package bridge

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"iter"
	"log/slog"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/appsync"
	"github.com/sst/sst/v3/pkg/id"
)

type Packet struct {
	Type   MessageType `json:"type"`
	Source string      `json:"source"`
	ID     string      `json:"id"`
	Index  int         `json:"index"`
	Data   string      `json:"data"`
	Final  bool        `json:"final"`
	// LogsFollow says a MessageLogs follows this reply, with what the function
	// printed. A bridge from before it ignores it.
	LogsFollow bool `json:"logsFollow,omitempty"`
	// Streaming says the message is streamed, which its sender keeps to send
	// again, so its receiver asks for a packet it's missing. A sender from
	// before it doesn't say, and isn't asked.
	Streaming bool `json:"streaming,omitempty"`

	// dropped is passed on by sorted for a message whose first packets were
	// passed on, and that it dropped before it was whole
	dropped bool
	// ask is passed on by sorted for a message that's missing packets, for
	// its Client to ask for
	ask *ResendBody
}

type MessageType int

const (
	MessageInit MessageType = iota
	MessagePing
	MessageNext
	MessageResponse
	MessageError
	MessageReboot
	MessageInitError

	MessageTaskStart
	MessageTaskComplete

	MessageProbe

	// MessageLogs carries what a function printed in sst dev, for its bridge to
	// print in the function's log stream. A bridge from before it ignores it.
	MessageLogs

	// MessageResend asks a message's sender for the packets its receiver is
	// missing, with a ResendBody. The sender's Client answers it, and one from
	// before it ignores it.
	MessageResend
)

type Message struct {
	ID         string
	Type       MessageType
	Source     string
	Body       io.Reader
	LogsFollow bool
}

// Conn is the publish/subscribe transport used by the bridge.
type Conn interface {
	Publish(ctx context.Context, channel string, event interface{}) error
	Subscribe(ctx context.Context, channel string) (chan string, error)
}

// Connection also supports recovering a subscription after Lambda freezes.
type Connection interface {
	Conn
	Reconnect(context.Context)
}

var _ Connection = (*appsync.Connection)(nil)

// socketConn is a Conn that can publish over its WebSocket, which is faster.
type socketConn interface {
	PublishBatchOverSocket(ctx context.Context, channel string, events []interface{}) error
}

var _ socketConn = (*appsync.Connection)(nil)

// batchConn is a Conn that can publish several events in one request.
type batchConn interface {
	PublishBatch(ctx context.Context, channel string, events []interface{}) error
}

var _ batchConn = (*appsync.Connection)(nil)

type Writer struct {
	conn      Conn
	message   MessageType
	source    string
	channel   string
	buffer    []byte
	index     int
	id        string
	streaming bool

	// set on every packet, as the bridge reads it from the first that arrives
	logsFollow bool
	// publish over the connection's WebSocket where it can
	overSocket bool
	// keeps a streamed message's packets, to send again when asked
	sent *sentPackets

	// the packets waiting to be published together
	batch []Packet
	// the batches in flight, the oldest first, each closed when it's done
	inFlight []chan struct{}
	errLock  sync.Mutex
	err      error
}

// LogsBody is the body of a MessageLogs: the lines a worker printed up to the
// reply with the ID ReplyID, and how many more were left out.
type LogsBody struct {
	ReplyID string   `json:"replyID"`
	Lines   []string `json:"lines"`
	Dropped int      `json:"dropped,omitempty"`
}

type InitBody struct {
	FunctionID  string   `json:"functionID"`
	Environment []string `json:"environment"`
}

type TaskStartBody struct {
	TaskID      string   `json:"taskID"`
	Environment []string `json:"environment"`
}

type TaskCompleteBody struct {
}

type PingBody struct {
}

type RebootBody struct {
}

func newWriter(conn Conn, source string, channel string, message MessageType) *Writer {
	return &Writer{
		id:      id.Ascending(),
		conn:    conn,
		source:  source,
		message: message,
		channel: channel,
		index:   0,
	}
}

