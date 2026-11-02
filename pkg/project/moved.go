package project

import (
	"fmt"
	"strings"

	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
	"github.com/sst/sst/v3/internal/util"
)

// MovedMarker is the type of the resource that says a stage is on SST 5's
// components. The program leaves one in the state (platform/src/auto/run.ts)
// when the stage moves, when it's new, and in every deploy after. A stage
// that has anything deployed and no marker was deployed with SST 4's
// components, and only `sst migrate` deploys it: a plain deploy would switch
// its components without the move's check, and delete what the move releases,
// like a site's files, which the new resources had just written again.
const MovedMarker = "sst:sst:Moved"

// StageState is what the program is told about the stage's state.
type StageState struct {
	// Versions are the components' versions, by name, as 4.x recorded them
	Versions map[string]int
	// Moved is whether the state has the marker
	Moved bool
	// Empty is whether nothing is deployed: a new stage, or a removed one
	Empty bool
}

// stageState reads what the program is told from what the stage's state has.
func stageState(completed *CompleteEvent) StageState {
	return StageState{
		Versions: completed.Versions,
		Moved:    completed.Moved,
		Empty:    !holdsResources(completed.Resources),
	}
}

// holdsResources reports whether a state has anything deployed: more than
// the stack and its providers.
func holdsResources(resources []apitype.ResourceV3) bool {
	for _, res := range resources {
		if res.Type == "pulumi:pulumi:Stack" || strings.HasPrefix(string(res.Type), "pulumi:providers:") {
			continue
		}
		return true
	}
	return false
}

// refuseUnmoved refuses to deploy a stage that hasn't moved to SST 5's
// components, except as the move itself. A diff, a refresh and a remove still
// run on it.
func (p *Project) refuseUnmoved(input *StackInput, state StageState) error {
	if input.Command != "deploy" || input.Move || state.Moved || state.Empty {
		return nil
	}
	return util.NewReadableError(nil, fmt.Sprintf(
		"The stage %q was deployed with SST 4's components, and hasn't moved to SST 5's. `sst migrate --check` shows what moving it does, and `sst migrate` moves it. Until then, it can't be deployed.",
		p.app.Stage,
	))
}
