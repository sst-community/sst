//go:build windows
// +build windows

package process

import "os"

// Windows doesn't support process groups like Unix. These functions only
// terminate the target process; child processes may continue running.

func sendTermSignal(process *os.Process) error {
	return process.Kill()
}

func sendKillSignal(process *os.Process) error {
	return process.Kill()
}

// Windows has no process groups to stop.
func stopGroup(pgid int) {}
