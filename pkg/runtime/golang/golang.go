package golang

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/sst/sst/v3/internal/fs"
	"github.com/sst/sst/v3/pkg/process"
	"github.com/sst/sst/v3/pkg/runtime"
)

type Runtime struct {
	mut sync.Mutex
	// each function's folder, which ShouldRebuild reads while a build runs
	dirMut      sync.Mutex
	directories map[string]string
}

func New() *Runtime {
	return &Runtime{
		directories: map[string]string{},
	}
}

func (r *Runtime) Match(runtime string) bool {
	return runtime == "go"
}

type Properties struct {
	Architecture string `json:"architecture"`
}

func (r *Runtime) Build(ctx context.Context, input *runtime.BuildInput) (*runtime.BuildOutput, error) {
	r.mut.Lock()
	defer r.mut.Unlock()
	var properties Properties
	json.Unmarshal(input.Properties, &properties)

	gomod, err := fs.FindUp(input.Handler, "go.mod")
	if err != nil {
		return nil, err
	}
	// root of go project
	root := filepath.Dir(gomod)
	src, _ := filepath.Rel(root, input.Handler)
	out := filepath.Join(input.Out(), "bootstrap")
	args := []string{"build"}
	env := os.Environ()
	if !input.Dev {
		args = append(args, "-ldflags", "-s -w")
		// no revision or commit time in the binary, or every commit changes it
		args = append(args, "-buildvcs=false")
		env = append(env, "CGO_ENABLED=0")
		env = append(env, "GOOS=linux")
		env = append(env, "GOARCH=amd64")
		if properties.Architecture == "arm64" {
			env = append(env, "GOARCH=arm64")
		}
	}
	args = append(args, "-o", out, src)
	cmd := process.Command("go", args...)
	cmd.Dir = root
	cmd.Env = env
	slog.Info("running go build", "cmd", cmd.Args)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return &runtime.BuildOutput{
			Errors: []string{string(output)},
		}, nil
	}
	r.dirMut.Lock()
	r.directories[input.FunctionID], _ = filepath.Abs(root)
	r.dirMut.Unlock()
	return &runtime.BuildOutput{
		Handler:    "bootstrap",
		Sourcemaps: []string{},
		Errors:     []string{},
		Out:        root,
	}, nil
}

func (r *Runtime) Run(ctx context.Context, input *runtime.RunInput) (runtime.Worker, error) {
	cmd := process.Command(
		filepath.Join(input.Build.Out, input.Build.Handler),
	)
	slog.Info("running go run", "workerID", input.WorkerID)
	cmd.Env = input.Env
	cmd.Env = append(cmd.Env, "AWS_LAMBDA_RUNTIME_API="+input.Server)
	cmd.Dir = input.Build.Out
	worker, err := process.StartWorker(cmd)
	if err != nil {
		return nil, err
	}
	return worker, nil
}

func (r *Runtime) ValidateHandler(input *runtime.BuildInput) error {
	// A custom bundle is a prebuilt artifact directory. The go handler is a
	// module path that Build resolves directly (never relative to the bundle),
	// so there is nothing bundle-relative to validate here.
	if input.Bundle != "" {
		return nil
	}
	// Mirror Build's handler resolution exactly: it finds go.mod above the
	// handler and does not require the handler itself to be a directory, so a
	// module-name or single-file handler that Build accepts isn't rejected here.
	_, err := fs.FindUp(input.Handler, "go.mod")
	if err != nil {
		return fmt.Errorf("handler not found: could not find go.mod for handler %v", input.Handler)
	}
	return nil
}

func (r *Runtime) ShouldRebuild(functionID string, file string) bool {
	if !strings.HasSuffix(file, ".go") {
		return false
	}
	r.dirMut.Lock()
	match, ok := r.directories[functionID]
	r.dirMut.Unlock()
	if !ok {
		return false
	}
	slog.Info("checking if file needs to be rebuilt", "file", file, "match", match)
	rel, err := filepath.Rel(match, file)
	if err != nil {
		return false
	}
	return !strings.HasPrefix(rel, "..")
}
