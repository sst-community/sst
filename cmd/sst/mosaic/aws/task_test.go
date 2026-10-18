package aws

import (
	"fmt"
	"os/exec"
	"slices"
	"sync"
	"testing"
	"time"
)

// lines collects what onLine is passed, from both pipes.
type lines struct {
	mu  sync.Mutex
	got []string
}

func (l *lines) add(line string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.got = append(l.got, line)
}

func (l *lines) all() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return slices.Clone(l.got)
}

func noReadError(t *testing.T) func(error) {
	return func(err error) { t.Errorf("read error: %v", err) }
}

// A task's output is read to its end, on stdout and stderr, before the wait
// returns.
func TestStartWithOutputReadsAllOfIt(t *testing.T) {
	var out lines
	cmd := exec.Command("sh", "-c", `i=0; while [ $i -lt 2000 ]; do echo line$i; i=$((i+1)); done; echo last >&2`)
	wait, err := startWithOutput(cmd, out.add, noReadError(t))
	if err != nil {
		t.Fatal(err)
	}
	wait()
	got := out.all()
	if len(got) != 2001 {
		t.Fatalf("read %d lines, want 2001", len(got))
	}
	for i := range 2000 {
		if !slices.Contains(got, fmt.Sprintf("line%d", i)) {
			t.Fatalf("line%d is missing", i)
		}
	}
	if !slices.Contains(got, "last") {
		t.Fatal("the line on stderr is missing")
	}
}

// A process the command started in the background keeps its output open. The
// wait still returns soon after the command exits, with what it printed.
func TestStartWithOutputDoesNotWaitForWhatTheCommandStarted(t *testing.T) {
	grace := taskOutputGrace
	taskOutputGrace = 100 * time.Millisecond
	t.Cleanup(func() { taskOutputGrace = grace })

	var out lines
	cmd := exec.Command("sh", "-c", `echo before; sleep 3 & echo after`)
	wait, err := startWithOutput(cmd, out.add, noReadError(t))
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	wait()
	if took := time.Since(start); took > 2*time.Second {
		t.Fatalf("the wait took %v, as long as the background process", took)
	}
	if got := out.all(); !slices.Equal(got, []string{"before", "after"}) {
		t.Fatalf("read %q, want before and after", got)
	}
}

func TestStartWithOutputOfACommandThatCantStart(t *testing.T) {
	wait, err := startWithOutput(exec.Command("sst-no-such-command"), func(string) {}, noReadError(t))
	if err == nil {
		t.Fatal("startWithOutput() = nil, want the error")
	}
	done := make(chan struct{})
	go func() {
		wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("the wait of a command that didn't start didn't return")
	}
}
