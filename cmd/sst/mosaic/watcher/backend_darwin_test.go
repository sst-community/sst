//go:build darwin

package watcher

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/sst/sst/v3/pkg/bus"
	"github.com/sst/sst/v3/pkg/project"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The watcher must not fall back to kqueue silently: that would bring back a
// descriptor for every file in the project.
func TestNewBackendUsesFSEventsOnDarwin(t *testing.T) {
	if os.Getenv("SST_WATCHER") == "kqueue" {
		t.Skip("kqueue forced")
	}
	root := t.TempDir()
	b, err := newBackend([]string{root}, nil, filepath.Join(root, ".git/HEAD"), slog.Default())
	require.NoError(t, err)
	defer b.Close()
	assert.Equal(t, "fsevents", b.Name())
	assert.True(t, b.Recursive())
}

// When FSEvents can't watch the project, the default falls back to kqueue,
// but SST_WATCHER=fsevents fails instead of falling back quietly.
func TestNewBackendFallsBackOnlyByDefault(t *testing.T) {
	// a tree that doesn't exist can't be watched by FSEvents
	missing := filepath.Join(t.TempDir(), "missing")
	head := filepath.Join(missing, ".git/HEAD")

	t.Setenv("SST_WATCHER", "")
	b, err := newBackend([]string{missing}, nil, head, slog.Default())
	require.NoError(t, err)
	assert.Equal(t, "fsnotify", b.Name())
	b.Close()

	t.Setenv("SST_WATCHER", "fsevents")
	b, err = newBackend([]string{missing}, nil, head, slog.Default())
	if err == nil {
		b.Close()
	}
	require.Error(t, err)
	assert.Contains(t, err.Error(), "SST_WATCHER=fsevents")
}

func newTestFSEventsBackend(trees []treeMapping, headFile string) *fseventsBackend {
	return &fseventsBackend{
		trees:    trees,
		headFile: headFile,
		events:   make(chan fsnotify.Event, 16),
		errors:   make(chan error, 16),
		done:     make(chan struct{}),
		created:  map[string]uint64{},
	}
}

func drainEvents(b *fseventsBackend) []fsnotify.Event {
	var out []fsnotify.Event
	for {
		select {
		case e := <-b.events:
			out = append(out, e)
		default:
			return out
		}
	}
}

func TestFSEventsMapPath(t *testing.T) {
	b := newTestFSEventsBackend([]treeMapping{
		{real: "/private/var/app", tree: "/var/app"},
		{real: "/private/var/app/packages/shared", tree: "/var/app/packages/shared"},
		{real: "/Users/me/external", tree: "/Users/me/link-to-external"},
	}, "")

	cases := []struct {
		in, path, tree string
		ok             bool
	}{
		{"/private/var/app/src/a.ts", "/var/app/src/a.ts", "/var/app", true},
		{"/private/var/app", "/var/app", "/var/app", true},
		// The longest matching tree wins.
		{"/private/var/app/packages/shared/x.ts", "/var/app/packages/shared/x.ts", "/var/app/packages/shared", true},
		{"/Users/me/external/lib/b.ts", "/Users/me/link-to-external/lib/b.ts", "/Users/me/link-to-external", true},
		// A sibling with the same prefix is not inside the tree.
		{"/private/var/application/a.ts", "", "", false},
		{"/elsewhere/a.ts", "", "", false},
	}
	for _, c := range cases {
		path, tree, ok := b.mapPath(c.in)
		assert.Equal(t, c.ok, ok, c.in)
		assert.Equal(t, c.path, path, c.in)
		assert.Equal(t, c.tree, tree, c.in)
	}
}

