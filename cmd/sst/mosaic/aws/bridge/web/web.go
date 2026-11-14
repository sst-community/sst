// Package web carries the HTTP requests of a web function that's live in sst
// dev: the Bridge, deployed as the web function, sends each request it gets to
// sst dev over AppSync, and the Forwarder in sst dev sends it to the local
// server and streams the response back.
//
// A request is a MessageHttpRequest with an ID of its own, so an environment
// can have many in flight. sst dev pings it as soon as it has it, and again
// while the local server works on it. Until the first ping, the bridge sends the
// request again with the same ID, as AppSync can take an event and not deliver
// it: a copy only fills in packets sst dev is missing. A request nobody takes is
// answered with a 503, so a caller isn't left waiting when sst dev isn't
// running. The response is streamed, so the bridge asks for a packet it's
// missing, and the Forwarder's Client sends it again.
package web

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/bridge"
	"github.com/sst/sst/v3/pkg/id"
)

// Messenger is what the bridge and the forwarder need from a bridge.Client.
type Messenger interface {
	NewWriter(message bridge.MessageType, destination string) *bridge.Writer
	Read() <-chan bridge.Message
}

var _ Messenger = (*bridge.Client)(nil)

// Defaults for a Bridge: how long it waits for sst dev to take a request, how
// often it sends it again until then, and how long it can go without a request
// before it checks its subscription again, as the environment may have been
// frozen with its WebSocket dead.
const (
	DefaultTakeTimeout = 5 * time.Second
	DefaultResendEvery = time.Second
	DefaultIdle        = 10 * time.Second
	// DefaultLostAfter is how long a request sst dev took can go without a ping
	// before the bridge answers it with a 504: several of sst dev's pings, so a
	// lost one doesn't end it.
	DefaultLostAfter = 20 * time.Second
)

// How often a Forwarder pings a request while the local server works on it,
// by default.
const DefaultPingEvery = 3 * time.Second

// hopHeaders are the headers of one connection, not of the request or
// response, which aren't passed on.
var hopHeaders = []string{
	"Connection",
	"Keep-Alive",
	"Proxy-Authenticate",
	"Proxy-Authorization",
	"Proxy-Connection",
	"Te",
	"Trailer",
	"Transfer-Encoding",
	"Upgrade",
}

func withoutHop(header http.Header) http.Header {
	header = header.Clone()
	if header == nil {
		header = http.Header{}
	}
	for _, field := range strings.Split(header.Get("Connection"), ",") {
		if field = strings.TrimSpace(field); field != "" {
			header.Del(field)
		}
	}
	for _, name := range hopHeaders {
		header.Del(name)
	}
	return header
}

// Bridge is the http.Handler of a web function that's live in sst dev.
type Bridge struct {
	Client     Messenger
	Prefix     string
	WorkerID   string
	FunctionID string
	// TakeTimeout is how long it waits for sst dev to take a request before it
	// answers it with a 503, and ResendEvery how often it sends it meanwhile.
	TakeTimeout time.Duration
	ResendEvery time.Duration
	// LostAfter is how long a request sst dev took can go without a ping, as
	// when sst dev exits, before it answers it with a 504.
	LostAfter time.Duration
	// Idle is how long it can go without a request before the next one checks
	// the subscription first, with Reconnect to reconnect it, if set.
	Idle      time.Duration
	Reconnect func(ctx context.Context)

	mu      sync.Mutex
	waiting map[string]*request
	probes  chan string
	// probeMu is held while the subscription is checked, so the requests that
	// come meanwhile wait for it
	probeMu    sync.Mutex
	lastActive time.Time
	started    bool
}

type request struct {
	taken    chan struct{}
	once     sync.Once
	pinged   chan struct{}
	response chan bridge.Message
}

func (r *request) take() { r.once.Do(func() { close(r.taken) }) }

// ping marks the request taken, and that sst dev is still working on it.
func (r *request) ping() {
	r.take()
	select {
	case r.pinged <- struct{}{}:
	default:
	}
}

