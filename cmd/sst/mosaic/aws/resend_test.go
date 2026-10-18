package aws

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/bridge"
	"github.com/sst/sst/v3/pkg/flag"
)

// countReplies counts the replies published to a bridge, by ID.
func countReplies(h *harness, b *fakeBridge) func(id string) int {
	sub, _ := h.appsync.Subscribe(h.ctx, h.prefix+"/"+b.workerID+"/in")
	var mu sync.Mutex
	counts := map[string]int{}
	go func() {
		for {
			select {
			case <-h.ctx.Done():
				return
			case data := <-sub:
				var p bridge.Packet
				json.Unmarshal([]byte(data), &p)
				if p.Type == bridge.MessageResponse && p.Index == 0 {
					mu.Lock()
					counts[p.ID]++
					mu.Unlock()
				}
			}
		}
	}()
	return func(id string) int {
		mu.Lock()
		defer mu.Unlock()
		return counts[id]
	}
}

// A bridge only sends its next invocation once it's done with the one before,
// so a reply isn't sent again after that. A reply nothing follows still is, in
// case AppSync dropped it.
func TestReplyIsNotResentOnceTheBridgeMovesOn(t *testing.T) {
	h := newHarness(t, &fakeRuntime{handle: echo})
	h.addFunction("fn")
	b := h.bridge("fn")
	sent := countReplies(h, b)
	for i := range 3 {
		if _, err := b.invoke("event"); err != nil {
			t.Fatalf("invocation %d: %v", i, err)
		}
	}
	time.Sleep(replyResendEvery + 500*time.Millisecond)

	for n := 1; n <= 2; n++ {
		if times := sent(fmt.Sprintf("%s-%d", b.workerID, n)); times != 1 {
			t.Errorf("the reply to invocation %d was sent %d times, want once", n, times)
		}
	}
	if times := sent(fmt.Sprintf("%s-3", b.workerID)); times < 2 {
		t.Errorf("the reply to the last invocation was sent %d times, want it sent again", times)
	}
}

// What a function printed is sent after its reply, and sent again too, when
// it goes to CloudWatch. Its resends don't stop the reply's, which the bridge
// still needs if AppSync didn't deliver the reply.
func TestReplyIsResentAfterItsOutput(t *testing.T) {
	logsOn := flag.SST_DEV_CLOUDWATCH_LOGS
	flag.SST_DEV_CLOUDWATCH_LOGS = true
	t.Cleanup(func() { flag.SST_DEV_CLOUDWATCH_LOGS = logsOn })
	h := newHarness(t, &fakeRuntime{handle: echo, prints: "hello"})
	h.addFunction("fn")
	b := h.bridge("fn")
	sent := countReplies(h, b)
	sub, _ := h.appsync.Subscribe(h.ctx, h.prefix+"/"+b.workerID+"/in")
	output := make(chan bridge.LogsBody, 10)
	go func() {
		for {
			select {
			case <-h.ctx.Done():
				return
			case data := <-sub:
				var p bridge.Packet
				json.Unmarshal([]byte(data), &p)
				if p.Type != bridge.MessageLogs {
					continue
				}
				raw, _ := base64.StdEncoding.DecodeString(p.Data)
				var body bridge.LogsBody
				json.Unmarshal(raw, &body)
				output <- body
			}
		}
	}()

	if _, err := b.invoke("event"); err != nil {
		t.Fatal(err)
	}
	select {
	case body := <-output:
		if len(body.Lines) != 1 || body.Lines[0] != "hello" {
			t.Fatalf("the output sent is %v, want the line printed", body.Lines)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the function's output wasn't sent")
	}
	time.Sleep(replyResendEvery + 500*time.Millisecond)
	if times := sent(b.workerID + "-1"); times < 2 {
		t.Errorf("the reply was sent %d times, want it sent again after its output", times)
	}
}
