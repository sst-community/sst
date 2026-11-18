package web

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/bridge"
)

// fakeAppSync delivers an event published to a channel to its subscribers.
// drop, if set, says whether to lose a packet, as AppSync can.
type fakeAppSync struct {
	mu   sync.Mutex
	subs map[string][]chan string
	drop func(channel string, packet bridge.Packet) bool
}

func (f *fakeAppSync) Publish(ctx context.Context, channel string, event interface{}) error {
	if packet, ok := event.(bridge.Packet); ok && f.drop != nil && f.drop(channel, packet) {
		return nil
	}
	data, err := json.Marshal(event)
	if err != nil {
		return err
	}
	f.mu.Lock()
	subs := slices.Clone(f.subs[channel])
	f.mu.Unlock()
	for _, sub := range subs {
		sub <- string(data)
	}
	return nil
}

func (f *fakeAppSync) Subscribe(ctx context.Context, channel string) (chan string, error) {
	sub := make(chan string, 10_000)
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.subs == nil {
		f.subs = map[string][]chan string{}
	}
	f.subs[channel] = append(f.subs[channel], sub)
	return sub, nil
}

const prefix = "/sst/app/stage"

type setup struct {
	url     string
	bridge  *Bridge
	appsync *fakeAppSync
}

// start runs a bridge over a fake AppSync, and sst dev's forwarder, unless
// noDev, which sends requests for the "Api" web function to local.
func start(t *testing.T, local http.Handler, noDev bool, live bool, drop func(string, bridge.Packet) bool) setup {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	appsync := &fakeAppSync{drop: drop}
	if !noDev {
		server := httptest.NewServer(local)
		t.Cleanup(server.Close)
		dev := bridge.NewClient(ctx, appsync, "dev", prefix)
		forwarder := &Forwarder{
			Client: dev,
			Prefix: prefix,
			Target: func(functionID string) (string, bool) {
				return server.URL, live && functionID == "Api"
			},
			HTTP:      NewHTTPClient(),
			PingEvery: 100 * time.Millisecond,
		}
		go func() {
			for {
				select {
				case <-ctx.Done():
					return
				case msg := <-dev.Read():
					if msg.Source == "dev" {
						continue
					}
					if msg.Type == bridge.MessageHttpRequest {
						go forwarder.Handle(ctx, msg)
					}
				}
			}
		}()
	}
	client := bridge.NewClient(ctx, appsync, "worker1", prefix+"/worker1")
	client.AskForMissingOn(prefix + "/in")
	b := &Bridge{
		Client:      client,
		Prefix:      prefix,
		WorkerID:    "worker1",
		FunctionID:  "Api",
		TakeTimeout: 500 * time.Millisecond,
		ResendEvery: 100 * time.Millisecond,
		// longer than the copies of a response sent whole take, as sst dev stops
		// pinging once it sends the response
		LostAfter: wholeCopies*wholeCopyEvery + time.Second,
	}
	go b.Run(ctx)
	b.Probe(ctx)
	front := httptest.NewServer(b)
	t.Cleanup(front.Close)
	return setup{url: front.URL, bridge: b, appsync: appsync}
}

func echo() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		w.Header().Set("X-Method", r.Method)
		w.Header().Set("X-Uri", r.URL.RequestURI())
		w.Header().Set("X-Got-Header", r.Header.Get("X-Test"))
		w.Header().Set("X-Forwarded-Host-Seen", r.Header.Get("X-Forwarded-Host"))
		w.Header().Add("Set-Cookie", "a=1")
		w.Header().Add("Set-Cookie", "b=2")
		w.WriteHeader(201)
		w.Write(body)
	})
}

func TestRoundTrip(t *testing.T) {
	s := start(t, echo(), false, true, nil)
	req, _ := http.NewRequest("POST", s.url+"/items?x=1&y=2", strings.NewReader("hello"))
	req.Header.Set("X-Test", "value")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 201 || string(body) != "hello" {
		t.Fatalf("got %d %q", resp.StatusCode, body)
	}
	for key, want := range map[string]string{
		"X-Method":              "POST",
		"X-Uri":                 "/items?x=1&y=2",
		"X-Got-Header":          "value",
		"X-Forwarded-Host-Seen": strings.TrimPrefix(s.url, "http://"),
	} {
		if got := resp.Header.Get(key); got != want {
			t.Errorf("%s = %q, want %q", key, got, want)
		}
	}
	if cookies := resp.Header.Values("Set-Cookie"); len(cookies) != 2 {
		t.Errorf("Set-Cookie = %v, want both", cookies)
	}
}

