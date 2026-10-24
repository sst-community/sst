package aws

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sst/sst/v3/cmd/sst/mosaic/watcher"
	"github.com/sst/sst/v3/pkg/bus"
	"github.com/sst/sst/v3/pkg/project"
)

// A worker can exit, as the Node.js runtime does after a minute without work,
// while sst dev still counts it as running. An invocation that arrives then is
// queued for it, and its bridge has had the ping. The worker is started again
// for it, instead of the invocation being dropped with the worker.
func TestWorkerExitWithQueuedInvocation(t *testing.T) {
	h := newHarness(t, &fakeRuntime{handle: echo, idle: 100 * time.Millisecond, exitDelay: time.Second})
	h.addFunction("Fn")
	b := h.bridge("Fn")
	if _, err := b.invoke("first"); err != nil {
		t.Fatal(err)
	}
	// the worker exits on idle, and sst dev hasn't noticed yet
	time.Sleep(300 * time.Millisecond)

	got, err := b.invoke("second")
	if err != nil {
		t.Fatalf("invocation after the worker exited: %v", err)
	}
	if got != "echo second" {
		t.Fatalf("got %q, want %q", got, "echo second")
	}
	if got := h.runtime.starts.Load(); got != 2 {
		t.Fatalf("started %d workers, want 2", got)
	}
}

// A worker that's running before sst dev has recorded it, as on a busy
// machine, counts what it does then: it asked for an invocation, so it started,
// and when it exits with one queued it's started again for it. Before, its
// requests went uncounted, it was taken for one that failed as it started, and
// the invocation was dropped with it.
func TestWorkerRecordedLateIsStartedAgainForItsQueue(t *testing.T) {
	h := newHarness(t, &fakeRuntime{handle: echo, idle: 100 * time.Millisecond, exitDelay: time.Second, recordedLate: true})
	h.addFunction("Fn")
	b := h.bridge("Fn")
	if _, err := b.invoke("first"); err != nil {
		t.Fatal(err)
	}
	// the worker exits on idle, and sst dev hasn't noticed yet
	time.Sleep(300 * time.Millisecond)
	got, err := b.invoke("second")
	if err != nil {
		t.Fatalf("invocation after a worker recorded late exited: %v", err)
	}
	if got != "echo second" {
		t.Fatalf("got %q, want %q", got, "echo second")
	}
	// by a worker started again, not the one that exited
	if got := h.runtime.starts.Load(); got != 2 {
		t.Fatalf("started %d workers, want 2", got)
	}
}

