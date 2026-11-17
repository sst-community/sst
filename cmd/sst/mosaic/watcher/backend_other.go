//go:build !darwin

package watcher

import "log/slog"

func newBackend(trees []string, headFile string, log *slog.Logger) (backend, error) {
	return newFsnotifyBackend()
}
