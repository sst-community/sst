package watcher

import (
	"context"
	"encoding/json"
	"errors"
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

func TestResolveWatchDefaultsToProjectRoot(t *testing.T) {
	root := t.TempDir()
	roots, ignore, err := resolveWatch(root, project.Watch{})
	require.NoError(t, err)
	assert.Equal(t, []string{root}, roots)
	assert.False(t, isIgnored(root, ignore, filepath.Join(root, "sst.config.ts")))
}

func TestResolveWatchResolvesExternalIncludeRoots(t *testing.T) {
	workspace := t.TempDir()
	root := filepath.Join(workspace, "app")
	external := filepath.Join(workspace, "external-package")
	require.NoError(t, os.MkdirAll(filepath.Join(root, "packages", "api"), 0755))
	require.NoError(t, os.MkdirAll(external, 0755))

	roots, _, err := resolveWatch(root, project.Watch{
		Paths: []string{"packages/api", "../external-package"},
	})
	require.NoError(t, err)
	assert.ElementsMatch(t, []string{filepath.Join(root, "packages", "api"), external}, roots)
}

func TestResolveWatchExpandsLegacyArrayGlobs(t *testing.T) {
	root := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(root, "packages", "api"), 0755))
	require.NoError(t, os.MkdirAll(filepath.Join(root, "packages", "web"), 0755))

	var watch project.Watch
	require.NoError(t, json.Unmarshal([]byte(`["packages/*"]`), &watch))

	roots, _, err := resolveWatch(root, watch)
	require.NoError(t, err)
	assert.ElementsMatch(t, []string{filepath.Join(root, "packages", "api"), filepath.Join(root, "packages", "web")}, roots)
}

func TestResolveWatchExpandsLegacyArrayFileGlobsToParentDirs(t *testing.T) {
	root := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(root, "src"), 0755))
	require.NoError(t, os.WriteFile(filepath.Join(root, "src", "index.ts"), []byte("export {}\n"), 0644))

	var watch project.Watch
	require.NoError(t, json.Unmarshal([]byte(`["src/*"]`), &watch))

	roots, _, err := resolveWatch(root, watch)
	require.NoError(t, err)
	assert.Equal(t, []string{filepath.Join(root, "src")}, roots)
}

func TestResolveWatchMatchesIgnorePaths(t *testing.T) {
	workspace := t.TempDir()
	root := filepath.Join(workspace, "app")
	external := filepath.Join(workspace, "external-package")
	require.NoError(t, os.MkdirAll(filepath.Join(root, "packages", "api", "generated"), 0755))
	require.NoError(t, os.MkdirAll(filepath.Join(external, "dist"), 0755))

	_, ignore, err := resolveWatch(root, project.Watch{
		Ignore: []string{"packages/api/generated", "../external-package/dist"},
	})
	require.NoError(t, err)

	generated := mustInfo(t, filepath.Join(root, "packages", "api", "generated"))
	dist := mustInfo(t, filepath.Join(external, "dist"))

	assert.True(t, shouldSkipDir(root, ignore, filepath.Join(root, "packages", "api", "generated"), generated))
	assert.True(t, shouldSkipDir(root, ignore, filepath.Join(external, "dist"), dist))
	assert.True(t, isIgnored(root, ignore, filepath.Join(root, "packages", "api", "generated", "index.ts")))
	assert.True(t, isIgnored(root, ignore, filepath.Join(external, "dist", "index.js")))
	assert.False(t, isIgnored(root, ignore, filepath.Join(root, "sst.config.ts")))
}

func TestResolveWatchMatchesIgnoreNamesAnywhere(t *testing.T) {
	root := t.TempDir()
	_, ignore, err := resolveWatch(root, project.Watch{
		Ignore: []string{".env", "*.egg-info"},
	})
	require.NoError(t, err)

	eggInfo := mustInfo(t, filepath.Join(root, "packages", "api", "foo.egg-info"))

	assert.True(t, isIgnored(root, ignore, filepath.Join(root, ".env")))
	assert.True(t, isIgnored(root, ignore, filepath.Join(root, "packages", "api", ".env")))
	assert.True(t, shouldSkipDir(root, ignore, filepath.Join(root, "packages", "api", "foo.egg-info"), eggInfo))
	assert.True(t, isIgnored(root, ignore, filepath.Join(root, "packages", "api", "foo.egg-info", "PKG-INFO")))
	assert.False(t, isIgnored(root, ignore, filepath.Join(root, "packages", "api", ".env.local")))
}

