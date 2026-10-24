package bridge

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

// lossyAppSync delivers what's published to a channel to its subscribers, but
// drops, once each, the packets lose says to, as AppSync sometimes takes a
// publish and never delivers it.
type lossyAppSync struct {
	mu   sync.Mutex
	subs map[string][]chan string
	lose func(Packet) bool
	lost map[string]bool
	// what was published, by type
	published map[MessageType]int
}

func newLossyAppSync(lose func(Packet) bool) *lossyAppSync {
	return &lossyAppSync{subs: map[string][]chan string{}, lose: lose, lost: map[string]bool{}, published: map[MessageType]int{}}
}

func (f *lossyAppSync) Publish(ctx context.Context, channel string, event interface{}) error {
	packet := event.(Packet)
	data, _ := json.Marshal(packet)
	f.mu.Lock()
	f.published[packet.Type]++
	key := fmt.Sprintf("%s/%d", packet.ID, packet.Index)
	if f.lose != nil && f.lose(packet) && !f.lost[key] {
		f.lost[key] = true
		f.mu.Unlock()
		return nil
	}
	subs := f.subs[channel]
	f.mu.Unlock()
	for _, sub := range subs {
		sub <- string(data)
	}
	return nil
}

func (f *lossyAppSync) Subscribe(ctx context.Context, channel string) (chan string, error) {
	sub := make(chan string, 1000)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.subs[channel] = append(f.subs[channel], sub)
	return sub, nil
}

func (f *lossyAppSync) count(t MessageType) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.published[t]
}

// soon makes a test's asks come within milliseconds.
func soon(t *testing.T) {
	with(t, &askAfterGap, 50*time.Millisecond)
	with(t, &askAfterIdle, 150*time.Millisecond)
	with(t, &askAtMost, 400*time.Millisecond)
	with(t, &askEvery, 10*time.Millisecond)
}

// stream has sst dev's Client stream a message of chunks to a bridge's Client,
// as it streams a function's response, and gives what the bridge read.
func stream(t *testing.T, appsync *lossyAppSync, asks bool, chunks []string) (string, error) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	dev := NewClient(ctx, appsync, "dev", "/sst/app/stage")
	fn := NewClient(ctx, appsync, "worker", "/sst/app/stage/worker")
	if asks {
		fn.AskForMissingOn("/sst/app/stage/in")
	}
	w := dev.NewWriter(MessageResponse, "/sst/app/stage/worker/in")
	w.SetStreaming(true)
	for _, chunk := range chunks {
		if _, err := w.Write([]byte(chunk)); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case msg := <-fn.Read():
		read := make(chan string, 1)
		go func() {
			body, _ := io.ReadAll(msg.Body)
			read <- string(body)
		}()
		select {
		case body := <-read:
			return body, nil
		case <-time.After(3 * time.Second):
			return "", fmt.Errorf("the stream never ended")
		}
	case <-time.After(3 * time.Second):
		return "", fmt.Errorf("the stream never started")
	}
}

func chunks(n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = fmt.Sprintf("chunk %03d\n", i)
	}
	return out
}

// A streamed response that AppSync lost a packet of arrives whole: the bridge
// asks for it, and sst dev sends it again. Before, the bridge waited on it until
// the function timed out.
func TestStreamGetsAPacketThatWasLost(t *testing.T) {
	soon(t)
	appsync := newLossyAppSync(func(p Packet) bool { return p.Type == MessageResponse && p.Index == 3 })
	want := chunks(10)
	got, err := stream(t, appsync, true, want)
	if err != nil {
		t.Fatal(err)
	}
	if got != strings.Join(want, "") {
		t.Fatalf("got %q, want the 10 chunks", got)
	}
	// once, or again on a busy machine before the answer came
	if n := appsync.count(MessageResend); n < 1 {
		t.Errorf("asked %d times, want at least once", n)
	}
}

