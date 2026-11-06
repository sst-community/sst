package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/http/pprof"
	"net/rpc"
	"net/rpc/jsonrpc"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/sst/sst/v3/pkg/flag"
	"github.com/sst/sst/v3/pkg/global"
	"github.com/sst/sst/v3/pkg/project"
	"github.com/sst/sst/v3/pkg/server/aws"
	"github.com/sst/sst/v3/pkg/server/resource"
	"github.com/sst/sst/v3/pkg/server/runtime"
)

type Server struct {
	project *project.Project
	Port    int
	Mux     *http.ServeMux
	Rpc     *rpc.Server
	Ready   chan struct{}
}

func New() (*Server, error) {
	port, err := port()
	slog.Info("server port assigned", "port", port)
	if err != nil {
		return nil, err
	}
	result := &Server{
		Port:  port,
		Mux:   http.NewServeMux(),
		Rpc:   rpc.NewServer(),
		Ready: make(chan struct{}),
	}
	result.Mux.HandleFunc("/rpc", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if result.project != nil && result.project.FlociPreflight() {
			data, err := io.ReadAll(io.LimitReader(r.Body, 16<<20))
			if err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			var request struct{ Method string }
			if json.Unmarshal(data, &request) != nil {
				http.Error(w, "invalid RPC", 400)
				return
			}
			if strings.HasSuffix(request.Method, ".Create") || strings.HasSuffix(request.Method, ".Update") || strings.HasSuffix(request.Method, ".Delete") {
				http.Error(w, "Floci preflight refuses mutations", 403)
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(data))
		}
		slog.Info("rpc request", "method", r.Method, "url", r.URL.String())
		result.Rpc.ServeCodec(jsonrpc.NewServerCodec(&HttpConn{Reader: r.Body, Writer: w}))
	})
	if flag.SST_PPROF {
		// the dev server listens on all interfaces, profiles are for this machine only
		local := func(h http.HandlerFunc) http.HandlerFunc {
			return func(w http.ResponseWriter, r *http.Request) {
				host, _, err := net.SplitHostPort(r.RemoteAddr)
				// requests through the TLS proxy arrive from 127.0.0.1 with X-Forwarded-For set
				if ip := net.ParseIP(host); err != nil || ip == nil || !ip.IsLoopback() || r.Header.Get("X-Forwarded-For") != "" {
					http.Error(w, "pprof is only served to localhost", http.StatusForbidden)
					return
				}
				h(w, r)
			}
		}
		result.Mux.HandleFunc("/debug/pprof/", local(pprof.Index))
		result.Mux.HandleFunc("/debug/pprof/cmdline", local(pprof.Cmdline))
		result.Mux.HandleFunc("/debug/pprof/profile", local(pprof.Profile))
		result.Mux.HandleFunc("/debug/pprof/symbol", local(pprof.Symbol))
		result.Mux.HandleFunc("/debug/pprof/trace", local(pprof.Trace))
	}
	return result, nil
}

func (s *Server) Start(ctx context.Context, p *project.Project) error {
	s.project = p
	log := slog.Default().With("service", "server")
	log.Info("starting")
	defer log.Info("server done")

	resource.Register(ctx, p, s.Rpc)
	aws.Register(ctx, p, s.Rpc)
	runtime.Register(ctx, p, s.Rpc)

	server := &http.Server{
		Handler: s.Mux,
	}
	server.Addr = serverAddress(p.Floci(), s.Port)
	log.Info("server", "addr", server.Addr)
	serverPath := resolveServerFile(p.PathConfig(), p.App().Stage)
	if p.Floci() {
		serverPath = resolveFlociServerFile(p.PathConfig(), p.App().Stage, p.Env()["SST_FLOCI_ENDPOINT"])
	}
	u, _ := url.Parse("http://" + server.Addr)
	os.WriteFile(serverPath, []byte(u.String()), 0644)
	defer os.Remove(serverPath)

	listener, err := net.Listen("tcp", server.Addr)
	if err != nil {
		close(s.Ready)
		return fmt.Errorf("failed to listen on %s: %w", server.Addr, err)
	}

	go func() {
		server.Serve(listener)
	}()

	close(s.Ready)
	log.Info("server ready to accept connections")

	keyPath := filepath.Join(global.CertPath(), "key.pem")
	certPath := filepath.Join(global.CertPath(), "cert.pem")
	if _, err := os.Stat(keyPath); err == nil {
		log.Info("https enabled")
		proxy := httputil.NewSingleHostReverseProxy(u)
		go http.ListenAndServeTLS(
			serverAddress(p.Floci(), s.Port+1000),
			certPath,
			keyPath,
			proxy,
		)
		if err != nil {
			log.Error("failed to start https server", "err", err)
			return err
		}
	}

	<-ctx.Done()
	log.Info("shutting down server")
	go server.Shutdown(ctx)
	return nil
}

// The authenticated Floci bridge has its own Docker-reachable listener. The
// dev APIs expose decrypted state and RPCs, so they must stay on the host.
func serverAddress(local bool, port int) string {
	host := "0.0.0.0"
	if local {
		host = "127.0.0.1"
	}
	return net.JoinHostPort(host, fmt.Sprint(port))
}

func port() (int, error) {
	port := 13557
	for {
		if port == 65535 {
			return 0, fmt.Errorf("no port available")
		}
		listener, err := net.Listen("tcp", fmt.Sprintf("0.0.0.0:%d", port))
		if err != nil {
			port++
			continue
		}
		defer listener.Close()
		return port, nil
	}
}

type HttpConn struct {
	io.Reader
	io.Writer
}

func (c *HttpConn) Close() error { return nil }
