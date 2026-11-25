// Package console is sst dev's local web console: a page on loopback that
// shows what sst dev publishes on its bus, made of modules that are each
// turned on or off with --console or SST_CONSOLE.
//
// The console is another view of the bus, like the terminal UI. It never
// slows the bus: it reads one lossy subscription, its modules keep bounded
// stores, and what it loses is counted and shown on the page.
//
// Every module's state belongs to one goroutine, the dispatcher, which reads
// the bus, runs the modules' handlers and ticks, builds the snapshot a page
// gets when it connects, and runs what a route asks of a module with Do. A
// module needs no locks, and a page that connects gets a snapshot and then
// every message after it, with nothing in between lost or sent twice.
//
// See README.md for how to write a module, and for the messages each one
// sends.
package console

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"log/slog"
	"maps"
	"net/http"
	"reflect"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/sst/sst/v3/pkg/bus"
	"github.com/sst/sst/v3/pkg/project"
)

// Module is one part of the console that's turned on or off.
//
// Start is called once, before the console reads the bus, and registers what
// the module does with the console: the bus events it handles (On), what a
// page gets when it connects (Snapshot), what it does every second (Every),
// and its routes (Handle). Those all run on the dispatcher, so the module's
// state needs no locks. A module that's off isn't started, and costs nothing.
type Module interface {
	// Name is how it's turned on, as in --console=<name>: lower case letters.
	Name() string
	// Title is the name of its tab on the page, or nothing for a module that
	// adds to another's tab, as invocations adds to the logs'.
	Title() string
	// Web is its part of the page: <name>.js, which registers it with
	// SST.register, and <name>.css if it has one. Nil for a module without a
	// tab of its own.
	Web() fs.FS
	Start(ctx context.Context, c *Console) error
}

// Requirer is a Module that needs other modules on: they're turned on with
// it.
type Requirer interface {
	Requires() []string
}

// Message is what a page gets, one per server-sent event, as JSON. Seq orders
// them, and Time is when the console handled the event, in Unix milliseconds.
type Message struct {
	Seq    uint64 `json:"seq"`
	Time   int64  `json:"time"`
	Module string `json:"module"`
	Type   string `json:"type"`
	Data   any    `json:"data,omitempty"`
}

// StartedEvent is published once the console listens, with the link to open
// it. The link holds the console's token.
type StartedEvent struct {
	URL string
}

// Config is what the console starts with.
type Config struct {
	// Modules are the names of the modules to turn on, from Parse.
	Modules []string
	// Available are the modules there are, in the order of their tabs.
	Available []Module
	App       string
	Stage     string
	Version   string
}

// how many messages wait for a page before it's too far behind and is made to
// connect again, when it gets a fresh snapshot
const clientBuffer = 4096

// Console is what a module registers with in Start, and what it emits
// through.
type Console struct {
	cfg      Config
	modules  []Module
	enabled  map[string]bool
	handlers map[reflect.Type][]func(evt any)
	snaps    []snapshotter
	ticks    []func(now time.Time)
	mux      *http.ServeMux

	calls   chan func()
	stopped chan struct{}

	// below here, only the dispatcher reads and writes
	sub     <-chan any
	seq     uint64
	now     time.Time
	clients map[*client]struct{}
	pages   uint64
	resyncs uint64
	// unsent is how many of each module's messages couldn't be marshalled
	unsent    map[string]uint64
	functions map[string]string
	started   time.Time
}

type snapshotter struct {
	module string
	fn     func() []Message
}

// client is one page's stream. ch is closed when it falls too far behind.
// shown is the module whose tab the page shows, if it's in view.
type client struct {
	id      uint64
	modules map[string]bool
	shown   map[string]bool
	ch      chan []byte
	closed  bool
}

// New makes a console with the configured modules started, subscribed to the
// bus, which Run reads.
func New(ctx context.Context, cfg Config) (*Console, error) {
	c := &Console{
		cfg:       cfg,
		enabled:   map[string]bool{},
		handlers:  map[reflect.Type][]func(any){},
		mux:       http.NewServeMux(),
		calls:     make(chan func()),
		stopped:   make(chan struct{}),
		clients:   map[*client]struct{}{},
		unsent:    map[string]uint64{},
		functions: map[string]string{},
		started:   time.Now(),
	}
	for _, m := range cfg.Available {
		if slices.Contains(cfg.Modules, m.Name()) {
			c.modules = append(c.modules, m)
			c.enabled[m.Name()] = true
		}
	}
	c.On(&project.CompleteEvent{}, c.onComplete)
	c.On(&project.StackCommandEvent{}, func(evt any) {
		e := evt.(*project.StackCommandEvent)
		if e.App != "" {
			c.cfg.App, c.cfg.Stage = e.App, e.Stage
			c.Emit("core", "app", c.app())
		}
	})
	c.Every(func(now time.Time) {
		if len(c.clients) > 0 {
			c.Emit("core", "status", c.status())
		}
	})
	for _, m := range c.modules {
		if err := m.Start(ctx, c); err != nil {
			return nil, fmt.Errorf("console module %s: %w", m.Name(), err)
		}
	}
	c.routes()
	c.sub = bus.SubscribeAll()
	return c, nil
}

