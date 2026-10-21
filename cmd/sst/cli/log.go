package cli

import (
	"io"
	"os"
	"runtime/debug"
	"sync"
)

// How big logFile gets before it's started again. sst dev logs every
// invocation, so a long session would otherwise grow it for as long as it
// runs.
var logLimit int64 = 50 << 20

var (
	logMu sync.Mutex
	// the file logSize is the size of, as InitProject swaps logFile
	logSized *os.File
	logSize  int64
)

// cappedLog writes to logFile. Once that's past logLimit, it moves what's
// there to <name>.1, replacing an older one, and starts the file again. If it
// can't be moved, it's emptied, so the cap holds.
type cappedLog struct{}

func (cappedLog) Write(p []byte) (int, error) {
	logMu.Lock()
	defer logMu.Unlock()
	if logSized != logFile {
		logSized, logSize = logFile, 0
		if info, err := logFile.Stat(); err == nil {
			logSize = info.Size()
		}
	}
	if logSize > 0 && logSize+int64(len(p)) > logLimit {
		if next, err := startLogAgain(logFile); err == nil {
			// counted from 0 even when it was opened again to add to, so
			// that's tried again only once as much more is written
			logFile, logSized, logSize = next, next, 0
			debug.SetCrashOutput(logFile, debug.CrashOptions{})
		}
	}
	n, err := logFile.Write(p)
	logSize += int64(n)
	return n, err
}

// logWriters writes to each of its writers, though one of them fails, where
// io.MultiWriter stops at the first that does
type logWriters []io.Writer

func (w logWriters) Write(p []byte) (int, error) {
	var failed error
	for _, writer := range w {
		n, err := writer.Write(p)
		if err == nil && n < len(p) {
			err = io.ErrShortWrite
		}
		if err != nil && failed == nil {
			failed = err
		}
	}
	return len(p), failed
}

// The file is closed before it's moved, as Windows can't move an open file.
// If no new file can be made, it's opened again to add to.
func startLogAgain(file *os.File) (*os.File, error) {
	path := file.Name()
	// the crash output keeps a handle on it too
	debug.SetCrashOutput(nil, debug.CrashOptions{})
	file.Close()
	os.Rename(path, path+".1")
	if next, err := os.Create(path); err == nil {
		return next, nil
	}
	return os.OpenFile(path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0644)
}
