package aws

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/bridge"
	"github.com/sst/sst/v3/cmd/sst/mosaic/watcher"
	"github.com/sst/sst/v3/pkg/bus"
	"github.com/sst/sst/v3/pkg/id"
	"github.com/sst/sst/v3/pkg/project"
	"github.com/sst/sst/v3/pkg/runtime"
	"github.com/sst/sst/v3/pkg/server"
)

type FunctionInvokedEvent struct {
	FunctionID string
	WorkerID   string
	RequestID  string
	Input      []byte
}

type FunctionResponseEvent struct {
	FunctionID string
	WorkerID   string
	RequestID  string
	Output     []byte
}

type FunctionErrorEvent struct {
	FunctionID   string
	WorkerID     string
	RequestID    string
	ErrorType    string   `json:"errorType"`
	ErrorMessage string   `json:"errorMessage"`
	Trace        []string `json:"trace"`
}

type FunctionBuildEvent struct {
	FunctionID string
	Errors     []string
}

type FunctionLogEvent struct {
	FunctionID string
	WorkerID   string
	RequestID  string
	Line       string
}

type input struct {
	config  aws.Config
	project *project.Project
	server  *server.Server
	client  *bridge.Client
	msg     chan bridge.Message
	prefix  string
}

func function(ctx context.Context, input input) {
	log := slog.Default().With("service", "aws.function")
	server := fmt.Sprintf("localhost:%d/lambda/", input.server.Port)
	type WorkerInfo struct {
		FunctionID       string
		WorkerID         string
		Worker           runtime.Worker
		CurrentRequestID string
		Env              []string
		Streaming        bool
	}
	workerShutdownChan := make(chan *WorkerInfo, 1000)
	nextChan := map[string]chan io.Reader{}
	workers := map[string]*WorkerInfo{}
	// nextChan and workers are written by the event loop below while the
	// lambda runtime-API handlers read them from request goroutines; a bare
	// map access on either side crashes the process with a concurrent
	// map read/write fatal under cold-start bursts.
	var stateMu sync.Mutex
	loadNextChan := func(workerID string) chan io.Reader {
		stateMu.Lock()
		defer stateMu.Unlock()
		ch, ok := nextChan[workerID]
		if !ok {
			ch = make(chan io.Reader, 100)
			nextChan[workerID] = ch
		}
		return ch
	}
	loadWorker := func(workerID string) (*WorkerInfo, bool) {
		stateMu.Lock()
		defer stateMu.Unlock()
		info, ok := workers[workerID]
		return info, ok
	}
	// AppSync can accept an event and not deliver it, as in the seconds after a
	// Lambda cold-starts and subscribes. The bridge has had the ping by then, so it
	// would wait until Lambda times the invocation out. So a reply to a bridge is
	// sent again a few times, with the ID of the first. The bridge passes on the
	// first copy with that ID, and a later one only fills in packets it's missing.
	resendReply := func(message bridge.MessageType, workerID, messageID string, body []byte) {
		channel := input.prefix + "/" + workerID + "/in"
		go resend(ctx, replyResends, replyResendEvery, func() {
			writer := input.client.NewWriter(message, channel)
			writer.SetID(messageID)
			if err := sendMessage(writer, bytes.NewReader(body)); err != nil {
				log.Error("failed to resend reply", "workerID", workerID, "messageID", messageID, "err", err)
			}
		})
	}
	evts := bus.Subscribe(&watcher.FileChangedEvent{}, &project.CompleteEvent{}, &runtime.BuildInput{}, &FunctionInvokedEvent{})
	go fileLogger(input.project)

	input.server.Mux.HandleFunc(`/lambda/{workerID}/2018-06-01/runtime/invocation/next`, func(w http.ResponseWriter, r *http.Request) {
		log.Info("got next request", "workerID", r.PathValue("workerID"))
		workerID := r.PathValue("workerID")
		ch := loadNextChan(workerID)
		select {
		case <-r.Context().Done():
			log.Info("worker disconnected", "workerID", workerID)
			return
		case reader := <-ch:
			log.Info("worker got next request", "workerID", workerID)
			resp, _ := http.ReadResponse(bufio.NewReader(reader), r)
			requestID := resp.Header.Get("lambda-runtime-aws-request-id")
			for key, values := range resp.Header {
				for _, value := range values {
					w.Header().Add(key, value)
				}
			}
			w.WriteHeader(resp.StatusCode)

			var buf bytes.Buffer
			tee := io.TeeReader(resp.Body, &buf)
			io.Copy(w, tee)
			workerInfo, ok := loadWorker(workerID)
			if ok {
				bus.Publish(&FunctionInvokedEvent{
					FunctionID: workerInfo.FunctionID,
					WorkerID:   workerID,
					RequestID:  requestID,
					Input:      buf.Bytes(),
				})
			}
		}
	})

	input.server.Mux.HandleFunc(`/lambda/{workerID}/2018-06-01/runtime/init/error`, func(w http.ResponseWriter, r *http.Request) {
		workerID := r.PathValue("workerID")
		log.Info("got init error", "workerID", workerID, "requestID", r.PathValue("requestID"))
		writer := input.client.NewWriter(bridge.MessageInitError, input.prefix+"/"+workerID+"/in")
		// an init error has no request ID, so its copies share one made here, and
		// the bridge passes on only one of them
		messageID := id.Ascending()
		writer.SetID(messageID)
		var buf bytes.Buffer
		tee := io.TeeReader(r.Body, &buf)
		if err := sendMessage(writer, tee); err != nil {
			log.Error("failed to send init error", "workerID", workerID, "err", err)
		}
		w.WriteHeader(200)
		resendReply(bridge.MessageInitError, workerID, messageID, buf.Bytes())
		info, ok := loadWorker(workerID)
		if ok {
			fee := &FunctionErrorEvent{
				FunctionID: info.FunctionID,
				WorkerID:   info.WorkerID,
			}
			json.Unmarshal(buf.Bytes(), &fee)
			bus.Publish(fee)
		}
	})

	input.server.Mux.HandleFunc(`/lambda/{workerID}/2018-06-01/runtime/invocation/{requestID}/response`, func(w http.ResponseWriter, r *http.Request) {
		workerID := r.PathValue("workerID")
		requestID := r.PathValue("requestID")
		log.Info("got response", "workerID", workerID, "requestID", r.PathValue("requestID"))
		writer := input.client.NewWriter(bridge.MessageResponse, input.prefix+"/"+workerID+"/in")
		writer.SetID(requestID)
		info, ok := loadWorker(workerID)
		if ok && info.Streaming {
			writer.SetStreaming(true)
			if err := sendMessage(writer, r.Body); err != nil {
				log.Error("failed to send response", "workerID", workerID, "requestID", requestID, "err", err)
			}
			w.WriteHeader(202)
			bus.Publish(&FunctionResponseEvent{
				FunctionID: info.FunctionID,
				WorkerID:   workerID,
				RequestID:  requestID,
				Output:     []byte("[streaming response]"),
			})
		} else {
			var buf bytes.Buffer
			tee := io.TeeReader(r.Body, &buf)
			if err := sendMessage(writer, tee); err != nil {
				log.Error("failed to send response", "workerID", workerID, "requestID", requestID, "err", err)
			}
			w.WriteHeader(202)
			if ok {
				bus.Publish(&FunctionResponseEvent{
					FunctionID: info.FunctionID,
					WorkerID:   workerID,
					RequestID:  requestID,
					Output:     buf.Bytes(),
				})
			}
			resendReply(bridge.MessageResponse, workerID, requestID, buf.Bytes())
		}
	})

	input.server.Mux.HandleFunc(`/lambda/{workerID}/2018-06-01/runtime/invocation/{requestID}/error`, func(w http.ResponseWriter, r *http.Request) {
		workerID := r.PathValue("workerID")
		requestID := r.PathValue("requestID")
		log.Info("got error", "workerID", workerID, "requestID", r.PathValue("requestID"))
		writer := input.client.NewWriter(bridge.MessageError, input.prefix+"/"+workerID+"/in")
		writer.SetID(requestID)
		var buf bytes.Buffer
		tee := io.TeeReader(r.Body, &buf)
		if err := sendMessage(writer, tee); err != nil {
			log.Error("failed to send error", "workerID", workerID, "requestID", requestID, "err", err)
		}
		w.WriteHeader(202)
		resendReply(bridge.MessageError, workerID, requestID, buf.Bytes())
		info, ok := loadWorker(workerID)
		if ok {
			fee := &FunctionErrorEvent{
				FunctionID: info.FunctionID,
				WorkerID:   info.WorkerID,
				RequestID:  requestID,
			}
			json.Unmarshal(buf.Bytes(), &fee)
			bus.Publish(fee)
		}
	})

	workerEnv := map[string][]string{}
	builds := map[string]*runtime.BuildOutput{}
	targets := map[string]*runtime.BuildInput{}

	// whether a build wrote its handler into its output folder when it was made,
	// the Python runtime in dev for one doesn't, its handler stays in the source
	handlerBuilt := map[string]bool{}

	// keeps what a build gave for the function and says how it went; it gives
	// the build, or nil when it failed
	record := func(functionID string, build *runtime.BuildOutput, err error) *runtime.BuildOutput {
		if err == nil {
			bus.Publish(&FunctionBuildEvent{
				FunctionID: functionID,
				Errors:     build.Errors,
			})
		} else {
			bus.Publish(&FunctionBuildEvent{
				FunctionID: functionID,
				Errors:     []string{err.Error()},
			})
		}
		if err != nil || len(build.Errors) > 0 {
			delete(builds, functionID)
			return nil
		}
		builds[functionID] = build
		handlerBuilt[functionID] = handlerFileExists(build)
		return build
	}

	getBuildOutput := func(functionID string) *runtime.BuildOutput {
		build := builds[functionID]
		if build != nil {
			if reusableBuild(build, handlerBuilt[functionID]) {
				return build
			}
			log.Info("build output missing, rebuilding", "functionID", functionID, "handler", build.Handler)
			delete(builds, functionID)
		}
		target, _ := targets[functionID]
		build, err := input.project.Runtime.Build(ctx, target)
		return record(functionID, build, err)
	}

	// builds the functions at once and keeps what each gave, and tells which
	// ones failed
	buildEach := func(toBuild []*runtime.BuildInput) map[string]bool {
		failed := map[string]bool{}
		results := buildAll(toBuild, func(target *runtime.BuildInput) (*runtime.BuildOutput, error) {
			return input.project.Runtime.Build(ctx, target)
		})
		for _, result := range results {
			if record(result.FunctionID, result.Output, result.Err) == nil {
				failed[result.FunctionID] = true
			}
		}
		return failed
	}

	startWorker := func(functionID string, workerID string) bool {
		build := getBuildOutput(functionID)
		if build == nil {
			return false
		}
		target, ok := targets[functionID]
		if !ok {
			return false
		}
		worker, err := input.project.Runtime.Run(ctx, &runtime.RunInput{
			CfgPath:    input.project.PathConfig(),
			Runtime:    target.Runtime,
			Server:     server + workerID,
			WorkerID:   workerID,
			FunctionID: functionID,
			Build:      build,
			Env:        workerEnv[workerID],
		})
		if err != nil {
			log.Error("failed to run worker", "error", err)
			return false
		}
		streaming := false
		for _, e := range workerEnv[workerID] {
			if e == "SST_FUNCTION_STREAMING=true" {
				streaming = true
				break
			}
		}
		info := &WorkerInfo{
			FunctionID: functionID,
			Worker:     worker,
			WorkerID:   workerID,
			Streaming:  streaming,
		}
		go func() {
			logs := worker.Logs()
			scanner := bufio.NewScanner(logs)
			for scanner.Scan() {
				line := scanner.Text()
				stateMu.Lock()
				requestID := info.CurrentRequestID
				stateMu.Unlock()
				bus.Publish(&FunctionLogEvent{
					FunctionID: functionID,
					WorkerID:   workerID,
					RequestID:  requestID,
					Line:       line,
				})
			}
			workerShutdownChan <- info
		}()
		stateMu.Lock()
		workers[workerID] = info
		stateMu.Unlock()

		return true
	}

	restartOrDeferWorker := func(workerID string, info *WorkerInfo) {
		target, ok := targets[info.FunctionID]
		if !ok {
			return
		}
		if input.project.Runtime.ShouldRunEagerly(target.Runtime) {
			startWorker(info.FunctionID, workerID)
		} else {
			log.Info("lazy startup: deferring worker restart until invoked", "workerID", workerID, "functionID", info.FunctionID)
			stateMu.Lock()
			delete(workers, workerID)
			stateMu.Unlock()
		}
	}

	// Files that changed since the last rebuild. One save can change several,
	// as a formatter or a checkout does, so they're taken together a moment
	// later, and a function is built once for all of them.
	changed := map[string]bool{}
	var rebuildChanged <-chan time.Time

	rebuild := func(paths map[string]bool) {
		toBuild := []*runtime.BuildInput{}
		for functionID := range builds {
			target, ok := targets[functionID]
			if !ok {
				continue
			}
			for path := range paths {
				if !input.project.Runtime.ShouldRebuild(target.Runtime, target.FunctionID, path) {
					continue
				}
				for _, worker := range workers {
					if worker.FunctionID == functionID {
						log.Info("stopping", "workerID", worker.WorkerID, "functionID", worker.FunctionID)
						worker.Worker.Stop()
					}
				}
				delete(builds, functionID)
				toBuild = append(toBuild, target)
				break
			}
		}
		if len(toBuild) == 0 {
			return
		}

		failed := buildEach(toBuild)
		rebuilt := map[string]bool{}
		for _, target := range toBuild {
			rebuilt[target.FunctionID] = !failed[target.FunctionID]
		}
		for workerID, info := range workers {
			if rebuilt[info.FunctionID] {
				restartOrDeferWorker(workerID, info)
			}
		}
	}

	for {
		select {
		case <-ctx.Done():
			return
		case msg := <-input.msg:
			switch msg.Type {
			case bridge.MessageInit:
				loadNextChan(msg.Source)
				init := bridge.InitBody{}
				json.NewDecoder(msg.Body).Decode(&init)
				if _, ok := targets[init.FunctionID]; !ok {
					log.Error("function not found", "functionID", init.FunctionID)
					continue
				}
				workerID := msg.Source
				if _, ok := loadWorker(workerID); ok {
					log.Error("got reboot but worker already exists", "workerID", workerID, "functionID", init.FunctionID)
					continue
				}
				log.Info("worker init", "workerID", msg.Source, "functionID", init.FunctionID)
				workerEnv[workerID] = init.Environment
				if ok := startWorker(init.FunctionID, workerID); !ok {
					result, err := http.Post("http://"+server+workerID+"/runtime/init/error", "application/json", strings.NewReader(`{"errorMessage":"Function failed to build"}`))
					if err != nil {
						continue
					}
					defer result.Body.Close()
					body, err := io.ReadAll(result.Body)
					if err != nil {
						continue
					}
					log.Info("error", "body", string(body), "status", result.StatusCode)

					if result.StatusCode != 202 {
						result, err := http.Get("http://" + server + workerID + "/runtime/invocation/next")
						if err != nil {
							continue
						}
						requestID := result.Header.Get("lambda-runtime-aws-request-id")
						result, err = http.Post("http://"+server+workerID+"/runtime/invocation/"+requestID+"/error", "application/json", strings.NewReader(`{"errorMessage":"Function failed to build"}`))
						if err != nil {
							continue
						}
						defer result.Body.Close()
						body, err := io.ReadAll(result.Body)
						if err != nil {
							continue
						}
						log.Info("error", "body", string(body), "status", result.StatusCode)
					}
				}
			case bridge.MessageNext:
				writer := input.client.NewWriter(bridge.MessagePing, input.prefix+"/"+msg.Source+"/in")
				if err := sendJSON(writer, bridge.PingBody{}); err != nil {
					log.Error("failed to send ping", "workerID", msg.Source, "err", err)
				}
				ch := loadNextChan(msg.Source)
				_, ok := loadWorker(msg.Source)
				if !ok {
					log.Info("asking for reboot", "workerID", msg.Source)
					writer := input.client.NewWriter(bridge.MessageReboot, input.prefix+"/"+msg.Source+"/in")
					if err := sendJSON(writer, bridge.RebootBody{}); err != nil {
						log.Error("failed to send reboot", "workerID", msg.Source, "err", err)
					}
				}
				ch <- msg.Body
				continue
			}

		case <-rebuildChanged:
			paths := changed
			changed = map[string]bool{}
			rebuildChanged = nil
			rebuild(paths)
		case info := <-workerShutdownChan:
			log.Info("worker died", "workerID", info.WorkerID)
			stateMu.Lock()
			existing, ok := workers[info.WorkerID]
			// only delete if a new worker hasn't already been started
			if ok && existing == info {
				log.Info("deleting worker", "workerID", info.WorkerID)
				delete(workers, info.WorkerID)
				delete(nextChan, info.WorkerID)
			}
			stateMu.Unlock()
			break
		case unknown := <-evts:
			switch evt := unknown.(type) {
			case *FunctionInvokedEvent:
				info, ok := loadWorker(evt.WorkerID)
				if !ok {
					continue
				}
				stateMu.Lock()
				info.CurrentRequestID = evt.RequestID
				stateMu.Unlock()
			case *project.CompleteEvent:
				if evt.Old {
					continue
				}
				for _, info := range workers {
					info.Worker.Stop()
				}
				builds = map[string]*runtime.BuildOutput{}
				// the functions whose workers start again now are built at once,
				// not one by one as each starts
				toBuild := []*runtime.BuildInput{}
				for _, info := range workers {
					target, ok := targets[info.FunctionID]
					if !ok || slices.Contains(toBuild, target) || !input.project.Runtime.ShouldRunEagerly(target.Runtime) {
						continue
					}
					toBuild = append(toBuild, target)
				}
				failed := buildEach(toBuild)
				for workerID, info := range workers {
					if !failed[info.FunctionID] {
						restartOrDeferWorker(workerID, info)
					}
				}
			case *runtime.BuildInput:
				targets[evt.FunctionID] = evt
			case *watcher.FileChangedEvent:
				log.Info("checking if code needs to be rebuilt", "file", evt.Path)
				changed[evt.Path] = true
				if rebuildChanged == nil {
					rebuildChanged = time.After(rebuildDelay)
				}
				break
			}
		}
	}
}

