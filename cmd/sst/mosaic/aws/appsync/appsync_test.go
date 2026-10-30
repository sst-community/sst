package appsync

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/gorilla/websocket"
)

func TestFailedEvents(t *testing.T) {
	cases := map[string]int{
		`{"failed":[],"successful":[{"identifier":"a","index":0}]}`:                          0,
		`{"failed":[{"identifier":"a","index":0,"code":"X","message":"y"}],"successful":[]}`: 1,
		`{"successful":[{"identifier":"a","index":0}]}`:                                      0,
		`not json`: 0,
		``:         0,
	}
	for body, want := range cases {
		if got := failedEvents([]byte(body)); got != want {
			t.Errorf("failedEvents(%q) = %d, want %d", body, got, want)
		}
	}
}

// publishServer answers each publish with the next of the given statuses, and
// with 200 once they run out. A status of 0 drops the connection with no answer.
type publishServer struct {
	t        *testing.T
	statuses []int
	mu       sync.Mutex
	requests []*http.Request
	bodies   []string
}

func (s *publishServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	s.mu.Lock()
	s.requests = append(s.requests, r)
	s.bodies = append(s.bodies, string(body))
	status := http.StatusOK
	if len(s.statuses) > 0 {
		status, s.statuses = s.statuses[0], s.statuses[1:]
	}
	s.mu.Unlock()
	if status == 0 {
		conn, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			s.t.Error(err)
			return
		}
		conn.Close()
		return
	}
	w.WriteHeader(status)
	w.Write([]byte(`{"failed":[],"successful":[{"identifier":"a","index":0}]}`))
}

func (s *publishServer) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.requests)
}

// connect starts a server that answers publishes with the given statuses, and
// a connection that publishes to it. Retries wait a millisecond.
func connect(t *testing.T, statuses ...int) (*Connection, *publishServer) {
	t.Helper()
	retries, attemptTimeout, timeout := publishRetries, publishAttemptTimeout, publishTimeout
	publishRetries = []time.Duration{time.Millisecond, time.Millisecond, time.Millisecond}
	t.Cleanup(func() { publishRetries, publishAttemptTimeout, publishTimeout = retries, attemptTimeout, timeout })

	handler := &publishServer{t: t, statuses: statuses}
	srv := httptest.NewTLSServer(handler)
	t.Cleanup(srv.Close)
	conn := &Connection{
		cfg: aws.Config{
			Region:      "us-east-1",
			Credentials: credentials.NewStaticCredentialsProvider("AKID", "SECRET", ""),
		},
		httpEndpoint: strings.TrimPrefix(srv.URL, "https://"),
		httpClient:   srv.Client(),
	}
	return conn, handler
}

func TestPublishRetriesThrottlesAndServerErrors(t *testing.T) {
	conn, srv := connect(t, 429, 500, 503)
	if err := conn.Publish(context.Background(), "/sst/app/stage/in", map[string]string{"a": "b"}); err != nil {
		t.Fatalf("Publish() = %v, want nil after the retries", err)
	}
	if got := srv.count(); got != 4 {
		t.Fatalf("made %d attempts, want 4", got)
	}
	srv.mu.Lock()
	defer srv.mu.Unlock()
	for i, r := range srv.requests {
		if !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 ") {
			t.Errorf("attempt %d isn't signed: %q", i, r.Header.Get("Authorization"))
		}
		if srv.bodies[i] != srv.bodies[0] {
			t.Errorf("attempt %d sent %q, want the same body as the first, %q", i, srv.bodies[i], srv.bodies[0])
		}
	}
	if !strings.Contains(srv.bodies[0], `"channel":"/sst/app/stage/in"`) {
		t.Errorf("body %q doesn't name the channel", srv.bodies[0])
	}
}

