package dev

import (
	"context"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/sst/sst/v3/pkg/bus"
	"github.com/sst/sst/v3/pkg/project"
	"github.com/sst/sst/v3/pkg/server"
)

// The UI asks for sst dev's stream as soon as the server is ready, which can
// be before sst dev's routes are there: the stream waits for them, rather
// than closing at once and ending the CLI with it
func TestStreamWaitsForSSTDev(t *testing.T) {
	s, err := server.New()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	go s.Serve(ctx)
	<-s.Ready
	go func() {
		time.Sleep(300 * time.Millisecond)
		go Register(nil, s).Run(ctx)
	}()

	evts, err := Stream(ctx, s.URL(), project.CompleteEvent{})
	if err != nil {
		t.Fatal(err)
	}
	// published until the stream, once it's subscribed, passes one on
	go func() {
		for ctx.Err() == nil {
			bus.Publish(&project.CompleteEvent{UpdateID: "first"})
			time.Sleep(50 * time.Millisecond)
		}
	}()
	select {
	case evt, ok := <-evts:
		if !ok {
			t.Fatal("the stream closed before sst dev was there")
		}
		if got := evt.(*project.CompleteEvent).UpdateID; got != "first" {
			t.Fatalf("got %v", got)
		}
	case <-ctx.Done():
		t.Fatal("no event came")
	}
}

// Register leaves sst dev's routes on the server when it returns, before the
// server serves, so mosaic's first request after Ready finds them
func TestRegisterAddsTheRoutesAtOnce(t *testing.T) {
	s, err := server.New()
	if err != nil {
		t.Fatal(err)
	}
	routes := []struct{ method, path string }{
		{"GET", "/stream"},
		{"POST", "/api/deploy"},
		{"GET", "/api/env"},
		{"GET", "/api/completed"},
	}
	found := func(method, path string) bool {
		_, pattern := s.Mux.Handler(httptest.NewRequest(method, path, nil))
		return pattern != ""
	}
	for _, route := range routes {
		if found(route.method, route.path) {
			t.Fatalf("%s %s is there before Register", route.method, route.path)
		}
	}
	Register(nil, s)
	for _, route := range routes {
		if !found(route.method, route.path) {
			t.Errorf("%s %s isn't there when Register returns", route.method, route.path)
		}
	}
}
