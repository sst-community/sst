package bridge

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"slices"
	"sync"
	"time"
)

// AppSync sometimes takes a publish and never delivers it. A reply is sent
// again, as a whole, so a lost packet is filled in from a copy, but a streamed
// one is sent once, as it's written, and a packet it lost left the receiver
// waiting on it until the function timed out. So the receiver asks for what it
// waits on, and the sender keeps a streamed message's packets to send again.
//
// A message that has packets waiting past one that's missing asks for it once
// it has waited askAfterGap. One that's started and gets nothing for
// askAfterIdle asks for whatever came after its last packet, in case it was
// the last ones that were lost. A message asks again, each time twice as long
// after, up to askAtMost, until a packet comes.
var (
	askAfterGap  = time.Second
	askAfterIdle = 3 * time.Second
	askAtMost    = 30 * time.Second
	// how often waiting messages are looked at
	askEvery = 250 * time.Millisecond
	// how many missing packets an ask names at most, a few KB of JSON
	askAtMostMissing = 1000
	// how many messages ask each time they're looked at, at most, so a backlog
	// doesn't add a burst of publishes to an Event API that's losing them
	askAtMostAtOnce = 20
)

// askTiming is the ask timings as a Client started, which it keeps.
type askTiming struct {
	gap, idle, most, every time.Duration
	atOnce                 int
}

// asking is whether a Client asks for what's missing, and when.
type asking struct {
	on     func() bool
	timing askTiming
}

func askTimingNow() askTiming {
	return askTiming{gap: askAfterGap, idle: askAfterIdle, most: askAtMost, every: askEvery, atOnce: askAtMostAtOnce}
}

// The sender keeps a streamed message's packets for keepSent after its last
// one, at most keepSentBytes of them, in base64, the oldest dropped first. One
// past keepSent is dropped when another packet is kept, or one is asked for, so
// what's kept after the last stream is at most keepSentBytes until then.
var (
	keepSent      = 2 * time.Minute
	keepSentBytes = 32 << 20
)

// ResendBody is the body of a MessageResend: the packets of the message with
// the ID that its receiver is missing, and that it has none after After.
type ResendBody struct {
	ID      string `json:"id"`
	Missing []int  `json:"missing,omitempty"`
	After   int    `json:"after"`
}

// sentMessage is a streamed message's packets, as they were published.
type sentMessage struct {
	channel string
	packets map[int]Packet
	bytes   int
	last    time.Time
}

// sentPackets keeps the packets of the streamed messages a Client sent.
type sentPackets struct {
	mu       sync.Mutex
	messages map[string]*sentMessage
	// the IDs of the messages kept, the one written to longest ago first, so
	// the ones past keepSent are first
	order []string
	bytes int
}

func newSentPackets() *sentPackets {
	return &sentPackets{messages: map[string]*sentMessage{}}
}

func (s *sentPackets) keep(channel string, packet Packet, now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	message, ok := s.messages[packet.ID]
	if !ok {
		message = &sentMessage{channel: channel, packets: map[int]Packet{}}
		s.messages[packet.ID] = message
	} else {
		// it moves to the end, as the one written to last
		s.order = slices.DeleteFunc(s.order, func(id string) bool { return id == packet.ID })
	}
	s.order = append(s.order, packet.ID)
	if _, kept := message.packets[packet.Index]; !kept {
		message.packets[packet.Index] = packet
		message.bytes += len(packet.Data)
		s.bytes += len(packet.Data)
	}
	message.last = now
	s.forget(now)
}

// forget drops the messages kept past keepSent, and the one written to longest
// ago while there's more than keepSentBytes. A message that alone is more drops
// its first packets, which its receiver most likely has.
func (s *sentPackets) forget(now time.Time) {
	for len(s.order) > 0 {
		id := s.order[0]
		message := s.messages[id]
		if now.Sub(message.last) <= keepSent && (s.bytes <= keepSentBytes || len(s.order) == 1) {
			break
		}
		s.order = s.order[1:]
		delete(s.messages, id)
		s.bytes -= message.bytes
	}
	if len(s.order) == 1 && s.bytes > keepSentBytes {
		message := s.messages[s.order[0]]
		indexes := make([]int, 0, len(message.packets))
		for index := range message.packets {
			indexes = append(indexes, index)
		}
		slices.Sort(indexes)
		for _, index := range indexes {
			if s.bytes <= keepSentBytes {
				break
			}
			size := len(message.packets[index].Data)
			delete(message.packets, index)
			message.bytes -= size
			s.bytes -= size
		}
	}
}

