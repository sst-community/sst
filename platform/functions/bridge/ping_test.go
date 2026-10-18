package main

import (
	"testing"

	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/bridge"
)

func TestIsPingFor(t *testing.T) {
	cases := []struct {
		msg  bridge.Message
		want bool
	}{
		{bridge.Message{Type: bridge.MessagePing, ID: "next-2"}, true},
		{bridge.Message{Type: bridge.MessagePing, ID: "next-1"}, false},
		{bridge.Message{Type: bridge.MessagePing}, false},
		{bridge.Message{Type: bridge.MessageResponse, ID: "next-2"}, false},
	}
	for _, c := range cases {
		if got := isPingFor(c.msg, "next-2"); got != c.want {
			t.Errorf("isPingFor(%+v, next-2) = %v, want %v", c.msg, got, c.want)
		}
	}
}
