package appsync

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/gorilla/websocket"
)

// fakeEventAPI stands in for an Event API. Its HTTPS endpoint takes publishes,
// and its WebSocket takes subscribes and publishes, and answers each publish as
// its mode says: "ack", "failed" (a publish_success that lists the event as
// failed), "silent" (no answer, as for a throttled one), "error"
// (a publish_error), "throttle" (AppSync's LimitExceededError, which names no
// publish), "close" (the socket closes) or "stall" (the socket isn't read
// from, as one that stopped taking data, and the next one is as "ack").
type fakeEventAPI struct {
	t   *testing.T
	srv *httptest.Server

	mu   sync.Mutex
	mode string
	// refuse is how many connects to turn down, as a new Event API does
	refuse int
	// silent is how many connects to never answer
	silent int
	// refuseWith is the error a refused connect gets, AppSync's for an Event
	// API it can't find yet unless it's set
	refuseWith map[string]interface{}
	// refuseSubscribes is how many subscribes to answer with an error, as a
	// namespace just created does
	refuseSubscribes int
	subscribeErrors  int
	// lateSubscribe leaves the first subscribe unanswered until the next one
	// comes, and then answers it with an error, just before the next one's
	// success
	lateSubscribe bool
	lateID        interface{}
	subscribes    int
	// refused is how many it turned down, and closedRefused how many of those
	// sockets the client closed
	refused         int
	closedRefused   int
	socketPublishes []map[string]interface{}
	httpPublishes   []string
}

func newFakeEventAPI(t *testing.T, mode string) *fakeEventAPI {
	t.Helper()
	f := &fakeEventAPI{t: t, mode: mode}
	upgrader := websocket.Upgrader{Subprotocols: []string{"aws-appsync-event-ws"}}
	f.srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/event/realtime" {
			conn, err := upgrader.Upgrade(w, r, nil)
			if err != nil {
				// a client that gives up mid-handshake, as one whose context
				// is done does, closes the connection under it, and that's
				// no failure. It can happen after the test ends, so it isn't
				// logged either.
				if !errors.Is(err, net.ErrClosed) && !errors.Is(err, syscall.ECONNRESET) && !errors.Is(err, syscall.EPIPE) {
					t.Error(err)
				}
				return
			}
			f.serveSocket(conn)
			return
		}
		body, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.httpPublishes = append(f.httpPublishes, string(body))
		f.mu.Unlock()
		w.Write([]byte(`{"failed":[],"successful":[{"identifier":"a","index":0}]}`))
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeEventAPI) serveSocket(conn *websocket.Conn) {
	defer conn.Close()
	var init map[string]interface{}
	if conn.ReadJSON(&init) != nil {
		return
	}
	f.mu.Lock()
	if f.silent > 0 {
		f.silent--
		f.mu.Unlock()
		var msg map[string]interface{}
		for conn.ReadJSON(&msg) == nil {
		}
		return
	}
	if f.refuse > 0 {
		f.refuse--
		f.refused++
		refuseWith := f.refuseWith
		f.mu.Unlock()
		if refuseWith == nil {
			refuseWith = map[string]interface{}{"errorCode": 404, "errorType": "ResourceNotFoundException", "message": "Unable to find the Api."}
		}
		conn.WriteJSON(map[string]interface{}{"type": "connection_error", "errors": []map[string]interface{}{refuseWith}})
		// AppSync leaves the socket open, so it's the client that closes it
		var msg map[string]interface{}
		for conn.ReadJSON(&msg) == nil {
		}
		f.mu.Lock()
		f.closedRefused++
		f.mu.Unlock()
		return
	}
	f.mu.Unlock()
	conn.WriteJSON(map[string]interface{}{"type": "connection_ack", "connectionTimeoutMs": 300000})
	f.mu.Lock()
	stall := f.mode == "stall"
	if stall {
		f.mode = "ack"
	}
	f.mu.Unlock()
	if stall {
		<-f.t.Context().Done()
		return
	}
	for {
		var msg map[string]interface{}
		if conn.ReadJSON(&msg) != nil {
			return
		}
		switch msg["type"] {
		case "subscribe":
			f.mu.Lock()
			f.subscribes++
			late, lateID := f.lateSubscribe, f.lateID
			if late {
				f.lateSubscribe = false
				f.lateID = msg["id"]
			}
			f.mu.Unlock()
			if late {
				continue
			}
			if lateID != nil {
				conn.WriteJSON(map[string]interface{}{"type": "subscribe_error", "id": lateID,
					"errors": []map[string]interface{}{{"errorType": "UnauthorizedException", "message": "late"}}})
			}
			f.mu.Lock()
			refuse := f.refuseSubscribes > 0
			if refuse {
				f.refuseSubscribes--
				f.subscribeErrors++
			}
			f.mu.Unlock()
			if refuse {
				conn.WriteJSON(map[string]interface{}{"type": "subscribe_error", "id": msg["id"],
					"errors": []map[string]interface{}{{"errorType": "UnauthorizedException", "message": "You are not authorized to make this call."}}})
				continue
			}
			conn.WriteJSON(map[string]interface{}{"type": "subscribe_success", "id": msg["id"]})
		case "publish":
			f.mu.Lock()
			f.socketPublishes = append(f.socketPublishes, msg)
			mode := f.mode
			f.mu.Unlock()
			switch mode {
			case "ack":
				conn.WriteJSON(map[string]interface{}{"type": "publish_success", "id": msg["id"],
					"successful": []map[string]interface{}{{"identifier": "a", "index": 0}}, "failed": []interface{}{}})
			case "failed":
				conn.WriteJSON(map[string]interface{}{"type": "publish_success", "id": msg["id"],
					"successful": []interface{}{}, "failed": []map[string]interface{}{{"identifier": "a", "index": 0, "code": 400, "message": "no"}}})
			case "error":
				conn.WriteJSON(map[string]interface{}{"type": "publish_error", "id": msg["id"],
					"errors": []map[string]string{{"errorType": "BadRequestException", "message": "no"}}})
			case "throttle":
				conn.WriteJSON(map[string]interface{}{"type": "error",
					"errors": []map[string]string{{"errorType": "LimitExceededError", "message": "Publish rate limit exceeded.Throttled Request count: 1"}}})
			case "close":
				return
			}
		}
	}
}

