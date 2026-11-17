//go:build darwin || linux

package watcher

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/sst/sst/v3/pkg/bus"
	"github.com/sst/sst/v3/pkg/project"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/sys/unix"
)

// openDescriptors counts the descriptors this process holds, by asking the
// kernel about each number below the soft limit.
func openDescriptors(t *testing.T) int {
	t.Helper()
	var limit unix.Rlimit
	require.NoError(t, unix.Getrlimit(unix.RLIMIT_NOFILE, &limit))
	max := min(limit.Cur, 1<<16)
	n := 0
	for fd := range int(max) {
		if _, err := unix.FcntlInt(uintptr(fd), unix.F_GETFD, 0); err == nil {
			n++
		}
	}
	return n
}

// makeTree writes dirs directories of files files each under root.
func makeTree(t testing.TB, root string, dirs, files int) {
	t.Helper()
	for d := range dirs {
		dir := filepath.Join(root, "packages", fmt.Sprintf("pkg%d", d), "src")
		require.NoError(t, os.MkdirAll(dir, 0755))
		for f := range files {
			require.NoError(t, os.WriteFile(filepath.Join(dir, fmt.Sprintf("file%d.ts", f)), nil, 0644))
		}
	}
}

// Issue #278: with kqueue the watcher held a descriptor for every file and
// directory in the project. FSEvents on macOS and inotify on Linux must hold
// a fixed number, however big the project is.
func TestStartDescriptorsDoNotGrowWithProjectSize(t *testing.T) {
	if os.Getenv("SST_WATCHER") == "kqueue" {
		t.Skip("kqueue holds a descriptor per file by design")
	}

	root := t.TempDir()
	makeTree(t, root, 100, 20) // 2,000 files in 201 directories

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := bus.SubscribeAll()
	defer bus.Unsubscribe(events)

	before := openDescriptors(t)
	errCh := make(chan error, 1)
	go func() {
		errCh <- Start(ctx, WatchConfig{Root: root, Watch: project.Watch{}})
	}()
	waitForWatcherReady(t, filepath.Join(root, "watcher-ready.txt"), events)

	held := openDescriptors(t) - before
	t.Logf("watcher holds %d descriptors for 2,000 files", held)
	assert.Less(t, held, 20, "watcher descriptors grow with the number of files")

	cancel()
	require.NoError(t, <-errCh)
}