func fileLogger(p *project.Project) {
	evts := bus.Subscribe(&FunctionLogEvent{}, &FunctionInvokedEvent{}, &FunctionResponseEvent{}, &FunctionErrorEvent{}, &FunctionBuildEvent{})
	logs := map[string]*os.File{}

	getLog := func(functionID string, requestID string) *os.File {
		log, ok := logs[requestID]
		if !ok {
			path := p.PathLog(fmt.Sprintf("lambda/%s/%d-%s", functionID, time.Now().Unix(), requestID))
			os.MkdirAll(filepath.Dir(path), 0755)
			log, _ = os.Create(path)
			logs[requestID] = log
		}
		return log
	}

	for range evts {
		for evt := range evts {
			switch evt := evt.(type) {
			case *FunctionInvokedEvent:
				log := getLog(evt.FunctionID, evt.RequestID)
				log.WriteString("invocation " + evt.RequestID + "\n")
				log.WriteString(string(evt.Input))
				log.WriteString("\n")
			case *FunctionLogEvent:
				getLog(evt.FunctionID, evt.RequestID).WriteString(evt.Line + "\n")
			case *FunctionResponseEvent:
				log := getLog(evt.FunctionID, evt.RequestID)
				log.WriteString("response " + evt.RequestID + "\n")
				log.WriteString(string(evt.Output))
				log.WriteString("\n")
				delete(logs, evt.RequestID)
			case *FunctionErrorEvent:
				getLog(evt.FunctionID, evt.RequestID).WriteString(evt.ErrorType + ": " + evt.ErrorMessage + "\n")
				delete(logs, evt.RequestID)
			}
		}
	}
}

