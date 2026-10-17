package aws

// A harness that runs function, the part of sst dev that runs functions
// locally, with stand-ins for what's around it: AppSync, the bridges deployed
// as the functions in AWS, and the runtime that runs a function's workers. The
// bridges and workers talk to function the way the real ones do, over AppSync
// and the local runtime API, so a test can play out an invocation from end to
// end, and lose or delay what the real ones can.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/bridge"
	"github.com/sst/sst/v3/pkg/bus"
	"github.com/sst/sst/v3/pkg/project"
	"github.com/sst/sst/v3/pkg/runtime"
	"github.com/sst/sst/v3/pkg/server"
)

// fakeAppSync stands in for AppSync Events: an event published to a channel
// goes to the channel's subscribers.
type fakeAppSync struct {
	mu   sync.Mutex
	subs map[string][]chan string
}

func (f *fakeAppSync) Publish(ctx context.Context, channel string, event interface{}) error {
	data, err := json.Marshal(event)
	if err != nil {
		return err
	}
	f.mu.Lock()
	subs := slices.Clone(f.subs[channel])
	f.mu.Unlock()
	for _, sub := range subs {
		sub <- string(data)
	}
	return nil
}

func (f *fakeAppSync) Subscribe(ctx context.Context, channel string) (chan string, error) {
	sub := make(chan string, 1000)
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.subs == nil {
		f.subs = map[string][]chan string{}
	}
	f.subs[channel] = append(f.subs[channel], sub)
	return sub, nil
}

// fakeRuntime stands in for a language runtime. Its builds write a handler
// file, and its workers answer each invocation with handle.
type fakeRuntime struct {
	// handle answers an invocation's event
	handle func(event string) string
	// idle is how long a worker waits for an invocation before it exits, as
	// the Node.js runtime does after a minute. Zero waits for good.
	idle time.Duration
	// exitDelay is how long a worker's output stays open after it exits, the
	// time sst dev takes to notice.
	exitDelay time.Duration
	// polling, when set, holds a worker's first request for an invocation
	// until it's closed
	polling chan struct{}
	// builds holds the build of a function in it until its channel is closed,
	// and held is sent the function when its build is held
	builds map[string]chan struct{}
	held   chan string

	starts atomic.Int32
}

func (r *fakeRuntime) Match(runtime string) bool { return runtime == "fake" }