func (w *Writer) SetID(id string) {
	w.id = id
}

func (w *Writer) SetStreaming(streaming bool) {
	w.streaming = streaming
}

func (w *Writer) SetLogsFollow(logsFollow bool) {
	w.logsFollow = logsFollow
}

// SetOverSocket publishes the message over the AppSync connection's WebSocket
// where it can, which reaches the bridge sooner, and over HTTPS otherwise. Only
// a message that fits in one request and holds no more than a packet's data goes
// over it, in one publish: one of exactly BUFFER_SIZE is 2 packets, the second
// empty. A longer one, or a streamed one that's written to, goes in requests
// over HTTPS, several at once. See appsync.Connection.PublishBatchOverSocket.
func (w *Writer) SetOverSocket(overSocket bool) {
	w.overSocket = overSocket
}

const BUFFER_SIZE = 1024 * 128

// Write adds p to the message, making a packet each time BUFFER_SIZE bytes are
// waiting, and publishing them packetsPerPublish at a time in the background,
// or each one when it's streamed. A request that failed is returned by the next
// Write, or by Close. The buffer grows as it's written, so a small message
// allocates about what it holds.
func (w *Writer) Write(p []byte) (int, error) {
	if err := w.failed(); err != nil {
		return 0, err
	}
	total := 0

	for total < len(p) {
		toWrite := min(BUFFER_SIZE-len(w.buffer), len(p)-total)
		w.buffer = append(w.buffer, p[total:total+toWrite]...)
		total += toWrite
		if len(w.buffer) == BUFFER_SIZE {
			if err := w.Flush(false); err != nil {
				return total, err
			}
		}
	}
	if w.streaming && len(w.buffer) > 0 {
		if err := w.Flush(false); err != nil {
			return total, err
		}
	}
	return total, nil
}

// A message of more than one packet is published packetsPerPublish packets to a
// request, which is as many events as AppSync takes in one, with up to
// publishesInFlight requests at once. The receiver puts the packets back in
// order, as it does when AppSync delivers them out of order. A request waits
// for the one publishesInFlight before it, not only for any to finish, so the
// packets that arrive ahead of one that's late, and that the receiver holds,
// are at most that many requests' worth.
var (
	packetsPerPublish = appsync.MaxBatch
	publishesInFlight = 4
)

// Flush publishes what's buffered as the message's next packet, or its last.
// A message that fits in one request is published by its last Flush, which
// returns its error. A longer one's packets are published a batch at a time, in
// the background, so a failed one is returned by a later Flush, or by Close,
// which waits for them.
func (w *Writer) Flush(final bool) error {
	if !final && len(w.buffer) == 0 {
		return nil
	}
	if err := w.failed(); err != nil {
		if final {
			w.wait()
		}
		return err
	}
	packet := Packet{
		ID:     w.id,
		Index:  w.index,
		Type:   w.message,
		Source: w.source,
		Data:   base64.StdEncoding.EncodeToString(w.buffer),
		Final:  final,

		LogsFollow: w.logsFollow,
		Streaming:  w.streaming,
	}
	// a streamed message is sent once, so its packets are kept to send again
	if w.streaming && w.sent != nil {
		w.sent.keep(w.channel, packet, time.Now())
	}
	w.batch = append(w.batch, packet)
	w.index++
	// the packet holds its own copy, so the buffer is reused for the next one
	w.buffer = w.buffer[:0]
	if final && len(w.inFlight) == 0 {
		// A message that fits in one request, as nearly every one does, is
		// published in it now. It goes over the socket when told only if it
		// holds no more than a packet, 175 KB in base64, as a publish over it
		// always has: the socket's write timeout is sized for that, and one that
		// times out closes the socket, and its subscription.
		batch := w.batch
		w.batch = nil
		size := 0
		for _, packet := range batch {
			size += len(packet.Data)
		}
		if err := w.publish(batch, w.overSocket && size <= base64.StdEncoding.EncodedLen(BUFFER_SIZE)); err != nil {
			w.setFailed(err)
		}
		return w.failed()
	}
	if final || w.streaming || len(w.batch) == packetsPerPublish {
		w.send()
	}
	if final {
		w.wait()
	}
	return w.failed()
}

