package project

import (
	"context"
	"net/rpc"

	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
	"github.com/sst/sst/v3/internal/util"
	"github.com/sst/sst/v3/pkg/project/provider"
)

// programContract is SST 5's program contract, version 1: the core gives the
// program $cli with the stage's state, a component reports through its _sst
// output, and a stage deployed with SST 4's components runs only to move.
type programContract struct{}

func (programContract) Version() int { return ContractVersion }

// Begin starts a move: it saves the state as it was, and releases what the
// components' maps say it does, marked retained in the state this deploy
// runs from, under its lock
func (programContract) Begin(p *Project, workdir *PulumiWorkdir, update *provider.Update, input *StackInput) error {
	if input.Command != "deploy" || !input.Move {
		return nil
	}
	if err := p.beginMove(workdir, update.ID, input.Release); err != nil {
		return util.NewReadableError(err, "The move can't start: "+err.Error()+".")
	}
	return nil
}

func (programContract) Read(complete *CompleteEvent, res apitype.ResourceV3, outputs map[string]interface{}) error {
	return AddRecords(complete, res.URN, string(res.Type), outputs)
}

func (programContract) Locked(p *Project) error { return nil }

func (programContract) Refuse(p *Project, input *StackInput, state StageState) error {
	return p.refuseUnmoved(input, state)
}

func (programContract) Define(p *Project, input *StackInput, state StageState) (map[string]string, error) {
	return p.programDefine(input, state)
}

// RegisterRPC registers the program contract's calls only an SST app's
// program makes: Provider.Aws, for SST's bootstrap in a region, and Move,
// while a stage moves to new components.
func (programContract) RegisterRPC(ctx context.Context, p *Project, server *rpc.Server) {
	server.RegisterName("Provider.Aws", &awsContract{project: p})
	server.RegisterName("Move", &moveContract{})
}

func (programContract) HoldsProviderMajors() bool { return true }

// RefuseTarget refuses nothing: SST 5's components run on a target
func (programContract) RefuseTarget(stage string) error { return nil }

// LoadsProvidersForApp is false: `app()` is read before the first install,
// so the providers' modules the app's files import are left out until run()
func (programContract) LoadsProvidersForApp() bool { return false }
