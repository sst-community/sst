package aws

import (
	"context"
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
func fileLogger(p *project.Project) {
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
	case "off", "false", "0":
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
func invocationLogsDir(p *project.Project) string {
	return filepath.Join(p.PathLog(""), "lambda")
}

// removeInvocationFolders removes what an earlier sst dev wrote to dir: a
// folder for each function, with a file for each invocation. Logs are now
// files in dir, so its folders are all from then. There can be hundreds of
// thousands of files in them, so this runs on its own.
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
		if err := os.RemoveAll(path); err != nil {
			slog.Error("failed to remove old invocation logs", "path", path, "err", err)
		}
	}
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
// the biggest logs, until they're under it again. Only the most recently
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
	size    int64
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
		now:     time.Now,
	}
	entries, _ := os.ReadDir(dir)
	for _, entry := range entries {
		name := entry.Name()
		if !entry.Type().IsRegular() || !(strings.HasSuffix(name, ".log") || strings.HasSuffix(name, ".log.1")) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		path := filepath.Join(dir, name)
		l.sizes[path] = info.Size()
		l.size += info.Size()
		if strings.HasSuffix(name, ".1") {
			l.rotated[path] = info.ModTime()
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
		if len(trace) > 0 && trace[0] == text {
			trace = trace[1:]
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
	if file != nil && l.sizes[path] > 0 && l.sizes[path]+int64(b.Len()) > l.limit {
		l.rotate(path)
		file = l.file(path)
	}
	if file == nil {
		return
	}
	n, err := file.WriteString(b.String())
	l.grow(path, int64(n))
	if err != nil {
		slog.Error("failed to write invocation log", "path", path, "err", err)
	}
	if l.size > l.total {
		l.shrink()
	}
}

// logPath is the path of a function's log. Its ID is a name in the app, but
// a separator in it would put the log in a folder, which the next sst dev
// would take to be an old one and remove.
func (l *invocationLogs) logPath(functionID string) string {
	name := strings.NewReplacer("/", "_", "\\", "_").Replace(functionID)
	return filepath.Join(l.dir, name+".log")
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
			// moved, as by a tool that rotates logs, maybe to <path>.1
			l.recount(path + ".1")
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
		return
	}
	l.size += info.Size() - l.sizes[path]
	l.sizes[path] = info.Size()
	if _, ok := l.rotated[path]; !ok && strings.HasSuffix(path, ".1") {
		l.rotated[path] = info.ModTime()
	}
}

// isFileAt says whether file is still the one at path.
func (l *invocationLogs) isFileAt(file *os.File, path string) bool {
	opened, err := file.Stat()
	if err != nil {
		return false
	}
	current, err := os.Stat(path)
	return err == nil && os.SameFile(opened, current)
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

// shrink removes the oldest .log.1 files, and then empties the biggest logs,
// until all of them are under the total again.
func (l *invocationLogs) shrink() {
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
		biggest := ""
		for path, size := range l.sizes {
			if biggest == "" || size > l.sizes[biggest] {
				biggest = path
			}
		}
		if biggest == "" || l.sizes[biggest] == 0 {
			return
		}
		l.remove(biggest)
	}
}

func (l *invocationLogs) close() {
	for path := range l.open {
		l.closeLog(path)
	}
}
