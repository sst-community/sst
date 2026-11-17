package target

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
)

// A command on a target's stage uses the target from when it starts it until
// the command exits, and holds a shared lock on a file beside the target's
// home for that long, outside it, so a reset can remove the home while it's
// held. A remove stops the target's container, and `sst target stop` and
// `reset` act, only while they hold that lock alone. So none of them acts
// under another command: a deploy that hasn't taken its stage's lock yet, a
// diff, which takes none, or `sst dev`. The system lets go of a process's
// locks when it exits, however it exits, so a command that crashed leaves
// nothing that keeps the container running.

var (
	usesMu sync.Mutex
	// The lock file of each target this process uses, by its path
	uses = map[string]*os.File{}
)

// usesFile is the file the commands using a target lock, beside its home
func usesFile(name string) string {
	return HomeDir(name) + ".lock"
}

// use holds this process's shared lock on the target whose lock file is at
// path, until it exits. While a remove is stopping the target's container,
// it says so and waits.
func use(path string) error {
	usesMu.Lock()
	defer usesMu.Unlock()
	if uses[path] != nil {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	ok, err := lock(file, false, false)
	if err == nil && !ok {
		Say("Waiting for another command to stop the target's container, to start it again.")
		_, err = lock(file, false, true)
	}
	if err != nil {
		file.Close()
		return err
	}
	uses[path] = file
	return nil
}

// alone runs fn while no other command uses the target whose lock file is at
// path, and says whether it did: it doesn't while another one does. A
// command that starts on the target meanwhile waits until fn has returned.
// This process uses the target again after.
func alone(path string, fn func() error) (bool, error) {
	if err := use(path); err != nil {
		return false, err
	}
	usesMu.Lock()
	defer usesMu.Unlock()
	file := uses[path]
	// A lock isn't changed in place on every system, so this one is let go
	// first, and taken again after
	if err := unlock(file); err != nil {
		return false, err
	}
	defer func() {
		if _, err := lock(file, false, true); err != nil {
			slog.Warn("using the target again", "err", err)
		}
	}()
	ok, err := lock(file, true, false)
	if err != nil || !ok {
		return false, err
	}
	defer unlock(file)
	return true, fn()
}

// Alone runs fn while no other command is running on a stage bound to the
// target, of any app, and says whether it did: it doesn't while one is. A
// command that starts on the target meanwhile waits until fn has returned.
func (l *Local) Alone(fn func() error) (bool, error) {
	return alone(usesFile(l.settings.Name), fn)
}

// StopIfIdle stops the target's container when nothing uses it: no stage on
// it has anything deployed, of any app, and no other command is running on
// it. It says whether it stopped it. Its volumes are kept, and the next
// command on a stage bound to the target starts it again.
func (l *Local) StopIfIdle(ctx context.Context) (bool, error) {
	s := l.settings
	if s.Container == nil {
		return false, nil
	}
	stopped := false
	_, err := l.Alone(func() error {
		deployed, err := Deployed(s.Name)
		if err != nil || len(deployed) > 0 {
			return err
		}
		stopped, err = l.StopContainer(ctx)
		return err
	})
	return stopped, err
}
