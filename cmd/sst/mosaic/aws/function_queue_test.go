package aws

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"sync"
	"testing"
	"time"

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
