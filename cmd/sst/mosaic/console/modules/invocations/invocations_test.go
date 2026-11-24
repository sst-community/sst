package invocations

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/sst/sst/v3/cmd/sst/mosaic/aws"
	"github.com/sst/sst/v3/cmd/sst/mosaic/console"
)

func get(t *testing.T, h *console.Harness, request string) (*Payload, int) {
	t.Helper()
	w := h.Get("/api/invocations/" + request)
	if w.Code != 200 {
		return nil, w.Code
	}
	var p Payload
	if err := json.Unmarshal(w.Body.Bytes(), &p); err != nil {
		t.Fatal(err)
	}
	return &p, 200
}

func TestPayloads(t *testing.T) {
	h, err := console.NewHarness(Module{})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	h.Publish(&aws.FunctionInvokedEvent{FunctionID: "Api", WorkerID: "w1", RequestID: "r1", Input: []byte(`{"a":1}`)}, now)
	h.Publish(&aws.FunctionResponseEvent{FunctionID: "Api", WorkerID: "w1", RequestID: "r1", Output: []byte(`{"ok":true}`)}, now)
	h.Publish(&aws.FunctionInvokedEvent{FunctionID: "Api", WorkerID: "w1", RequestID: "r2", Input: []byte("x")}, now)
	h.Publish(&aws.FunctionErrorEvent{FunctionID: "Api", WorkerID: "w1", RequestID: "r2", ErrorMessage: "boom", Trace: []string{"at y"}}, now)

	p, _ := get(t, h, "r1")
	if p == nil || p.Input.Text != `{"a":1}` || p.Output.Text != `{"ok":true}` || p.Function != "Api" {
		t.Fatalf("r1 %+v", p)
	}
	p, _ = get(t, h, "r2")
	if p == nil || p.Output != nil || p.Error == nil || p.Error.Message != "boom" {
		t.Fatalf("r2 %+v", p)
	}
	if _, code := get(t, h, "nope"); code != 404 {
		t.Fatalf("unknown request: %d", code)
	}
	// nothing goes on the stream
	if msgs := h.Watch("invocations"); len(msgs) != 3 {
		t.Fatalf("snapshot %+v", msgs)
	}
}

func TestTruncated(t *testing.T) {
	b := body([]byte(strings.Repeat("é", maxPayload)))
	if !b.Truncated || b.Size != 2*maxPayload || len(b.Text) > maxPayload || !utf8.ValidString(b.Text) {
		t.Fatalf("size %d, kept %d, valid %v", b.Size, len(b.Text), utf8.ValidString(b.Text))
	}
	if b := body([]byte("small")); b.Truncated || b.Text != "small" {
		t.Fatalf("%+v", b)
	}
}

func TestBounded(t *testing.T) {
	h, _ := console.NewHarness(Module{})
	big := []byte(strings.Repeat("z", maxPayload*2))
	n := totalBytes/maxPayload + 50
	for i := 0; i < n; i++ {
		h.Publish(&aws.FunctionInvokedEvent{FunctionID: "Api", WorkerID: "w", RequestID: "r" + itoa(i), Input: big}, time.Now())
	}
	if _, code := get(t, h, "r0"); code != 404 {
		t.Fatalf("the oldest is still kept: %d", code)
	}
	if p, _ := get(t, h, "r"+itoa(n-1)); p == nil {
		t.Fatal("the newest isn't kept")
	}
}

func itoa(i int) string { b, _ := json.Marshal(i); return string(b) }
