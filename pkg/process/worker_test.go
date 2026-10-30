//go:build !windows

package process

import (
	"bufio"
	"io"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func startTestWorker(t *testing.T, script string) *Worker {
	t.Helper()
	reset()
	w, err := StartWorker(Command("sh", "-c", script))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { syscall.Kill(-w.cmd.Process.Pid, syscall.SIGKILL) })
	return w
}

// readAllWithin reads a worker's output to the end, or fails the test.
func readAllWithin(t *testing.T, w *Worker, d time.Duration) string {
	t.Helper()
	out := make(chan string, 1)
	go func() {
		data, _ := io.ReadAll(w.Logs())
		out <- string(data)
	}()
	select {
	case got := <-out:
		return got
	case <-time.After(d):
		t.Fatalf("the worker's output didn't end within %v", d)
		return ""
	}
}

// alive is whether a process still runs a second after it should have gone.
// One that was signalled can still answer kill(pid, 0) for a moment after its
// group is empty, while the kernel finishes its exit, though ps no longer
// lists it.
func alive(pid int) bool {
	for deadline := time.Now().Add(time.Second); time.Now().Before(deadline); {
		if syscall.Kill(pid, 0) != nil {
			return false
		}
		time.Sleep(10 * time.Millisecond)
	}
	return true
}

// A worker's output has what it printed last, and ends once it exits.
func TestWorkerOutputEndsWhenItExits(t *testing.T) {
	w := startTestWorker(t, "echo out; echo err >&2; echo last")
	got := readAllWithin(t, w, 2*time.Second)
	for _, want := range []string{"out", "err", "last"} {
		if !strings.Contains(got, want) {
			t.Errorf("the output %q doesn't have %q", got, want)
		}
	}
	select {
	case <-w.exited:
	default:
		t.Error("the output ended before the worker was waited for")
	}
}

// sst dev takes a worker whose output ended for gone, so the output of one that
// closes it and goes on running doesn't end until it exits.
func TestWorkerThatClosesItsOutputIsStillRunning(t *testing.T) {
	w := startTestWorker(t, "exec >&- 2>&-; sleep 1")
	readAllWithin(t, w, 3*time.Second)
	select {
	case <-w.exited:
	default:
		t.Error("the output ended while the worker was running")
	}
}

// What a worker started is stopped when it exits on its own, and its output,
// which that held open, ends.
func TestWorkerThatExitsTakesWhatItStarted(t *testing.T) {
	w := startTestWorker(t, "sleep 60 & echo $!")
	logs := bufio.NewReader(w.Logs())
	line, err := logs.ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	child, _ := strconv.Atoi(strings.TrimSpace(line))
	if _, err := io.ReadAll(logs); err != nil {
		t.Fatal(err)
	}
	<-w.done
	if alive(child) {
		t.Errorf("what the worker started (pid %d) still runs after it exited", child)
	}
}

// Something a worker started outside its group can hold its output open after
// it exits. Its output still ends, so it isn't taken for running.
func TestWorkerOutputEndsWhenSomethingElseHoldsIt(t *testing.T) {
	// it waits for the process to leave its group, which takes a moment
	w := startTestWorker(t, `perl -MPOSIX -e '$| = 1; setsid(); print "$$\n"; sleep 30' & sleep 0.5`)
	logs := bufio.NewReader(w.Logs())
	line, err := logs.ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if held, err := strconv.Atoi(strings.TrimSpace(line)); err == nil {
		t.Cleanup(func() { syscall.Kill(held, syscall.SIGKILL) })
	}
	done := make(chan struct{})
	go func() {
		io.Copy(io.Discard, logs)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(workerOutputGrace + 2*time.Second):
		t.Fatal("the worker's output didn't end after it exited")
	}
}

// Stop returns at once, and a worker that doesn't stop when asked is killed, with
// what it started.
func TestWorkerThatIgnoresStopIsKilled(t *testing.T) {
	w := startTestWorker(t, `trap "" TERM; sleep 60 & echo $!; wait`)
	logs := bufio.NewReader(w.Logs())
	line, err := logs.ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	child, _ := strconv.Atoi(strings.TrimSpace(line))
	go io.Copy(io.Discard, logs)

	start := time.Now()
	w.Stop()
	if took := time.Since(start); took > 100*time.Millisecond {
		t.Errorf("Stop took %v, want it to return at once", took)
	}
	select {
	case <-w.done:
	case <-time.After(killWait + 2*time.Second):
		t.Fatal("the worker wasn't killed")
	}
	if alive(child) {
		t.Errorf("what the worker started (pid %d) still runs after it was killed", child)
	}
}

// Cleanup, when sst dev exits, stops the workers and what they started.
func TestCleanupStopsWorkers(t *testing.T) {
	w := startTestWorker(t, "sleep 60 & echo $!; wait")
	logs := bufio.NewReader(w.Logs())
	line, err := logs.ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	child, _ := strconv.Atoi(strings.TrimSpace(line))
	go io.Copy(io.Discard, logs)

	if err := Cleanup(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-w.done:
	default:
		t.Fatal("Cleanup returned before the worker stopped")
	}
	if alive(child) {
		t.Errorf("what the worker started (pid %d) still runs after Cleanup", child)
	}
}

// A worker is tracked until it's gone, not as a command.
func TestWorkerIsTrackedUntilItsGone(t *testing.T) {
	w := startTestWorker(t, "exit 0")
	lock.Lock()
	commands := len(cmds)
	lock.Unlock()
	if commands != 0 {
		t.Errorf("%d commands are tracked, want the worker tracked as one only", commands)
	}
	readAllWithin(t, w, 2*time.Second)
	<-w.done
	workersLock.Lock()
	_, tracked := workers[w]
	workersLock.Unlock()
	if tracked {
		t.Error("the worker is still tracked after it exited")
	}
}

// A worker that can't start isn't tracked.
func TestWorkerThatCantStart(t *testing.T) {
	reset()
	if _, err := StartWorker(Command("/nonexistent/worker")); err == nil {
		t.Fatal("want an error for a worker that can't start")
	}
	lock.Lock()
	defer lock.Unlock()
	if len(cmds) != 0 {
		t.Errorf("%d commands are tracked after a worker failed to start, want 0", len(cmds))
	}
}
