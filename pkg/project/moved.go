package project

import (
	"fmt"
	"sort"
	"strings"

	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
	"github.com/sst/sst/v3/internal/util"
)

// MovedMarker is the type of the resource that says a stage is on SST 5's
// components. The program leaves one in the state (platform/src/components/
// move.ts) when the stage moves, when it's new, and in every deploy after,
// with the types of the components the stage has in their 5.0 form. A stage
// that has anything deployed and no marker was deployed with SST 4's
// components, and only `sst migrate` deploys it: a plain deploy would switch
// its components without the move's check, and delete what the move releases,
// like a site's files, which the new resources had just written again.
const MovedMarker = "sst:sst:Moved"

// StageState is what the program is told about the stage's state.
type StageState struct {
	// Versions are the components' versions, by name, as 4.x recorded them
	Versions map[string]int
	// Moved is whether the state has the marker, and Components the types it
	// says the stage has in their 5.0 form
	Moved      bool
	Components []string
	// Types are the types of the components the state has, other than those
	// inside one of SST's components, which move with it
	Types []string
	// Empty is whether nothing is deployed: a new stage, or a removed one
	Empty bool
}

// stageState reads what the program is told from what the stage's state has.
func stageState(completed *CompleteEvent) StageState {
	return StageState{
		Versions:   completed.Versions,
		Moved:      completed.Moved,
		Components: completed.MovedComponents,
		Types:      componentTypes(completed.Resources),
		Empty:      !holdsResources(completed.Resources),
	}
}

// movedComponents reads the types the marker lists, from its outputs
func movedComponents(outputs interface{}) []string {
	types := []string{}
	record, _ := outputs.(map[string]interface{})
	list, _ := record["components"].([]interface{})
	for _, item := range list {
		if value, ok := item.(string); ok {
			types = append(types, value)
		}
	}
	return types
}

// componentTypes are the types of the components in a state, but those inside
// one of SST's components
func componentTypes(resources []apitype.ResourceV3) []string {
	found := map[string]bool{}
	for _, res := range resources {
		if res.Custom || !deployed(res) {
			continue
		}
		chain := strings.Split(string(res.URN.QualifiedType()), "$")
		inside := false
		for _, parent := range chain[:len(chain)-1] {
			if strings.HasPrefix(parent, "sst:") {
				inside = true
			}
		}
		if !inside {
			found[string(res.Type)] = true
		}
	}
	types := []string{}
	for typ := range found {
		types = append(types, typ)
	}
	sort.Strings(types)
	return types
}

// deployed is whether a resource is something deployed: not the stack, a
// provider, or the marker
func deployed(res apitype.ResourceV3) bool {
	return res.Type != "pulumi:pulumi:Stack" && res.Type != MovedMarker &&
		!strings.HasPrefix(string(res.Type), "pulumi:providers:")
}

// holdsResources reports whether a state has anything deployed: more than
// the stack, its providers and the marker.
func holdsResources(resources []apitype.ResourceV3) bool {
	for _, res := range resources {
		if deployed(res) {
			return true
		}
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

// markerOf is the marker in a state, if it has one
func markerOf(resources []apitype.ResourceV3) *apitype.ResourceV3 {
	for _, res := range resources {
		if res.Type == MovedMarker {
			marker := res
			return &marker
		}
	}
	return nil
}

// keepMarker puts the marker back in the state a remove left, when the
// remove didn't finish: Pulumi deletes it first, as nothing depends on it,
// and without it the stage would read as one deployed with SST 4. It reports
// whether it put it back.
func keepMarker(checkpoint *apitype.CheckpointV3, marker *apitype.ResourceV3) bool {
	if marker == nil || checkpoint.Latest == nil {
		return false
	}
	resources := checkpoint.Latest.Resources
	if !holdsResources(resources) || markerOf(resources) != nil {
		return false
	}
	checkpoint.Latest.Resources = append(resources, *marker)
	return true
}

// keepMarker puts the marker back in the state a remove left in workdir, when
// the remove didn't finish
func (p *Project) keepMarker(workdir *PulumiWorkdir, marker *apitype.ResourceV3) error {
	checkpoint, err := workdir.Export()
	if err != nil {
		return err
	}
	if !keepMarker(checkpoint, marker) {
		return nil
	}
	return workdir.Import(checkpoint)
}