// send publishes the batch in the background, once the oldest batch in flight
// is done if there are publishesInFlight. If one failed meanwhile, the batch
// isn't published, as the message won't be whole. That's as soon as the failure
// is known: one still in flight can fail just after, and the batch goes.
func (w *Writer) send() {
	if len(w.inFlight) >= publishesInFlight {
		<-w.inFlight[0]
		w.inFlight = w.inFlight[1:]
	}
	batch := w.batch
	w.batch = nil
	if w.failed() != nil {
		return
	}
	done := make(chan struct{})
	w.inFlight = append(w.inFlight, done)
	go func() {
		defer close(done)
		if err := w.publish(batch, false); err != nil {
			w.setFailed(err)
		}
	}()
}

// publish publishes the packets in one request, over the connection's
// WebSocket where it can if overSocket, or one after another with a connection
// that can't.
func (w *Writer) publish(batch []Packet, overSocket bool) error {
	return publishPackets(context.Background(), w.conn, w.channel, batch, overSocket)
}

func publishPackets(ctx context.Context, as Conn, channel string, batch []Packet, overSocket bool) error {
	events := make([]interface{}, len(batch))
	for i, packet := range batch {
		events[i] = packet
	}
	if conn, ok := as.(socketConn); ok && overSocket {
		return conn.PublishBatchOverSocket(ctx, channel, events)
	}
	if conn, ok := as.(batchConn); ok {
		return conn.PublishBatch(ctx, channel, events)
	}
	for _, packet := range batch {
		if err := as.Publish(ctx, channel, packet); err != nil {
			return err
		}
	}
	return nil
}

// wait waits for every batch in flight.
func (w *Writer) wait() {
	for _, done := range w.inFlight {
		<-done
	}
	w.inFlight = nil
}

// setFailed keeps the first request that failed, for Write and Close to return.
func (w *Writer) setFailed(err error) {
	w.errLock.Lock()
	defer w.errLock.Unlock()
	if w.err == nil {
		w.err = err
	}
}

func (w *Writer) failed() error {
	w.errLock.Lock()
	defer w.errLock.Unlock()
	return w.err
}

func (w *Writer) Close() error {
	return w.Flush(true)
}

// ID is the ID the message is published with.
func (w *Writer) ID() string {
	return w.id
}

type Client struct {
	as      Conn
	prefix  string
	pending map[string]chan []byte
	out     chan Message
	source  string
	// the streamed messages it sent, and the channel it asks for what a
	// message it gets is missing, if it does
	sent  *sentPackets
	askOn atomic.Pointer[string]
	// the IDs of the messages it's sending again, so an ask that comes
	// meanwhile doesn't start another
	resending sync.Map
}

func NewClient(ctx context.Context, as Conn, source string, prefix string) *Client {
	slog.Info("subscribing to", "prefix", prefix+"/in")
	sub, _ := as.Subscribe(ctx, prefix+"/in")
	result := &Client{
		as:      as,
		source:  source,
		prefix:  prefix,
		pending: map[string]chan []byte{},
		out:     make(chan Message, 1000),
		sent:    newSentPackets(),
	}
	asks := &asking{
		on:     func() bool { return result.askOn.Load() != nil },
		timing: askTimingNow(),
	}
	go func() {
		for packet := range sorted(ctx, sub, asks) {
			if packet.ask != nil {
				go result.ask(*packet.ask)
				continue
			}
			if packet.Type == MessageResend {
				if ask, ok := readAsk(packet); ok {
					go result.resend(ctx, ask)
				}
				continue
			}
			pending, ok := result.pending[packet.ID]
			if packet.dropped {
				if ok {
					// its body ends with an error
					pending <- nil
					close(pending)
					delete(result.pending, packet.ID)
				}
				continue
			}
			if !ok {
				pending = make(chan []byte, 100)
				result.pending[packet.ID] = pending
				result.out <- Message{
					Type:       packet.Type,
					ID:         packet.ID,
					Source:     packet.Source,
					Body:       NewChannelReader(ctx, pending),
					LogsFollow: packet.LogsFollow,
				}
			}
			bytes, err := base64.StdEncoding.DecodeString(packet.Data)
			if err != nil {
				continue
			}
			pending <- bytes
			if packet.Final {
				close(pending)
				delete(result.pending, packet.ID)
			}
		}
	}()

	return result
}

