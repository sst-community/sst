package watcher

import (
	"context"
	"io/fs"
	"log/slog"
	"os"
	pathpkg "path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/sst/sst/v3/pkg/bus"
	"github.com/sst/sst/v3/pkg/project"
)

type FileChangedEvent struct {
	Path string
}

type WatchConfig struct {
	Root  string
	Watch project.Watch
}

// changeLimiter publishes at most one change per file in each window. The
// first change is published at once. Changes during the window are folded
// into one more publish when it ends, so a quick second save isn't lost. That
// one is skipped when the file's size and modification time are what they
// were at the last publish: FSEvents can report one write as a create and
// then a modify, and that shouldn't rebuild twice. This relies on the
// modification time changing with each save, as it does with the nanosecond
// times of APFS and ext4. Where times are coarser, like some network mounts,
// a second save of the same size within the window isn't published; before
// the limiter folded changes in, any second save within the window was
// dropped. A file the walk discovered is only published once per window.
//
// A file whose window has passed with nothing pending is forgotten, as its
// next change is published at once either way, so files holds only those
// changed in about the last window, not every file changed in the session.
type changeLimiter struct {
	mu      sync.Mutex
	window  time.Duration
	files   map[string]fileChange
	publish func(path string)
	closed  bool
	// when files was last swept of the files it can forget
	swept time.Time
}

type fileChange struct {
	timestamp time.Time
	stamp     fileStamp
	pending   bool
}

type fileStamp struct {
	exists bool
	size   int64
	mod    int64
}

func newChangeLimiter(window time.Duration, publish func(path string)) *changeLimiter {
	return &changeLimiter{window: window, files: map[string]fileChange{}, publish: publish}
}

func stampOf(path string) fileStamp {
	info, err := os.Stat(path)
	if err != nil {
		return fileStamp{}
	}
	return fileStamp{exists: true, size: info.Size(), mod: info.ModTime().UnixNano()}
}

func (l *changeLimiter) change(path string, discovered bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return
	}

	now := time.Now()
	if now.Sub(l.swept) > l.window {
		l.swept = now
		for p, f := range l.files {
			if !f.pending && now.Sub(f.timestamp) > l.window {
				delete(l.files, p)
			}
		}
	}
	last, ok := l.files[path]
	if !ok || now.Sub(last.timestamp) > l.window {
		l.files[path] = fileChange{timestamp: now, stamp: stampOf(path)}
		l.publish(path)
		return
	}
	if discovered || last.pending {
		return
	}
	last.pending = true
	l.files[path] = last
	time.AfterFunc(last.timestamp.Add(l.window).Sub(now), func() { l.flush(path) })
}

func (l *changeLimiter) flush(path string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	last, ok := l.files[path]
	if l.closed || !ok || !last.pending {
		return
	}

	last.pending = false
	stamp := stampOf(path)
	if stamp == last.stamp {
		l.files[path] = last
		return
	}
	l.files[path] = fileChange{timestamp: time.Now(), stamp: stamp}
	l.publish(path)
}

// close stops publishing, including from a window still waiting to end, so a
// watcher that has stopped publishes nothing more.
func (l *changeLimiter) close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.closed = true
}

// hasGlobMeta reports whether a watch.paths entry is a glob, which only the
// legacy array form expands.
func hasGlobMeta(path string) bool {
	return strings.ContainsAny(path, "*?[")
}

// listedRoots resolves the watch.paths entries written out without a glob.
// skipDir watches these even when they are hidden or named node_modules. A
// legacy array glob such as "*" can match node_modules or .git, and those
// stay skipped.
func listedRoots(root string, watch project.Watch) ([]string, error) {
	var paths []string
	for _, path := range watch.Paths {
		if !hasGlobMeta(path) {
			paths = append(paths, path)
		}
	}
	if len(paths) == 0 {
		return nil, nil
	}
	return resolvePaths(root, paths, watch.UsesLegacyArray())
}

