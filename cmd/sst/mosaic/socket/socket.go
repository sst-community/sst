// Package socket is the SST Console's local connection: console.sst.dev's
// page connects to sst dev from the browser and shows its function calls as
// they happen. The page knows only ws://localhost:13557/socket and
// wss://localhost:14557/socket, with no token (it also tries
// wss://localhost:13557, which the plain listener turns away), so the socket
// has listeners of its own on those ports (listen.go), apart from the server
// the program calls back into, which is under a token on a port the system
// picks.
package socket

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/charmbracelet/x/ansi"
	"github.com/gorilla/websocket"
	"github.com/sst/sst/v3/cmd/sst/mosaic/aws"
	"github.com/sst/sst/v3/pkg/bus"
	"github.com/sst/sst/v3/pkg/project"
)

type CliDevEvent struct {
	App    string `json:"app"`
	Stage  string `json:"stage"`
	Region string `json:"region"`
}

type Invocation struct {
	ID     string            `json:"id,omitempty"`
	Source string            `json:"source,omitempty"`
	Cold   bool              `json:"cold,omitempty"`
	Input  json.RawMessage   `json:"input,omitempty"`
	Output json.RawMessage   `json:"output,omitempty"`
	Start  int64             `json:"start,omitempty"`
	End    int64             `json:"end,omitempty"`
	Errors []InvocationError `json:"errors"`
	Logs   []InvocationLog   `json:"logs"`
	Report *InvocationReport `json:"report,omitempty"`
}

type InvocationLog struct {
	ID        string `json:"id,omitempty"`
	Timestamp int64  `json:"timestamp,omitempty"`
	Message   string `json:"message,omitempty"`
}

type InvocationReport struct {
	Duration int64  `json:"duration"`
	Init     int64  `json:"init"`
	Size     int64  `json:"size"`
	Memory   int64  `json:"memory"`
	Xray     string `json:"xray"`
}

type InvocationError struct {
	ID      string  `json:"id"`
	Error   string  `json:"error"`
	Message string  `json:"message"`
	Stack   []Frame `json:"stack"`
	Failed  bool    `json:"failed"`
}

type Frame struct {
	Raw string `json:"raw"`
}

const (
	// what the Console sends is small: only log.cleared is read
	maxMessageBytes = 4 << 10
	// how long a Console has to take a message, or to answer a ping
	writeWait = 10 * time.Second
	pingEvery = 30 * time.Second
	pongWait  = 2 * pingEvery
	// how many messages a Console can fall behind before it's let go; it
	// connects again and is sent what's kept
	queueSize = 64
	// how many connections the socket takes at once: a browser opens one
	// per Console tab
	maxConnections = 16
	// updates to the calls are sent together, at most this often, so a
	// function that logs many lines doesn't send its whole call each time
	flushEvery = 100 * time.Millisecond
)

// client is a connected Console. Its writer is the only one to write to it,
// from its queue, so a Console that doesn't read never holds up the event
// loop or the other Consoles.
type client struct {
	ws    *websocket.Conn
	queue chan []byte
}

func (cl *client) write() {
	ticker := time.NewTicker(pingEvery)
	defer ticker.Stop()
	defer cl.ws.Close()
	for {
		select {
		case message, ok := <-cl.queue:
			if !ok {
				return
			}
			cl.ws.SetWriteDeadline(time.Now().Add(writeWait))
			if err := cl.ws.WriteMessage(websocket.TextMessage, message); err != nil {
				return
			}
		case <-ticker.C:
			if err := cl.ws.WriteControl(websocket.PingMessage, nil, time.Now().Add(writeWait)); err != nil {
				return
			}
		}
	}
}

// console is the socket's event loop: it keeps the most recent invocations
// and sends them to each Console connected.
type console struct {
	app, stage   string
	connected    chan *client
	disconnected chan *client
	cleared      chan string
	connections  atomic.Int32
}

func newConsole(app, stage string) *console {
	return &console{
		app:          app,
		stage:        stage,
		connected:    make(chan *client),
		disconnected: make(chan *client),
		cleared:      make(chan string),
	}
}

// read takes what a connected Console sends, until it goes or ctx ends.
func (c *console) read(ctx context.Context, ws *websocket.Conn) {
	log := slog.Default().With("service", "socket")
	defer c.connections.Add(-1)
	ws.SetReadLimit(maxMessageBytes)
	alive := func() { ws.SetReadDeadline(time.Now().Add(pongWait)) }
	alive()
	ws.SetPongHandler(func(string) error {
		alive()
		return nil
	})
	cl := &client{ws: ws, queue: make(chan []byte, queueSize)}
	select {
	case c.connected <- cl:
	case <-ctx.Done():
		ws.Close()
		return
	}
	defer func() {
		select {
		case c.disconnected <- cl:
		case <-ctx.Done():
		}
	}()
	for {
		_, data, err := ws.ReadMessage()
		if err != nil {
			log.Info("socket closed", "err", err)
			return
		}
		alive()
		var message struct {
			Type       string `json:"type"`
			Properties struct {
				Source string `json:"source"`
			} `json:"properties"`
		}
		if json.Unmarshal(data, &message) != nil || message.Type != "log.cleared" || message.Properties.Source == "" {
			continue
		}
		select {
		case c.cleared <- message.Properties.Source:
		case <-ctx.Done():
			return
		}
	}
}

