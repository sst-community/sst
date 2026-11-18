package aws

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/sst/sst/v3/pkg/bus"
	"github.com/sst/sst/v3/pkg/flag"
	"github.com/sst/sst/v3/pkg/project"
)

const (
	// How big a function's log gets, by default, before it's moved to
	// <name>.log.1 and started again, so each function keeps up to twice
	// this.
	defaultInvocationLogLimit int64 = 10 << 20
	// How much all the logs take together, by default, before the oldest are
	// removed, so an app with hundreds of functions doesn't fill the disk.
	defaultInvocationLogsTotal int64 = 1 << 30
	// How many logs are kept open at once. The others are opened again when
	// their function next prints.
	maxOpenInvocationLogs = 64
)

// fileLogger writes what each function gets, prints and returns to a log of
// its own, under the project's log folder, unless SST_DEV_INVOCATION_LOGS
// turns that off.
func fileLogger(p project.Program) {
	dir := invocationLogsDir(p)
	go removeInvocationFolders(dir)
	limit, ok := invocationLogLimit(flag.SST_DEV_INVOCATION_LOGS)
	if !ok {
		return
	}
	logInvocations(context.Background(), dir, limit, invocationLogsTotal(flag.SST_DEV_INVOCATION_LOGS_TOTAL))
}

// invocationLogLimit reads SST_DEV_INVOCATION_LOGS: off, false or 0 turns the
// logs off, and a number is the size of each log in MB. Anything else is
// warned about, and the default is used.
func invocationLogLimit(value string) (int64, bool) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "":
		return defaultInvocationLogLimit, true
	case "off", "false":
		return 0, false
	}
	if mb, err := strconv.ParseFloat(strings.TrimSpace(value), 64); err == nil && mb == 0 {
		return 0, false
	}
	return megabytes("SST_DEV_INVOCATION_LOGS", value, defaultInvocationLogLimit), true
}

// invocationLogsTotal reads SST_DEV_INVOCATION_LOGS_TOTAL, the size of all the
// logs in MB.
func invocationLogsTotal(value string) int64 {
	if strings.TrimSpace(value) == "" {
		return defaultInvocationLogsTotal
	}
	return megabytes("SST_DEV_INVOCATION_LOGS_TOTAL", value, defaultInvocationLogsTotal)
}

// The biggest size in MB that's read, 1 PB, far past any disk and far from
// overflowing a size in bytes.
const maxMegabytes = 1 << 30

// megabytes reads a size in MB, or warns and returns fallback if it's not one.
func megabytes(name, value string, fallback int64) int64 {
	mb, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
	if err != nil || !(mb > 0 && mb <= maxMegabytes) {
		slog.Warn(name+" is not a size in MB, so the default is used", "value", value, "defaultMB", fallback>>20)
		return fallback
	}
	return int64(mb * (1 << 20))
}

// invocationLogsDir is the folder of the invocation logs: .sst/log/lambda.
func invocationLogsDir(p project.Program) string {
	return filepath.Join(p.PathLog(""), "lambda")
}

// removeInvocationFolders removes what an earlier sst dev wrote to dir: a
// folder for each function, with a file for each invocation. Logs are now
// files in dir, so its folders are all from then. There can be hundreds of
// thousands of files in them, so this runs on its own. A symlink isn't a
// folder here, so what one points to is left alone.
func removeInvocationFolders(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		if !isInvocationFolder(path) {
			continue
		}
		if err := os.RemoveAll(path); err != nil {
			slog.Error("failed to remove old invocation logs", "path", path, "err", err)
		}
	}
}