func TestLargeBodies(t *testing.T) {
	s := start(t, echo(), false, true, nil)
	// several packets each way
	payload := make([]byte, 3*bridge.BUFFER_SIZE+123)
	rand.Read(payload)
	resp, err := http.Post(s.url+"/upload", "application/octet-stream", bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if !bytes.Equal(body, payload) {
		t.Fatalf("got %d bytes back, want the %d sent", len(body), len(payload))
	}
}

func TestStreamsTheResponse(t *testing.T) {
	release := make(chan struct{})
	local := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte("first\n"))
		w.(http.Flusher).Flush()
		<-release
		w.Write([]byte("second\n"))
	})
	s := start(t, local, false, true, nil)
	resp, err := http.Get(s.url + "/events")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	buf := make([]byte, 6)
	if _, err := io.ReadFull(resp.Body, buf); err != nil || string(buf) != "first\n" {
		t.Fatalf("first part = %q, %v; want it before the server writes the rest", buf, err)
	}
	close(release)
	rest, _ := io.ReadAll(resp.Body)
	if string(rest) != "second\n" {
		t.Fatalf("rest = %q", rest)
	}
}

func TestConcurrentRequests(t *testing.T) {
	var inFlight, most atomic.Int32
	local := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		now := inFlight.Add(1)
		for {
			prev := most.Load()
			if now <= prev || most.CompareAndSwap(prev, now) {
				break
			}
		}
		time.Sleep(100 * time.Millisecond)
		inFlight.Add(-1)
		fmt.Fprint(w, r.URL.Path)
	})
	s := start(t, local, false, true, nil)
	var wg sync.WaitGroup
	errs := make(chan error, 20)
	for i := range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			resp, err := http.Get(fmt.Sprintf("%s/r%d", s.url, i))
			if err != nil {
				errs <- err
				return
			}
			defer resp.Body.Close()
			body, _ := io.ReadAll(resp.Body)
			if want := fmt.Sprintf("/r%d", i); string(body) != want {
				errs <- fmt.Errorf("request %d got %q", i, body)
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
	// they ran at once, not one after another
	if most.Load() < 10 {
		t.Errorf("at most %d requests ran at once, want them at once", most.Load())
	}
}

