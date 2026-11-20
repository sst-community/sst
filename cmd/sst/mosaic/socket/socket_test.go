package socket

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/sst/sst/v3/cmd/sst/mosaic/aws"
	"github.com/sst/sst/v3/pkg/bus"
)

// start serves the socket on 127.0.0.1 at a port of its own, and returns its
// address.
func start(t *testing.T, wrap func(net.Listener) net.Listener) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	if wrap != nil {
		listener = wrap(listener)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		listen(ctx, newConsole("app", "stage"), []net.Listener{listener})
		close(done)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	return address
}

type message struct {
	Type       string          `json:"type"`
	Properties json.RawMessage `json:"properties"`
}

func dial(t *testing.T, url string, header http.Header, dialer *websocket.Dialer) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	if dialer == nil {
		dialer = &websocket.Dialer{HandshakeTimeout: 5 * time.Second}
	}
	ws, resp, err := dialer.Dial(url, header)
	if ws != nil {
		t.Cleanup(func() { ws.Close() })
	}
	return ws, resp, err
}

func consoleHeader() http.Header {
	return http.Header{"Origin": {ConsoleOrigin}}
}

func next(t *testing.T, ws *websocket.Conn) message {
	t.Helper()
	ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	var got message
	if err := ws.ReadJSON(&got); err != nil {
		t.Fatal(err)
	}
	return got
}

// connect connects as the Console does, and reads what's sent first.
func connect(t *testing.T, address string) (*websocket.Conn, []Invocation) {
	t.Helper()
	ws, _, err := dial(t, "ws://"+address+"/socket", consoleHeader(), nil)
	if err != nil {
		t.Fatal(err)
	}
	hello := next(t, ws)
	var dev CliDevEvent
	if hello.Type != "cli.dev" || json.Unmarshal(hello.Properties, &dev) != nil || dev.App != "app" || dev.Stage != "stage" {
		t.Fatalf("first message %s %s", hello.Type, hello.Properties)
	}
	kept := next(t, ws)
	var invocations []Invocation
	if kept.Type != "invocation" || json.Unmarshal(kept.Properties, &invocations) != nil {
		t.Fatalf("second message %s %s", kept.Type, kept.Properties)
	}
	return ws, invocations
}

// invocation reads the next invocation sent.
func nextInvocation(t *testing.T, ws *websocket.Conn) Invocation {
	t.Helper()
	got := next(t, ws)
	var invocations []Invocation
	if got.Type != "invocation" || json.Unmarshal(got.Properties, &invocations) != nil || len(invocations) != 1 {
		t.Fatalf("got %s %s", got.Type, got.Properties)
	}
	return invocations[0]
}

func TestSocketTakesOnlyTheConsole(t *testing.T) {
	address := start(t, nil)
	_, port, _ := net.SplitHostPort(address)
	for _, test := range []struct {
		name   string
		path   string
		header http.Header
		status int
	}{
		{"another site's page", "/socket", http.Header{"Origin": {"https://example.com"}}, http.StatusForbidden},
		{"a page served on this machine", "/socket", http.Header{"Origin": {"http://localhost:3000"}}, http.StatusForbidden},
		{"the Console over plain HTTP", "/socket", http.Header{"Origin": {"http://console.sst.dev"}}, http.StatusForbidden},
		{"no origin", "/socket", http.Header{}, http.StatusForbidden},
		{"a site's own name pointed at this machine", "/socket", http.Header{"Origin": {ConsoleOrigin}, "Host": {"rebind.example.com:" + port}}, http.StatusForbidden},
		{"another path", "/rpc", consoleHeader(), http.StatusNotFound},
	} {
		t.Run(test.name, func(t *testing.T) {
			ws, resp, err := dial(t, "ws://"+address+test.path, test.header, nil)
			if err == nil {
				ws.Close()
				t.Fatal("connected")
			}
			if resp == nil || resp.StatusCode != test.status {
				t.Fatalf("answered %v, want %d", resp, test.status)
			}
		})
	}
	t.Run("the Console, at localhost", func(t *testing.T) {
		ws, _, err := dial(t, "ws://"+address+"/socket", http.Header{"Origin": {ConsoleOrigin}, "Host": {"localhost:" + port}}, nil)
		if err != nil {
			t.Fatal(err)
		}
		if got := next(t, ws); got.Type != "cli.dev" {
			t.Fatalf("first message %s", got.Type)
		}
	})
	t.Run("a plain request for the socket", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "http://"+address+"/socket", nil)
		req.Header.Set("Origin", ConsoleOrigin)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode < 400 {
			t.Fatalf("answered %d", resp.StatusCode)
		}
	})
}

