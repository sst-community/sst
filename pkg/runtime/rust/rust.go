package rust

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/BurntSushi/toml"
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
	return runtime == "rust"
}

type Properties struct {
	Architecture string `json:"architecture"`
}

type CargoToml struct {
	Package struct {
		Name string `toml:"name"`
	} `toml:"package"`
}

func (r *Runtime) Build(ctx context.Context, input *runtime.BuildInput) (*runtime.BuildOutput, error) {
	r.mut.Lock()
	defer r.mut.Unlock()
	var properties Properties
	json.Unmarshal(input.Properties, &properties)

	// split handler into path and function name
	parts := strings.Split(input.Handler, ".")
	handler := strings.Join(parts[:len(parts)-1], ".")

	// Locate cargo.toml/Cargo.toml
	cargotomlpath, err := fs.FindUp(handler, "cargo.toml")
	if err != nil {
		cargotomlpath, err = fs.FindUp(handler, "Cargo.toml")
		if err != nil {
			return nil, err
		}
	}

	// root of project
	root := filepath.Dir(cargotomlpath)

	// append args to the command
	args := []string{}
	env := os.Environ()
	if input.Dev {
		args = append(args, "build")
	} else {
		args = []string{"lambda", "build"}
		args = append(args, "--release")
		if properties.Architecture == "arm64" {
			args = append(args, "--arm64")
		}
	}

	cmd := process.Command("cargo", args...)
	cmd.Dir = root
	cmd.Env = env
	slog.Info("running cargo build", "cmd", cmd.Args)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return &runtime.BuildOutput{
			Errors: []string{string(output)},
		}, nil
	}

	// get the default output of the crate
	var cargotoml CargoToml
	_, err = toml.DecodeFile(cargotomlpath, &cargotoml)
	if err != nil {
		return nil, err
	}

	// if binary name is not specified, use the package name
	name := cargotoml.Package.Name
	if len(parts) >= 2 {
		name = parts[len(parts)-1]
	}
	binary := filepath.Join(root, "target",
		map[bool]string{
			true:  filepath.Join("debug", name),
			false: filepath.Join("lambda", name, "bootstrap"),
		}[input.Dev],
	)
	out := filepath.Join(input.Out(), "bootstrap")

	r.dirMut.Lock()
	r.directories[input.FunctionID], _ = filepath.Abs(root)
	r.dirMut.Unlock()

	if err := os.MkdirAll(filepath.Dir(out), 0755); err != nil {
		return nil, fmt.Errorf("failed to create output directory: %w", err)
	}

	source, err := os.Open(binary)
	if err != nil {
		return nil, fmt.Errorf("failed to open source binary: %w", err)
	}
	defer source.Close()

	// written beside it and renamed over it, as a worker from the last build
	// may still be running the binary there
	next := out + ".next"
	destination, err := os.Create(next)
	if err != nil {
		return nil, fmt.Errorf("failed to create destination file: %w", err)
	}
	if _, err := io.Copy(destination, source); err != nil {
		destination.Close()
		return nil, fmt.Errorf("failed to copy binary: %w", err)
	}
	if err := destination.Close(); err != nil {
		return nil, fmt.Errorf("failed to copy binary: %w", err)
	}
	if err := os.Chmod(next, 0755); err != nil {
		return nil, fmt.Errorf("failed to make binary executable: %w", err)
	}
	if err := os.Rename(next, out); err != nil {
		return nil, fmt.Errorf("failed to replace the binary: %w", err)
	}

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
	slog.Info("running server binary", "workerID", input.WorkerID)
	cmd.Env = input.Env
	cmd.Env = append(cmd.Env, "AWS_LAMBDA_RUNTIME_API=http://"+input.Server)
	cmd.Env = append(cmd.Env, "AWS_LAMBDA_FUNCTION_MEMORY_SIZE=1024")
	cmd.Dir = input.Build.Out
	worker, err := process.StartWorker(cmd)
	if err != nil {
		return nil, err
	}
	return worker, nil
}

func (r *Runtime) ShouldRebuild(functionID string, file string) bool {
	// copied from go
	if !strings.HasSuffix(file, ".rs") {
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
