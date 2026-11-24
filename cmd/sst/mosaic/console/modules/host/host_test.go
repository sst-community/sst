package host

import (
	"context"
	"testing"
	"time"

	"github.com/sst/sst/v3/cmd/sst/mosaic/console"
)

func TestSample(t *testing.T) {
	s := &store{cores: 1}
	smp, _ := s.sample(context.Background(), time.Time{}, 0)
	if smp.Machine.MemTotal == 0 || smp.Machine.MemUsed == 0 || smp.Process.Heap == 0 || smp.Process.Goroutines == 0 {
		t.Fatalf("%+v", smp)
	}
}

func TestOnlyWhenWatched(t *testing.T) {
	h, err := console.NewHarness(Module{})
	if err != nil {
		t.Fatal(err)
	}
	h.Tick(time.Now().Add(time.Hour))
	// nobody watches, so nothing was read
	if msgs := h.Watch("host"); len(msgs) != 3 {
		t.Fatalf("snapshot %+v", msgs)
	}
	h.Tick(time.Now().Add(2 * time.Hour))
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		h.Get("/x")
		for _, m := range h.Messages() {
			if m.Type == "sample" {
				return
			}
		}
	}
	t.Fatal("no sample")
}
