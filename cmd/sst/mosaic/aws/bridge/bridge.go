package bridge

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"iter"
	"log/slog"

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

func sorted(ctx context.Context, sub chan string) iter.Seq[Packet] {
	return func(yield func(Packet) bool) {
		history := make(map[string]map[int]Packet)
		next := map[string]int{}
		for {
			select {
			case <-ctx.Done():
				return
			case msg := <-sub:
				var packet Packet
				json.Unmarshal([]byte(msg), &packet)
				slog.Info("got packet", "id", packet.ID, "type", packet.Type, "from", packet.Source)
				// A packet behind the cursor is a copy of one already passed on, as
				// the CLI sends a reply more than once. Drop it, so a copy only fills
				// in packets that are missing, and a finished message isn't kept.
				if packet.Index < next[packet.ID] {
					continue
				}
				unprocessed, ok := history[packet.ID]
				if !ok {
					unprocessed = map[int]Packet{}
					history[packet.ID] = unprocessed
				}
				unprocessed[packet.Index] = packet
				for {
					index := next[packet.ID]
					envelope, ok := unprocessed[index]
					if !ok {
						break
					}
					delete(unprocessed, index)
					next[envelope.ID] = index + 1
					if !yield(envelope) {
						return
					}
					if envelope.Final {
						delete(history, envelope.ID)
					}
				}
			}

		}
	}
}