// handlerFileExists tells whether the handler of a build is in its output folder:
// a file named like the handler with an extension, or without one for compiled
// binaries. A source map next to a missing bundle doesn't count.
func handlerFileExists(build *runtime.BuildOutput) bool {
	// the method comes after the last dot of the file name, not of the whole path
	handlerFile := build.Handler
	base := filepath.Base(handlerFile)
	if i := strings.LastIndex(base, "."); i > 0 {
		handlerFile = filepath.Join(filepath.Dir(handlerFile), base[:i])
	}
	name := filepath.Base(handlerFile)
	entries, err := os.ReadDir(filepath.Join(build.Out, filepath.Dir(handlerFile)))
	if err != nil {
		return false
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		file := entry.Name()
		if file == name || (strings.HasPrefix(file, name+".") && !strings.HasSuffix(file, ".map")) {
			return true
		}
	}
	return false
}

// reusableBuild tells whether a cached build can be used again. A build that wrote
// its handler into the output folder is built again once that file is gone. One that
// didn't, such as Python in dev where the handler stays in the source, has nothing
// to check.
func reusableBuild(build *runtime.BuildOutput, handlerBuilt bool) bool {
	if build == nil {
		return false
	}
	return !handlerBuilt || handlerFileExists(build)
}

// How long after a file changes the functions that use it are built again. The
// files that change in that time are taken together.
const rebuildDelay = 100 * time.Millisecond

