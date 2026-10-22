package appsync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/sst/sst/v3/pkg/id"
)

// A publish over the WebSocket reaches a subscriber about 50 ms sooner than one
// over HTTPS. But AppSync takes at most 25 publishes a second on one socket,
// and drops the rest without saying which, so the socket is kept under it, and
// every publish over it is backed by one over HTTPS.
var (
	// how many publishes go over the socket in any second, at most
	socketPublishesPerSecond = 15
	// how long a publish waits for AppSync to acknowledge it, before it's
	// published over HTTPS too. It's acknowledged in a round trip, so one that
	// takes longer was dropped, or the socket is gone.
	socketAckTimeout = 500 * time.Millisecond
	// how long a write to the socket can take. A packet takes a while on a slow
	// uplink, and one cut short could have AppSync close the socket, and its
	// subscription. A dead socket doesn't hold up a write, its publish just
	// isn't acknowledged.
	socketWriteTimeout = 10 * time.Second
	// how long publishes don't use the socket after one wasn't acknowledged,
	// as the socket may be dead, or after AppSync said it throttled one
	socketPauseAfterTimeout  = 30 * time.Second
	socketPauseAfterThrottle = time.Second
)

var errSocketUnavailable = errors.New("the socket isn't used for this publish")
var errSocketClosed = errors.New("the socket closed")
var errSocketThrottled = errors.New("AppSync throttled a publish on the socket")

// socket is one WebSocket connection, for publishing: what's waiting for an
// acknowledgement on it, whether it's closed, and its share of AppSync's limit,
// which is on each connection. A reconnect makes a new one.
type socket struct {
	conn    *websocket.Conn
	write   *sync.Mutex
	mu      sync.Mutex
	pending map[string]chan error
	closed  bool
	budget  socketBudget
}

func newSocket(conn *websocket.Conn, write *sync.Mutex) *socket {
	return &socket{conn: conn, write: write, pending: map[string]chan error{}}
}

// expect registers a publish, and gives the channel its outcome comes on.
func (s *socket) expect(publishID string) (chan error, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, false
	}
	ch := make(chan error, 1)
	s.pending[publishID] = ch
	return ch, true
}

func (s *socket) forget(publishID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.pending, publishID)
}

// resolve passes on what AppSync answered to a publish.
func (s *socket) resolve(publishID string, err error) {
	s.mu.Lock()
	ch, ok := s.pending[publishID]
	delete(s.pending, publishID)
	s.mu.Unlock()
	if ok {
		ch <- err
	}
}

// failAll fails every publish waiting on the socket, so each is published over
// HTTPS at once. When AppSync throttles a publish, it doesn't say which.
func (s *socket) failAll(err error, closed bool) {
	s.mu.Lock()
	pending := s.pending
	s.pending = map[string]chan error{}
	if closed {
		s.closed = true
	}
	s.mu.Unlock()
	for _, ch := range pending {
		ch <- err
	}
}

// send writes a message to the socket. Writes share one lock, as a WebSocket
// takes one writer at a time, and each has a deadline, so a socket that stopped
// taking data doesn't hold up the publish, or the next ones.
func (s *socket) send(msg interface{}) error {
	s.write.Lock()
	defer s.write.Unlock()
	s.conn.SetWriteDeadline(time.Now().Add(socketWriteTimeout))
	defer s.conn.SetWriteDeadline(time.Time{})
	return s.conn.WriteJSON(msg)
}

// handle reads what the socket's reader got about a publish, and says whether
// it was about one.
func (s *socket) handle(msg map[string]interface{}) bool {
	publishID, _ := msg["id"].(string)
	switch msg["type"] {
	case "publish_success":
		// a publish has one event, so one that failed is all of it
		if failed, ok := msg["failed"].([]interface{}); ok && len(failed) > 0 {
			s.resolve(publishID, fmt.Errorf("event not published: %v", failed))
			return true
		}
		s.resolve(publishID, nil)
		return true
	case "publish_error":
		s.resolve(publishID, fmt.Errorf("publish failed: %v", msg["errors"]))
		return true
	case "error":
		// A throttled publish isn't answered: AppSync says one was throttled,
		// and not which
		if strings.Contains(fmt.Sprint(msg["errors"]), "LimitExceededError") {
			log.Warn("publish over the socket throttled", "errors", fmt.Sprint(msg["errors"]))
			s.failAll(errSocketThrottled, false)
			return true
		}
	}
	return false
}

