package local_test

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/bridge"
	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/local"
)

const token = "01234567890123456789012345678901"

func TestAuthentication(t *testing.T) {
	handler, err := local.NewServer(token)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(handler)
	defer srv.Close()
	for _, path := range []string{"/subscribe?channel=/sst/test/in", "/publish?channel=/sst/test/in"} {
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 401 {
			t.Fatalf("status %d", resp.StatusCode)
		}
	}
	if _, err := local.NewServer(""); err == nil {
		t.Fatal("accepted missing token")
	}
}

// A lost packet exercises the actual bridge's resend protocol over local HTTP.
type dropPacket struct {
	*local.Connection
	dropped bool
	mu      sync.Mutex
}

func (c *dropPacket) PublishBatch(ctx context.Context, ch string, events []interface{}) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	kept := []interface{}{}
	for _, event := range events {
		packet := event.(bridge.Packet)
		if packet.Index == 1 && packet.Type == bridge.MessageResponse && !c.dropped {
			c.dropped = true
			continue
		}
		kept = append(kept, event)
	}
	return c.Connection.PublishBatch(ctx, ch, kept)
}

func TestStreamRecoversMissingPacket(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	handler, _ := local.NewServer(token)
	srv := httptest.NewServer(handler)
	defer func() { cancel(); srv.Close() }()
	senderConn, _ := local.Dial(srv.URL, token)
	receiverConn, _ := local.Dial(srv.URL, token)
	sender := bridge.NewClient(ctx, &dropPacket{Connection: senderConn}, "sender", "/sst/test/sender")
	receiver := bridge.NewClient(ctx, receiverConn, "receiver", "/sst/test/receiver")
	receiver.AskForMissingOn("/sst/test/sender/in")
	payload := bytes.Repeat([]byte("streamed response"), 20000)
	writer := sender.NewWriter(bridge.MessageResponse, "/sst/test/receiver/in")
	writer.SetStreaming(true)
	if _, err := writer.Write(payload); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case message := <-receiver.Read():
		got, err := io.ReadAll(message.Body)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, payload) {
			t.Fatalf("got %d bytes, want %d", len(got), len(payload))
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

func TestReconnect(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	handler, _ := local.NewServer(token)
	srv := httptest.NewServer(handler)
	defer func() { cancel(); srv.Close() }()
	conn, _ := local.Dial(srv.URL, token)
	sub, err := conn.Subscribe(ctx, "/sst/test/in")
	if err != nil {
		t.Fatal(err)
	}
	if err := conn.Publish(ctx, "/sst/test/in", "first"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-sub:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	conn.Reconnect(ctx)
	for {
		if err := conn.Publish(ctx, "/sst/test/in", "again"); err != nil {
			t.Fatal(err)
		}
		select {
		case <-sub:
			return
		case <-time.After(20 * time.Millisecond):
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}

// net/http clears the read deadline before its background read on bodyless GETs.
// Keep this regression to distinguish request-body timeouts from stream lifetime.
func TestSubscriptionSurvivesServerReadTimeout(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	handler, _ := local.NewServer(token)
	srv := httptest.NewUnstartedServer(handler)
	srv.Config.ReadTimeout = 50 * time.Millisecond
	srv.Start()
	defer func() { cancel(); srv.Close() }()
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+"/subscribe?channel=/sst/timeout", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	// Use the original response, without Connection.Subscribe's reconnect loop.
	time.Sleep(150 * time.Millisecond)
	conn, _ := local.Dial(srv.URL, token)
	if err := conn.Publish(ctx, "/sst/timeout", "still connected"); err != nil {
		t.Fatal(err)
	}
	line := make([]byte, len("\"still connected\"\n"))
	if _, err := io.ReadFull(resp.Body, line); err != nil {
		t.Fatalf("subscription ended: %v", err)
	}
	if string(line) != "\"still connected\"\n" {
		t.Fatalf("unexpected event: %s", line)
	}
}
