package stats

import (
	"testing"
	"time"

	"github.com/sst/sst/v3/cmd/sst/mosaic/aws"
	"github.com/sst/sst/v3/cmd/sst/mosaic/console"
)

func functions(t *testing.T, msgs []console.Message) map[string]Function {
	out := map[string]Function{}
	for _, m := range msgs {
		if m.Type == "functions" {
			var d struct{ Functions []Function }
			if err := console.Decode(m, &d); err != nil {
				t.Fatal(err)
			}
			for _, f := range d.Functions {
				out[f.ID] = f
			}
		}
	}
	return out
}

func TestStats(t *testing.T) {
	h, err := console.NewHarness(Module{})
	if err != nil {
		t.Fatal(err)
	}
	t0 := time.Now()
	// 100 invocations taking 1ms to 100ms, on two workers
	for i := 1; i <= 100; i++ {
		req := "r" + time.Duration(i).String()
		worker := "w1"
		if i%2 == 0 {
			worker = "w2"
		}
		h.Publish(&aws.FunctionInvokedEvent{FunctionID: "Api", WorkerID: worker, RequestID: req}, t0)
		if i%10 == 0 {
			h.Publish(&aws.FunctionErrorEvent{FunctionID: "Api", WorkerID: worker, RequestID: req}, t0.Add(time.Duration(i)*time.Millisecond))
		} else {
			h.Publish(&aws.FunctionResponseEvent{FunctionID: "Api", WorkerID: worker, RequestID: req}, t0.Add(time.Duration(i)*time.Millisecond))
		}
	}
	h.Publish(&aws.FunctionInvokedEvent{FunctionID: "Api", WorkerID: "w1", RequestID: "running"}, t0)
	h.Publish(&aws.FunctionBuildEvent{FunctionID: "Api"}, t0)
	h.Publish(&aws.FunctionBuildEvent{FunctionID: "Api", Errors: []string{"x"}}, t0)
	h.Publish(&aws.FunctionInvokedEvent{FunctionID: "Api", WorkerID: "w1", RequestID: "after-build"}, t0)
	h.Publish(&aws.FunctionErrorEvent{FunctionID: "Api", WorkerID: "w9", ErrorMessage: "Cannot find module"}, t0)

	f := functions(t, h.Watch("stats"))["Api"]
	if f.Invocations != 102 || f.Errors != 10 || f.InitErrors != 1 || f.Running != 2 || f.Cold != 3 || f.Builds != 2 || f.BuildErrors != 1 {
		t.Fatalf("%+v", f)
	}
	if f.P50 != 50 || f.P95 != 95 || f.P99 != 99 || f.Max != 100 {
		t.Fatalf("percentiles %v %v %v %v", f.P50, f.P95, f.P99, f.Max)
	}
}

func TestOnlySentWhenWatchedAndChanged(t *testing.T) {
	h, _ := console.NewHarness(Module{})
	now := time.Now()
	h.Publish(&aws.FunctionInvokedEvent{FunctionID: "Api", WorkerID: "w", RequestID: "r"}, now)
	h.Tick(now)
	h.Watch("stats")
	h.Tick(now)
	if n := count(h.Messages()); n != 1 {
		t.Fatalf("got %d messages", n)
	}
	h.Tick(now)
	if n := count(h.Messages()); n != 0 {
		t.Fatalf("nothing changed, but got %d messages", n)
	}
}

func count(msgs []console.Message) int {
	n := 0
	for _, m := range msgs {
		if m.Module == "stats" {
			n++
		}
	}
	return n
}

func TestLostInvocationsStopRunning(t *testing.T) {
	h, _ := console.NewHarness(Module{})
	now := time.Now()
	h.Publish(&aws.FunctionInvokedEvent{FunctionID: "Api", WorkerID: "w", RequestID: "r"}, now)
	h.Tick(now.Add(lost + time.Second))
	if f := functions(t, h.Watch("stats"))["Api"]; f.Running != 0 {
		t.Fatalf("%+v", f)
	}
}

func TestPercentile(t *testing.T) {
	if percentile(nil, 0.5) != 0 || percentile([]float64{7}, 0.99) != 7 || percentile([]float64{1, 2, 3, 4}, 0.5) != 2 {
		t.Fatal("percentile")
	}
}

// Functions with the same count keep their order.
func TestOrder(t *testing.T) {
	h, _ := console.NewHarness(Module{})
	for _, id := range []string{"c", "a", "b", "d", "e"} {
		h.Publish(&aws.FunctionBuildEvent{FunctionID: id}, time.Now())
	}
	for i := 0; i < 10; i++ {
		var d struct{ Functions []Function }
		for _, m := range h.Watch("stats") {
			if m.Type == "functions" {
				console.Decode(m, &d)
			}
		}
		ids := ""
		for _, f := range d.Functions {
			ids += f.ID
		}
		if ids != "abcde" {
			t.Fatalf("order %q", ids)
		}
	}
}