// close lets go of the bus, for a console that won't run.
func (c *Console) close() {
	bus.Unsubscribe(c.sub)
}

// On has fn handle every bus event of sample's type, as published: a pointer,
// like &aws.FunctionLogEvent{}. fn runs on the dispatcher, as do Snapshot's
// and Every's, so they can use the module's state and the Console's methods.
func (c *Console) On(sample any, fn func(evt any)) {
	t := reflect.TypeOf(sample)
	c.handlers[t] = append(c.handlers[t], fn)
}

// Snapshot has fn say what a page that connects gets of the module, before
// the messages after it.
func (c *Console) Snapshot(module string, fn func() []Message) {
	c.snaps = append(c.snaps, snapshotter{module: module, fn: fn})
}

// Every has fn run once a second.
func (c *Console) Every(fn func(now time.Time)) {
	c.ticks = append(c.ticks, fn)
}

// Handle serves a module's route, like "GET /api/logs/{id}". A handler that
// reads the module's state does it with Do.
func (c *Console) Handle(pattern string, handler http.HandlerFunc) {
	c.mux.HandleFunc(pattern, handler)
}

// Do runs fn on the dispatcher, with the modules' state, and waits for it.
// Once the dispatcher has fn, Do waits for it to finish, even if ctx ends,
// so what fn did, like adding a page's stream, is never left behind.
func (c *Console) Do(ctx context.Context, fn func()) error {
	done := make(chan struct{})
	select {
	case c.calls <- func() { fn(); close(done) }:
	case <-ctx.Done():
		return ctx.Err()
	case <-c.stopped:
		return fmt.Errorf("console stopped")
	}
	select {
	case <-done:
		return nil
	case <-c.stopped:
		// fn may have finished as the console stopped
		select {
		case <-done:
			return nil
		default:
			return fmt.Errorf("console stopped")
		}
	}
}

// Now is when the event being handled reached the console.
func (c *Console) Now() time.Time {
	return c.now
}

// Message makes a message of the module, for a snapshot. A snapshot's
// messages all have the seq of the last message before it, and come in the
// order to apply them. It runs on the dispatcher.
func (c *Console) Message(module, typ string, data any) Message {
	return Message{Seq: c.seq, Time: c.now.UnixMilli(), Module: module, Type: typ, Data: data}
}

// Emit sends a message of the module to the pages that show it. It's only
// marshalled when one does, so a console without a page open does no more
// than keep its modules' stores. It runs on the dispatcher: off it, as in a
// goroutine that samples, call it in Do.
func (c *Console) Emit(module, typ string, data any) {
	c.seq++
	var payload []byte
	for cl := range c.clients {
		if cl.closed || !cl.modules[module] {
			continue
		}
		if payload == nil {
			var err error
			payload, err = json.Marshal(Message{Seq: c.seq, Time: c.now.UnixMilli(), Module: module, Type: typ, Data: data})
			if err != nil {
				slog.Error("console: marshalling a message", "module", module, "type", typ, "err", err)
				c.unsent[module]++
				return
			}
		}
		select {
		case cl.ch <- payload:
		default:
			// It's too far behind to catch up. Its page connects again and
			// gets a fresh snapshot, rather than missing messages silently.
			cl.closed = true
			close(cl.ch)
			c.resyncs++
		}
	}
}

// Watched is whether a page that's open shows the module's tab, so a module
// that samples, like the host's CPU, only does it then. It runs on the
// dispatcher, as in Every: off it, call it in Do.
func (c *Console) Watched(module string) bool {
	for cl := range c.clients {
		if cl.shown[module] && !cl.closed {
			return true
		}
	}
	return false
}

// show records which module's tab a page shows: none when it's out of view.
// It runs on the dispatcher.
func (c *Console) show(id uint64, module string) bool {
	for cl := range c.clients {
		if cl.id == id {
			cl.shown = map[string]bool{}
			if module != "" && cl.modules[module] {
				cl.shown[module] = true
			}
			return true
		}
	}
	return false
}

// FunctionName is a function's handler, as the last deploy reported it, or its
// ID. It runs on the dispatcher: off it, call it in Do.
func (c *Console) FunctionName(id string) string {
	if name, ok := c.functions[id]; ok && name != "" {
		return name
	}
	return id
}

// clipped is what Clip ends a text it cut with.
const clipped = "… [truncated]"