// isInvocationFolder says whether a folder holds an earlier sst dev's logs of
// invocations, <time>-<request>.log with the time in Unix seconds, and nothing
// else, so a folder put there for something else, such as one of date-named
// files, is left alone. The files an OS adds to a folder that's been opened,
// as Finder's .DS_Store, don't count.
func isInvocationFolder(path string) bool {
	entries, err := os.ReadDir(path)
	if err != nil {
		return false
	}
	logs := 0
	for _, entry := range entries {
		name := entry.Name()
		if isFolderClutter(name) && !entry.IsDir() {
			continue
		}
		secs, request, ok := strings.Cut(strings.TrimSuffix(name, ".log"), "-")
		if !entry.Type().IsRegular() || !strings.HasSuffix(name, ".log") || !ok || request == "" || strings.Trim(secs, "0123456789") != "" || len(secs) < 9 || len(secs) > 10 {
			return false
		}
		logs++
	}
	return logs > 0
}

// isFolderClutter says whether a file is one an OS adds to a folder that's
// been opened: Finder's .DS_Store, the ._ files macOS writes on other volumes,
// and Windows Explorer's Thumbs.db and desktop.ini.
func isFolderClutter(name string) bool {
	switch name {
	case ".DS_Store", "Thumbs.db", "desktop.ini":
		return true
	}
	return strings.HasPrefix(name, "._")
}

// isRotatedLog says whether a file in the logs folder is a log moved aside:
// <name>.log.1, as sst dev moves it, or <name>.log.<n>, as by a tool that
// rotates logs.
func isRotatedLog(name string) bool {
	i := strings.LastIndex(name, ".log.")
	if i < 0 {
		return false
	}
	n := name[i+len(".log."):]
	return n != "" && strings.Trim(n, "0123456789") == ""
}

// logInvocations writes the log of each function in dir, until ctx is done.
func logInvocations(ctx context.Context, dir string, limit, total int64) {
	evts := bus.Subscribe(&FunctionLogEvent{}, &FunctionInvokedEvent{}, &FunctionResponseEvent{}, &FunctionErrorEvent{})
	defer bus.Unsubscribe(evts)
	logs := newInvocationLogs(dir, limit, total)
	defer logs.close()
	for {
		select {
		case <-ctx.Done():
			return
		case evt := <-evts:
			logs.handle(evt)
		}
	}
}

// invocationLogs appends what each function gets, prints and returns to
// <dir>/<function>.log, a line for each, so a function's log can be followed
// with tail -f and a request found with grep. Invocations that run at once
// write to the same log, so each line starts with its time and request ID:
//
//	2026-11-16T12:00:00.123Z r1 invoked {"a":1}
//	2026-11-16T12:00:00.200Z r1 | hello
//	2026-11-16T12:00:00.456Z r1 responded "ok"
//
// What a function prints outside an invocation has - for its request ID.
//
// Once a log is past limit, it's moved to <function>.log.1, replacing an
// older one, and started again. Once all the logs, those of an earlier sst
// dev included, are past total, the oldest .log.1 files are removed, and then
// the logs written least recently, until they're under it again. Only the most recently
// written logs are kept open.
type invocationLogs struct {
	dir   string
	limit int64
	total int64
	open  map[string]*openLog
	// the size of each log in dir, by path, and the time each .log.1 was
	// made, and their sum
	sizes   map[string]int64
	rotated map[string]time.Time
	// the write each log was last added to by, from writes, and when each log
	// of an earlier sst dev was last written, to remove the oldest first
	written  map[string]uint64
	modified map[string]time.Time
	// the logs found in dir, by their path lowercased
	existing map[string]string
	// the path of each function's log, and the function of each path,
	// lowercased, as two IDs can differ only in case on a disk that ignores
	// it, as macOS's and Windows' do by default
	paths  map[string]string
	owners map[string]string
	size   int64
	// counts writes, to find the log written to least recently
	writes uint64
	now    func() time.Time
}

type openLog struct {
	file *os.File
	used uint64
	// when it was last found to still be the file at its path
	checked time.Time
}