// run is the event loop, until ctx ends.
func (c *console) run(ctx context.Context) {
	log := slog.Default().With("service", "socket")
	evts := bus.Subscribe(
		&project.CompleteEvent{},
		&aws.FunctionInvokedEvent{},
		&aws.FunctionResponseEvent{},
		&aws.FunctionErrorEvent{},
		&aws.FunctionLogEvent{},
	)
	defer bus.Unsubscribe(evts)
	clients := map[*client]struct{}{}
	drop := func(cl *client) {
		if _, ok := clients[cl]; ok {
			delete(clients, cl)
			close(cl.queue)
		}
	}
	defer func() {
		for cl := range clients {
			drop(cl)
		}
	}()
	encode := func(kind string, properties any) []byte {
		message, err := json.Marshal(map[string]any{"type": kind, "properties": properties})
		if err != nil {
			log.Info("socket message not sent", "err", err)
			return nil
		}
		return message
	}
	send := func(cl *client, message []byte) {
		if message == nil {
			return
		}
		select {
		case cl.queue <- message:
		default:
			log.Info("socket let go of a Console that fell behind", "addr", cl.ws.RemoteAddr())
			drop(cl)
		}
	}
	invocations := newInvocationStore()

	// the calls changed since the last flush, oldest first
	var changed []string
	pending := map[string]bool{}
	var flush <-chan time.Time
	update := func(id string) {
		if !pending[id] {
			pending[id] = true
			changed = append(changed, id)
		}
		if flush == nil {
			flush = time.After(flushEvery)
		}
	}

	var complete *project.CompleteEvent
	for {
		select {
		case <-ctx.Done():
			return
		case <-flush:
			flush = nil
			if len(clients) > 0 {
				batch := []*Invocation{}
				for _, id := range changed {
					if invocation, ok := invocations.get(id); ok {
						batch = append(batch, invocation)
					}
				}
				if len(batch) > 0 {
					message := encode("invocation", batch)
					for cl := range clients {
						send(cl, message)
					}
				}
			}
			changed = nil
			pending = map[string]bool{}
		case source := <-c.cleared:
			invocations.clear(source)
		case unknown := <-evts:
			switch evt := unknown.(type) {
			case *project.CompleteEvent:
				complete = evt
			case *aws.FunctionInvokedEvent:
				source := ""
				if complete != nil {
					for _, resource := range complete.Resources {
						if resource.URN.Name() == evt.FunctionID && resource.Type == "sst:aws:Function" {
							source = string(resource.URN)
						}
					}
				}
				invocation := &Invocation{
					ID:     evt.RequestID,
					Source: source,
					Input:  rawJSON(evt.Input),
					Start:  time.Now().UnixMilli(),
					Errors: []InvocationError{},
					Logs:   []InvocationLog{},
				}
				invocations.add(invocation)
				update(evt.RequestID)
			case *aws.FunctionResponseEvent:
				invocation, ok := invocations.get(evt.RequestID)
				if ok {
					invocation.Output = rawJSON(evt.Output)
					invocations.grow(evt.RequestID, len(invocation.Output))
					invocation.End = time.Now().UnixMilli()
					invocation.Report = &InvocationReport{
						Duration: invocation.End - invocation.Start,
					}
					update(evt.RequestID)
				}
			case *aws.FunctionErrorEvent:
				invocation, ok := invocations.get(evt.RequestID)
				if ok {
					invocation.End = time.Now().UnixMilli()
					invocation.Report = &InvocationReport{
						Duration: invocation.End - invocation.Start,
					}
					failure := InvocationError{
						Message: evt.ErrorMessage,
						Error:   evt.ErrorType,
						Failed:  true,
						Stack:   []Frame{},
					}
					size := len(evt.ErrorMessage) + len(evt.ErrorType)
					for _, frame := range evt.Trace {
						failure.Stack = append(failure.Stack, Frame{Raw: frame})
						size += len(frame)
					}
					invocation.Errors = append(invocation.Errors, failure)
					invocations.grow(evt.RequestID, size)
					update(evt.RequestID)
				}
			case *aws.FunctionLogEvent:
				if _, ok := invocations.get(evt.RequestID); ok {
					invocations.log(evt.RequestID, InvocationLog{
						ID:        time.Now().String(),
						Timestamp: time.Now().UnixMilli(),
						Message:   ansi.Strip(evt.Line),
					})
					update(evt.RequestID)
				}
			}
		case cl := <-c.connected:
			log.Info("socket connected", "addr", cl.ws.RemoteAddr())
			clients[cl] = struct{}{}
			go cl.write()
			send(cl, encode("cli.dev", CliDevEvent{App: c.app, Stage: c.stage}))
			if _, ok := clients[cl]; ok {
				send(cl, encode("invocation", invocations.list()))
			}
		case cl := <-c.disconnected:
			log.Info("socket disconnected", "addr", cl.ws.RemoteAddr())
			drop(cl)
		}
	}
}

// rawJSON is a function's input or output as JSON: as it is when it's JSON,
// and as a string when it isn't, as a payload needn't be. Text that isn't
// UTF-8 is quoted too: the Console's browser closes a connection that sends
// it, and would again each time it connected and was sent what's kept.
func rawJSON(data []byte) json.RawMessage {
	if len(data) == 0 {
		return nil
	}
	if utf8.Valid(data) && json.Valid(data) {
		return json.RawMessage(data)
	}
	quoted, _ := json.Marshal(string(data))
	return quoted
}
