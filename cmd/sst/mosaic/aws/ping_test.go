package aws

import (
	"testing"
	"time"
)

// A worker gets an invocation without waiting for the bridge's ping to be
// published. Publishing it is a round trip to AppSync, about 100 ms, that
// every invocation waited on before its handler could start.
func TestWorkerDoesNotWaitForThePing(t *testing.T) {
	handed := make(chan time.Time, 10)
	h := newHarness(t, &fakeRuntime{handle: func(event string) string {
		handed <- time.Now()
		return echo(event)
	}})
	h.addFunction("fn")
	b := h.bridge("fn")
	if _, err := b.invoke("warm"); err != nil {
		t.Fatal(err)
	}
	<-handed

	// long against the handler, so a slow machine doesn't fail the test
	const publish = 2 * time.Second
	h.appsync.pingDelay.Store(int64(publish))
	start := time.Now()
	reply, err := b.invoke("event")
	if err != nil {
		t.Fatal(err)
	}
	if reply != echo("event") {
		t.Errorf("got %q, want %q", reply, echo("event"))
	}
	if waited := (<-handed).Sub(start); waited > publish/2 {
		t.Errorf("the worker got the invocation %v after the bridge sent it, behind a ping that took %v to publish", waited.Round(time.Millisecond), publish)
	}
}

// A ping carries the ID of the bridge's message with the invocation, so a
// bridge can tell it from a late ping for the one before. A bridge only waits past its ping timeout, for a
// handler that takes longer, once it has a ping it can tell is its own.
func TestPingNamesItsInvocation(t *testing.T) {
	h := newHarness(t, &fakeRuntime{handle: func(event string) string {
		time.Sleep(100 * time.Millisecond)
		return echo(event)
	}})
	h.addFunction("fn")
	b := h.bridge("fn")
	for i := range 3 {
		if _, err := b.invoke("event"); err != nil {
			t.Fatalf("invocation %d: %v", i, err)
		}
		select {
		case <-b.pinged:
		default:
			t.Errorf("invocation %d was answered without a ping the bridge could tell was for it", i)
		}
	}
}