// A batch is one request, holding each event as a string of JSON, in order, and
// a retry sends it whole again.
func TestPublishBatchSendsItsEventsInOneRequest(t *testing.T) {
	conn, srv := connect(t, 429)
	events := []interface{}{map[string]int{"index": 0}, map[string]int{"index": 1}, map[string]int{"index": 2}}
	if err := conn.PublishBatch(context.Background(), "c", events); err != nil {
		t.Fatal(err)
	}
	srv.mu.Lock()
	defer srv.mu.Unlock()
	if len(srv.bodies) != 2 || srv.bodies[1] != srv.bodies[0] {
		t.Fatalf("made %d attempts, want 2 with the same body", len(srv.bodies))
	}
	var body struct {
		Events []string `json:"events"`
	}
	if err := json.Unmarshal([]byte(srv.bodies[0]), &body); err != nil {
		t.Fatal(err)
	}
	want := []string{`{"index":0}`, `{"index":1}`, `{"index":2}`}
	if !slices.Equal(body.Events, want) {
		t.Errorf("sent events %q, want %q", body.Events, want)
	}
}

// More events than AppSync takes in a publish, or none, are an error, without
// a request.
func TestPublishBatchTakesOneToFive(t *testing.T) {
	if MaxBatch != 5 {
		t.Fatalf("MaxBatch is %d, but AppSync takes 5 events in a publish", MaxBatch)
	}
	conn, srv := connect(t)
	events := []interface{}{1, 2, 3, 4, 5, 6}
	if err := conn.PublishBatch(context.Background(), "c", events); err == nil {
		t.Fatal("PublishBatch() of 6 events = nil, want an error")
	}
	if got := srv.count(); got != 0 {
		t.Fatalf("made %d requests, want none", got)
	}
	if err := conn.PublishBatchOverSocket(context.Background(), "c", events); err == nil {
		t.Fatal("PublishBatchOverSocket() of 6 events = nil, want an error")
	}
	if got := srv.count(); got != 0 {
		t.Fatalf("made %d requests, want none", got)
	}
	if err := conn.PublishBatch(context.Background(), "c", nil); err == nil {
		t.Fatal("PublishBatch() of no events = nil, want an error")
	}
	if err := conn.PublishBatchOverSocket(context.Background(), "c", nil); err == nil {
		t.Fatal("PublishBatchOverSocket() of no events = nil, want an error")
	}
	if got := srv.count(); got != 0 {
		t.Fatalf("made %d requests, want none", got)
	}
	if err := conn.PublishBatch(context.Background(), "c", events[:5]); err != nil {
		t.Fatalf("PublishBatch() of 5 events = %v", err)
	}
}

func TestPublishRetriesADroppedConnection(t *testing.T) {
	conn, srv := connect(t, 0)
	if err := conn.Publish(context.Background(), "c", "event"); err != nil {
		t.Fatalf("Publish() = %v, want nil after the retry", err)
	}
	if got := srv.count(); got != 2 {
		t.Fatalf("made %d attempts, want 2", got)
	}
}

func TestPublishGivesUp(t *testing.T) {
	conn, srv := connect(t, 500, 500, 500, 500, 500)
	err := conn.Publish(context.Background(), "c", "event")
	if err == nil || !strings.Contains(err.Error(), "status 500") {
		t.Fatalf("Publish() = %v, want the last 500", err)
	}
	if got, want := srv.count(), 1+len(publishRetries); got != want {
		t.Fatalf("made %d attempts, want %d", got, want)
	}
}

// A request AppSync refuses fails the same way the next time, so it isn't retried.
func TestPublishDoesNotRetryAClientError(t *testing.T) {
	for _, status := range []int{400, 401, 403, 404} {
		conn, srv := connect(t, status)
		if err := conn.Publish(context.Background(), "c", "event"); err == nil {
			t.Fatalf("status %d: Publish() = nil, want an error", status)
		}
		if got := srv.count(); got != 1 {
			t.Fatalf("status %d: made %d attempts, want 1", status, got)
		}
	}
}