// What a worker prints as it runs an invocation is tied to that invocation,
// though sst dev's loop is held up, here building another function. Before, the
// loop tied a worker's lines to its invocation from an event it hadn't got to,
// so they went with the invocation before, or with none.
func TestLinesAreTiedToTheirInvocationWhileTheLoopIsBusy(t *testing.T) {
	slow := make(chan struct{})
	held := make(chan string, 1)
	h := newHarness(t, &fakeRuntime{handle: echo, prints: "working on it", builds: map[string]chan struct{}{"Slow": slow}, held: held})
	defer close(slow)
	h.addFunction("Fast")
	h.addFunction("Slow")
	lines := bus.Subscribe(&FunctionLogEvent{})
	defer bus.Unsubscribe(lines)
	fast := h.bridge("Fast")
	if _, err := fast.invoke("warm"); err != nil {
		t.Fatal(err)
	}
	// the warm invocation's line, so the next is the second's
	select {
	case <-lines:
	case <-time.After(5 * time.Second):
		t.Fatal("nothing was printed")
	}

	// the Slow function starts building, and holds up the loop till it's let
	h.bridge("Slow")
	select {
	case <-held:
	case <-time.After(5 * time.Second):
		t.Fatal("the Slow function's build never started")
	}
	if _, err := fast.invoke("x"); err != nil {
		t.Fatal(err)
	}
	select {
	case evt := <-lines:
		line := evt.(*FunctionLogEvent)
		if want := fast.workerID + "-2"; line.RequestID != want {
			t.Fatalf("%q was tied to invocation %q, want %q", line.Line, line.RequestID, want)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("nothing was printed")
	}
}

// A worker that takes its first invocation before sst dev has recorded it is
// running it, so a rebuild leaves it to finish. Before, sst dev didn't know it
// was busy, stopped it, and the invocation was never answered.
func TestWorkerRecordedLateIsLeftToFinishThroughARebuild(t *testing.T) {
	release := make(chan struct{})
	h := newHarness(t, &fakeRuntime{rebuild: true, recordedAfterTaking: true, handle: func(event string) string {
		if event == "first" {
			<-release
		}
		return echo(event)
	}})
	h.addFunction("Fn")
	b := h.bridge("Fn")
	reply := make(chan error, 1)
	go func() {
		got, err := b.invoke("first")
		if err == nil && got != "echo first" {
			err = errors.New("got " + got)
		}
		reply <- err
	}()
	// the worker has the invocation, and sst dev has recorded it since
	for start := time.Now(); h.runtime.starts.Load() == 0; time.Sleep(time.Millisecond) {
		if time.Since(start) > 5*time.Second {
			t.Fatal("the worker never started")
		}
	}
	time.Sleep(500 * time.Millisecond)
	bus.Publish(&watcher.FileChangedEvent{Path: "src/handler.ts"})
	time.Sleep(500 * time.Millisecond)
	close(release)
	if err := <-reply; err != nil {
		t.Fatalf("the invocation running through a rebuild: %v", err)
	}
}

// A worker that fails an invocation before sst dev has recorded it has its error
// shown, as after. Before, sst dev didn't know whose it was, so it published
// none.
func TestWorkerRecordedLateShowsItsError(t *testing.T) {
	h := newHarness(t, &fakeRuntime{handle: echo, recordedLate: true, failInvocations: true})
	h.addFunction("Fn")
	errs := bus.Subscribe(&FunctionErrorEvent{})
	defer bus.Unsubscribe(errs)
	b := h.bridge("Fn")
	if _, err := b.invoke("first"); err == nil {
		t.Fatal("the invocation succeeded, want it to fail")
	}
	select {
	case evt := <-errs:
		if got := evt.(*FunctionErrorEvent); got.FunctionID != "Fn" || got.ErrorMessage != "echo first" {
			t.Fatalf("published %+v, want Fn's error", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no error was published")
	}
}

// A streamed function's worker that answers before sst dev has recorded it has
// its answer streamed, as it would after. Before, sst dev didn't know the
// worker yet, so it sent the answer as a whole reply.
func TestWorkerRecordedLateStreams(t *testing.T) {
	h := newHarness(t, &fakeRuntime{handle: echo, recordedLate: true})
	h.addFunction("Fn")
	responses := bus.Subscribe(&FunctionResponseEvent{})
	defer bus.Unsubscribe(responses)
	b := h.bridgeWithEnv("Fn", []string{"SST_FUNCTION_STREAMING=true"})
	if _, err := b.invoke("first"); err != nil {
		t.Fatal(err)
	}
	select {
	case evt := <-responses:
		if got := string(evt.(*FunctionResponseEvent).Output); got != "[streaming response]" {
			t.Fatalf("the first answer went as %q, want it streamed", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no response")
	}
}

// When a worker that exits with an invocation queued can't be started again, the
// invocation fails straight away, instead of at Lambda's timeout, and isn't
// left queued for the next worker the bridge gets.
func TestQueuedInvocationFailsWhenTheWorkerCantRestart(t *testing.T) {
	var mu sync.Mutex
	ran := []string{}
	h := newHarness(t, &fakeRuntime{handle: func(event string) string {
		mu.Lock()
		ran = append(ran, event)
		mu.Unlock()
		return echo(event)
	}, idle: 100 * time.Millisecond, exitDelay: time.Second})
	h.addFunction("Fn")
	b := h.bridge("Fn")
	if _, err := b.invoke("first"); err != nil {
		t.Fatal(err)
	}
	// the worker exits on idle, and sst dev hasn't noticed yet
	time.Sleep(300 * time.Millisecond)
	h.runtime.failRuns.Store(true)
	errs := bus.Subscribe(&FunctionErrorEvent{})
	defer bus.Unsubscribe(errs)

	start := time.Now()
	_, err := b.invoke("second")
	if err == nil || errors.Is(err, errNoReply) {
		t.Fatalf("invocation whose worker couldn't restart: got %v, want it to fail to start", err)
	}
	if waited := time.Since(start); waited > 3*time.Second {
		t.Errorf("it failed after %v, want straight away", waited.Round(time.Millisecond))
	}
	// what sst dev shows and logs for it
	select {
	case evt := <-errs:
		if e := evt.(*FunctionErrorEvent); e.FunctionID != "Fn" || e.ErrorMessage != "Function failed to start" {
			t.Errorf("got error event %+v, want one for Fn saying it failed to start", e)
		}
	case <-time.After(time.Second):
		t.Error("no error event, so sst dev shows nothing for the failed invocation")
	}

	h.runtime.failRuns.Store(false)
	got, err := b.invoke("third")
	if err != nil {
		t.Fatal(err)
	}
	if got != echo("third") {
		t.Errorf("got %q, want %q", got, echo("third"))
	}
	mu.Lock()
	defer mu.Unlock()
	if slices.Contains(ran, "second") {
		t.Errorf("the failed invocation was run later, by the next worker: ran %q", ran)
	}
}

// A deploy stops every worker. A runtime that starts workers only when they're
// invoked, as Python's does, doesn't start one again then. An invocation already
// queued for a worker that was stopped is still run, instead of waiting for one
// that isn't coming.
func TestQueuedInvocationRunsAfterADeployWithALazyRuntime(t *testing.T) {
	polling := make(chan struct{})
	h := newHarness(t, &fakeRuntime{handle: echo, lazy: true, polling: polling})
	h.addFunction("Fn")
	b := h.bridge("Fn")

	reply := make(chan error, 1)
	go func() {
		got, err := b.invoke("x")
		if err == nil && got != "echo x" {
			t.Errorf("got %q, want %q", got, "echo x")
		}
		reply <- err
	}()
	select {
	case <-b.pinged:
	case err := <-reply:
		t.Fatalf("invocation ended before the ping: %v", err)
	}
	// queued for the worker, which hasn't asked for it yet
	time.Sleep(50 * time.Millisecond)

	bus.Publish(&project.CompleteEvent{})
	// the stopped worker has gone before any other asks
	time.Sleep(200 * time.Millisecond)
	close(polling)
	if err := <-reply; err != nil {
		t.Fatalf("invocation queued before the deploy: %v", err)
	}
}

// A worker that fails as it starts, as when its handler throws on import, has
// already failed its invocation with an init error. It isn't started again and
// again for that invocation, which is still queued as it never asked for it.
func TestWorkerThatFailsToStartIsNotStartedOverAndOver(t *testing.T) {
	h := newHarness(t, &fakeRuntime{handle: echo})
	h.runtime.crash.Store(true)
	h.addFunction("Fn")
	b := h.bridge("Fn")
	b.invoke("x")
	time.Sleep(time.Second)
	// one start for the bridge's init, and one for the reboot it's asked for
	if starts := h.runtime.starts.Load(); starts > 3 {
		t.Errorf("a worker that fails to start was started %d times in a second", starts)
	}
}

// A deploy starts again each lazy runtime's worker that has an invocation
// queued, once, however many environments there are.
func TestDeployStartsEachQueuedLazyWorkerOnce(t *testing.T) {
	polling := make(chan struct{})
	h := newHarness(t, &fakeRuntime{handle: echo, lazy: true, polling: polling})
	h.addFunction("Fn")
	const envs = 20
	replies := make(chan error, envs)
	for range envs {
		b := h.bridge("Fn")
		go func() {
			_, err := b.invoke("x")
			replies <- err
		}()
		<-b.pinged
	}
	time.Sleep(100 * time.Millisecond)

	bus.Publish(&project.CompleteEvent{})
	time.Sleep(300 * time.Millisecond)
	close(polling)
	for range envs {
		if err := <-replies; err != nil {
			t.Fatalf("an invocation queued before the deploy: %v", err)
		}
	}
	if starts := h.runtime.starts.Load(); starts != 2*envs {
		t.Errorf("started %d workers for %d environments, want %d: one each, and one again after the deploy", starts, envs, 2*envs)
	}
}

// A worker's request for the next invocation can end, as when the worker exits,
// just as an invocation is handed to it. The invocation is put back for the
// worker's next request instead of being written to a request that's gone.
func TestNextPutsBackAnInvocationForAWorkerThatLeft(t *testing.T) {
	polling := make(chan struct{})
	h := newHarness(t, &fakeRuntime{handle: echo, polling: polling})
	h.addFunction("Fn")
	b := h.bridge("Fn")

	reply := make(chan error, 1)
	go func() {
		got, err := b.invoke("x")
		if err == nil && got != "echo x" {
			t.Errorf("got %q, want %q", got, "echo x")
		}
		reply <- err
	}()
	select {
	case <-b.pinged:
	case err := <-reply:
		t.Fatalf("invocation ended before the ping: %v", err)
	}
	// the invocation is queued right after the ping
	time.Sleep(50 * time.Millisecond)

	// requests whose worker has gone. Each one either sees that first, or takes
	// the invocation, so 20 of them all but surely take it once.
	gone, cancel := context.WithCancel(context.Background())
	cancel()
	for range 20 {
		r := httptest.NewRequest(http.MethodGet, "/lambda/"+b.workerID+"/2018-06-01/runtime/invocation/next", nil).WithContext(gone)
		h.mux.ServeHTTP(httptest.NewRecorder(), r)
	}

	close(polling)
	if err := <-reply; err != nil {
		t.Fatalf("invocation was lost: %v", err)
	}
}

// A function that takes long to build holds up only its own invocations. Other
// bridges still get their ping, which they give up on after 16 seconds, and
// their workers still get the invocations.
func TestBuildDoesNotHoldUpOtherFunctions(t *testing.T) {
	slow := make(chan struct{})
	held := make(chan string, 1)
	h := newHarness(t, &fakeRuntime{handle: echo, builds: map[string]chan struct{}{"Slow": slow}, held: held})
	h.addFunction("Fast")
	h.addFunction("Slow")
	fast := h.bridge("Fast")
	if _, err := fast.invoke("warm"); err != nil {
		t.Fatal(err)
	}

	// the Slow function starts building, and doesn't finish until it's let
	h.bridge("Slow")
	select {
	case <-held:
	case <-time.After(5 * time.Second):
		t.Fatal("the Slow function's build never started")
	}

	for i := range 3 {
		got, err := fast.invoke("x")
		if err != nil {
			t.Fatalf("invocation %d while another function builds: %v", i, err)
		}
		if got != "echo x" {
			t.Fatalf("got %q, want %q", got, "echo x")
		}
	}
	close(slow)
}

// A worker that exited, as a Node.js worker does after a minute without work, is
// started again for its environment's next invocation with the environment its
// bridge sent before. Asking the bridge to send it again took a round trip.
func TestWorkerThatExitedStartsWithoutAReboot(t *testing.T) {
	h := newHarness(t, &fakeRuntime{handle: echo, idle: 100 * time.Millisecond})
	h.addFunction("Fn")
	b := h.bridge("Fn")
	if _, err := b.invoke("x"); err != nil {
		t.Fatal(err)
	}
	reboots := b.reboots.Load()
	// the worker exits without work
	time.Sleep(500 * time.Millisecond)

	got, err := b.invoke("y")
	if err != nil {
		t.Fatal(err)
	}
	if got != "echo y" {
		t.Fatalf("got %q, want %q", got, "echo y")
	}
	if n := b.reboots.Load() - reboots; n > 0 {
		t.Fatalf("the bridge was asked to say it's there again %d times, when sst dev knew it", n)
	}
	if starts := h.runtime.starts.Load(); starts != 2 {
		t.Fatalf("started %d workers, want 2", starts)
	}
}

// A second init for a worker that's running, as a bridge sends when it's asked
// for its init again after its first invocation was handled before its first
// init, doesn't start another worker.
func TestSecondInitForARunningWorker(t *testing.T) {
	h := newHarness(t, &fakeRuntime{handle: echo})
	h.addFunction("Fn")
	b := h.bridge("Fn")
	if _, err := b.invoke("x"); err != nil {
		t.Fatal(err)
	}
	b.init()
	time.Sleep(100 * time.Millisecond)
	got, err := b.invoke("y")
	if err != nil || got != "echo y" {
		t.Fatalf("got %q, %v, want %q", got, err, "echo y")
	}
	if starts := h.runtime.starts.Load(); starts != 1 {
		t.Fatalf("started %d workers, want 1", starts)
	}
}

// A function whose worker can't start fails its invocation straight away with
// an init error, not at Lambda's timeout. The error says why, its build failed
// or its runtime couldn't run it, whether the bridge's init or its invocation
// was handled first. The next invocation, once the worker can start, runs.
func TestInvocationFailsWhenTheWorkerCantStart(t *testing.T) {
	for _, c := range []struct {
		name string
		why  string
		fail func(r *fakeRuntime) *atomic.Bool
	}{
		{"build", "Function failed to build", func(r *fakeRuntime) *atomic.Bool { return &r.failBuilds }},
		{"run", "Function failed to start", func(r *fakeRuntime) *atomic.Bool { return &r.failRuns }},
	} {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t, &fakeRuntime{handle: echo})
			c.fail(h.runtime).Store(true)
			h.addFunction("Fn")
			b := h.bridge("Fn")
			start := time.Now()
			_, err := b.invoke("x")
			if err == nil || !strings.Contains(err.Error(), "function failed to start") || !strings.Contains(err.Error(), c.why) {
				t.Fatalf("invoke() = %v, want the init error saying %q", err, c.why)
			}
			if took := time.Since(start); took > 2*time.Second {
				t.Fatalf("the init error took %v", took)
			}

			c.fail(h.runtime).Store(false)
			got, err := b.invoke("y")
			if err != nil || got != "echo y" {
				t.Fatalf("invoke() after the worker can start = %q, %v, want its answer", got, err)
			}
		})
	}
}
