// Package logs is the console's logs module: what functions, tasks and
// Cloudflare workers print, grouped by invocation.
//
// Messages, of module "logs":
//
//   - "invocation": an invocation started, or, in a snapshot, one kept with
//     its lines. See Invocation.
//   - "line": a line it printed: {key, t, text}, t in Unix milliseconds.
//   - "end": it finished: {key, end, status, error}. status is "ok" or
//     "error". error is {type, message, trace}.
//   - "build": a function or worker was built: {function, ok, errors, time}.
//   - "evicted": the oldest invocations were dropped to stay under the
//     store's limits: {keys}.
package logs

import (
	"container/list"
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"strings"

	"github.com/sst/sst/v3/cmd/sst/mosaic/aws"
	"github.com/sst/sst/v3/cmd/sst/mosaic/cloudflare"
	"github.com/sst/sst/v3/cmd/sst/mosaic/console"
)

//go:embed web
var web embed.FS

const (
	// how many invocations a function keeps, and all of them together
	perFunction = 500
	total       = 5000
	// how much the lines of every invocation take together, before the
	// oldest invocations go
	totalBytes = 16 << 20
	// how many lines an invocation keeps, and how long one is, before the
	// rest are counted, not kept
	maxLines    = 2000
	maxLineSize = 16 << 10
	// how many builds are kept
	maxBuilds = 100
)

type Module struct{}

func (Module) Name() string  { return "logs" }
func (Module) Title() string { return "Logs" }
func (Module) Web() fs.FS    { return must(fs.Sub(web, "web")) }

// Kind is what ran.
const (
	KindFunction = "function"
	KindTask     = "task"
	KindWorker   = "worker"
)

// Invocation is one run of a function, a task or a Cloudflare worker.
type Invocation struct {
	// Key is the invocation's own: its request ID for a function's
	Key      string `json:"key"`
	Kind     string `json:"kind"`
	Function string `json:"function"`
	Worker   string `json:"worker"`
	Request  string `json:"request,omitempty"`
	// Title is what it was for, like a worker's request or a task's command
	Title  string `json:"title,omitempty"`
	Start  int64  `json:"start"`
	End    int64  `json:"end,omitempty"`
	Status string `json:"status"`
	// Cold is whether it's the first its worker ran since it started, or
	// since its function was built again
	Cold  bool   `json:"cold,omitempty"`
	Error *Error `json:"error,omitempty"`
	Lines []Line `json:"lines"`
	// Dropped is how many lines it printed that weren't kept
	Dropped int `json:"dropped,omitempty"`

	size  int
	all   *list.Element
	group *list.Element
}

type Line struct {
	T    int64  `json:"t"`
	Text string `json:"text"`
}

type Error struct {
	Type    string   `json:"type,omitempty"`
	Message string   `json:"message"`
	Trace   []string `json:"trace,omitempty"`
}

type line struct {
	Key  string `json:"key"`
	T    int64  `json:"t"`
	Text string `json:"text"`
}

type end struct {
	Key    string `json:"key"`
	End    int64  `json:"end"`
	Status string `json:"status"`
	Error  *Error `json:"error,omitempty"`
}

type Build struct {
	Function string   `json:"function"`
	OK       bool     `json:"ok"`
	Errors   []string `json:"errors,omitempty"`
	Time     int64    `json:"time"`
}

// store is what the module keeps. It's only used on the console's dispatcher.
type store struct {
	c     *console.Console
	byKey map[string]*Invocation
	// oldest first, all of them and each function's
	all       *list.List
	functions map[string]*list.List
	size      int
	// what each worker runs now, and the workers that ran since they started
	current map[string]string
	warm    map[string]bool
	// a function's workers, to make them cold when it's built again
	workers map[string]map[string]bool
	builds  []Build
	seq     uint64
}

