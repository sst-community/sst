package appsync

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"maps"
	"net/http"
	"net/url"
	"os"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	"github.com/gorilla/websocket"
	"github.com/sst/sst/v3/pkg/id"
)

var log = slog.Default().With("service", "appsync.connection")

var ErrSubscriptionFailed = fmt.Errorf("appsync subscription failed")
var ErrConnectionFailed = fmt.Errorf("appsync connection failed")

func getProxyURL(isHTTPS bool) (*url.URL, error) {
	var proxyEnv string

	if isHTTPS {
		proxyEnv = os.Getenv("HTTPS_PROXY")
		if proxyEnv == "" {
			proxyEnv = os.Getenv("https_proxy")
		}
	}

	if proxyEnv == "" {
		proxyEnv = os.Getenv("HTTP_PROXY")
		if proxyEnv == "" {
			proxyEnv = os.Getenv("http_proxy")
		}
	}

	if proxyEnv != "" {
		noProxy := os.Getenv("NO_PROXY")
		if noProxy == "" {
			noProxy = os.Getenv("no_proxy")
		}

		if noProxy == "*" {
			return nil, nil
		}
	}

	if proxyEnv == "" {
		return nil, nil
	}

	return url.Parse(proxyEnv)
}

func getHTTPClient() *http.Client {
	proxyURL, err := getProxyURL(true)
	if err != nil {
		log.Warn("failed to parse proxy URL", "err", err)
		return http.DefaultClient
	}

	if proxyURL == nil {
		return http.DefaultClient
	}

	log.Info("using proxy for HTTP requests", "proxy", proxyURL.String())
	return &http.Client{
		Transport: &http.Transport{
			Proxy: http.ProxyURL(proxyURL),
		},
	}
}

type Connection struct {
	conn             *websocket.Conn
	cfg              aws.Config
	httpEndpoint     string
	realtimeEndpoint string
	subscriptions    map[string]SubscriptionInfo
	lock             sync.Mutex
	ctx              context.Context
	reconnectLock    sync.Mutex
	// subscriptionsLock guards subscriptions, which the reader goroutine reads
	// while subscribe swaps entries. Never hold it while sending on Out.
	subscriptionsLock sync.Mutex

	// made once, so publishes through a proxy reuse their connections
	httpClient *http.Client
}

type SubscriptionInfo struct {
	Channel string
	Out     chan string
}

type SubscribeEvent struct {
	Type          string      `json:"type"`
	ID            string      `json:"id"`
	Channel       string      `json:"channel"`
	Authorization interface{} `json:"authorization"`
}

func Dial(
	ctx context.Context,
	cfg aws.Config,
	httpEndpoint string,
	realtimeEndpoint string,
) (*Connection, error) {
	result := &Connection{
		ctx:              ctx,
		cfg:              cfg,
		httpEndpoint:     httpEndpoint,
		realtimeEndpoint: realtimeEndpoint,
		httpClient:       getHTTPClient(),
		subscriptions:    map[string]SubscriptionInfo{},
	}

	err := result.connect(ctx)
	if err != nil {
		return nil, err
	}

	go func() {
		<-ctx.Done()
		if result.conn != nil {
			result.conn.Close()
		}
		result.subscriptionsLock.Lock()
		defer result.subscriptionsLock.Unlock()
		for _, item := range result.subscriptions {
			close(item.Out)
		}
	}()
	return result, nil
}

func (c *Connection) connect(ctx context.Context) error {
	log.Info("connecting")
	auth, err := c.getAuth(ctx, map[string]interface{}{})
	if err != nil {
		return err
	}
	authJson, err := json.Marshal(auth)
	if err != nil {
		return err
	}
	auth64 := base64.URLEncoding.WithPadding(base64.NoPadding).EncodeToString(authJson)

	// Configure WebSocket dialer with proxy support
	dialer := websocket.Dialer{
		Subprotocols: []string{"aws-appsync-event-ws", "header-" + auth64},
	}

	// Add proxy support to WebSocket dialer
	proxyURL, err := getProxyURL(true) // WebSocket uses wss:// (HTTPS)
	if err != nil {
		log.Warn("failed to parse proxy URL", "err", err)
	} else if proxyURL != nil {
		dialer.Proxy = http.ProxyURL(proxyURL)
		log.Info("using proxy for WebSocket connection", "proxy", proxyURL.String())
	}

	conn, _, err := dialer.DialContext(ctx, "wss://"+c.realtimeEndpoint+"/event/realtime", nil)
	if err != nil {
		return err
	}
	conn.WriteJSON(map[string]interface{}{
		"type": "connection_init",
	})
	c.conn = conn

	msg := map[string]interface{}{}
	err = conn.ReadJSON(&msg)
	if err != nil {
		log.Error("write to connection failed", "err", err)
		return ErrConnectionFailed
	}
	log.Info("connect message", "msg", msg)
	if msg["type"] != "connection_ack" {
		return ErrConnectionFailed
	}
	duration := time.Millisecond * time.Duration(msg["connectionTimeoutMs"].(float64))

	timer := time.NewTimer(duration)
	go func() {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			log.Info("connection timeout")
			c.reconnect(ctx, conn)
		}
	}()

	go func() {
		for {
			msg := map[string]interface{}{}
			err := conn.ReadJSON(&msg)
			if err != nil {
				log.Info("connection closed")
				timer.Reset(1 * time.Millisecond)
				return
			}
			log.Info("msg", "type", msg["type"], "id", msg["id"])

			if msg["type"] == "connection_ack" {
				duration = time.Millisecond * time.Duration(msg["connectionTimeoutMs"].(float64))
				log.Info("keep alive set", "duration", duration.Seconds())
				timer.Reset(duration)
			}

			if msg["type"] == "ka" {
				timer.Reset(duration)
			}

			if msg["type"] == "subscribe_success" {
				id := msg["id"].(string)
				if item, ok := c.subscription(id); ok {
					item.Out <- "ok"
				}
			}
			if t := msg["type"]; t == "data" {
				id := msg["id"].(string)
				if item, ok := c.subscription(id); ok {
					item.Out <- msg["event"].(string)
				}
			}
		}
	}()

	return nil
}

