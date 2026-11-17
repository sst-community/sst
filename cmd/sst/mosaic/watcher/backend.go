package watcher

import (
	"github.com/fsnotify/fsnotify"
)

// backend delivers file system events to watchLoop.
//
// A recursive backend watches whole trees from the paths it was created with,
// and Add does nothing. A per-directory backend needs Add for every directory
// it should report, and for any single file, such as .git/HEAD.
type backend interface {
	Name() string
	Recursive() bool
	Add(path string) error
	Events() <-chan fsnotify.Event
	Errors() <-chan error
	Close() error
}

// fsnotifyBackend uses inotify on Linux and ReadDirectoryChangesW on Windows,
// which both cost one watch per directory and no descriptor per file. It is
// also the fallback on macOS, where fsnotify uses kqueue and opens a
// descriptor for every file and directory it watches.
type fsnotifyBackend struct {
	w *fsnotify.Watcher
}

func newFsnotifyBackend() (*fsnotifyBackend, error) {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	return &fsnotifyBackend{w: w}, nil
}

func (b *fsnotifyBackend) Name() string                  { return "fsnotify" }
func (b *fsnotifyBackend) Recursive() bool               { return false }
func (b *fsnotifyBackend) Add(path string) error         { return b.w.Add(path) }
func (b *fsnotifyBackend) Events() <-chan fsnotify.Event { return b.w.Events }
func (b *fsnotifyBackend) Errors() <-chan error          { return b.w.Errors }
func (b *fsnotifyBackend) Close() error                  { return b.w.Close() }
