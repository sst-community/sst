package project

import (
	"context"
	"fmt"
	"net/rpc"

	"github.com/sst/sst/v3/pkg/bus"
	"github.com/sst/sst/v3/pkg/move"
	"github.com/sst/sst/v3/pkg/project/provider"
)

// RegisterRPC registers the calls only an SST app's program makes, as the
// platform's contract has them
func (p *Project) RegisterRPC(ctx context.Context, server *rpc.Server) {
	p.speaks().RegisterRPC(ctx, p, server)
}

// awsContract is the program contract's calls about AWS, as
// Provider.Aws.<method>.
type awsContract struct {
	project *Project
}

type BootstrapInput struct {
	Region string `json:"region"`
}

// Bootstrap is SST's bootstrap in a region, set up if it isn't yet
func (a *awsContract) Bootstrap(input *BootstrapInput, output *provider.AwsBootstrapData) error {
	unknown, ok := a.project.Provider("aws")
	if !ok {
		return fmt.Errorf("aws provider not found")
	}
	existing := unknown.(*provider.AwsProvider)
	data, err := existing.Bootstrap(input.Region)
	if err != nil {
		return err
	}
	*output = *data
	return nil
}

// moveContract is the program contract's call while a stage moves to new
// components, as Move.<method>.
type moveContract struct{}

// Part is a part of a component that its state map says something about: new,
// replaced, or in the place of what's released. The command that moves the
// stage reads them from the bus.
func (m *moveContract) Part(input *move.Part, output *struct{}) error {
	bus.Publish(input)
	return nil
}

// Merged is what the object form of a part's transform merged into its
// defaults where SST 4's replaced the arg whole. The command that moves the
// stage reads it from the bus, to say why such a field changes.
func (m *moveContract) Merged(input *move.Merged, output *struct{}) error {
	bus.Publish(input)
	return nil
}
