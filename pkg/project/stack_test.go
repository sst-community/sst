package project

import (
	"reflect"
	"testing"

	"github.com/pulumi/pulumi/sdk/v3/go/auto/events"
	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
)

type notNilInner struct {
	Ptr   *int
	Slice []string
	Num   int
}

type notNilOuter struct {
	First  *string
	Inner  notNilInner
	Nil    *string
	Map    map[string]int
	Any    interface{}
	Fn     func()
	Text   string
	Last   []int
	NilMap map[string]int
}

// getNotNilFields walks the fields in order, goes into nested structs, keeps
// set pointers, interfaces, slices, maps, channels and funcs, and skips nil
// ones and plain values.
func TestGetNotNilFields(t *testing.T) {
	s := "a"
	n := 7
	m := map[string]int{"x": 1}
	inner := notNilInner{Ptr: &n, Slice: []string{"b"}, Num: 3}

	got := getNotNilFields(&notNilOuter{
		First: &s,
		Inner: inner,
		Map:   m,
		Any:   42,
		Text:  "skipped",
		Last:  []int{1},
	})
	want := []interface{}{&s, &n, []string{"b"}, m, 42, []int{1}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}

	if got := getNotNilFields(notNilOuter{}); len(got) != 0 {
		t.Fatalf("empty struct: got %#v, want none", got)
	}
	if got := getNotNilFields("plain"); !reflect.DeepEqual(got, []interface{}{"plain"}) {
		t.Fatalf("non-struct: got %#v", got)
	}
}

// An engine event gives back only the event part that is set, which is what
// PublishEngineEvent sends on the bus.
func TestGetNotNilFieldsEngineEvent(t *testing.T) {
	diag := &apitype.DiagnosticEvent{Message: "hi"}
	got := getNotNilFields(events.EngineEvent{
		EngineEvent: apitype.EngineEvent{Sequence: 1, Timestamp: 2, DiagnosticEvent: diag},
	})
	if !reflect.DeepEqual(got, []interface{}{diag}) {
		t.Fatalf("got %#v", got)
	}
}
