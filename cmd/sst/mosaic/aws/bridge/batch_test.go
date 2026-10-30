package bridge

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math/rand"
	"sync"
	"testing"
	"time"
)

// batchPackets is a Conn that publishes a batch in one request. Each request
// takes delay, and fail, when it says so, fails one.
type batchPackets struct {
	delay time.Duration
	fail  func(batch []Packet) error

	mu       sync.Mutex
	requests [][]Packet
	// how many requests were in flight, now and at most
	inFlight, mostInFlight int
}

func (c *batchPackets) Publish(ctx context.Context, channel string, event interface{}) error {
	return c.PublishBatch(ctx, channel, []interface{}{event})
}

func (c *batchPackets) PublishBatch(ctx context.Context, channel string, events []interface{}) error {
	batch := make([]Packet, len(events))
	for i, event := range events {
		batch[i] = event.(Packet)
	}
	c.mu.Lock()
	c.requests = append(c.requests, batch)
	c.inFlight++
	c.mostInFlight = max(c.mostInFlight, c.inFlight)
	c.mu.Unlock()
	time.Sleep(c.delay)
	var err error
	if c.fail != nil {
		err = c.fail(batch)
	}
	c.mu.Lock()
	c.inFlight--
	c.mu.Unlock()
	return err
}

func (c *batchPackets) Subscribe(ctx context.Context, channel string) (chan string, error) {
	return make(chan string), nil
}

func (c *batchPackets) published() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.requests)
}

func (c *batchPackets) packets() []Packet {
	c.mu.Lock()
	defer c.mu.Unlock()
	var all []Packet
	for _, batch := range c.requests {
		all = append(all, batch...)
	}
	return all
}

func message(size int) []byte {
	body := make([]byte, size)
	for i := range body {
		body[i] = byte(i % 251)
	}
	return body
}

func writeMessage(t *testing.T, conn Conn, body []byte) error {
	t.Helper()
	w := newWriter(conn, "source", "channel", MessageResponse)
	if _, err := w.Write(body); err != nil {
		w.Close()
		return err
	}
	return w.Close()
}

// A 6 MB message, about Lambda's limit, goes in requests of up to 5 packets,
// not a request a packet, and every packet goes once.
func TestWriterBatchesAMessagesPackets(t *testing.T) {
	conn := &batchPackets{}
	body := message(6 << 20)
	if err := writeMessage(t, conn, body); err != nil {
		t.Fatal(err)
	}
	// 48 full packets and an empty last one, in 10 requests. Before, it was 49.
	if len(conn.requests) != 10 {
		t.Errorf("%d packets went in %d requests, want 10", len(conn.packets()), len(conn.requests))
	}
	for i, batch := range conn.requests {
		if len(batch) > packetsPerPublish {
			t.Errorf("request %d held %d packets, over %d", i, len(batch), packetsPerPublish)
		}
	}
	seen := map[int]bool{}
	var got []byte
	all := conn.packets()
	for _, p := range all {
		if seen[p.Index] {
			t.Fatalf("packet %d went twice", p.Index)
		}
		seen[p.Index] = true
	}
	for i := range all {
		if !seen[i] {
			t.Fatalf("packet %d never went", i)
		}
	}
	for _, p := range sortedByIndex(all) {
		data, _ := base64.StdEncoding.DecodeString(p.Data)
		got = append(got, data...)
		if p.Final != (p.Index == len(all)-1) {
			t.Errorf("packet %d has final %v", p.Index, p.Final)
		}
	}
	if !bytes.Equal(got, body) {
		t.Errorf("the packets hold %d bytes, not the %d written", len(got), len(body))
	}
}

func sortedByIndex(packets []Packet) []Packet {
	out := make([]Packet, len(packets))
	for _, p := range packets {
		out[p.Index] = p
	}
	return out
}

// Requests for a message go publishesInFlight at a time, so a message of many
// packets takes about as many round trips as it has requests over that.
func TestWriterKeepsRequestsInFlight(t *testing.T) {
	conn := &batchPackets{delay: 100 * time.Millisecond}
	start := time.Now()
	if err := writeMessage(t, conn, message(6<<20)); err != nil {
		t.Fatal(err)
	}
	took := time.Since(start)
	if conn.mostInFlight != publishesInFlight {
		t.Errorf("at most %d requests were in flight, want %d", conn.mostInFlight, publishesInFlight)
	}
	// 49 packets, in 10 requests, are 3 round trips of 100 ms. Before, a round
	// trip a packet, it took about 5 s.
	if took > time.Second {
		t.Errorf("a 6 MB message took %v over requests of 100 ms", took)
	}
}

