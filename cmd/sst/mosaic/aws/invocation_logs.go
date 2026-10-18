package aws

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/sst/sst/v3/pkg/bus"
	"github.com/sst/sst/v3/pkg/project"
)

// How many invocation logs are kept for each function, the newest.
const invocationLogsKept = 100

// fileLogger writes what each invocation of a function gets, prints and returns
// to a file of its own, under the project's log folder.
func fileLogger(p *project.Project) {
	logInvocations(context.Background(), invocationLogsDir(p))
}

// invocationLogsDir is the folder of the invocation logs: .sst/log/lambda.
func invocationLogsDir(p *project.Project) string {
	return filepath.Join(p.PathLog(""), "lambda")
}

// logInvocations writes the log of each invocation in a folder of dir named
// after the function, until ctx is done.
func logInvocations(ctx context.Context, dir string) {
	evts := bus.Subscribe(&FunctionLogEvent{}, &FunctionInvokedEvent{}, &FunctionResponseEvent{}, &FunctionErrorEvent{})
	defer bus.Unsubscribe(evts)
	logs := newInvocationLogs(dir, invocationLogsKept)
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

// invocationLogs writes the log file of each invocation. A file is open from
// the invocation's first event until its response or error. What the function
// prints after that is added to the file without keeping it open. Only the
// newest files of each function are kept, those made in an earlier sst dev
// included, so a long session doesn't fill the disk.
type invocationLogs struct {
	dir  string
	keep int
	// the open files, and the path of each file made in this session, by
	// function and request, and the request of each of those paths
	open  map[string]*os.File
	paths map[string]string
	keys  map[string]string
	// the paths of the files kept for each function, oldest first
	kept map[string][]string
}

func newInvocationLogs(dir string, keep int) *invocationLogs {
	return &invocationLogs{
		dir:   dir,
		keep:  keep,
		open:  map[string]*os.File{},
		paths: map[string]string{},
		keys:  map[string]string{},
		kept:  map[string][]string{},
	}
}

func (l *invocationLogs) handle(evt interface{}) {
	switch evt := evt.(type) {
	case *FunctionInvokedEvent:
		l.write(evt.FunctionID, evt.RequestID, "invocation "+evt.RequestID+"\n"+string(evt.Input)+"\n", false)
	case *FunctionLogEvent:
		l.write(evt.FunctionID, evt.RequestID, evt.Line+"\n", false)
	case *FunctionResponseEvent:
		l.write(evt.FunctionID, evt.RequestID, "response "+evt.RequestID+"\n"+string(evt.Output)+"\n", true)
	case *FunctionErrorEvent:
		l.write(evt.FunctionID, evt.RequestID, evt.ErrorType+": "+evt.ErrorMessage+"\n", true)
	}
}

// write adds text to the log of a request, and closes it when the request is
// done. Output that's not part of a request has no end, so its log is closed
// after each write.
func (l *invocationLogs) write(functionID, requestID, text string, done bool) {
	if requestID == "" {
		done = true
	}
	key := functionID + "/" + requestID
	file, ok := l.open[key]
	if !ok {
		path, finished := l.paths[key]
		if !finished {
			path = l.add(functionID, key, requestID)
		}
		var err error
		file, err = os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
		if err != nil {
			slog.Error("failed to open invocation log", "path", path, "err", err)
			return
		}
		if finished {
			done = true
		} else {
			l.open[key] = file
		}
	}
	if _, err := file.WriteString(text); err != nil {
		slog.Error("failed to write invocation log", "path", file.Name(), "err", err)
	}
	if done {
		file.Close()
		delete(l.open, key)
	}
}

// add makes the path of a new log for a request, and removes the oldest logs
// of the function past the number kept.
func (l *invocationLogs) add(functionID, key, requestID string) string {
	folder := filepath.Join(l.dir, functionID)
	kept, ok := l.kept[functionID]
	if !ok {
		kept = existingLogs(folder)
		if err := os.MkdirAll(folder, 0755); err != nil {
			slog.Error("failed to make invocation log folder", "path", folder, "err", err)
		}
	}
	path := filepath.Join(folder, fmt.Sprintf("%d-%s.log", time.Now().Unix(), requestID))
	l.paths[key] = path
	l.keys[path] = key
	kept = append(kept, path)
	for len(kept) > l.keep {
		oldest := kept[0]
		kept = kept[1:]
		if err := os.Remove(oldest); err != nil && !os.IsNotExist(err) {
			slog.Error("failed to remove invocation log", "path", oldest, "err", err)
		}
		if key, ok := l.keys[oldest]; ok {
			if file, ok := l.open[key]; ok {
				file.Close()
				delete(l.open, key)
			}
			delete(l.paths, key)
			delete(l.keys, oldest)
		}
	}
	l.kept[functionID] = kept
	return path
}

// existingLogs lists the logs in a function's folder, oldest first. They're
// named after the time they were made, in seconds, so they sort by name, to
// the second.
func existingLogs(folder string) []string {
	entries, err := os.ReadDir(folder)
	if err != nil {
		return nil
	}
	logs := []string{}
	for _, entry := range entries {
		if entry.Type().IsRegular() && strings.HasSuffix(entry.Name(), ".log") {
			logs = append(logs, filepath.Join(folder, entry.Name()))
		}
	}
	return logs
}

func (l *invocationLogs) close() {
	for _, file := range l.open {
		file.Close()
	}
}
