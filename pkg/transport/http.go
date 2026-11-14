package transport

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/bridge"
	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/httpbus"
)

var _ bridge.Connection = (*httpbus.Connection)(nil)

// HTTP is the transport for a stage whose functions run in containers on
// this machine, like an emulator's: the stub reaches sst dev over HTTP, with a
// token on every request. It's #212's, by rogueturnip.
//
// sst dev listens on 127.0.0.1, which Docker Desktop's containers reach as
// host.docker.internal. On Linux, where that's the Docker bridge's address,
// it listens there too, and only while it runs.
type HTTP struct {
	// path is the file that keeps the stage's port and token, so each run
	// gives the stub the same ones and doesn't redeploy it
	path string
	mu   sync.Mutex
}

// NewHTTP is the HTTP transport for a stage, its port and token kept in the
// file at path.
func NewHTTP(path string) *HTTP {
	return &HTTP{path: path}
}

var _ bridge.Transport = (*HTTP)(nil)

// What the stub is given to reach sst dev
const (
	EnvHTTPAddress = "SST_HTTP_TRANSPORT"
	EnvHTTPToken   = "SST_HTTP_TRANSPORT_TOKEN"
)

type httpSettings struct {
	Port  int    `json:"port"`
	Token string `json:"token"`
}

// settings are the stage's port and token, made the first time and kept.
func (h *HTTP) settings() (*httpSettings, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for {
		data, err := os.ReadFile(h.path)
		if err == nil {
			var kept httpSettings
			if err := json.Unmarshal(data, &kept); err == nil && kept.Port > 0 && len(kept.Token) >= 32 {
				return &kept, nil
			}
			if err := os.Remove(h.path); err != nil && !errors.Is(err, os.ErrNotExist) {
				return nil, err
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		made, err := newHTTPSettings()
		if err != nil {
			return nil, err
		}
		data, _ = json.Marshal(made)
		published, err := publish(h.path, data)
		if err != nil {
			return nil, err
		}
		// Another process made them at the same time, and the first wins
		if !published {
			continue
		}
		return made, nil
	}
}

// publish writes data to path in one step, only when nothing is there yet,
// readable by the developer alone. It's written under another name first and
// linked into place, which fails when path exists: a file created and then
// written could be read empty by another process, which would take it for a
// broken one, remove it and make its own.
func publish(path string, data []byte) (bool, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return false, err
	}
	temp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return false, err
	}
	defer os.Remove(temp.Name())
	_, err = temp.Write(data)
	if closeErr := temp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return false, err
	}
	if err := os.Chmod(temp.Name(), 0600); err != nil {
		return false, err
	}
	if err := os.Link(temp.Name(), path); err != nil {
		if errors.Is(err, os.ErrExist) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

func newHTTPSettings() (*httpSettings, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	token := make([]byte, 32)
	if _, err := rand.Read(token); err != nil {
		return nil, err
	}
	return &httpSettings{Port: port, Token: hex.EncodeToString(token)}, nil
}

// Stub gives the stub the address of sst dev, as a container on this machine
// reaches it, and the token. It needs no permissions.
func (h *HTTP) Stub(ctx context.Context) (*bridge.StubSettings, error) {
	settings, err := h.settings()
	if err != nil {
		return nil, err
	}
	return &bridge.StubSettings{
		Environment: map[string]string{
			EnvHTTPAddress: fmt.Sprintf("http://host.docker.internal:%d", settings.Port),
			EnvHTTPToken:   settings.Token,
		},
		Permissions: []bridge.StubPermission{},
	}, nil
}

// Connect starts sst dev's side: the server the stubs and sst dev reach, until
// ctx is done, and a connection to it.
func (h *HTTP) Connect(ctx context.Context) (bridge.Conn, error) {
	settings, err := h.settings()
	if err != nil {
		return nil, err
	}
	server, err := httpbus.NewServer(settings.Token)
	if err != nil {
		return nil, err
	}
	addresses := []string{"127.0.0.1"}
	if runtime.GOOS == "linux" {
		if gateway := dockerBridge(ctx); gateway != "" {
			addresses = append(addresses, gateway)
		}
	}
	listeners := []net.Listener{}
	for _, address := range addresses {
		listener, err := net.Listen("tcp", net.JoinHostPort(address, fmt.Sprint(settings.Port)))
		if err != nil {
			for _, open := range listeners {
				open.Close()
			}
			return nil, fmt.Errorf("sst dev's HTTP transport for this stage listens on port %d, which is in use. Stop what's using it, or delete %s to have another port, which the next deploy gives the stubs: %w", settings.Port, h.path, err)
		}
		listeners = append(listeners, listener)
	}
	httpServer := &http.Server{Handler: server, ReadHeaderTimeout: 10 * time.Second}
	for _, listener := range listeners {
		go httpServer.Serve(listener)
	}
	go func() {
		<-ctx.Done()
		httpServer.Close()
	}()
	slog.Info("http transport listening", "port", settings.Port, "addresses", addresses)
	return httpbus.Dial(fmt.Sprintf("http://127.0.0.1:%d", settings.Port), settings.Token)
}

// dockerBridge is the address of Docker's default bridge on this machine,
// which host.docker.internal is on Linux, or "" when there's none.
func dockerBridge(ctx context.Context) string {
	out, err := exec.CommandContext(ctx, "docker", "network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}").Output()
	if err != nil {
		return ""
	}
	gateway := strings.TrimSpace(string(out))
	if ip := net.ParseIP(gateway); ip == nil || !ip.IsPrivate() {
		return ""
	}
	return gateway
}

// Remove forgets the stage's port and token.
func (h *HTTP) Remove(ctx context.Context) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if err := os.Remove(h.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}
