// Package runtimetest checks a runtime against what runtime.Runtime says it
// does, through runtime.Collection, as the core calls it: it builds a fixture
// function, runs it against a stand-in Lambda runtime API, and checks that a
// change to a file it uses rebuilds it and that an error in its code is
// reported. Each runtime runs it in its own tests, with a fixture in its
// language.
package runtimetest

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sst/sst/v3/pkg/runtime"
)

// Event is what the fixture function is invoked with, and Answer what it
// answers, and Changed what it answers once Options.Changed are written. As it
// answers, it prints the value of the variable Print, which the suite sets to
// Printed.
const (
	Event   = `{"name":"suite"}`
	Answer  = `{"hello":"suite"}`
	Changed = `{"hello":"suite","again":true}`
	Print   = "RUNTIMETEST_PRINT"
	Printed = "hello from the fixture"
)

// what sst dev gives a worker: the function's environment in Lambda, without
// what's Lambda's own, like PATH and HOME
var workerEnv = []string{
	"AWS_REGION=us-east-1",
	"AWS_LAMBDA_FUNCTION_NAME=fixture",
	Print + "=" + Printed,
}

// Options is the runtime under test, and its fixture.
type Options struct {
	// Runtimes are the runtimes in the collection. A runtime the collection
	// has already, like Commands, needs none.
	Runtimes func() []runtime.Runtime
	// Files are the fixture's files, by their path in the app's folder. Its
	// handler answers Event with Answer, and prints the variable Print.
	Files map[string]string
	// Changed are files written over Files, among them Uses, that make it
	// answer Changed.
	Changed map[string]string
	// Input is the fixture's build input. The suite fills in its CfgPath,
	// FunctionID and Dev.
	Input runtime.BuildInput
	// Uses is a file the function uses, and Unused one it doesn't, by their
	// path in the app's folder.
	Uses, Unused string
	// Broken are files written over Files that make the build fail, as an
	// error in the function's code does. Without them, that's not checked.
	Broken map[string]string
	// Platform are the platform's files the runtime reads, put in the app's
	// .sst/platform as the CLI does: by their path in it, the file copied or
	// the folder linked.
	Platform map[string]string
	// NoRun is for a runtime whose functions sst dev runs another way, as
	// Cloudflare's workers are.
	NoRun bool
	// Wait is how long the worker has to answer, from when it's started.
	// It's 30 seconds without it.
	Wait time.Duration
}

// Run runs the suite.
func Run(t *testing.T, o Options) {
	if o.Wait == 0 {
		o.Wait = 30 * time.Second
	}

	t.Run("builds the function", func(t *testing.T) {
		app := newApp(t, o)
		build := app.build(t, false)
		if build.Handler == "" {
			t.Fatal("the build has no handler")
		}
		entries, err := os.ReadDir(build.Out)
		if err != nil || len(entries) == 0 {
			t.Fatalf("the build's folder %v has nothing in it: %v", build.Out, err)
		}
	})

	t.Run("runs the function on the runtime API", func(t *testing.T) {
		if o.NoRun {
			t.Skip("sst dev runs this runtime's functions another way")
		}
		app := newApp(t, o)
		answer, printed := app.invoke(t, app.build(t, true), o.Wait)
		if !sameJSON(answer, Answer) {
			t.Fatalf("the function answered %s, want %s", answer, Answer)
		}
		if !strings.Contains(printed, Printed) {
			t.Fatalf("its logs don't have what it printed:\n%s", printed)
		}
	})

	t.Run("rebuilds for a file it uses", func(t *testing.T) {
		app := newApp(t, o)
		app.build(t, true)
		if !app.collection.ShouldRebuild(o.Input.Runtime, app.input.FunctionID, app.path(o.Uses)) {
			t.Fatalf("a change to %v doesn't rebuild it", o.Uses)
		}
		if app.collection.ShouldRebuild(o.Input.Runtime, app.input.FunctionID, app.path(o.Unused)) {
			t.Fatalf("a change to %v rebuilds it", o.Unused)
		}
		// it builds again into the same folder, as sst dev does, with the change
		app.write(t, o.Changed)
		build := app.build(t, true)
		if o.NoRun {
			return
		}
		if answer, _ := app.invoke(t, build, o.Wait); !sameJSON(answer, Changed) {
			t.Fatalf("after the change, the function answered %s, want %s", answer, Changed)
		}
	})

	t.Run("builds functions at once", func(t *testing.T) {
		app := newApp(t, o)
		var wg sync.WaitGroup
		builds := make([]*runtime.BuildOutput, 4)
		errs := make([]error, len(builds))
		for i := range builds {
			wg.Go(func() {
				input := app.input
				input.FunctionID = fmt.Sprintf("Fixture%d", i)
				builds[i], errs[i] = app.collection.Build(t.Context(), &input)
			})
		}
		wg.Wait()
		for i, build := range builds {
			if errs[i] != nil {
				t.Fatal(errs[i])
			}
			if len(build.Errors) > 0 {
				t.Fatalf("a build failed: %v", build.Errors)
			}
			if entries, err := os.ReadDir(build.Out); err != nil || len(entries) == 0 {
				t.Fatalf("the build's folder %v has nothing in it: %v", build.Out, err)
			}
		}
	})

	t.Run("reports an error in the function's code", func(t *testing.T) {
		if o.Broken == nil {
			t.Skip("the fixture has no broken files")
		}
		app := newApp(t, o)
		app.write(t, o.Broken)
		input := app.input
		build, err := app.collection.Build(t.Context(), &input)
		if err != nil {
			t.Fatalf("the build failed as the runtime failing, want it in the build's errors: %v", err)
		}
		if len(build.Errors) == 0 {
			t.Fatal("the build has no errors")
		}
	})
}

