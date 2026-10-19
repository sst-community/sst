package aws

import (
	"fmt"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/sst/sst/v3/cmd/sst/mosaic/watcher"
	"github.com/sst/sst/v3/pkg/bus"
)

// forgetSoon makes sst dev forget the environment of a worker that stopped
// after d, for the test. The loop reads it as it starts, so it's called before
// newHarness, and set back once the loop has stopped. That holds only because
// the tests that use the harness don't run in parallel.
func forgetSoon(t *testing.T, d time.Duration) {
	old := forgetAfter
	forgetAfter = d
	t.Cleanup(func() { forgetAfter = old })
}

// Lambda keeps making new execution environments for a function, and removes
// idle ones, so over a long session sst dev sees thousands. What it knows about
// each, its environment variables among them, is forgotten a while after its
// worker exits, or its memory grows with every one.
func TestFunctionForgetsEnvironmentsThatAreGone(t *testing.T) {
	forgetSoon(t, 100*time.Millisecond)
	h := newHarness(t, &fakeRuntime{handle: echo, idle: 20 * time.Millisecond})
	h.addFunction("Fn")
	// a Lambda environment's variables, as a bridge sends them, are a few KB
	env := []string{"SST_RESOURCE_App=" + strings.Repeat("x", 10<<10)}

	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	for i := range 1000 {
		b := h.bridgeWithEnv("Fn", env)
		if _, err := b.invoke(fmt.Sprintf("%d", i)); err != nil {
			t.Fatalf("environment %d: %v", i, err)
		}
		b.close()
	}
	// the workers exit on idle, and the replies stop being sent again
	time.Sleep(replyResends*replyResendEvery + time.Second)
	runtime.GC()
	runtime.ReadMemStats(&after)
	if grew, limit := int64(after.HeapAlloc)-int64(before.HeapAlloc), int64(3<<20); grew > limit {
		t.Fatalf("1,000 environments that are gone hold %d MB, want under %d MB", grew>>20, limit>>20)
	}
}

