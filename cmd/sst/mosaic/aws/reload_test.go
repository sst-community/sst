package aws

import (
	"sync"
	"testing"
	"time"

	"github.com/sst/sst/v3/cmd/sst/mosaic/watcher"
	"github.com/sst/sst/v3/pkg/bus"
)

// Saving a file rebuilds the functions that use it, and stops their workers,
// one that's running an invocation included. The invocation is never answered,
// and its bridge, which has had the ping, waits until Lambda times it out.
func TestReloadDoesNotDropARunningInvocation(t *testing.T) {
	running := make(chan struct{}, 1)
	release := make(chan struct{})
	h := newHarness(t, &fakeRuntime{rebuild: true, handle: func(event string) string {
		if event == "slow" {
			running <- struct{}{}
			<-release
		}
		return "echo " + event
	}})
	h.addFunction("Fn")
	b := h.bridge("Fn")
	if _, err := b.invoke("warm"); err != nil {
		t.Fatal(err)
	}

	reply := make(chan error, 1)
	go func() {
		_, err := b.invoke("slow")
		reply <- err
	}()
	<-running
	bus.Publish(&watcher.FileChangedEvent{Path: "src/handler.ts"})
	time.Sleep(200 * time.Millisecond)
	close(release)

	if err := <-reply; err == errNoReply {
		t.Fatal("the invocation running when the function was rebuilt was never answered")
	}
}

// A rebuild starts a new worker at once only for the environment of the function
// that was invoked last, the one likely to be invoked next. Starting one for
// every environment, the idle ones too, started as many processes as there are
// environments on each save, about 60 MB each for Node.js. The others start when
// they're invoked, and answer as before.
func TestReloadStartsWorkersOnlyForWhatIsInvoked(t *testing.T) {
	h := newHarness(t, &fakeRuntime{rebuild: true, handle: echo})
	h.addFunction("Fn")
	bridges := make([]*fakeBridge, 20)
	var wg sync.WaitGroup
	for i := range bridges {
		bridges[i] = h.bridge("Fn")
		wg.Add(1)
		go func(b *fakeBridge) {
			defer wg.Done()
			if _, err := b.invoke("warm"); err != nil {
				t.Error(err)
			}
		}(bridges[i])
	}
	wg.Wait()
	if _, err := bridges[0].invoke("last"); err != nil {
		t.Fatal(err)
	}
	before := h.runtime.starts.Load()
	// a bridge can be asked as it starts, when its invocation comes before it
	// said it's there
	reboots := make([]int32, len(bridges))
	for i, b := range bridges {
		reboots[i] = b.reboots.Load()
	}

	bus.Publish(&watcher.FileChangedEvent{Path: "src/handler.ts"})
	time.Sleep(500 * time.Millisecond)
	if started := h.runtime.starts.Load() - before; started != 1 {
		t.Fatalf("one save started %d workers for %d environments, want 1, for the one invoked last", started, len(bridges))
	}
	if _, err := bridges[0].invoke("after"); err != nil {
		t.Fatal(err)
	}
	if started := h.runtime.starts.Load() - before; started != 1 {
		t.Fatalf("invoking the environment invoked last started %d workers since the save, want its worker started then", started)
	}
	for i, b := range bridges[1:] {
		got, err := b.invoke("later")
		if err != nil {
			t.Fatalf("environment %d: %v", i+1, err)
		}
		if got != "echo later" {
			t.Fatalf("environment %d: got %q, want %q", i+1, got, "echo later")
		}
	}
	if started := h.runtime.starts.Load() - before; started != int32(len(bridges)) {
		t.Fatalf("started %d workers for %d environments invoked after a save, want one each", started, len(bridges))
	}
	for i, b := range bridges {
		if n := b.reboots.Load() - reboots[i]; n > 0 {
			t.Fatalf("environment %d was asked to say it's there again %d times after the save, when sst dev knew it", i, n)
		}
	}
}

// A worker that ran an invocation through a rebuild is replaced once it's done,
// so the next invocation runs the new build. It's replaced once, not again at its
// invocation's deadline.
func TestReloadReplacesAWorkerOnceItsDone(t *testing.T) {
	running := make(chan struct{}, 1)
	release := make(chan struct{})
	h := newHarness(t, &fakeRuntime{rebuild: true, handle: func(event string) string {
		if event == "slow" {
			running <- struct{}{}
			<-release
		}
		return "echo " + event
	}})
	h.addFunction("Fn")
	b := h.bridge("Fn")
	b.deadline = time.Second
	if _, err := b.invoke("warm"); err != nil {
		t.Fatal(err)
	}
	reply := make(chan error, 1)
	go func() {
		_, err := b.invoke("slow")
		reply <- err
	}()
	<-running
	before := h.runtime.starts.Load()
	bus.Publish(&watcher.FileChangedEvent{Path: "src/handler.ts"})
	time.Sleep(200 * time.Millisecond)
	if started := h.runtime.starts.Load() - before; started != 0 {
		t.Fatalf("started %d workers while the worker ran its invocation, want it left to finish", started)
	}
	close(release)
	if err := <-reply; err != nil {
		t.Fatal(err)
	}

	if got, err := b.invoke("next"); err != nil || got != "echo next" {
		t.Fatalf("got %q, %v, want %q", got, err, "echo next")
	}
	if started := h.runtime.starts.Load() - before; started != 1 {
		t.Fatalf("started %d workers after the invocation was done, want 1 with the new build", started)
	}
	time.Sleep(time.Second)
	if started := h.runtime.starts.Load() - before; started != 1 {
		t.Fatalf("started %d workers by the invocation's deadline, want it replaced once", started)
	}
}

