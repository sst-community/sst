package bridge

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
)

// heapAfter runs f, and returns how much the live heap grew while it ran.
func heapAfter(f func()) int64 {
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	f()
	runtime.GC()
	runtime.ReadMemStats(&after)
	return int64(after.HeapAlloc) - int64(before.HeapAlloc)
}

// sorted remembers where every message it has seen is up to, so that it can
// drop the copies the CLI sends of a reply. It never forgets one, so the
// memory grows with every message for as long as sst dev runs.
func TestSortedForgetsFinishedMessages(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sub := make(chan string, 1024)
	seen := make(chan string, 1024)
	go func() {
		for p := range sorted(ctx, sub, nil) {
			select {
			case seen <- p.ID:
			default:
			}
		}
	}()
	drain := func(id string) {
		for got := range seen {
			if got == id {
				return
			}
		}
	}
	grew := heapAfter(func() {
		for i := range 200_000 {
			sub <- packet(fmt.Sprintf("01JABCDEFGHJKMNPQRSTV%07d", i), 0, "{}", true)
		}
		sub <- packet("end", 0, "", true)
		drain("end")
	})
	if limit := int64(4 << 20); grew > limit {
		t.Fatalf("after 200,000 finished messages the heap grew by %d MB, want under %d MB", grew>>20, limit>>20)
	}
}

// A message that lost a packet is kept until it's whole, with the data of every
// packet that did arrive. One that never becomes whole is kept for good.
func TestSortedDropsMessagesThatNeverFinish(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sub := make(chan string, 1024)
	seen := make(chan string, 16)
	go func() {
		for p := range sorted(ctx, sub, nil) {
			seen <- p.ID
		}
	}()
	data := strings.Repeat("x", 64<<10)
	grew := heapAfter(func() {
		for i := range 500 {
			// packet 0 was lost, so packet 1 waits for it
			b, _ := json.Marshal(Packet{Type: MessageResponse, ID: fmt.Sprintf("lost-%d", i), Index: 1, Data: base64.StdEncoding.EncodeToString([]byte(data)), Final: true})
			sub <- string(b)
		}
		sub <- packet("end", 0, "", true)
		<-seen
	})
	if limit := int64(10 << 20); grew > limit {
		t.Fatalf("500 messages that never finished hold %d MB, want under %d MB", grew>>20, limit>>20)
	}
}

// with sets a package variable for a test.
func with[T any](t *testing.T, v *T, value T) {
	old := *v
	*v = value
	t.Cleanup(func() { *v = old })
}

// A copy of a message is dropped for at least finishedPerSet messages after it,
// longer than the CLI goes on sending copies.
func TestSortedDropsCopiesForAWhile(t *testing.T) {
	with(t, &finishedPerSet, 10)
	packets := []string{packet("first", 0, "x", true)}
	for i := range 10 {
		packets = append(packets, packet(fmt.Sprintf("m%d", i), 0, "x", true))
	}
	packets = append(packets, packet("first", 0, "x", true))
	got := passedOn(t, packets...)
	if slices.Contains(got[1:], "first/0") {
		t.Fatalf("a copy of a message was passed on again %d messages after it", 10)
	}
}

// A message waiting for a packet is put together when it comes, while others
// come and go.
func TestSortedWaitsForAMissingPacket(t *testing.T) {
	packets := []string{packet("slow", 1, "llo", true)}
	for i := range 100 {
		packets = append(packets, packet(fmt.Sprintf("m%d", i), 0, "x", true))
	}
	packets = append(packets, packet("slow", 0, "he", false))
	got := passedOn(t, packets...)
	if want := []string{"slow/0", "slow/1"}; !slices.Equal(got[len(got)-2:], want) {
		t.Fatalf("passed on %v last, want %v", got[len(got)-2:], want)
	}
}

