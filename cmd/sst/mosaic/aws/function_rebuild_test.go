package aws

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/bridge"
	"github.com/sst/sst/v3/cmd/sst/mosaic/watcher"
	"github.com/sst/sst/v3/pkg/bus"
	"github.com/sst/sst/v3/pkg/project"
	"github.com/sst/sst/v3/pkg/runtime"
	"github.com/sst/sst/v3/pkg/server"
)

// The builds run at once, and each result is in the place of its function.
func TestBuildAll(t *testing.T) {
	targets := []*runtime.BuildInput{{FunctionID: "a"}, {FunctionID: "b"}, {FunctionID: "c"}}
	var started sync.WaitGroup
	started.Add(len(targets))
	all := make(chan struct{})
	go func() {
		started.Wait()
		close(all)
	}()

	results := buildAll(targets, func(target *runtime.BuildInput) (*runtime.BuildOutput, error) {
		started.Done()
		// each build waits for the others to start, so they have to run together
		select {
		case <-all:
		case <-time.After(5 * time.Second):
			return nil, errors.New("the builds ran one after the other")
		}
		if target.FunctionID == "b" {
			return nil, errors.New("b failed")
		}
		return &runtime.BuildOutput{Handler: target.FunctionID + ".handler"}, nil
	})

	if len(results) != 3 {
		t.Fatalf("got %d results", len(results))
	}
	for i, id := range []string{"a", "b", "c"} {
		result := results[i]
		if result.FunctionID != id {
			t.Errorf("result %d is for %q, want %q", i, result.FunctionID, id)
		}
		if id == "b" {
			if result.Err == nil || result.Err.Error() != "b failed" {
				t.Errorf("b: got error %v", result.Err)
			}
			continue
		}
		if result.Err != nil || result.Output.Handler != id+".handler" {
			t.Errorf("%s: got %+v, %v", id, result.Output, result.Err)
		}
	}
}

// When several files change at once, the functions that use them are each built
// once, at the same time, and their workers start again.
func TestFunctionRebuildsChangedFilesTogether(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	dir := t.TempDir()
	fake := &fakeRuntime{started: make(chan string, 16)}
	proj := &project.Project{Runtime: runtime.NewCollection("", fake)}
	srv := &server.Server{Mux: http.NewServeMux()}
	msg := make(chan bridge.Message)
	go function(ctx, input{server: srv, msg: msg, project: proj})

	send := func(workerID, functionID string) {
		select {
		case msg <- bridge.Message{
			Type:   bridge.MessageInit,
			Source: workerID,
			Body:   strings.NewReader(`{"functionID":"` + functionID + `"}`),
		}:
		case <-time.After(5 * time.Second):
			t.Fatal("event loop stopped accepting messages")
		}
	}
	// The loop subscribes to the bus before it reads a message
	send("ready", "does-not-exist")

	for _, id := range []string{"fnA", "fnB"} {
		bus.Publish(&runtime.BuildInput{
			FunctionID: id,
			Runtime:    "fake",
			CfgPath:    filepath.Join(dir, "sst.config.ts"),
			Dev:        true,
		})
	}
	// A worker for each function. The bus delivers the targets on its own time,
	// so an init that comes first is sent again.
	for _, worker := range [][2]string{{"workerA", "fnA"}, {"workerB", "fnB"}} {
		started := false
		for attempt := 0; attempt < 100 && !started; attempt++ {
			send(worker[0], worker[1])
			select {
			case <-fake.started:
				started = true
			case <-time.After(20 * time.Millisecond):
			}
		}
		if !started {
			t.Fatalf("%s didn't start", worker[0])
		}
	}
	fake.maxBuilding.Store(0)

	for _, file := range []string{"a.ts", "b.ts", "c.ts"} {
		bus.Publish(&watcher.FileChangedEvent{Path: filepath.Join(dir, file)})
	}

	for range 2 {
		select {
		case <-fake.started:
		case <-time.After(5 * time.Second):
			t.Fatal("the workers didn't start again")
		}
	}
	// Nothing else is built after it
	time.Sleep(3 * rebuildDelay)

	for _, id := range []string{"fnA", "fnB"} {
		if got := fake.builds(id); got != 2 {
			t.Errorf("%s was built %d times, want 2: once at init, once for the three files", id, got)
		}
	}
	if got := fake.maxBuilding.Load(); got != 2 {
		t.Errorf("at most %d functions were built at once after the change, want 2", got)
	}
	select {
	case id := <-fake.started:
		t.Errorf("a worker of %s started once more", id)
	default:
	}
}

type fakeRuntime struct {
	mu          sync.Mutex
	built       map[string]int
	building    atomic.Int32
	maxBuilding atomic.Int32
	started     chan string
}

func (f *fakeRuntime) builds(functionID string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.built[functionID]
}

func (f *fakeRuntime) Match(runtime string) bool { return runtime == "fake" }

func (f *fakeRuntime) Build(ctx context.Context, input *runtime.BuildInput) (*runtime.BuildOutput, error) {
	building := f.building.Add(1)
	defer f.building.Add(-1)
	for {
		max := f.maxBuilding.Load()
		if building <= max || f.maxBuilding.CompareAndSwap(max, building) {
			break
		}
	}
	// long enough for another build to start alongside
	time.Sleep(50 * time.Millisecond)

	f.mu.Lock()
	if f.built == nil {
		f.built = map[string]int{}
	}
	f.built[input.FunctionID]++
	f.mu.Unlock()

	if err := os.WriteFile(filepath.Join(input.Out(), "index.mjs"), nil, 0644); err != nil {
		return nil, err
	}
	return &runtime.BuildOutput{Handler: "index.handler", Errors: []string{}}, nil
}

func (f *fakeRuntime) Run(ctx context.Context, input *runtime.RunInput) (runtime.Worker, error) {
	logs, writer := io.Pipe()
	f.started <- input.FunctionID
	return &fakeWorker{logs: logs, writer: writer}, nil
}

func (f *fakeRuntime) ShouldRebuild(functionID string, path string) bool {
	return strings.HasSuffix(path, ".ts")
}

func (f *fakeRuntime) ShouldRunEagerly() bool { return true }

type fakeWorker struct {
	logs   *io.PipeReader
	writer *io.PipeWriter
}

func (w *fakeWorker) Stop() { w.writer.Close() }

func (w *fakeWorker) Logs() io.ReadCloser { return w.logs }
