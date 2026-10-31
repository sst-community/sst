package local

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestPublishRejectsFullBatchWithoutPartialDelivery(t *testing.T) {
	s, _ := NewServer(strings.Repeat("x", 32))
	slow, fast := make(chan string, 2), make(chan string, 3)
	slow <- "occupied"
	s.subscribers["/sst/test"] = map[chan string]struct{}{slow: {}, fast: {}}
	publish := func() int {
		r := httptest.NewRequest("POST", "/publish?channel=/sst/test", strings.NewReader(`["ping","init"]`))
		r.Header.Set("Authorization", "Bearer "+strings.Repeat("x", 32))
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w.Code
	}
	if code := publish(); code != 503 {
		t.Fatalf("got %d, want retryable failure", code)
	}
	if len(fast) != 0 || len(slow) != 1 {
		t.Fatal("partially delivered rejected batch")
	}
	<-slow
	if code := publish(); code != 204 {
		t.Fatal(code)
	}
	for _, ch := range []chan string{slow, fast} {
		if <-ch != `"ping"` || <-ch != `"init"` {
			t.Fatal("lost or reordered control messages")
		}
	}
}

func TestPublishRetriesBackpressure(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.WriteHeader(503)
			return
		}
		w.WriteHeader(204)
	}))
	defer srv.Close()
	c, _ := Dial(srv.URL, strings.Repeat("x", 32))
	if err := c.Publish(context.Background(), "/sst/test", "ping"); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 {
		t.Fatal(calls.Load())
	}
}

func TestPublishBackpressureHonorsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503); cancel() }))
	defer srv.Close()
	c, _ := Dial(srv.URL, strings.Repeat("x", 32))
	if err := c.Publish(ctx, "/sst/test", "ping"); err == nil {
		t.Fatal("accepted rejected publish")
	}
}
