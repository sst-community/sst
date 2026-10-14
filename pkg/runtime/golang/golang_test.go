package golang

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/sst/sst/v3/pkg/runtime"
)

func git(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	// no global or system git config, so a signing key or a template dir can't get in the way
	cmd.Env = append(os.Environ(),
		"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1",
		"GIT_AUTHOR_NAME=test", "GIT_AUTHOR_EMAIL=test@example.com",
		"GIT_COMMITTER_NAME=test", "GIT_COMMITTER_EMAIL=test@example.com",
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

// A Go function built at two different commits must be the same binary, or the
// zip changes and the next deploy uploads new code for a function nobody touched.
func TestBuildDoesNotDependOnTheCommit(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	// an ambient GOFLAGS=-buildvcs=false would make this pass without the fix
	t.Setenv("GOFLAGS", "")
	dir := t.TempDir()
	write := func(name, content string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}
	write("go.mod", "module example.com/fn\n\ngo 1.21\n")
	write("main.go", "package main\n\nfunc main() { println(\"hello\") }\n")
	git(t, dir, "init", "-q")
	git(t, dir, "add", ".")
	git(t, dir, "commit", "-q", "-m", "first")

	input := &runtime.BuildInput{
		CfgPath:    filepath.Join(dir, "sst.config.ts"),
		FunctionID: "fn",
		Handler:    dir,
		Runtime:    "go",
		Properties: json.RawMessage(`{}`),
	}
	build := func() [32]byte {
		t.Helper()
		if err := os.MkdirAll(input.Out(), 0755); err != nil {
			t.Fatal(err)
		}
		output, err := New().Build(context.Background(), input)
		if err != nil {
			t.Fatal(err)
		}
		if len(output.Errors) > 0 {
			t.Fatal(output.Errors)
		}
		data, err := os.ReadFile(filepath.Join(input.Out(), "bootstrap"))
		if err != nil {
			t.Fatal(err)
		}
		return sha256.Sum256(data)
	}

	first := build()
	git(t, dir, "commit", "-q", "--allow-empty", "-m", "second")
	second := build()
	if first != second {
		t.Fatal("the binary changed with the commit, want the same bytes")
	}
}
