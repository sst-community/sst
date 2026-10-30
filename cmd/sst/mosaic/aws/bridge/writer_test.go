package bridge

import (
	"bytes"
	"context"
	"encoding/base64"
	"runtime"
	"sync"
	"testing"
	"time"
)

// publishedPackets is a Conn that keeps what's published to it, or with
// discard, only counts it.
type publishedPackets struct {
	mu      sync.Mutex
	packets []Packet
	discard bool
}

func (c *publishedPackets) Publish(ctx context.Context, channel string, event interface{}) error {
	if !c.discard {
		c.mu.Lock()
		c.packets = append(c.packets, event.(Packet))
		c.mu.Unlock()
	}
	return nil
}

func (c *publishedPackets) published() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.packets)
}

func (c *publishedPackets) Subscribe(ctx context.Context, channel string) (chan string, error) {
	return make(chan string), nil
}

// A message as small as a ping allocates about what it holds, not a 128 KB
// buffer up front and another after its last packet. sst dev sends a ping and a
// reply for every invocation, and each reply again 5 times.
func TestWriterAllocatesWhatAMessageHolds(t *testing.T) {
	conn := &publishedPackets{discard: true}
	const messages = 100
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	for range messages {
		w := newWriter(conn, "source", "channel", MessagePing)
		if _, err := w.Write([]byte("{}\n")); err != nil {
			t.Fatal(err)
		}
		if err := w.Close(); err != nil {
			t.Fatal(err)
		}
	}
	runtime.ReadMemStats(&after)
	// TotalAlloc counts the whole test binary, so the budget is generous on
	// purpose: a message allocates about 120 bytes, and before this it was 256 KB
	if perMessage := (after.TotalAlloc - before.TotalAlloc) / messages; perMessage > 4*1024 {
		t.Errorf("a 3-byte message allocated %d KB, want under 4 KB", perMessage/1024)
	}
}

// However a message is written, its packets hold it in order, each at most
// BUFFER_SIZE, with only the last one final.
func TestWriterSplitsAMessageIntoPackets(t *testing.T) {
	sizes := []int{0, 1, BUFFER_SIZE - 1, BUFFER_SIZE, BUFFER_SIZE + 1, 3*BUFFER_SIZE + 5}
	for _, size := range sizes {
		for _, chunk := range []int{1000, BUFFER_SIZE, 2*BUFFER_SIZE + 7} {
			message := make([]byte, size)
			for i := range message {
				message[i] = byte(i % 251)
			}
			conn := &publishedPackets{}
			w := newWriter(conn, "source", "channel", MessageResponse)
			for start := 0; start < size; start += chunk {
				if _, err := w.Write(message[start:min(start+chunk, size)]); err != nil {
					t.Fatal(err)
				}
			}
			if err := w.Close(); err != nil {
				t.Fatal(err)
			}

			// a message's requests go at once, so they're published in any order,
			// but each index once, with none missing
			seen := map[int]bool{}
			for _, p := range conn.packets {
				if p.Index < 0 || p.Index >= len(conn.packets) || seen[p.Index] {
					t.Fatalf("size %d, chunk %d: packet index %d is out of range or published twice", size, chunk, p.Index)
				}
				seen[p.Index] = true
			}
			var got []byte
			for i, p := range sortedByIndex(conn.packets) {
				data, _ := base64.StdEncoding.DecodeString(p.Data)
				if len(data) > BUFFER_SIZE {
					t.Errorf("size %d, chunk %d: packet %d holds %d bytes, over %d", size, chunk, i, len(data), BUFFER_SIZE)
				}
				if p.Index != i || p.Final != (i == len(conn.packets)-1) {
					t.Errorf("size %d, chunk %d: packet %d has index %d, final %v", size, chunk, i, p.Index, p.Final)
				}
				got = append(got, data...)
			}
			if !bytes.Equal(got, message) {
				t.Errorf("size %d, chunk %d: the packets hold %d bytes, not the %d written", size, chunk, len(got), size)
			}
		}
	}
}