// Clip cuts text to at most max bytes, where a character starts, and says
// it was cut, within max. A max with no room for that is the saying alone.
func Clip(text string, max int) string {
	if len(text) <= max {
		return text
	}
	cut := max - len(clipped)
	if cut < 0 {
		cut = 0
	}
	for cut > 0 && !utf8.RuneStart(text[cut]) {
		cut--
	}
	return text[:cut] + clipped
}

// Enabled is whether a module is on.
func (c *Console) Enabled(module string) bool {
	return c.enabled[module]
}

func (c *Console) onComplete(evt any) {
	e := evt.(*project.CompleteEvent)
	functions := make(map[string]string, len(e.Functions))
	for id, fn := range e.Functions {
		functions[id] = strings.TrimPrefix(fn.Handler, "./")
	}
	c.functions = functions
	c.Emit("core", "app", c.app())
}

type appInfo struct {
	App       string            `json:"app"`
	Stage     string            `json:"stage"`
	Version   string            `json:"version"`
	Functions map[string]string `json:"functions"`
}

func (c *Console) app() appInfo {
	return appInfo{App: c.cfg.App, Stage: c.cfg.Stage, Version: c.cfg.Version, Functions: c.functions}
}

type moduleInfo struct {
	Name  string `json:"name"`
	Title string `json:"title"`
}

type hello struct {
	appInfo
	Modules []moduleInfo `json:"modules"`
	// Page is the stream's ID, which the page says what tab it shows with
	Page uint64 `json:"page"`
}

type status struct {
	// BusDropped is how many events the console's own subscription lost, and
	// BusDroppedTotal how many every subscriber did.
	BusDropped      uint64 `json:"busDropped"`
	BusDroppedTotal uint64 `json:"busDroppedTotal"`
	Clients         int    `json:"clients"`
	Resyncs         uint64 `json:"resyncs"`
	Uptime          int64  `json:"uptime"`
	// Unsent is how many of each module's messages couldn't be marshalled,
	// so the page can say a module is failing
	Unsent map[string]uint64 `json:"unsent,omitempty"`
}

func (c *Console) status() status {
	return status{
		BusDropped:      bus.DroppedFrom(c.sub),
		BusDroppedTotal: bus.Dropped(),
		Clients:         c.open(),
		Resyncs:         c.resyncs,
		Uptime:          int64(time.Since(c.started).Seconds()),
		Unsent:          maps.Clone(c.unsent),
	}
}

// open is how many pages have a stream: not one that was cut off for falling
// behind, which its handler drops soon after.
func (c *Console) open() int {
	n := 0
	for cl := range c.clients {
		if !cl.closed {
			n++
		}
	}
	return n
}

// Run reads the bus and runs the modules until ctx ends.
func (c *Console) Run(ctx context.Context) {
	defer close(c.stopped)
	defer c.close()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			for cl := range c.clients {
				c.drop(cl)
			}
			return
		case evt := <-c.sub:
			c.dispatch(evt)
		case fn := <-c.calls:
			c.now = time.Now()
			fn()
		case now := <-ticker.C:
			c.now = now
			for _, fn := range c.ticks {
				fn(now)
			}
		}
	}
}

func (c *Console) dispatch(evt any) {
	handlers := c.handlers[reflect.TypeOf(evt)]
	if len(handlers) == 0 {
		return
	}
	c.now = time.Now()
	for _, fn := range handlers {
		fn(evt)
	}
}

// connect adds a page's stream for the modules, and gives the snapshot it
// starts with. It runs on the dispatcher.
func (c *Console) connect(modules []string) (*client, [][]byte) {
	c.pages++
	cl := &client{id: c.pages, modules: map[string]bool{"core": true}, shown: map[string]bool{}, ch: make(chan []byte, clientBuffer)}
	info := hello{appInfo: c.app(), Page: cl.id}
	for _, m := range c.modules {
		if slices.Contains(modules, m.Name()) {
			cl.modules[m.Name()] = true
			info.Modules = append(info.Modules, moduleInfo{Name: m.Name(), Title: m.Title()})
		}
	}
	messages := []Message{c.Message("core", "hello", info), c.Message("core", "status", c.status())}
	for _, s := range c.snaps {
		if cl.modules[s.module] {
			messages = append(messages, s.fn()...)
		}
	}
	messages = append(messages, c.Message("core", "ready", nil))
	out := make([][]byte, 0, len(messages))
	for _, m := range messages {
		b, err := json.Marshal(m)
		if err != nil {
			slog.Error("console: marshalling a snapshot", "module", m.Module, "type", m.Type, "err", err)
			c.unsent[m.Module]++
			continue
		}
		out = append(out, b)
	}
	c.clients[cl] = struct{}{}
	return cl, out
}

// drop removes a page's stream. It runs on the dispatcher.
func (c *Console) drop(cl *client) {
	if _, ok := c.clients[cl]; !ok {
		return
	}
	delete(c.clients, cl)
	if !cl.closed {
		cl.closed = true
		close(cl.ch)
	}
}