func (r *fakeRuntime) Build(ctx context.Context, input *runtime.BuildInput) (*runtime.BuildOutput, error) {
	if release, ok := r.builds[input.FunctionID]; ok {
		if r.held != nil {
			r.held <- input.FunctionID
		}
		select {
		case <-release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if err := os.WriteFile(filepath.Join(input.Out(), "index.mjs"), []byte("export const handler = 1"), 0644); err != nil {
		return nil, err
	}
	return &runtime.BuildOutput{Handler: "index.handler", Errors: []string{}}, nil
}

func (r *fakeRuntime) Run(ctx context.Context, input *runtime.RunInput) (runtime.Worker, error) {
	r.starts.Add(1)
	logs, output := io.Pipe()
	w := &fakeWorker{runtime: r, api: "http://" + input.Server + "/2018-06-01/runtime", stop: make(chan struct{}), logs: logs}
	go w.run(ctx, output)
	return w, nil
}

func (r *fakeRuntime) ShouldRebuild(functionID string, path string) bool { return false }

func (r *fakeRuntime) ShouldRunEagerly() bool { return true }

type fakeWorker struct {
	runtime  *fakeRuntime
	api      string
	stop     chan struct{}
	stopOnce sync.Once
	logs     *io.PipeReader
}

func (w *fakeWorker) Stop() { w.stopOnce.Do(func() { close(w.stop) }) }

func (w *fakeWorker) Logs() io.ReadCloser { return w.logs }

// run asks for invocations and answers them until it's stopped or idle, then
// closes its output, which is how sst dev tells a worker exited.
func (w *fakeWorker) run(ctx context.Context, output *io.PipeWriter) {
	defer func() {
		time.Sleep(w.runtime.exitDelay)
		output.Close()
	}()
	if w.runtime.polling != nil {
		select {
		case <-w.runtime.polling:
		case <-w.stop:
			return
		}
	}
	for {
		next, cancel := context.WithCancel(ctx)
		var idle *time.Timer
		if w.runtime.idle > 0 {
			idle = time.AfterFunc(w.runtime.idle, cancel)
		}
		go func() {
			select {
			case <-w.stop:
				cancel()
			case <-next.Done():
			}
		}()
		req, _ := http.NewRequestWithContext(next, "GET", w.api+"/invocation/next", nil)
		resp, err := http.DefaultClient.Do(req)
		if idle != nil {
			idle.Stop()
		}
		if err != nil {
			cancel()
			return
		}
		event, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		cancel()
		requestID := resp.Header.Get("lambda-runtime-aws-request-id")
		answer := w.runtime.handle(string(event))
		resp, err = http.Post(w.api+"/invocation/"+requestID+"/response", "application/json", strings.NewReader(answer))
		if err != nil {
			return
		}
		resp.Body.Close()
	}
}

// harness runs function against the fakes.
type harness struct {
	t       *testing.T
	mux     *http.ServeMux
	ctx     context.Context
	appsync *fakeAppSync
	runtime *fakeRuntime
	prefix  string
	cfgPath string
	// how long a bridge waits for the ping, and then for the reply
	pingTimeout   time.Duration
	invokeTimeout time.Duration
	envs          atomic.Int32
}

func newHarness(t *testing.T, rt *fakeRuntime) *harness {
	t.Helper()
	mux := http.NewServeMux()
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	// cleanups run last first: the workers stop before the server waits for
	// their requests to end
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	h := &harness{
		t:             t,
		mux:           mux,
		ctx:           ctx,
		appsync:       &fakeAppSync{},
		runtime:       rt,
		prefix:        "/sst/app/" + strings.ReplaceAll(t.Name(), "/", "-"),
		cfgPath:       filepath.Join(t.TempDir(), "sst.config.ts"),
		pingTimeout:   2 * time.Second,
		invokeTimeout: 5 * time.Second,
	}
	client := bridge.NewClient(ctx, h.appsync, "dev", h.prefix)
	msg := make(chan bridge.Message)
	go function(ctx, input{
		project: &project.Project{Runtime: runtime.NewCollection(h.cfgPath, rt)},
		server:  &server.Server{Mux: mux, Port: srv.Listener.Addr().(*net.TCPAddr).Port},
		client:  client,
		msg:     msg,
		prefix:  h.prefix,
	})
	// msg is only read once function's loop runs, which is after it subscribes
	// to the bus, so the functions added next aren't missed
	msg <- bridge.Message{Type: bridge.MessageInit, Source: "sync", Body: strings.NewReader(`{"functionID":"none"}`)}
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case m := <-client.Read():
				if m.Source == "dev" {
					continue
				}
				select {
				case msg <- m:
				case <-ctx.Done():
					return
				}
			}
		}
	}()
	return h
}

// addFunction tells sst dev about a function, as a deploy does.
func (h *harness) addFunction(functionID string) {
	bus.Publish(&runtime.BuildInput{
		FunctionID: functionID,
		Runtime:    "fake",
		Handler:    "index.handler",
		CfgPath:    h.cfgPath,
		Dev:        true,
	})
}

// fakeBridge stands in for the bridge deployed as a function, in one Lambda
// execution environment. It follows the protocol of the real one.
type fakeBridge struct {
	h          *harness
	functionID string
	workerID   string
	client     *bridge.Client
	requests   atomic.Int32
	// pinged is sent to when sst dev pings the bridge
	pinged chan struct{}
}

// bridge starts a bridge for the function, which tells sst dev it's there.
func (h *harness) bridge(functionID string) *fakeBridge {
	workerID := fmt.Sprintf("%032d", h.envs.Add(1))
	b := &fakeBridge{
		h:          h,
		functionID: functionID,
		workerID:   workerID,
		client:     bridge.NewClient(h.ctx, h.appsync, workerID, h.prefix+"/"+workerID),
		pinged:     make(chan struct{}, 100),
	}
	b.init()
	return b
}

func (b *fakeBridge) init() {
	writer := b.client.NewWriter(bridge.MessageInit, b.h.prefix+"/in")
	if err := sendJSON(writer, bridge.InitBody{FunctionID: b.functionID, Environment: []string{}}); err != nil {
		b.h.t.Error(err)
	}
}

