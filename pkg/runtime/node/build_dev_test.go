package node

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/sst/sst/v3/pkg/flag"
	"github.com/sst/sst/v3/pkg/runtime"
)

func devBuildInput(t *testing.T, dir string, name string) *runtime.BuildInput {
	t.Helper()
	file := filepath.Join(dir, name+".ts")
	err := os.WriteFile(file, []byte("export const handler = async () => \""+name+"\";\n"), 0644)
	if err != nil {
		t.Fatal(err)
	}
	return &runtime.BuildInput{
		CfgPath:    filepath.Join(dir, "sst.config.ts"),
		Dev:        true,
		FunctionID: name,
		Handler:    name + ".handler",
		Runtime:    "nodejs20.x",
		Properties: json.RawMessage(`{}`),
	}
}

func TestDevBuildContextsAreBounded(t *testing.T) {
	dir := t.TempDir()
	r := New("dev")
	r.contextCap = 2

	for i := 0; i < 5; i++ {
		input := devBuildInput(t, dir, fmt.Sprintf("fn%d", i))
		output, err := r.Build(context.Background(), input)
		if err != nil {
			t.Fatal(err)
		}
		if len(output.Errors) > 0 {
			t.Fatal(output.Errors)
		}
	}

	r.contextsLock.Lock()
	got := len(r.contexts)
	r.contextsLock.Unlock()
	if got > 2 {
		t.Errorf("live esbuild contexts = %d, want <= 2", got)
	}
}

func TestDevBuildShouldRebuildTracksInputs(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	r := New("dev")
	r.contextCap = 1

	first := devBuildInput(t, dir, "first")
	second := devBuildInput(t, dir, "second")
	for _, input := range []*runtime.BuildInput{first, second} {
		output, err := r.Build(context.Background(), input)
		if err != nil {
			t.Fatal(err)
		}
		if len(output.Errors) > 0 {
			t.Fatal(output.Errors)
		}
	}

	// dependency tracking must survive context eviction
	if !r.ShouldRebuild("first", filepath.Join(dir, "first.ts")) {
		t.Error("expected ShouldRebuild to be true for first.ts after eviction")
	}
	if !r.ShouldRebuild("second", filepath.Join(dir, "second.ts")) {
		t.Error("expected ShouldRebuild to be true for second.ts")
	}
	if r.ShouldRebuild("first", filepath.Join(dir, "second.ts")) {
		t.Error("expected ShouldRebuild to be false for unrelated file")
	}

	// rebuilding an evicted function must still work
	output, buildErr := r.Build(context.Background(), first)
	if buildErr != nil {
		t.Fatal(buildErr)
	}
	if len(output.Errors) > 0 {
		t.Fatal(output.Errors)
	}
}

func TestDevBuildContextCapFromEnv(t *testing.T) {
	original := flag.SST_BUILD_CONTEXT_CACHE
	defer func() { flag.SST_BUILD_CONTEXT_CACHE = original }()

	for value, want := range map[string]int{"": DefaultContextCap, "0": 0, "7": 7, "-1": DefaultContextCap, "abc": DefaultContextCap} {
		flag.SST_BUILD_CONTEXT_CACHE = value
		if got := New("dev").contextCap; got != want {
			t.Errorf("SST_BUILD_CONTEXT_CACHE=%q: contextCap = %d, want %d", value, got, want)
		}
	}
}

func TestDevBuildCacheOffDisposesContexts(t *testing.T) {
	dir := t.TempDir()
	r := New("dev")
	r.contextCap = 0
	for i := 0; i < 3; i++ {
		if _, err := r.Build(context.Background(), devBuildInput(t, dir, fmt.Sprintf("fn%d", i))); err != nil {
			t.Fatal(err)
		}
	}
	r.contextsLock.Lock()
	got := len(r.contexts)
	r.contextsLock.Unlock()
	if got != 0 {
		t.Errorf("live esbuild contexts = %d, want 0", got)
	}
}

func TestDevBuildConcurrentBuildsWithEviction(t *testing.T) {
	dir := t.TempDir()
	r := New("dev")
	r.contextCap = 2

	inputs := make([]*runtime.BuildInput, 4)
	for i := range inputs {
		inputs[i] = devBuildInput(t, dir, fmt.Sprintf("fn%d", i))
	}

	var wg sync.WaitGroup
	for round := 0; round < 3; round++ {
		for i := 0; i < 8; i++ {
			// several builds of the same function and of different functions at once
			input := inputs[i%len(inputs)]
			wg.Add(1)
			go func() {
				defer wg.Done()
				output, err := r.Build(context.Background(), input)
				if err != nil {
					t.Error(err)
					return
				}
				if len(output.Errors) > 0 {
					t.Error(output.Errors)
				}
			}()
		}
	}
	wg.Wait()

	r.contextsLock.Lock()
	defer r.contextsLock.Unlock()
	if len(r.contexts) > 2 {
		t.Errorf("live esbuild contexts = %d, want <= 2", len(r.contexts))
	}
	for id, entry := range r.contexts {
		if entry.building != 0 {
			t.Errorf("%s is still pinned (%d)", id, entry.building)
		}
	}
}

func TestDevBuildDefaultCap(t *testing.T) {
	original := flag.SST_BUILD_CONTEXT_CACHE
	defer func() { flag.SST_BUILD_CONTEXT_CACHE = original }()
	flag.SST_BUILD_CONTEXT_CACHE = ""

	dir := t.TempDir()
	r := New("dev")
	for i := 0; i < DefaultContextCap+3; i++ {
		if _, err := r.Build(context.Background(), devBuildInput(t, dir, fmt.Sprintf("fn%d", i))); err != nil {
			t.Fatal(err)
		}
	}
	r.contextsLock.Lock()
	got := len(r.contexts)
	r.contextsLock.Unlock()
	if got != DefaultContextCap {
		t.Errorf("live esbuild contexts = %d, want %d", got, DefaultContextCap)
	}
}
