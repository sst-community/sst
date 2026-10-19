package bridge

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"iter"
	"log/slog"
	"slices"

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

	// dropped is passed on by sorted for a message whose first packets were
	// passed on, and that it dropped before it was whole
	dropped bool
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
)

type Message struct {
	ID         string
	Type       MessageType
	Source     string
	Body       io.Reader
	LogsFollow bool
}

// Conn is what the bridge needs from its AppSync connection.
type Conn interface {
	Publish(ctx context.Context, channel string, event interface{}) error
	Subscribe(ctx context.Context, channel string) (chan string, error)
}

var _ Conn = (*appsync.Connection)(nil)

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

const BUFFER_SIZE = 1024 * 128

// Write adds p to the message, publishing a packet each time BUFFER_SIZE
// bytes are waiting. The buffer grows as it's written, so a small message
// allocates about what it holds.
func (w *Writer) Write(p []byte) (int, error) {
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

func (w *Writer) Flush(final bool) error {
	if !final && len(w.buffer) == 0 {
		return nil
	}
	encoded := base64.StdEncoding.EncodeToString(w.buffer)
	err := w.conn.Publish(context.Background(), w.channel, Packet{
		ID:     w.id,
		Index:  w.index,
		Type:   w.message,
		Source: w.source,
		Data:   encoded,
		Final:  final,

		LogsFollow: w.logsFollow,
	})
	w.index++
	if err != nil {
		return err
	}
	// the packet holds its own copy, so the buffer is reused for the next one
	w.buffer = w.buffer[:0]
	return nil
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
	}
	go func() {
		for packet := range sorted(ctx, sub) {
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
// packet data, as it's sent, in base64. Past either, the one kept longest is
// dropped. It isn't counted as finished, so a whole copy of it, as the CLI
// sends of a reply, is still passed on.
var (
	maxWaiting      = 10_000
	maxWaitingBytes = 8 << 20
)

// waiting is a message that's being passed on, or waits for a packet.
type waiting struct {
	// next is the index of the packet to pass on next
	next  int
	held  map[int]Packet
	bytes int
}

func sorted(ctx context.Context, sub chan string) iter.Seq[Packet] {
	return func(yield func(Packet) bool) {
		perSet, mostWaiting, mostBytes := finishedPerSet, maxWaiting, maxWaitingBytes
		finished, finishedBefore := map[string]bool{}, map[string]bool{}
		messages := map[string]*waiting{}
		// the messages that have waited, the first first, some since finished
		order := []string{}
		heldBytes := 0
		for {
			select {
			case <-ctx.Done():
				return
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
						if len(finished) >= perSet {
							finished, finishedBefore = map[string]bool{}, finished
						}
						finished[envelope.ID] = true
						break
					}
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