// late is what a timer that just fired may have raced: a response that's
// already here, a ping that's waiting, or whether sst dev has taken the
// request. A ping it reads is put back for the loop.
func (r *request) late() (msg *bridge.Message, pinged bool, taken bool) {
	select {
	case m := <-r.response:
		msg = &m
	default:
	}
	select {
	case <-r.pinged:
		pinged = true
		r.ping()
	default:
	}
	select {
	case <-r.taken:
		taken = true
	default:
	}
	return msg, pinged, taken
}

func (b *Bridge) init() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.waiting == nil {
		b.waiting = map[string]*request{}
		b.probes = make(chan string, 16)
	}
}

func (b *Bridge) channel() string { return b.Prefix + "/" + b.WorkerID + "/in" }

// Run reads what sst dev sends the bridge, and passes each on to the request
// it's for. It runs until ctx is done.
func (b *Bridge) Run(ctx context.Context) {
	b.init()
	for {
		select {
		case <-ctx.Done():
			return
		case msg := <-b.Client.Read():
			switch msg.Type {
			case bridge.MessageProbe:
				select {
				case b.probes <- msg.ID:
				default:
				}
			case bridge.MessagePing:
				var taken bridge.HttpTakenBody
				json.NewDecoder(msg.Body).Decode(&taken)
				io.Copy(io.Discard, msg.Body)
				if r := b.find(taken.RequestID); r != nil {
					r.ping()
				}
			case bridge.MessageHttpResponse:
				r := b.find(msg.ID)
				if r == nil {
					io.Copy(io.Discard, msg.Body)
					continue
				}
				r.take()
				select {
				case r.response <- msg:
				default:
					// a second response with the same ID, which can't be
					io.Copy(io.Discard, msg.Body)
				}
			default:
				io.Copy(io.Discard, msg.Body)
			}
		}
	}
}

func (b *Bridge) find(id string) *request {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.waiting[id]
}

// Probe publishes probes to the bridge's own channel until one comes back, so
// sst dev is only sent a request once its answer can arrive. AppSync drops
// events that have no live subscriber, and after a freeze the WebSocket can be
// dead without an error. Run must be running.
func (b *Bridge) Probe(ctx context.Context) {
	b.init()
	b.probeMu.Lock()
	defer b.probeMu.Unlock()
	b.probe(ctx)
}

func (b *Bridge) probe(ctx context.Context) {
	defer func() {
		b.mu.Lock()
		b.lastActive = time.Now().Round(0)
		b.started = true
		b.mu.Unlock()
	}()
	sent := map[string]bool{}
	for attempt := 1; attempt <= 15; attempt++ {
		if (attempt == 4 || attempt == 10) && b.Reconnect != nil {
			slog.Warn("subscription is not delivering, reconnecting")
			reconnectCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			b.Reconnect(reconnectCtx)
			cancel()
			sent = map[string]bool{}
		}
		probeID := id.Ascending()
		sent[probeID] = true
		writer := b.Client.NewWriter(bridge.MessageProbe, b.channel())
		writer.SetID(probeID)
		writer.Close()
		wait := time.After(500 * time.Millisecond)
	drain:
		for {
			select {
			case <-ctx.Done():
				return
			case got := <-b.probes:
				if sent[got] {
					return
				}
			case <-wait:
				break drain
			}
		}
	}
	slog.Error("subscription never delivered a probe, continuing anyway")
}

// reprobe checks the subscription if the bridge has been idle for longer than
// Idle, once for all the requests that come meanwhile.
func (b *Bridge) reprobe(ctx context.Context) {
	idle := b.Idle
	if idle <= 0 {
		idle = DefaultIdle
	}
	b.mu.Lock()
	stale := !b.started || time.Since(b.lastActive) > idle
	b.mu.Unlock()
	if !stale {
		return
	}
	b.probeMu.Lock()
	defer b.probeMu.Unlock()
	b.mu.Lock()
	stale = !b.started || time.Since(b.lastActive) > idle
	b.mu.Unlock()
	if stale {
		b.probe(ctx)
	}
}

func (b *Bridge) active() {
	b.mu.Lock()
	b.lastActive = time.Now().Round(0)
	b.mu.Unlock()
}