func (f *fakeEventAPI) setMode(mode string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.mode = mode
}

func (f *fakeEventAPI) counts() (socket, https int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.socketPublishes), len(f.httpPublishes)
}

// connection dials the fake as sst dev dials AppSync.
func (f *fakeEventAPI) connection() *Connection {
	f.t.Helper()
	tlsConfig := dialTLS
	dialTLS = f.srv.Client().Transport.(*http.Transport).TLSClientConfig
	f.t.Cleanup(func() { dialTLS = tlsConfig })
	ctx, cancel := context.WithCancel(context.Background())
	f.t.Cleanup(cancel)
	host := strings.TrimPrefix(f.srv.URL, "https://")
	conn, err := Dial(ctx, aws.Config{
		Region:      "us-east-1",
		Credentials: credentials.NewStaticCredentialsProvider("AKID", "SECRET", "TOKEN"),
	}, host, host)
	if err != nil {
		f.t.Fatal(err)
	}
	conn.httpClient = f.srv.Client()
	return conn
}

// setTimings sets the socket's timings for a test, and puts them back after.
func setTimings(t *testing.T, ack, afterTimeout, afterThrottle time.Duration) {
	t.Helper()
	a, b, c := socketAckTimeout, socketPauseAfterTimeout, socketPauseAfterThrottle
	socketAckTimeout, socketPauseAfterTimeout, socketPauseAfterThrottle = ack, afterTimeout, afterThrottle
	t.Cleanup(func() { socketAckTimeout, socketPauseAfterTimeout, socketPauseAfterThrottle = a, b, c })
}

