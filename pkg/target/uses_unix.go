//go:build !windows

package target

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

// lock takes a lock on the whole file, shared or exclusive, and says whether
// it did. Without wait, it doesn't when another one is in the way.
func lock(file *os.File, exclusive, wait bool) (bool, error) {
	how := unix.LOCK_SH
	if exclusive {
		how = unix.LOCK_EX
	}
	if !wait {
		how |= unix.LOCK_NB
	}
	for {
		err := unix.Flock(int(file.Fd()), how)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if errors.Is(err, unix.EWOULDBLOCK) {
			return false, nil
		}
		return err == nil, err
	}
}

func unlock(file *os.File) error {
	return unix.Flock(int(file.Fd()), unix.LOCK_UN)
}
