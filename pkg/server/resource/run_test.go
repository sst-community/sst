package resource

import (
	"runtime"
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
	if runtime.GOOS == "windows" {
		t.Skip("the commands need sh, head and tr")
	}
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

func TestRunWithNormalOutput(t *testing.T) {
	lines := collectOutput(t, `echo `+strings.Repeat("x", 100)+`; echo done`)
	if len(lines) != 2 || lines[0] != strings.Repeat("x", 100) || lines[1] != "done" {
		t.Fatalf("got %q", lines)
	}
}

func TestRunWithALineOverTheLimit(t *testing.T) {
	// 3 MB on one line is dropped with a note, and the lines around it still come through
	lines := collectOutput(t, `echo before; head -c 3000000 /dev/zero | tr '\0' a; echo; echo after`)
	if len(lines) != 3 || lines[0] != "before" || !strings.Contains(lines[1], "longer than 1 MB") || lines[2] != "after" {
		t.Fatalf("got %d lines: %.80q", len(lines), lines)
	}
}

func TestRunWithALineJustUnderTheLimit(t *testing.T) {
	// exactly the limit is passed on whole
	lines := collectOutput(t, `head -c 1048576 /dev/zero | tr '\0' a; echo; echo after`)
	if len(lines) != 2 || len(lines[0]) != 1048576 || lines[1] != "after" {
		t.Fatalf("got %d lines", len(lines))
	}
}

func TestRunWithALotOfStderr(t *testing.T) {
	// more on stderr than a pipe holds, while stdout stays open
	lines := collectOutput(t, `head -c 300000 /dev/zero | tr '\0' e >&2; echo; sleep 0.2; echo after`)
	if len(lines) == 0 || lines[len(lines)-1] != "after" {
		t.Fatalf("got %d lines, last %q", len(lines), lines[len(lines)-1:])
	}
}

func TestRunPassesALongLineOn(t *testing.T) {
	lines := collectOutput(t, `head -c 200000 /dev/zero | tr '\0' a; echo; echo after`)
	if len(lines) != 2 || len(lines[0]) != 200000 || lines[1] != "after" {
		t.Fatalf("got %d lines, first has %d characters", len(lines), len(lines[0]))
	}
}