// reconnect replaces stale with a new connection and resubscribes. It does
// nothing if stale was already replaced, so a timeout and a Reconnect call
// never both redial.
func (c *Connection) reconnect(ctx context.Context, stale *websocket.Conn) {
	c.reconnectLock.Lock()
	defer c.reconnectLock.Unlock()
	if c.conn != stale {
		return
	}
	stale.Close()
	for {
		select {
		case <-ctx.Done():
			return
		default:
			err := c.connect(ctx)
			if err != nil {
				log.Info("failed to reconnect", "err", err)
				time.Sleep(time.Second * 5)
				continue
			}
			c.subscriptionsLock.Lock()
			subscriptions := maps.Clone(c.subscriptions)
			c.subscriptionsLock.Unlock()
			for id, sub := range subscriptions {
				log.Info("resubscribing", "channel", sub.Channel, "id", id)
				err := c.subscribe(ctx, sub.Channel, id)
				if err != nil {
					log.Error("failed to resubscribe", "err", err)
					continue
				}
			}
			return
		}
	}
}

// Reconnect replaces the websocket and resubscribes, for when the connection
// may have died without an error, such as after a Lambda freeze. It returns
// once resubscribed or when ctx is done; the reconnect itself carries on.
func (c *Connection) Reconnect(ctx context.Context) {
	done := make(chan struct{})
	go func() {
		defer close(done)
		if !c.reconnectLock.TryLock() {
			// A reconnect is already running. Wait for it rather than tearing
			// down the connection it is about to hand back.
			c.reconnectLock.Lock()
			c.reconnectLock.Unlock()
			return
		}
		stale := c.conn
		c.reconnectLock.Unlock()
		c.reconnect(c.ctx, stale)
	}()
	select {
	case <-done:
	case <-ctx.Done():
	}
}

func (c *Connection) Subscribe(ctx context.Context, channel string) (chan string, error) {
	out := make(chan string, 1000)
	subscriptionID := id.Ascending()
	c.setSubscription(subscriptionID, SubscriptionInfo{
		Channel: channel,
		Out:     out,
	})
	// On error, out is still returned: the subscription stays registered and
	// is retried on the next reconnect.
	err := c.subscribe(ctx, channel, subscriptionID)
	return out, err
}

func (c *Connection) subscription(id string) (SubscriptionInfo, bool) {
	c.subscriptionsLock.Lock()
	defer c.subscriptionsLock.Unlock()
	item, ok := c.subscriptions[id]
	return item, ok
}

func (c *Connection) setSubscription(id string, item SubscriptionInfo) {
	c.subscriptionsLock.Lock()
	defer c.subscriptionsLock.Unlock()
	c.subscriptions[id] = item
}

func (c *Connection) subscribe(ctx context.Context, channel string, subscriptionID string) error {
	c.lock.Lock()
	defer c.lock.Unlock()
	auth, err := c.getAuth(ctx, map[string]interface{}{
		"channel": channel,
	})
	if err != nil {
		return err
	}
	current, _ := c.subscription(subscriptionID)
	old := current.Out
	tmp := make(chan string, 1)
	defer func() {
		c.setSubscription(subscriptionID, SubscriptionInfo{
			Channel: channel,
			Out:     old,
		})
	}()
	c.setSubscription(subscriptionID, SubscriptionInfo{
		Channel: channel,
		Out:     tmp,
	})
	c.conn.WriteJSON(map[string]interface{}{
		"type":          "subscribe",
		"id":            subscriptionID,
		"channel":       channel,
		"authorization": auth,
	})
	select {
	case <-tmp:
		log.Info("subscribed", "channel", channel, "id", subscriptionID)
		return nil
	case <-time.After(time.Second * 3):
		return ErrSubscriptionFailed
	}
}