func newInvocationLogs(dir string, limit, total int64) *invocationLogs {
	l := &invocationLogs{
		dir:     dir,
		limit:   limit,
		total:   total,
		open:    map[string]*openLog{},
		sizes:   map[string]int64{},
		rotated: map[string]time.Time{},
		written: map[string]uint64{},
		paths:   map[string]string{},
		// the two below are set from what's in dir
		modified: map[string]time.Time{},
		existing: map[string]string{},
		owners:   map[string]string{},
		now:      time.Now,
	}
	entries, _ := os.ReadDir(dir)
	for _, entry := range entries {
		name := entry.Name()
		if !entry.Type().IsRegular() || !(strings.HasSuffix(name, ".log") || isRotatedLog(name)) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		path := filepath.Join(dir, name)
		l.sizes[path] = info.Size()
		l.size += info.Size()
		if isRotatedLog(name) {
			l.rotated[path] = info.ModTime()
		} else {
			l.modified[path] = info.ModTime()
			l.existing[strings.ToLower(path)] = path
		}
	}
	return l
}

func (l *invocationLogs) handle(evt interface{}) {
	switch evt := evt.(type) {
	case *FunctionInvokedEvent:
		l.write(evt.FunctionID, evt.RequestID, "invoked", string(evt.Input))
	case *FunctionLogEvent:
		l.write(evt.FunctionID, evt.RequestID, "|", evt.Line)
	case *FunctionResponseEvent:
		l.write(evt.FunctionID, evt.RequestID, "responded", string(evt.Output))
	case *FunctionErrorEvent:
		// a worker that fails to start, as when its build fails, has a
		// message and no type
		text := evt.ErrorMessage
		if evt.ErrorType != "" {
			text = evt.ErrorType + ": " + text
		}
		// Node's trace starts with the error, which is already there
		trace := evt.Trace
		if lines := strings.Count(text, "\n") + 1; len(trace) >= lines && strings.Join(trace[:lines], "\n") == text {
			trace = trace[lines:]
		}
		if len(trace) > 0 {
			text += "\n" + strings.Join(trace, "\n")
		}
		l.write(evt.FunctionID, evt.RequestID, "failed", text)
	}
}

// write adds text to a function's log, a line for each of its lines.
func (l *invocationLogs) write(functionID, requestID, kind, text string) {
	if requestID == "" {
		requestID = "-"
	}
	prefix := l.now().UTC().Format("2006-01-02T15:04:05.000Z") + " " + requestID + " " + kind
	// an empty line, as from console.log(""), is kept as a bare prefix, so the
	// log shows where it was
	var b strings.Builder
	for _, line := range strings.Split(strings.TrimRight(text, "\r\n"), "\n") {
		b.WriteString(prefix)
		if line = strings.TrimRight(line, "\r"); line != "" {
			b.WriteByte(' ')
			b.WriteString(line)
		}
		b.WriteByte('\n')
	}
	path := l.logPath(functionID)
	file := l.file(path)
	// an event bigger than the limit on its own is added first and moved with
	// the log after, below, so the .log.1 before it isn't replaced twice
	if file != nil && l.sizes[path] > 0 && l.sizes[path]+int64(b.Len()) > l.limit && int64(b.Len()) <= l.limit {
		l.rotate(path)
		file = l.file(path)
	}
	if file == nil {
		return
	}
	n, err := file.WriteString(b.String())
	l.grow(path, int64(n))
	if n > 0 {
		l.written[path] = l.writes
	}
	if err != nil {
		slog.Error("failed to write invocation log", "path", path, "err", err)
	}
	// one event bigger than the limit, as a big payload, is moved on its own
	if l.sizes[path] > l.limit {
		l.rotate(path)
	}
	if l.size > l.total {
		l.shrink(path)
	}
}