func TestUnavailableWithoutDev(t *testing.T) {
	s := start(t, nil, true, false, nil)
	began := time.Now()
	resp, err := http.Get(s.url + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 503 || !strings.Contains(string(body), "sst dev") {
		t.Fatalf("got %d %q, want a 503 that names sst dev", resp.StatusCode, body)
	}
	// loose, so a loaded runner under -race doesn't fail it: this checks
	// the 503 doesn't wait for the function's timeout
	if took := time.Since(began); took > 10*time.Second {
		t.Fatalf("took %s, want it soon after the take timeout", took)
	}
}

// A request that sst dev never answered doesn't count as activity, so the
// next request after an idle spell checks the subscription again, as the
// failure may be the subscription's. One sst dev answered does count.
func TestFailedRequestIsNotActivity(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	var probes atomic.Int32
	appsync := &fakeAppSync{drop: func(channel string, packet bridge.Packet) bool {
		if packet.Type == bridge.MessageProbe {
			probes.Add(1)
		}
		return false
	}}
	client := bridge.NewClient(ctx, appsync, "worker1", prefix+"/worker1")
	b := &Bridge{
		Client:     client,
		Prefix:     prefix,
		WorkerID:   "worker1",
		FunctionID: "Api",
		// longer than Idle, so a request that's marked active when it ends
		// leaves the next one fresh, and one that isn't leaves it stale
		TakeTimeout: 600 * time.Millisecond,
		ResendEvery: 100 * time.Millisecond,
		Idle:        200 * time.Millisecond,
	}
	go b.Run(ctx)
	b.Probe(ctx)
	front := httptest.NewServer(b)
	t.Cleanup(front.Close)
	get := func() int {
		t.Helper()
		resp, err := http.Get(front.URL + "/")
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		return resp.StatusCode
	}

	time.Sleep(300 * time.Millisecond)
	before := probes.Load()
	if status := get(); status != 503 {
		t.Fatalf("got %d without sst dev, want 503", status)
	}
	// stale after the idle spell, so it was probed
	afterFirst := probes.Load()
	if afterFirst == before {
		t.Fatal("the request after an idle spell didn't check the subscription")
	}
	// right away, but the 503 took longer than Idle, and sst dev sent nothing
	if status := get(); status != 503 {
		t.Fatalf("got %d without sst dev, want 503", status)
	}
	if probes.Load() == afterFirst {
		t.Fatal("a request that sst dev never answered counted as activity, so the next one didn't check the subscription")
	}
}

func TestUnavailableWhenNotLive(t *testing.T) {
	s := start(t, echo(), false, false, nil)
	resp, err := http.Get(s.url + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 503 || !strings.Contains(string(body), "isn't live") {
		t.Fatalf("got %d %q", resp.StatusCode, body)
	}
}

func TestLocalServerDown(t *testing.T) {
	// a local server that isn't listening
	closed := httptest.NewServer(echo())
	closed.Close()
	resp, err := http.Get(startWithTarget(t, closed.URL) + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 502 || !strings.Contains(string(body), "couldn't reach the local server") {
		t.Fatalf("got %d %q", resp.StatusCode, body)
	}
}

// A request sst dev took, then stopped pinging, as when sst dev exits, gets a
// 504 instead of waiting out the function's timeout.
func TestTakenRequestLost(t *testing.T) {
	release := make(chan struct{})
	local := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-release })
	var pings atomic.Int32
	drop := func(channel string, packet bridge.Packet) bool {
		// keep the first ping, which takes the request, and lose the rest
		return packet.Type == bridge.MessagePing && pings.Add(1) > 1
	}
	s := start(t, local, false, true, drop)
	// after start's, so it runs before the local server is closed
	t.Cleanup(func() { close(release) })
	started := time.Now()
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Get(s.url + "/hang")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 504 || !strings.Contains(string(body), "stopped answering") {
		t.Fatalf("got %d %q", resp.StatusCode, body)
	}
	if waited := time.Since(started); waited < s.bridge.LostAfter {
		t.Fatalf("answered after %s, before LostAfter", waited)
	}
}

// A request that fails before it reaches the local server still has the rest of
// its body read. Otherwise its packets fill the Client's queue for it, and the
// Client stops delivering every other message, so later requests get no answer.
func TestFailedRequestDrainsItsBody(t *testing.T) {
	for _, target := range []string{
		"://bad",             // bad dev.url
		"http://127.0.0.1:1", // local server down
	} {
		t.Run(target, func(t *testing.T) {
			url := startWithTarget(t, target)
			client := &http.Client{Timeout: 20 * time.Second}
			// more packets than the Client queues for one message
			payload := make([]byte, 110*bridge.BUFFER_SIZE)
			resp, err := client.Post(url+"/upload", "application/octet-stream", bytes.NewReader(payload))
			if err != nil {
				t.Fatal(err)
			}
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode != 502 {
				t.Fatalf("first request: got %d, want 502", resp.StatusCode)
			}
			resp, err = client.Get(url + "/next")
			if err != nil {
				t.Fatalf("next request got no answer: %v", err)
			}
			resp.Body.Close()
			if resp.StatusCode != 502 {
				t.Fatalf("next request: got %d, want 502", resp.StatusCode)
			}
		})
	}
}

// startWithTarget runs a bridge and a forwarder that sends to target.
func startWithTarget(t *testing.T, target string) string {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	appsync := &fakeAppSync{}
	dev := bridge.NewClient(ctx, appsync, "dev", prefix)
	forwarder := &Forwarder{
		Client: dev, Prefix: prefix, HTTP: NewHTTPClient(),
		Target: func(string) (string, bool) { return target, true },
	}
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case msg := <-dev.Read():
				if msg.Source != "dev" && msg.Type == bridge.MessageHttpRequest {
					go forwarder.Handle(ctx, msg)
				}
			}
		}
	}()
	client := bridge.NewClient(ctx, appsync, "worker1", prefix+"/worker1")
	b := &Bridge{Client: client, Prefix: prefix, WorkerID: "worker1", FunctionID: "Api", TakeTimeout: time.Second}
	go b.Run(ctx)
	b.Probe(ctx)
	front := httptest.NewServer(b)
	t.Cleanup(front.Close)
	return front.URL
}

// A request AppSync lost is sent again until sst dev takes it.
func TestResendsALostRequest(t *testing.T) {
	var dropped atomic.Bool
	drop := func(channel string, packet bridge.Packet) bool {
		return packet.Type == bridge.MessageHttpRequest && dropped.CompareAndSwap(false, true)
	}
	s := start(t, echo(), false, true, drop)
	resp, err := http.Post(s.url+"/", "text/plain", strings.NewReader("again"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if !dropped.Load() || resp.StatusCode != 201 || string(body) != "again" {
		t.Fatalf("dropped %v, got %d %q", dropped.Load(), resp.StatusCode, body)
	}
}

// A copy of a request sst dev took is dropped, so the local server gets it
// once.
func TestRequestReachesTheServerOnce(t *testing.T) {
	var calls atomic.Int32
	local := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		// past several resends
		time.Sleep(400 * time.Millisecond)
		w.Write([]byte("ok"))
	})
	s := start(t, local, false, true, nil)
	resp, err := http.Get(s.url + "/")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if calls.Load() != 1 {
		t.Fatalf("the local server got the request %d times", calls.Load())
	}
}