// A stream that goes on writing past a packet that was lost has it filled in
// as it goes, a gap's wait after it was lost, not once the stream ends: a
// stream can be long, and its caller reads it as it comes.
func TestStreamGetsALostPacketWhileItGoesOn(t *testing.T) {
	soon(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	appsync := newLossyAppSync(func(p Packet) bool { return p.Type == MessageResponse && p.Index == 3 })
	dev := NewClient(ctx, appsync, "dev", "/sst/app/stage")
	fn := NewClient(ctx, appsync, "worker", "/sst/app/stage/worker")
	fn.AskForMissingOn("/sst/app/stage/in")
	w := dev.NewWriter(MessageResponse, "/sst/app/stage/worker/in")
	w.SetStreaming(true)
	want := chunks(100)
	written := make(chan time.Time, 1)
	go func() {
		// 100 writes 20 ms apart, 2 s in all, against a gap's wait of 50 ms
		for _, chunk := range want {
			w.Write([]byte(chunk))
			time.Sleep(20 * time.Millisecond)
		}
		written <- time.Now()
		w.Close()
	}()
	var msg Message
	select {
	case msg = <-fn.Read():
	case <-time.After(3 * time.Second):
		t.Fatal("the stream never started")
	}
	// read up to past the lost chunk, and note when
	got := make([]byte, len(strings.Join(want[:10], "")))
	if _, err := io.ReadFull(msg.Body, got); err != nil {
		t.Fatal(err)
	}
	pastTheGap := time.Now()
	if string(got) != strings.Join(want[:10], "") {
		t.Fatalf("got %q, want the first 10 chunks", got)
	}
	rest, err := io.ReadAll(msg.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(got)+string(rest) != strings.Join(want, "") {
		t.Fatal("the stream isn't whole")
	}
	if done := <-written; !pastTheGap.Before(done.Add(-time.Second)) {
		t.Fatalf("the lost chunk was filled in %v before the stream was written, want a second or more", done.Sub(pastTheGap))
	}
}

// A gap that opens after a stream was quiet, and asked, and backed off, is
// asked for a gap's wait after, not after that backoff.
func TestGapAfterAQuietStreamAsksSoon(t *testing.T) {
	soon(t)
	with(t, &askAtMost, time.Hour)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sub := make(chan string, 100)
	asks := &asking{on: func() bool { return true }, timing: askTimingNow()}
	asked := make(chan Packet, 100)
	go func() {
		for packet := range sorted(ctx, sub, asks) {
			if packet.ask != nil {
				asked <- packet
			}
		}
	}()
	send := func(index int) {
		data, _ := json.Marshal(Packet{Type: MessageResponse, ID: "m", Index: index, Streaming: true})
		sub <- string(data)
	}
	send(0)
	// quiet, so it asks, and asks again after twice as long, and so on
	for range 3 {
		select {
		case <-asked:
		case <-time.After(5 * time.Second):
			t.Fatal("a quiet stream never asked")
		}
	}
	// then packet 1 is lost and 2 comes
	send(2)
	select {
	case ask := <-asked:
		if len(ask.ask.Missing) != 1 || ask.ask.Missing[0] != 1 {
			t.Fatalf("asked for %v, want 1", ask.ask.Missing)
		}
	case <-time.After(4 * askAfterGap):
		t.Fatal("the gap wasn't asked for within a gap's wait")
	}
}

// A streamed response that lost its last packets, its end among them, arrives
// whole: the bridge asks for what came after the last packet it has once it's
// heard nothing for a while.
func TestStreamGetsItsEndThatWasLost(t *testing.T) {
	soon(t)
	appsync := newLossyAppSync(func(p Packet) bool { return p.Type == MessageResponse && p.Index >= 8 })
	want := chunks(10)
	got, err := stream(t, appsync, true, want)
	if err != nil {
		t.Fatal(err)
	}
	if got != strings.Join(want, "") {
		t.Fatalf("got %q, want the 10 chunks", got)
	}
}

// A stream that lost nothing asks for nothing.
func TestStreamThatLostNothingAsksNothing(t *testing.T) {
	soon(t)
	appsync := newLossyAppSync(nil)
	want := chunks(10)
	got, err := stream(t, appsync, true, want)
	if err != nil {
		t.Fatal(err)
	}
	if got != strings.Join(want, "") {
		t.Fatalf("got %q, want the 10 chunks", got)
	}
	time.Sleep(4 * askAfterIdle)
	if n := appsync.count(MessageResend); n != 0 {
		t.Errorf("asked %d times, want none", n)
	}
}

// A bridge from before this doesn't ask, and its stream waits on what was lost
// as it always has. sst dev's packets kept for it change nothing.
func TestStreamToABridgeThatDoesNotAsk(t *testing.T) {
	soon(t)
	appsync := newLossyAppSync(func(p Packet) bool { return p.Type == MessageResponse && p.Index == 3 })
	if _, err := stream(t, appsync, false, chunks(10)); err == nil {
		t.Fatal("the stream ended, without its lost packet")
	}
	if n := appsync.count(MessageResend); n != 0 {
		t.Errorf("asked %d times, want none", n)
	}
}

// An ask that reaches an sst dev from before this, which doesn't answer, is
// passed on to it as a message it ignores. One for a message this sst dev
// didn't keep is answered with nothing.
func TestAskForWhatWasNotKept(t *testing.T) {
	soon(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	appsync := newLossyAppSync(nil)
	dev := NewClient(ctx, appsync, "dev", "/sst/app/stage")
	fn := NewClient(ctx, appsync, "worker", "/sst/app/stage/worker")
	fn.AskForMissingOn("/sst/app/stage/in")
	fn.ask(ResendBody{ID: "unknown", Missing: []int{1}, After: 4})
	time.Sleep(100 * time.Millisecond)
	if n := appsync.count(MessageResponse); n != 0 {
		t.Errorf("sent %d packets for a message it didn't keep, want none", n)
	}
	select {
	case msg := <-dev.Read():
		t.Fatalf("the ask was passed on as a message of type %d", msg.Type)
	default:
	}
}

// A message asks once it has waited on a gap, or once it's heard nothing for a
// while after it started, and again, each time twice as long after, until a
// packet comes. It asks for what's missing, and for anything after the last.
func TestWhenAMessageAsks(t *testing.T) {
	timing := askTiming{gap: time.Second, idle: 3 * time.Second, most: 4 * time.Second}
	start := time.Unix(1000, 0)
	at := func(d time.Duration) time.Time { return start.Add(d) }

	idle := &waiting{held: map[int]Packet{}, lastPacket: start, streamed: true}
	if _, ok := idle.askFor("m", at(time.Hour), timing); ok {
		t.Fatal("a message nothing came of asked")
	}

	// the gap opened at start, and packets went on coming past it since
	gap := &waiting{next: 2, held: map[int]Packet{4: {}, 6: {}}, gapSince: start, lastPacket: start.Add(900 * time.Millisecond), streamed: true}
	if _, ok := gap.askFor("m", at(999*time.Millisecond), timing); ok {
		t.Fatal("asked before it waited on its gap a second")
	}
	ask, ok := gap.askFor("m", at(time.Second), timing)
	if !ok || fmt.Sprint(ask.Missing) != "[2 3 5]" || ask.After != 6 {
		t.Fatalf("asked %+v, %v, want 2, 3 and 5 missing, and after 6", ask, ok)
	}
	for _, again := range []struct {
		at  time.Duration
		ask bool
	}{{1500 * time.Millisecond, false}, {2 * time.Second, true}, {3 * time.Second, false}, {4 * time.Second, true}, {8 * time.Second, true}, {11 * time.Second, false}, {12 * time.Second, true}} {
		if _, ok := gap.askFor("m", at(again.at), timing); ok != again.ask {
			t.Fatalf("at %v asked %v, want %v", again.at, ok, again.ask)
		}
	}

	many := &waiting{next: 0, held: map[int]Packet{5000: {}}, gapSince: start, lastPacket: start, streamed: true}
	ask, ok = many.askFor("m", at(time.Second), timing)
	if !ok || len(ask.Missing) != askAtMostMissing || ask.Missing[0] != 0 || ask.After != 5000 {
		t.Fatalf("asked for %d missing from %v, after %d, want the first %d, after 5000", len(ask.Missing), ask.Missing[:1], ask.After, askAtMostMissing)
	}
	if data, _ := json.Marshal(ask); len(data) > BUFFER_SIZE {
		t.Fatalf("an ask is %d bytes, more than a packet", len(data))
	}

	// a message that isn't streamed never asks, as its sender didn't keep it
	buffered := &waiting{next: 2, held: map[int]Packet{4: {}}, gapSince: start, lastPacket: start}
	if _, ok := buffered.askFor("m", at(time.Hour), timing); ok {
		t.Fatal("a message that isn't streamed asked")
	}

	tail := &waiting{next: 5, held: map[int]Packet{}, lastPacket: start, streamed: true}
	if _, ok := tail.askFor("m", at(2*time.Second), timing); ok {
		t.Fatal("asked after a stream was quiet 2 s, before 3")
	}
	ask, ok = tail.askFor("m", at(3*time.Second), timing)
	if !ok || len(ask.Missing) != 0 || ask.After != 4 {
		t.Fatalf("asked %+v, %v, want anything after 4", ask, ok)
	}
}

// sst dev keeps a streamed message's packets for keepSent after its last, and
// at most keepSentBytes of them, the oldest messages first, then the first
// packets of one that alone is more.
func TestSentPacketsAreKeptForAWhile(t *testing.T) {
	with(t, &keepSent, time.Minute)
	with(t, &keepSentBytes, 100)
	start := time.Unix(1000, 0)
	s := newSentPackets()
	packet := func(id string, index int) Packet {
		return Packet{ID: id, Index: index, Data: strings.Repeat("x", 10)}
	}
	for i := range 3 {
		s.keep("a/in", packet("a", i), start)
	}
	if channel, found := s.find(ResendBody{ID: "a", Missing: []int{1}, After: 1}, start); channel != "a/in" || len(found) != 2 || found[0].Index != 1 || found[1].Index != 2 {
		t.Fatalf("found %v on %q, want packets 1 and 2 on a/in", found, channel)
	}
	// a copy of a packet isn't kept twice
	s.keep("a/in", packet("a", 2), start)
	if s.bytes != 30 {
		t.Fatalf("kept %d bytes, want 30", s.bytes)
	}

	// one past keepSent is dropped when it's asked for, too
	if _, found := s.find(ResendBody{ID: "a", After: -1}, start.Add(90*time.Second)); len(found) != 0 || s.bytes != 0 {
		t.Fatalf("found %d packets, and kept %d bytes, of a message past keepSent", len(found), s.bytes)
	}
	for i := range 3 {
		s.keep("a/in", packet("a", i), start)
	}

	s.keep("b/in", packet("b", 0), start.Add(2*time.Minute))
	if _, found := s.find(ResendBody{ID: "a", After: -1}, start.Add(2*time.Minute)); len(found) != 0 {
		t.Fatalf("kept %d packets of a message past keepSent", len(found))
	}

	for i := 1; i < 15; i++ {
		s.keep("b/in", packet("b", i), start.Add(2*time.Minute))
	}
	if s.bytes > 100 {
		t.Fatalf("kept %d bytes, over %d", s.bytes, 100)
	}
	_, found := s.find(ResendBody{ID: "b", After: -1}, start.Add(2*time.Minute))
	if len(found) != 10 || found[0].Index != 5 {
		t.Fatalf("kept %d packets from %d, want the last 10", len(found), found[0].Index)
	}
}

// What's kept is ordered by when it was last written to, so a message past
// keepSent is dropped though one written to since is ahead of it, and over
// keepSentBytes, the one still being written is trimmed, not dropped.
func TestSentPacketsGoInTheOrderTheyWereWritten(t *testing.T) {
	with(t, &keepSent, time.Minute)
	with(t, &keepSentBytes, 100)
	start := time.Unix(1000, 0)
	packet := func(id string, index, size int) Packet {
		return Packet{ID: id, Index: index, Data: strings.Repeat("x", size)}
	}
	s := newSentPackets()
	s.keep("a/in", packet("a", 0, 10), start)
	s.keep("b/in", packet("b", 0, 10), start)
	// a goes on, b doesn't
	s.keep("a/in", packet("a", 1, 10), start.Add(90*time.Second))
	if _, found := s.find(ResendBody{ID: "b", After: -1}, start.Add(90*time.Second)); len(found) != 0 {
		t.Fatalf("kept %d packets of b, past keepSent behind a", len(found))
	}
	if _, found := s.find(ResendBody{ID: "a", After: -1}, start.Add(90*time.Second)); len(found) != 2 {
		t.Fatalf("kept %d packets of a, written to since, want 2", len(found))
	}

	// a fresh message over the limit, with an expired one after it in when
	// they started: the expired one goes, and the fresh one is trimmed
	s = newSentPackets()
	s.keep("a/in", packet("a", 0, 60), start)
	s.keep("b/in", packet("b", 0, 10), start)
	s.keep("a/in", packet("a", 1, 60), start.Add(90*time.Second))
	_, found := s.find(ResendBody{ID: "a", After: -1}, start.Add(90*time.Second))
	if len(found) != 1 || found[0].Index != 1 || s.bytes != 60 {
		t.Fatalf("kept %d packets of a, and %d bytes, want its last one, 60", len(found), s.bytes)
	}
}

// At most askAtMostAtOnce messages ask each time they're looked at, and the
// rest on the next look.
func TestAsksAreFewAtOnce(t *testing.T) {
	soon(t)
	with(t, &askAtMostAtOnce, 3)
	with(t, &askEvery, 100*time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sub := make(chan string, 100)
	asks := &asking{on: func() bool { return true }, timing: askTimingNow()}
	at := make(chan time.Time, 100)
	go func() {
		for range sorted(ctx, sub, asks) {
			at <- time.Now()
		}
	}()
	// 10 streamed messages that each hold a packet past a missing first one
	for i := range 10 {
		data, _ := json.Marshal(Packet{Type: MessageResponse, ID: fmt.Sprintf("m%d", i), Index: 1, Streaming: true})
		sub <- string(data)
	}
	// the asks of one look come together, and the next look's 100 ms after
	var looks [][]time.Time
	for len(looks) < 4 {
		select {
		case ask := <-at:
			if len(looks) == 0 || ask.Sub(looks[len(looks)-1][0]) > askEvery/2 {
				looks = append(looks, nil)
			}
			looks[len(looks)-1] = append(looks[len(looks)-1], ask)
		case <-time.After(5 * time.Second):
			t.Fatalf("%d looks asked, want 4", len(looks))
		}
	}
	for i, look := range looks {
		if len(look) > 3 {
			t.Fatalf("look %d had %d messages ask, want at most 3", i, len(look))
		}
	}
	if len(looks[0]) != 3 {
		t.Fatalf("the first look had %d messages ask, want 3", len(looks[0]))
	}
}

// A message that isn't streamed doesn't ask for what it's missing: it's sent
// again whole, and its sender didn't keep it.
func TestReplyThatLostAPacketDoesNotAsk(t *testing.T) {
	soon(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	appsync := newLossyAppSync(func(p Packet) bool { return p.Type == MessageResponse && p.Index == 1 })
	dev := NewClient(ctx, appsync, "dev", "/sst/app/stage")
	fn := NewClient(ctx, appsync, "worker", "/sst/app/stage/worker")
	fn.AskForMissingOn("/sst/app/stage/in")
	w := dev.NewWriter(MessageResponse, "/sst/app/stage/worker/in")
	if _, err := w.Write(bytes.Repeat([]byte("x"), 3*BUFFER_SIZE)); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	time.Sleep(4 * askAfterIdle)
	if n := appsync.count(MessageResend); n != 0 {
		t.Fatalf("asked %d times for a reply, want none", n)
	}
}

// Only a streamed message's packets are kept: a reply is sent again whole.
func TestOnlyAStreamIsKept(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	dev := NewClient(ctx, newLossyAppSync(nil), "dev", "/sst/app/stage")
	w := dev.NewWriter(MessageResponse, "worker/in")
	if _, err := w.Write(bytes.Repeat([]byte("x"), 3*BUFFER_SIZE)); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if dev.sent.bytes != 0 {
		t.Fatalf("kept %d bytes of a message that wasn't streamed", dev.sent.bytes)
	}
}
