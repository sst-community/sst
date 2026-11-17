package aws

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/bridge"
)

// The lambda runtime-API handlers read worker state from request goroutines
// while the event loop writes it. Driving both sides concurrently surfaces
// the conflict under `go test -race`; the same interleaving without the race
// detector crashes the dev server with a concurrent map fatal (#6567).
//
// MessageInit for an unknown function id exercises the event loop's map
// write and returns before any bridge or project access, so the test needs
// no infrastructure.
func TestFunctionConcurrentInitAndNext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	srv := newServer(t, ctx)
	msg := make(chan bridge.Message)
	go function(ctx, input{server: srv, msg: msg, startAtOnce: startAtOnce})

	send := func(worker int) {
		m := bridge.Message{
			Type:   bridge.MessageInit,
			Source: fmt.Sprintf("worker-%d", worker),
			Body:   strings.NewReader(`{"functionID":"does-not-exist"}`),
		}
		select {
		case msg <- m:
		case <-time.After(5 * time.Second):
			t.Error("event loop stopped accepting messages")
		}
	}

	// The first accepted message proves the handlers are registered: the
	// unbuffered channel is only read once function's event loop is running,
	// which happens after registration.
	send(0)

	requests, stopRequests := context.WithCancel(context.Background())
	var handlers sync.WaitGroup
	for i := 0; i < 64; i++ {
		handlers.Add(1)
		go func(worker int) {
			defer handlers.Done()
			r := httptest.NewRequest(
				http.MethodGet,
				workerPath(srv, fmt.Sprintf("worker-%d", worker%8), "/2018-06-01/runtime/invocation/next"),
				nil,
			).WithContext(requests)
			srv.ServeHTTP(httptest.NewRecorder(), r)
		}(i)
	}

	for i := 1; i < 512; i++ {
		send(i % 8)
	}

	stopRequests()
	handlers.Wait()
}

// A reply is sent again the given number of times, and no more once the dev
// server stops.
func TestResend(t *testing.T) {
	sent := 0
	resend(context.Background(), 5, time.Millisecond, func() {
		sent++
	})
	if sent != 5 {
		t.Fatalf("sent %d times, want 5", sent)
	}

	sent = 0
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	resend(ctx, 5, time.Hour, func() {
		sent++
	})
	if sent != 0 {
		t.Fatalf("sent %d times after the context was done, want 0", sent)
	}
}