func TestPublishRetriesAnAttemptThatHangs(t *testing.T) {
	conn, _ := connect(t)
	publishAttemptTimeout = 50 * time.Millisecond
	var mu sync.Mutex
	attempts := 0
	hang := make(chan struct{})
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		attempts++
		first := attempts == 1
		mu.Unlock()
		if first {
			select {
			case <-hang:
			case <-r.Context().Done():
			}
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	// the server waits for the hung handler when it closes, so it's let go first
	defer srv.Close()
	defer close(hang)
	conn.httpEndpoint = strings.TrimPrefix(srv.URL, "https://")
	conn.httpClient = srv.Client()

	if err := conn.Publish(context.Background(), "c", "event"); err != nil {
		t.Fatalf("Publish() = %v, want nil after the retry", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if attempts != 2 {
		t.Fatalf("made %d attempts, want 2", attempts)
	}
}

// A large request has longer to send, as a batch over a slow uplink needs. Here
// the times are a tenth of what they are, and 4 batches of 875 KB, as many as a
// message has in flight, share a link of 4 MB/s, so each takes about 0.9 s.
// That's half the 1.9 s it has, 0.5 s and 875 KB at 640 KB/s, though well over
// the 0.5 s a small publish has.
func TestPublishGivesALargeRequestLongerToSend(t *testing.T) {
	conn, _ := connect(t)
	minRate := publishMinRate
	t.Cleanup(func() { publishMinRate = minRate })
	publishAttemptTimeout, publishTimeout, publishMinRate = 500*time.Millisecond, time.Second, 640<<10
	var link sync.Mutex
	var attempts atomic.Int32
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		buf := make([]byte, 25<<10)
		for {
			// the link carries 25 KB every 6 ms, for every request at once
			link.Lock()
			n, err := io.ReadFull(r.Body, buf)
			time.Sleep(time.Duration(n) * time.Second / (4 << 20))
			link.Unlock()
			if err != nil {
				break
			}
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	conn.httpEndpoint = strings.TrimPrefix(srv.URL, "https://")
	conn.httpClient = srv.Client()

	event := strings.Repeat("A", 175<<10)
	var wg sync.WaitGroup
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := conn.PublishBatch(context.Background(), "c", []interface{}{event, event, event, event, event}); err != nil {
				t.Errorf("PublishBatch() = %v, want nil", err)
			}
		}()
	}
	wg.Wait()
	if got := attempts.Load(); got != 4 {
		t.Errorf("made %d attempts, want 4, one for each", got)
	}
}

// Once the caller is done, a publish stops: it isn't retried, and doesn't wait.
func TestPublishStopsWhenTheContextIsDone(t *testing.T) {
	conn, srv := connect(t, 500, 500, 500, 500)
	publishRetries = []time.Duration{time.Hour, time.Hour, time.Hour}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- conn.Publish(ctx, "c", "event") }()
	deadline := time.Now().Add(5 * time.Second)
	for srv.count() == 0 {
		if time.Now().After(deadline) {
			t.Fatal("Publish() never made its first attempt")
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("Publish() = nil, want the error of the attempt it made")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Publish() kept waiting to retry after the context was done")
	}
	if got := srv.count(); got != 1 {
		t.Fatalf("made %d attempts, want 1", got)
	}
}

// A publish, with all its retries, stops after publishTimeout, so a caller
// isn't held up for long by attempts that each hang.
func TestPublishGivesUpAfterItsTimeout(t *testing.T) {
	conn, _ := connect(t)
	publishAttemptTimeout = time.Hour
	publishTimeout = 100 * time.Millisecond
	hang := make(chan struct{})
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-hang:
		case <-r.Context().Done():
		}
	}))
	// the server waits for the hung handler when it closes, so it's let go first
	defer srv.Close()
	defer close(hang)
	conn.httpEndpoint = strings.TrimPrefix(srv.URL, "https://")
	conn.httpClient = srv.Client()

	start := time.Now()
	if err := conn.Publish(context.Background(), "c", "event"); err == nil {
		t.Fatal("Publish() = nil, want the timeout")
	}
	if took := time.Since(start); took > 5*time.Second {
		t.Fatalf("Publish() took %v, want it to stop after %v", took, publishTimeout)
	}
}