var errNoPing = errors.New("sst dev didn't ping")
var errNoReply = errors.New("sst dev pinged, then didn't reply")

// invoke hands sst dev an invocation, as Lambda hands one to the bridge, and
// returns the reply.
func (b *fakeBridge) invoke(event string) (string, error) {
	requestID := fmt.Sprintf("%s-%d", b.workerID, b.requests.Add(1))
	resp := &http.Response{
		StatusCode:    http.StatusOK,
		ProtoMajor:    1,
		ProtoMinor:    1,
		Header:        http.Header{"Lambda-Runtime-Aws-Request-Id": {requestID}},
		Body:          io.NopCloser(strings.NewReader(event)),
		ContentLength: int64(len(event)),
	}
	var next bytes.Buffer
	if err := resp.Write(&next); err != nil {
		return "", err
	}
	if err := sendMessage(b.client.NewWriter(bridge.MessageNext, b.h.prefix+"/in"), &next); err != nil {
		return "", err
	}
	timeout, timedOut := b.h.pingTimeout, errNoPing
	for {
		select {
		case <-b.h.ctx.Done():
			return "", b.h.ctx.Err()
		case msg := <-b.client.Read():
			switch msg.Type {
			case bridge.MessagePing:
				timeout, timedOut = b.h.invokeTimeout, errNoReply
				b.pinged <- struct{}{}
			case bridge.MessageReboot:
				b.init()
			case bridge.MessageResponse, bridge.MessageError:
				if msg.ID != requestID {
					continue
				}
				body, _ := io.ReadAll(msg.Body)
				if msg.Type == bridge.MessageError {
					return "", fmt.Errorf("function failed: %s", body)
				}
				return string(body), nil
			case bridge.MessageInitError:
				body, _ := io.ReadAll(msg.Body)
				return "", fmt.Errorf("function failed to start: %s", body)
			}
		case <-time.After(timeout):
			return "", timedOut
		}
	}
}

func echo(event string) string { return "echo " + event }

// The harness plays out an invocation from end to end.
func TestHarnessInvokes(t *testing.T) {
	h := newHarness(t, &fakeRuntime{handle: echo})
	h.addFunction("Fn")
	b := h.bridge("Fn")
	for i := range 3 {
		got, err := b.invoke(fmt.Sprintf(`{"n":%d}`, i))
		if err != nil {
			t.Fatalf("invocation %d: %v", i, err)
		}
		if want := fmt.Sprintf(`echo {"n":%d}`, i); got != want {
			t.Fatalf("invocation %d: got %q, want %q", i, got, want)
		}
	}
	if got := h.runtime.starts.Load(); got != 1 {
		t.Fatalf("started %d workers, want 1", got)
	}
}

// An environment that sst dev has no worker for, as after sst dev restarts, is
// asked to say it's there again, and then served.
func TestHarnessReboots(t *testing.T) {
	h := newHarness(t, &fakeRuntime{handle: echo})
	// the bridge can say it's there before sst dev knows the function, which
	// drops it
	b := h.bridge("Late")
	h.addFunction("Late")
	got, err := b.invoke("x")
	if err != nil {
		t.Fatal(err)
	}
	if got != "echo x" {
		t.Fatalf("got %q, want %q", got, "echo x")
	}
}

// Invocations of many environments at once are each served by their own worker.
func TestHarnessConcurrentEnvironments(t *testing.T) {
	h := newHarness(t, &fakeRuntime{handle: echo})
	h.addFunction("Fn")
	bridges := make([]*fakeBridge, 20)
	for i := range bridges {
		bridges[i] = h.bridge("Fn")
	}
	var wg sync.WaitGroup
	for i, b := range bridges {
		wg.Add(1)
		go func() {
			defer wg.Done()
			event := fmt.Sprintf("%d", i)
			got, err := b.invoke(event)
			if err != nil {
				t.Errorf("environment %d: %v", i, err)
				return
			}
			if got != "echo "+event {
				t.Errorf("environment %d: got %q, want %q", i, got, "echo "+event)
			}
		}()
	}
	wg.Wait()
}