func (c *Client) Read() <-chan Message {
	return c.out
}

func (c *Client) NewWriter(message MessageType, destination string) *Writer {
	writer := newWriter(c.as, c.source, destination, message)
	writer.sent = c.sent
	return writer
}

type ChannelReader struct {
	ch     chan []byte
	buffer []byte
	err    error
	ctx    context.Context
}

func NewChannelReader(ctx context.Context, ch chan []byte) *ChannelReader {
	return &ChannelReader{
		ch:     ch,
		buffer: nil,
		err:    nil,
		ctx:    ctx,
	}
}

func (r *ChannelReader) Read(p []byte) (n int, err error) {
	if len(r.buffer) == 0 && r.err == nil {
		select {
		case chunk, ok := <-r.ch:
			if !ok {
				return 0, io.EOF
			}
			// nil, not an empty packet's data, is sent for a message that was
			// dropped before it was whole
			if chunk == nil {
				r.err = io.ErrUnexpectedEOF
				return 0, r.err
			}
			r.buffer = chunk
		case <-r.ctx.Done():
			return 0, io.EOF
		}
	}
	if len(r.buffer) > 0 {
		n = copy(p, r.buffer)
		r.buffer = r.buffer[n:]
		return n, nil
	}

	if r.err != nil {
		return 0, r.err
	}
	return 0, io.EOF
}

// A copy of a message that was passed on whole is dropped, as the CLI sends a
// reply more than once, over 15 seconds. So the IDs of the messages passed on
// are kept, in two sets of finishedPerSet, the older dropped when the newer is
// full: for at least the last finishedPerSet messages.
var finishedPerSet = 10_000

// A message is passed on a packet at a time, in order, and is kept until its
// last packet comes. One that a packet is missing from waits for it, holding
// the packets that came after. At most maxWaiting messages are kept, the ones
// coming in as well as the ones waiting, holding at most maxWaitingBytes of
// packet data, as it's sent, in base64. A message's packets go in several
// requests at once, so a receiver holds a few of each that came early: a burst
// of 10 invocations of 6 MB at once held 21 MB at most. Past either, the one
// kept longest is dropped. A reply isn't counted as finished, so a whole copy
// of it, as the CLI sends, is still passed on. A stream is, as nothing sends it
// again whole.
var (
	maxWaiting      = 10_000
	maxWaitingBytes = 64 << 20
)

// waiting is a message that's being passed on, or waits for a packet.
type waiting struct {
	// next is the index of the packet to pass on next
	next  int
	held  map[int]Packet
	bytes int
	// when its last packet came, when the gap it waits on opened, if it does,
	// and when it asks again for what's missing, after how long
	lastPacket time.Time
	gapSince   time.Time
	// whether it's streamed, so its sender has kept it to send again
	streamed   bool
	askAgain   time.Time
	askedAfter time.Duration
}