func TestResolveWatchSkipsBuiltInDirs(t *testing.T) {
	root := t.TempDir()
	_, ignore, err := resolveWatch(root, project.Watch{})
	require.NoError(t, err)

	hidden := mustInfo(t, filepath.Join(root, ".sst"))
	nodeModules := mustInfo(t, filepath.Join(root, "node_modules"))
	normal := mustInfo(t, filepath.Join(root, "src"))

	assert.True(t, shouldSkipDir(root, ignore, filepath.Join(root, ".sst"), hidden))
	assert.True(t, shouldSkipDir(root, ignore, filepath.Join(root, "node_modules"), nodeModules))
	assert.False(t, shouldSkipDir(root, ignore, filepath.Join(root, "src"), normal))
}

func TestStartDiscoversFilesInNewDirectories(t *testing.T) {
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

	path := filepath.Join(root, "src", "newpkg", "handler.go")
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0755))

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		require.NoError(t, os.WriteFile(path, []byte(time.Now().String()), 0644))
		if waitForFileChangedEvent(events, path, 200*time.Millisecond) {
			cancel()
			require.NoError(t, <-errCh)
			return
		}
		time.Sleep(50 * time.Millisecond)
	}

	t.Fatalf("expected file change for %s", path)
}

func TestStartWatchesNewDirectories(t *testing.T) {
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

	dir := filepath.Join(root, "src", "newpkg")
	require.NoError(t, os.MkdirAll(dir, 0755))

	path := filepath.Join(dir, "handler.go")
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		require.NoError(t, os.WriteFile(path, []byte(time.Now().String()), 0644))
		if waitForFileChangedEvent(events, path, 200*time.Millisecond) {
			cancel()
			require.NoError(t, <-errCh)
			return
		}
		time.Sleep(50 * time.Millisecond)
	}

	t.Fatalf("expected file change for %s", path)
}

func TestStartPicksUpImmediateEditsAfterNewFileDiscovery(t *testing.T) {
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

	dir := filepath.Join(root, "src", "newpkg")
	require.NoError(t, os.MkdirAll(dir, 0755))

	path := filepath.Join(dir, "handler.go")
	require.NoError(t, os.WriteFile(path, []byte("package newpkg\n"), 0644))
	require.True(t, waitForFileChangedEvent(events, path, 5*time.Second), "expected initial file change for %s", path)

	require.NoError(t, os.WriteFile(path, []byte("package newpkg\n\nfunc Handler() {}\n"), 0644))
	require.True(t, waitForFileChangedEvent(events, path, 1*time.Second), "expected immediate follow-up file change for %s", path)

	cancel()
	require.NoError(t, <-errCh)
}

func TestStartOnlyWatchesConfiguredPaths(t *testing.T) {
	root := t.TempDir()
	watchedDir := filepath.Join(root, "packages", "api")
	require.NoError(t, os.MkdirAll(watchedDir, 0755))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	events := bus.SubscribeAll()
	defer bus.Unsubscribe(events)

	errCh := make(chan error, 1)
	go func() {
		errCh <- Start(ctx, WatchConfig{
			Root: root,
			Watch: project.Watch{
				Paths: []string{"packages/api"},
			},
		})
	}()

	waitForWatcherReady(t, filepath.Join(watchedDir, "watcher-ready.txt"), events)

	unwatched := filepath.Join(root, "docs", "guide.md")
	require.NoError(t, os.MkdirAll(filepath.Dir(unwatched), 0755))
	require.NoError(t, os.WriteFile(unwatched, []byte("# docs\n"), 0644))
	assert.False(t, waitForFileChangedEvent(events, unwatched, 750*time.Millisecond), "did not expect file change for %s", unwatched)

	watched := filepath.Join(watchedDir, "handler.go")
	require.NoError(t, os.WriteFile(watched, []byte("package api\n"), 0644))
	require.True(t, waitForFileChangedEvent(events, watched, 5*time.Second), "expected file change for %s", watched)

	cancel()
	require.NoError(t, <-errCh)
}

