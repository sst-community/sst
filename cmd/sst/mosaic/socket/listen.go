package socket

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/sst/sst/v3/pkg/bus"
	"github.com/sst/sst/v3/pkg/global"
	"github.com/sst/sst/v3/pkg/project"
)

const (
	// ConsoleOrigin is the only page the socket takes.
	ConsoleOrigin = "https://console.sst.dev"
	// Port and TLSPort are the ports the Console's page tries.
	Port    = 13557
	TLSPort = 14557
)

// Start serves the socket on loopback, at Port and, with `sst cert`'s
// certificate, at TLSPort over TLS, until ctx ends. It never stops sst dev:
// when a port is taken, as by another sst dev, the Console can't connect to
// this one, and sst dev says so and goes on. With serve false, as with
// SST_NO_CONSOLE, it serves nothing, but still warns about a root
// certificate that kept its key.
//
// The socket lets the Console's page in and nothing else a browser runs:
//
//   - It listens on 127.0.0.1 and ::1 only, so other machines can't reach it.
//   - It serves the socket alone, not the server the program calls back
//     into, nor the Lambda runtime API sst dev's workers call.
//   - A browser always sends the page's origin, so another site can't connect
//     to it, and a page that points its own name at this machine (DNS
//     rebinding) is refused for its host.
//   - What the Console sends is read only for log.cleared, a message of a few
//     bytes.
//
// What it can't keep out is a program on this machine, which can send any
// origin: another user's, or a container's through host.docker.internal. It
// can read every call sst dev keeps and shows the Console, whole (its input,
// with any request headers, its output and its logs), and clear them.
// SST_NO_CONSOLE turns the socket off.
func Start(ctx context.Context, p project.Program, serve bool) error {
	warnings := rootKeyWarnings(global.CertPath())
	if !serve {
		if len(warnings) > 0 {
			warnWhenReady(ctx, warnings)
		}
		return nil
	}
	certificate, certificateWarnings := consoleCertificate(global.CertPath(), time.Now())
	warnings = append(warnings, certificateWarnings...)
	ports := []int{Port}
	if certificate != nil {
		ports = append(ports, TLSPort)
	}
	listeners, err := listenPorts(ports...)
	if err != nil {
		warnings = append(warnings, fmt.Sprintf("The SST Console can't connect to this sst dev: %v, likely by another sst dev.", err))
	}
	if len(warnings) > 0 {
		go warnWhenReady(ctx, warnings)
	}
	if err != nil {
		return nil
	}
	all := listeners[0]
	if certificate != nil {
		for _, listener := range listeners[1] {
			all = append(all, tls.NewListener(listener, &tls.Config{
				Certificates: []tls.Certificate{*certificate},
				MinVersion:   tls.VersionTLS12,
			}))
		}
	}
	listen(ctx, newConsole(p.Name(), p.Stage()), all)
	return nil
}

// WarningEvent is something about the Console's local connection that the
// developer should do something about.
type WarningEvent struct {
	Message string
}

// warnWhenReady publishes the warnings once the first deploy of sst dev is
// done, when its UI is listening.
func warnWhenReady(ctx context.Context, warnings []string) {
	complete := bus.Subscribe(&project.CompleteEvent{})
	defer bus.Unsubscribe(complete)
	select {
	case <-ctx.Done():
		return
	case <-complete:
	}
	for _, warning := range warnings {
		slog.Warn("socket", "warning", warning)
		bus.Publish(&WarningEvent{Message: warning})
	}
}

// listen serves the socket on each listener until ctx ends.
func listen(ctx context.Context, c *console, listeners []net.Listener) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	server := &http.Server{
		Handler:           handler(ctx, c),
		ReadHeaderTimeout: 10 * time.Second,
		// to the CLI's log, not the terminal sst dev draws in: a browser
		// that doesn't trust the certificate fails every handshake
		ErrorLog: slog.NewLogLogger(slog.Default().Handler(), slog.LevelInfo),
	}
	for _, listener := range listeners {
		slog.Info("socket listening", "addr", listener.Addr())
		go server.Serve(listener)
	}
	go func() {
		<-ctx.Done()
		server.Close()
	}()
	c.run(ctx)
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return r.Header.Get("Origin") == ConsoleOrigin
	},
}

