// Package transporttest checks a transport against what bridge.Transport says
// its connection does, and checks that the bridge carries messages over it
// whole, with what a transport may do to events made to happen: losing,
// reordering and copying them. Each transport runs it in its own tests.
package transporttest

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/bridge"
	"github.com/sst/sst/v3/pkg/id"
)

// Options is the transport under test.
type Options struct {
	// Connect gives a new connection to the transport each time it's called,
	// as sst dev and a stub each have their own. Its connections should end
	// with the test.
	Connect func(t *testing.T) bridge.Conn
	// Reconnect makes conn connect again, as it does when it finds its
	// connection lost. The suite checks its subscriptions receive again after.
	// Without it, that test is skipped.
	Reconnect func(t *testing.T, conn bridge.Conn)
}

// Run runs the suite.
func Run(t *testing.T, o Options) {
	connect := o.Connect

	t.Run("delivers an event", func(t *testing.T) {
		ch := channels(t)
		publisher := connect(t)
		received := subscribe(t, connect(t), publisher, ch.dev)
		publish(t, publisher, ch.dev, map[string]any{"hello": "world"})
		if got := receive(t, received); got != `{"hello":"world"}` {
			t.Fatalf("received %s", got)
		}
	})

	t.Run("an event with no subscriber is no error", func(t *testing.T) {
		publish(t, connect(t), channels(t).dev, map[string]any{"hello": "nobody"})
	})

	t.Run("delivers the largest packet whole", func(t *testing.T) {
		ch := channels(t)
		publisher := connect(t)
		received := subscribe(t, connect(t), publisher, ch.dev)
		data := make([]byte, bridge.BUFFER_SIZE)
		rand.Read(data)
		packet := bridge.Packet{Type: bridge.MessageResponse, Source: "test", ID: "1", Data: base64.StdEncoding.EncodeToString(data), Final: true}
		publish(t, publisher, ch.dev, packet)
		var got bridge.Packet
		if err := json.Unmarshal([]byte(receive(t, received)), &got); err != nil {
			t.Fatal(err)
		}
		if got != packet {
			t.Fatal("the packet arrived changed")
		}
	})

	t.Run("receives again after reconnecting", func(t *testing.T) {
		if o.Reconnect == nil {
			t.Skip("the transport has no way to reconnect")
		}
		ch := channels(t)
		publisher, conn := connect(t), connect(t)
		received := subscribe(t, conn, publisher, ch.dev)
		o.Reconnect(t, conn)
		// events published while it reconnects may be lost
		live(t, func() { publish(t, publisher, ch.dev, ping) }, func(wait time.Duration) bool {
			_, ok := within(received, wait)
			return ok
		})
		publish(t, publisher, ch.dev, map[string]any{"after": "reconnecting"})
		if got := receive(t, received); got != `{"after":"reconnecting"}` {
			t.Fatalf("received %s", got)
		}
	})

	t.Run("carries a message whole", func(t *testing.T) {
		dev, stub := clients(t, connect(t), connect(t))
		body := message(1, 6*bridge.BUFFER_SIZE+100)
		if got := carry(t, dev, stub, body); got[0] != body {
			t.Fatalf("read %d bytes of %d", len(got[0]), len(body))
		}
	})

	t.Run("carries many messages at once", func(t *testing.T) {
		dev, stub := clients(t, connect(t), connect(t))
		var want []string
		for i := range 20 {
			want = append(want, message(i, (i%4)*bridge.BUFFER_SIZE+i*100+1))
		}
		got := carry(t, dev, stub, want...)
		slices.Sort(want)
		slices.Sort(got)
		if !slices.Equal(got, want) {
			t.Fatal("the messages didn't all arrive whole")
		}
	})

	// The stub asks for a packet it's missing, and sst dev sends it again, as
	// for a streamed reply, which isn't sent again whole
	t.Run("carries a message when a packet is lost", func(t *testing.T) {
		lossy := &losing{Conn: connect(t), index: 2}
		dev, stub := clients(t, lossy, connect(t))
		stub.AskForMissingOn(dev.channel)
		body := message(1, 4*bridge.BUFFER_SIZE)
		send(t, dev, stub.channel, body, true, "")
		if got, ok := read(stub, 30*time.Second); !ok || got != body {
			t.Fatalf("read %d bytes of %d", len(got), len(body))
		}
		if !lossy.lost() {
			t.Fatal("no packet was lost")
		}
	})

	t.Run("carries a message when packets arrive out of order", func(t *testing.T) {
		dev, stub := clients(t, &reversing{Conn: connect(t)}, connect(t))
		// more than one request's worth of packets, which go at once
		body := message(1, 12*bridge.BUFFER_SIZE+10)
		if got := carry(t, dev, stub, body); got[0] != body {
			t.Fatalf("read %d bytes of %d", len(got[0]), len(body))
		}
	})

	t.Run("carries a message when packets arrive twice", func(t *testing.T) {
		dev, stub := clients(t, &copying{Conn: connect(t)}, connect(t))
		body := message(1, 3*bridge.BUFFER_SIZE+10)
		if got := carry(t, dev, stub, body); got[0] != body {
			t.Fatalf("read %d bytes of %d", len(got[0]), len(body))
		}
		if _, ok := read(stub, 500*time.Millisecond); ok {
			t.Fatal("the message arrived twice")
		}
	})

	// What a small message takes from sst dev to the stub, which is most of
	// what the transport adds to an invocation. A transport may lose one,
	// which sst dev's resends cover, so a loss is reported, not failed.
	t.Run("the time it adds", func(t *testing.T) {
		dev, stub := clients(t, connect(t), connect(t))
		var took []time.Duration
		lost := 0
		for i := range 10 {
			body := message(i, 100)
			start := time.Now()
			send(t, dev, stub.channel, body, false, "")
			if !readThis(stub, body, 5*time.Second) {
				lost++
				continue
			}
			took = append(took, time.Since(start))
		}
		if len(took) == 0 {
			t.Fatal("no message arrived")
		}
		slices.Sort(took)
		t.Logf("a small message took %v at the median and %v at most, and %d of 10 were lost", took[len(took)/2], took[len(took)-1], lost)
	})
}