// A streaming message publishes what each write holds straight away.
func TestStreamingWriterPublishesEachWrite(t *testing.T) {
	conn := &publishedPackets{}
	w := newWriter(conn, "source", "channel", MessageResponse)
	w.SetStreaming(true)
	for _, chunk := range []string{"first", "second"} {
		if _, err := w.Write([]byte(chunk)); err != nil {
			t.Fatal(err)
		}
	}
	// in the background, without waiting for the message to end
	for start := time.Now(); conn.published() < 2; time.Sleep(time.Millisecond) {
		if time.Since(start) > time.Second {
			t.Fatalf("2 writes published %d packets, want 2", conn.published())
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	var got []byte
	for _, p := range sortedByIndex(conn.packets) {
		data, _ := base64.StdEncoding.DecodeString(p.Data)
		got = append(got, data...)
	}
	if string(got) != "firstsecond" || !conn.packets[len(conn.packets)-1].Final {
		t.Errorf("the packets hold %q, last final %v", got, conn.packets[len(conn.packets)-1].Final)
	}
}

// BenchmarkWriter writes and publishes a message of each size, to a connection
// that discards it: go test -run '^$' -bench Writer ./cmd/sst/mosaic/aws/bridge/
func BenchmarkWriter(b *testing.B) {
	for _, c := range []struct {
		name string
		size int
	}{{"ping 3 B", 3}, {"reply 1 KB", 1024}, {"event 200 KB", 200 * 1024}} {
		b.Run(c.name, func(b *testing.B) {
			conn := &publishedPackets{discard: true}
			body := make([]byte, c.size)
			b.ReportAllocs()
			for b.Loop() {
				w := newWriter(conn, "source", "channel", MessageResponse)
				if _, err := w.Write(body); err != nil {
					b.Fatal(err)
				}
				if err := w.Close(); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

// socketPackets is a Conn that can publish over its socket, and says which way
// each packet went.
type socketPackets struct {
	mu                    sync.Mutex
	overHTTPS, overSocket int
	// how many requests went over HTTPS with PublishBatch
	requests int
}

func (c *socketPackets) Publish(ctx context.Context, channel string, event interface{}) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.overHTTPS++
	return nil
}

func (c *socketPackets) PublishBatch(ctx context.Context, channel string, events []interface{}) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.overHTTPS += len(events)
	c.requests++
	return nil
}

func (c *socketPackets) PublishBatchOverSocket(ctx context.Context, channel string, events []interface{}) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.overSocket += len(events)
	return nil
}

func (c *socketPackets) Subscribe(ctx context.Context, channel string) (chan string, error) {
	return make(chan string), nil
}

// A message goes over the socket only when its writer is told to, and only one
// that holds no more than a packet: one of BUFFER_SIZE is 2 packets, the second
// empty. A longer one goes in requests over HTTPS, several at once, so a write
// to the socket is no larger than a packet, as its timeout is sized for, and
// the socket stays under AppSync's limit for the rest.
func TestWriterPublishesOverTheSocketWhenTold(t *testing.T) {
	conn := &socketPackets{}
	w := newWriter(conn, "source", "channel", MessageResponse)
	w.SetOverSocket(true)
	if _, err := w.Write(bytes.Repeat([]byte("x"), BUFFER_SIZE)); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if conn.overSocket != 2 || conn.overHTTPS != 0 {
		t.Fatalf("published %d packets over the socket and %d over HTTPS, want 2 and 0", conn.overSocket, conn.overHTTPS)
	}

	conn = &socketPackets{}
	w = newWriter(conn, "source", "channel", MessageResponse)
	w.SetOverSocket(true)
	if _, err := w.Write(bytes.Repeat([]byte("x"), BUFFER_SIZE+5)); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if conn.overSocket != 0 || conn.overHTTPS != 2 || conn.requests != 1 {
		t.Fatalf("a message of more than a packet went %d over the socket and %d over HTTPS in %d requests, want 0, and 2 in 1", conn.overSocket, conn.overHTTPS, conn.requests)
	}

	conn = &socketPackets{}
	w = newWriter(conn, "source", "channel", MessageResponse)
	w.SetOverSocket(true)
	if _, err := w.Write(bytes.Repeat([]byte("x"), packetsPerPublish*BUFFER_SIZE)); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if conn.overSocket != 0 || conn.overHTTPS != packetsPerPublish+1 {
		t.Fatalf("a message of %d packets went %d over the socket and %d over HTTPS, want 0 and %d", packetsPerPublish+1, conn.overSocket, conn.overHTTPS, packetsPerPublish+1)
	}

	conn = &socketPackets{}
	w = newWriter(conn, "source", "channel", MessagePing)
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if conn.overSocket != 0 || conn.overHTTPS != 1 {
		t.Fatalf("a writer not told to published %d over the socket and %d over HTTPS, want 0 and 1", conn.overSocket, conn.overHTTPS)
	}
}

// A Conn that can't publish over a socket gets every packet through Publish.
func TestWriterOverSocketWithoutASocket(t *testing.T) {
	conn := &publishedPackets{}
	w := newWriter(conn, "source", "channel", MessageResponse)
	w.SetOverSocket(true)
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if len(conn.packets) != 1 {
		t.Fatalf("published %d packets, want 1", len(conn.packets))
	}
}