func TestWatchLoopDrainsErrors(t *testing.T) {
	root := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	events := make(chan fsnotify.Event, 1)
	// Unbuffered, matching fsnotify v1.7.0's Errors channel.
	errs := make(chan error)

	// Mimic fsnotify's backend: sendError blocks until the error is read,
	// then an event follows. If the loop never reads errs, the event is
	// never delivered and the watcher silently stalls.
	go func() {
		select {
		case errs <- errors.New("boom"):
		case <-ctx.Done():
			// The test ended without the error being read; the main select
			// below reports the failure.
			return
		}
		events <- fsnotify.Event{Name: filepath.Join(root, "main.go"), Op: fsnotify.Write}
	}()

	published := make(chan string, 1)
	done := make(chan error, 1)
	go func() {
		done <- watchLoop(
			ctx, events, errs, slog.Default(), root, []string{root}, nil, nil,
			func(path string, publish bool) error { return nil },
			func(path string, discovered bool) { published <- path },
		)
	}()

	select {
	case path := <-published:
		assert.Equal(t, filepath.Join(root, "main.go"), path)
	case err := <-done:
		t.Fatalf("watchLoop returned early: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("event after an error was never delivered: Errors not drained")
	}

	cancel()
	require.NoError(t, <-done)
}

func TestWatchLoopStopsWhenErrorsCloses(t *testing.T) {
	root := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	events := make(chan fsnotify.Event)
	errs := make(chan error)

	done := make(chan error, 1)
	go func() {
		done <- watchLoop(
			ctx, events, errs, slog.Default(), root, []string{root}, nil, nil,
			func(path string, publish bool) error { return nil },
			func(path string, discovered bool) {},
		)
	}()

	close(errs)

	select {
	case err := <-done:
		require.NoError(t, err)
	case <-time.After(5 * time.Second):
		t.Fatal("watchLoop kept running after the Errors channel was closed")
	}
}

func mustInfo(t *testing.T, path string) os.FileInfo {
	t.Helper()
	require.NoError(t, os.MkdirAll(path, 0755))
	info, err := os.Stat(path)
	require.NoError(t, err)
	return info
}

func waitForWatcherReady(t *testing.T, probe string, events <-chan interface{}) {
	t.Helper()

	require.NoError(t, os.MkdirAll(filepath.Dir(probe), 0755))
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		require.NoError(t, os.WriteFile(probe, []byte(time.Now().String()), 0644))
		if waitForFileChangedEvent(events, probe, 200*time.Millisecond) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}

	t.Fatalf("timed out waiting for watcher startup")
}

func waitForFileChangedEvent(events <-chan interface{}, path string, timeout time.Duration) bool {
	deadline := time.After(timeout)
	for {
		select {
		case evt := <-events:
			changed, ok := evt.(*FileChangedEvent)
			if ok && changed.Path == path {
				return true
			}
		case <-deadline:
			return false
		}
	}
}

func TestInSkippedDir(t *testing.T) {
	root := "/repo"
	assert.True(t, inSkippedDir(root, "/repo/node_modules/pkg/index.js"))
	assert.True(t, inSkippedDir(root, "/repo/packages/api/node_modules/pkg/index.js"))
	assert.True(t, inSkippedDir(root, "/repo/.sst/types.d.ts"))
	assert.True(t, inSkippedDir(root, "/repo/.git/objects/ab/cdef"))
	// Hidden files are watched; only hidden directories are skipped.
	assert.False(t, inSkippedDir(root, "/repo/.env"))
	assert.False(t, inSkippedDir(root, "/repo/src/.env"))
	assert.False(t, inSkippedDir(root, "/repo/src/handler.ts"))
	// The tree itself may live under a hidden directory.
	assert.False(t, inSkippedDir("/home/me/.worktrees/app", "/home/me/.worktrees/app/src/handler.ts"))
}