// resolvePaths turns watch.paths entries into the directories to walk, for
// both resolveWatch and listedRoots: it expands the legacy array form, then
// resolves each entry against root. With no entries it returns root.
func resolvePaths(root string, paths []string, legacy bool) ([]string, error) {
	root = filepath.Clean(root)
	if legacy {
		var err error
		paths, err = expandLegacyPaths(root, paths)
		if err != nil {
			return nil, err
		}
	}
	return resolveRoots(root, paths)
}

func resolveWatch(root string, watch project.Watch) ([]string, []string, error) {
	roots, err := resolvePaths(root, watch.Paths, watch.UsesLegacyArray())
	if err != nil {
		return nil, nil, err
	}

	ignore := make([]string, 0, len(watch.Ignore))
	for _, path := range watch.Ignore {
		ignore = append(ignore, normalizePath(path))
	}

	return roots, ignore, nil
}

func expandLegacyPaths(root string, paths []string) ([]string, error) {
	expanded := make([]string, 0, len(paths))
	seen := map[string]bool{}
	for _, path := range paths {
		matches := []string{path}
		if hasGlobMeta(path) {
			resolved, err := filepath.Glob(filepath.Join(root, filepath.FromSlash(path)))
			if err != nil {
				return nil, err
			}
			matches = nil
			for _, match := range resolved {
				watchPath, err := legacyWatchPath(root, match)
				if err != nil {
					return nil, err
				}
				matches = append(matches, watchPath)
			}
		}

		for _, match := range matches {
			match = filepath.ToSlash(filepath.Clean(match))
			if seen[match] {
				continue
			}
			seen[match] = true
			expanded = append(expanded, match)
		}
	}

	return expanded, nil
}

func legacyWatchPath(root string, path string) (string, error) {
	resolved := path
	if !filepath.IsAbs(resolved) {
		resolved = filepath.Join(root, filepath.FromSlash(path))
	}

	info, err := os.Stat(resolved)
	if err == nil && !info.IsDir() {
		resolved = filepath.Dir(resolved)
	}
	if err != nil && !os.IsNotExist(err) {
		return "", err
	}

	rel, err := filepath.Rel(root, resolved)
	if err != nil {
		return "", err
	}

	return filepath.ToSlash(rel), nil
}

func resolveRoots(root string, paths []string) ([]string, error) {
	if len(paths) == 0 {
		paths = []string{"."}
	}

	seen := map[string]bool{}
	var roots []string

	for _, path := range paths {
		resolved := filepath.Clean(filepath.Join(root, filepath.FromSlash(path)))
		if seen[resolved] {
			continue
		}

		info, err := os.Stat(resolved)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, err
		}

		if !info.IsDir() {
			continue
		}

		seen[resolved] = true
		roots = append(roots, resolved)
	}

	return roots, nil
}

// dirEntry is the part of os.FileInfo and fs.DirEntry that shouldSkipDir needs.
type dirEntry interface {
	Name() string
	IsDir() bool
}

// skippedByName holds the built-in rules, for the walk (skipDir) and for the
// recursive backend (inSkippedDir) alike. They skip a directory by its own
// name: hidden, or with node_modules in it, which also catches copies such as
// node_modules.old that can be as big. A directory listed by name in
// watch.paths (see listedRoots) is exempt, and so are the directories on the
// way to it, such as .config for .config/types, as the walk has to pass
// through them. Directories under a listed one aren't exempt, so a listed
// packages/api still skips its node_modules.
func skippedByName(path string, listed []string) bool {
	name := filepath.Base(path)
	if !strings.HasPrefix(name, ".") && !strings.Contains(name, "node_modules") {
		return false
	}
	for _, r := range listed {
		if isWithinPath(path, r) {
			return false
		}
	}
	return true
}

// shouldSkipDir is skipDir with nothing listed in watch.paths.
func shouldSkipDir(root string, ignore []string, path string, info dirEntry) bool {
	return skipDir(root, nil, ignore, path, info)
}

