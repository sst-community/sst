package aws

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"maps"
	"testing"
	"time"

	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/bridge"
	"github.com/sst/sst/v3/pkg/flag"
)

// overSocket is what the harness's AppSync got over its socket, by message type.
func overSocket(h *harness) map[bridge.MessageType]int {
	h.appsync.mu.Lock()
	defer h.appsync.mu.Unlock()
	return maps.Clone(h.appsync.overSocket)
}

// Only the first copy of a reply goes over the socket, as the bridge is waiting
// on it. Pings, reboots and the reply's resends go over HTTPS.
func TestOnlyARepliesFirstCopyGoesOverTheSocket(t *testing.T) {
	h := newHarness(t, &fakeRuntime{handle: echo})
	h.addFunction("fn")
	b := h.bridge("fn")
	for i := range 3 {
		if _, err := b.invoke(fmt.Sprintf("event %d", i)); err != nil {
			t.Fatalf("invocation %d: %v", i, err)
		}
	}
	// the last reply is resent, which goes over HTTPS
	time.Sleep(replyResendEvery + 500*time.Millisecond)
	got := overSocket(h)
	if got[bridge.MessageResponse] != 3 || len(got) != 1 {
		t.Fatalf("over the socket: %v, want the 3 replies' first copies only", got)
	}
}

// With SST_DEV_HTTP_PUBLISH, nothing goes over the socket.
func TestHTTPPublishKeepsRepliesOffTheSocket(t *testing.T) {
	httpOnly := flag.SST_DEV_HTTP_PUBLISH
	flag.SST_DEV_HTTP_PUBLISH = true
	t.Cleanup(func() { flag.SST_DEV_HTTP_PUBLISH = httpOnly })
	h := newHarness(t, &fakeRuntime{handle: echo})
	h.addFunction("fn")
	b := h.bridge("fn")
	if _, err := b.invoke("event"); err != nil {
		t.Fatal(err)
	}
	if got := overSocket(h); len(got) != 0 {
		t.Fatalf("over the socket: %v, want nothing", got)
	}
}

// With output sent to CloudWatch, the reply still goes over the socket, and
// says its output follows. The output goes over HTTPS, after the reply.
func TestOutputFollowsAReplyOverTheSocket(t *testing.T) {
	logsOn := flag.SST_DEV_CLOUDWATCH_LOGS
	flag.SST_DEV_CLOUDWATCH_LOGS = true
	t.Cleanup(func() { flag.SST_DEV_CLOUDWATCH_LOGS = logsOn })
	h := newHarness(t, &fakeRuntime{handle: echo, prints: "hello"})
	h.addFunction("fn")
	b := h.bridge("fn")
	sub, _ := h.appsync.Subscribe(h.ctx, h.prefix+"/"+b.workerID+"/in")
	if _, err := b.invoke("event"); err != nil {
		t.Fatal(err)
	}

	order := []bridge.MessageType{}
	var reply bridge.Packet
	var output bridge.LogsBody
	timeout := time.After(2 * time.Second)
read:
	for {
		select {
		case data := <-sub:
			var p bridge.Packet
			json.Unmarshal([]byte(data), &p)
			switch p.Type {
			case bridge.MessageResponse:
				if reply.ID == "" {
					reply = p
					order = append(order, p.Type)
				}
			case bridge.MessageLogs:
				raw, _ := base64.StdEncoding.DecodeString(p.Data)
				json.Unmarshal(raw, &output)
				order = append(order, p.Type)
				break read
			}
		case <-timeout:
			t.Fatalf("the output wasn't sent, got %v", order)
		}
	}
	if len(order) != 2 || order[0] != bridge.MessageResponse {
		t.Fatalf("got %v, want the reply, then its output", order)
	}
	if !reply.LogsFollow {
		t.Fatal("the reply doesn't say its output follows")
	}
	if len(output.Lines) != 1 || output.Lines[0] != "hello" || output.ReplyID != reply.ID {
		t.Fatalf("the output is %+v, want the line, for the reply %s", output, reply.ID)
	}
	if got := overSocket(h); got[bridge.MessageResponse] != 1 || got[bridge.MessageLogs] != 0 {
		t.Fatalf("over the socket: %v, want the reply only", got)
	}
}