// ServeHTTP sends the request to sst dev, and writes the response it streams
// back. A request sst dev doesn't take within TakeTimeout gets a 503.
func (b *Bridge) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	b.init()
	ctx := r.Context()
	b.reprobe(ctx)
	// A web function's request is half-duplex: its body is read whole before
	// the response starts.
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "sst dev: failed to read the request body: "+err.Error(), http.StatusBadRequest)
		return
	}
	header := r.Header.Clone()
	if len(body) > 0 || r.ContentLength >= 0 {
		header.Set("Content-Length", strconv.Itoa(len(body)))
	}
	var payload bytes.Buffer
	if err := bridge.WriteHead(&payload, bridge.HttpRequestHead{
		FunctionID: b.FunctionID,
		Method:     r.Method,
		URI:        r.URL.RequestURI(),
		Host:       r.Host,
		Header:     header,
	}); err != nil {
		http.Error(w, "sst dev: "+err.Error(), http.StatusInternalServerError)
		return
	}
	payload.Write(body)

	requestID := id.Ascending()
	pending := &request{taken: make(chan struct{}), pinged: make(chan struct{}, 1), response: make(chan bridge.Message, 1)}
	b.mu.Lock()
	b.waiting[requestID] = pending
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		delete(b.waiting, requestID)
		b.mu.Unlock()
		b.active()
	}()

	// the first copy goes over the WebSocket where it can, as it reaches sst dev
	// sooner, and the copies over HTTPS
	send := func(overSocket bool) {
		writer := b.Client.NewWriter(bridge.MessageHttpRequest, b.Prefix+"/in")
		writer.SetID(requestID)
		writer.SetOverSocket(overSocket)
		if _, err := writer.Write(payload.Bytes()); err == nil {
			err = writer.Close()
		} else {
			writer.Close()
		}
		if err != nil {
			slog.Warn("failed to send request", "requestID", requestID, "err", err)
		}
	}
	send(true)

	takeTimeout, resendEvery, lostAfter := b.TakeTimeout, b.ResendEvery, b.LostAfter
	if takeTimeout <= 0 {
		takeTimeout = DefaultTakeTimeout
	}
	if resendEvery <= 0 {
		resendEvery = DefaultResendEvery
	}
	if lostAfter <= 0 {
		lostAfter = DefaultLostAfter
	}
	timeout := time.NewTimer(takeTimeout)
	defer timeout.Stop()
	resends := time.NewTicker(resendEvery)
	defer resends.Stop()
	// set once sst dev takes the request, and reset by each of its pings
	lost := time.NewTimer(lostAfter)
	lost.Stop()
	defer lost.Stop()
	taken := pending.taken
	for {
		select {
		case <-ctx.Done():
			return
		case <-taken:
			// it's sst dev's now, while it keeps pinging it
			taken = nil
			timeout.Stop()
			resends.Stop()
			lost.Reset(lostAfter)
		case <-pending.pinged:
			if taken == nil {
				lost.Reset(lostAfter)
			}
		case <-lost.C:
			// a response or ping that came as the timer fired wins
			if msg, pinged, _ := pending.late(); msg != nil {
				writeResponse(w, *msg)
				return
			} else if pinged {
				lost.Reset(lostAfter)
				continue
			}
			slog.Warn("sst dev stopped answering the request", "requestID", requestID)
			http.Error(w, "sst dev took this request, then stopped answering it for "+lostAfter.String()+" (worker: "+b.WorkerID+"). Check that `sst dev` is still running.", http.StatusGatewayTimeout)
			return
		case <-resends.C:
			send(false)
		case <-timeout.C:
			// a response or take that came as the timer fired wins; the
			// take case then runs next
			if msg, pinged, taken := pending.late(); msg != nil {
				writeResponse(w, *msg)
				return
			} else if pinged || taken {
				continue
			}
			slog.Warn("sst dev didn't take the request", "requestID", requestID)
			http.Error(w, unavailable(b.WorkerID, takeTimeout), http.StatusServiceUnavailable)
			return
		case msg := <-pending.response:
			writeResponse(w, msg)
			return
		}
	}
}

func unavailable(workerID string, waited time.Duration) string {
	return "sst dev didn't take this request within " + waited.String() + " (worker: " + workerID + "). Check that `sst dev` is running for this stage."
}

