package server

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/pprof"
	"net/rpc"
	"net/rpc/jsonrpc"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/sst/sst/v3/pkg/flag"
	"github.com/sst/sst/v3/pkg/project"
	"github.com/sst/sst/v3/pkg/server/aws"
	"github.com/sst/sst/v3/pkg/server/runtime"
)

// Server is what the CLI listens on while it runs: the RPC the program calls
// back into, the routes `sst dev`'s own processes call, and the Lambda runtime
// API its workers call.
//
// It listens on loopback only. Every route but the workers' is under a token
// the server makes when it starts, as the first part of the path, so a page in
// a browser, or anything else that can't read the CLI's environment or the
// stage's server file, can't call it. The token goes in the path, not a header,
// so that the code Pulumi stored with each of SST's dynamic resources, which
// calls SST_SERVER + "/rpc", carries it as it is.
//
// A worker is given only its own routes, under a key made from its id.
type Server struct {
	// Mux serves the routes under the token.
	Mux   *http.ServeMux
	Rpc   *rpc.Server
	Ready chan struct{}

	listener  net.Listener
	token     string
	routes    http.Handler
	workerKey []byte
	workers   *http.ServeMux
}

func New() (*Server, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("failed to listen on loopback: %w", err)
	}
	token := make([]byte, 32)
	workerKey := make([]byte, 32)
	rand.Read(token)
	rand.Read(workerKey)
	result := &Server{
		Mux:       http.NewServeMux(),
		Rpc:       rpc.NewServer(),
		Ready:     make(chan struct{}),
		listener:  listener,
		token:     hex.EncodeToString(token),
		workerKey: workerKey,
		workers:   http.NewServeMux(),
	}
	result.routes = http.StripPrefix("/"+result.token, result.Mux)
	slog.Info("server listening", "port", result.port())
	result.Mux.HandleFunc("POST /rpc", func(w http.ResponseWriter, r *http.Request) {
		slog.Info("rpc request")
		result.Rpc.ServeCodec(jsonrpc.NewServerCodec(&HttpConn{Reader: r.Body, Writer: w}))
	})
	if flag.SST_PPROF {
		result.Mux.HandleFunc("/debug/pprof/", pprof.Index)
		result.Mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
		result.Mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
		result.Mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
		result.Mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	}
	return result, nil
}

func (s *Server) port() int {
	return s.listener.Addr().(*net.TCPAddr).Port
}

// URL is the server's address with its token, what SST_SERVER and the stage's
// server file hold. A route is called at URL() + its path.
func (s *Server) URL() string {
	return fmt.Sprintf("http://127.0.0.1:%d/%s", s.port(), s.token)
}

// workerSecret is the key a worker's routes are under, made from its id.
func (s *Server) workerSecret(workerID string) string {
	mac := hmac.New(sha256.New, s.workerKey)
	mac.Write([]byte(workerID))
	return hex.EncodeToString(mac.Sum(nil)[:16])
}

// WorkerAddress is the address of a worker's own routes, for sst dev's own
// requests to them. A worker is given WorkerRunAddress.
func (s *Server) WorkerAddress(workerID string) string {
	return fmt.Sprintf("127.0.0.1:%d/lambda/%s.%s", s.port(), workerID, s.workerSecret(workerID))
}

// WorkerRunAddress is what a worker is given as AWS_LAMBDA_RUNTIME_API, for
// one start of its process, run: the host and the path of its own routes,
// with no scheme, as Lambda gives it. Its routes see run as
// r.PathValue("run"), so what a process that was stopped sends can be told
// from what the one that replaced it does.
func (s *Server) WorkerRunAddress(workerID, run string) string {
	return fmt.Sprintf("127.0.0.1:%d/lambda/%s.%s/%s", s.port(), workerID, s.workerSecret(workerID+"/"+run), run)
}

