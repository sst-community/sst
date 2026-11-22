package process

import (
	"os"
	"os/exec"
	"testing"
	"time"
)

func TestKillNil(t *testing.T) {
	if err := Kill(nil); err != nil {
		t.Fatalf("Kill(nil) returned error: %v", err)
	}
}

func TestKillTerminatesProcess(t *testing.T) {
	reset()
	cmd := Command("sleep", "60")
	if err := cmd.Start(); err != nil {
		t.Fatalf("failed to start: %v", err)
	}
	pid := cmd.Process.Pid

	if err := Kill(cmd.Process); err != nil {
		t.Fatalf("Kill returned error: %v", err)
	}

	// process should no longer exist
	if err := signalProcess(pid); err == nil {
		t.Fatal("process still alive after Kill")
	}
}

func TestCleanupKillsAllTracked(t *testing.T) {
	reset()
	var pids []int
	for i := 0; i < 3; i++ {
		cmd := Command("sleep", "60")
		if err := cmd.Start(); err != nil {
			t.Fatalf("failed to start process %d: %v", i, err)
		}
		pids = append(pids, cmd.Process.Pid)
	}

	if err := Cleanup(); err != nil {
		t.Fatalf("Cleanup returned error: %v", err)
	}

	for _, pid := range pids {
		if err := signalProcess(pid); err == nil {
			t.Errorf("process %d still alive after Cleanup", pid)
		}
	}
}

func TestKillAlreadyExited(t *testing.T) {
	reset()
	cmd := Command("true")
	if err := cmd.Start(); err != nil {
		t.Fatalf("failed to start: %v", err)
	}
	cmd.Wait()
	// should not error on already-exited process
	if err := Kill(cmd.Process); err != nil {
		t.Fatalf("Kill on exited process returned error: %v", err)
	}
}

func TestCommandTracksProcess(t *testing.T) {
	reset()
	cmd := Command("sleep", "60")
	if err := cmd.Start(); err != nil {
		t.Fatalf("failed to start: %v", err)
	}
	defer Kill(cmd.Process)

	lock.Lock()
	count := len(cmds)
	lock.Unlock()

	if count != 1 {
		t.Fatalf("expected 1 tracked command, got %d", count)
	}
}

func TestKillUntracksProcess(t *testing.T) {
	reset()
	cmd := Command("sleep", "60")
	if err := cmd.Start(); err != nil {
		t.Fatalf("failed to start: %v", err)
	}

	Kill(cmd.Process)

	lock.Lock()
	count := len(cmds)
	lock.Unlock()

	if count != 0 {
		t.Fatalf("expected 0 tracked commands after Kill, got %d", count)
	}
}

func signalProcess(pid int) error {
	p, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return p.Signal(os.Interrupt)
}

func init() {
	killWait = 1 * time.Second
}

func fakeCmd(pid int) *exec.Cmd {
	return &exec.Cmd{Process: &os.Process{Pid: pid}}
}

func trackedNow() []*exec.Cmd {
	lock.Lock()
	defer lock.Unlock()
	return append([]*exec.Cmd{}, cmds...)
}

func setTracked(list ...*exec.Cmd) {
	lock.Lock()
	defer lock.Unlock()
	cmds = list
}

func sameCmds(t *testing.T, got, want []*exec.Cmd) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %d tracked commands, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("tracked command %d is not the one expected", i)
		}
	}
}

// untrack searches from the end and moves the last command into the gap
func TestUntrackSwapsLastIntoGap(t *testing.T) {
	a, b, c, d := fakeCmd(1), fakeCmd(2), fakeCmd(3), fakeCmd(4)
	setTracked(a, b, c, d)
	defer reset()

	untrack(2)
	sameCmds(t, trackedNow(), []*exec.Cmd{a, d, c})

	untrack(4)
	sameCmds(t, trackedNow(), []*exec.Cmd{a, c})
}

// When two commands share a pid, the one tracked last is removed, and only it
func TestUntrackRemovesLastMatchOnly(t *testing.T) {
	first, other, last := fakeCmd(7), fakeCmd(8), fakeCmd(7)
	setTracked(first, other, last)
	defer reset()

	untrack(7)
	sameCmds(t, trackedNow(), []*exec.Cmd{first, other})
}

func TestUntrackSkipsUnstartedAndUnknown(t *testing.T) {
	unstarted, started := &exec.Cmd{}, fakeCmd(5)
	setTracked(unstarted, started)
	defer reset()

	untrack(99)
	sameCmds(t, trackedNow(), []*exec.Cmd{unstarted, started})

	untrack(5)
	sameCmds(t, trackedNow(), []*exec.Cmd{unstarted})

	setTracked()
	untrack(5)
	sameCmds(t, trackedNow(), []*exec.Cmd{})
}
