package project

import (
	"context"
	"fmt"
	"net/rpc"
	"sort"

	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
	"github.com/sst/sst/v3/internal/util"
	"github.com/sst/sst/v3/pkg/js"
	"github.com/sst/sst/v3/pkg/project/provider"
	"github.com/sst/sst/v3/platform"
)

// Contract is how the engine speaks to the platform's components: what it
// gives the program, what it reads back from the state, which stages it runs
// on, and what it serves the program over the RPC. A platform declares its
// contract's version in its manifest (js.PlatformManifest), and the project
// speaks that one, so the engine runs either line's components and checks
// the line nowhere else.
//
// Version 1 is SST 5's program contract (platform/src/components/contract.ts),
// here. Version 0 is how SST 4's components were spoken to, in pkg/sst4,
// which registers itself as it loads.
type Contract interface {
	// Version is the contract's version, as a platform declares it
	Version() int
	// Begin starts a run, before the stage's state is read: a move to SST
	// 5's components saves the state and releases what it's told to
	Begin(p *Project, workdir *PulumiWorkdir, update *provider.Update, input *StackInput) error
	// Read reads what one of the state's resources records for the engine,
	// from its outputs, decrypted, into what the state left: a component's
	// report, a link's properties, and what the contract keeps of the state
	// for itself (CompleteEvent.Contract). It's called for each resource as
	// the state is read, before what's read is published, as the event is
	// read by others from then on.
	Read(complete *CompleteEvent, res apitype.ResourceV3, outputs map[string]interface{}) error
	// Locked is called once the stage is locked for a run that changes it.
	// An error refuses the run: the lock is released and the update dropped.
	Locked(p *Project) error
	// Refuse refuses to run on a stage, from what its state has
	Refuse(p *Project, input *StackInput, state StageState) error
	// Define is what the program reads as its globals: $app, $cli and $dev
	Define(p *Project, input *StackInput, state StageState) (map[string]string, error)
	// RegisterRPC registers what an SST app's program calls the CLI for,
	// beside what the server registers for every program, served for as
	// long as ctx is live
	RegisterRPC(ctx context.Context, p *Project, server *rpc.Server)
	// HoldsProviderMajors is whether a provider has to be at the major
	// version the platform's components were written for
	HoldsProviderMajors() bool
	// RefuseTarget refuses a stage the app gives a target, when the
	// contract's components don't run on one. Left alone, the stage would
	// deploy to the real cloud.
	RefuseTarget(stage string) error
}

// The contracts this CLI speaks, by version
var contracts = map[int]Contract{}

// RegisterContract adds a contract this CLI speaks. pkg/sst4 adds SST 4's.
func RegisterContract(contract Contract) {
	contracts[contract.Version()] = contract
}

func init() {
	RegisterContract(programContract{})
}

// ContractFor is the contract of a platform's manifest, or an error that
// says this CLI doesn't speak it
func ContractFor(manifest *js.PlatformManifest) (Contract, error) {
	if manifest == nil {
		return nil, util.NewReadableError(nil, "The platform this CLI has doesn't say which components it has: its package.json has no `sst`.")
	}
	contract, ok := contracts[manifest.Contract]
	if !ok {
		versions := []int{}
		for version := range contracts {
			versions = append(versions, version)
		}
		sort.Ints(versions)
		return nil, util.NewReadableError(nil, fmt.Sprintf(
			"The platform this CLI has speaks version %d of the program contract, and this CLI was built with %v.",
			manifest.Contract, versions,
		))
	}
	return contract, nil
}

// EmbeddedManifest is the manifest of the platform this CLI has
func EmbeddedManifest() (*js.PlatformManifest, error) {
	pkg, err := platform.PackageJson()
	if err != nil {
		return nil, err
	}
	return pkg.SST, nil
}

// speaks is the contract the project speaks, which New gives it from the
// platform. A project without one stops here, loudly: SST 4's components take
// a call the RPC doesn't serve as done, so a remove run without a contract
// would drop what they created from the state and leave it in the cloud.
func (p *Project) speaks() Contract {
	if p.contract == nil {
		panic("the project has no program contract: a Project is made with project.New, which gives it its platform's")
	}
	return p.contract
}

// HasTombstone is whether the stage keeps the tombstone at the lock SST 4
// reads: it's on SST 5's components
func (p *Project) HasTombstone() (bool, error) {
	return provider.HasTombstone(p.home, p.app.Name, p.app.Stage)
}