// Past maxWaiting, the message that started waiting first is dropped, and the
// others are still put together.
func TestSortedDropsTheMessageWaitingLongest(t *testing.T) {
	with(t, &maxWaiting, 2)
	got := passedOn(t,
		packet("a", 1, "a", true),
		packet("b", 1, "b", true),
		// a is dropped
		packet("c", 1, "c", true),
		packet("b", 0, "b", false),
		packet("c", 0, "c", false),
	)
	if want := []string{"b/0", "b/1", "c/0", "c/1"}; !slices.Equal(got, want) {
		t.Fatalf("passed on %v, want %v", got, want)
	}
}

type fakeConn struct{ sub chan string }

func (c *fakeConn) Publish(ctx context.Context, channel string, event interface{}) error {
	return nil
}

func (c *fakeConn) Subscribe(ctx context.Context, channel string) (chan string, error) {
	return c.sub, nil
}

// A message dropped after its first packets were passed on ends with an error,
// so what reads it doesn't wait for the rest, or take what came for all of it.
func TestDroppedMessageEndsWithAnError(t *testing.T) {
	with(t, &maxWaiting, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	conn := &fakeConn{sub: make(chan string, 10)}
	client := NewClient(ctx, conn, "test", "test")
	conn.sub <- packet("cut", 0, "he", false)
	// another message waits, so the first is dropped
	conn.sub <- packet("other", 1, "x", true)

	msg := <-client.Read()
	if msg.ID != "cut" {
		t.Fatalf("got message %q, want %q", msg.ID, "cut")
	}
	done := make(chan error, 1)
	var body []byte
	go func() {
		var err error
		body, err = io.ReadAll(msg.Body)
		done <- err
	}()
	select {
	case err := <-done:
		if err != io.ErrUnexpectedEOF {
			t.Fatalf("reading the dropped message gave %q and %v, want io.ErrUnexpectedEOF", body, err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("reading the dropped message waited for the rest of it")
	}
}

// A copy of a packet that's held, as the CLI sends a reply again, counts once
// toward what waiting messages hold.
func TestSortedCountsACopyOnce(t *testing.T) {
	// the packet's data, in base64, is 8 bytes
	with(t, &maxWaitingBytes, 10)
	packets := []string{}
	for range 4 {
		packets = append(packets, packet("w", 1, "abcd", true))
	}
	packets = append(packets, packet("w", 0, "x", false))
	if got, want := passedOn(t, packets...), []string{"w/0", "w/1"}; !slices.Equal(got, want) {
		t.Fatalf("passed on %v, want %v", got, want)
	}
}

// A message that was dropped isn't counted as finished, so a whole copy that
// comes after, as the CLI sends of a reply, is still passed on.
func TestDroppedMessageIsPassedOnWhenACopyComes(t *testing.T) {
	with(t, &maxWaiting, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	conn := &fakeConn{sub: make(chan string, 10)}
	client := NewClient(ctx, conn, "test", "test")
	conn.sub <- packet("cut", 0, "he", false)
	conn.sub <- packet("other", 1, "x", true)
	first := <-client.Read()
	if _, err := io.ReadAll(first.Body); err != io.ErrUnexpectedEOF {
		t.Fatalf("reading the dropped message gave %v, want io.ErrUnexpectedEOF", err)
	}

	conn.sub <- packet("cut", 0, "he", false)
	conn.sub <- packet("cut", 1, "llo", true)
	select {
	case again := <-client.Read():
		body, err := io.ReadAll(again.Body)
		if again.ID != "cut" || err != nil || string(body) != "hello" {
			t.Fatalf("got %q with %q and %v, want the whole copy of cut", again.ID, body, err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the whole copy of the dropped message wasn't passed on")
	}
}

// A packet with no data is passed on as an empty chunk, not the nil that ends a
// dropped message with an error, so a message whose last packet is empty ends
// as usual.
func TestMessageWithAnEmptyLastPacketEnds(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	conn := &fakeConn{sub: make(chan string, 10)}
	client := NewClient(ctx, conn, "test", "test")
	conn.sub <- packet("m", 0, "hello", false)
	conn.sub <- packet("m", 1, "", true)
	msg := <-client.Read()
	body, err := io.ReadAll(msg.Body)
	if err != nil || string(body) != "hello" {
		t.Fatalf("read %q and %v, want %q and no error", body, err, "hello")
	}
}