func (Module) Start(ctx context.Context, c *console.Console) error {
	s := &store{
		c:         c,
		byKey:     map[string]*Invocation{},
		all:       list.New(),
		functions: map[string]*list.List{},
		current:   map[string]string{},
		warm:      map[string]bool{},
		workers:   map[string]map[string]bool{},
	}
	c.On(&aws.FunctionInvokedEvent{}, func(evt any) {
		e := evt.(*aws.FunctionInvokedEvent)
		s.start(&Invocation{Key: e.RequestID, Kind: KindFunction, Function: e.FunctionID, Worker: e.WorkerID, Request: e.RequestID})
	})
	c.On(&aws.FunctionLogEvent{}, func(evt any) {
		e := evt.(*aws.FunctionLogEvent)
		key := e.RequestID
		if _, ok := s.byKey[key]; !ok || key == "" {
			// printed before it was ever invoked, as a worker starting
			key = s.orphan(KindFunction, e.FunctionID, e.WorkerID)
		}
		s.line(key, e.Line)
	})
	c.On(&aws.FunctionResponseEvent{}, func(evt any) {
		e := evt.(*aws.FunctionResponseEvent)
		s.end(e.RequestID, "ok", nil)
	})
	c.On(&aws.FunctionErrorEvent{}, func(evt any) {
		e := evt.(*aws.FunctionErrorEvent)
		key := e.RequestID
		if key == "" {
			// it failed as it started: the error is the worker's current
			// invocation's, if it has one
			key = s.current[e.WorkerID]
		}
		if _, ok := s.byKey[key]; !ok {
			key = s.orphan(KindFunction, e.FunctionID, e.WorkerID)
		}
		s.end(key, "error", &Error{Type: e.ErrorType, Message: e.ErrorMessage, Trace: e.Trace})
	})
	c.On(&aws.FunctionBuildEvent{}, func(evt any) {
		e := evt.(*aws.FunctionBuildEvent)
		s.build(e.FunctionID, e.Errors)
	})
	c.On(&aws.FunctionWorkerForgottenEvent{}, func(evt any) {
		e := evt.(*aws.FunctionWorkerForgottenEvent)
		delete(s.warm, e.WorkerID)
		delete(s.current, e.WorkerID)
		if w := s.workers[e.FunctionID]; w != nil {
			delete(w, e.WorkerID)
		}
	})
	c.On(&aws.TaskStartEvent{}, func(evt any) {
		e := evt.(*aws.TaskStartEvent)
		s.start(&Invocation{Key: s.key("t"), Kind: KindTask, Function: e.TaskID, Worker: e.WorkerID, Title: e.Command})
	})
	c.On(&aws.TaskLogEvent{}, func(evt any) {
		e := evt.(*aws.TaskLogEvent)
		key, ok := s.current[e.WorkerID]
		if !ok {
			key = s.orphan(KindTask, e.TaskID, e.WorkerID)
		}
		s.line(key, e.Line)
	})
	c.On(&aws.TaskCompleteEvent{}, func(evt any) {
		e := evt.(*aws.TaskCompleteEvent)
		if key, ok := s.current[e.WorkerID]; ok {
			s.end(key, "ok", nil)
		}
	})
	c.On(&cloudflare.WorkerBuildEvent{}, func(evt any) {
		e := evt.(*cloudflare.WorkerBuildEvent)
		s.build(e.WorkerID, e.Errors)
	})
	c.On(&cloudflare.WorkerInvokedEvent{}, func(evt any) {
		e := evt.(*cloudflare.WorkerInvokedEvent)
		s.worker(e)
	})
	c.Snapshot("logs", s.snapshot)
	return nil
}

func (s *store) key(prefix string) string {
	s.seq++
	return fmt.Sprintf("%s%d", prefix, s.seq)
}

// orphan is the invocation for what a worker printed outside of one, made
// when it's first needed.
func (s *store) orphan(kind, function, worker string) string {
	key := "w:" + worker
	if inv, ok := s.byKey[key]; ok && inv.End == 0 {
		return key
	}
	if _, ok := s.byKey[key]; ok {
		s.remove(s.byKey[key])
		s.c.Emit("logs", "evicted", map[string][]string{"keys": {key}})
	}
	s.start(&Invocation{Key: key, Kind: kind, Function: function, Worker: worker, Title: "Outside an invocation"})
	return key
}

func (s *store) start(inv *Invocation) {
	if old, ok := s.byKey[inv.Key]; ok {
		s.remove(old)
	}
	now := s.c.Now().UnixMilli()
	if inv.Start == 0 {
		inv.Start = now
	}
	inv.Status = "running"
	inv.Lines = []Line{}
	if inv.Kind == KindFunction && !strings.HasPrefix(inv.Key, "w:") {
		inv.Cold = !s.warm[inv.Worker]
		s.warm[inv.Worker] = true
		s.current[inv.Worker] = inv.Key
		if s.workers[inv.Function] == nil {
			s.workers[inv.Function] = map[string]bool{}
		}
		s.workers[inv.Function][inv.Worker] = true
	}
	if inv.Kind == KindTask {
		s.current[inv.Worker] = inv.Key
	}
	s.add(inv)
	// what a snapshot sends of it is what it is now, and lines come after
	s.c.Emit("logs", "invocation", *inv)
	s.evict()
}

func (s *store) add(inv *Invocation) {
	s.byKey[inv.Key] = inv
	inv.all = s.all.PushBack(inv)
	group := s.functions[inv.Function]
	if group == nil {
		group = list.New()
		s.functions[inv.Function] = group
	}
	inv.group = group.PushBack(inv)
	s.size += inv.size
}

