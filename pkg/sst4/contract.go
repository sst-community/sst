// Package sst4 is how the engine speaks to SST 4's components: version 0 of
// the program contract, which a platform with SST 4's components declares in
// its manifest. With it, a CLI built with SST 4's platform runs an SST 4 app
// as SST 4.25.0 did.
//
// All of it is here, so SST 4's support ends by deleting this package and its
// import in cmd/sst. It registers itself with pkg/project as it loads.
package sst4

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/rpc"
	"strings"

	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
	"github.com/pulumi/pulumi/sdk/v3/go/common/tokens"
	"github.com/sst/sst/v3/internal/util"
	"github.com/sst/sst/v3/pkg/global"
	"github.com/sst/sst/v3/pkg/project"
	"github.com/sst/sst/v3/pkg/project/provider"
)

func init() {
	project.RegisterContract(Contract{})
}

// Contract is SST 4's: the core gives the program $cli as SST 4's CLI did,
// a component reports through outputs of its own names, the program calls
// the CLI for SST 4's provider resources, and a stage on SST 5's components
// is refused.
type Contract struct{}

var _ project.Contract = Contract{}

func (Contract) Version() int { return 0 }

// ErrStageOnSST5 is a stage that moved to SST 5's components, which SST 4's
// can't run on: they'd delete what SST 5 created
var ErrStageOnSST5 = util.NewReadableError(
	errors.New("stage is on SST 5's components"),
	"This stage moved to SST 5's components, so SST 4 can't deploy, remove or refresh it. Run it with SST 5, or put it back on SST 4 with SST 5's `sst migrate --undo`.",
)

// errMove is a move to SST 5's components, which only SST 5's CLI makes
var errMove = util.NewReadableError(nil, "Moving a stage to SST 5's components takes SST 5's CLI.")

// Begin refuses a move, before anything of the stage is read or changed
func (Contract) Begin(p *project.Project, workdir *project.PulumiWorkdir, update *provider.Update, input *project.StackInput) error {
	if input.Move {
		return errMove
	}
	return nil
}

// Read reads a component's report from SST 4's output names, a link's
// properties, and the component's version as SST 4 recorded it
func (Contract) Read(complete *project.CompleteEvent, res apitype.ResourceV3, outputs map[string]interface{}) error {
	complete.AddRecords(res.URN, string(res.Type), outputs, readReport(outputs))
	versions, ok := complete.Contract.(Versions)
	if !ok {
		versions = Versions{}
		complete.Contract = versions
	}
	versions.add(res, outputs)
	return nil
}

// Locked refuses a stage with the tombstone, which SST 5 keeps at the lock
// SST 4 reads on a stage on its components: SST 4's CLI found its own lock
// held there
func (Contract) Locked(p *project.Project) error {
	return refuseTombstone(p.HasTombstone())
}

// refuseTombstone refuses a stage with the tombstone, given whether it has
// one, as read
func refuseTombstone(tombstone bool, err error) error {
	if err != nil {
		return err
	}
	if tombstone {
		return ErrStageOnSST5
	}
	return nil
}

// Refuse refuses a stage on SST 5's components, and a move. A diff still
// runs, as it does with SST 4's CLI.
func (Contract) Refuse(p *project.Project, input *project.StackInput, state project.StageState) error {
	if input.Move {
		return errMove
	}
	if state.Moved && input.Command != "diff" {
		return ErrStageOnSST5
	}
	return nil
}

// Define is the globals SST 4's CLI gave its components: $cli has the
// command, whether it's sst dev, the paths, and the components' versions as
// SST 4 recorded them (Versions)
func (Contract) Define(p *project.Project, input *project.StackInput, state project.StageState) (map[string]string, error) {
	versions, _ := state.Contract.(Versions)
	if versions == nil {
		versions = Versions{}
	}
	cli := map[string]interface{}{
		"command": input.Command,
		"dev":     input.Dev,
		"paths": map[string]string{
			"home":     global.ConfigDir(),
			"root":     p.PathRoot(),
			"work":     p.PathWorkingDir(),
			"platform": p.PathPlatformDir(),
		},
		"state": map[string]interface{}{
			"version": versions,
		},
	}
	cliBytes, err := json.Marshal(cli)
	if err != nil {
		return nil, err
	}
	appBytes, err := json.Marshal(p.App())
	if err != nil {
		return nil, err
	}
	return map[string]string{
		"$app": string(appBytes),
		"$cli": string(cliBytes),
		"$dev": fmt.Sprintf("%v", input.Dev),
	}, nil
}

// RegisterRPC serves what SST 4's components call the CLI for: their
// provider resources, and Provider.Aws for SST's bootstrap and AppSync
func (Contract) RegisterRPC(ctx context.Context, p *project.Project, server *rpc.Server) {
	registerRPC(ctx, p, server)
}

// HoldsProviderMajors is false: SST 4 never refused a provider's other
// major version
func (Contract) HoldsProviderMajors() bool { return false }

// RefuseTarget refuses every target: SST 4's components were never run on
// one, and SST 4's CLI had none, so the stage is stopped rather than
// deployed to the real cloud
func (Contract) RefuseTarget(stage string) error {
	return util.NewReadableError(nil, fmt.Sprintf("The %q stage has a target in app(), and SST 4's components deploy only to the cloud. Targets come with SST 5.", stage))
}

// Versions are the components' versions as SST 4's CLI read them from the
// state, by name: each `sst:sst:Version` record's, and 1 for any other of
// SST's resources it has none for
type Versions map[string]int

// add adds a resource of the state, given its outputs, already decrypted
func (versions Versions) add(res apitype.ResourceV3, outputs map[string]interface{}) {
	if typePackage(res.Type) != "sst" {
		return
	}
	if res.Type == "sst:sst:Version" {
		target, targetOk := outputs["target"].(string)
		version, versionOk := outputs["version"].(float64)
		if targetOk && versionOk {
			versions[target] = int(version)
		}
		return
	}
	if _, ok := versions[res.URN.Name()]; !ok {
		versions[res.URN.Name()] = 1
	}
}

// typePackage is the package of a resource's type, its first part. A
// component's type can have two parts, like "acme:Uploads", which Pulumi's
// Module() fails on.
func typePackage(t tokens.Type) string {
	return strings.SplitN(string(t), ":", 2)[0]
}

// The output SST 4's components give each item of a report as
var reportOutputs = map[string]string{
	"_metadata": "function",
	"_dev":      "dev",
	"_task":     "task",
	"_tunnel":   "tunnel",
	"_hint":     "hint",
}

// readReport reads what one of SST 4's components reported, from its output
// names, as the core did for them before 2026-11-05 (cdc16c144). It's nil
// when it reported nothing.
func readReport(outputs map[string]interface{}) *project.Report {
	legacy := map[string]interface{}{}
	for output, item := range reportOutputs {
		value := outputs[output]
		object, isObject := value.(map[string]interface{})
		_, isString := value.(string)
		switch {
		case item == "hint" && isString:
			legacy[item] = value
		// A site names what it is as _metadata too, with no handler: it isn't
		// a function
		case item == "function" && isObject:
			if _, ok := object["handler"].(string); ok {
				legacy[item] = value
			}
		case item != "hint" && item != "function" && isObject:
			legacy[item] = value
		}
	}
	if len(legacy) == 0 {
		return nil
	}
	// Read as json.Unmarshal does, which leaves out a field of the wrong type
	// and reads the rest
	var report project.Report
	if data, err := json.Marshal(legacy); err == nil {
		json.Unmarshal(data, &report)
	}
	return &report
}