// A request starts only once the one publishesInFlight before it is done, so a
// request that's slow doesn't let the rest of the message go on ahead of it, for
// the receiver to hold.
func TestWriterWaitsForTheOldestRequest(t *testing.T) {
	conn := &batchPackets{}
	slow := make(chan struct{})
	conn.fail = func(batch []Packet) error {
		if batch[0].Index == 0 {
			<-slow
		}
		return nil
	}
	done := make(chan error)
	go func() { done <- writeMessage(t, conn, message(6<<20)) }()
	started := func() int {
		conn.mu.Lock()
		defer conn.mu.Unlock()
		return len(conn.requests)
	}
	for start := time.Now(); started() < publishesInFlight && time.Since(start) < 5*time.Second; {
		time.Sleep(time.Millisecond)
	}
	// and no more go, however long it takes
	time.Sleep(200 * time.Millisecond)
	if started := started(); started != publishesInFlight {
		t.Errorf("with the first request slow, %d started, want %d", started, publishesInFlight)
	}
	close(slow)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

// A request that fails, after its retries, fails the message: the next Write
// or Close returns its error, and Close waits for the rest first.
func TestWriterReturnsAFailedRequestsError(t *testing.T) {
	failure := errors.New("throttled")
	conn := &batchPackets{delay: 5 * time.Millisecond}
	conn.fail = func(batch []Packet) error {
		if batch[0].Index == packetsPerPublish {
			return failure
		}
		return nil
	}
	if err := writeMessage(t, conn, message(6<<20)); !errors.Is(err, failure) {
		t.Fatalf("got %v, want the failed request's error", err)
	}
	conn.mu.Lock()
	defer conn.mu.Unlock()
	if conn.inFlight != 0 {
		t.Errorf("Close returned with %d requests in flight", conn.inFlight)
	}
	if len(conn.requests) == (6<<20/BUFFER_SIZE+1+packetsPerPublish-1)/packetsPerPublish {
		t.Errorf("all %d requests went after one failed", len(conn.requests))
	}

	// and a Write after the request failed returns its error, without
	// publishing more
	conn = &batchPackets{delay: time.Millisecond, fail: func(batch []Packet) error { return failure }}
	w := newWriter(conn, "source", "channel", MessageResponse)
	if _, err := w.Write(message(packetsPerPublish * BUFFER_SIZE)); err != nil {
		t.Fatalf("the first Write returned %v, before its request answered", err)
	}
	for start := time.Now(); w.failed() == nil; time.Sleep(time.Millisecond) {
		if time.Since(start) > 5*time.Second {
			t.Fatal("the request never finished")
		}
	}
	if _, err := w.Write(message(packetsPerPublish * BUFFER_SIZE)); !errors.Is(err, failure) {
		t.Fatalf("the next Write returned %v, want the failed request's error", err)
	}
	if err := w.Close(); !errors.Is(err, failure) {
		t.Fatalf("Close returned %v, want the failed request's error", err)
	}
	if got := len(conn.requests); got != 1 {
		t.Errorf("made %d requests, want 1, none after it failed", got)
	}

	// and a message of one request that failed returns its error again
	conn = &batchPackets{fail: func(batch []Packet) error { return failure }}
	w = newWriter(conn, "source", "channel", MessageResponse)
	if err := w.Close(); !errors.Is(err, failure) {
		t.Fatalf("Close returned %v, want the request's error", err)
	}
	if _, err := w.Write([]byte("x")); !errors.Is(err, failure) {
		t.Fatalf("a Write after it returned %v, want the request's error", err)
	}

	// and a message whose last request fails does too
	conn = &batchPackets{fail: func(batch []Packet) error {
		if batch[len(batch)-1].Final {
			return failure
		}
		return nil
	}}
	if err := writeMessage(t, conn, message(3*BUFFER_SIZE)); !errors.Is(err, failure) {
		t.Fatalf("got %v, want the last request's error", err)
	}
}

// A request that fails while the writer waits for the oldest one in flight
// stops the message there: no request starts after it. Here the first request
// is held, the second fails, and the writer, wanting a 5th, waits on the first.
func TestWriterStartsNothingAfterARequestFailed(t *testing.T) {
	failure := errors.New("throttled")
	held := make(chan struct{})
	failed := make(chan struct{})
	conn := &batchPackets{}
	conn.fail = func(batch []Packet) error {
		switch batch[0].Index {
		case 0:
			<-held
		case packetsPerPublish:
			// once all 4 are in flight, and the writer waits on the first
			for conn.published() < publishesInFlight {
				time.Sleep(time.Millisecond)
			}
			time.Sleep(50 * time.Millisecond)
			defer close(failed)
			return failure
		}
		return nil
	}
	go func() {
		<-failed
		// the second request's error is recorded once PublishBatch returns
		time.Sleep(50 * time.Millisecond)
		close(held)
	}()
	if err := writeMessage(t, conn, message(6<<20)); !errors.Is(err, failure) {
		t.Fatalf("got %v, want the failed request's error", err)
	}
	if got := conn.published(); got != publishesInFlight {
		t.Errorf("%d requests started, want %d, none after one failed", got, publishesInFlight)
	}
}

// shuffled is a Conn that delivers what's published to a subscriber, in an
// order it shuffles, a request at a time, as AppSync can.
type shuffled struct {
	mu   sync.Mutex
	rand *rand.Rand
	sub  chan string
}

func (c *shuffled) Publish(ctx context.Context, channel string, event interface{}) error {
	return c.PublishBatch(ctx, channel, []interface{}{event})
}

func (c *shuffled) PublishBatch(ctx context.Context, channel string, events []interface{}) error {
	c.mu.Lock()
	time.Sleep(time.Duration(c.rand.Intn(3)) * time.Millisecond)
	order := c.rand.Perm(len(events))
	c.mu.Unlock()
	for _, i := range order {
		data, _ := json.Marshal(events[i])
		c.sub <- string(data)
	}
	return nil
}

func (c *shuffled) Subscribe(ctx context.Context, channel string) (chan string, error) {
	return c.sub, nil
}

// Through a subscriber that gets the packets out of order, a message arrives
// whole and in order, streamed or not, at each size.
func TestBatchedMessageArrivesWhole(t *testing.T) {
	for _, streaming := range []bool{false, true} {
		for _, size := range []int{0, 1, BUFFER_SIZE, BUFFER_SIZE + 1, 1 << 20, 6 << 20} {
			ctx, cancel := context.WithCancel(context.Background())
			conn := &shuffled{rand: rand.New(rand.NewSource(int64(size))), sub: make(chan string, 1000)}
			client := NewClient(ctx, conn, "receiver", "prefix")
			body := message(size)
			w := newWriter(conn, "source", "channel", MessageResponse)
			w.SetStreaming(streaming)
			// written as a streamed response is, a chunk at a time
			for start := 0; start < size; start += 64 << 10 {
				if _, err := w.Write(body[start:min(start+64<<10, size)]); err != nil {
					t.Fatal(err)
				}
			}
			if err := w.Close(); err != nil {
				t.Fatal(err)
			}
			select {
			case msg := <-client.Read():
				got, err := io.ReadAll(msg.Body)
				if err != nil {
					t.Fatalf("streaming %v, size %d: %v", streaming, size, err)
				}
				if !bytes.Equal(got, body) {
					t.Errorf("streaming %v, size %d: got %d bytes, not the %d written", streaming, size, len(got), size)
				}
			case <-time.After(5 * time.Second):
				t.Fatalf("streaming %v, size %d: the message never arrived", streaming, size)
			}
			cancel()
		}
	}
}

// lateFirst is a Conn that delivers a message's first request only once the
// rest of its window has been, so its receiver holds as many packets early as
// the writer lets go ahead.
type lateFirst struct {
	sub   chan string
	mu    sync.Mutex
	early map[string]int
	first map[string]chan struct{}
}

func (c *lateFirst) Publish(ctx context.Context, channel string, event interface{}) error {
	return c.PublishBatch(ctx, channel, []interface{}{event})
}

func (c *lateFirst) PublishBatch(ctx context.Context, channel string, events []interface{}) error {
	id := events[0].(Packet).ID
	c.mu.Lock()
	release, ok := c.first[id]
	if !ok {
		release = make(chan struct{})
		c.first[id] = release
	}
	c.mu.Unlock()
	if events[0].(Packet).Index == 0 {
		<-release
	}
	for _, event := range events {
		data, _ := json.Marshal(event)
		c.sub <- string(data)
	}
	c.mu.Lock()
	c.early[id]++
	if c.early[id] == publishesInFlight-1 {
		close(release)
	}
	c.mu.Unlock()
	return nil
}

func (c *lateFirst) Subscribe(ctx context.Context, channel string) (chan string, error) {
	return c.sub, nil
}

// A burst of 10 invocations of 6 MB, each with its first request late, all
// arrive whole. With the 8 MB the receiver held before, they were dropped as
// messages that never finished.
func TestBurstOfLargeMessagesArrivesWhole(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	conn := &lateFirst{sub: make(chan string, 10_000), early: map[string]int{}, first: map[string]chan struct{}{}}
	client := NewClient(ctx, conn, "receiver", "prefix")
	const burst = 10
	body := message(6 << 20)
	var wg sync.WaitGroup
	for range burst {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := writeMessage(t, conn, body); err != nil {
				t.Error(err)
			}
		}()
	}
	var read sync.WaitGroup
	for range burst {
		select {
		case msg := <-client.Read():
			read.Add(1)
			go func() {
				defer read.Done()
				got, err := io.ReadAll(msg.Body)
				if err != nil || !bytes.Equal(got, body) {
					t.Errorf("a message arrived with %d bytes and %v, want %d", len(got), err, len(body))
				}
			}()
		case <-time.After(10 * time.Second):
			t.Fatal("a message never arrived")
		}
	}
	read.Wait()
	wg.Wait()
}