func (s *store) remove(inv *Invocation) {
	delete(s.byKey, inv.Key)
	s.all.Remove(inv.all)
	if group := s.functions[inv.Function]; group != nil {
		group.Remove(inv.group)
		if group.Len() == 0 {
			delete(s.functions, inv.Function)
		}
	}
	s.size -= inv.size
	if s.current[inv.Worker] == inv.Key {
		delete(s.current, inv.Worker)
	}
}

// evict drops the oldest invocations of a function that keeps too many, and
// then the oldest of all, until the store is under its limits.
func (s *store) evict() {
	keys := []string{}
	for _, group := range s.functions {
		for group.Len() > perFunction {
			inv := group.Front().Value.(*Invocation)
			keys = append(keys, inv.Key)
			s.remove(inv)
		}
	}
	for s.all.Len() > total || (s.size > totalBytes && s.all.Len() > 1) {
		inv := s.all.Front().Value.(*Invocation)
		keys = append(keys, inv.Key)
		s.remove(inv)
	}
	if len(keys) > 0 {
		s.c.Emit("logs", "evicted", map[string][]string{"keys": keys})
	}
}

func (s *store) line(key string, text string) {
	inv, ok := s.byKey[key]
	if !ok {
		return
	}
	if len(inv.Lines) >= maxLines {
		inv.Dropped++
		return
	}
	text = strings.TrimRight(text, "\r\n")
	text = console.Clip(text, maxLineSize)
	t := s.c.Now().UnixMilli()
	inv.Lines = append(inv.Lines, Line{T: t, Text: text})
	inv.size += len(text) + 16
	s.size += len(text) + 16
	s.c.Emit("logs", "line", line{Key: key, T: t, Text: text})
	if s.size > totalBytes {
		s.evict()
	}
}

func (s *store) end(key, status string, err *Error) {
	inv, ok := s.byKey[key]
	if !ok || inv.End != 0 {
		return
	}
	inv.End = s.c.Now().UnixMilli()
	inv.Status = status
	inv.Error = err
	if err != nil {
		inv.size += len(err.Message) + len(strings.Join(err.Trace, ""))
		s.size += len(err.Message) + len(strings.Join(err.Trace, ""))
	}
	if s.current[inv.Worker] == key {
		delete(s.current, inv.Worker)
	}
	s.c.Emit("logs", "end", end{Key: key, End: inv.End, Status: status, Error: err})
}

func (s *store) build(function string, errors []string) {
	b := Build{Function: function, OK: len(errors) == 0, Errors: errors, Time: s.c.Now().UnixMilli()}
	s.builds = append(s.builds, b)
	if len(s.builds) > maxBuilds {
		s.builds = s.builds[len(s.builds)-maxBuilds:]
	}
	// the workers run the old build until they start again
	for worker := range s.workers[function] {
		delete(s.warm, worker)
	}
	s.c.Emit("logs", "build", b)
}

// worker records a Cloudflare worker's invocation, which arrives whole.
func (s *store) worker(e *cloudflare.WorkerInvokedEvent) {
	t := e.TailEvent
	if t == nil {
		return
	}
	start := t.EventTimestamp
	if start == 0 {
		start = s.c.Now().UnixMilli()
	}
	title := t.Event.Request.Method + " " + t.Event.Request.URL
	inv := &Invocation{Key: s.key("cf"), Kind: KindWorker, Function: e.WorkerID, Worker: e.WorkerID, Title: strings.TrimSpace(title), Start: start}
	s.start(inv)
	for _, l := range t.Logs {
		parts := make([]string, 0, len(l.Message))
		for _, m := range l.Message {
			if str, ok := m.(string); ok {
				parts = append(parts, str)
				continue
			}
			b, _ := json.Marshal(m)
			parts = append(parts, string(b))
		}
		text := strings.Join(parts, " ")
		if l.Level != "" && l.Level != "log" {
			text = strings.ToUpper(l.Level) + " " + text
		}
		s.line(inv.Key, text)
	}
	var err *Error
	for _, ex := range t.Exceptions {
		b, _ := json.Marshal(ex)
		if err == nil {
			err = &Error{Message: string(b)}
			continue
		}
		err.Trace = append(err.Trace, string(b))
	}
	status := "ok"
	if t.Outcome != "" && t.Outcome != "ok" || err != nil {
		status = "error"
		if err == nil {
			err = &Error{Message: t.Outcome}
		}
	}
	s.end(inv.Key, status, err)
}

func (s *store) snapshot() []console.Message {
	out := make([]console.Message, 0, s.all.Len()+len(s.builds))
	for _, b := range s.builds {
		out = append(out, s.c.Message("logs", "build", b))
	}
	for e := s.all.Front(); e != nil; e = e.Next() {
		out = append(out, s.c.Message("logs", "invocation", *e.Value.(*Invocation)))
	}
	return out
}

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}
