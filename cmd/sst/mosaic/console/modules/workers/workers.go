// Package workers is the console's workers module: the CPU and memory of each
// function worker sst dev runs on this machine, with what its process
// started, over time.
//
// It samples only while a page shows it, every two seconds, and off the
// console's dispatcher, as reading the processes takes a few milliseconds.
//
// Messages, of module "workers":
//
//   - "worker": a worker, with its samples so far. See Worker.
//   - "sample": the latest sample of each worker that runs:
//     {t, samples: [{id, cpu, rss, processes}]}.
//   - "exited": a worker's process is gone: {id, t}.
//   - "removed": a worker that exited a while ago is no longer kept: {id}.
package workers

import (
	"context"
	"embed"
	"io/fs"
	"time"

	"github.com/shirou/gopsutil/v4/process"
	"github.com/sst/sst/v3/cmd/sst/mosaic/aws"
	"github.com/sst/sst/v3/cmd/sst/mosaic/console"
)

//go:embed web
var web embed.FS

const (
	interval = 2 * time.Second
	// how long after sst dev starts a worker its process can have started:
	// a process with its PID that started later is another one, which took
	// the PID once the worker's exited
	startSkew = 10 * time.Second
	// how many samples a worker keeps: five minutes
	history = 150
	// how long a worker that exited is kept
	keepExited = 2 * time.Minute
)

type Module struct{}

func (Module) Name() string  { return "workers" }
func (Module) Title() string { return "Workers" }
func (Module) Web() fs.FS    { return must(fs.Sub(web, "web")) }

type Worker struct {
	ID       string   `json:"id"`
	Function string   `json:"function"`
	PID      int      `json:"pid"`
	Started  int64    `json:"started"`
	Exited   int64    `json:"exited,omitempty"`
	Samples  []Sample `json:"samples"`
}

// Sample is one worker's at a time: CPU is the percent of one core its
// processes used since the last sample, and RSS their resident memory, in
// bytes.
type Sample struct {
	T         int64   `json:"t"`
	CPU       float64 `json:"cpu"`
	RSS       uint64  `json:"rss"`
	Processes int     `json:"processes"`
}

type sampled struct {
	ID string `json:"id"`
	Sample
}

type store struct {
	c        *console.Console
	workers  map[string]*Worker
	order    []string
	sampling bool
	last     time.Time
	// the CPU seconds each process had used at the last sample, by PID
	cpu map[int32]float64
}

func (Module) Start(ctx context.Context, c *console.Console) error {
	s := &store{c: c, workers: map[string]*Worker{}, cpu: map[int32]float64{}}
	c.On(&aws.FunctionWorkerStartedEvent{}, func(evt any) {
		e := evt.(*aws.FunctionWorkerStartedEvent)
		w := &Worker{ID: e.WorkerID, Function: e.FunctionID, PID: e.PID, Started: c.Now().UnixMilli(), Samples: []Sample{}}
		if _, ok := s.workers[e.WorkerID]; !ok {
			s.order = append(s.order, e.WorkerID)
		}
		// a worker that starts again is a new process, with samples of its own
		s.workers[e.WorkerID] = w
		c.Emit("workers", "worker", w)
	})
	// sst dev forgets a worker a while after it stops, so one isn't kept for
	// good when no page samples it
	c.On(&aws.FunctionWorkerForgottenEvent{}, func(evt any) {
		e := evt.(*aws.FunctionWorkerForgottenEvent)
		if w, ok := s.workers[e.WorkerID]; ok && w.Exited == 0 {
			s.exit(w)
		}
	})
	c.Every(func(now time.Time) {
		s.forget(now)
		if s.sampling || !c.Watched("workers") || now.Sub(s.last) < interval {
			return
		}
		roots := map[string]root{}
		for id, w := range s.workers {
			if w.Exited == 0 {
				roots[id] = root{pid: int32(w.PID), started: time.UnixMilli(w.Started)}
			}
		}
		if len(roots) == 0 {
			return
		}
		s.sampling = true
		previous := s.cpu
		since := s.last
		go func() {
			trees, cpu, err := sample(ctx, roots)
			c.Do(ctx, func() {
				if err != nil {
					// no list of the processes says nothing about the workers
					s.sampling = false
					return
				}
				s.apply(trees, cpu, previous, since)
			})
		}()
	})
	c.Snapshot("workers", func() []console.Message {
		out := make([]console.Message, 0, len(s.order))
		for _, id := range s.order {
			out = append(out, c.Message("workers", "worker", s.workers[id]))
		}
		return out
	})
	return nil
}

