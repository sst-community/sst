package dev

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/sst/sst/v3/cmd/sst/mosaic/deployer"
	"github.com/sst/sst/v3/internal/util"
	"github.com/sst/sst/v3/pkg/bus"
	"github.com/sst/sst/v3/pkg/project"
	"github.com/sst/sst/v3/pkg/server"
)

type Message struct {
	Type  string          `json:"type"`
	Event json.RawMessage `json:"event"`
}

// Dev is sst dev's routes on the CLI's server: its events, a request to
// deploy, a dev command's environment, and the last deploy's result
type Dev struct {
	program   project.Program
	completes <-chan any

	mu       sync.Mutex
	complete *project.CompleteEvent
}

// Register registers sst dev's routes on the server. It's called before the
// server serves, so the first request finds them: the UI asks for the events
// as soon as the server is ready. Run keeps what they answer with.
func Register(p project.Program, server *server.Server) *Dev {
	d := &Dev{program: p, completes: bus.Subscribe(&project.CompleteEvent{})}
	d.routes(server)
	return d
}

// Run keeps the last deploy's result, which the routes answer with, for as
// long as ctx lasts
func (d *Dev) Run(ctx context.Context) error {
	log := slog.Default().With("service", "dev")
	log.Info("starting")
	defer log.Info("done")
	for {
		select {
		case <-ctx.Done():
			return nil
		case evt := <-d.completes:
			d.mu.Lock()
			d.complete = evt.(*project.CompleteEvent)
			d.mu.Unlock()
		}
	}
}

// last is the last deploy's result, if one finished since sst dev started
func (d *Dev) last() *project.CompleteEvent {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.complete
}

func (d *Dev) routes(server *server.Server) {
	p := d.program
	log := slog.Default().With("service", "dev")

	server.Mux.HandleFunc("GET /stream", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Add("content-type", "application/x-ndjson")
		w.WriteHeader(http.StatusOK)
		log.Info("subscribed", "addr", r.RemoteAddr)
		flusher, _ := w.(http.Flusher)
		flusher.Flush()
		ctx := r.Context()
		events := bus.SubscribeAll()
		defer bus.Unsubscribe(events)
		if complete := d.last(); complete != nil {
			go func() {
				events <- complete
			}()
		}
		for {
			select {
			case <-ctx.Done():
				return
			case event := <-events:
				t := reflect.TypeOf(event)
				if t.Kind() == reflect.Ptr {
					t = t.Elem()
				}
				bytes, _ := json.Marshal(event)
				data, _ := json.Marshal(&Message{
					Type:  t.String(),
					Event: json.RawMessage(bytes),
				})
				w.Write(data)
				flusher.Flush()
			}
		}
	})

	server.Mux.HandleFunc("POST /api/deploy", func(w http.ResponseWriter, r *http.Request) {
		log.Info("deploy requested")
		bus.Publish(&deployer.DeployRequestedEvent{})
	})

	server.Mux.HandleFunc("GET /api/env", func(w http.ResponseWriter, r *http.Request) {
		directory := r.URL.Query().Get("directory")
		name := r.URL.Query().Get("name")
		resolved := d.last()
		// The state is read only when the last deploy's isn't known, as a
		// read can take a while
		if resolved == nil || resolved.Old {
			if latest, err := p.GetCompleted(r.Context()); err == nil {
				resolved = latest
			}
		}
		if resolved == nil {
			http.Error(w, "dev state not ready", http.StatusServiceUnavailable)
			return
		}
		cwd, _ := os.Getwd()
		for _, command := range resolved.Devs {
			full := filepath.Join(cwd, command.Directory)
			log.Info("matching dev", "full", full, "directory", directory)
			if (directory != "" && full == directory) || (name != "" && command.Name == name) {
				env, err := p.EnvFor(r.Context(), resolved, command.Name)
				if err != nil {
					http.Error(w, err.Error(), http.StatusInternalServerError)
					return
				}
				body, err := json.Marshal(map[string]interface{}{
					"env":     env,
					"command": command.Command,
					"awsOnly": command.Aws != nil && command.Aws.Only,
				})
				if err != nil {
					http.Error(w, err.Error(), http.StatusInternalServerError)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusOK)
				w.Write(body)
				return
			}
		}
		log.Info("dev not found", "directory", directory)
		http.Error(w, "dev not found", http.StatusNotFound)
		return
	})

	server.Mux.HandleFunc("GET /api/completed", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Add("content-type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(d.last())
		return
	})
}