// writeResponse writes a response sst dev streamed back. One that ends before
// it's whole aborts the connection, so the caller can tell.
func writeResponse(w http.ResponseWriter, msg bridge.Message) {
	var head bridge.HttpResponseHead
	rest, err := bridge.ReadHead(msg.Body, &head)
	if err != nil {
		http.Error(w, "sst dev: failed to read the response: "+err.Error(), http.StatusBadGateway)
		go io.Copy(io.Discard, msg.Body)
		return
	}
	for key, values := range withoutHop(head.Header) {
		w.Header()[key] = values
	}
	w.WriteHeader(head.Status)
	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 32*1024)
	for {
		n, err := rest.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				go io.Copy(io.Discard, rest)
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if errors.Is(err, io.EOF) {
			return
		}
		if err != nil {
			slog.Warn("response ended before it was whole", "err", err)
			panic(http.ErrAbortHandler)
		}
	}
}

// Forwarder sends the requests of the web functions live in sst dev to their
// local servers.
type Forwarder struct {
	Client Messenger
	Prefix string
	// Target gives the local server's URL for a web function, if it's live
	Target func(functionID string) (string, bool)
	// HTTP sends the requests. It must not follow redirects or decompress
	// responses, so they pass through as the local server sent them.
	HTTP *http.Client
	// PingEvery is how often it pings a request until the response starts.
	PingEvery time.Duration
}

// A response sent whole is sent again wholeCopies times, wholeCopyEvery apart,
// as AppSync can take an event and not deliver it. The bridge drops a copy of
// one it had, so a copy only counts when the first was lost.
const (
	wholeCopies    = 2
	wholeCopyEvery = 1500 * time.Millisecond
)

// sendWhole sends a response that fits in a packet, over the WebSocket, and
// its copies in the background, over HTTPS.
func (f *Forwarder) sendWhole(ctx context.Context, log *slog.Logger, id, replyTo string, data []byte) {
	send := func(overSocket bool) {
		writer := f.Client.NewWriter(bridge.MessageHttpResponse, replyTo)
		writer.SetID(id)
		writer.SetOverSocket(overSocket)
		writer.Write(data)
		if err := writer.Close(); err != nil {
			log.Warn("failed to send response", "err", err)
		}
	}
	send(true)
	go func() {
		for range wholeCopies {
			select {
			case <-ctx.Done():
				return
			case <-time.After(wholeCopyEvery):
			}
			send(false)
		}
	}()
}