func isIgnored(root string, ignore []string, path string) bool {
	if len(ignore) == 0 {
		return false
	}

	rel, err := filepath.Rel(root, path)
	if err != nil {
		return false
	}

	rel = normalizePath(rel)
	for _, prefix := range ignore {
		if matchesIgnore(prefix, rel) {
			return true
		}
	}

	return false
}

func matchesIgnore(pattern string, path string) bool {
	if pattern == "." {
		return true
	}

	if strings.Contains(pattern, "/") {
		return path == pattern || strings.HasPrefix(path, pattern+"/")
	}

	for part := range strings.SplitSeq(path, "/") {
		matched, err := pathpkg.Match(pattern, part)
		if err == nil && matched {
			return true
		}
	}

	return false
}

// skipDir reports whether the walk and the event loop skip a directory: by
// the built-in rules (skippedByName), or by watch.ignore, which applies to
// listed paths too. The walk skips a directory before entering it, so nothing
// below one is reached. The project root itself is always watched, whatever
// it or the directories above it are called. On the way to a listed path,
// shouldWatchDir still prunes everything else, so .config/other isn't watched
// for a listed .config/types.
func skipDir(root string, listed []string, ignore []string, path string, info dirEntry) bool {
	if !info.IsDir() {
		return false
	}
	if filepath.Clean(path) != filepath.Clean(root) && skippedByName(path, listed) {
		return true
	}
	return isIgnored(root, ignore, path)
}

func isWatchedPath(roots []string, path string) bool {
	for _, root := range roots {
		if isWithinPath(root, path) {
			return true
		}
	}

	return false
}

func shouldWatchDir(projectRoot string, roots []string, path string) bool {
	if filepath.Clean(path) == filepath.Clean(projectRoot) {
		return true
	}
	if isWatchedPath(roots, path) {
		return true
	}
	if !isWithinPath(projectRoot, path) {
		return false
	}

	for _, root := range roots {
		if isWithinPath(path, root) {
			return true
		}
	}

	return false
}

func normalizePath(path string) string {
	path = filepath.ToSlash(filepath.Clean(path))
	if path == "./" {
		return "."
	}
	return strings.TrimPrefix(path, "./")
}

func Start(ctx context.Context, config WatchConfig) error {
	log := slog.Default().With("service", "watcher")
	log.Info("starting", "root", config.Root)
	defer log.Info("done")

	roots, ignore, err := resolveWatch(config.Root, config.Watch)
	if err != nil {
		return err
	}
	listed, err := listedRoots(config.Root, config.Watch)
	if err != nil {
		return err
	}

	// The project root plus any watched path outside it. A recursive backend
	// watches these trees whole; a per-directory backend walks them.
	trees := []string{filepath.Clean(config.Root)}
	for _, match := range roots {
		if !isWithinPath(config.Root, match) {
			trees = append(trees, match)
		}
	}

	headFile := filepath.Join(config.Root, ".git/HEAD")
	b, err := newBackend(trees, roots, listed, headFile, log)
	if err != nil {
		return err
	}
	defer b.Close()
	log.Info("watching", "backend", b.Name(), "recursive", b.Recursive())

	limiter := newChangeLimiter(500*time.Millisecond, func(path string) {
		bus.Publish(&FileChangedEvent{Path: path})
	})
	defer limiter.close()
	publishChange := limiter.change

	// watchTree walks a directory tree. It adds each directory to a
	// per-directory backend, and when publish is set it reports the files it
	// finds, which covers a directory that is created or moved in with files
	// already inside it. WalkDir reads entry types from the directory listing,
	// so it doesn't stat every file.
	watchTree := func(path string, publish bool) error {
		return filepath.WalkDir(path, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				if os.IsNotExist(err) {
					return nil
				}
				return err
			}

			if d.IsDir() {
				if skipDir(config.Root, listed, ignore, path, d) {
					return filepath.SkipDir
				}
				if !shouldWatchDir(config.Root, roots, path) {
					return filepath.SkipDir
				}
				if b.Recursive() {
					return nil
				}

				log.Info("watching", "path", path)
				return b.Add(path)
			}

			if publish && isWatchedPath(roots, path) && !isIgnored(config.Root, ignore, path) {
				log.Info("discovered new file in directory", "path", path)
				publishChange(path, true)
			}

			return nil
		})
	}

	if !b.Recursive() {
		if err := b.Add(config.Root); err != nil {
			return err
		}
		for _, tree := range trees {
			if err := watchTree(tree, false); err != nil {
				return err
			}
		}
		b.Add(headFile)
	}

	return watchLoop(ctx, b.Events(), b.Errors(), log, config.Root, roots, listed, ignore, watchTree, publishChange)
}