// A publish over the socket is the message AppSync documents, signed over the
// same body as an HTTPS publish, and isn't published over HTTPS too.
func TestPublishOverSocket(t *testing.T) {
	f := newFakeEventAPI(t, "ack")
	conn := f.connection()
	if err := conn.PublishOverSocket(context.Background(), "/sst/app/stage/in", map[string]string{"a": "b"}); err != nil {
		t.Fatal(err)
	}
	if socket, https := f.counts(); socket != 1 || https != 0 {
		t.Fatalf("published %d over the socket and %d over HTTPS, want 1 and 0", socket, https)
	}
	msg := f.socketPublishes[0]
	events, _ := msg["events"].([]interface{})
	if msg["channel"] != "/sst/app/stage/in" || len(events) != 1 || events[0] != `{"a":"b"}` {
		t.Fatalf("published %v, want the channel and the event as a string", msg)
	}
	if id, _ := msg["id"].(string); !regexp.MustCompile(`^[a-zA-Z0-9-_+]{1,128}$`).MatchString(id) {
		t.Fatalf("the publish's id %q isn't one AppSync takes", msg["id"])
	}
	// AppSync checks the signature against the channel and the events
	auth, _ := msg["authorization"].(map[string]interface{})
	date, _ := time.Parse("20060102T150405Z", auth["x-amz-date"].(string))
	body, _ := json.Marshal(map[string]interface{}{"channel": "/sst/app/stage/in", "events": []string{`{"a":"b"}`}})
	req, _ := http.NewRequest("POST", "https://"+conn.httpEndpoint+"/event", bytes.NewReader(body))
	req.Header.Set("accept", "application/json, text/javascript")
	req.Header.Set("content-encoding", "amz-1.0")
	req.Header.Set("content-type", "application/json; charset=UTF-8")
	hash := sha256.Sum256(body)
	creds, _ := conn.cfg.Credentials.Retrieve(context.Background())
	if err := v4.NewSigner().SignHTTP(context.Background(), creds, req, hex.EncodeToString(hash[:]), "appsync", "us-east-1", date); err != nil {
		t.Fatal(err)
	}
	if auth["Authorization"] != req.Header.Get("Authorization") || auth["X-Amz-Security-Token"] != "TOKEN" {
		t.Fatalf("authorization %v isn't signed over the channel and the events", auth)
	}
}

// A publish AppSync doesn't acknowledge, as when it throttled it without a
// word, is published over HTTPS too. The next ones go over HTTPS for a while,
// as the socket may be dead.
func TestPublishOverSocketFallsBackWithoutAnAck(t *testing.T) {
	setTimings(t, 50*time.Millisecond, time.Hour, time.Hour)
	f := newFakeEventAPI(t, "silent")
	conn := f.connection()
	if err := conn.PublishOverSocket(context.Background(), "c", "first"); err != nil {
		t.Fatal(err)
	}
	if socket, https := f.counts(); socket != 1 || https != 1 {
		t.Fatalf("published %d over the socket and %d over HTTPS, want 1 and 1", socket, https)
	}
	if !strings.Contains(f.httpPublishes[0], `\"first\"`) {
		t.Fatalf("published %s over HTTPS, want the event", f.httpPublishes[0])
	}
	if err := conn.PublishOverSocket(context.Background(), "c", "second"); err != nil {
		t.Fatal(err)
	}
	if socket, https := f.counts(); socket != 1 || https != 2 {
		t.Fatalf("published %d over the socket and %d over HTTPS, want the second over HTTPS only", socket, https)
	}
}

// AppSync says it throttled a publish, but not which, so whatever waits on the
// socket goes over HTTPS at once, and the socket isn't used for a moment.
func TestPublishOverSocketFallsBackWhenThrottled(t *testing.T) {
	setTimings(t, 5*time.Second, time.Hour, time.Second)
	f := newFakeEventAPI(t, "throttle")
	conn := f.connection()
	start := time.Now()
	if err := conn.PublishOverSocket(context.Background(), "c", "event"); err != nil {
		t.Fatal(err)
	}
	if took := time.Since(start); took > 2*time.Second {
		t.Fatalf("the publish took %v, waiting for an acknowledgement that wasn't coming", took)
	}
	if socket, https := f.counts(); socket != 1 || https != 1 {
		t.Fatalf("published %d over the socket and %d over HTTPS, want 1 and 1", socket, https)
	}
	f.setMode("ack")
	if err := conn.PublishOverSocket(context.Background(), "c", "event"); err != nil {
		t.Fatal(err)
	}
	if socket, _ := f.counts(); socket != 1 {
		t.Fatal("published over the socket straight after it was throttled")
	}
	time.Sleep(1200 * time.Millisecond)
	if err := conn.PublishOverSocket(context.Background(), "c", "event"); err != nil {
		t.Fatal(err)
	}
	if socket, https := f.counts(); socket != 2 || https != 2 {
		t.Fatalf("published %d over the socket and %d over HTTPS, want the socket used again", socket, https)
	}
}