func TestSocketSendsTheFunctionCalls(t *testing.T) {
	address := start(t, nil)
	ws, kept := connect(t, address)
	if len(kept) != 0 {
		t.Fatalf("kept %d", len(kept))
	}

	bus.Publish(&aws.FunctionInvokedEvent{FunctionID: "Fn", RequestID: "r1", Input: []byte(`{"a":1}`)})
	if got := nextInvocation(t, ws); got.ID != "r1" || string(got.Input) != `{"a":1}` {
		t.Fatalf("invoked %+v", got)
	}
	bus.Publish(&aws.FunctionLogEvent{FunctionID: "Fn", RequestID: "r1", Line: "\x1b[31mhello\x1b[0m"})
	if got := nextInvocation(t, ws); len(got.Logs) != 1 || got.Logs[0].Message != "hello" {
		t.Fatalf("logged %+v", got.Logs)
	}
	// a function's output needn't be JSON
	bus.Publish(&aws.FunctionResponseEvent{FunctionID: "Fn", RequestID: "r1", Output: []byte("plain text")})
	if got := nextInvocation(t, ws); string(got.Output) != `"plain text"` || got.Report == nil {
		t.Fatalf("responded %s %+v", got.Output, got.Report)
	}
	bus.Publish(&aws.FunctionInvokedEvent{FunctionID: "Fn", RequestID: "r2"})
	nextInvocation(t, ws)
	bus.Publish(&aws.FunctionErrorEvent{FunctionID: "Fn", RequestID: "r2", ErrorType: "Error", ErrorMessage: "boom", Trace: []string{"at x"}})
	if got := nextInvocation(t, ws); len(got.Errors) != 1 || got.Errors[0].Message != "boom" || len(got.Errors[0].Stack) != 1 {
		t.Fatalf("failed %+v", got.Errors)
	}

	// what a Console that connects later is sent
	_, kept = connect(t, address)
	if len(kept) != 2 {
		t.Fatalf("a later Console was sent %d", len(kept))
	}

	// malformed messages are passed over, and the socket stays
	for _, data := range []string{`not json`, `{"type":"log.cleared"}`, `{"type":"log.cleared","properties":"all"}`, `{"type":"log.cleared","properties":{"source":1}}`, `{"type":"other"}`} {
		if err := ws.WriteMessage(websocket.TextMessage, []byte(data)); err != nil {
			t.Fatal(err)
		}
	}
	if err := ws.WriteJSON(map[string]any{"type": "log.cleared", "properties": map[string]any{"source": "all"}}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, kept = connect(t, address); len(kept) == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("log.cleared left %d", len(kept))
		}
		time.Sleep(20 * time.Millisecond)
	}
	bus.Publish(&aws.FunctionInvokedEvent{FunctionID: "Fn", RequestID: "r3"})
	if got := nextInvocation(t, ws); got.ID != "r3" {
		t.Fatalf("after the malformed messages, got %+v", got)
	}
}

func TestSocketClosesOnALargeMessage(t *testing.T) {
	address := start(t, nil)
	ws, _ := connect(t, address)
	if err := ws.WriteMessage(websocket.TextMessage, []byte(strings.Repeat("x", maxMessageBytes+1))); err != nil {
		t.Fatal(err)
	}
	ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		if _, _, err := ws.ReadMessage(); err != nil {
			if strings.Contains(err.Error(), "timeout") {
				t.Fatal("the socket stayed open")
			}
			return
		}
	}
}