// NewHTTPClient makes the client a Forwarder sends requests with.
func NewHTTPClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DisableCompression = true
	transport.MaxIdleConnsPerHost = 64
	return &http.Client{
		Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// Handle sends a MessageHttpRequest to the local server and streams its
// response back. It returns when the response is sent.
func (f *Forwarder) Handle(ctx context.Context, msg bridge.Message) {
	log := slog.Default().With("service", "aws.web", "requestID", msg.ID, "workerID", msg.Source)
	replyTo := f.Prefix + "/" + msg.Source + "/in"
	ping := func() {
		// a ping of its own ID each time, as a copy of one is dropped
		writer := f.Client.NewWriter(bridge.MessagePing, replyTo)
		data, _ := json.Marshal(bridge.HttpTakenBody{RequestID: msg.ID})
		writer.Write(data)
		if err := writer.Close(); err != nil {
			log.Warn("failed to ping", "err", err)
		}
	}
	ping()
	answered := make(chan struct{})
	every := f.PingEvery
	if every <= 0 {
		every = DefaultPingEvery
	}
	go func() {
		pings := time.NewTicker(every)
		defer pings.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-answered:
				return
			case <-pings.C:
				ping()
			}
		}
	}()
	// answer sends the response. One whose length is known, that fits in a
	// packet with its head, as most do, is sent whole, over the WebSocket, as it
	// reaches the bridge sooner, and sent again a few times, as AppSync can lose
	// it: the bridge passes on the first copy, and drops the others. Any other is
	// streamed as the local server sends it.
	answer := func(status int, header http.Header, body io.Reader, length int64) {
		var first bytes.Buffer
		bridge.WriteHead(&first, bridge.HttpResponseHead{Status: status, Header: header})
		if length >= 0 && int64(first.Len())+length <= bridge.BUFFER_SIZE {
			// one that ends early is sent as it is, shorter than its length,
			// so the caller can tell
			if _, err := io.CopyN(&first, body, length); err != nil {
				log.Warn("local response ended early", "err", err)
			}
			close(answered)
			f.sendWhole(ctx, log, msg.ID, replyTo, first.Bytes())
			return
		}
		writer := f.Client.NewWriter(bridge.MessageHttpResponse, replyTo)
		writer.SetID(msg.ID)
		writer.SetStreaming(true)
		buf := make([]byte, bridge.BUFFER_SIZE)
		// the head goes with the body's first part, in one packet
		n, err := body.Read(buf)
		first.Write(buf[:n])
		close(answered)
		if _, werr := writer.Write(first.Bytes()); werr != nil {
			log.Error("failed to send response", "err", werr)
			writer.Close()
			return
		}
		for err == nil {
			n, err = body.Read(buf)
			if n > 0 {
				if _, werr := writer.Write(buf[:n]); werr != nil {
					log.Error("failed to send response", "err", werr)
					break
				}
			}
		}
		if err != nil && !errors.Is(err, io.EOF) {
			log.Warn("local response ended early", "err", err)
		}
		if err := writer.Close(); err != nil {
			log.Error("failed to send response", "err", err)
		}
	}
	fail := func(status int, message string) {
		message += "\n"
		answer(status, http.Header{"Content-Type": {"text/plain; charset=utf-8"}}, strings.NewReader(message), int64(len(message)))
	}

	var head bridge.HttpRequestHead
	rest, err := bridge.ReadHead(msg.Body, &head)
	if err != nil {
		log.Error("failed to read request", "err", err)
		fail(http.StatusBadGateway, "sst dev: failed to read the request: "+err.Error())
		go io.Copy(io.Discard, msg.Body)
		return
	}
	target, ok := f.Target(head.FunctionID)
	if !ok {
		fail(http.StatusServiceUnavailable, fmt.Sprintf("sst dev: the %q web function isn't live in this sst dev.", head.FunctionID))
		go io.Copy(io.Discard, rest)
		return
	}
	base, err := url.Parse(target)
	if err != nil {
		fail(http.StatusBadGateway, "sst dev: bad dev.url: "+err.Error())
		go io.Copy(io.Discard, rest)
		return
	}
	req, err := http.NewRequestWithContext(ctx, head.Method, base.Scheme+"://"+base.Host+head.URI, rest)
	if err != nil {
		fail(http.StatusBadGateway, "sst dev: bad request: "+err.Error())
		go io.Copy(io.Discard, rest)
		return
	}
	req.Header = withoutHop(head.Header)
	if length, err := strconv.ParseInt(req.Header.Get("Content-Length"), 10, 64); err == nil {
		req.ContentLength = length
		if length == 0 {
			req.Body = http.NoBody
		}
	}
	req.Header.Del("Content-Length")
	if req.Header.Get("X-Forwarded-Host") == "" && head.Host != "" {
		req.Header.Set("X-Forwarded-Host", head.Host)
	}
	if req.Header.Get("X-Forwarded-Proto") == "" {
		req.Header.Set("X-Forwarded-Proto", "https")
	}
	log.Info("forwarding", "functionID", head.FunctionID, "method", head.Method, "uri", head.URI)
	resp, err := f.HTTP.Do(req)
	if err != nil {
		fail(http.StatusBadGateway, fmt.Sprintf("sst dev couldn't reach the local server of %q at %s: %s", head.FunctionID, target, err))
		// what the transport didn't send of the body
		go io.Copy(io.Discard, rest)
		return
	}
	defer resp.Body.Close()
	length := resp.ContentLength
	// these have a length, and no body
	if head.Method == http.MethodHead || resp.StatusCode == http.StatusNoContent || resp.StatusCode == http.StatusNotModified {
		length = 0
	}
	answer(resp.StatusCode, withoutHop(resp.Header), resp.Body, length)
}
