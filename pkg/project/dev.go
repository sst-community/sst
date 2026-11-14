package project

import (
	"context"
	"net/rpc"

	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/bridge"
	"github.com/sst/sst/v3/pkg/project/provider"
	"github.com/sst/sst/v3/pkg/runtime"
	"github.com/sst/sst/v3/pkg/target"
)

// Program is what sst dev runs, and what the CLI's server serves the program
// contract to: an SST app (Project), or a plain Pulumi program
// (pkg/pulumidev). sst dev's machinery, in cmd/sst/mosaic and pkg/server,
// knows it only through this, so it has no part of either's own.
type Program interface {
	// Name and Stage are the app's and the stage's: they name the channel the
	// stubs talk on, the server's file and the panes
	Name() string
	Stage() string
	// Home is the provider the app keeps its state with, "" for none of SST's
	Home() string
	// Providers are the program's providers, by name, with their args. sst
	// dev runs the dev loops of aws and cloudflare.
	Providers() map[string]interface{}
	// Provider is a provider the CLI loaded, by name
	Provider(name string) (provider.Provider, bool)
	// Target is where the stage's cloud calls go
	Target() target.Target
	// Transport is how the stage's stubs reach sst dev, and NoTransport why
	// there's none
	Transport() (bridge.Transport, bool)
	NoTransport() error
	// Runtimes build the program's functions, and run them in sst dev
	Runtimes() *runtime.Collection

	PathRoot() string
	PathConfig() string
	PathPlatformDir() string
	PathLog(name string) string
	// PathWatch is the folder sst dev watches, as Watch says
	PathWatch() string
	Watch() Watch

	// Run deploys the program
	Run(ctx context.Context, input *StackInput) error
	ResolvePolicyPackPath(policyPath string) (string, error)
	// GetCompleted reads what the last deploy left, from the state
	GetCompleted(ctx context.Context) (*CompleteEvent, error)
	// EnvFor is the environment of a dev command, by its name, from what a
	// deploy left
	EnvFor(ctx context.Context, complete *CompleteEvent, name string) (map[string]string, error)
	// RegisterRPC registers the program contract's calls only this program
	// makes, beside the ones the server registers for every program, served
	// for as long as ctx is live
	RegisterRPC(ctx context.Context, server *rpc.Server)
}

var _ Program = (*Project)(nil)

func (p *Project) Name() string {
	return p.app.Name
}

func (p *Project) Stage() string {
	return p.app.Stage
}

func (p *Project) Home() string {
	return p.app.Home
}

func (p *Project) Providers() map[string]interface{} {
	return p.app.Providers
}

func (p *Project) Runtimes() *runtime.Collection {
	return p.Runtime
}

func (p *Project) PathWatch() string {
	return p.PathRoot()
}

func (p *Project) Watch() Watch {
	return p.app.Watch
}
