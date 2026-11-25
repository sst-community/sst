package workers

import (
	"context"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/sst/sst/v3/cmd/sst/mosaic/aws"
	"github.com/sst/sst/v3/cmd/sst/mosaic/console"
)

// A worker's tree is its process and what it started.
func TestSampleTree(t *testing.T) {
	cmd := exec.Command("sh", "-c", "sleep 30 & sleep 30 & wait")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill()
	deadline := time.Now().Add(3 * time.Second)
	for {
		trees, cpu, err := sample(context.Background(), map[string]root{
			"w":    {pid: int32(cmd.Process.Pid), started: time.Now()},
			"gone": {pid: 1 << 30, started: time.Now()},
			// this test's own process, which started before the worker said it
			// did: it took a dead worker's PID
			"reused": {pid: int32(os.Getpid()), started: time.Now().Add(-time.Hour)},
		})
		if err != nil {
			t.Fatal(err)
		}
		tr := trees["w"]
		if tr.alive && tr.processes == 3 {
			if tr.rss == 0 || len(cpu) != 3 {
				t.Fatalf("tree %+v, cpu %v", tr, cpu)
			}
			if trees["gone"].alive {
				t.Fatal("a process that isn't there is alive")
			}
			if trees["reused"].alive {
				t.Fatal("a process that took a worker's PID was taken for it")
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("tree %+v", tr)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// It samples only while a page shows it, and says when a worker's gone.
func TestSamplesWhenWatched(t *testing.T) {
	h, err := console.NewHarness(Module{})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	h.Publish(&aws.FunctionWorkerStartedEvent{FunctionID: "Api", WorkerID: "w1", PID: os.Getpid()}, now)
	h.Publish(&aws.FunctionWorkerStartedEvent{FunctionID: "Api", WorkerID: "w2", PID: 1 << 30}, now)
	h.Tick(now.Add(time.Hour))
	if h.Get("/x").Code != 404 {
		t.Fatal("route")
	}
	snap := h.Watch("workers")
	if len(snap) != 5 {
		t.Fatalf("snapshot %+v", snap)
	}
	h.Tick(now.Add(2 * time.Hour))
	// the sample is read off the dispatcher, and handed back to it
	got := map[string]bool{}
	deadline := time.Now().Add(3 * time.Second)
	for !(got["sample"] && got["exited"]) && time.Now().Before(deadline) {
		h.Get("/x")
		for _, m := range h.Messages() {
			got[m.Type] = true
		}
	}
	if !got["sample"] || !got["exited"] {
		t.Fatalf("got %v", got)
	}
}

// A worker sst dev forgot isn't kept, whether a page samples it or not.
func TestForgottenWorkerExits(t *testing.T) {
	h, err := console.NewHarness(Module{})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	h.Publish(&aws.FunctionWorkerStartedEvent{FunctionID: "Api", WorkerID: "w1", PID: os.Getpid()}, now)
	h.Publish(&aws.FunctionWorkerForgottenEvent{FunctionID: "Api", WorkerID: "w1"}, now)
	snap := h.Watch("workers")
	var w Worker
	for _, m := range snap {
		if m.Type == "worker" {
			console.Decode(m, &w)
		}
	}
	if w.Exited == 0 {
		t.Fatalf("%+v", w)
	}
	h.Tick(now.Add(keepExited + time.Second))
	for _, m := range h.Watch("workers") {
		if m.Type == "worker" {
			t.Fatalf("still kept: %+v", m)
		}
	}
}