// sorted passes on, as well, an ask for what a message is missing, when asks
// says the Client asks for it. With asks nil, it never does.
func sorted(ctx context.Context, sub chan string, asks *asking) iter.Seq[Packet] {
	return func(yield func(Packet) bool) {
		perSet, mostWaiting, mostBytes := finishedPerSet, maxWaiting, maxWaitingBytes
		finished, finishedBefore := map[string]bool{}, map[string]bool{}
		messages := map[string]*waiting{}
		// the messages that have waited, the first first, some since finished
		order := []string{}
		heldBytes := 0
		finish := func(id string) {
			if len(finished) >= perSet {
				finished, finishedBefore = map[string]bool{}, finished
			}
			finished[id] = true
		}
		var tick <-chan time.Time
		if asks != nil {
			ticker := time.NewTicker(asks.timing.every)
			defer ticker.Stop()
			tick = ticker.C
		}
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-tick:
				if !asks.on() {
					continue
				}
				asked := 0
				for id, message := range messages {
					if asked == asks.timing.atOnce {
						break
					}
					if ask, ok := message.askFor(id, now, asks.timing); ok {
						asked++
						if !yield(Packet{ID: id, ask: &ask}) {
							return
						}
					}
				}
			case msg := <-sub:
				var packet Packet
				json.Unmarshal([]byte(msg), &packet)
				slog.Info("got packet", "id", packet.ID, "type", packet.Type, "from", packet.Source)
				if finished[packet.ID] || finishedBefore[packet.ID] {
					continue
				}
				message, known := messages[packet.ID]
				if !known {
					message = &waiting{held: map[int]Packet{}}
					messages[packet.ID] = message
				}
				// A packet behind the cursor, or one held already, is a copy of
				// one already here. Drop it, so a copy only fills in packets that
				// are missing.
				if _, held := message.held[packet.Index]; held || packet.Index < message.next {
					continue
				}
				message.held[packet.Index] = packet
				message.streamed = message.streamed || packet.Streaming
				message.lastPacket = time.Now()
				passedOn := message.next
				message.bytes += len(packet.Data)
				heldBytes += len(packet.Data)
				for {
					envelope, ok := message.held[message.next]
					if !ok {
						break
					}
					delete(message.held, message.next)
					message.bytes -= len(envelope.Data)
					heldBytes -= len(envelope.Data)
					message.next++
					if !yield(envelope) {
						return
					}
					if envelope.Final {
						heldBytes -= message.bytes
						delete(messages, envelope.ID)
						finish(envelope.ID)
						break
					}
				}
				// A gap is timed from when it opened, not from the last packet, as
				// a stream goes on sending past one. Once the message moves on,
				// it's a new gap, if any, and it asks soon again.
				if message.next > passedOn {
					message.gapSince, message.askAgain, message.askedAfter = time.Time{}, time.Time{}, 0
				}
				if len(message.held) > 0 && message.gapSince.IsZero() {
					// a new gap, so it's asked for a gap's wait after, not after
					// the backoff of asks while the stream was quiet
					message.gapSince = message.lastPacket
					message.askAgain, message.askedAfter = time.Time{}, 0
				}
				if _, waits := messages[packet.ID]; waits && !known {
					order = append(order, packet.ID)
				}
				for len(order) > 0 && (len(messages) > mostWaiting || heldBytes > mostBytes) {
					id := order[0]
					order = order[1:]
					message, ok := messages[id]
					if !ok {
						continue
					}
					slog.Warn("dropping a message that never finished", "id", id, "passedOn", message.next, "held", len(message.held))
					delete(messages, id)
					heldBytes -= message.bytes
					// its first packets were passed on, so it's ended, as one that
					// won't be whole
					if message.next > 0 {
						// Nothing sends a stream again whole, so what comes of it
						// later, its next packets or an answer to an ask, would only
						// start it again as a new message, that nothing reads.
						if message.streamed {
							finish(id)
						}
						if !yield(Packet{ID: id, dropped: true}) {
							return
						}
					}
				}
				if len(order) > 2*len(messages)+64 {
					order = slices.DeleteFunc(order, func(id string) bool {
						_, waits := messages[id]
						return !waits
					})
				}
			}
		}
	}
}
