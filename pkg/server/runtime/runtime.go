package runtime

import (
	"context"
	"net/rpc"

	"github.com/sst/sst/v3/pkg/bus"
	"github.com/sst/sst/v3/pkg/runtime"
)

// Builder is what a program's builds need: where its config is, and the
// runtimes that build its functions. Every project.Program is one.
type Builder interface {
	PathConfig() string
	Runtimes() *runtime.Collection
}

// platformDir is a Builder whose platform files aren't in the work folder,
// as a Pulumi program's build server has them in the sst package
type platformDir interface {
	PlatformDir() string
}

type Runtime struct {
	program Builder
}

func (r *Runtime) Build(input *runtime.BuildInput, output *runtime.BuildOutput) error {
	input.CfgPath = r.program.PathConfig()
	if p, ok := r.program.(platformDir); ok {
		input.PlatformDir = p.PlatformDir()
	}
	result, err := r.program.Runtimes().Build(context.Background(), input)
	if err != nil {
		return err
	}
	*output = *result
	return nil
}

func (r *Runtime) AddTarget(input *runtime.BuildInput, output *bool) error {
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
