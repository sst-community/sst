package console

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"time"
)

// Harness runs modules without the bus or a listener, for a module's tests:
// Publish hands them an event as the dispatcher would, Tick runs their every
// second, Watch connects a page and gives its snapshot, and Messages what it
// got since.
type Harness struct {
	c    *Console
	page *client
}

// NewHarness starts the modules, all of them on.
func NewHarness(modules ...Module) (*Harness, error) {
	names := make([]string, 0, len(modules))
	for _, m := range modules {
		names = append(names, m.Name())
	}
	c, err := New(context.Background(), Config{Available: modules, Modules: names})
	if err != nil {
		return nil, err
	}
	// a harness doesn't read the bus
	c.close()
	return &Harness{c: c}, nil
}

// Publish hands evt to the modules that handle it, as if it were published at
// now.
func (h *Harness) Publish(evt any, now time.Time) {
	h.c.now = now
	for _, fn := range h.c.handlers[reflect.TypeOf(evt)] {
		fn(evt)
	}
}

// Tick runs the modules' every second.
func (h *Harness) Tick(now time.Time) {
	h.c.now = now
	for _, fn := range h.c.ticks {
		fn(now)
	}
}

// Watch connects a page that shows the modules, with their tabs open, and
// gives what it starts with.
func (h *Harness) Watch(modules ...string) []Message {
	cl, snapshot := h.c.connect(modules)
	for _, m := range modules {
		cl.shown[m] = true
	}
	h.page = cl
	return decode(snapshot)
}

// Messages is what the page got since Watch, or since Messages was last
// called.
func (h *Harness) Messages() []Message {
	if h.page == nil {
		return nil
	}
	out := [][]byte{}
	for {
		select {
		case b, ok := <-h.page.ch:
			if !ok {
				return decode(out)
			}
			out = append(out, b)
		default:
			return decode(out)
		}
	}
}

// Get serves a request to the modules' routes, running what they ask of the
// dispatcher.
func (h *Harness) Get(path string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		h.c.mux.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		close(done)
	}()
	for {
		select {
		case fn := <-h.c.calls:
			fn()
		case <-done:
			return w
		}
	}
}

// Decode reads a message's data into v.
func Decode(m Message, v any) error {
	b, err := json.Marshal(m.Data)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

func decode(raw [][]byte) []Message {
	out := make([]Message, 0, len(raw))
	for _, b := range raw {
		var m Message
		if json.Unmarshal(b, &m) == nil {
			out = append(out, m)
		}
	}
	return out
}