// watchLoop runs the fsnotify event loop. It drains both the Events and
// Errors channels: in fsnotify v1.7.0 the Errors channel is unbuffered, so
// an unread error blocks the reader goroutine and silently stops delivery
// of all further events.
func watchLoop(
	ctx context.Context,
	events <-chan fsnotify.Event,
	errs <-chan error,
	log *slog.Logger,
	root string,
	roots []string,
	listed []string,
	ignore []string,
	watchTree func(path string, publish bool) error,
	publishChange func(path string, discovered bool),
) error {
	for {
		select {
		case event, ok := <-events:
			if !ok {
				return nil
			}
			if event.Op&(fsnotify.Write|fsnotify.Create) == 0 {
				log.Info("ignoring file event", "path", event.Name, "op", event.Op)
				continue
			}
			if event.Op&fsnotify.Create != 0 {
				info, err := os.Stat(event.Name)
				if err != nil && !os.IsNotExist(err) {
					return err
				}
				if err == nil && info.IsDir() {
					if skipDir(root, listed, ignore, event.Name, info) || !shouldWatchDir(root, roots, event.Name) {
						log.Info("ignoring created directory", "path", event.Name)
						continue
					}

					err = watchTree(event.Name, true)
					if err != nil {
						return err
					}

					// Catch nested dirs/files created while fsnotify attaches to the new dir.
					select {
					case <-time.After(50 * time.Millisecond):
					case <-ctx.Done():
						return nil
					}
					err = watchTree(event.Name, true)
					if err != nil {
						return err
					}
					continue
				}
			}
			if !isWatchedPath(roots, event.Name) {
				log.Info("ignoring unwatched file event", "path", event.Name, "op", event.Op)
				continue
			}
			if isIgnored(root, ignore, event.Name) {
				log.Info("ignoring ignored file event", "path", event.Name, "op", event.Op)
				continue
			}
			log.Info("file event", "path", event.Name, "op", event.Op)
			publishChange(event.Name, false)
		case err, ok := <-errs:
			if !ok {
				return nil
			}
			// Drain the error channel. fsnotify's sendError blocks until the
			// error is read, so leaving it unread wedges the reader goroutine
			// and silently stops all further events.
			log.Error("watcher error", "err", err)
		case <-ctx.Done():
			return nil
		}
	}
}

func isWithinPath(root string, path string) bool {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return false
	}

	rel = normalizePath(rel)
	return rel == "." || (!strings.HasPrefix(rel, "../") && rel != "..")
}

// inSkippedDir reports whether path is inside a directory the per-directory
// walk never enters, for the recursive backend, which watches whole trees.
// It applies skippedByName to each directory between tree and path, as the
// walk does from the root down; tree itself is always watched. watch.ignore
// is left to the loop.
func inSkippedDir(tree string, listed []string, path string) bool {
	tree = filepath.Clean(tree)
	for dir := filepath.Dir(filepath.Clean(path)); dir != tree && isWithinPath(tree, dir); dir = filepath.Dir(dir) {
		if skippedByName(dir, listed) {
			return true
		}
	}
	return false
}