func TestListenLoopback(t *testing.T) {
	listeners, err := listenLoopback(0)
	if err != nil {
		t.Fatal(err)
	}
	for _, listener := range listeners {
		defer listener.Close()
		if ip := listener.Addr().(*net.TCPAddr).IP; !ip.IsLoopback() {
			t.Fatalf("listens on %v", ip)
		}
	}

	t.Run("listens on neither address when 127.0.0.1's port is taken", func(t *testing.T) {
		taken, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		defer taken.Close()
		port := taken.Addr().(*net.TCPAddr).Port
		if listeners, err := listenLoopback(port); err == nil {
			for _, listener := range listeners {
				listener.Close()
			}
			t.Fatal("listened on a taken port")
		}

		// with the TLS port free, the plain one taken: neither is kept
		free, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		freePort := free.Addr().(*net.TCPAddr).Port
		free.Close()
		if _, err := listenPorts(freePort, port); err == nil {
			t.Fatal("listened with a port taken")
		}
		again, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", fmt.Sprint(freePort)))
		if err != nil {
			t.Fatalf("the free port was kept: %v", err)
		}
		again.Close()
	})
}

func TestSocketOverTLS(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	if certificate, warnings := consoleCertificate(dir, now); certificate != nil || len(warnings) != 0 {
		t.Fatalf("without sst cert's files: %v, %v", certificate, warnings)
	}
	pool := writeCertificate(t, dir, now.Add(90*24*time.Hour))
	certificate, warnings := consoleCertificate(dir, now)
	if certificate == nil || len(warnings) != 0 {
		t.Fatalf("with sst cert's files: %v, %v", certificate, warnings)
	}
	address := start(t, func(listener net.Listener) net.Listener {
		return tls.NewListener(listener, &tls.Config{Certificates: []tls.Certificate{*certificate}, MinVersion: tls.VersionTLS12})
	})
	ws, _, err := dial(t, "wss://"+address+"/socket", consoleHeader(), &websocket.Dialer{
		HandshakeTimeout: 5 * time.Second,
		TLSClientConfig:  &tls.Config{RootCAs: pool, ServerName: "localhost"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := next(t, ws); got.Type != "cli.dev" {
		t.Fatalf("first message %s", got.Type)
	}

	t.Run("a certificate that can't be read", func(t *testing.T) {
		dir := t.TempDir()
		os.WriteFile(filepath.Join(dir, "cert.pem"), []byte("not a certificate"), 0600)
		if certificate, warnings := consoleCertificate(dir, now); certificate != nil || !mentions(warnings, "can't be read") {
			t.Fatalf("%v, %v", certificate, warnings)
		}
	})

	t.Run("a certificate that expires soon is served, with a warning", func(t *testing.T) {
		dir := t.TempDir()
		writeCertificate(t, dir, now.Add(10*24*time.Hour))
		if certificate, warnings := consoleCertificate(dir, now); certificate == nil || !mentions(warnings, "expires on") {
			t.Fatalf("%v, %v", certificate, warnings)
		}
	})

	t.Run("an expired certificate isn't served", func(t *testing.T) {
		dir := t.TempDir()
		writeCertificate(t, dir, now.Add(-time.Minute))
		if certificate, warnings := consoleCertificate(dir, now); certificate != nil || !mentions(warnings, "expired on") {
			t.Fatalf("%v, %v", certificate, warnings)
		}
	})

	t.Run("a root key an earlier sst cert left is warned about", func(t *testing.T) {
		dir := t.TempDir()
		os.WriteFile(filepath.Join(dir, "rootCA-key.pem"), []byte("key"), 0400)
		if warnings := rootKeyWarnings(dir); !mentions(warnings, "still has its private key") {
			t.Fatalf("%v", warnings)
		}
		if warnings := rootKeyWarnings(t.TempDir()); len(warnings) != 0 {
			t.Fatalf("without a key: %v", warnings)
		}
	})
}

func mentions(warnings []string, text string) bool {
	for _, warning := range warnings {
		if strings.Contains(warning, text) {
			return true
		}
	}
	return false
}

// writeCertificate writes a certificate for localhost to dir, as sst cert
// does, valid until expires, and returns a pool that trusts it.
func writeCertificate(t *testing.T, dir string, expires time.Time) *x509.CertPool {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "localhost"},
		DNSNames:     []string{"localhost"},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
		NotBefore:    expires.Add(-365 * 24 * time.Hour),
		NotAfter:     expires,
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(dir, "cert.pem"), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0600)
	os.WriteFile(filepath.Join(dir, "key.pem"), pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), 0600)
	parsed, _ := x509.ParseCertificate(der)
	pool := x509.NewCertPool()
	pool.AddCert(parsed)
	return pool
}