// app is a fixture's app, in a folder of its own.
type app struct {
	root, cfgPath string
	input         runtime.BuildInput
	collection    *runtime.Collection
}

func newApp(t *testing.T, o Options) *app {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	// the CLI runs in the app's folder, and a runtime can read a path from there
	t.Chdir(root)
	a := &app{root: root, cfgPath: filepath.Join(root, "sst.config.ts")}
	a.write(t, map[string]string{"sst.config.ts": "export default $config({})\n"})
	a.write(t, o.Files)
	for name, source := range o.Platform {
		dest := filepath.Join(root, ".sst", "platform", name)
		if err := os.MkdirAll(filepath.Dir(dest), 0755); err != nil {
			t.Fatal(err)
		}
		info, err := os.Stat(source)
		if err != nil {
			t.Fatal(err)
		}
		if info.IsDir() {
			err = os.Symlink(source, dest)
		} else {
			var data []byte
			if data, err = os.ReadFile(source); err == nil {
				err = os.WriteFile(dest, data, 0644)
			}
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	a.input = o.Input
	a.input.CfgPath = a.cfgPath
	a.input.FunctionID = "Fixture"
	if a.input.Properties == nil {
		a.input.Properties = json.RawMessage(`{}`)
	}
	var runtimes []runtime.Runtime
	if o.Runtimes != nil {
		runtimes = o.Runtimes()
	}
	a.collection = runtime.NewCollection(a.cfgPath, runtimes...)
	return a
}

func (a *app) path(name string) string { return filepath.Join(a.root, name) }

func (a *app) write(t *testing.T, files map[string]string) {
	t.Helper()
	for name, content := range files {
		file := a.path(name)
		if err := os.MkdirAll(filepath.Dir(file), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}
}

// build builds the function, for sst dev or a deploy, and fails on an error.
func (a *app) build(t *testing.T, dev bool) *runtime.BuildOutput {
	t.Helper()
	input := a.input
	input.Dev = dev
	build, err := a.collection.Build(t.Context(), &input)
	if err != nil {
		t.Fatal(err)
	}
	if len(build.Errors) > 0 {
		t.Fatalf("the build failed: %v", build.Errors)
	}
	return build
}

// invoke runs a worker for the build, as sst dev does, and is what it
// answered Event with and what it printed by the time it asked for the next
// invocation, which is when sst dev is done with it. Its logs end once it's
// stopped.
func (a *app) invoke(t *testing.T, build *runtime.BuildOutput, wait time.Duration) (string, string) {
	t.Helper()
	api := newAPI(t)
	worker, err := a.collection.Run(t.Context(), &runtime.RunInput{
		CfgPath:    a.cfgPath,
		Runtime:    a.input.Runtime,
		Server:     api.address,
		FunctionID: a.input.FunctionID,
		WorkerID:   "suite",
		Build:      build,
		Env:        workerEnv,
	})
	if err != nil {
		t.Fatal(err)
	}
	logs := readAll(worker.Logs())
	t.Cleanup(worker.Stop)
	var body string
	select {
	case answer := <-api.answers:
		if answer.err != "" {
			t.Fatalf("the function failed: %v\nIt printed:\n%s", answer.err, logs.wait(time.Second))
		}
		body = answer.body
	case <-time.After(wait):
		worker.Stop()
		t.Fatalf("the function didn't answer in %v. It printed:\n%s", wait, logs.wait(5*time.Second))
	}
	select {
	case <-api.askedAgain:
	case <-time.After(10 * time.Second):
		t.Fatal("it didn't ask for the next invocation within 10 seconds of answering")
	}
	worker.Stop()
	printed := logs.wait(10 * time.Second)
	if !logs.ended() {
		t.Fatal("its logs didn't end within 10 seconds of it being stopped")
	}
	return body, printed
}

// api is a stand-in for sst dev's Lambda runtime API, which hands the worker
// one invocation.
type api struct {
	address string
	answers chan apiAnswer
	// closed when the worker asks for an invocation after the first
	askedAgain chan struct{}
}

type apiAnswer struct{ body, err string }

func newAPI(t *testing.T) *api {
	t.Helper()
	const prefix = "/lambda/suite/2018-06-01/runtime"
	a := &api{answers: make(chan apiAnswer, 10), askedAgain: make(chan struct{})}
	var mu sync.Mutex
	asked := 0
	mux := http.NewServeMux()
	mux.HandleFunc("GET "+prefix+"/invocation/next", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		asked++
		first := asked == 1
		if asked == 2 {
			close(a.askedAgain)
		}
		mu.Unlock()
		if !first {
			<-r.Context().Done()
			return
		}
		w.Header().Set("Lambda-Runtime-Aws-Request-Id", "request")
		w.Header().Set("Lambda-Runtime-Deadline-Ms", "9999999999999")
		w.Header().Set("Lambda-Runtime-Invoked-Function-Arn", "arn:aws:lambda:us-east-1:123456789012:function:fixture")
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, Event)
	})
	mux.HandleFunc("POST "+prefix+"/invocation/request/response", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		w.WriteHeader(http.StatusAccepted)
		a.answers <- apiAnswer{body: string(body)}
	})
	for _, route := range []string{"/invocation/request/error", "/init/error"} {
		mux.HandleFunc("POST "+prefix+route, func(w http.ResponseWriter, r *http.Request) {
			body, _ := io.ReadAll(r.Body)
			w.WriteHeader(http.StatusAccepted)
			a.answers <- apiAnswer{err: route + ": " + string(body)}
		})
	}
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	a.address = strings.TrimPrefix(server.URL, "http://") + "/lambda/suite"
	return a
}

// logs reads a worker's logs as it prints them.
type logs struct {
	mu   sync.Mutex
	text strings.Builder
	done chan struct{}
}

func readAll(r io.ReadCloser) *logs {
	l := &logs{done: make(chan struct{})}
	go func() {
		defer close(l.done)
		buf := make([]byte, 4096)
		for {
			n, err := r.Read(buf)
			l.mu.Lock()
			l.text.Write(buf[:n])
			l.mu.Unlock()
			if err != nil {
				return
			}
		}
	}()
	return l
}

// wait waits up to wait for the logs to end, and is what's been read.
func (l *logs) wait(wait time.Duration) string {
	select {
	case <-l.done:
	case <-time.After(wait):
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.text.String()
}

func (l *logs) ended() bool {
	select {
	case <-l.done:
		return true
	default:
		return false
	}
}

func sameJSON(a, b string) bool {
	var x, y any
	if json.Unmarshal([]byte(a), &x) != nil || json.Unmarshal([]byte(b), &y) != nil {
		return false
	}
	return reflect.DeepEqual(x, y)
}
