package project

import (
	"fmt"
	"sort"
	"strings"

	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
	"github.com/sst/sst/v3/internal/util"
	"github.com/sst/sst/v3/pkg/move"
)

// MovedMarker is the type of the resource that says a stage is on SST 5's
// components. The program leaves one in the state (platform/src/components/
// move.ts) when the stage moves, when it's new, and in every deploy after,
// with the version of each component the stage has in a 5.0 form. A stage
// that has anything deployed and no marker was deployed with SST 4's
// components, and only `sst migrate` deploys it: a plain deploy would switch
// its components without the move's check, and delete what the move releases,
// like a site's files, which the new resources had just written again.
const MovedMarker = "sst:sst:Moved"

// VersionsRecord is the type of the record of the version of each component a
// deploy created, which the program leaves once everything it deployed is
// deployed. It adds what the marker can't list, as a component whose map an
// app registers as its program runs. Where both list a component, the
// marker's is the latest: a plain deploy writes it as it begins, with the
// versions the stage has, and a move once everything it moved is deployed.
// So after a deploy that failed partway, it has the version of a component
// that deploy began to create, where the record has an older code's.
const VersionsRecord = "sst:sst:Versions"

// StageState is what the program is told about the stage's state.
type StageState struct {
	// Moved is whether the state has the marker, and Components the version
	// of each component it says the stage has in a 5.0 form, by type, and of
	// those inside SST's components by their type after ">". SST 4's form is
	// version 0, and isn't listed.
	Moved      bool
	Components map[string]int
	// Types are the types of the components the state has, other than those
	// inside one of SST's components, which move with it, and Nested those it
	// has only inside them
	Types  []string
	Nested []string
	// Empty is whether nothing is deployed: a new stage, or a removed one
	Empty bool
	// Adopt is the id of each of SST 4's provider resources a move adopts, by
	// its name (move.Adoptable). The state has them until a move finishes.
	Adopt map[string]string
	// Stranded are the components of SST 4's that a stage it deployed has,
	// which have no 5.0 form (move.FindStranded)
	Stranded []move.Stranded
	// Contract is what the platform's contract kept of the state for itself
	// as it was read (CompleteEvent.Contract)
	Contract any
}

// stageState reads what the program is told from what the stage's state has.
func stageState(completed *CompleteEvent) StageState {
	components := map[string]int{}
	for typ, version := range completed.RecordedVersions {
		components[typ] = version
	}
	for typ, version := range completed.MovedComponents {
		components[typ] = version
	}
	top, nested := componentTypes(completed.Resources)
	var stranded []move.Stranded
	if !completed.Moved {
		stranded = move.FindStranded(completed.Resources)
	}
	return StageState{
		Moved:      completed.Moved,
		Components: components,
		Types:      top,
		Nested:     nested,
		Empty:      !holdsResources(completed.Resources),
		Adopt:      move.Adoptable(completed.Resources),
		Stranded:   stranded,
		Contract:   completed.Contract,
	}
}

// movedComponents reads the version of each component the marker lists, by
// type, from its outputs. A marker written before components had versions
// lists only their types, each at version 1.
func movedComponents(outputs interface{}) map[string]int {
	versions := map[string]int{}
	record, _ := outputs.(map[string]interface{})
	switch listed := record["components"].(type) {
	case map[string]interface{}:
		for typ, version := range listed {
			if number, ok := version.(float64); ok && number >= 1 {
				versions[typ] = int(number)
			}
		}
	case []interface{}:
		for _, item := range listed {
			if typ, ok := item.(string); ok {
				versions[typ] = 1
			}
		}
	}
	return versions
}

// componentTypes are the types of the components in a state, but those inside
// one of SST's components, and the types it has only inside those
func componentTypes(resources []apitype.ResourceV3) ([]string, []string) {
	found := map[string]bool{}
	inside := map[string]bool{}
	for _, res := range resources {
		if res.Custom || !deployed(res) {
			continue
		}
		chain := strings.Split(string(res.URN.QualifiedType()), "$")
		nested := false
		for _, parent := range chain[:len(chain)-1] {
			if strings.HasPrefix(parent, "sst:") {
				nested = true
			}
		}
		if nested {
			inside[string(res.Type)] = true
		} else {
			found[string(res.Type)] = true
		}
	}
	types, only := []string{}, []string{}
	for typ := range found {
		types = append(types, typ)
	}
	for typ := range inside {
		if !found[typ] {
			only = append(only, typ)
		}
	}
	sort.Strings(types)
	sort.Strings(only)
	return types, only
}

// deployed is whether a resource is something deployed: not the stack, a
// provider, or the marker
func deployed(res apitype.ResourceV3) bool {
	return res.Type != "pulumi:pulumi:Stack" && res.Type != MovedMarker &&
		res.Type != VersionsRecord &&
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
// components, except as the move itself, and to remove one. SST 4's own
// resources in it, like a site's files, delete through code only SST 4's CLI
// serves, and that code takes a call this CLI doesn't serve as done: a remove
// would leave them in the cloud and drop them from the state. A diff and a
// refresh still run on it: a refresh's read keeps what the state has.
//
// It refuses the move, and its check, while the stage has a component of
// SST 4's with no 5.0 form, naming each: the move can't take one over or
// delete one, and an app's config can't create one, so the check would fail
// without saying why.
func (p *Project) refuseUnmoved(input *StackInput, state StageState) error {
	if state.Moved || state.Empty {
		return nil
	}
	if input.Move {
		if len(state.Stranded) == 0 {
			return nil
		}
		return util.NewReadableError(nil, fmt.Sprintf(
			"The stage %q can't move to SST 5's components yet. It has some of SST 4's that have no 5.0 form, and each has to be dealt with on SST 4 first, then deployed:%s",
			p.app.Stage,
			strandedList(state.Stranded),
		))
	}
	if input.Command == "remove" {
		return util.NewReadableError(nil, fmt.Sprintf(
			"The stage %q was deployed with SST 4's components, and hasn't moved to SST 5's, so SST 5 can't remove it: some of what SST 4 created there can only be deleted by SST 4. Remove it with SST 4, or move it with `sst migrate` and then remove it.",
			p.app.Stage,
		))
	}
	if input.Command != "deploy" {
		return nil
	}
	message := fmt.Sprintf(
		"The stage %q was deployed with SST 4's components, and hasn't moved to SST 5's. `sst migrate --check` shows what moving it does, and `sst migrate` moves it. Until then, it can't be deployed.",
		p.app.Stage,
	)
	if len(state.Stranded) > 0 {
		message += " Before it can move, each of these has to be dealt with on SST 4, then deployed:" + strandedList(state.Stranded)
	}
	return util.NewReadableError(nil, message)
}

// strandedList is a line for each stranded component, to end a message with
func strandedList(stranded []move.Stranded) string {
	lines := ""
	for _, s := range stranded {
		lines += "\n  - " + s.String()
	}
	return lines
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
