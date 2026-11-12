package move

// What a move needs only for a stage SST 4 deployed. A stage that moves
// between versions of SST 5's components, as `sst.takeover()` gives them,
// needs none of it.
//
// Taking SST 4's support out, as in SST 6, starts with deleting this file and
// the others named sst4_*.go, with their tests: sst4_stranded.go, SST 4's
// components that have no 5.0 form, and sst4_restore.go, going back with
// `sst migrate --undo`. The compiler then names each place they're used,
// marked "SST 4's" there: the check in this package, `sst migrate` and its
// `--undo` (cmd/sst/migrate.go, migrate_undo.go, pkg/project/undo.go), what
// the program is told about the stage (pkg/project/moved.go), the program's
// contract (pkg/server/contract.go), and the move's copy of the state
// (pkg/project/release.go). In the platform, what goes is each group's
// takeover maps of SST 4's components (platform/src/components/*/takeover)
// and the sst4.ts files with SST 4's names (components/sst4.ts and each
// group's), each imported in one place in the group's index.ts, the
// codemod (platform/src/codemod, cmd/sst/codemod.go), SST 4's frozen
// components the maps are tested against (platform/test/fixtures/v4), and
// the recorded states (testdata/states). A few tests in check_test.go have cases of SST 4's
// beside the rest: TestLocalCommand, TestDataBySideItWas, TestDataIsNeverLost
// and TestReleased.

import (
	"strings"

	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
)

// SST's own provider resources that hold data, by the kind they add to their
// name ("MyVectorTable.sst.aws.VectorTable"), and the inputs that empty one
// when they change. In 4.x a `Vector`'s table is dropped and created again
// when its dimension changes (VectorTable.Update).
var dataKinds = map[string][]string{
	"sst.aws.VectorTable": {"dimension"},
}

// SST 4's provider resources that a move adopts, by the kind each adds to its
// name: what takes the place of one imports it by its id, as its create would
// make a second one in the cloud and leave the first behind
// (docs/plans/v5-rewrite/reference.md, SST's provider resources).
var adoptKinds = map[string]bool{
	"sst.aws.OriginAccessControl": true,
}

// Adoptable is the id of each of SST 4's provider resources in a state that a
// move adopts, by its name, which the program is told while the stage moves:
// the part in its place imports it. A name two of them share is left out, so
// neither is adopted, and the check refuses the move.
func Adoptable(resources []apitype.ResourceV3) map[string]string {
	ids := map[string]string{}
	shared := map[string]bool{}
	for _, res := range resources {
		if !res.Custom || res.Delete || res.Type != dynamicType || res.ID == "" || !adoptKinds[kindOf(string(res.URN))] {
			continue
		}
		name := res.URN.Name()
		if _, ok := ids[name]; ok {
			shared[name] = true
		}
		ids[name] = string(res.ID)
	}
	for name := range shared {
		delete(ids, name)
	}
	return ids
}

// The type of SST 4's provider resources: Pulumi's dynamic resources
const dynamicType = "pulumi-nodejs:dynamic:Resource"

// SST 4's lookups, made with resources, by the kind each adds to its name.
// SST 5 makes them with functions. Nothing in the cloud is behind one, so a
// move releases it: it leaves the state without its delete being called, so
// the move doesn't need what ran SST 4's lookups, which goes with SST 4's
// components (docs/plans/v5-rewrite/reference.md, SST's provider resources).
var lookupKinds = map[string]bool{
	"sst.aws.HostedZoneLookup":  true,
	"sst.cloudflare.ZoneLookup": true,
}

// SST 4's provider resources that hold data
func sst4HoldsData(urn string) bool {
	_, ok := dataKinds[kindOf(urn)]
	return ok
}

// The inputs of a resource that empty it when they change
func emptiedBy(urn string) []string {
	return dataKinds[kindOf(urn)]
}

// The kind one of SST's provider resources adds to the end of its name, as
// "sst.aws.VectorTable". The name before it may have ".sst." in it too: SST
// 4's Cloudflare lookups put a domain in it, like "docs.sst.dev".
func kindOf(urn string) string {
	name := urn[strings.LastIndex(urn, "::")+2:]
	at := strings.LastIndex(name, ".sst.")
	if at == -1 {
		return ""
	}
	return name[at+1:]
}

// sharedAdoptNames are the names more than one of SST 4's resources a move
// adopts have: the core gives the program their ids by name, so it gives
// neither
func sharedAdoptNames(steps []apitype.StepEventMetadata) map[string]bool {
	count := map[string]int{}
	for _, step := range steps {
		if step.Op == apitype.OpDelete && step.Type == dynamicType && adoptKinds[kindOf(step.URN)] {
			count[nameOf(step.URN)]++
		}
	}
	shared := map[string]bool{}
	for name, n := range count {
		shared[name] = n > 1
	}
	return shared
}

// unadopted is whether a step deletes one of SST 4's provider resources a
// move adopts, which the part in its place didn't import by its id
func unadopted(step apitype.StepEventMetadata, importedID string) bool {
	return step.Type == dynamicType && adoptKinds[kindOf(step.URN)] && !adopted(step, importedID)
}

