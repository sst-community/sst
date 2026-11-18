//go:build !darwin

package watcher

import "log/slog"

func newBackend(trees []string, roots []string, listed []string, headFile string, log *slog.Logger) (backend, error) {
	return newFsnotifyBackend()
}
