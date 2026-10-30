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
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/bridge"
	"github.com/sst/sst/v3/cmd/sst/mosaic/watcher"
	"github.com/sst/sst/v3/pkg/bus"
	"github.com/sst/sst/v3/pkg/flag"
	"github.com/sst/sst/v3/pkg/id"
	"github.com/sst/sst/v3/pkg/process"
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

// The environment of a worker that stopped is forgotten, so the UI can forget
// what it keeps for the worker too
type FunctionWorkerForgottenEvent struct {
	FunctionID string
	WorkerID   string
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
		// Polled is whether the worker has asked for an invocation, so it
		// started. One that exits before then failed as it started.
		Polled bool
		// Busy is whether the worker is running an invocation: it was handed
		// one, and hasn't asked for the next. Deadline is when that times out,
		// and LastInvoked when it was handed it.
		Busy        bool
		Deadline    time.Time
		LastInvoked time.Time
		// Outdated is whether its function was rebuilt while it ran an
		// invocation. It's replaced once it's done with it, and the new worker
		// starts then if Eager, as the function's worker invoked last.
		// replaceAt replaces it at its invocation's deadline, and is only used
		// by the loop.
		Outdated  bool
		Eager     bool
		replaceAt *time.Timer
		// Stopped is whether it was stopped. It takes a moment to exit, and
		// isn't handed an invocation meanwhile.
		Stopped bool
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
	// queueNext queues an invocation for a worker, and says whether the worker
	// is running. Both under the lock, so a worker that exits sees the
	// invocation queued, or the invocation sees the worker gone.
	queueNext := func(workerID string, body io.Reader) bool {
		stateMu.Lock()
		ch, ok := nextChan[workerID]
		if !ok {
			ch = make(chan io.Reader, 100)
			nextChan[workerID] = ch
		}
		_, running := workers[workerID]
		select {
		case ch <- body:
			stateMu.Unlock()
		default:
			// a full queue is waited on without holding up everything else
			stateMu.Unlock()
			select {
			case ch <- body:
			case <-ctx.Done():
			}
		}
		return running
	}
	// AppSync can accept an event and not deliver it, as in the seconds after a
	// Lambda cold-starts and subscribes. The bridge has had the ping by then, so it
	// would wait until Lambda times the invocation out. So a reply to a bridge is
	// sent again a few times, with the ID of the first. The bridge passes on the
	// first copy with that ID, and a later one only fills in packets it's missing.
	//
	// A bridge only sends its next invocation once it's done with the one before,
	// so its reply's resends stop then. What the function printed is sent after
	// the reply, as a message of its own, so a worker's resends are kept by
	// message: the output's don't stop the reply's.
	type resending struct{ cancel context.CancelFunc }
	resends := map[string]map[string]*resending{}
	stopResending := func(workerID string) {
		stateMu.Lock()
		defer stateMu.Unlock()
		for _, r := range resends[workerID] {
			r.cancel()
		}
		delete(resends, workerID)
	}
	var cloudLogs *pendingLogs
	if flag.SST_DEV_CLOUDWATCH_LOGS {
		cloudLogs = newPendingLogs()
	}
	// newReply makes the writer for a reply to a bridge. When what the function
	// printed is sent to the bridge, it says that follows.
	newReply := func(message bridge.MessageType, workerID, messageID string) *bridge.Writer {
		writer := input.client.NewWriter(message, input.prefix+"/"+workerID+"/in")
		writer.SetID(messageID)
		writer.SetLogsFollow(cloudLogs != nil && message != bridge.MessageLogs)
		return writer
	}
	// firstReply makes the writer for the first copy of a reply, which goes
	// over the AppSync connection's WebSocket where it can, as the bridge is
	// waiting on it, if it holds no more than a packet. Its resends, a longer
	// reply, and every other message, go over HTTPS.
	firstReply := func(message bridge.MessageType, workerID, messageID string) *bridge.Writer {
		writer := newReply(message, workerID, messageID)
		writer.SetOverSocket(!flag.SST_DEV_HTTP_PUBLISH)
		return writer
	}
	resendReply := func(message bridge.MessageType, workerID, messageID string, body []byte) {
		resendCtx, cancel := context.WithCancel(ctx)
		r := &resending{cancel}
		stateMu.Lock()
		// a new reply means the bridge is past the ones before
		if message != bridge.MessageLogs {
			for _, previous := range resends[workerID] {
				previous.cancel()
			}
			delete(resends, workerID)
		}
		if resends[workerID] == nil {
			resends[workerID] = map[string]*resending{}
		}
		resends[workerID][messageID] = r
		stateMu.Unlock()
		go func() {
			resend(resendCtx, replyResends, replyResendEvery, func() {
				writer := newReply(message, workerID, messageID)
				if err := sendMessage(writer, bytes.NewReader(body)); err != nil {
					log.Error("failed to resend reply", "workerID", workerID, "messageID", messageID, "err", err)
				}
			})
			stateMu.Lock()
			if resends[workerID][messageID] == r {
				delete(resends[workerID], messageID)
				if len(resends[workerID]) == 0 {
					delete(resends, workerID)
				}
			}
			stateMu.Unlock()
			cancel()
		}()
	}
	// a worker with an invocation queued that may be gone, for the loop to start
	// it again
	requeued := make(chan string, 100)
	requeue := func(workerID string) {
		select {
		case requeued <- workerID:
		case <-ctx.Done():
		}
	}
	// a worker that's done with the invocation it ran through a rebuild, or ran
	// past its deadline, for the loop to replace with one of the new build
	replaced := make(chan *WorkerInfo, 100)
	replace := func(info *WorkerInfo) {
		select {
		case replaced <- info:
		case <-ctx.Done():
		}
	}
	// sendLogs sends the bridge what the worker printed up to a reply, after it,
	// so the reply isn't held up. It's sent when there's nothing too, so the
	// bridge stops waiting. A copy arrives after the bridge has stopped waiting,
	// and is printed as late, so there are copies only when there's something to
	// print.
	sendLogs := func(workerID, replyID string) {
		if cloudLogs == nil {
			return
		}
		go func() {
			select {
			case <-ctx.Done():
				return
			case <-time.After(logsDelay):
			}
			lines, dropped := cloudLogs.take(workerID)
			body, err := json.Marshal(bridge.LogsBody{ReplyID: replyID, Lines: lines, Dropped: dropped})
			if err != nil {
				log.Error("failed to encode logs", "workerID", workerID, "err", err)
				return
			}
			messageID := id.Ascending()
			// the resends are set before the first copy goes, as for a reply
			if len(lines) > 0 || dropped > 0 {
				resendReply(bridge.MessageLogs, workerID, messageID, body)
			}
			if err := sendMessage(newReply(bridge.MessageLogs, workerID, messageID), bytes.NewReader(body)); err != nil {
				log.Error("failed to send logs", "workerID", workerID, "replyID", replyID, "err", err)
			}
		}()
	}
	evts := bus.Subscribe(&watcher.FileChangedEvent{}, &project.CompleteEvent{}, &runtime.BuildInput{})

	input.server.Mux.HandleFunc(`/lambda/{workerID}/2018-06-01/runtime/invocation/next`, func(w http.ResponseWriter, r *http.Request) {
		log.Info("got next request", "workerID", r.PathValue("workerID"))
		workerID := r.PathValue("workerID")
		stateMu.Lock()
		info, ok := workers[workerID]
		if ok {
			info.Polled = true
			info.Busy = false
		}
		outdated := ok && info.Outdated
		stateMu.Unlock()
		if outdated {
			// it doesn't take another, as its function was rebuilt, and it's
			// stopped
			log.Info("worker done with its invocation through a rebuild", "workerID", workerID)
			go replace(info)
			<-r.Context().Done()
			return
		}
		ch := loadNextChan(workerID)
		select {
		case <-r.Context().Done():
			log.Info("worker disconnected", "workerID", workerID)
			return
		case reader := <-ch:
			// the worker can go, as when it exits on idle or is stopped by a
			// rebuild, as the invocation arrives. Put it back for the next one, or
			// it's lost. It's taken as busy in the same lock, so a rebuild either
			// stops it before, and it's put back, or leaves it to finish.
			gone := r.Context().Err() != nil
			stateMu.Lock()
			stopped := info != nil && info.Stopped
			current, recorded := workers[workerID]
			if !gone && !stopped && recorded {
				current.Busy = true
				current.LastInvoked = time.Now()
				current.Deadline = time.Time{}
			}
			stateMu.Unlock()
			if gone || stopped {
				log.Info("worker disconnected, putting its invocation back", "workerID", workerID)
				queueNext(workerID, reader)
				// the loop can be busy building, and the worker's runtime doesn't
				// wait for this
				go requeue(workerID)
				// one that was stopped is let go without an answer, which it could
				// take for an invocation
				<-r.Context().Done()
				return
			}
			log.Info("worker got next request", "workerID", workerID)
			resp, _ := http.ReadResponse(bufio.NewReader(reader), r)
			requestID := resp.Header.Get("lambda-runtime-aws-request-id")
			if recorded {
				// what it prints from now is this invocation's, set here and
				// not by the loop, which can be held up, as by a build, and
				// would tie it to the invocation before
				stateMu.Lock()
				current.CurrentRequestID = requestID
				if ms, err := strconv.ParseInt(resp.Header.Get("lambda-runtime-deadline-ms"), 10, 64); err == nil {
					current.Deadline = time.UnixMilli(ms)
				}
				stateMu.Unlock()
			}
			for key, values := range resp.Header {
				for _, value := range values {
					w.Header().Add(key, value)
				}
			}
			// The invocation is published before the worker has it, so it comes
			// before anything the worker prints for it, which is tied to it from
			// above, and its log starts with it. Its body is in memory already,
			// as the bridge's message.
			body, _ := io.ReadAll(resp.Body)
			if workerInfo, ok := loadWorker(workerID); ok {
				bus.Publish(&FunctionInvokedEvent{
					FunctionID: workerInfo.FunctionID,
					WorkerID:   workerID,
					RequestID:  requestID,
					Input:      body,
				})
			}
			w.WriteHeader(resp.StatusCode)
			w.Write(body)
		}
	})

	input.server.Mux.HandleFunc(`/lambda/{workerID}/2018-06-01/runtime/init/error`, func(w http.ResponseWriter, r *http.Request) {
		workerID := r.PathValue("workerID")
		log.Info("got init error", "workerID", workerID, "requestID", r.PathValue("requestID"))
		// an init error has no request ID, so its copies share one made here, and
		// the bridge passes on only one of them
		messageID := id.Ascending()
		writer := firstReply(bridge.MessageInitError, workerID, messageID)
		var buf bytes.Buffer
		if _, err := buf.ReadFrom(r.Body); err != nil {
			log.Error("failed to read init error", "workerID", workerID, "err", err)
		}
		// the resends are set before the first copy goes, as the bridge can
		// send its next invocation, which stops them, before the publish returns
		resendReply(bridge.MessageInitError, workerID, messageID, buf.Bytes())
		if err := sendMessage(writer, bytes.NewReader(buf.Bytes())); err != nil {
			log.Error("failed to send init error", "workerID", workerID, "err", err)
		}
		w.WriteHeader(200)
		sendLogs(workerID, messageID)
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
		writer := firstReply(bridge.MessageResponse, workerID, requestID)
		defer sendLogs(workerID, requestID)
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
			if _, err := buf.ReadFrom(r.Body); err != nil {
				log.Error("failed to read response", "workerID", workerID, "requestID", requestID, "err", err)
			}
			resendReply(bridge.MessageResponse, workerID, requestID, buf.Bytes())
			if err := sendMessage(writer, bytes.NewReader(buf.Bytes())); err != nil {
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
		}
	})

	input.server.Mux.HandleFunc(`/lambda/{workerID}/2018-06-01/runtime/invocation/{requestID}/error`, func(w http.ResponseWriter, r *http.Request) {
		workerID := r.PathValue("workerID")
		requestID := r.PathValue("requestID")
		log.Info("got error", "workerID", workerID, "requestID", r.PathValue("requestID"))
		writer := firstReply(bridge.MessageError, workerID, requestID)
		var buf bytes.Buffer
		if _, err := buf.ReadFrom(r.Body); err != nil {
			log.Error("failed to read error", "workerID", workerID, "requestID", requestID, "err", err)
		}
		resendReply(bridge.MessageError, workerID, requestID, buf.Bytes())
		if err := sendMessage(writer, bytes.NewReader(buf.Bytes())); err != nil {
			log.Error("failed to send error", "workerID", workerID, "requestID", requestID, "err", err)
		}
		w.WriteHeader(202)
		sendLogs(workerID, requestID)
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
	// the function of each worker, kept after it exits, to start it again
	workerFunction := map[string]string{}
	// When each worker that isn't running stopped: it exited, wasn't started
	// again after a rebuild, or failed to start. Its environment is forgotten
	// once it has been stopped for forgetAfter, unless it started again. A
	// worker in it is never in workers: startWorker takes it out as it records
	// the worker. Like workerEnv, it's only used by the loop, so it isn't
	// under stateMu.
	stoppedAt := map[string]time.Time{}
	forgetLater := func(workerID string) {
		stoppedAt[workerID] = time.Now()
	}
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

	// startWorker starts a worker for a function. When it can't, it says why, for
	// the init error its bridge gets: the function's build failed, or its runtime
	// couldn't run it. The bridge's init and its first invocation can be handled
	// in either order, and the reason is the same.
	startWorker := func(functionID string, workerID string) (bool, string) {
		build := getBuildOutput(functionID)
		if build == nil {
			return false, "Function failed to build"
		}
		target, ok := targets[functionID]
		if !ok {
			return false, "Function failed to start"
		}
		streaming := false
		for _, e := range workerEnv[workerID] {
			if e == "SST_FUNCTION_STREAMING=true" {
				streaming = true
				break
			}
		}
		// The worker is recorded before it starts, not once it has, so what it
		// does as soon as it runs is its own: its first request for an
		// invocation, its answer, its error, what it prints. On a busy machine
		// it can answer an invocation before Run returns. Its Worker is set once
		// it has. Nothing stops a worker but this loop, which is here till then.
		info := &WorkerInfo{
			FunctionID: functionID,
			WorkerID:   workerID,
			Streaming:  streaming,
		}
		stateMu.Lock()
		previous, hadPrevious := workers[workerID]
		workers[workerID] = info
		stateMu.Unlock()
		// it isn't stopped while it's recorded, so it's taken out as it's
		// recorded, and put back if it doesn't start
		stopped, wasStopped := stoppedAt[workerID]
		delete(stoppedAt, workerID)
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
			stateMu.Lock()
			if workers[workerID] == info {
				if hadPrevious {
					workers[workerID] = previous
				} else {
					delete(workers, workerID)
				}
			}
			stateMu.Unlock()
			if wasStopped {
				stoppedAt[workerID] = stopped
			}
			log.Error("failed to run worker", "error", err)
			return false, "Function failed to start"
		}
		stateMu.Lock()
		info.Worker = worker
		stateMu.Unlock()
		go func() {
			logs := worker.Logs()
			onLine := func(line string) {
				stateMu.Lock()
				requestID := info.CurrentRequestID
				stateMu.Unlock()
				if cloudLogs != nil {
					cloudLogs.add(workerID, line)
				}
				bus.Publish(&FunctionLogEvent{
					FunctionID: functionID,
					WorkerID:   workerID,
					RequestID:  requestID,
					Line:       line,
				})
			}
			// A line too long for a bufio.Scanner stopped it, and the worker was
			// then taken for dead while it was still running.
			err := process.ReadLines(logs, maxOutputLine, onLine, func() { onLine(tooLongNote("function")) })
			if err != nil {
				log.Error("failed to read function output", "workerID", workerID, "err", err)
				// Keep reading, or the worker blocks on a full pipe.
				io.Copy(io.Discard, logs)
			}
			workerShutdownChan <- info
		}()

		return true, ""
	}

	// failedToStart tells the bridge of a worker that couldn't start, as when
	// its build failed, with an init error, so its invocation fails now instead
	// of at Lambda's timeout. The worker's queue is dropped, so the invocation
	// isn't handed to the next worker the bridge gets.
	//
	// A bridge takes any init error as its invocation's, so one is sent only
	// when an invocation is queued, which its bridge is waiting on. A worker can
	// fail to start twice for one invocation, as when the invocation arrived
	// first and the bridge was asked to start it again, and the second init
	// error would otherwise fail the bridge's next invocation. With nothing
	// queued, the invocation asks for the worker again when it arrives.
	failedToStart := func(functionID string, workerID string, message string) {
		forgetLater(workerID)
		stateMu.Lock()
		queued := len(nextChan[workerID])
		delete(nextChan, workerID)
		stateMu.Unlock()
		if queued == 0 {
			log.Info("worker didn't start, with nothing queued for it", "workerID", workerID)
			return
		}
		// the worker is gone, so the init error handler can't say whose it is
		bus.Publish(&FunctionErrorEvent{
			FunctionID:   functionID,
			WorkerID:     workerID,
			ErrorMessage: message,
		})
		body, _ := json.Marshal(map[string]string{"errorMessage": message})
		// sent from its own goroutine, as the handler publishes it to AppSync,
		// and the loop doesn't wait on that
		go func() {
			client := http.Client{Timeout: 10 * time.Second}
			result, err := client.Post("http://"+server+workerID+"/2018-06-01/runtime/init/error", "application/json", bytes.NewReader(body))
			if err != nil {
				log.Error("failed to report a worker that didn't start", "workerID", workerID, "err", err)
				return
			}
			result.Body.Close()
			if result.StatusCode >= 300 {
				log.Error("failed to report a worker that didn't start", "workerID", workerID, "status", result.StatusCode)
			}
		}()
	}

	// restart starts a worker again for the invocations queued for it.
	restart := func(functionID string, workerID string) {
		log.Info("starting worker again for its queued invocations", "workerID", workerID)
		if ok, why := startWorker(functionID, workerID); !ok {
			failedToStart(functionID, workerID, why)
		}
	}

	// restartOrDeferWorker starts a worker again after its function was built,
	// or, when it isn't to start eagerly, once it's next invoked
	restartOrDeferWorker := func(workerID string, info *WorkerInfo, eager bool) {
		target, ok := targets[info.FunctionID]
		if !ok {
			return
		}
		if eager && input.project.Runtime.ShouldRunEagerly(target.Runtime) {
			startWorker(info.FunctionID, workerID)
		} else {
			log.Info("lazy startup: deferring worker restart until invoked", "workerID", workerID, "functionID", info.FunctionID)
			stateMu.Lock()
			delete(workers, workerID)
			// the stopped worker's exit isn't seen as this worker's any more, so
			// an invocation already queued for it is started here
			queued := len(nextChan[workerID]) > 0
			stateMu.Unlock()
			if queued {
				restart(info.FunctionID, workerID)
			} else {
				forgetLater(workerID)
			}
		}
	}

	// next pings the bridge that sent an invocation and queues the invocation
	// for its worker, or asks the bridge to start one. It runs outside the loop,
	// which builds functions, so a long build doesn't keep other bridges from
	// their ping past the 16 seconds they wait for it.
	next := func(msg bridge.Message) {
		// The ping is published while the worker starts on the invocation, not
		// before, as publishing it takes a round trip. So it can reach the
		// bridge after the reply. It carries the ID of the bridge's message, so
		// a late one isn't taken for the ping of the bridge's next invocation.
		go func() {
			writer := input.client.NewWriter(bridge.MessagePing, input.prefix+"/"+msg.Source+"/in")
			writer.SetID(msg.ID)
			if err := sendJSON(writer, bridge.PingBody{}); err != nil {
				log.Error("failed to send ping", "workerID", msg.Source, "err", err)
			}
		}()
		if queueNext(msg.Source, msg.Body) {
			return
		}
		requeue(msg.Source)
	}
	// askForReboot asks a bridge to send its environment again, for sst dev to
	// start its worker with
	askForReboot := func(workerID string) {
		log.Info("asking for reboot", "workerID", workerID)
		writer := input.client.NewWriter(bridge.MessageReboot, input.prefix+"/"+workerID+"/in")
		if err := sendJSON(writer, bridge.RebootBody{}); err != nil {
			log.Error("failed to send reboot", "workerID", workerID, "err", err)
		}
	}
	loopMsg := make(chan bridge.Message, 1000)
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case msg := <-input.msg:
				if msg.Type == bridge.MessageNext {
					stopResending(msg.Source)
					go next(msg)
					continue
				}
				select {
				case loopMsg <- msg:
				case <-ctx.Done():
					return
				}
			}
		}
	}()

	// the loop ends with ctx, as in tests, which run it again and again
	defer bus.Unsubscribe(evts)
	// Files that changed since the last rebuild. One save can change several,
	// as a formatter or a checkout does, so they're taken together a moment
	// later, and a function is built once for all of them.
	changed := map[string]bool{}
	var rebuildChanged <-chan time.Time
	// What has been stopped for forgetAfter is forgotten at the next tick, so
	// within a tenth of forgetAfter more.
	forgetTick := time.NewTicker(forgetAfter / 10)
	defer forgetTick.Stop()

	// stopWhenDone stops a worker whose function is rebuilt. One that's running
	// an invocation is left to finish it, until its deadline, and then replaced.
	// It goes on running from the build's folder, which the new build is written
	// into, so what it loads after it started, as a module imported on use, can
	// come from the new build.
	stopWhenDone := func(info *WorkerInfo) {
		stateMu.Lock()
		busy := info.Busy
		if busy {
			info.Outdated = true
		} else {
			info.Stopped = true
		}
		deadline := info.Deadline
		if deadline.IsZero() {
			deadline = info.LastInvoked.Add(longestInvocation)
		}
		stateMu.Unlock()
		if !busy {
			log.Info("stopping", "workerID", info.WorkerID, "functionID", info.FunctionID)
			info.Worker.Stop()
			return
		}
		log.Info("rebuilt while running an invocation, replacing it once it's done", "workerID", info.WorkerID, "functionID", info.FunctionID)
		if info.replaceAt == nil {
			info.replaceAt = time.AfterFunc(time.Until(deadline), func() { replace(info) })
		}
	}

	// restartAfterBuild starts again, of each function that was built, the
	// worker invoked last, which is likely to be invoked next. The others start
	// when they're invoked, so a save doesn't start a worker for every
	// environment of a function at once. One that's still running an
	// invocation is replaced once it's done.
	restartAfterBuild := func(built func(functionID string) bool) {
		stateMu.Lock()
		last := map[string]*WorkerInfo{}
		toRestart := map[string]*WorkerInfo{}
		for workerID, info := range workers {
			if !built(info.FunctionID) {
				continue
			}
			if latest, ok := last[info.FunctionID]; !ok || info.LastInvoked.After(latest.LastInvoked) {
				last[info.FunctionID] = info
			}
			if info.Outdated {
				continue
			}
			toRestart[workerID] = info
		}
		for _, info := range last {
			if info.Outdated {
				info.Eager = true
			}
		}
		stateMu.Unlock()
		for workerID, info := range toRestart {
			restartOrDeferWorker(workerID, info, last[info.FunctionID] == info)
		}
	}

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
						stopWhenDone(worker)
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
		restartAfterBuild(func(functionID string) bool { return rebuilt[functionID] })
	}

	for {
		select {
		case <-ctx.Done():
			return
		case msg := <-loopMsg:
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
				// A bridge sends its init, then its first invocation. When the
				// invocation is handled first, the worker isn't there yet, so the
				// bridge is asked for its init again. It answers whenever the ask
				// arrives, while it waits for a reply or for what the function
				// printed, so this init finds the worker the first init started.
				// Nothing is wrong.
				if _, ok := loadWorker(workerID); ok {
					log.Info("init for a worker that's already running", "workerID", workerID, "functionID", init.FunctionID)
					continue
				}
				log.Info("worker init", "workerID", msg.Source, "functionID", init.FunctionID)
				workerEnv[workerID] = init.Environment
				workerFunction[workerID] = init.FunctionID
				if ok, why := startWorker(init.FunctionID, workerID); !ok {
					failedToStart(init.FunctionID, workerID, why)
				}
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
			current := ok && existing == info
			queued := false
			if current {
				log.Info("deleting worker", "workerID", info.WorkerID)
				delete(workers, info.WorkerID)
				// an invocation can be queued for a worker that's exiting, as it
				// still counted as running when the invocation arrived. Its bridge
				// has had the ping, so it would wait until Lambda times it out.
				// A worker that never asked for one failed as it started, and
				// has sent its bridge an init error, so it isn't started again.
				queued = info.Polled && len(nextChan[info.WorkerID]) > 0
				if !queued {
					delete(nextChan, info.WorkerID)
				}
			}
			stateMu.Unlock()
			if queued {
				restart(info.FunctionID, info.WorkerID)
			} else if current {
				forgetLater(info.WorkerID)
			}
			break
		case info := <-replaced:
			stateMu.Lock()
			current := workers[info.WorkerID] == info
			eager := info.Eager
			if current {
				info.Stopped = true
			}
			stateMu.Unlock()
			// it may have been replaced already, or exited
			if !current {
				break
			}
			if info.replaceAt != nil {
				info.replaceAt.Stop()
			}
			log.Info("stopping", "workerID", info.WorkerID, "functionID", info.FunctionID)
			info.Worker.Stop()
			restartOrDeferWorker(info.WorkerID, info, eager)
		case workerID := <-requeued:
			stateMu.Lock()
			_, running := workers[workerID]
			queued := len(nextChan[workerID]) > 0
			stateMu.Unlock()
			if running || !queued {
				break
			}
			// A worker that sst dev has run before, as one that exited after a
			// minute without work, or wasn't started again after a rebuild, is
			// started with the environment its bridge sent then, until it's
			// forgotten (see forgetAfter). Asking the bridge for it again takes a
			// round trip.
			if functionID, ok := workerFunction[workerID]; ok {
				restart(functionID, workerID)
				break
			}
			go askForReboot(workerID)
		case <-forgetTick.C:
			for workerID, stopped := range stoppedAt {
				if time.Since(stopped) < forgetAfter {
					continue
				}
				log.Info("forgetting the environment of a worker that stopped", "workerID", workerID)
				bus.Publish(&FunctionWorkerForgottenEvent{
					FunctionID: workerFunction[workerID],
					WorkerID:   workerID,
				})
				delete(stoppedAt, workerID)
				delete(workerEnv, workerID)
				delete(workerFunction, workerID)
				if cloudLogs != nil {
					cloudLogs.take(workerID)
				}
				// an invocation queued for it as it's forgotten asks its bridge
				// for the environment again
				stateMu.Lock()
				if len(nextChan[workerID]) == 0 {
					delete(nextChan, workerID)
				}
				stateMu.Unlock()
			}
		case unknown := <-evts:
			switch evt := unknown.(type) {
			case *project.CompleteEvent:
				if evt.Old {
					continue
				}
				for _, info := range workers {
					stopWhenDone(info)
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
				restartAfterBuild(func(functionID string) bool { return !failed[functionID] })
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

// longestInvocation is how long a worker running an invocation through a
// rebuild is left to finish it, when the invocation came without a deadline.
// Lambda sends one, and its longest timeout is 15 minutes.
var longestInvocation = 15 * time.Minute

// forgetAfter is how long sst dev keeps the environment of a worker that
// stopped, as when it exited after a minute without work, to start it again
// without asking its bridge. Lambda keeps making new environments for a
// function and removing idle ones, so a long session sees thousands, and
// keeping each one's variables for good grows sst dev's memory with every
// one. An environment invoked again after this is asked for its variables
// again, which takes a round trip.
var forgetAfter = 15 * time.Minute

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
// the first error. The writer publishes its packets as they fill, in the
// background, so a request that failed can come back from the copy as well as
// the close.
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