// find gives the packets kept that an ask is for, in order, and the channel
// they went to.
func (s *sentPackets) find(ask ResendBody, now time.Time) (string, []Packet) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.forget(now)
	message, ok := s.messages[ask.ID]
	if !ok {
		return "", nil
	}
	var found []Packet
	for _, index := range ask.Missing {
		if packet, ok := message.packets[index]; ok {
			found = append(found, packet)
		}
	}
	for index, packet := range message.packets {
		if index > ask.After && !slices.Contains(ask.Missing, index) {
			found = append(found, packet)
		}
	}
	slices.SortFunc(found, func(a, b Packet) int { return a.Index - b.Index })
	return message.channel, found
}

// resend publishes again the packets an ask is for, that the Client kept.
func (c *Client) resend(ctx context.Context, ask ResendBody) {
	channel, packets := c.sent.find(ask, time.Now())
	if len(packets) == 0 {
		return
	}
	slog.Info("sending packets again", "id", ask.ID, "packets", len(packets))
	for _, packet := range packets {
		if err := c.as.Publish(ctx, channel, packet); err != nil {
			slog.Warn("failed to send packets again", "id", ask.ID, "err", err)
			return
		}
	}
}

// AskForMissingOn has the Client ask for the packets a message it's receiving
// is missing, on the channel its sender reads. Without it, it doesn't ask.
func (c *Client) AskForMissingOn(channel string) {
	c.askOn.Store(&channel)
}

// ask publishes an ask for what a message is missing, if the Client asks.
func (c *Client) ask(ask ResendBody) {
	channel := c.askOn.Load()
	if channel == nil {
		return
	}
	slog.Info("asking for missing packets", "id", ask.ID, "missing", ask.Missing, "after", ask.After)
	w := newWriter(c.as, c.source, *channel, MessageResend)
	data, err := json.Marshal(ask)
	if err == nil {
		_, err = w.Write(data)
	}
	if err == nil {
		err = w.Close()
	}
	if err != nil {
		slog.Warn("failed to ask for missing packets", "id", ask.ID, "err", err)
	}
}

// readAsk reads an ask from its packet, which is the whole of it.
func readAsk(packet Packet) (ResendBody, bool) {
	var ask ResendBody
	data, err := base64.StdEncoding.DecodeString(packet.Data)
	if err != nil || json.Unmarshal(data, &ask) != nil || ask.ID == "" {
		return ask, false
	}
	return ask, true
}

// askFor says what a waiting message should ask for now, if anything, and
// notes that it asked.
func (m *waiting) askFor(id string, now time.Time, timing askTiming) (ResendBody, bool) {
	// a gap since it opened, or nothing at all since the last packet
	waitedFor, since := timing.idle, m.lastPacket
	if len(m.held) > 0 {
		waitedFor, since = timing.gap, m.gapSince
	}
	if m.next == 0 && len(m.held) == 0 {
		// nothing came yet, so there's nothing to ask about
		return ResendBody{}, false
	}
	if now.Sub(since) < waitedFor || now.Before(m.askAgain) {
		return ResendBody{}, false
	}
	ask := ResendBody{ID: id, After: m.next - 1}
	for index := range m.held {
		ask.After = max(ask.After, index)
	}
	// at most askAtMostMissing, so the ask is one packet, which is all its
	// sender reads: the ones past it are asked for once these come
	for index := m.next; index < ask.After && len(ask.Missing) < askAtMostMissing; index++ {
		if _, ok := m.held[index]; !ok {
			ask.Missing = append(ask.Missing, index)
		}
	}
	if m.askedAfter == 0 {
		m.askedAfter = waitedFor
	} else {
		m.askedAfter = min(2*m.askedAfter, timing.most)
	}
	m.askAgain = now.Add(m.askedAfter)
	return ask, true
}