// socketBudget keeps the publishes over a socket under AppSync's limit, and off
// for a while after one went wrong. A new socket starts with a new one.
type socketBudget struct {
	mu       sync.Mutex
	sent     []time.Time
	offUntil time.Time
}

// take says whether a publish can go over the socket now, and counts it if so.
func (b *socketBudget) take(now time.Time) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if now.Before(b.offUntil) {
		return false
	}
	recent := b.sent[:0]
	for _, t := range b.sent {
		if now.Sub(t) < time.Second {
			recent = append(recent, t)
		}
	}
	b.sent = recent
	if len(b.sent) >= socketPublishesPerSecond {
		return false
	}
	b.sent = append(b.sent, now)
	return true
}

func (b *socketBudget) pause(now time.Time, d time.Duration) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if until := now.Add(d); until.After(b.offUntil) {
		b.offUntil = until
	}
}

func (c *Connection) currentSocket() *socket {
	c.socketLock.Lock()
	defer c.socketLock.Unlock()
	return c.socket
}

func (c *Connection) webSocket() *websocket.Conn {
	c.socketLock.Lock()
	defer c.socketLock.Unlock()
	return c.conn
}

// PublishOverSocket publishes an event as Publish does, over the connection's
// WebSocket where it can, which reaches a subscriber about 50 ms sooner. When
// the socket is over its share of AppSync's limit, or a publish on it isn't
// acknowledged in time, is throttled, or the socket is gone, the event is
// published over HTTPS, with Publish. So a subscriber can get it twice, as
// with Publish's retries.
func (c *Connection) PublishOverSocket(ctx context.Context, channel string, event interface{}) error {
	err := c.publishOverSocket(ctx, channel, event)
	if err == nil {
		return nil
	}
	if err != errSocketUnavailable {
		log.Info("publishing over HTTPS instead", "channel", channel, "err", err)
	}
	return c.Publish(ctx, channel, event)
}

func (c *Connection) publishOverSocket(ctx context.Context, channel string, event interface{}) error {
	s := c.currentSocket()
	if s == nil || !s.budget.take(time.Now()) {
		return errSocketUnavailable
	}
	eventJson, err := json.Marshal(event)
	if err != nil {
		return err
	}
	events := []string{string(eventJson)}
	// signed the same way as the HTTPS request's body
	auth, err := c.getAuth(ctx, map[string]interface{}{
		"channel": channel,
		"events":  events,
	})
	if err != nil {
		return err
	}
	publishID := id.Ascending()
	answer, ok := s.expect(publishID)
	if !ok {
		return errSocketClosed
	}
	err = s.send(map[string]interface{}{
		"type":          "publish",
		"id":            publishID,
		"channel":       channel,
		"events":        events,
		"authorization": auth,
	})
	if err != nil {
		s.forget(publishID)
		s.budget.pause(time.Now(), socketPauseAfterTimeout)
		// A WebSocket whose write failed takes no more, while it goes on reading
		// AppSync's keep-alives, so nothing would replace it. Closed, its reader
		// fails what's waiting on it, and reconnects.
		s.conn.Close()
		return err
	}
	timer := time.NewTimer(socketAckTimeout)
	defer timer.Stop()
	select {
	case err := <-answer:
		if err == errSocketThrottled {
			s.budget.pause(time.Now(), socketPauseAfterThrottle)
		}
		return err
	case <-timer.C:
		s.forget(publishID)
		s.budget.pause(time.Now(), socketPauseAfterTimeout)
		return errors.New("no acknowledgement")
	case <-ctx.Done():
		s.forget(publishID)
		return ctx.Err()
	}
}
