//go:build windows

package target

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

// lock takes a lock on the whole file, shared or exclusive, and says whether
// it did. Without wait, it doesn't when another one is in the way.
func lock(file *os.File, exclusive, wait bool) (bool, error) {
	var flags uint32
	if exclusive {
		flags |= windows.LOCKFILE_EXCLUSIVE_LOCK
	}
	if !wait {
		flags |= windows.LOCKFILE_FAIL_IMMEDIATELY
	}
	err := windows.LockFileEx(windows.Handle(file.Fd()), flags, 0, 1, 0, &windows.Overlapped{})
	if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
		return false, nil
	}
	return err == nil, err
}

func unlock(file *os.File) error {
	return windows.UnlockFileEx(windows.Handle(file.Fd()), 0, 1, 0, &windows.Overlapped{})
}