// A worker that runs an invocation past its deadline through a rebuild is
// replaced then. Lambda has given up on the invocation, and the environment's
// next one would wait for it.
func TestReloadReplacesAWorkerAtItsDeadline(t *testing.T) {
	running := make(chan struct{}, 1)
	h := newHarness(t, &fakeRuntime{rebuild: true, handle: func(event string) string {
		if event == "hang" {
			running <- struct{}{}
			<-t.Context().Done()
		}
		return "echo " + event
	}})
	h.addFunction("Fn")
	b := h.bridge("Fn")
	b.deadline = time.Second
	if _, err := b.invoke("warm"); err != nil {
		t.Fatal(err)
	}
	// the invocation that hangs times out in Lambda, which then hands the
	// environment its next one. A bridge runs one invocation at a time.
	h.invokeTimeout = time.Second
	hung := make(chan error, 1)
	go func() {
		_, err := b.invoke("hang")
		hung <- err
	}()
	<-running
	bus.Publish(&watcher.FileChangedEvent{Path: "src/handler.ts"})
	if err := <-hung; err != errNoReply {
		t.Fatalf("the invocation that hangs ended with %v, want %v", err, errNoReply)
	}
	h.invokeTimeout = 5 * time.Second

	if got, err := b.invoke("next"); err != nil || got != "echo next" {
		t.Fatalf("got %q, %v, want %q", got, err, "echo next")
	}
}

// Workers that ran invocations through a rebuild are replaced as the others:
// once they're done, a new worker starts at once only for the environment
// invoked last, and the others when they're invoked.
func TestReloadReplacesBusyWorkersOnlyForWhatIsInvoked(t *testing.T) {
	running := make(chan struct{}, 10)
	release := make(chan struct{})
	h := newHarness(t, &fakeRuntime{rebuild: true, handle: func(event string) string {
		if event == "slow" {
			running <- struct{}{}
			<-release
		}
		return "echo " + event
	}})
	h.addFunction("Fn")
	bridges := make([]*fakeBridge, 5)
	for i := range bridges {
		bridges[i] = h.bridge("Fn")
		if _, err := bridges[i].invoke("warm"); err != nil {
			t.Fatal(err)
		}
	}
	replies := make(chan error, len(bridges))
	for _, b := range bridges {
		go func() {
			_, err := b.invoke("slow")
			replies <- err
		}()
		<-running
	}
	before := h.runtime.starts.Load()
	bus.Publish(&watcher.FileChangedEvent{Path: "src/handler.ts"})
	time.Sleep(200 * time.Millisecond)
	close(release)
	for range bridges {
		if err := <-replies; err != nil {
			t.Fatal(err)
		}
	}
	time.Sleep(200 * time.Millisecond)
	if started := h.runtime.starts.Load() - before; started != 1 {
		t.Fatalf("%d workers that ran invocations through a save were replaced with %d started at once, want 1", len(bridges), started)
	}
	for i, b := range bridges {
		if got, err := b.invoke("next"); err != nil || got != "echo next" {
			t.Fatalf("environment %d: got %q, %v, want %q", i, got, err, "echo next")
		}
	}
	if started := h.runtime.starts.Load() - before; started != int32(len(bridges)) {
		t.Fatalf("started %d workers for %d environments invoked after a save, want one each", started, len(bridges))
	}
}

// A worker stopped by a rebuild takes a moment to exit, and goes on asking for
// an invocation meanwhile, beside the worker that replaces it. An invocation
// isn't handed to it, as it would never answer.
func TestReloadDoesNotHandAnInvocationToAStoppedWorker(t *testing.T) {
	h := newHarness(t, &fakeRuntime{rebuild: true, handle: echo, stopDelay: time.Second})
	h.addFunction("Fn")
	b := h.bridge("Fn")
	if _, err := b.invoke("warm"); err != nil {
		t.Fatal(err)
	}
	before := h.runtime.starts.Load()
	bus.Publish(&watcher.FileChangedEvent{Path: "src/handler.ts"})
	for deadline := time.Now().Add(5 * time.Second); h.runtime.starts.Load() == before; time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the worker wasn't started again after the rebuild")
		}
	}

	// the stopped worker still asks, and asked first
	if got, err := b.invoke("next"); err != nil || got != "echo next" {
		t.Fatalf("got %q, %v, want %q", got, err, "echo next")
	}
}

// One whose invocation came without a deadline is replaced after the longest an
// invocation can run.
func TestReloadReplacesAWorkerWithoutADeadline(t *testing.T) {
	old := longestInvocation
	longestInvocation = time.Second
	t.Cleanup(func() { longestInvocation = old })
	running := make(chan struct{}, 1)
	h := newHarness(t, &fakeRuntime{rebuild: true, handle: func(event string) string {
		if event == "hang" {
			running <- struct{}{}
			<-t.Context().Done()
		}
		return "echo " + event
	}})
	h.addFunction("Fn")
	b := h.bridge("Fn")
	if _, err := b.invoke("warm"); err != nil {
		t.Fatal(err)
	}
	h.invokeTimeout = time.Second
	hung := make(chan error, 1)
	go func() {
		_, err := b.invoke("hang")
		hung <- err
	}()
	<-running
	bus.Publish(&watcher.FileChangedEvent{Path: "src/handler.ts"})
	if err := <-hung; err != errNoReply {
		t.Fatalf("the invocation that hangs ended with %v, want %v", err, errNoReply)
	}
	h.invokeTimeout = 5 * time.Second

	if got, err := b.invoke("next"); err != nil || got != "echo next" {
		t.Fatalf("got %q, %v, want %q", got, err, "echo next")
	}
}
