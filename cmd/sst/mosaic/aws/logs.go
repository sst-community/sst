package aws

import (
	"fmt"
	"sync"
	"time"
)

// With SST_DEV_CLOUDWATCH_LOGS set, what a function or a task prints in sst dev
// is also sent to what's deployed in its place, which prints it in its log
// group. A function's lines are sent after each reply, so a line printed after
// a reply goes with the next one, as it would in Lambda, where the function is
// frozen once it replies. A task's are sent every second, and when it exits.

// maxLogBytes is how much of what a worker printed is sent at once. The rest is
// counted and left out.
const maxLogBytes = 256 * 1024

// maxOutputLine is the longest line of a function's or a task's output that's
// passed on, 1 MB, as for Run. A longer one is left out, with a note.
const maxOutputLine = 1024 * 1024

func tooLongNote(of string) string {
	return fmt.Sprintf("A line of the %s's output is longer than %d MB and is not shown.", of, maxOutputLine/(1024*1024))
}

// logsDelay is how long after a reply its lines are taken, for the last ones
// still on their way from the worker's output.
const logsDelay = 50 * time.Millisecond

type pendingLogs struct {
	mu      sync.Mutex
	workers map[string]*workerLines
}

type workerLines struct {
	lines   []string
	size    int
	dropped int
}

func newPendingLogs() *pendingLogs {
	return &pendingLogs{workers: map[string]*workerLines{}}
}

func (p *pendingLogs) add(workerID string, line string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	w, ok := p.workers[workerID]
	if !ok {
		w = &workerLines{}
		p.workers[workerID] = w
	}
	if w.size+len(line) > maxLogBytes {
		w.dropped++
		return
	}
	w.lines = append(w.lines, line)
	w.size += len(line)
}

// take returns what the worker printed since the last take, and how many lines
// were left out.
func (p *pendingLogs) take(workerID string) ([]string, int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	w, ok := p.workers[workerID]
	if !ok {
		return nil, 0
	}
	delete(p.workers, workerID)
	return w.lines, w.dropped
}
