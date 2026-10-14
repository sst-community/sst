package resource

import (
	"strings"
	"testing"
	"time"

	"github.com/sst/sst/v3/cmd/sst/mosaic/ui/common"
	"github.com/sst/sst/v3/pkg/bus"
)

// collectOutput runs a command and returns the lines of output it published.
func collectOutput(t *testing.T, command string) []string {
	t.Helper()
	events := bus.Subscribe(&common.StdoutEvent{})
	defer bus.Unsubscribe(events)
	if err, finished := runWithTimeout(t, command); !finished || err != nil {
		t.Fatalf("finished=%v err=%v", finished, err)
	}
	var lines []string
	for {
		select {
		case evt := <-events:
			lines = append(lines, evt.(*common.StdoutEvent).Line)
		default:
			return lines
		}
	}
}

func runWithTimeout(t *testing.T, command string) (error, bool) {
	t.Helper()
	r := NewRun()
	done := make(chan error, 1)
	go func() { done <- r.executeCommand(&RunInputs{Command: command}) }()
	select {
	case err := <-done:
		return err, true
	case <-time.After(10 * time.Second):
		return nil, false
	}
}

func TestRunWithALongLine(t *testing.T) {
	// one line of 200 KB, longer than the 64 KB a bufio.Scanner takes by default, then more output
	err, finished := runWithTimeout(t, `head -c 200000 /dev/zero | tr '\0' a; echo; echo after`)
	if !finished {
		t.Fatal("the command never finished")
	}
	if err != nil {
		t.Fatal(err)
	}
}

func TestRunWithNormalOutput(t *testing.T) {
	err, finished := runWithTimeout(t, `echo `+strings.Repeat("x", 100)+`; echo done`)
	if !finished || err != nil {
		t.Fatalf("finished=%v err=%v", finished, err)
	}
}

func TestRunWithALineOverTheLimit(t *testing.T) {
	// 3 MB on one line is dropped with an error in the log, and the command still ends
	err, finished := runWithTimeout(t, `head -c 3000000 /dev/zero | tr '\0' a; echo; echo after`)
	if !finished {
		t.Fatal("the command never finished")
	}
	if err != nil {
		t.Fatal(err)
	}
}

func TestRunPassesALongLineOn(t *testing.T) {
	lines := collectOutput(t, `head -c 200000 /dev/zero | tr '\0' a; echo; echo after`)
	if len(lines) != 2 || len(lines[0]) != 200000 || lines[1] != "after" {
		t.Fatalf("got %d lines, first has %d characters", len(lines), len(lines[0]))
	}
}