// channels are a test's own, so tests on a shared transport don't see each
// other's events: sst dev's, and a stub's.
type testChannels struct{ prefix, dev, stub string }

func channels(t *testing.T) testChannels {
	id := make([]byte, 8)
	rand.Read(id)
	prefix := "/sst/transporttest/" + hex.EncodeToString(id)
	return testChannels{prefix: prefix, dev: prefix + "/in", stub: prefix + "/worker/in"}
}

// what the suite publishes to see that a subscription receives, which a read
// after passes over, as one can arrive late
var ping = map[string]any{"ping": true}

const pingEvent = `{"ping":true}`

// subscribe subscribes conn to channel, and returns once the subscription
// receives what publisher publishes: a new one can miss events for a moment,
// as AppSync's does.
func subscribe(t *testing.T, conn, publisher bridge.Conn, channel string) chan string {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	received, err := conn.Subscribe(ctx, channel)
	if err != nil {
		t.Fatal(err)
	}
	live(t, func() { publish(t, publisher, channel, ping) }, func(wait time.Duration) bool {
		_, ok := within(received, wait)
		return ok
	})
	return received
}

// live pings until a ping is received.
func live(t *testing.T, ping func(), received func(wait time.Duration) bool) {
	t.Helper()
	for range 20 {
		ping()
		if received(500 * time.Millisecond) {
			return
		}
	}
	t.Fatal("the subscription never received anything")
}

func publish(t *testing.T, conn bridge.Conn, channel string, event any) {
	t.Helper()
	if err := conn.Publish(context.Background(), channel, event); err != nil {
		t.Fatal(err)
	}
}

// within is the next event received within wait, a ping or not.
func within(received chan string, wait time.Duration) (string, bool) {
	select {
	case event, ok := <-received:
		return event, ok
	case <-time.After(wait):
		return "", false
	}
}

// receive is the next event received that isn't a ping.
func receive(t *testing.T, received chan string) string {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		select {
		case event, ok := <-received:
			if !ok {
				t.Fatal("the subscription was closed")
			}
			if event != pingEvent {
				return event
			}
		case <-deadline:
			t.Fatal("nothing was received")
		}
	}
}

// client is sst dev's or a stub's, with the bodies of the messages it reads,
// each once it's whole.
type client struct {
	*bridge.Client
	channel string
	bodies  chan string
}

// clients are sst dev's and a stub's, each on its own connection.
func clients(t *testing.T, devConn, stubConn bridge.Conn) (client, client) {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	ch := channels(t)
	dev := newClient(ctx, bridge.NewClient(ctx, devConn, "dev", ch.prefix), ch.dev)
	stub := newClient(ctx, bridge.NewClient(ctx, stubConn, "worker", ch.prefix+"/worker"), ch.stub)
	// each side's subscription receives, as in subscribe
	for _, pair := range [][2]client{{dev, stub}, {stub, dev}} {
		from, to := pair[0], pair[1]
		live(t, func() { send(t, from, to.channel, pingBody, false, "") }, func(wait time.Duration) bool {
			select {
			case <-to.bodies:
				return true
			case <-time.After(wait):
				return false
			}
		})
	}
	return dev, stub
}

const pingBody = "ping"

// newClient reads each message's body as it comes, so one that's waiting for
// a packet doesn't hold up the next. A body that ends with an error, as one
// the bridge gave up on does, is left out.
func newClient(ctx context.Context, c *bridge.Client, channel string) client {
	bodies := make(chan string, 100)
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case msg := <-c.Read():
				go func() {
					body, err := io.ReadAll(msg.Body)
					if err != nil {
						return
					}
					select {
					case bodies <- string(body):
					case <-ctx.Done():
					}
				}()
			}
		}
	}()
	return client{c, channel, bodies}
}