// tree is what a worker's process and its descendants use now.
type tree struct {
	alive     bool
	cpu       float64
	rss       uint64
	processes int
	pids      []int32
}

// root is a worker's process, and when sst dev started it.
type root struct {
	pid     int32
	started time.Time
}

// sample reads each worker's process tree: every process whose parent is in
// it, from one list of the machine's processes. A worker whose PID is gone,
// or is another process's that started after it, has exited.
func sample(ctx context.Context, workers map[string]root) (map[string]tree, map[int32]float64, error) {
	pids, err := process.PidsWithContext(ctx)
	if err != nil {
		return nil, nil, err
	}
	children := map[int32][]int32{}
	exists := map[int32]bool{}
	for _, pid := range pids {
		exists[pid] = true
		p := &process.Process{Pid: pid}
		if ppid, err := p.PpidWithContext(ctx); err == nil {
			children[ppid] = append(children[ppid], pid)
		}
	}
	trees := map[string]tree{}
	cpu := map[int32]float64{}
	for id, w := range workers {
		t := tree{}
		if !exists[w.pid] {
			trees[id] = t
			continue
		}
		created, err := (&process.Process{Pid: w.pid}).CreateTimeWithContext(ctx)
		if err == nil && time.UnixMilli(created).After(w.started.Add(startSkew)) {
			trees[id] = t
			continue
		}
		t.alive = true
		queue := []int32{w.pid}
		seen := map[int32]bool{}
		for len(queue) > 0 {
			pid := queue[0]
			queue = queue[1:]
			if seen[pid] {
				continue
			}
			seen[pid] = true
			p := &process.Process{Pid: pid}
			if times, err := p.TimesWithContext(ctx); err == nil {
				cpu[pid] = times.User + times.System
			}
			if mem, err := p.MemoryInfoWithContext(ctx); err == nil {
				t.rss += mem.RSS
			}
			t.processes++
			t.pids = append(t.pids, pid)
			queue = append(queue, children[pid]...)
		}
		trees[id] = t
	}
	return trees, cpu, nil
}

func (s *store) apply(trees map[string]tree, cpu, previous map[int32]float64, since time.Time) {
	s.sampling = false
	now := s.c.Now()
	elapsed := now.Sub(since).Seconds()
	s.last = now
	s.cpu = cpu
	out := []sampled{}
	for id, t := range trees {
		w, ok := s.workers[id]
		if !ok || w.Exited != 0 {
			continue
		}
		if !t.alive {
			s.exit(w)
			continue
		}
		used := 0.0
		for _, pid := range t.pids {
			before, ok := previous[pid]
			if !ok {
				// a process that's new since the last sample used what it has
				// in that time, but the worker's own, seen for the first time,
				// has used it since it started
				if pid == int32(w.PID) {
					continue
				}
				before = 0
			}
			if d := cpu[pid] - before; d > 0 {
				used += d
			}
		}
		smp := Sample{T: now.UnixMilli(), RSS: t.rss, Processes: t.processes}
		if !since.IsZero() && elapsed > 0 {
			smp.CPU = used / elapsed * 100
		}
		w.Samples = append(w.Samples, smp)
		if len(w.Samples) > history {
			w.Samples = w.Samples[len(w.Samples)-history:]
		}
		out = append(out, sampled{ID: id, Sample: smp})
	}
	if len(out) > 0 {
		s.c.Emit("workers", "sample", map[string]any{"t": now.UnixMilli(), "samples": out})
	}
}

func (s *store) exit(w *Worker) {
	w.Exited = s.c.Now().UnixMilli()
	s.c.Emit("workers", "exited", map[string]any{"id": w.ID, "t": w.Exited})
}

// forget removes workers that exited a while ago.
func (s *store) forget(now time.Time) {
	kept := s.order[:0]
	for _, id := range s.order {
		w := s.workers[id]
		if w.Exited != 0 && now.Sub(time.UnixMilli(w.Exited)) > keepExited {
			delete(s.workers, id)
			s.c.Emit("workers", "removed", map[string]string{"id": id})
			continue
		}
		kept = append(kept, id)
	}
	s.order = kept
}

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}
