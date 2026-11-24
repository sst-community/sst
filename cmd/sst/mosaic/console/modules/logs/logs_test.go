package logs

import (
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/sst/sst/v3/cmd/sst/mosaic/aws"
	"github.com/sst/sst/v3/cmd/sst/mosaic/cloudflare"
	"github.com/sst/sst/v3/cmd/sst/mosaic/console"
)

var t0 = time.UnixMilli(1_700_000_000_000)

func at(ms int) time.Time { return t0.Add(time.Duration(ms) * time.Millisecond) }

func harness(t *testing.T) *console.Harness {
	t.Helper()
	h, err := console.NewHarness(Module{})
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func invocations(t *testing.T, msgs []console.Message) map[string]Invocation {
	t.Helper()
	out := map[string]Invocation{}
	for _, m := range msgs {
		if m.Module == "logs" && m.Type == "invocation" {
			var inv Invocation
			if err := console.Decode(m, &inv); err != nil {
				t.Fatal(err)
			}
			out[inv.Key] = inv
		}
	}
	return out
}

func invoke(h *console.Harness, fn, worker, request string, ms int) {
	h.Publish(&aws.FunctionInvokedEvent{FunctionID: fn, WorkerID: worker, RequestID: request}, at(ms))
}

// An invocation's lines and end are grouped under it, with what a page that
// connects after gets of it.
func TestGroupsByInvocation(t *testing.T) {
	h := harness(t)
	h.Watch("logs")
	invoke(h, "Api", "w1", "r1", 0)
	invoke(h, "Api", "w2", "r2", 1)
	h.Publish(&aws.FunctionLogEvent{FunctionID: "Api", WorkerID: "w1", RequestID: "r1", Line: "one\n"}, at(5))
	h.Publish(&aws.FunctionLogEvent{FunctionID: "Api", WorkerID: "w2", RequestID: "r2", Line: "two"}, at(6))
	h.Publish(&aws.FunctionResponseEvent{FunctionID: "Api", WorkerID: "w1", RequestID: "r1", Output: []byte("{}")}, at(40))
	h.Publish(&aws.FunctionErrorEvent{FunctionID: "Api", WorkerID: "w2", RequestID: "r2", ErrorType: "TypeError", ErrorMessage: "boom", Trace: []string{"at x"}}, at(50))

	live := h.Messages()
	types := []string{}
	for _, m := range live {
		types = append(types, m.Type)
	}
	if strings.Join(types, " ") != "invocation invocation line line end end" {
		t.Fatalf("live messages %v", types)
	}

	got := invocations(t, h.Watch("logs"))
	r1, r2 := got["r1"], got["r2"]
	if r1.Status != "ok" || r1.Start != t0.UnixMilli() || r1.End != at(40).UnixMilli() || len(r1.Lines) != 1 || r1.Lines[0].Text != "one" {
		t.Fatalf("r1 %+v", r1)
	}
	if r2.Status != "error" || r2.Error == nil || r2.Error.Type != "TypeError" || r2.Error.Message != "boom" || len(r2.Error.Trace) != 1 {
		t.Fatalf("r2 %+v", r2)
	}
	if !r1.Cold || !r2.Cold {
		t.Fatalf("a worker's first invocation is cold: %v %v", r1.Cold, r2.Cold)
	}
}

func TestColdOnlyAfterAStartOrABuild(t *testing.T) {
	h := harness(t)
	invoke(h, "Api", "w1", "r1", 0)
	invoke(h, "Api", "w1", "r2", 10)
	h.Publish(&aws.FunctionBuildEvent{FunctionID: "Api"}, at(20))
	invoke(h, "Api", "w1", "r3", 30)
	h.Publish(&aws.FunctionWorkerForgottenEvent{FunctionID: "Api", WorkerID: "w1"}, at(40))
	invoke(h, "Api", "w1", "r4", 50)
	got := invocations(t, h.Watch("logs"))
	for request, want := range map[string]bool{"r1": true, "r2": false, "r3": true, "r4": true} {
		if got[request].Cold != want {
			t.Errorf("%s cold %v, want %v", request, got[request].Cold, want)
		}
	}
}

// What a worker prints outside of an invocation, or an error it fails with as
// it starts, isn't lost.
func TestOutsideAnInvocation(t *testing.T) {
	h := harness(t)
	h.Publish(&aws.FunctionLogEvent{FunctionID: "Api", WorkerID: "w1", Line: "starting"}, at(0))
	h.Publish(&aws.FunctionErrorEvent{FunctionID: "Api", WorkerID: "w1", ErrorMessage: "Cannot find module"}, at(5))
	got := invocations(t, h.Watch("logs"))
	inv, ok := got["w:w1"]
	if !ok || len(inv.Lines) != 1 || inv.Lines[0].Text != "starting" || inv.Status != "error" || inv.Error.Message != "Cannot find module" {
		t.Fatalf("got %+v", got)
	}
}

func TestInitErrorGoesToTheWorkersInvocation(t *testing.T) {
	h := harness(t)
	invoke(h, "Api", "w1", "r1", 0)
	h.Publish(&aws.FunctionErrorEvent{FunctionID: "Api", WorkerID: "w1", ErrorMessage: "crashed"}, at(5))
	got := invocations(t, h.Watch("logs"))
	if got["r1"].Status != "error" || got["r1"].Error.Message != "crashed" || len(got) != 1 {
		t.Fatalf("got %+v", got)
	}
}

func TestTasksAndWorkers(t *testing.T) {
	h := harness(t)
	h.Publish(&aws.TaskStartEvent{TaskID: "Job", WorkerID: "t1", Command: "node job.js"}, at(0))
	h.Publish(&aws.TaskLogEvent{TaskID: "Job", WorkerID: "t1", Line: "working"}, at(5))
	h.Publish(&aws.TaskCompleteEvent{TaskID: "Job", WorkerID: "t1"}, at(90))
	tail := &cloudflare.TailEvent{EventTimestamp: at(100).UnixMilli(), Outcome: "exception", Exceptions: []any{map[string]any{"message": "bad"}}}
	tail.Event.Request.Method = "GET"
	tail.Event.Request.URL = "https://x.dev/a"
	tail.Logs = append(tail.Logs, struct {
		Level     string        `json:"level"`
		Message   []interface{} `json:"message"`
		Timestamp int64         `json:"timestamp"`
	}{Level: "error", Message: []any{"oops", map[string]any{"n": 1}}})
	h.Publish(&cloudflare.WorkerInvokedEvent{WorkerID: "Edge", TailEvent: tail}, at(110))
	got := invocations(t, h.Watch("logs"))
	var task, worker Invocation
	for _, inv := range got {
		switch inv.Kind {
		case KindTask:
			task = inv
		case KindWorker:
			worker = inv
		}
	}
	if task.Function != "Job" || task.Title != "node job.js" || task.Status != "ok" || len(task.Lines) != 1 {
		t.Fatalf("task %+v", task)
	}
	if worker.Title != "GET https://x.dev/a" || worker.Status != "error" || len(worker.Lines) != 1 || worker.Lines[0].Text != `ERROR oops {"n":1}` {
		t.Fatalf("worker %+v", worker)
	}
}

// The store stays under its limits, and says what it dropped.
func TestBounded(t *testing.T) {
	h := harness(t)
	h.Watch("logs")
	for i := 0; i < perFunction+10; i++ {
		invoke(h, "Api", "w1", "r"+strconv.Itoa(i), i)
	}
	evicted := 0
	for _, m := range h.Messages() {
		if m.Type == "evicted" {
			var e struct{ Keys []string }
			console.Decode(m, &e)
			evicted += len(e.Keys)
		}
	}
	if evicted != 10 {
		t.Fatalf("evicted %d, want 10", evicted)
	}
	if n := len(invocations(t, h.Watch("logs"))); n != perFunction {
		t.Fatalf("kept %d, want %d", n, perFunction)
	}

	// an invocation keeps maxLines lines, and counts the rest
	invoke(h, "Other", "w2", "big", 0)
	long := strings.Repeat("x", maxLineSize+100)
	for i := 0; i < maxLines+5; i++ {
		h.Publish(&aws.FunctionLogEvent{FunctionID: "Other", WorkerID: "w2", RequestID: "big", Line: long}, at(i))
	}
	big := invocations(t, h.Watch("logs"))["big"]
	if len(big.Lines) != maxLines || big.Dropped != 5 {
		t.Fatalf("kept %d lines, dropped %d", len(big.Lines), big.Dropped)
	}
	if n := len(big.Lines[0].Text); n > maxLineSize {
		t.Fatalf("a line of %d bytes was kept whole", n)
	}
}

func TestBoundedInBytes(t *testing.T) {
	h := harness(t)
	line := strings.Repeat("y", maxLineSize)
	// each function has fewer than perFunction, but together they're past
	// totalBytes
	for f := 0; f < 40; f++ {
		fn := "F" + strconv.Itoa(f)
		for i := 0; i < 40; i++ {
			req := fn + "-" + strconv.Itoa(i)
			invoke(h, fn, "w"+strconv.Itoa(f), req, i)
			h.Publish(&aws.FunctionLogEvent{FunctionID: fn, WorkerID: "w" + strconv.Itoa(f), RequestID: req, Line: line}, at(i))
		}
	}
	size := 0
	for _, inv := range invocations(t, h.Watch("logs")) {
		for _, l := range inv.Lines {
			size += len(l.Text) + 16
		}
	}
	if size > totalBytes {
		t.Fatalf("kept %d bytes of lines, over %d", size, totalBytes)
	}
	if size < totalBytes/2 {
		t.Fatalf("kept only %d bytes", size)
	}
}

func TestBuilds(t *testing.T) {
	h := harness(t)
	h.Publish(&aws.FunctionBuildEvent{FunctionID: "Api", Errors: []string{"syntax error"}}, at(0))
	var b Build
	for _, m := range h.Watch("logs") {
		if m.Type == "build" {
			console.Decode(m, &b)
		}
	}
	if b.Function != "Api" || b.OK || len(b.Errors) != 1 {
		t.Fatalf("build %+v", b)
	}
}