// dialFake dials the fake with DialWhenReady, as sst dev dials AppSync.
func dialFake(t *testing.T, f *fakeEventAPI) (*Connection, error) {
	t.Helper()
	tlsConfig := dialTLS
	dialTLS = f.srv.Client().Transport.(*http.Transport).TLSClientConfig
	t.Cleanup(func() { dialTLS = tlsConfig })
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	host := strings.TrimPrefix(f.srv.URL, "https://")
	return DialWhenReady(ctx, aws.Config{
		Region:      "us-east-1",
		Credentials: credentials.NewStaticCredentialsProvider("AKID", "SECRET", "TOKEN"),
	}, host, host)
}

func setReadyTimings(t *testing.T, timeout, interval time.Duration) {
	t.Helper()
	oldTimeout, oldInterval := readyTimeout, readyInterval
	readyTimeout, readyInterval = timeout, interval
	t.Cleanup(func() { readyTimeout, readyInterval = oldTimeout, oldInterval })
}

func TestDialWhenReadyWaitsForANewEventAPI(t *testing.T) {
	setReadyTimings(t, 5*time.Second, 10*time.Millisecond)
	f := newFakeEventAPI(t, "ack")
	f.refuse = 2

	conn, err := dialFake(t, f)
	if err != nil {
		t.Fatal(err)
	}
	if conn == nil {
		t.Fatal("no connection")
	}
	// and it works
	out, err := conn.Subscribe(context.Background(), "/sst/app/stage/x")
	if err != nil || out == nil {
		t.Fatalf("subscribe: %v", err)
	}
	waitFor(t, func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		return f.closedRefused == 2
	})
	f.mu.Lock()
	refused := f.refused
	f.mu.Unlock()
	if refused != 2 {
		t.Fatalf("refused %d connects, want 2", refused)
	}
}

func TestDialWhenReadyGivesUp(t *testing.T) {
	setReadyTimings(t, 200*time.Millisecond, 10*time.Millisecond)
	f := newFakeEventAPI(t, "ack")
	f.refuse = 1 << 30

	start := time.Now()
	_, err := dialFake(t, f)
	if !errors.Is(err, ErrConnectionFailed) {
		t.Fatalf("got %v, want ErrConnectionFailed", err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("gave up after %v", elapsed)
	}
	// every refused socket was closed, none left open
	waitFor(t, func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		return f.refused > 1 && f.closedRefused == f.refused
	})
}