// logPath is the path of a function's log. Its ID is a name in the app, which
// can have characters a file name can't: a separator would put the log in a
// folder, which the next sst dev would take to be an old one and remove, and
// Windows refuses others, or drops them from the end of a name, as spaces and
// dots. Those characters are escaped as %XX, % included, so no two IDs share a
// log over them. Windows' reserved names, such as CON, aren't handled; the
// names sst gives functions aren't those.
//
// Two IDs that differ only in case would share a log on a disk that ignores
// case, so the second of them seen, in this sst dev or as a log an earlier one
// left, gets a log of its own, named with a hash of its ID.
func (l *invocationLogs) logPath(functionID string) string {
	if path, ok := l.paths[functionID]; ok {
		return path
	}
	path := filepath.Join(l.dir, escapeLogName(functionID)+".log")
	key := strings.ToLower(path)
	owner, taken := l.owners[key]
	taken = taken && owner != functionID
	if found, ok := l.existing[key]; ok && found != path {
		taken, owner = true, filepath.Base(found)
	}
	if taken {
		sum := sha256.Sum256([]byte(functionID))
		path = filepath.Join(l.dir, escapeLogName(functionID)+"~"+hex.EncodeToString(sum[:4])+".log")
		slog.Warn("two functions' IDs differ only in case, so one has a log named with a hash", "functionID", functionID, "other", owner, "path", path)
		key = strings.ToLower(path)
	}
	l.owners[key] = functionID
	l.paths[functionID] = path
	return path
}

// escapeLogName escapes the characters a file name can't hold, as %XX, and the
// spaces and dots it ends with, which Windows drops.
func escapeLogName(functionID string) string {
	end := len(strings.TrimRight(functionID, " ."))
	var name strings.Builder
	for i := 0; i < len(functionID); i++ {
		c := functionID[i]
		if c < 0x20 || i >= end || strings.IndexByte(`%/\:*?"<>|`, c) >= 0 {
			fmt.Fprintf(&name, "%%%02X", c)
		} else {
			name.WriteByte(c)
		}
	}
	return name.String()
}

// file returns the log at path, opened to add to if it's not open, and the
// log written to least recently closed if too many are. Once a second, an
// open log is checked to still be the file at its path, and opened again if
// it's not, so its lines aren't lost when it's removed or moved, as with rm
// or a tool that rotates logs.
func (l *invocationLogs) file(path string) *os.File {
	l.writes++
	if log, ok := l.open[path]; ok {
		log.used = l.writes
		if now := l.now(); now.Sub(log.checked) >= time.Second {
			log.checked = now
			if l.isFileAt(log.file, path) {
				return log.file
			}
			l.closeLog(path)
			// moved, as by a tool that rotates logs, which may have shifted its
			// other rotations too
			l.recountRotations(path)
		} else {
			return log.file
		}
	}
	if len(l.open) >= maxOpenInvocationLogs {
		oldest := ""
		for p, log := range l.open {
			if oldest == "" || log.used < l.open[oldest].used {
				oldest = p
			}
		}
		l.closeLog(oldest)
	}
	if err := os.MkdirAll(l.dir, 0755); err != nil {
		slog.Error("failed to make invocation log folder", "path", l.dir, "err", err)
		return nil
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		slog.Error("failed to open invocation log", "path", path, "err", err)
		return nil
	}
	l.open[path] = &openLog{file: file, used: l.writes, checked: l.now()}
	// counted from what's there, as the file may have changed since it was
	// last open
	var size int64
	if info, err := file.Stat(); err == nil {
		size = info.Size()
	}
	l.size += size - l.sizes[path]
	l.sizes[path] = size
	return file
}

// recount counts the size of the file at path from what's on disk, as it may
// have been changed outside sst dev.
func (l *invocationLogs) recount(path string) {
	info, err := os.Stat(path)
	if err != nil {
		l.size -= l.sizes[path]
		delete(l.sizes, path)
		delete(l.rotated, path)
		delete(l.written, path)
		delete(l.modified, path)
		return
	}
	l.size += info.Size() - l.sizes[path]
	l.sizes[path] = info.Size()
	if _, ok := l.rotated[path]; !ok && isRotatedLog(filepath.Base(path)) {
		l.rotated[path] = info.ModTime()
	}
}

