// Package invocations is the console's invocations module: each function
// invocation's input and output, truncated, and its error and trace. It adds
// them to the logs module's invocations, which it turns on.
//
// It sends no messages, so the stream stays light: the page asks for an
// invocation's payloads when it's opened, with
// GET /api/invocations/{request}, which answers with a Payload, or 404 once
// it's no longer kept.
package invocations

import (
	"container/list"
	"context"
	"embed"
	"encoding/json"
	"io/fs"
	"net/http"
	"unicode/utf8"

	"github.com/sst/sst/v3/cmd/sst/mosaic/aws"
	"github.com/sst/sst/v3/cmd/sst/mosaic/console"
)

//go:embed web
var web embed.FS

const (
	// how much of an input or an output is kept
	maxPayload = 64 << 10
	// how many invocations' payloads are kept, and how much they take
	// together, before the oldest go
	maxEntries = 2000
	totalBytes = 32 << 20
)

type Module struct{}

func (Module) Name() string       { return "invocations" }
func (Module) Title() string      { return "" }
func (Module) Web() fs.FS         { return must(fs.Sub(web, "web")) }
func (Module) Requires() []string { return []string{"logs"} }

// Body is an input or an output: Text is the first maxPayload bytes, and Size
// how big it was.
type Body struct {
	Text      string `json:"text"`
	Size      int    `json:"size"`
	Truncated bool   `json:"truncated,omitempty"`
}

type Payload struct {
	Request  string `json:"request"`
	Function string `json:"function"`
	Worker   string `json:"worker"`
	Input    *Body  `json:"input,omitempty"`
	Output   *Body  `json:"output,omitempty"`
	Error    *Error `json:"error,omitempty"`

	size int
	elem *list.Element
}

type Error struct {
	Type    string   `json:"type,omitempty"`
	Message string   `json:"message"`
	Trace   []string `json:"trace,omitempty"`
}

type store struct {
	byRequest map[string]*Payload
	order     *list.List
	size      int
}

func (Module) Start(ctx context.Context, c *console.Console) error {
	s := &store{byRequest: map[string]*Payload{}, order: list.New()}
	c.On(&aws.FunctionInvokedEvent{}, func(evt any) {
		e := evt.(*aws.FunctionInvokedEvent)
		p := s.get(e.RequestID, e.FunctionID, e.WorkerID)
		s.set(p, &p.Input, body(e.Input))
	})
	c.On(&aws.FunctionResponseEvent{}, func(evt any) {
		e := evt.(*aws.FunctionResponseEvent)
		p := s.get(e.RequestID, e.FunctionID, e.WorkerID)
		s.set(p, &p.Output, body(e.Output))
	})
	c.On(&aws.FunctionErrorEvent{}, func(evt any) {
		e := evt.(*aws.FunctionErrorEvent)
		if e.RequestID == "" {
			return
		}
		p := s.get(e.RequestID, e.FunctionID, e.WorkerID)
		p.Error = &Error{Type: e.ErrorType, Message: e.ErrorMessage, Trace: e.Trace}
		n := len(e.ErrorMessage)
		for _, t := range e.Trace {
			n += len(t)
		}
		p.size += n
		s.size += n
		s.evict()
	})
	c.Handle("GET /api/invocations/{request}", func(w http.ResponseWriter, r *http.Request) {
		request := r.PathValue("request")
		var found []byte
		err := c.Do(r.Context(), func() {
			if p, ok := s.byRequest[request]; ok {
				found, _ = json.Marshal(p)
			}
		})
		if err != nil {
			return
		}
		if found == nil {
			http.Error(w, "not kept", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(found)
	})
	return nil
}

func (s *store) get(request, function, worker string) *Payload {
	if p, ok := s.byRequest[request]; ok {
		return p
	}
	p := &Payload{Request: request, Function: function, Worker: worker}
	p.elem = s.order.PushBack(p)
	s.byRequest[request] = p
	return p
}

func (s *store) set(p *Payload, field **Body, b *Body) {
	if *field != nil {
		p.size -= len((*field).Text)
		s.size -= len((*field).Text)
	}
	*field = b
	p.size += len(b.Text)
	s.size += len(b.Text)
	s.evict()
}

func (s *store) evict() {
	for s.order.Len() > 1 && (s.order.Len() > maxEntries || s.size > totalBytes) {
		p := s.order.Front().Value.(*Payload)
		s.order.Remove(p.elem)
		delete(s.byRequest, p.Request)
		s.size -= p.size
	}
}

// body keeps the first maxPayload bytes, cut where a character starts.
func body(b []byte) *Body {
	out := &Body{Size: len(b)}
	if len(b) > maxPayload {
		cut := maxPayload
		for cut > 0 && !utf8.RuneStart(b[cut]) {
			cut--
		}
		b = b[:cut]
		out.Truncated = true
	}
	out.Text = string(b)
	return out
}

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}