func TestFSEventsHandle(t *testing.T) {
	root := t.TempDir()
	write := func(rel string) string {
		path := filepath.Join(root, rel)
		require.NoError(t, os.MkdirAll(filepath.Dir(path), 0755))
		require.NoError(t, os.WriteFile(path, []byte("x"), 0644))
		return path
	}
	file := write("src/handler.ts")
	head := write(".git/HEAD")
	hidden := write(".sst/types.d.ts")
	deps := write("node_modules/pkg/index.js")
	dotfile := write(".env")
	dir := filepath.Join(root, "src", "newpkg")
	require.NoError(t, os.MkdirAll(dir, 0755))
	gone := filepath.Join(root, "src", "deleted.ts")

	const isFile = 0x00010000
	const inodeMeta = 0x00000400

	cases := []struct {
		name  string
		path  string
		flags uint32
		want  []fsnotify.Event
	}{
		{"modified file", file, isFile | fsEventFlagItemModified, []fsnotify.Event{{Name: file, Op: fsnotify.Write}}},
		{"created file", file, isFile | fsEventFlagItemCreated, []fsnotify.Event{{Name: file, Op: fsnotify.Write}}},
		{"renamed into place", file, isFile | fsEventFlagItemRenamed, []fsnotify.Event{{Name: file, Op: fsnotify.Write}}},
		// An atomic save removes the old file and puts a new one in its place.
		{"removed and recreated", file, isFile | fsEventFlagItemRemoved | fsEventFlagItemCreated, []fsnotify.Event{{Name: file, Op: fsnotify.Write}}},
		{"metadata only", file, isFile | inodeMeta, nil},
		{"removed file", gone, isFile | fsEventFlagItemRemoved, nil},
		{"git head", head, isFile | fsEventFlagItemModified, []fsnotify.Event{{Name: head, Op: fsnotify.Write}}},
		{"hidden dir", hidden, isFile | fsEventFlagItemModified, nil},
		{"node_modules", deps, isFile | fsEventFlagItemModified, nil},
		{"hidden file", dotfile, isFile | fsEventFlagItemModified, []fsnotify.Event{{Name: dotfile, Op: fsnotify.Write}}},
		// A directory made here: its files come as their own events.
		{"created dir", dir, fsEventFlagItemIsDir | fsEventFlagItemCreated, nil},
		// A directory moved in: nothing comes for its files, so it is walked.
		{"moved-in dir", dir, fsEventFlagItemIsDir | fsEventFlagItemRenamed, []fsnotify.Event{{Name: dir, Op: fsnotify.Create}}},
		{"modified dir", filepath.Join(root, "src"), fsEventFlagItemIsDir | inodeMeta, nil},
		{"outside the trees", "/elsewhere/a.ts", isFile | fsEventFlagItemModified, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			b := newTestFSEventsBackend([]treeMapping{{real: root, tree: root}}, head)
			b.handle(c.path, c.flags)
			assert.Equal(t, c.want, drainEvents(b))
		})
	}
}

func TestFSEventsHandleReportsMovedInDirOnce(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "newpkg")
	require.NoError(t, os.MkdirAll(dir, 0755))
	b := newTestFSEventsBackend([]treeMapping{{real: root, tree: root}}, "")

	// FSEvents repeats an item's flags in later batches. Reporting the
	// directory again would make the watcher report all its files again.
	b.handle(dir, fsEventFlagItemIsDir|fsEventFlagItemRenamed)
	b.handle(dir, fsEventFlagItemIsDir|fsEventFlagItemRenamed)
	assert.Len(t, drainEvents(b), 1)

	// Once it is removed and another is moved in, it is new again.
	require.NoError(t, os.Remove(dir))
	b.handle(dir, fsEventFlagItemIsDir|fsEventFlagItemRenamed|fsEventFlagItemRemoved)
	assert.Empty(t, drainEvents(b))
	require.NoError(t, os.MkdirAll(dir, 0755))
	b.handle(dir, fsEventFlagItemIsDir|fsEventFlagItemRenamed)
	assert.Len(t, drainEvents(b), 1)
}

// When a directory is moved away and another moved to the same path within
// one batch, FSEvents sends one item with Renamed and Removed set and the
// directory exists. It is a different directory, so it is reported, but a
// repeat of that item is not.
func TestFSEventsHandleReportsDirReplacedWithinOneBatch(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "newpkg")
	require.NoError(t, os.MkdirAll(dir, 0755))
	b := newTestFSEventsBackend([]treeMapping{{real: root, tree: root}}, "")

	b.handle(dir, fsEventFlagItemIsDir|fsEventFlagItemRenamed)
	assert.Len(t, drainEvents(b), 1)

	// Hold the old directory open so the new one can't reuse its inode.
	old, err := os.Open(dir)
	require.NoError(t, err)
	defer old.Close()
	require.NoError(t, os.Rename(dir, filepath.Join(root, "trash")))
	require.NoError(t, os.MkdirAll(dir, 0755))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "handler.ts"), nil, 0644))

	recreated := uint32(fsEventFlagItemIsDir | fsEventFlagItemRenamed | fsEventFlagItemRemoved)
	b.handle(dir, recreated)
	assert.Equal(t, []fsnotify.Event{{Name: dir, Op: fsnotify.Create}}, drainEvents(b))
	b.handle(dir, recreated)
	assert.Empty(t, drainEvents(b), "a repeated item is not a new directory")
}

func TestFSEventsHandleReportsDroppedEvents(t *testing.T) {
	root := t.TempDir()
	b := newTestFSEventsBackend([]treeMapping{{real: root, tree: root}}, "")
	b.handle(root, fsEventFlagMustScanSubDirs|fsEventFlagKernelDropped)
	assert.Empty(t, drainEvents(b))
	select {
	case err := <-b.errors:
		assert.Contains(t, err.Error(), "dropped events")
	default:
		t.Fatal("expected an error for dropped events")
	}
}