func message(n, size int) string {
	head := fmt.Sprintf("message %d:", n)
	return head + strings.Repeat("x", max(size-len(head), 0))
}

// send sends body as a message, with id if it's given.
func send(t *testing.T, from client, to string, body string, streaming bool, id string) {
	t.Helper()
	w := from.NewWriter(bridge.MessageResponse, to)
	if id != "" {
		w.SetID(id)
	}
	w.SetStreaming(streaming)
	if _, err := io.WriteString(w, body); err != nil {
		t.Error(err)
		return
	}
	if err := w.Close(); err != nil {
		t.Error(err)
	}
}

// read is the next body that isn't a ping, read whole within wait.
func read(c client, wait time.Duration) (string, bool) {
	deadline := time.After(wait)
	for {
		select {
		case body := <-c.bodies:
			if body != pingBody {
				return body, true
			}
		case <-deadline:
			return "", false
		}
	}
}

// readThis is whether body is read whole within wait. Others read meanwhile,
// like one that arrived late, are passed over.
func readThis(c client, body string, wait time.Duration) bool {
	deadline := time.After(wait)
	for {
		select {
		case got := <-c.bodies:
			if got == body {
				return true
			}
		case <-deadline:
			return false
		}
	}
}

// carry sends each body from one client to the other, at once, and returns
// them as they're read. A transport may lose any packet, and the receiver of
// a message that isn't streamed doesn't ask for it, so a message that isn't
// read in a while is sent again with its ID, as sst dev sends a reply.
func carry(t *testing.T, from, to client, bodies ...string) []string {
	t.Helper()
	ids := map[string]string{}
	for _, body := range bodies {
		ids[body] = id.Ascending()
	}
	sendAll := func(bodies []string) {
		var sent sync.WaitGroup
		for _, body := range bodies {
			sent.Go(func() { send(t, from, to.channel, body, false, ids[body]) })
		}
		sent.Wait()
	}
	var got []string
	unread := slices.Clone(bodies)
	for range 6 {
		sendAll(unread)
		deadline := time.Now().Add(5 * time.Second)
		for len(unread) > 0 {
			body, ok := read(to, time.Until(deadline))
			if !ok {
				break
			}
			got = append(got, body)
			unread = slices.DeleteFunc(unread, func(b string) bool { return b == body })
		}
		if len(unread) == 0 {
			return got
		}
	}
	t.Fatalf("%d of %d messages never arrived whole", len(unread), len(bodies))
	return nil
}

// losing loses the first copy of the packet at index of each message it
// publishes, as a transport can.
type losing struct {
	bridge.Conn
	index int
	mu    sync.Mutex
	gone  map[string]bool
}

func (l *losing) Publish(ctx context.Context, channel string, event any) error {
	if packet, ok := event.(bridge.Packet); ok && packet.Type == bridge.MessageResponse && packet.Index == l.index {
		l.mu.Lock()
		first := !l.gone[packet.ID]
		if l.gone == nil {
			l.gone = map[string]bool{}
		}
		l.gone[packet.ID] = true
		l.mu.Unlock()
		if first {
			return nil
		}
	}
	return l.Conn.Publish(ctx, channel, event)
}

func (l *losing) lost() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.gone) > 0
}

// reversing holds each message's packets until it has them all, which the
// bridge publishes several requests at once, and publishes them last first.
type reversing struct {
	bridge.Conn
	mu   sync.Mutex
	held map[string]map[int]bridge.Packet
}

func (r *reversing) Publish(ctx context.Context, channel string, event any) error {
	packet, ok := event.(bridge.Packet)
	if !ok {
		return r.Conn.Publish(ctx, channel, event)
	}
	r.mu.Lock()
	if r.held == nil {
		r.held = map[string]map[int]bridge.Packet{}
	}
	if r.held[packet.ID] == nil {
		r.held[packet.ID] = map[int]bridge.Packet{}
	}
	held := r.held[packet.ID]
	held[packet.Index] = packet
	last := -1
	for _, p := range held {
		if p.Final {
			last = p.Index
		}
	}
	whole := last >= 0 && len(held) == last+1
	if whole {
		delete(r.held, packet.ID)
	}
	r.mu.Unlock()
	if !whole {
		return nil
	}
	for i := last; i >= 0; i-- {
		if err := r.Conn.Publish(ctx, channel, held[i]); err != nil {
			return err
		}
	}
	return nil
}

// copying publishes every event twice.
type copying struct{ bridge.Conn }

func (c *copying) Publish(ctx context.Context, channel string, event any) error {
	if err := c.Conn.Publish(ctx, channel, event); err != nil {
		return err
	}
	return c.Conn.Publish(ctx, channel, event)
}
