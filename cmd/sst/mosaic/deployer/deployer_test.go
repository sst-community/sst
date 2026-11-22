package deployer

import (
	"reflect"
	"testing"

	"github.com/sst/sst/v3/pkg/bus"
)

type publishInner struct {
	Ptr *int
	Num int
}

type publishOuter struct {
	First *string
	Inner publishInner
	Nil   *string
	Text  string
	Last  []int
}

// publishFields publishes, in order, each set pointer, slice, map, channel,
// func or interface field, going into nested structs, and a non-struct as is.
func TestPublishFields(t *testing.T) {
	s := "a"
	n := 7
	last := []int{1}

	cases := []struct {
		name string
		in   interface{}
		want []interface{}
	}{
		{"nested", &publishOuter{First: &s, Inner: publishInner{Ptr: &n, Num: 3}, Text: "x", Last: last}, []interface{}{&s, &n, last}},
		{"empty", publishOuter{}, nil},
		{"non-struct", 5, []interface{}{5}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ch := bus.SubscribeAll()
			defer bus.Unsubscribe(ch)
			publishFields(tc.in)
			var got []interface{}
			for len(ch) > 0 {
				got = append(got, <-ch)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %#v, want %#v", got, tc.want)
			}
		})
	}
}
