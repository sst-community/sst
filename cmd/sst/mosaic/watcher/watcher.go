package watcher

import (
	"context"
	"log/slog"
	"os"
	pathpkg "path"
	"path/filepath"
	"strings"
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

type fileChange struct {
	timestamp  time.Time
	discovered bool
}

// listedRoots resolves the watch.paths entries written out without a glob.
// skipDir watches these even when they are hidden or named node_modules. A
// legacy array glob such as "*" can match node_modules or .git, and those
// stay skipped.
func listedRoots(root string, watch project.Watch) ([]string, error) {
	var paths []string
	for _, path := range watch.Paths {
		if !strings.ContainsAny(path, "*?[") {
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
		if strings.ContainsAny(path, "*?[") {
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

func shouldSkipDir(root string, ignore []string, path string, info os.FileInfo) bool {
	if !info.IsDir() {
		return false
	}

	// The built-in rules skip hidden and node_modules directories by the
	// directory's own name, as internal/fs does. The walk skips such a
	// directory before entering it, so nothing below one is reached. The
	// project root itself is always watched, whatever it or the directories
	// above it are called, and skipDir exempts the paths listed by name in
	// watch.paths.
	if filepath.Clean(path) != filepath.Clean(root) {
		name := info.Name()
		if strings.HasPrefix(name, ".") || name == "node_modules" {
			return true
		}
	}

	return isIgnored(root, ignore, path)
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

// skipDir is shouldSkipDir for the walk and the event loop. A directory
// listed by name in watch.paths (see listedRoots) is watched even when it is
// hidden or named node_modules, and so are the directories on the way to it,
// such as .config for .config/types: the walk has to pass through them.
// shouldWatchDir still prunes everything else under those, so .config/other
// isn't watched. watch.ignore still applies.
func skipDir(root string, listed []string, ignore []string, path string, info os.FileInfo) bool {
	if !info.IsDir() {
		return false
	}
	for _, r := range listed {
		if isWithinPath(path, r) {
			return isIgnored(root, ignore, path)
		}
	}
	return shouldSkipDir(root, ignore, path, info)
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
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	defer watcher.Close()

	err = watcher.AddWith(config.Root)
	if err != nil {
		return err
	}

	limiter := map[string]fileChange{}

	publishChange := func(path string, discovered bool) {
		last, ok := limiter[path]
		if ok && time.Since(last.timestamp) <= 500*time.Millisecond {
			if discovered || !last.discovered {
				return
			}
		}

		limiter[path] = fileChange{timestamp: time.Now(), discovered: discovered}
		bus.Publish(&FileChangedEvent{Path: path})
	}

	watchTree := func(path string, publish bool) error {
		return filepath.Walk(path, func(path string, info os.FileInfo, err error) error {
			if err != nil {
				if os.IsNotExist(err) {
					return nil
				}
				return err
			}

			if info.IsDir() {
				if skipDir(config.Root, listed, ignore, path, info) {
					return filepath.SkipDir
				}
				if !shouldWatchDir(config.Root, roots, path) {
					return filepath.SkipDir
				}

				log.Info("watching", "path", path)
				return watcher.Add(path)
			}

			if publish && isWatchedPath(roots, path) && !isIgnored(config.Root, ignore, path) {
				log.Info("discovered new file in directory", "path", path)
				publishChange(path, true)
			}

			return nil
		})
	}

	err = watchTree(config.Root, false)
	if err != nil {
		return err
	}

	for _, match := range roots {
		if isWithinPath(config.Root, match) {
			continue
		}
		err = watchTree(match, false)
		if err != nil {
			return err
		}
	}

	headFile := filepath.Join(config.Root, ".git/HEAD")
	watcher.Add(headFile)
	return watchLoop(ctx, watcher.Events, watcher.Errors, log, config.Root, roots, listed, ignore, watchTree, publishChange)
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
