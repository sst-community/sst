package aws

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
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