func unadoptedWhy(urn string, part Part, shared map[string]bool) string {
	why := nameOf(part.URN) + ", in its place, doesn't adopt it by its id, so a second one would be made in the cloud and this one left there."
	if shared[nameOf(urn)] {
		why += " The stage has more than one named " + nameOf(urn) + ", in different components, so the core can't tell which is whose."
	}
	return why
}

// isLookup is whether a step is of one of SST 4's lookups
func isLookup(step apitype.StepEventMetadata) bool {
	return step.Type == dynamicType && lookupKinds[kindOf(step.URN)]
}

const lookupWhy = "One of SST 4's lookups, which SST 5 makes with a function: nothing in the cloud is behind it."

// keepReplaced keeps in the cloud the one SST 4 deployed of a resource the
// move replaces, when SST 5 keeps its own when it's deleted and SST 4 didn't
func keepReplaced(result *Result, steps []apitype.StepEventMetadata) {
	old, ok := retainedOnReplace(steps)
	if !ok {
		return
	}
	result.Retained = append(result.Retained, Change{URN: old.URN, Type: old.Type, Why: "SST 5 keeps it when it's deleted, so the move keeps the one SST 4 deployed."})
	last := &result.Replaced[len(result.Replaced)-1]
	last.Why += " The one SST 4 deployed is kept in the cloud, as SST 5 keeps this one when it's deleted."
}

// The resource a replace deletes, when the one that takes its place is kept
// when it's deleted and it isn't, like the dev stub code an SST 4 without
// that rule uploaded, which every stage in an account and region shares
func retainedOnReplace(steps []apitype.StepEventMetadata) (*apitype.StepEventStateMetadata, bool) {
	retains := false
	for _, step := range steps {
		if step.New != nil && step.New.RetainOnDelete {
			retains = true
		}
	}
	if !retains {
		return nil, false
	}
	for _, step := range steps {
		if step.Op == apitype.OpDeleteReplaced && step.Old != nil && !step.Old.RetainOnDelete {
			return step.Old, true
		}
	}
	return nil, false
}

// The build of a 4.x site: the one command an SST component runs on this
// machine, `<Site>Builder`, right under the site, with no delete command. A
// 4.x site builds again on every deploy, which replaces it, so its replace
// isn't the move's doing, and it writes only the site's files on this machine.
func isSiteBuild(step apitype.StepEventMetadata) bool {
	if step.Type != "command:local:Command" {
		return false
	}
	for _, state := range []*apitype.StepEventStateMetadata{step.Old, step.New} {
		if state == nil {
			continue
		}
		if command, ok := state.Inputs["delete"].(string); ok && command != "" {
			return false
		}
	}
	parts := strings.Split(step.URN, "::")
	if len(parts) < 4 {
		return false
	}
	chain := strings.Split(parts[2], "$")
	if len(chain) < 2 {
		return false
	}
	parent := chain[len(chain)-2]
	return strings.HasPrefix(parent, "sst:") && strings.HasSuffix(parts[len(parts)-1], "Builder")
}

// Merged is what the object form of a part's transform merged into its
// defaults where SST 4's replaced the arg whole. The program reports it as the
// stage moves (platform/src/components/move.ts, reportMerged).
type Merged struct {
	URN    string        `json:"urn"`
	Fields []MergedField `json:"fields"`
}

// MergedField is an arg the transform sets as an object, and the paths of
// SST's settings in it that 5.0 keeps beside what the transform sets. SST 4
// put the transform's object in their place.
type MergedField struct {
	Field string   `json:"field"`
	Kept  []string `json:"kept"`
}

// Explain says which changes come from a transform's object merged into the
// component's settings, where SST 4 replaced them: of a kept resource, the
// fields it updates in place, and of one that would be replaced where it may
// not be, the fields the replace is keyed on. A merge reported for a
// component, like a function part's, explains a field of the same name that
// a resource inside it changes. A replace the move allows isn't explained: a
// map or the cloud is why.
func (r *Result) Explain(merged []Merged) {
	byURN := map[string][]MergedField{}
	for _, m := range merged {
		byURN[m.URN] = append(byURN[m.URN], m.Fields...)
	}
	explain := func(urn string, fields []string) []MergedField {
		found := []MergedField{}
		seen := map[string]bool{}
		for at := urn; at != "" && !seen[at]; at = r.parents[at] {
			seen[at] = true
			for _, field := range byURN[at] {
				if contains(fields, field.Field) {
					found = append(found, field)
				}
			}
		}
		if len(found) == 0 {
			return nil
		}
		return found
	}
	for i, kept := range r.Kept {
		if len(kept.Fields) > 0 {
			r.Kept[i].Merged = explain(kept.URN, kept.Fields)
		}
	}
	// An update that may not happen is the kept resource's, which says it
	for i, problem := range r.Problems {
		if problem.Does == "replace" && len(problem.Fields) > 0 {
			r.Problems[i].Merged = explain(problem.URN, problem.Fields)
		}
	}
}
