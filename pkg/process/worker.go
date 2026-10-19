package process

import (
	"io"
	"log/slog"
	"os"
	"os/exec"
	"sync"
	"time"
)

var (
	workersLock sync.Mutex
	workers     = map[*Worker]struct{}{}
	// how long a worker's output is still read after it exits, when something
	// it started holds the output open
	workerOutputGrace = time.Second
)

// Worker is a process that runs a function in sst dev, until it's stopped or
// exits on its own, as a Node.js worker does after a minute without work.
//
// It runs in a process group of its own, so what it started stops with it. It's
// waited for as soon as it exits, so it isn't left a zombie, holding its pipes
// open, and its output ends then, as that's how sst dev tells it's gone.
type Worker struct {
	cmd    *exec.Cmd
	output []*os.File
	// closed once the process has exited and been waited for
	exited chan struct{}
	// closed once what it started has stopped too
	done chan struct{}
	stop sync.Once
}

// StartWorker starts cmd as a worker. It sets the command's output, and
// replaces a Cancel from CommandContext, so its context ending stops the
// group.
func StartWorker(cmd *exec.Cmd) (*Worker, error) {
	Detach(cmd)
	if cmd.Cancel != nil {
		cmd.Cancel = func() error { return sendTermSignal(cmd.Process) }
		cmd.WaitDelay = killWait
	}
	// The pipes are made here, not with StdoutPipe, as Wait closes those once
	// the process exits, which can lose the last of its output.
	readers := []*os.File{}
	writers := []*os.File{}
	for range 2 {
		r, w, err := os.Pipe()
		if err != nil {
			untrackCommand(cmd)
			closeFiles(readers)
			closeFiles(writers)
			return nil, err
		}
		readers = append(readers, r)
		writers = append(writers, w)
	}
	cmd.Stdout, cmd.Stderr = writers[0], writers[1]
	err := cmd.Start()
	// the process has its own copies
	closeFiles(writers)
	if err != nil {
		untrackCommand(cmd)
		closeFiles(readers)
		return nil, err
	}
	w := &Worker{
		cmd:    cmd,
		output: readers,
		exited: make(chan struct{}),
		done:   make(chan struct{}),
	}
	// it's tracked as a worker from here, for Cleanup to stop with its group,
	// and as a command until then
	workersLock.Lock()
	workers[w] = struct{}{}
	workersLock.Unlock()
	untrackCommand(cmd)
	go func() {
		cmd.Wait()
		close(w.exited)
		// what it started goes with it, as in a Lambda environment that's shut
		// down
		stopGroup(cmd.Process.Pid)
		workersLock.Lock()
		delete(workers, w)
		workersLock.Unlock()
		close(w.done)
	}()
	return w, nil
}

// Logs gives what the worker prints, its output and its errors together. It
// ends once the worker has exited and what it printed is read.
func (w *Worker) Logs() io.ReadCloser {
	reader, writer := io.Pipe()
	var reading sync.WaitGroup
	for _, r := range w.output {
		reading.Go(func() { io.Copy(writer, r) })
	}
	read := make(chan struct{})
	go func() {
		reading.Wait()
		close(read)
	}()
	go func() {
		// A worker can close its output and keep running. It isn't gone until
		// it exits.
		<-w.exited
		select {
		case <-read:
		case <-time.After(workerOutputGrace):
			// something the worker started holds its output open, and isn't in
			// its group. Closing the pipes ends the reads, and what they read
			// last is passed on.
			closeFiles(w.output)
			select {
			case <-read:
			case <-time.After(workerOutputGrace):
			}
		}
		closeFiles(w.output)
		writer.Close()
	}()
	return reader
}

// Stop stops the worker and what it started, without waiting for them: they're
// asked to stop, and killed if they haven't a moment later.
func (w *Worker) Stop() {
	w.stop.Do(func() {
		select {
		case <-w.exited:
			return
		default:
		}
		if err := sendTermSignal(w.cmd.Process); err != nil {
			slog.Error("failed to stop worker", "pid", w.cmd.Process.Pid, "err", err)
		}
		go func() {
			select {
			case <-w.exited:
			case <-time.After(killWait):
				slog.Info("worker didn't stop, killing it", "pid", w.cmd.Process.Pid)
				sendKillSignal(w.cmd.Process)
			}
		}()
	})
}

func closeFiles(files []*os.File) {
	for _, f := range files {
		f.Close()
	}
}
