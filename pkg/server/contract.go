package server

import (
	"context"

	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/bridge"
	"github.com/sst/sst/v3/pkg/project"
)

// devContract is the program contract's calls about sst dev, as Dev.<method>.
type devContract struct {
	program project.Program
}

// Stub is what the stub sst dev deploys in place of a function is deployed
// with, from the stage's transport: its environment and the permissions its
// role needs.
func (d *devContract) Stub(input *struct{}, output *bridge.StubSettings) error {
	transport, ok := d.program.Transport()
	if !ok {
		return d.program.NoTransport()
	}
	settings, err := transport.Stub(context.Background())
	if err != nil {
		return err
	}
	*output = *settings
	// the program reads both as given, so neither is null
	if output.Environment == nil {
		output.Environment = map[string]string{}
	}
	if output.Permissions == nil {
		output.Permissions = []bridge.StubPermission{}
	}
	return nil
}
