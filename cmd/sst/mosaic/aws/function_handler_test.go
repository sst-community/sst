package aws

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/sst/sst/v3/pkg/runtime"
)

func TestHandlerFileExists(t *testing.T) {
	out := t.TempDir()
	build := &runtime.BuildOutput{Out: out, Handler: "index.handler"}

	if handlerFileExists(build) {
		t.Fatal("no handler file yet, want false")
	}

	file := filepath.Join(out, "index.mjs")
	if err := os.WriteFile(file, []byte("export const handler = 1"), 0644); err != nil {
		t.Fatal(err)
	}
	if !handlerFileExists(build) {
		t.Fatal("index.mjs exists, want true")
	}

	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if handlerFileExists(build) {
		t.Fatal("index.mjs was removed, want false")
	}
}

func TestHandlerFileExistsCompiledBinary(t *testing.T) {
	out := t.TempDir()
	build := &runtime.BuildOutput{Out: out, Handler: "bootstrap"}
	if handlerFileExists(build) {
		t.Fatal("no binary yet, want false")
	}
	if err := os.WriteFile(filepath.Join(out, "bootstrap"), []byte("bin"), 0755); err != nil {
		t.Fatal(err)
	}
	if !handlerFileExists(build) {
		t.Fatal("bootstrap exists, want true")
	}
}

func TestHandlerFileExistsHandlerInSource(t *testing.T) {
	// the Python runtime in dev keeps its handler in the source and returns an empty
	// output folder, so it never counts as built
	build := &runtime.BuildOutput{Out: t.TempDir(), Handler: "src/app.handler"}
	if handlerFileExists(build) {
		t.Fatal("handler is not in the output folder, want false")
	}
}

func TestHandlerFileExistsDottedDirectory(t *testing.T) {
	out := t.TempDir()
	if err := os.MkdirAll(filepath.Join(out, "packages", "api.v2"), 0755); err != nil {
		t.Fatal(err)
	}
	build := &runtime.BuildOutput{Out: out, Handler: "packages/api.v2/handler.main"}
	if handlerFileExists(build) {
		t.Fatal("only the directory exists, want false")
	}
	if err := os.WriteFile(filepath.Join(out, "packages", "api.v2", "handler.mjs"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	if !handlerFileExists(build) {
		t.Fatal("handler.mjs exists, want true")
	}
}

func TestHandlerFileExistsIgnoresSourceMap(t *testing.T) {
	out := t.TempDir()
	build := &runtime.BuildOutput{Out: out, Handler: "bundle.handler"}
	if err := os.WriteFile(filepath.Join(out, "bundle.mjs.map"), []byte("{}"), 0644); err != nil {
		t.Fatal(err)
	}
	if handlerFileExists(build) {
		t.Fatal("only the source map is left, want false")
	}
}

func TestHandlerFileExistsIgnoresDirectoryWithTheName(t *testing.T) {
	out := t.TempDir()
	build := &runtime.BuildOutput{Out: out, Handler: "index.handler"}
	if err := os.MkdirAll(filepath.Join(out, "index.d"), 0755); err != nil {
		t.Fatal(err)
	}
	if handlerFileExists(build) {
		t.Fatal("a folder is not a handler file, want false")
	}
}

func TestReusableBuild(t *testing.T) {
	out := t.TempDir()
	build := &runtime.BuildOutput{Out: out, Handler: "index.handler"}
	file := filepath.Join(out, "index.mjs")
	if err := os.WriteFile(file, []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}

	if reusableBuild(nil, true) {
		t.Fatal("no build, want false")
	}
	if !reusableBuild(build, true) {
		t.Fatal("handler is there, want true")
	}
	os.Remove(file)
	if reusableBuild(build, true) {
		t.Fatal("handler was written and is gone, want false (build again)")
	}
	if !reusableBuild(build, false) {
		t.Fatal("handler never was in the output folder, want true (nothing to check)")
	}
}