func TestLoopbackHost(t *testing.T) {
	for host, want := range map[string]bool{
		"localhost:13557":          true,
		"LOCALHOST:13557":          true,
		"localhost.:13557":         true,
		"127.0.0.1:13557":          true,
		"[::1]:13557":              true,
		"localhost":                true,
		"rebind.example.com:13557": false,
		"192.168.1.5:13557":        false,
		"localhost.example.com":    false,
		"":                         false,
	} {
		if got := loopbackHost(host); got != want {
			t.Errorf("loopbackHost(%q) = %v", host, got)
		}
	}
}

func TestSocketTakesSoManyConnections(t *testing.T) {
	address := start(t, nil)
	for range maxConnections {
		connect(t, address)
	}
	ws, resp, err := dial(t, "ws://"+address+"/socket", consoleHeader(), nil)
	if err == nil {
		ws.Close()
		t.Fatal("connected over the limit")
	}
	if resp == nil || resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("answered %v", resp)
	}
}

// A Console that doesn't read holds up neither the event loop nor the others.
func TestSocketIsntHeldUpByAConsoleThatDoesntRead(t *testing.T) {
	address := start(t, nil)
	// a call large enough to fill the connection's buffers
	big := `"` + strings.Repeat("x", 8<<20) + `"`
	bus.Publish(&aws.FunctionInvokedEvent{FunctionID: "Fn", RequestID: "big", Input: []byte(big)})
	reader, _ := connect(t, address)
	nextInvocation(t, reader)
	for range 3 {
		// connects, and never reads what it's sent
		if _, _, err := dial(t, "ws://"+address+"/socket", consoleHeader(), nil); err != nil {
			t.Fatal(err)
		}
	}
	time.Sleep(200 * time.Millisecond)
	started := time.Now()
	bus.Publish(&aws.FunctionInvokedEvent{FunctionID: "Fn", RequestID: "after"})
	if got := nextInvocation(t, reader); got.ID != "after" {
		t.Fatalf("got %s", got.ID)
	}
	if took := time.Since(started); took > time.Second {
		t.Fatalf("a Console that reads waited %v", took)
	}
}

func TestSocketSendsTextThatIsntUTF8AsAString(t *testing.T) {
	address := start(t, nil)
	ws, _ := connect(t, address)
	bus.Publish(&aws.FunctionInvokedEvent{FunctionID: "Fn", RequestID: "latin1", Input: []byte("{\"name\":\"Jos\xe9\"}")})
	got := nextInvocation(t, ws)
	var input string
	if err := json.Unmarshal(got.Input, &input); err != nil || !strings.Contains(input, "Jos") {
		t.Fatalf("input %s, %v", got.Input, err)
	}
	// the connection is still good
	bus.Publish(&aws.FunctionInvokedEvent{FunctionID: "Fn", RequestID: "next"})
	if got := nextInvocation(t, ws); got.ID != "next" {
		t.Fatalf("got %s", got.ID)
	}
}

// A function that logs many lines quickly sends its call a few times, not
// once a line, and the last one has every line.
func TestSocketSendsAChangedCallTogether(t *testing.T) {
	address := start(t, nil)
	ws, _ := connect(t, address)
	bus.Publish(&aws.FunctionInvokedEvent{FunctionID: "Fn", RequestID: "chatty"})
	nextInvocation(t, ws)
	for i := range 500 {
		bus.Publish(&aws.FunctionLogEvent{FunctionID: "Fn", RequestID: "chatty", Line: fmt.Sprint("line ", i)})
	}
	messages := 0
	for {
		got := nextInvocation(t, ws)
		messages++
		if len(got.Logs) == 500 {
			break
		}
	}
	if messages > 20 {
		t.Fatalf("sent the call %d times for 500 lines", messages)
	}
}
