package runtime

import (
	"context"
	"errors"
	"testing"

	"github.com/sst/sst/v3/pkg/runtime"
)

// node is a runtime for nodejs* that finds no handler
type node struct{}

var errNoHandler = errors.New("no handler")

func (node) Match(name string) bool { return name == "nodejs24.x" }
func (node) Build(ctx context.Context, input *runtime.BuildInput) (*runtime.BuildOutput, error) {
	return nil, errNoHandler
}
func (node) Run(ctx context.Context, input *runtime.RunInput) (runtime.Worker, error) {
	return nil, nil
}
func (node) ShouldRebuild(functionID string, path string) bool { return false }
func (node) ValidateHandler(input *runtime.BuildInput) error   { return errNoHandler }

type builder struct{ runtimes *runtime.Collection }

func (b builder) PathConfig() string            { return "sst.config.ts" }
func (b builder) PathPlatformDir() string       { return "" }
func (b builder) Runtimes() *runtime.Collection { return b.runtimes }

// sst dev checks a function's handler as the runtime it names would build
// it, but not a function with a runtime from sst.runtime, which its own
// commands build: its handler may only exist once they've run
func TestAddTargetChecksOnlyWhatARuntimeBuilds(t *testing.T) {
	r := &Runtime{program: builder{runtime.NewCollection("", node{})}}
	var added bool

	err := r.AddTarget(&runtime.BuildInput{FunctionID: "Api", Runtime: "nodejs24.x", Handler: "dist/index.handler"}, &added)
	if !errors.Is(err, errNoHandler) {
		t.Fatalf("a Node.js function's missing handler was taken: %v", err)
	}

	commands := &runtime.CommandSettings{}
	commands.Dev.Command = "node dist/index.mjs"
	err = r.AddTarget(&runtime.BuildInput{FunctionID: "Own", Runtime: "nodejs24.x", Handler: "dist/index.handler", Commands: commands}, &added)
	if err != nil || !added {
		t.Fatalf("a function its commands build was checked as Node.js builds one: %v", err)
	}
}