// handler takes the Console's connections at /socket, and nothing else.
func handler(ctx context.Context, c *console) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/socket" {
			http.NotFound(w, r)
			return
		}
		if !loopbackHost(r.Host) {
			http.Error(w, "the socket is only for this machine", http.StatusForbidden)
			return
		}
		if c.connections.Add(1) > maxConnections {
			c.connections.Add(-1)
			http.Error(w, "too many connections", http.StatusServiceUnavailable)
			return
		}
		// Upgrade answers anything but a websocket handshake from the
		// Console's page with an error
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			c.connections.Add(-1)
			return
		}
		c.read(ctx, ws)
	})
}

// loopbackHost is whether the host a request was sent to names this machine,
// as the Console's page does, and not a site's own name pointed at it.
func loopbackHost(host string) bool {
	name, _, err := net.SplitHostPort(host)
	if err != nil {
		name = host
	}
	name = strings.TrimSuffix(strings.ToLower(name), ".")
	if name == "localhost" {
		return true
	}
	ip := net.ParseIP(strings.Trim(name, "[]"))
	return ip != nil && ip.IsLoopback()
}

// listenPorts listens on each port at loopback, or on none when one is
// taken: the Console tries each port in turn, so two sst devs that took one
// each would look like one to it.
func listenPorts(ports ...int) ([][]net.Listener, error) {
	var all [][]net.Listener
	for _, port := range ports {
		listeners, err := listenLoopback(port)
		if err != nil {
			for _, open := range all {
				for _, listener := range open {
					listener.Close()
				}
			}
			return nil, fmt.Errorf("port %d is taken", port)
		}
		all = append(all, listeners)
	}
	return all, nil
}

// listenLoopback listens on port at 127.0.0.1, and at ::1 when the machine
// has it, which is where a browser can reach localhost. It listens on neither
// when 127.0.0.1's is taken: a browser asking for localhost could reach
// either listener, and the Console would see two sst devs as one.
func listenLoopback(port int) ([]net.Listener, error) {
	v4, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return nil, err
	}
	listeners := []net.Listener{v4}
	if v6, err := net.Listen("tcp", net.JoinHostPort("::1", strconv.Itoa(port))); err == nil {
		listeners = append(listeners, v6)
	}
	return listeners, nil
}

// rootKeyWarnings warns about the private key of a root certificate an
// earlier sst cert installed, as SST's own kept it.
func rootKeyWarnings(dir string) []string {
	key := filepath.Join(dir, "rootCA-key.pem")
	if _, err := os.Stat(key); err != nil {
		return nil
	}
	return []string{fmt.Sprintf("The root certificate an earlier sst cert installed still has its private key, at %s, so the key can sign a certificate for any site, which your machine would trust. Run sst cert again to replace the root with one whose key is deleted, or sst cert --remove to remove it.", key)}
}

// consoleCertificate is the certificate `sst cert` made in dir, or nil when it
// hasn't made one or the one it made can't be served, with what the developer
// should know about it.
func consoleCertificate(dir string, now time.Time) (*tls.Certificate, []string) {
	var warnings []string
	certFile, keyFile := filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	if _, err := os.Stat(certFile); errors.Is(err, fs.ErrNotExist) {
		return nil, warnings
	}
	certificate, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err == nil && certificate.Leaf == nil {
		certificate.Leaf, err = x509.ParseCertificate(certificate.Certificate[0])
	}
	if err != nil {
		return nil, append(warnings, fmt.Sprintf("The certificate sst cert made for the SST Console can't be read (%v), so Safari and Brave can't connect. Run sst cert again.", err))
	}
	expires := certificate.Leaf.NotAfter
	if now.After(expires) {
		return nil, append(warnings, fmt.Sprintf("The certificate sst cert made for the SST Console expired on %s, so Safari and Brave can't connect. Run sst cert again.", expires.Format("2006-01-02")))
	}
	if now.Add(30 * 24 * time.Hour).After(expires) {
		warnings = append(warnings, fmt.Sprintf("The certificate sst cert made for the SST Console expires on %s. Run sst cert again before then.", expires.Format("2006-01-02")))
	}
	return &certificate, warnings
}