func TestStartSkipsHiddenDirsAndNodeModules(t *testing.T) {
	root := t.TempDir()
	for _, dir := range []string{"node_modules/pkg", ".sst", "src"} {
		require.NoError(t, os.MkdirAll(filepath.Join(root, dir), 0755))
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := bus.SubscribeAll()
	defer bus.Unsubscribe(events)

	errCh := make(chan error, 1)
	go func() {
		errCh <- Start(ctx, WatchConfig{Root: root, Watch: project.Watch{}})
	}()
	waitForWatcherReady(t, filepath.Join(root, "watcher-ready.txt"), events)

	skipped := []string{
		filepath.Join(root, "node_modules", "pkg", "index.js"),
		filepath.Join(root, ".sst", "types.d.ts"),
	}
	for _, path := range skipped {
		require.NoError(t, os.WriteFile(path, []byte("x"), 0644))
	}
	watched := filepath.Join(root, "src", "handler.ts")
	require.NoError(t, os.WriteFile(watched, []byte("x"), 0644))

	seen := collectFileChangedEvents(events, 750*time.Millisecond)
	assert.True(t, seen[watched], "expected file change for %s", watched)
	for _, path := range skipped {
		assert.False(t, seen[path], "did not expect file change for %s", path)
	}

	cancel()
	require.NoError(t, <-errCh)
}

func TestStartDiscoversDirectoryMovedIn(t *testing.T) {
	workspace := t.TempDir()
	root := filepath.Join(workspace, "app")
	require.NoError(t, os.MkdirAll(root, 0755))
	outside := filepath.Join(workspace, "staging", "newpkg")
	require.NoError(t, os.MkdirAll(outside, 0755))
	require.NoError(t, os.WriteFile(filepath.Join(outside, "handler.go"), []byte("package newpkg\n"), 0644))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := bus.SubscribeAll()
	defer bus.Unsubscribe(events)

	errCh := make(chan error, 1)
	go func() {
		errCh <- Start(ctx, WatchConfig{Root: root, Watch: project.Watch{}})
	}()
	waitForWatcherReady(t, filepath.Join(root, "watcher-ready.txt"), events)

	moved := filepath.Join(root, "newpkg")
	require.NoError(t, os.Rename(outside, moved))
	path := filepath.Join(moved, "handler.go")
	require.True(t, waitForFileChangedEvent(events, path, 5*time.Second), "expected file change for %s", path)

	cancel()
	require.NoError(t, <-errCh)
}

func TestStartReportsGitHead(t *testing.T) {
	root := t.TempDir()
	head := filepath.Join(root, ".git", "HEAD")
	require.NoError(t, os.MkdirAll(filepath.Dir(head), 0755))
	require.NoError(t, os.WriteFile(head, []byte("ref: refs/heads/main\n"), 0644))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := bus.SubscribeAll()
	defer bus.Unsubscribe(events)

	errCh := make(chan error, 1)
	go func() {
		errCh <- Start(ctx, WatchConfig{Root: root, Watch: project.Watch{}})
	}()
	waitForWatcherReady(t, filepath.Join(root, "watcher-ready.txt"), events)

	// FSEvents can report the write above, made just before the stream
	// started, and the 500ms debounce then drops a second write right after.
	// Retry the write like the other tests do.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		require.NoError(t, os.WriteFile(head, []byte(time.Now().String()), 0644))
		if waitForFileChangedEvent(events, head, 200*time.Millisecond) {
			cancel()
			require.NoError(t, <-errCh)
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("expected file change for %s", head)
}

func collectFileChangedEvents(events <-chan interface{}, window time.Duration) map[string]bool {
	seen := map[string]bool{}
	deadline := time.After(window)
	for {
		select {
		case evt := <-events:
			if changed, ok := evt.(*FileChangedEvent); ok {
				seen[changed.Path] = true
			}
		case <-deadline:
			return seen
		}
	}
}

// The built-in rules apply to directories inside the project, by their own
// name. Neither the project root nor the path it lives at counts.
func TestShouldSkipDirOnlyAppliesInsideTheProject(t *testing.T) {
	roots := map[string]string{
		"node_modules above the root": filepath.Join(t.TempDir(), "node_modules-demo", "app"),
		"node_modules in the root":    filepath.Join(t.TempDir(), "node_modules-demo"),
		"hidden root":                 filepath.Join(t.TempDir(), ".dotfiles"),
		"root named node_modules":     filepath.Join(t.TempDir(), "node_modules"),
	}
	for name, root := range roots {
		t.Run(name, func(t *testing.T) {
			_, ignore, err := resolveWatch(root, project.Watch{})
			require.NoError(t, err)

			skip := func(rel string) bool {
				path := filepath.Join(root, rel)
				return shouldSkipDir(root, ignore, path, mustInfo(t, path))
			}
			assert.False(t, skip("."), "the root")
			assert.False(t, skip("src"))
			// A copy such as node_modules.old can be as big, so it's skipped
			// too, as before.
			assert.True(t, skip("node_modules.old"))
			assert.True(t, skip("my_node_modules"))
			assert.True(t, skip("node_modules"))
			assert.True(t, skip(filepath.Join("packages", "api", "node_modules")))
			assert.True(t, skip(".sst"))
		})
	}
}

func TestStartWatchesProjectWhateverItsPath(t *testing.T) {
	roots := map[string]string{
		"node_modules above the root": filepath.Join(t.TempDir(), "node_modules-demo", "app"),
		"node_modules in the root":    filepath.Join(t.TempDir(), "node_modules-demo"),
		"hidden root":                 filepath.Join(t.TempDir(), ".dotfiles"),
		"root named node_modules":     filepath.Join(t.TempDir(), "node_modules"),
	}
	for name, root := range roots {
		t.Run(name, func(t *testing.T) {
			require.NoError(t, os.MkdirAll(filepath.Join(root, "src"), 0755))

			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			events := bus.SubscribeAll()
			defer bus.Unsubscribe(events)

			errCh := make(chan error, 1)
			go func() {
				errCh <- Start(ctx, WatchConfig{Root: root, Watch: project.Watch{}})
			}()

			// waitForWatcherReady fails the test if no event ever arrives,
			// which is what happened: the whole project was skipped.
			waitForWatcherReady(t, filepath.Join(root, "src", "handler.ts"), events)

			cancel()
			require.NoError(t, <-errCh)
		})
	}
}

// A directory listed in watch.paths is watched even when it is hidden or
// named node_modules, inside the project or outside it.
func TestStartWatchesHiddenAndNodeModulesPathsListedByName(t *testing.T) {
	workspace := t.TempDir()
	root := filepath.Join(workspace, "app")
	inside := filepath.Join(root, "packages", ".generated")
	outside := filepath.Join(workspace, "shared", "node_modules")
	for _, dir := range []string{inside, outside, filepath.Join(root, ".sst")} {
		require.NoError(t, os.MkdirAll(dir, 0755))
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := bus.SubscribeAll()
	defer bus.Unsubscribe(events)

	errCh := make(chan error, 1)
	go func() {
		errCh <- Start(ctx, WatchConfig{Root: root, Watch: project.Watch{
			Paths: []string{"packages/.generated", "../shared/node_modules"},
		}})
	}()

	waitForWatcherReady(t, filepath.Join(inside, "types.ts"), events)
	waitForWatcherReady(t, filepath.Join(outside, "lib.js"), events)

	cancel()
	require.NoError(t, <-errCh)
}

func TestSkipDirHonorsIgnoreOnListedPaths(t *testing.T) {
	root := t.TempDir()
	listed := filepath.Join(root, "packages", ".generated")
	info := mustInfo(t, listed)
	roots, err := listedRoots(root, project.Watch{Paths: []string{"packages/.generated"}})
	require.NoError(t, err)
	_, ignore, err := resolveWatch(root, project.Watch{Ignore: []string{"packages/.generated"}})
	require.NoError(t, err)

	assert.False(t, skipDir(root, roots, nil, listed, info), "listed by name")
	assert.True(t, skipDir(root, roots, ignore, listed, info), "watch.ignore still wins")
	assert.True(t, skipDir(root, nil, nil, listed, info), "nothing listed: the built-in rule applies")
	// Listing the root exempts the root, not what's under it.
	assert.True(t, skipDir(root, []string{root}, nil, listed, info), "under a listed root: the built-in rule applies")
}

// Listing a directory exempts it and the directories on the way to it, not
// the ones under it: watch.paths ["."] or ["packages/api"] still skips
// node_modules and hidden directories inside.
func TestStartListedPathStillSkipsNodeModulesInside(t *testing.T) {
	for _, paths := range [][]string{{"."}, {"packages/api"}} {
		t.Run(paths[0], func(t *testing.T) {
			root := t.TempDir()
			base := filepath.Join(root, filepath.FromSlash(paths[0]))
			for _, dir := range []string{"node_modules/pkg", ".cache", "src"} {
				require.NoError(t, os.MkdirAll(filepath.Join(base, dir), 0755))
			}

			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			events := bus.SubscribeAll()
			defer bus.Unsubscribe(events)

			errCh := make(chan error, 1)
			go func() {
				errCh <- Start(ctx, WatchConfig{Root: root, Watch: project.Watch{Paths: paths}})
			}()
			waitForWatcherReady(t, filepath.Join(base, "src", "ready.ts"), events)

			skipped := []string{
				filepath.Join(base, "node_modules", "pkg", "index.js"),
				filepath.Join(base, ".cache", "x"),
			}
			for _, path := range skipped {
				require.NoError(t, os.WriteFile(path, []byte("x"), 0644))
			}
			seen := map[string]bool{}
			deadline := time.After(750 * time.Millisecond)
		collect:
			for {
				select {
				case evt := <-events:
					if changed, ok := evt.(*FileChangedEvent); ok {
						seen[changed.Path] = true
					}
				case <-deadline:
					break collect
				}
			}
			for _, path := range skipped {
				assert.False(t, seen[path], "did not expect file change for %s", path)
			}

			cancel()
			require.NoError(t, <-errCh)
		})
	}
}

// A legacy array glob can match node_modules or hidden folders. Only paths
// written out by name are exempt from the built-in rules, so those stay
// skipped, while a legacy entry written out by name is still watched.
func TestListedRootsLeavesGlobMatchesToTheBuiltInRules(t *testing.T) {
	root := t.TempDir()
	for _, dir := range []string{"node_modules", ".sst", "src", "packages/.generated"} {
		require.NoError(t, os.MkdirAll(filepath.Join(root, dir), 0755))
	}

	var watch project.Watch
	require.NoError(t, json.Unmarshal([]byte(`["*", ".*", "packages/.generated"]`), &watch))
	roots, ignore, err := resolveWatch(root, watch)
	require.NoError(t, err)
	listed, err := listedRoots(root, watch)
	require.NoError(t, err)

	// The globs do match the built-in folders...
	assert.Contains(t, roots, filepath.Join(root, "node_modules"))
	assert.Contains(t, roots, filepath.Join(root, ".sst"))
	// ...but only the entry written out by name is listed.
	assert.Equal(t, []string{filepath.Join(root, "packages", ".generated")}, listed)

	skip := func(rel string) bool {
		path := filepath.Join(root, rel)
		return skipDir(root, listed, ignore, path, mustInfo(t, path))
	}
	assert.True(t, skip("node_modules"))
	assert.True(t, skip(".sst"))
	assert.False(t, skip("src"))
	assert.False(t, skip("packages/.generated"))
}

func TestStartLegacyGlobDoesNotWatchNodeModules(t *testing.T) {
	root := t.TempDir()
	for _, dir := range []string{"node_modules/pkg", "src"} {
		require.NoError(t, os.MkdirAll(filepath.Join(root, dir), 0755))
	}
	var watch project.Watch
	require.NoError(t, json.Unmarshal([]byte(`["*"]`), &watch))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := bus.SubscribeAll()
	defer bus.Unsubscribe(events)

	errCh := make(chan error, 1)
	go func() {
		errCh <- Start(ctx, WatchConfig{Root: root, Watch: watch})
	}()
	waitForWatcherReady(t, filepath.Join(root, "src", "ready.ts"), events)

	dep := filepath.Join(root, "node_modules", "pkg", "index.js")
	require.NoError(t, os.WriteFile(dep, []byte("x"), 0644))
	assert.False(t, waitForFileChangedEvent(events, dep, 750*time.Millisecond), "node_modules matched by a glob is still skipped")

	cancel()
	require.NoError(t, <-errCh)
}

// A watch.paths entry inside the project can sit under a hidden or
// node_modules folder. The folders on the way to it are walked, but nothing
// else under them is watched.
func TestStartWatchesListedPathsUnderSkippedFolders(t *testing.T) {
	root := t.TempDir()
	for _, dir := range []string{".config/types", ".config/other", "node_modules/pkg", "node_modules/other"} {
		require.NoError(t, os.MkdirAll(filepath.Join(root, dir), 0755))
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := bus.SubscribeAll()
	defer bus.Unsubscribe(events)

	errCh := make(chan error, 1)
	go func() {
		errCh <- Start(ctx, WatchConfig{Root: root, Watch: project.Watch{
			Paths: []string{".config/types", "node_modules/pkg"},
		}})
	}()

	waitForWatcherReady(t, filepath.Join(root, ".config", "types", "env.d.ts"), events)
	waitForWatcherReady(t, filepath.Join(root, "node_modules", "pkg", "index.js"), events)

	unlisted := []string{
		filepath.Join(root, ".config", "other", "x.ts"),
		filepath.Join(root, "node_modules", "other", "index.js"),
		filepath.Join(root, ".config", "top.ts"),
	}
	for _, path := range unlisted {
		require.NoError(t, os.WriteFile(path, []byte("x"), 0644))
	}
	seen := map[string]bool{}
	deadline := time.After(750 * time.Millisecond)
collect:
	for {
		select {
		case evt := <-events:
			if changed, ok := evt.(*FileChangedEvent); ok {
				seen[changed.Path] = true
			}
		case <-deadline:
			break collect
		}
	}
	for _, path := range unlisted {
		assert.False(t, seen[path], "did not expect file change for %s", path)
	}

	cancel()
	require.NoError(t, <-errCh)
}