// A response that takes longer than the take timeout isn't answered with a
// 503, as sst dev pings while the local server works on it.
func TestSlowResponse(t *testing.T) {
	// the first ping is lost, so only the later ones say it's taken
	var first atomic.Bool
	drop := func(channel string, packet bridge.Packet) bool {
		return packet.Type == bridge.MessagePing && first.CompareAndSwap(false, true)
	}
	local := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(1500 * time.Millisecond)
		w.Write([]byte("slow"))
	})
	s := start(t, local, false, true, drop)
	resp, err := http.Get(s.url + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || string(body) != "slow" {
		t.Fatalf("got %d %q", resp.StatusCode, body)
	}
}

// A response sent whole that AppSync lost is filled in from a copy.
func TestLostWholeResponse(t *testing.T) {
	var dropped atomic.Bool
	drop := func(channel string, packet bridge.Packet) bool {
		return packet.Type == bridge.MessageHttpResponse && dropped.CompareAndSwap(false, true)
	}
	s := start(t, echo(), false, true, drop)
	resp, err := http.Post(s.url+"/", "text/plain", strings.NewReader("small"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if !dropped.Load() || resp.StatusCode != 201 || string(body) != "small" {
		t.Fatalf("dropped %v, got %d %q", dropped.Load(), resp.StatusCode, body)
	}
}

// A HEAD response has the length of the body it doesn't have.
func TestHeadRequest(t *testing.T) {
	local := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "1234")
		w.Header().Set("X-Seen", r.Method)
	})
	s := start(t, local, false, true, nil)
	req, _ := http.NewRequest("HEAD", s.url+"/", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 || resp.Header.Get("X-Seen") != "HEAD" || resp.ContentLength != 1234 {
		t.Fatalf("got %d %v %d", resp.StatusCode, resp.Header, resp.ContentLength)
	}
}

// A packet of a streamed response that AppSync lost is asked for and sent
// again.
func TestLostResponsePacket(t *testing.T) {
	var dropped atomic.Bool
	drop := func(channel string, packet bridge.Packet) bool {
		return packet.Type == bridge.MessageHttpResponse && packet.Index == 1 && dropped.CompareAndSwap(false, true)
	}
	s := start(t, echo(), false, true, drop)
	payload := make([]byte, 2*bridge.BUFFER_SIZE)
	rand.Read(payload)
	resp, err := http.Post(s.url+"/", "application/octet-stream", bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if !dropped.Load() || !bytes.Equal(body, payload) {
		t.Fatalf("dropped %v, got %d bytes, want %d", dropped.Load(), len(body), len(payload))
	}
}

// A later packet of a request that AppSync loses after sst dev took it.
func TestLostRequestPacket(t *testing.T) {
	var dropped atomic.Bool
	drop := func(channel string, packet bridge.Packet) bool {
		return packet.Type == bridge.MessageHttpRequest && packet.Index == 1 && dropped.CompareAndSwap(false, true)
	}
	s := start(t, echo(), false, true, drop)
	payload := make([]byte, 2*bridge.BUFFER_SIZE)
	rand.Read(payload)
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Post(s.url+"/", "application/octet-stream", bytes.NewReader(payload))
	if err != nil {
		t.Fatalf("dropped %v: %v", dropped.Load(), err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if !dropped.Load() || !bytes.Equal(body, payload) {
		t.Fatalf("dropped %v, got %d bytes, want %d", dropped.Load(), len(body), len(payload))
	}
}

// A timer that fires as the response, a take or a ping arrives mustn't answer
// with a 503 or 504: late reports what it raced, and puts a ping back.
func TestLateTimerRaces(t *testing.T) {
	fresh := func() *request {
		return &request{taken: make(chan struct{}), pinged: make(chan struct{}, 1), response: make(chan bridge.Message, 1)}
	}

	r := fresh()
	if msg, pinged, taken := r.late(); msg != nil || pinged || taken {
		t.Fatalf("a request nothing came for: got %v %v %v, want nothing", msg, pinged, taken)
	}

	r = fresh()
	r.response <- bridge.Message{ID: "x"}
	if msg, _, _ := r.late(); msg == nil || msg.ID != "x" {
		t.Fatalf("a response that came as the timer fired: got %v, want it", msg)
	}

	r = fresh()
	r.take()
	if msg, pinged, taken := r.late(); msg != nil || pinged || !taken {
		t.Fatalf("a take that came as the timer fired: got %v %v %v, want taken only", msg, pinged, taken)
	}

	r = fresh()
	r.ping()
	if _, pinged, taken := r.late(); !pinged || !taken {
		t.Fatalf("a ping that came as the timer fired: got pinged=%v taken=%v, want both", pinged, taken)
	}
	select {
	case <-r.pinged:
	default:
		t.Fatal("late read the ping without putting it back for the loop")
	}
}
