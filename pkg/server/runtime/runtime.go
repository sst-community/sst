package runtime

import (
	"context"
	"net/rpc"

	"github.com/sst/sst/v3/pkg/bus"
	"github.com/sst/sst/v3/pkg/project"
	"github.com/sst/sst/v3/pkg/runtime"
)

type Runtime struct {
	project *project.Project
}

func (r *Runtime) Build(input *runtime.BuildInput, output *runtime.BuildOutput) error {
	input.CfgPath = r.project.PathConfig()
	result, err := r.project.Runtime.Build(context.Background(), input)
	if err != nil {
		return err
	}
	*output = *result
	return nil
}

func (r *Runtime) AddTarget(input *runtime.BuildInput, output *bool) error {
	input.CfgPath = r.project.PathConfig()
	// Validate only when a runtime we build matches. provided.al2/al2023
	// functions (Swift, Dart) have no runtime implementation and nothing to
	// validate against, so leave them to register as before.
	if rt, ok := r.project.Runtime.Runtime(input.Runtime); ok {
		if err := rt.ValidateHandler(input); err != nil {
			return err
		}
	}
	bus.Publish(input)
	*output = true
	return nil
}

func Register(ctx context.Context, p *project.Project, r *rpc.Server) error {
	r.RegisterName("Runtime", &Runtime{
		project: p,
	})
	return nil
}
