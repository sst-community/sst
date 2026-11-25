// Package stats is the console's stats module: for each function, how many
// invocations it had, how many failed, how long they took locally, how many
// run now, how many were the first of a worker (cold), and how many times it
// was built.
//
// The durations are local: sst dev runs the handler on this machine, so they
// aren't what Lambda bills.
//
// Messages, of module "stats":
//
//   - "functions": every function's stats, at most once a second, when they
//     changed and a page shows its tab: {functions: [Function]}.
package stats

import (
	"context"
	"embed"
	"io/fs"
	"math"
	"slices"
	"strings"
	"time"

	"github.com/sst/sst/v3/cmd/sst/mosaic/aws"
	"github.com/sst/sst/v3/cmd/sst/mosaic/console"
)

//go:embed web
var web embed.FS

const (
	// how many of a function's last durations its percentiles are of
	window = 1000
	// how long an invocation is counted as running without an answer: past
	// the longest a Lambda function runs, it's taken as lost
	lost = 15 * time.Minute
)

type Module struct{}

func (Module) Name() string  { return "stats" }
func (Module) Title() string { return "Stats" }
func (Module) Web() fs.FS    { return must(fs.Sub(web, "web")) }

// Function is one function's stats. Durations are in milliseconds, of its
// last invocations.
type Function struct {
	ID          string `json:"id"`
	Invocations int    `json:"invocations"`
	// Errors is how many invocations failed, and InitErrors how many times a
	// worker failed as it started, before it was handed one
	Errors      int     `json:"errors"`
	InitErrors  int     `json:"initErrors"`
	Running     int     `json:"running"`
	Cold        int     `json:"cold"`
	Builds      int     `json:"builds"`
	BuildErrors int     `json:"buildErrors"`
	P50         float64 `json:"p50"`
	P95         float64 `json:"p95"`
	P99         float64 `json:"p99"`
	Max         float64 `json:"max"`
	Last        int64   `json:"last,omitempty"`

	durations []float64
	next      int
}

type running struct {
	function string
	worker   string
	start    time.Time
}

type store struct {
	c         *console.Console
	functions map[string]*Function
	running   map[string]running
	warm      map[string]bool
	workers   map[string]map[string]bool
	dirty     bool
}

func (Module) Start(ctx context.Context, c *console.Console) error {
	s := &store{
		c:         c,
		functions: map[string]*Function{},
		running:   map[string]running{},
		warm:      map[string]bool{},
		workers:   map[string]map[string]bool{},
	}
	c.On(&aws.FunctionInvokedEvent{}, func(evt any) {
		e := evt.(*aws.FunctionInvokedEvent)
		f := s.function(e.FunctionID)
		f.Invocations++
		f.Last = c.Now().UnixMilli()
		if !s.warm[e.WorkerID] {
			f.Cold++
			s.warm[e.WorkerID] = true
		}
		if s.workers[e.FunctionID] == nil {
			s.workers[e.FunctionID] = map[string]bool{}
		}
		s.workers[e.FunctionID][e.WorkerID] = true
		if _, ok := s.running[e.RequestID]; !ok {
			f.Running++
		}
		s.running[e.RequestID] = running{function: e.FunctionID, worker: e.WorkerID, start: c.Now()}
		s.dirty = true
	})
	c.On(&aws.FunctionResponseEvent{}, func(evt any) {
		e := evt.(*aws.FunctionResponseEvent)
		s.done(e.RequestID, false)
	})
	c.On(&aws.FunctionErrorEvent{}, func(evt any) {
		e := evt.(*aws.FunctionErrorEvent)
		if e.RequestID == "" {
			// it failed as it started, before it was handed an invocation
			s.function(e.FunctionID).InitErrors++
			s.dirty = true
			return
		}
		s.done(e.RequestID, true)
	})
	c.On(&aws.FunctionBuildEvent{}, func(evt any) {
		e := evt.(*aws.FunctionBuildEvent)
		f := s.function(e.FunctionID)
		f.Builds++
		if len(e.Errors) > 0 {
			f.BuildErrors++
		}
		for worker := range s.workers[e.FunctionID] {
			delete(s.warm, worker)
		}
		s.dirty = true
	})
	c.On(&aws.FunctionWorkerForgottenEvent{}, func(evt any) {
		e := evt.(*aws.FunctionWorkerForgottenEvent)
		delete(s.warm, e.WorkerID)
		if w := s.workers[e.FunctionID]; w != nil {
			delete(w, e.WorkerID)
		}
		for request, r := range s.running {
			if r.worker == e.WorkerID {
				s.done(request, true)
			}
		}
	})
	c.Every(func(now time.Time) {
		for request, r := range s.running {
			if now.Sub(r.start) > lost {
				delete(s.running, request)
				s.function(r.function).Running--
				s.dirty = true
			}
		}
		if s.dirty && c.Watched("stats") {
			s.dirty = false
			c.Emit("stats", "functions", map[string]any{"functions": s.list()})
		}
	})
	c.Snapshot("stats", func() []console.Message {
		return []console.Message{c.Message("stats", "functions", map[string]any{"functions": s.list()})}
	})
	return nil
}

func (s *store) function(id string) *Function {
	f, ok := s.functions[id]
	if !ok {
		f = &Function{ID: id, durations: make([]float64, 0, 64)}
		s.functions[id] = f
	}
	return f
}

func (s *store) done(request string, failed bool) {
	r, ok := s.running[request]
	if !ok {
		return
	}
	delete(s.running, request)
	f := s.function(r.function)
	f.Running--
	if failed {
		f.Errors++
	}
	ms := float64(s.c.Now().Sub(r.start).Microseconds()) / 1000
	if len(f.durations) < window {
		f.durations = append(f.durations, ms)
	} else {
		f.durations[f.next] = ms
		f.next = (f.next + 1) % window
	}
	s.dirty = true
}

// list is every function's stats, with their percentiles worked out now.
func (s *store) list() []Function {
	out := make([]Function, 0, len(s.functions))
	sorted := make([]float64, 0, window)
	for _, f := range s.functions {
		copy := *f
		sorted = append(sorted[:0], f.durations...)
		slices.Sort(sorted)
		copy.P50 = percentile(sorted, 0.50)
		copy.P95 = percentile(sorted, 0.95)
		copy.P99 = percentile(sorted, 0.99)
		if len(sorted) > 0 {
			copy.Max = sorted[len(sorted)-1]
		}
		copy.durations = nil
		out = append(out, copy)
	}
	// by ID among the same count, so the order holds from one update to the next
	slices.SortFunc(out, func(a, b Function) int {
		if a.Invocations != b.Invocations {
			return b.Invocations - a.Invocations
		}
		return strings.Compare(a.ID, b.ID)
	})
	return out
}

// percentile is the nearest-rank percentile of sorted.
func percentile(sorted []float64, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	rank := int(math.Ceil(p*float64(len(sorted)))) - 1
	if rank < 0 {
		rank = 0
	}
	if rank >= len(sorted) {
		rank = len(sorted) - 1
	}
	return sorted[rank]
}

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}