func TestPublishOverSocketFallsBackOnAnError(t *testing.T) {
	f := newFakeEventAPI(t, "error")
	conn := f.connection()
	if err := conn.PublishOverSocket(context.Background(), "c", "event"); err != nil {
		t.Fatal(err)
	}
	if socket, https := f.counts(); socket != 1 || https != 1 {
		t.Fatalf("published %d over the socket and %d over HTTPS, want 1 and 1", socket, https)
	}
}

// AppSync can answer a publish with success, and list its event as failed.
func TestPublishOverSocketFallsBackWhenItsEventFailed(t *testing.T) {
	setTimings(t, 5*time.Second, time.Hour, time.Hour)
	f := newFakeEventAPI(t, "failed")
	conn := f.connection()
	start := time.Now()
	if err := conn.PublishOverSocket(context.Background(), "c", "event"); err != nil {
		t.Fatal(err)
	}
	if took := time.Since(start); took > 2*time.Second {
		t.Fatalf("the publish took %v, waiting for an acknowledgement it had", took)
	}
	if socket, https := f.counts(); socket != 1 || https != 1 {
		t.Fatalf("published %d over the socket and %d over HTTPS, want 1 and 1", socket, https)
	}
}

// A pause after a publish wasn't acknowledged is for that socket, which may be
// dead, so the one a reconnect makes is used straight away.
func TestPublishOverSocketUsesTheSocketAReconnectMakes(t *testing.T) {
	setTimings(t, 50*time.Millisecond, time.Hour, time.Hour)
	f := newFakeEventAPI(t, "silent")
	conn := f.connection()
	if err := conn.PublishOverSocket(context.Background(), "c", "first"); err != nil {
		t.Fatal(err)
	}
	f.setMode("ack")
	if err := conn.PublishOverSocket(context.Background(), "c", "second"); err != nil {
		t.Fatal(err)
	}
	if socket, https := f.counts(); socket != 1 || https != 2 {
		t.Fatalf("published %d over the socket and %d over HTTPS, want the second over HTTPS only", socket, https)
	}
	conn.Reconnect(context.Background())
	if err := conn.PublishOverSocket(context.Background(), "c", "third"); err != nil {
		t.Fatal(err)
	}
	if socket, https := f.counts(); socket != 2 || https != 2 {
		t.Fatalf("published %d over the socket and %d over HTTPS, want the third over the new socket", socket, https)
	}
}

// A write that fails, as one that times out on a socket that stopped taking
// data, leaves the WebSocket taking no more, though it can go on reading. The
// publish goes over HTTPS, and the socket is closed, so a reconnect makes a new
// one, which is used.
func TestPublishOverSocketReconnectsAfterAWriteFails(t *testing.T) {
	setTimings(t, 5*time.Second, time.Hour, time.Hour)
	write := socketWriteTimeout
	socketWriteTimeout = 100 * time.Millisecond
	t.Cleanup(func() { socketWriteTimeout = write })
	f := newFakeEventAPI(t, "stall")
	conn := f.connection()
	stalled := conn.currentSocket()
	// more than the connection's buffers hold, so the write waits on them
	if err := conn.PublishOverSocket(context.Background(), "c", strings.Repeat("x", 32<<20)); err != nil {
		t.Fatal(err)
	}
	if socket, https := f.counts(); socket != 0 || https != 1 {
		t.Fatalf("published %d over the socket and %d over HTTPS, want 0 and 1", socket, https)
	}
	for start := time.Now(); conn.currentSocket() == stalled; time.Sleep(10 * time.Millisecond) {
		if time.Since(start) > 5*time.Second {
			t.Fatal("the socket whose write failed wasn't replaced")
		}
	}
	if err := conn.PublishOverSocket(context.Background(), "c", "event"); err != nil {
		t.Fatal(err)
	}
	if socket, https := f.counts(); socket != 1 || https != 1 {
		t.Fatalf("published %d over the socket and %d over HTTPS, want the next over the new socket", socket, https)
	}
}