// recountRotations counts the rotations of the log at path, <path>.<n>, from
// what's on disk, those added and those gone included.
func (l *invocationLogs) recountRotations(path string) {
	prefix := filepath.Base(path) + "."
	found := map[string]bool{}
	entries, _ := os.ReadDir(l.dir)
	for _, entry := range entries {
		if name := entry.Name(); strings.HasPrefix(name, prefix) && isRotatedLog(name) && entry.Type().IsRegular() {
			found[filepath.Join(l.dir, name)] = true
		}
	}
	for tracked := range l.sizes {
		if strings.HasPrefix(filepath.Base(tracked), prefix) && isRotatedLog(filepath.Base(tracked)) {
			found[tracked] = true
		}
	}
	for rotation := range found {
		l.recount(rotation)
	}
}

// isFileAt says whether file is still the one at path.
// Its size is counted again from what's there, as it may have been emptied in
// place, as with > Fn.log.
func (l *invocationLogs) isFileAt(file *os.File, path string) bool {
	opened, err := file.Stat()
	if err != nil {
		return false
	}
	current, err := os.Stat(path)
	if err != nil || !os.SameFile(opened, current) {
		return false
	}
	l.size += opened.Size() - l.sizes[path]
	l.sizes[path] = opened.Size()
	return true
}

func (l *invocationLogs) closeLog(path string) {
	if log, ok := l.open[path]; ok {
		log.file.Close()
		delete(l.open, path)
	}
}

// grow counts n more bytes in the file at path.
func (l *invocationLogs) grow(path string, n int64) {
	l.sizes[path] += n
	l.size += n
}

// remove removes the file at path, closing it first, as Windows can't remove
// an open file.
func (l *invocationLogs) remove(path string) {
	l.closeLog(path)
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		slog.Error("failed to remove invocation log", "path", path, "err", err)
	}
	l.size -= l.sizes[path]
	delete(l.sizes, path)
	delete(l.rotated, path)
	delete(l.written, path)
	delete(l.modified, path)
}

// rotate moves a log to <path>.1, replacing an older one, so it's started
// again when it's next written. It's closed before it's moved, as Windows
// can't move an open file. If it can't be moved, it's removed, so the cap
// holds.
func (l *invocationLogs) rotate(path string) {
	l.closeLog(path)
	l.remove(path + ".1")
	if err := os.Rename(path, path+".1"); err != nil {
		slog.Error("failed to rotate invocation log", "path", path, "err", err)
		l.remove(path)
		return
	}
	l.sizes[path+".1"] = l.sizes[path]
	l.rotated[path+".1"] = l.now()
	delete(l.sizes, path)
}

// shrink removes the oldest rotated logs, and then the logs written least
// recently, those of an earlier sst dev first and oldest first, until all of
// them are under the total again. So what's removed is always the oldest
// history. current, the log just written, is never removed, so with a total
// smaller than one log, that log is kept on its own, within the limit.
func (l *invocationLogs) shrink(current string) {
	old := []string{}
	for path := range l.rotated {
		old = append(old, path)
	}
	slices.SortFunc(old, func(a, b string) int { return l.rotated[a].Compare(l.rotated[b]) })
	for _, path := range old {
		if l.size <= l.total {
			return
		}
		l.remove(path)
	}
	for l.size > l.total {
		oldest := ""
		for path, size := range l.sizes {
			if size == 0 || path == current {
				continue
			}
			if oldest == "" || l.olderThan(path, oldest) {
				oldest = path
			}
		}
		if oldest == "" {
			return
		}
		l.remove(oldest)
	}
}

// olderThan says whether the log at a was last written before the one at b:
// in this sst dev by the order of writes, and before it by when they were
// last changed, by name when they tie.
func (l *invocationLogs) olderThan(a, b string) bool {
	if l.written[a] != l.written[b] {
		return l.written[a] < l.written[b]
	}
	if c := l.modified[a].Compare(l.modified[b]); c != 0 {
		return c < 0
	}
	return a < b
}

func (l *invocationLogs) close() {
	for path := range l.open {
		l.closeLog(path)
	}
}