// A dropped-events flag can come on an item with a change of its own, which
// is still reported.
func TestFSEventsHandleKeepsChangeOnItemWithDroppedEvents(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "handler.ts")
	require.NoError(t, os.WriteFile(file, []byte("x"), 0644))
	b := newTestFSEventsBackend([]treeMapping{{real: root, tree: root}}, "")

	b.handle(file, 0x00010000|fsEventFlagItemModified|fsEventFlagMustScanSubDirs)
	assert.Equal(t, []fsnotify.Event{{Name: file, Op: fsnotify.Write}}, drainEvents(b))
	assert.Len(t, b.errors, 1)
}

// After Close, a callback still running on the dispatch queue must not block
// on a full channel nobody reads any more.
func TestFSEventsSendAfterCloseDoesNotBlock(t *testing.T) {
	b := newTestFSEventsBackend(nil, "")
	b.events = make(chan fsnotify.Event)
	close(b.done)
	finished := make(chan struct{})
	go func() {
		b.send(fsnotify.Event{Name: "x", Op: fsnotify.Write})
		close(finished)
	}()
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("send blocked after close")
	}
}

func TestFSEventsWatchesSeveralTrees(t *testing.T) {
	a, ext := t.TempDir(), t.TempDir()
	b, err := newFSEventsBackend([]string{a, ext}, nil, filepath.Join(a, ".git/HEAD"))
	require.NoError(t, err)
	defer b.Close()

	path := filepath.Join(ext, "lib.ts")
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		require.NoError(t, os.WriteFile(path, []byte(time.Now().String()), 0644))
		select {
		case e := <-b.Events():
			if e.Name == path {
				assert.NoError(t, b.Close())
				assert.NoError(t, b.Close(), "Close is idempotent")
				return
			}
		case <-time.After(200 * time.Millisecond):
		}
	}
	t.Fatalf("expected an event for %s", path)
}

// Close must be safe while callbacks are running: it releases the stream and
// its queue, so a callback still in flight would touch freed memory. This
// opens and closes streams while files change under them, with a consumer
// that stops reading so callbacks block in send when Close runs.
func TestFSEventsCloseWhileCallbacksRun(t *testing.T) {
	root := t.TempDir()
	stop := make(chan struct{})
	writer := make(chan struct{})
	go func() {
		defer close(writer)
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			default:
			}
			os.WriteFile(filepath.Join(root, fmt.Sprintf("f%d.ts", i%50)), []byte{byte(i)}, 0644)
		}
	}()
	defer func() {
		close(stop)
		<-writer
	}()

	for range 30 {
		b, err := newFSEventsBackend([]string{root}, nil, filepath.Join(root, ".git/HEAD"))
		require.NoError(t, err)
		// Read a few events so callbacks are running, then stop reading.
		for range 3 {
			select {
			case <-b.Events():
			case <-time.After(time.Second):
			}
		}
		time.Sleep(20 * time.Millisecond)
		done := make(chan struct{})
		go func() {
			b.Close()
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("Close hung while callbacks were running")
		}
	}
}

// A file written into a directory made while the watcher runs is reported
// once. FSEvents reports the file itself, so walking the new directory as
// well reported it twice, and every rebuild or deploy ran twice. (inotify on
// Linux can still report it twice, depending on timing; that's older and
// separate.)
func TestStartReportsFileInNewDirectoryOnce(t *testing.T) {
	root := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := bus.SubscribeAll()
	defer bus.Unsubscribe(events)

	errCh := make(chan error, 1)
	go func() {
		errCh <- Start(ctx, WatchConfig{Root: root, Watch: project.Watch{}})
	}()
	waitForWatcherReady(t, filepath.Join(root, "watcher-ready.txt"), events)
	// Let the probe's own events pass the 500ms debounce.
	time.Sleep(700 * time.Millisecond)

	dir := filepath.Join(root, "src", "newpkg")
	require.NoError(t, os.MkdirAll(dir, 0755))
	path := filepath.Join(dir, "handler.ts")
	require.NoError(t, os.WriteFile(path, []byte("export {}\n"), 0644))

	n := 0
	deadline := time.After(2 * time.Second)
collect:
	for {
		select {
		case evt := <-events:
			if changed, ok := evt.(*FileChangedEvent); ok && changed.Path == path {
				n++
			}
		case <-deadline:
			break collect
		}
	}
	assert.Equal(t, 1, n, "events for %s", path)

	cancel()
	require.NoError(t, <-errCh)
}