func TestPublishOverSocketFallsBackWhenTheSocketCloses(t *testing.T) {
	setTimings(t, 5*time.Second, time.Hour, time.Hour)
	f := newFakeEventAPI(t, "close")
	conn := f.connection()
	start := time.Now()
	if err := conn.PublishOverSocket(context.Background(), "c", "event"); err != nil {
		t.Fatal(err)
	}
	if took := time.Since(start); took > 2*time.Second {
		t.Fatalf("the publish took %v, waiting on a socket that closed", took)
	}
	if _, https := f.counts(); https != 1 {
		t.Fatalf("published %d over HTTPS, want 1", https)
	}
}

// A burst stays under AppSync's 25 publishes a second on one socket: the rest
// go over HTTPS, and every one is published.
func TestPublishOverSocketStaysUnderAppSyncsLimit(t *testing.T) {
	f := newFakeEventAPI(t, "ack")
	conn := f.connection()
	var wg sync.WaitGroup
	for range 40 {
		wg.Go(func() {
			if err := conn.PublishOverSocket(context.Background(), "c", "event"); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	socket, https := f.counts()
	if socket > socketPublishesPerSecond || socket == 0 || socket+https != 40 {
		t.Fatalf("published %d over the socket and %d over HTTPS, want at most %d over the socket and 40 in all", socket, https, socketPublishesPerSecond)
	}
}

// Publish itself never uses the socket: everything but a reply's first copy
// goes over HTTPS.
func TestPublishDoesNotUseTheSocket(t *testing.T) {
	f := newFakeEventAPI(t, "ack")
	conn := f.connection()
	if err := conn.Publish(context.Background(), "c", "event"); err != nil {
		t.Fatal(err)
	}
	if socket, https := f.counts(); socket != 0 || https != 1 {
		t.Fatalf("published %d over the socket and %d over HTTPS, want 0 and 1", socket, https)
	}
}

// Publishes and subscribes write to the socket at once, which takes one writer
// at a time. Run with -race.
func TestSocketPublishesAndSubscribesAtOnce(t *testing.T) {
	f := newFakeEventAPI(t, "ack")
	conn := f.connection()
	var wg sync.WaitGroup
	for i := range 10 {
		wg.Go(func() {
			if err := conn.PublishOverSocket(context.Background(), "c", i); err != nil {
				t.Error(err)
			}
		})
	}
	for range 3 {
		wg.Go(func() {
			if _, err := conn.Subscribe(context.Background(), "/sst/app/stage/in"); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	if socket, https := f.counts(); socket+https != 10 {
		t.Fatalf("published %d in all, want 10", socket+https)
	}
}

func TestSocketBudget(t *testing.T) {
	var b socketBudget
	now := time.Now()
	for i := range socketPublishesPerSecond {
		if !b.take(now.Add(time.Duration(i) * time.Millisecond)) {
			t.Fatalf("publish %d refused, under the limit", i)
		}
	}
	if b.take(now.Add(500 * time.Millisecond)) {
		t.Fatal("a publish over the limit was let through")
	}
	if !b.take(now.Add(1100 * time.Millisecond)) {
		t.Fatal("a publish a second later was refused")
	}
	b.pause(now.Add(1100*time.Millisecond), time.Minute)
	if b.take(now.Add(5 * time.Second)) {
		t.Fatal("a publish while paused was let through")
	}
	if !b.take(now.Add(2 * time.Minute)) {
		t.Fatal("a publish after the pause was refused")
	}
}
