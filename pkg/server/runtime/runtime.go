package runtime

import (
	"context"
	"net/rpc"

	"github.com/sst/sst/v3/pkg/bus"
	"github.com/sst/sst/v3/pkg/runtime"
)

// Builder is what a program's builds need: where its config is, where
// SST's platform files are, and the runtimes that build its functions. Every
// project.Program is one, with the platform in its work folder, and so is a
// Pulumi program's build server, with it in the sst package.
type Builder interface {
	PathConfig() string
	PathPlatformDir() string
	Runtimes() *runtime.Collection
}

type Runtime struct {
	program Builder
}

func (r *Runtime) Build(input *runtime.BuildInput, output *runtime.BuildOutput) error {
	input.CfgPath = r.program.PathConfig()
	input.PlatformDir = r.program.PathPlatformDir()
	result, err := r.program.Runtimes().Build(context.Background(), input)
	if err != nil {
		return err
	}
	*output = *result
	return nil
}

func (r *Runtime) AddTarget(input *runtime.BuildInput, output *bool) error {
	input.CfgPath = r.program.PathConfig()
	// Checked as a build checks it (Collection.ValidateHandler), so a missing
	// handler fails the deploy rather than the first invocation
	if err := r.program.Runtimes().ValidateHandler(input); err != nil {
		return err
	}
	bus.Publish(input)
	*output = true
	return nil
}

func Register(ctx context.Context, p Builder, r *rpc.Server) error {
	r.RegisterName("Runtime", &Runtime{
		program: p,
	})
	return nil
}