type functionBuild struct {
	FunctionID string
	Output     *runtime.BuildOutput
	Err        error
}

// buildAll builds the functions at once and gives what each build returned, in
// the order of targets. A change to a file that several functions import would
// otherwise build them one after the other. The runtimes limit how many builds
// run together.
func buildAll(targets []*runtime.BuildInput, build func(*runtime.BuildInput) (*runtime.BuildOutput, error)) []functionBuild {
	results := make([]functionBuild, len(targets))
	var wg sync.WaitGroup
	for i, target := range targets {
		wg.Go(func() {
			output, err := build(target)
			results[i] = functionBuild{FunctionID: target.FunctionID, Output: output, Err: err}
		})
	}
	wg.Wait()
	return results
}

// How many more times a reply to a bridge is sent after the first, and how far
// apart: over 15 seconds.
const (
	replyResends     = 5
	replyResendEvery = 3 * time.Second
)

// sendMessage writes a message's body and publishes what's left of it, and returns
// the first error. The writer publishes each time its buffer fills, so the copy can
// fail as well as the close.
func sendMessage(writer *bridge.Writer, body io.Reader) error {
	_, err := io.Copy(writer, body)
	if closeErr := writer.Close(); err == nil {
		err = closeErr
	}
	return err
}

// sendJSON publishes a message whose body is v as JSON.
func sendJSON(writer *bridge.Writer, v any) error {
	var body bytes.Buffer
	if err := json.NewEncoder(&body).Encode(v); err != nil {
		return err
	}
	return sendMessage(writer, &body)
}

// resend calls publish the given number of times, waiting before each, and stops
// early when the context is done. A failed publish doesn't stop it, since the next
// one may still get through.
func resend(ctx context.Context, times int, every time.Duration, publish func()) {
	for range times {
		select {
		case <-ctx.Done():
			return
		case <-time.After(every):
		}
		publish()
	}
}