// The environment of a worker that exited is kept for a while, so the worker
// starts again without asking its bridge, and then forgotten. A worker that
// starts again in that time is kept for as long again once it exits.
func TestEnvironmentIsForgottenAWhileAfterItsWorkerExits(t *testing.T) {
	forgetSoon(t, 2*time.Second)
	h := newHarness(t, &fakeRuntime{handle: echo, idle: 50 * time.Millisecond})
	h.addFunction("Fn")
	b := h.bridge("Fn")
	invoke := func(event string, wantAsked int32) {
		t.Helper()
		reboots := b.reboots.Load()
		got, err := b.invoke(event)
		if err != nil {
			t.Fatalf("%s: %v", event, err)
		}
		if got != "echo "+event {
			t.Fatalf("%s: got %q, want %q", event, got, "echo "+event)
		}
		if n := b.reboots.Load() - reboots; n != wantAsked {
			t.Fatalf("%s: the bridge was asked for its environment %d times, want %d", event, n, wantAsked)
		}
	}
	// the first can ask, when the invocation comes before the bridge said it's there
	if _, err := b.invoke("first"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(1200 * time.Millisecond)
	invoke("kept", 0)
	// past the time after the first exit, but not after the second
	time.Sleep(1200 * time.Millisecond)
	invoke("kept-again", 0)
	time.Sleep(3 * time.Second)
	invoke("forgotten", 1)
}

// A worker that's running when the time its environment is kept for is up,
// started again since it exited, keeps it.
func TestEnvironmentOfARunningWorkerIsKept(t *testing.T) {
	forgetSoon(t, 2*time.Second)
	h := newHarness(t, &fakeRuntime{handle: echo, idle: 1600 * time.Millisecond})
	h.addFunction("Fn")
	b := h.bridge("Fn")
	if _, err := b.invoke("first"); err != nil {
		t.Fatal(err)
	}
	reboots := b.reboots.Load()
	// it exits after 1.6 s, and runs again from 2.6 s to 4.2 s, past 3.6 s
	time.Sleep(2600 * time.Millisecond)
	if _, err := b.invoke("running"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(2200 * time.Millisecond)
	if _, err := b.invoke("after"); err != nil {
		t.Fatal(err)
	}
	if n := b.reboots.Load() - reboots; n > 0 {
		t.Fatalf("the bridge was asked for its environment %d times, when it was kept", n)
	}
}

// An invocation that arrives as its environment is forgotten is answered. The
// loop is held in a build while the environments' time is up and they're
// invoked, so it can forget an environment after an invocation was queued for
// it, and before it sees that invocation.
func TestInvocationAsItsEnvironmentIsForgotten(t *testing.T) {
	forgetSoon(t, 300*time.Millisecond)
	release := make(chan struct{})
	h := newHarness(t, &fakeRuntime{
		handle: echo,
		// long enough for a worker started under load to ask for its
		// invocation before it exits on idle
		idle:   100 * time.Millisecond,
		builds: map[string]chan struct{}{"Slow": release},
		held:   make(chan string, 1),
	})
	h.addFunction("Fn")
	h.addFunction("Slow")
	bridges := make([]*fakeBridge, 10)
	for i := range bridges {
		bridges[i] = h.bridge("Fn")
		if _, err := bridges[i].invoke("first"); err != nil {
			t.Fatal(err)
		}
	}
	// the workers exit on idle, and then the loop builds Slow until it's
	// released
	time.Sleep(300 * time.Millisecond)
	h.bridge("Slow")
	<-h.runtime.held
	time.Sleep(500 * time.Millisecond)
	errs := make(chan error, len(bridges))
	for _, b := range bridges {
		go func() {
			got, err := b.invoke("second")
			if err == nil && got != "echo second" {
				err = fmt.Errorf("got %q, want %q", got, "echo second")
			}
			errs <- err
		}()
	}
	time.Sleep(200 * time.Millisecond)
	close(release)
	for range bridges {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
}

// A worker that isn't started again after a rebuild, as only the one invoked
// last is, has its environment forgotten as well.
func TestEnvironmentNotStartedAfterARebuildIsForgotten(t *testing.T) {
	forgetSoon(t, 500*time.Millisecond)
	h := newHarness(t, &fakeRuntime{rebuild: true, handle: echo})
	h.addFunction("Fn")
	idle, last := h.bridge("Fn"), h.bridge("Fn")
	for _, b := range []*fakeBridge{idle, last} {
		if _, err := b.invoke("x"); err != nil {
			t.Fatal(err)
		}
	}
	reboots := idle.reboots.Load()
	bus.Publish(&watcher.FileChangedEvent{Path: "src/handler.ts"})
	time.Sleep(1500 * time.Millisecond)

	got, err := idle.invoke("y")
	if err != nil {
		t.Fatal(err)
	}
	if got != "echo y" {
		t.Fatalf("got %q, want %q", got, "echo y")
	}
	if n := idle.reboots.Load() - reboots; n != 1 {
		t.Fatalf("the bridge was asked for its environment %d times, want once, as it was forgotten", n)
	}
}

// The environment of a worker that failed to start is forgotten as well.
func TestEnvironmentOfAWorkerThatFailedToStartIsForgotten(t *testing.T) {
	forgetSoon(t, 500*time.Millisecond)
	h := newHarness(t, &fakeRuntime{handle: echo})
	h.runtime.failRuns.Store(true)
	h.addFunction("Fn")
	b := h.bridge("Fn")
	if _, err := b.invoke("x"); err == nil || !strings.Contains(err.Error(), "function failed to start") {
		t.Fatalf("invoke() = %v, want the init error", err)
	}
	h.runtime.failRuns.Store(false)
	reboots := b.reboots.Load()
	time.Sleep(1500 * time.Millisecond)

	got, err := b.invoke("y")
	if err != nil {
		t.Fatal(err)
	}
	if got != "echo y" {
		t.Fatalf("got %q, want %q", got, "echo y")
	}
	if n := b.reboots.Load() - reboots; n != 1 {
		t.Fatalf("the bridge was asked for its environment %d times, want once, as it was forgotten", n)
	}
}