func (c *Connection) getAuth(ctx context.Context, body interface{}) (interface{}, error) {
	credentials, err := c.cfg.Credentials.Retrieve(ctx)
	if err != nil {
		return nil, err
	}
	bodyJson, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	bodyReader := bytes.NewReader(bodyJson)
	req, err := http.NewRequest("POST",
		"https://"+c.httpEndpoint+"/event",
		bodyReader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("accept", "application/json, text/javascript")
	req.Header.Set("content-encoding", "amz-1.0")
	req.Header.Set("content-type", "application/json; charset=UTF-8")

	// Compute SHA256 hash of the payload
	h := sha256.New()
	h.Write(bodyJson)
	payloadHash := hex.EncodeToString(h.Sum(nil))

	signer := v4.NewSigner()
	err = signer.SignHTTP(ctx,
		credentials,
		req,
		payloadHash,
		"appsync",
		c.cfg.Region,
		time.Now(),
	)
	auth := map[string]string{
		"accept":           req.Header.Get("accept"),
		"content-encoding": req.Header.Get("content-encoding"),
		"content-type":     req.Header.Get("content-type"),
		"host":             req.Host,
		"x-amz-date":       req.Header.Get("x-amz-date"),
		"Authorization":    req.Header.Get("Authorization"),
	}
	if req.Header.Get("X-Amz-Security-Token") != "" {
		auth["X-Amz-Security-Token"] = req.Header.Get("X-Amz-Security-Token")
	}
	return auth, nil
}

// How long Publish waits before each retry of a publish that was throttled or
// failed with a server or network error, 1.4 seconds in all, how long one
// attempt can take, and how long a publish can take with its retries. The
// bridge sends at most 128 KB at a time, and AppSync answers in well under a
// second, so an attempt that takes longer has most likely hung.
var (
	publishRetries = []time.Duration{
		100 * time.Millisecond,
		300 * time.Millisecond,
		time.Second,
	}
	publishAttemptTimeout = 5 * time.Second
	publishTimeout        = 10 * time.Second
)

// Publish sends an event to a channel. AppSync throttles a burst of events and
// sometimes fails a request, so a publish answered with a 429 or a 5xx, or that
// fails to connect, is tried again. Any other error is returned as is.
func (c *Connection) Publish(ctx context.Context, channel string, event interface{}) error {
	eventJson, err := json.Marshal(event)
	if err != nil {
		return err
	}
	body, err := json.Marshal(map[string]interface{}{
		"channel": channel,
		"events":  []string{string(eventJson)},
	})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, publishTimeout)
	defer cancel()
	for attempt := 0; ; attempt++ {
		retry, err := c.publish(ctx, channel, body)
		if err == nil || !retry || attempt == len(publishRetries) {
			return err
		}
		log.Warn("publish failed, trying again", "channel", channel, "attempt", attempt+1, "err", err)
		select {
		case <-ctx.Done():
			return err
		case <-time.After(publishRetries[attempt]):
		}
	}
}

// publish makes one attempt at a publish, and says whether a failed one is worth
// trying again. Each attempt is signed again, as a signature is for one time.
func (c *Connection) publish(ctx context.Context, channel string, body []byte) (bool, error) {
	credentials, err := c.cfg.Credentials.Retrieve(ctx)
	if err != nil {
		return false, err
	}
	attemptCtx, cancel := context.WithTimeout(ctx, publishAttemptTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(attemptCtx, "POST", "https://"+c.httpEndpoint+"/event", bytes.NewReader(body))
	if err != nil {
		return false, err
	}
	req.Header.Set("Content-Type", "application/json")
	signer := v4.NewSigner()
	h := sha256.New()
	h.Write(body)
	payloadHash := hex.EncodeToString(h.Sum(nil))
	err = signer.SignHTTP(ctx, credentials, req, payloadHash, "appsync", c.cfg.Region, time.Now())
	if err != nil {
		return false, err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		// an attempt that timed out is tried again, but not once the caller is done
		return ctx.Err() == nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		retry := resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500
		return retry, fmt.Errorf("request failed with status %d: %s", resp.StatusCode, string(bodyBytes))
	}

	// Say when AppSync answers that it didn't publish the event. Only logged, so
	// what a caller does after a publish doesn't change.
	bodyBytes, _ := io.ReadAll(resp.Body)
	if failedEvents(bodyBytes) > 0 {
		log.Error("event not published", "channel", channel, "response", string(bodyBytes))
	}

	return false, nil
}

// failedEvents counts the events a publish response lists as failed. A response
// it can't read counts none.
func failedEvents(body []byte) int {
	var result struct {
		Failed []json.RawMessage `json:"failed"`
	}
	if json.Unmarshal(body, &result) != nil {
		return 0
	}
	return len(result.Failed)
}
