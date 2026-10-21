package ui

import (
	"context"
	"fmt"
	"testing"

	"github.com/sst/sst/v3/cmd/sst/mosaic/aws"
)

// What the UI keeps for a worker is dropped once sst dev forgets its
// environment, and the workers still running keep colors of their own.
func TestForgottenWorker(t *testing.T) {
	u := New(context.Background(), WithSilent)
	u.Event(&aws.FunctionInvokedEvent{FunctionID: "Fn", WorkerID: "a"})
	u.Event(&aws.FunctionInvokedEvent{FunctionID: "Fn", WorkerID: "b"})
	if len(u.workerTime) != 2 || len(u.colors) != 2 {
		t.Fatalf("kept %d times and %d colors, want 2 of each", len(u.workerTime), len(u.colors))
	}

	u.Event(&aws.FunctionWorkerForgottenEvent{FunctionID: "Fn", WorkerID: "a"})
	if _, ok := u.workerTime["a"]; ok {
		t.Error("a's time is still kept")
	}
	if _, ok := u.colors["a"]; ok {
		t.Error("a's color is still kept")
	}

	u.Event(&aws.FunctionInvokedEvent{FunctionID: "Fn", WorkerID: "c"})
	if u.colors["c"].GetForeground() == u.colors["b"].GetForeground() {
		t.Error("c has b's color, and both are running")
	}
}

// A long-lived worker keeps a color of its own while others come and go.
func TestLongLivedWorkerColor(t *testing.T) {
	u := New(context.Background(), WithSilent)
	u.Event(&aws.FunctionInvokedEvent{FunctionID: "Fn", WorkerID: "long"})
	long := u.colors["long"].GetForeground()
	for i := range 3 * len(Colors) {
		id := fmt.Sprintf("short-%d", i)
		u.Event(&aws.FunctionInvokedEvent{FunctionID: "Fn", WorkerID: id})
		if u.colors[id].GetForeground() == long {
			t.Fatalf("%s has the long-lived worker's color", id)
		}
		u.Event(&aws.FunctionWorkerForgottenEvent{FunctionID: "Fn", WorkerID: id})
	}
}

// A task's worker isn't kept once the task is done, though the pane's filter
// came to hide the task while it ran.
func TestDoneTaskWorker(t *testing.T) {
	u := New(context.Background(), WithSilent)
	u.Event(&aws.TaskStartEvent{TaskID: "Task", WorkerID: "a"})
	u.Event(&aws.TaskCompleteEvent{TaskID: "Task", WorkerID: "a"})
	u.Event(&aws.TaskStartEvent{TaskID: "Task", WorkerID: "b"})
	u.SetFilter("Other", "task")
	u.Event(&aws.TaskCompleteEvent{TaskID: "Task", WorkerID: "b"})
	if len(u.workerTime) != 0 || len(u.colors) != 0 {
		t.Fatalf("kept %d times and %d colors, want none", len(u.workerTime), len(u.colors))
	}
}
