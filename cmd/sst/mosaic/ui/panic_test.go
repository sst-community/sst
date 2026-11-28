package ui

import (
	"context"
	"testing"

	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
	"github.com/sst/sst/v3/cmd/sst/mosaic/aws"
	"github.com/sst/sst/v3/pkg/project"
)

// #310: in `sst dev --mode=basic` and `sst deploy` the UI runs in the process
// that deploys, so an event the UI can't print must not crash that process
// and leave the stage locked. A nil event stands in for any bug in printing.
func TestEventThatPanicsIsRecovered(t *testing.T) {
	u := New(context.Background(), WithSilent)
	u.print("half a line")
	u.Event((*aws.FunctionBuildEvent)(nil))
	if len(u.buffer) != 0 {
		t.Errorf("kept %v of the line the panic cut short", u.buffer)
	}
	// the UI keeps handling events after one it couldn't print
	u.Event(&aws.FunctionInvokedEvent{FunctionID: "Fn", WorkerID: "a"})
	if _, ok := u.workerTime["a"]; !ok {
		t.Error("the event after the panic wasn't handled")
	}
}

// #310: the footer handles the same events in a goroutine of its own, where
// a panic would crash the process just the same.
func TestFooterMessageThatPanicsIsRecovered(t *testing.T) {
	f := NewFooter()
	f.handle((*apitype.ResourcePreEvent)(nil), 80)
	f.handle(&project.StackCommandEvent{Command: "deploy"}, 80)
	if !f.started || f.mode != ProgressModeDeploy {
		t.Error("the message after the panic wasn't handled")
	}
}

// #310's panic: a function's event came before its outputs had a handler.
// The function's ID is printed until the handler is known.
func TestFunctionNameWithoutHandler(t *testing.T) {
	u := New(context.Background(), WithSilent)
	if got := u.functionName("Fn"); got != "Fn" {
		t.Errorf("before a deploy completes, got %q, want Fn", got)
	}
	u.complete = &project.CompleteEvent{Functions: map[string]project.FunctionReport{
		"Empty": {},
		"Api":   {Handler: "./src/api.handler"},
	}}
	for id, want := range map[string]string{
		"Missing": "Missing",
		"Empty":   "Empty",
		"Api":     "src/api.handler",
	} {
		if got := u.functionName(id); got != want {
			t.Errorf("functionName(%q) = %q, want %q", id, got, want)
		}
	}
}