func TestDialWhenReadyStopsWithTheContext(t *testing.T) {
	setReadyTimings(t, time.Minute, 10*time.Millisecond)
	f := newFakeEventAPI(t, "ack")
	f.refuse = 1 << 30
	tlsConfig := dialTLS
	dialTLS = f.srv.Client().Transport.(*http.Transport).TLSClientConfig
	t.Cleanup(func() { dialTLS = tlsConfig })
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	host := strings.TrimPrefix(f.srv.URL, "https://")
	start := time.Now()
	_, err := DialWhenReady(ctx, aws.Config{
		Region:      "us-east-1",
		Credentials: credentials.NewStaticCredentialsProvider("AKID", "SECRET", "TOKEN"),
	}, host, host)
	if err == nil {
		t.Fatal("want an error")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("stopped after %v", elapsed)
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// failingCredentials can't be retrieved, as with an expired SSO session
type failingCredentials struct{ calls atomic.Int32 }

func (f *failingCredentials) Retrieve(context.Context) (aws.Credentials, error) {
	f.calls.Add(1)
	return aws.Credentials{}, errors.New("token has expired")
}

func TestDialWhenReadyReturnsAPermanentErrorAtOnce(t *testing.T) {
	setReadyTimings(t, 5*time.Second, 10*time.Millisecond)
	f := newFakeEventAPI(t, "ack")
	creds := &failingCredentials{}
	host := strings.TrimPrefix(f.srv.URL, "https://")
	start := time.Now()
	_, err := DialWhenReady(context.Background(), aws.Config{Region: "us-east-1", Credentials: creds}, host, host)
	if err == nil || !strings.Contains(err.Error(), "token has expired") {
		t.Fatalf("got %v, want the credentials' error", err)
	}
	if Transient(err) {
		t.Fatalf("%v counted as transient", err)
	}
	if calls := creds.calls.Load(); calls != 1 {
		t.Fatalf("dialed %d times, want 1", calls)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("took %v", elapsed)
	}
}

// Credentials AppSync doesn't take are turned down at the connect, as they
// are, and that's returned at once, with what AppSync said.
func TestDialWhenReadyReturnsARefusalThatWontPass(t *testing.T) {
	setReadyTimings(t, 5*time.Second, 10*time.Millisecond)
	f := newFakeEventAPI(t, "ack")
	f.refuse = 1 << 30
	f.refuseWith = map[string]interface{}{"errorCode": 403, "errorType": "UnrecognizedClientException",
		"message": "The security token included in the request is invalid."}

	start := time.Now()
	_, err := dialFake(t, f)
	if err == nil || !strings.Contains(err.Error(), "UnrecognizedClientException") {
		t.Fatalf("got %v, want AppSync's error", err)
	}
	if !errors.Is(err, ErrConnectionFailed) {
		t.Fatalf("%v isn't ErrConnectionFailed", err)
	}
	if Transient(err) {
		t.Fatalf("%v counted as transient", err)
	}
	f.mu.Lock()
	refused := f.refused
	f.mu.Unlock()
	if refused != 1 {
		t.Fatalf("dialed %d times, want 1", refused)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("took %v", elapsed)
	}
}

func TestTransient(t *testing.T) {
	for _, err := range []error{
		ErrConnectionFailed,
		&ConnectError{Code: 404, Type: "ResourceNotFoundException"},
		&ConnectError{Code: 429, Type: "LimitExceededError"},
		&ConnectError{Code: 503, Type: "ServiceUnavailable"},
		&HandshakeError{Status: 404},
		&HandshakeError{Status: 502},
		fmt.Errorf("dial: %w", &net.DNSError{Err: "no such host", Name: "abc.appsync-realtime-api.ca-central-1.amazonaws.com", IsNotFound: true}),
		&net.OpError{Op: "dial", Net: "tcp", Err: syscall.ECONNREFUSED},
		&net.OpError{Op: "dial", Net: "tcp", Err: syscall.ECONNRESET},
		&net.OpError{Op: "dial", Net: "tcp", Err: syscall.ETIMEDOUT},
		websocket.ErrBadHandshake,
	} {
		if !Transient(err) {
			t.Errorf("%v: want transient", err)
		}
	}
	for _, err := range []error{
		&ConnectError{Code: 403, Type: "UnrecognizedClientException"},
		&ConnectError{Code: 401, Type: "UnauthorizedException"},
		&HandshakeError{Status: 403},
		&HandshakeError{Status: 401},
		&net.OpError{Op: "dial", Net: "tcp", Err: syscall.EACCES},
		&net.OpError{Op: "dial", Net: "tcp", Err: &tls.CertificateVerificationError{Err: errors.New("bad cert")}},
		errors.New("token has expired"),
		context.Canceled,
		&tls.CertificateVerificationError{Err: errors.New("bad cert")},
	} {
		if Transient(err) {
			t.Errorf("%v: want permanent", err)
		}
	}
}

// A connect that's never answered is given up on and dialed again, so a hung
// one can't hold sst dev past readyTimeout.
func TestDialWhenReadyDialsAgainAfterAConnectNobodyAnswers(t *testing.T) {
	setReadyTimings(t, 5*time.Second, 10*time.Millisecond)
	old := connectTimeout
	connectTimeout = 100 * time.Millisecond
	t.Cleanup(func() { connectTimeout = old })
	f := newFakeEventAPI(t, "ack")
	f.silent = 1

	start := time.Now()
	if _, err := dialFake(t, f); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("took %v", elapsed)
	}
}

// A certificate that isn't trusted won't pass on its own, so it's returned at
// once, not retried for readyTimeout.
func TestDialWhenReadyReturnsATLSErrorAtOnce(t *testing.T) {
	setReadyTimings(t, 5*time.Second, 10*time.Millisecond)
	f := newFakeEventAPI(t, "ack")
	host := strings.TrimPrefix(f.srv.URL, "https://")
	start := time.Now()
	// without the fake's certificate, as dialFake trusts it
	_, err := DialWhenReady(context.Background(), aws.Config{
		Region:      "us-east-1",
		Credentials: credentials.NewStaticCredentialsProvider("AKID", "SECRET", "TOKEN"),
	}, host, host)
	if err == nil {
		t.Fatal("want an error")
	}
	if Transient(err) {
		t.Fatalf("%v (%T) counted as transient", err, err)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("took %v", elapsed)
	}
}

// A namespace just created turns down the first subscribes to it. Subscribe
// tries again, so what's published to the channel arrives.
func TestSubscribeWaitsForANewNamespace(t *testing.T) {
	setReadyTimings(t, 5*time.Second, 10*time.Millisecond)
	f := newFakeEventAPI(t, "ack")
	f.refuseSubscribes = 2
	conn := f.connection()

	start := time.Now()
	out, err := conn.Subscribe(context.Background(), "/sst/app/stage/in")
	if err != nil {
		t.Fatal(err)
	}
	if out == nil {
		t.Fatal("no channel")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("took %v", elapsed)
	}
	f.mu.Lock()
	refused := f.subscribeErrors
	f.mu.Unlock()
	if refused != 2 {
		t.Fatalf("%d subscribes turned down, want 2", refused)
	}
}

// A subscribe that's turned down for longer than readyTimeout fails.
func TestSubscribeGivesUp(t *testing.T) {
	setReadyTimings(t, 200*time.Millisecond, 10*time.Millisecond)
	f := newFakeEventAPI(t, "ack")
	f.refuseSubscribes = 1 << 30
	conn := f.connection()
	start := time.Now()
	if _, err := conn.Subscribe(context.Background(), "/sst/app/stage/in"); !errors.Is(err, ErrSubscriptionFailed) {
		t.Fatalf("got %v, want ErrSubscriptionFailed", err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("took %v", elapsed)
	}
}

// A subscribe whose answer is late is tried again, and the late answer, an
// error here, isn't taken for the next try's.
func TestSubscribeIgnoresALateAnswer(t *testing.T) {
	setReadyTimings(t, 10*time.Second, 10*time.Millisecond)
	old := subscribeTimeout
	subscribeTimeout = 100 * time.Millisecond
	t.Cleanup(func() { subscribeTimeout = old })
	f := newFakeEventAPI(t, "ack")
	f.lateSubscribe = true
	conn := f.connection()

	if _, err := conn.Subscribe(context.Background(), "/sst/app/stage/in"); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.subscribes != 2 {
		t.Fatalf("subscribed %d times, want 2: the late error was taken for the second's answer", f.subscribes)
	}
}

// A reconnect resubscribes from a copy of the subscriptions, which can hold an
// ID that Subscribe has dropped since. Subscribing it fails, and doesn't put
// it back without a channel, which the reader would block on.
func TestSubscribeOfADroppedIDFails(t *testing.T) {
	f := newFakeEventAPI(t, "ack")
	conn := f.connection()
	conn.setSubscription("dropped", SubscriptionInfo{Channel: "/sst/app/stage/in", Out: make(chan string, 1)})
	conn.deleteSubscription("dropped")

	if err := conn.subscribe(context.Background(), "/sst/app/stage/in", "dropped"); !errors.Is(err, ErrSubscriptionFailed) {
		t.Fatalf("got %v, want ErrSubscriptionFailed", err)
	}
	if item, ok := conn.subscription("dropped"); ok {
		t.Fatalf("the dropped ID is back, with %+v", item)
	}
}
