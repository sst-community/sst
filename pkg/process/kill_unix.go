//go:build !windows
// +build !windows

package process

import (
	"errors"
	"log/slog"
	"os"
	"syscall"
	"time"
)

func sendSignal(process *os.Process, sig syscall.Signal) error {
	if process.Pid <= 0 {
		return errors.New("invalid process")
	}
	if err := syscall.Kill(-process.Pid, sig); err != nil {
		if !errors.Is(err, syscall.ESRCH) {
			slog.Warn("failed to kill process group", "pid", process.Pid, "signal", sig, "err", err)
		}
		// Group kill failed — either no such group (ESRCH) or other error.
		// Fall back to signaling the individual process.
		if err := process.Signal(sig); err != nil {
			if errors.Is(err, os.ErrProcessDone) {
				slog.Info("process already exited", "pid", process.Pid, "signal", sig)
				return nil
			}
			return err
		}
		slog.Info("sent signal to individual process", "pid", process.Pid, "signal", sig)
	} else {
		slog.Info("sent signal to process group", "pid", process.Pid, "signal", sig)
	}

	return nil
}

func sendTermSignal(process *os.Process) error {
	return sendSignal(process, syscall.SIGTERM)
}

func sendKillSignal(process *os.Process) error {
	return sendSignal(process, syscall.SIGKILL)
}

// stopGroup stops what's left of a process group whose leader has exited: it's
// asked to stop, and killed if it hasn't a moment later. The group's ID isn't
// given to another process while anything is left in it.
func stopGroup(pgid int) {
	if pgid <= 0 || syscall.Kill(-pgid, 0) != nil {
		return
	}
	syscall.Kill(-pgid, syscall.SIGTERM)
	for deadline := time.Now().Add(killWait); time.Now().Before(deadline); {
		time.Sleep(50 * time.Millisecond)
		if syscall.Kill(-pgid, 0) != nil {
			return
		}
	}
	slog.Info("killing what an exited process started", "pgid", pgid)
	syscall.Kill(-pgid, syscall.SIGKILL)
}