// HandleWorker serves a route of the Lambda runtime API to the workers, such as
// ("GET", "/2018-06-01/runtime/invocation/next"). The handler finds the worker's
// id with r.PathValue("workerID"), and the start of its process with
// r.PathValue("run"), if it was given one. A request with a key that isn't the
// worker's, for that start, isn't found.
func (s *Server) HandleWorker(method, path string, handler http.HandlerFunc) {
	serve := func(w http.ResponseWriter, r *http.Request) {
		worker, run := r.PathValue("worker"), r.PathValue("run")
		dot := strings.LastIndexByte(worker, '.')
		if dot < 0 {
			http.NotFound(w, r)
			return
		}
		workerID, secret := worker[:dot], worker[dot+1:]
		// a / in either, sent as %2F, would make one worker's key another's
		if strings.Contains(workerID, "/") || strings.Contains(run, "/") {
			http.NotFound(w, r)
			return
		}
		name := workerID
		if run != "" {
			name += "/" + run
		}
		if !hmac.Equal([]byte(secret), []byte(s.workerSecret(name))) {
			http.NotFound(w, r)
			return
		}
		r.SetPathValue("workerID", workerID)
		handler(w, r)
	}
	s.workers.HandleFunc(method+" /lambda/{worker}"+path, serve)
	s.workers.HandleFunc(method+" /lambda/{worker}/{run}"+path, serve)
}

// ServeHTTP sends a worker's request to its routes, and any other with the
// token to Mux, without it.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/lambda/") {
		s.workers.ServeHTTP(w, r)
		return
	}
	token, _, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, "/"), "/")
	if subtle.ConstantTimeCompare([]byte(token), []byte(s.token)) != 1 {
		http.NotFound(w, r)
		return
	}
	s.routes.ServeHTTP(w, r)
}

func (s *Server) Start(ctx context.Context, p *project.Project) error {
	log := slog.Default().With("service", "server")
	log.Info("starting")
	defer log.Info("server done")

	aws.Register(ctx, p, s.Rpc)
	runtime.Register(ctx, p, s.Rpc)
	s.Rpc.RegisterName("Dev", &devContract{project: p})
	s.Rpc.RegisterName("Move", &moveContract{})
	return s.Serve(ctx)
}

// Serve serves the routes until ctx is done.
func (s *Server) Serve(ctx context.Context) error {
	log := slog.Default().With("service", "server")
	server := &http.Server{
		Handler:           s,
		ReadHeaderTimeout: 10 * time.Second,
	}
	go server.Serve(s.listener)
	close(s.Ready)
	log.Info("server ready to accept connections")

	<-ctx.Done()
	log.Info("shutting down server")
	go server.Shutdown(ctx)
	return nil
}

// WriteDiscoveryFile writes the stage's server file, which is how the CLI's
// other processes find `sst dev` with Discover: `sst dev <command>`, `sst
// tunnel` and `sst secret set` in another terminal. Only `sst dev` writes it,
// as what they call is only served by `sst dev`. It returns the function that
// removes it.
func (s *Server) WriteDiscoveryFile(cfgPath, stage string) (func(), error) {
	path := resolveServerFile(cfgPath, stage)
	if err := writeServerFile(path, s.URL()); err != nil {
		return nil, err
	}
	return func() { removeServerFile(path, s.URL()) }, nil
}

// writeServerFile writes the stage's server file, which holds the token: a new
// file, put in place of the old one, so that on macOS and Linux only its owner
// can read it. On Windows it has the permissions of the app's .sst folder.
func writeServerFile(path, contents string) error {
	file, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	if _, err := file.WriteString(contents); err != nil {
		file.Close()
		os.Remove(file.Name())
		return err
	}
	if err := file.Close(); err != nil {
		os.Remove(file.Name())
		return err
	}
	if err := os.Rename(file.Name(), path); err != nil {
		os.Remove(file.Name())
		return err
	}
	return nil
}

// removeServerFile removes the stage's server file if it's still this server's,
// so an `sst dev` that exits doesn't hide another one running on the stage.
func removeServerFile(path, contents string) {
	if existing, err := os.ReadFile(path); err == nil && string(existing) == contents {
		os.Remove(path)
	}
}

type HttpConn struct {
	io.Reader
	io.Writer
}

func (c *HttpConn) Close() error { return nil }
