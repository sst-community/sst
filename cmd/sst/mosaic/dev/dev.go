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
	"time"

	"github.com/sst/sst/v3/cmd/sst/mosaic/deployer"
	"github.com/sst/sst/v3/internal/util"
	"github.com/sst/sst/v3/pkg/bus"
	"github.com/sst/sst/v3/pkg/project"
	"github.com/sst/sst/v3/pkg/server"
	"golang.org/x/sync/errgroup"
)

type Message struct {
	Type  string          `json:"type"`
	Event json.RawMessage `json:"event"`
}

func Start(ctx context.Context, p project.Program, server *server.Server) error {
	var complete *project.CompleteEvent
	var wg errgroup.Group

	log := slog.Default().With("service", "dev")
	log.Info("starting")
	defer log.Info("done")

	wg.Go(func() error {
		evts := bus.Subscribe(&project.CompleteEvent{})
		for {
			select {
			case <-ctx.Done():
				return nil
			case evt := <-evts:
				complete = evt.(*project.CompleteEvent)
			}
		}
	})

	server.Mux.HandleFunc("GET /stream", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Add("content-type", "application/x-ndjson")
		w.WriteHeader(http.StatusOK)
		log.Info("subscribed", "addr", r.RemoteAddr)
		flusher, _ := w.(http.Flusher)
		flusher.Flush()
		ctx := r.Context()
		events := bus.SubscribeAll()
		defer bus.Unsubscribe(events)
		if complete != nil {
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
		resolved := complete
		// The state is read only when the last deploy's isn't known, as a
		// read can take a while
		if resolved == nil || resolved.Old {
			if latest, err := p.GetCompleted(ctx); err == nil {
				resolved = latest
			}
		}
		if resolved == nil {
			http.Error(w, "dev state not ready", http.StatusServiceUnavailable)
			return
		}
		cwd, _ := os.Getwd()
		for _, d := range resolved.Devs {
			full := filepath.Join(cwd, d.Directory)
			log.Info("matching dev", "full", full, "directory", directory)
			if (directory != "" && full == directory) || (name != "" && d.Name == name) {
				env, err := p.EnvFor(ctx, resolved, d.Name)
				if err != nil {
					http.Error(w, err.Error(), http.StatusInternalServerError)
					return
				}
				body, err := json.Marshal(map[string]interface{}{
					"env":     env,
					"command": d.Command,
					"awsOnly": d.Aws != nil && d.Aws.Only,
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
		json.NewEncoder(w).Encode(complete)
		return
	})

	return wg.Wait()
}

func Stream(ctx context.Context, url string, types ...interface{}) (chan any, error) {
	out := make(chan any)
	resp, err := send(ctx, "GET", url, "/stream")
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
	var err error
	for attempt := 0; attempt < 20; attempt++ {
		if attempt > 0 {
			slog.Warn("asking sst dev to deploy again", "err", err)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(250 * time.Millisecond):
			}
		}
		var resp *http.Response
		resp, err = send(ctx, "POST", url, "/api/deploy")
		if err != nil {
			continue
		}
		resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			return nil
		}
		err = fmt.Errorf("POST /api/deploy: %s", resp.Status)
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
