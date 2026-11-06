// Package local transports the live-dev bridge over authenticated host HTTP.
package local

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Server keeps no event history: the bridge owns packet ordering and recovery.
type Server struct {
	token       string
	mu          sync.Mutex
	subscribers map[string]map[chan string]struct{}
}

func NewServer(token string) (*Server, error) {
	if len(token) < 32 {
		return nil, fmt.Errorf("Floci bridge requires a token of at least 32 characters")
	}
	return &Server{token: token, subscribers: make(map[string]map[chan string]struct{})}, nil
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+s.token)) != 1 {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	channel := r.URL.Query().Get("channel")
	if !strings.HasPrefix(channel, "/sst/") || len(channel) > 1024 {
		http.Error(w, "invalid channel", 400)
		return
	}
	switch {
	case r.Method == "GET" && r.URL.Path == "/subscribe":
		out := make(chan string, 128)
		s.mu.Lock()
		if s.subscribers[channel] == nil {
			s.subscribers[channel] = map[chan string]struct{}{}
		}
		s.subscribers[channel][out] = struct{}{}
		s.mu.Unlock()
		defer func() {
			s.mu.Lock()
			delete(s.subscribers[channel], out)
			if len(s.subscribers[channel]) == 0 {
				delete(s.subscribers, channel)
			}
			s.mu.Unlock()
		}()
		w.Header().Set("Content-Type", "application/x-ndjson")
		w.WriteHeader(200)
		controller := http.NewResponseController(w)
		if controller.Flush() != nil {
			return
		}
		for {
			select {
			case <-r.Context().Done():
				return
			case event := <-out:
				controller.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if _, err := io.WriteString(w, event+"\n"); err != nil {
					return
				}
				if controller.Flush() != nil {
					return
				}
			}
		}
	case r.Method == "POST" && r.URL.Path == "/publish":
		var events []json.RawMessage
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20)).Decode(&events); err != nil || len(events) > 5 {
			http.Error(w, "invalid batch", 400)
			return
		}
		// Reject the whole batch before enqueueing anything, including control
		// messages that the streaming resend protocol does not retain.
		s.mu.Lock()
		for subscriber := range s.subscribers[channel] {
			if cap(subscriber)-len(subscriber) < len(events) {
				s.mu.Unlock()
				http.Error(w, "subscriber queue full", http.StatusServiceUnavailable)
				return
			}
		}
		for subscriber := range s.subscribers[channel] {
			for _, event := range events {
				subscriber <- string(event)
			}
		}
		s.mu.Unlock()
		w.WriteHeader(204)
	default:
		http.NotFound(w, r)
	}
}

type statusError int

func (e statusError) Error() string { return fmt.Sprintf("Floci bridge returned HTTP %d", e) }

type Connection struct {
	endpoint, token string
	client          *http.Client
	mu              sync.Mutex
	streams         map[*http.Response]struct{}
}

func Dial(endpoint, token string) (*Connection, error) {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "http" || u.Host == "" || u.User != nil || u.RawQuery != "" || (u.Path != "" && u.Path != "/") || len(token) < 32 {
		return nil, fmt.Errorf("invalid Floci bridge endpoint or token")
	}
	// Local callbacks must never pass through an inherited proxy.
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.ResponseHeaderTimeout = 10 * time.Second
	return &Connection{endpoint: strings.TrimRight(endpoint, "/"), token: token, client: &http.Client{Transport: transport}, streams: map[*http.Response]struct{}{}}, nil
}

func (c *Connection) request(ctx context.Context, method, path, channel string, body io.Reader) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.endpoint+path+"?channel="+url.QueryEscape(channel), body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 300 {
		resp.Body.Close()
		return nil, statusError(resp.StatusCode)
	}
	return resp, nil
}

func (c *Connection) Publish(ctx context.Context, channel string, event interface{}) error {
	return c.PublishBatch(ctx, channel, []interface{}{event})
}
func (c *Connection) PublishBatch(ctx context.Context, channel string, events []interface{}) error {
	body, err := json.Marshal(events)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	for {
		resp, err := c.request(ctx, "POST", "/publish", channel, bytes.NewReader(body))
		if err == nil {
			resp.Body.Close()
			return nil
		}
		var status statusError
		if !errors.As(err, &status) || status != http.StatusServiceUnavailable {
			return err
		}
		// Only retry explicit rejection: transport errors can follow delivery.
		timer := time.NewTimer(50 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

func (c *Connection) Subscribe(ctx context.Context, channel string) (chan string, error) {
	resp, err := c.request(ctx, "GET", "/subscribe", channel, nil)
	if err != nil {
		return nil, err
	}
	out := make(chan string, 128)
	go func() {
		// Keep the channel open on shutdown, matching AppSync's subscription API.
		for {
			c.mu.Lock()
			c.streams[resp] = struct{}{}
			c.mu.Unlock()
			decoder := json.NewDecoder(resp.Body)
			for {
				var event json.RawMessage
				if decoder.Decode(&event) != nil {
					break
				}
				select {
				case out <- string(event):
				case <-ctx.Done():
					resp.Body.Close()
					c.mu.Lock()
					delete(c.streams, resp)
					c.mu.Unlock()
					return
				}
			}
			resp.Body.Close()
			c.mu.Lock()
			delete(c.streams, resp)
			c.mu.Unlock()
			retryDelay := 100 * time.Millisecond
			for {
				select {
				case <-ctx.Done():
					return
				case <-time.After(retryDelay):
				}
				resp, err = c.request(ctx, "GET", "/subscribe", channel, nil)
				if err == nil {
					break
				}
				if retryDelay == 100*time.Millisecond {
					slog.Warn("Floci bridge reconnect failed; retrying with backoff", "error", err)
				}
				retryDelay = min(retryDelay*2, 5*time.Second)
			}
		}
	}()
	return out, nil
}

func (c *Connection) Reconnect(ctx context.Context) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for stream := range c.streams {
		stream.Body.Close()
	}
}