// Stream subscribes to sst dev's events, of the given types. It tries for a
// few seconds, as Deploy does: the UI can ask as sst dev starts, before it
// takes the request. The channel closes when the events end.
func Stream(ctx context.Context, url string, types ...interface{}) (chan any, error) {
	out := make(chan any)
	var resp *http.Response
	err := askUntilTaken(ctx, "asking sst dev for its events again", func() error {
		var err error
		resp, err = send(ctx, "GET", url, "/stream")
		if err != nil {
			return err
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			return fmt.Errorf("GET /stream: %s", resp.Status)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(resp.Body)

	registry := map[string]reflect.Type{}
	for _, v := range types {
		t := reflect.TypeOf(v)
		if t.Kind() == reflect.Ptr {
			t = t.Elem()
		}
		name := t.String()
		registry[name] = t
	}

	go func() {
		defer close(out)
		defer resp.Body.Close()
		for {
			select {
			case <-ctx.Done():
				return
			default:
				var msg Message
				err := decoder.Decode(&msg)
				if err != nil {
					return
				}
				prototype, ok := registry[msg.Type]
				if !ok {
					continue
				}
				target := reflect.New(prototype).Interface()
				err = json.Unmarshal(msg.Event, target)
				if err != nil {
					continue
				}
				out <- target
			}
		}
	}()

	return out, nil
}

type EnvResponse struct {
	Env     map[string]string `json:"env"`
	Command string            `json:"command"`
	// AwsOnly is whether the command runs with its role's credentials alone
	// (project.DevAws)
	AwsOnly bool `json:"awsOnly"`
}

// Inherit is what a dev command keeps of the CLI's environment: all of it,
// but the AWS profile when it runs with its role's credentials alone, as the
// AWS SDKs would take the profile over them
func (r *EnvResponse) Inherit(environ []string) []string {
	if !r.AwsOnly {
		return environ
	}
	return slices.DeleteFunc(slices.Clone(environ), func(entry string) bool {
		return strings.HasPrefix(entry, "AWS_PROFILE=") || strings.HasPrefix(entry, "AWS_DEFAULT_PROFILE=")
	})
}

func Env(ctx context.Context, query string, url string) (*EnvResponse, error) {
	resp, err := send(ctx, "GET", url, "/api/env?"+query)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	// what sst dev said went wrong, like a role it couldn't take
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, util.NewReadableError(nil, strings.TrimSpace(string(body)))
	}
	var result EnvResponse
	err = json.NewDecoder(resp.Body).Decode(&result)
	if err != nil {
		return nil, err
	}
	return &result, nil
}

// Deploy asks `sst dev` to deploy again. It tries for a few seconds: the UI
// can ask as `sst dev` starts, before it takes the request.
func Deploy(ctx context.Context, url string) error {
	return askUntilTaken(ctx, "asking sst dev to deploy again", func() error {
		resp, err := send(ctx, "POST", url, "/api/deploy")
		if err != nil {
			return err
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return fmt.Errorf("POST /api/deploy: %s", resp.Status)
		}
		return nil
	})
}

// askUntilTaken asks sst dev with ask until it's taken, for up to five
// seconds, saying again before each try after the first
func askUntilTaken(ctx context.Context, again string, ask func() error) error {
	var err error
	for attempt := 0; attempt < 20; attempt++ {
		if attempt > 0 {
			slog.Warn(again, "err", err)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(250 * time.Millisecond):
			}
		}
		if err = ask(); err == nil {
			return nil
		}
	}
	return err
}

func Completed(ctx context.Context, url string) (*project.CompleteEvent, error) {
	resp, err := send(ctx, "GET", url, "/api/completed")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var result project.CompleteEvent
	err = json.NewDecoder(resp.Body).Decode(&result)
	if err != nil {
		return nil, err
	}
	return &result, nil
}

// send makes a request of `sst dev` at server, its URL with the token. An
// error leaves out the URL, as errors are logged.
func send(ctx context.Context, method, server, path string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, server+path, nil)
	if err == nil {
		var resp *http.Response
		if resp, err = http.DefaultClient.Do(req); err == nil {
			return resp, nil
		}
	}
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		err = urlErr.Err
	}
	return nil, fmt.Errorf("%s %s: %w", method, path, err)
}
