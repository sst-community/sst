// Package move checks what moving a stage to new components would do to it,
// from Pulumi's preview of the move and what each component's state map says
// (docs/plans/v5-rewrite/goals.md, goals 1 to 3).
//
// A move may keep a resource, at its address or at a new one, and update it in
// place. Anything else has to be allowed:
//
//   - A resource with nothing in the cloud behind it, a component or a
//     provider, may leave the state or be created.
//   - A resource the map releases leaves the state without its delete being
//     called. The part in its place is created, and writes the same thing
//     again or adopts it.
//   - A part the map lists as new is created.
//   - A part the map lists as replaced is replaced, unless it holds data.
//
// Nothing that holds data is deleted, replaced or emptied, whatever the map
// says.
package move

import (
	"sort"
	"strings"

	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
)

// Part is a resource a component created while the stage moves, with what its
// state map says about it. The program reports the parts the map says
// something about (platform/src/components/move.ts).
type Part struct {
	// Component is the address of the component it's a part of, and Type that
	// component's type
	Component string `json:"component"`
	Type      string `json:"type"`
	// Key is the part's key in the component, and ID its id, for a part the
	// component has several of
	Key string `json:"key"`
	ID  string `json:"id,omitempty"`
	// URN is the part's address
	URN string `json:"urn"`
	// Added is set for a part the component it takes over didn't have
	Added bool `json:"added,omitempty"`
	// Replaced is what changes for the user when the part is replaced, as the
	// migration guide says it, for a part the map says is replaced
	Replaced string `json:"replaced,omitempty"`
	// Releases are the addresses of the resources this part takes the place
	// of. They leave the state without being deleted.
	Releases []string `json:"releases,omitempty"`
}

// Kept is a resource the move keeps: the same one in the cloud.
type Kept struct {
	URN  string
	Type string
	// From is where it was, when that isn't where it is now
	From string
	// Fields are what changes in place
	Fields []string
}

// Change is a resource the move creates, takes out of the state or replaces,
// as allowed.
type Change struct {
	URN  string
	Type string
	// Why it's allowed
	Why string
}

// Problem is something the move would do that it may not.
type Problem struct {
	URN  string
	Type string
	// What the move would do: "create", "delete", "replace" or "update"
	Does string
	Why  string
}

// Result is what a move would do to a stage.
type Result struct {
	Kept []Kept
	// Left are resources with nothing in the cloud behind them, which leave
	// the state
	Left []Change
	// Released leave the state without being deleted, and the part in their
	// place is created
	Released []Change
	Created  []Change
	Replaced []Change
	Problems []Problem
}

// OK is whether the stage can move.
func (r *Result) OK() bool {
	return len(r.Problems) == 0
}

// Check works out what a move would do, from each step of Pulumi's preview of
// it and the parts the components reported.
func Check(steps []apitype.StepEventMetadata, parts []Part) *Result {
	added := map[string]Part{}
	replaced := map[string]Part{}
	// the part that takes each released resource's place
	released := map[string]Part{}
	for _, part := range parts {
		if part.Added {
			added[part.URN] = part
		}
		if part.Replaced != "" {
			replaced[part.URN] = part
		}
		for _, old := range part.Releases {
			released[old] = part
		}
	}

	// What the preview deletes, and the id of each resource it imports
	deleted := map[string]bool{}
	imported := map[string]string{}
	for _, step := range steps {
		if step.Op == apitype.OpDelete {
			deleted[step.URN] = true
		}
		if step.Op == apitype.OpImport && step.New != nil {
			imported[step.URN] = step.New.ID
		}
	}
	// The parts in the place of what's released, when the preview really
	// takes that out of the state
	inPlace := map[string]Part{}
	for old, part := range released {
		if deleted[old] {
			inPlace[part.URN] = part
		}
	}

	// Where each resource the map moves went. A replace of one is several
	// steps, and the last, which deletes what's replaced, is at its old
	// address.
	movedTo := map[string]string{}
	for _, step := range steps {
		if step.Old != nil && step.Old.URN != "" && step.Old.URN != step.URN {
			movedTo[step.Old.URN] = step.URN
		}
	}
	byURN := map[string][]apitype.StepEventMetadata{}
	order := []string{}
	parentOf := map[string]string{}
	for _, step := range steps {
		at := step.URN
		if to, ok := movedTo[at]; ok && isReplace(step.Op) {
			at = to
		}
		if _, ok := byURN[at]; !ok {
			order = append(order, at)
		}
		byURN[at] = append(byURN[at], step)
		for _, state := range []*apitype.StepEventStateMetadata{step.New, step.Old} {
			if state != nil && state.Parent != "" {
				parentOf[step.URN] = state.Parent
				break
			}
		}
	}
	// The part a resource is, or is inside of. What's inside a new part, like
	// a function's role, is as new as it is.
	within := func(urn string, set map[string]Part) (Part, bool) {
		seen := map[string]bool{}
		for at := urn; at != "" && !seen[at]; at = parentOf[at] {
			seen[at] = true
			if part, ok := set[at]; ok {
				return part, true
			}
		}
		return Part{}, false
	}

	result := &Result{}
	problem := func(urn string, step apitype.StepEventMetadata, does, why string) {
		result.Problems = append(result.Problems, Problem{URN: urn, Type: step.Type, Does: does, Why: why})
	}
	for _, urn := range order {
		group := byURN[urn]
		// What's left of a replace an earlier deploy made: any deploy deletes it
		replacing := false
		for _, s := range group {
			if isReplace(s.Op) && s.Op != apitype.OpDeleteReplaced {
				replacing = true
			}
		}
		steps := []apitype.StepEventMetadata{}
		for _, s := range group {
			if s.Op == apitype.OpDeleteReplaced && !replacing {
				if groupHoldsData([]apitype.StepEventMetadata{s}) {
					problem(urn, s, "delete", "An earlier deploy replaced it, and a deploy now deletes it. It holds data.")
				} else {
					result.Left = append(result.Left, Change{URN: urn, Type: s.Type, Why: "An earlier deploy replaced it, and any deploy now deletes it."})
				}
				continue
			}
			steps = append(steps, s)
		}
		if len(steps) == 0 {
			continue
		}
		step := steps[0]
		for _, s := range steps {
			if isReplace(s.Op) {
				step = s
				break
			}
		}
		custom := isCustom(step)
		// Whether it holds data, by what it is and what it was
		data := groupHoldsData(steps)

		switch {
		case isReplace(step.Op):
			fields := replaceKeys(steps)
			switch {
			case data:
				problem(urn, step, "replace", "It holds data."+changedBecause(fields))
			case setsExpiry(steps):
				problem(urn, step, "replace", "It sets when what's stored expires."+changedBecause(fields))
			case !custom:
				result.Replaced = append(result.Replaced, Change{URN: urn, Type: step.Type, Why: "Nothing in the cloud is behind it."})
			case replaced[urn].Replaced != "":
				result.Replaced = append(result.Replaced, Change{URN: urn, Type: step.Type, Why: replaced[urn].Replaced})
			default:
				problem(urn, step, "replace", "No component's state map says it's replaced."+changedBecause(fields))
			}

		case step.Op == apitype.OpRead && step.Old != nil && !step.Old.External:
			problem(urn, step, "read", "The app manages it now, and would only look it up.")

		case step.Op == apitype.OpSame || step.Op == apitype.OpUpdate || step.Op == apitype.OpRead || step.Op == apitype.OpRefresh:
			kept := Kept{URN: urn, Type: step.Type}
			if step.Old != nil && step.Old.URN != "" && step.Old.URN != urn {
				kept.From = step.Old.URN
			}
			if step.Op == apitype.OpUpdate {
				kept.Fields = changedFields(step)
				for _, why := range losses(step, kept.Fields) {
					problem(urn, step, "update", why)
				}
			}
			result.Kept = append(result.Kept, kept)

		case step.Op == apitype.OpCreate || step.Op == apitype.OpImport:
			_, isInPlace := within(urn, inPlace)
			_, isAdded := within(urn, added)
			switch {
			case setsExpiry(steps):
				problem(urn, step, "create", "It sets when what's stored expires.")
			case isInPlace:
				result.Created = append(result.Created, Change{URN: urn, Type: step.Type, Why: "It takes the place of what's released."})
			case isAdded:
				result.Created = append(result.Created, Change{URN: urn, Type: step.Type, Why: "It's new in this version of the component."})
			case !custom:
				result.Created = append(result.Created, Change{URN: urn, Type: step.Type, Why: "Nothing in the cloud is behind it."})
			default:
				problem(urn, step, "create", "No component's state map says it's new. If it's new in sst.config.ts, add it after the move.")
			}

		case step.Op == apitype.OpDelete:
			part, isReleased := released[urn]
			switch {
			// What holds data is released only to what adopts it: the
			// same resource in the cloud, imported by its id
			case isReleased && data && (step.Old == nil || step.Old.ID == "" || imported[part.URN] != step.Old.ID):
				problem(urn, step, "delete", "It holds data, and "+nameOf(part.URN)+", in its place, doesn't adopt it by its id.")
			case isReleased:
				result.Released = append(result.Released, Change{URN: urn, Type: step.Type, Why: "Taken out of the state without being deleted, with " + nameOf(part.URN) + " in its place."})
			case !custom:
				result.Left = append(result.Left, Change{URN: urn, Type: step.Type, Why: "Nothing in the cloud is behind it."})
			default:
				why := "No component's state map releases it."
				if data {
					why += " It holds data."
				}
				if step.Old != nil && step.Old.RetainOnDelete {
					why += " The cloud keeps it, but the app would lose it."
				}
				problem(urn, step, "delete", why)
			}

		case step.Op == apitype.OpReadDiscard || step.Op == apitype.OpDiscardReplaced || step.Op == apitype.OpRemovePendingReplace:
			// A lookup the program no longer makes, or what's left of a
			// replace that failed: nothing in the cloud changes
			result.Left = append(result.Left, Change{URN: urn, Type: step.Type, Why: "Nothing in the cloud changes."})

		default:
			problem(urn, step, string(step.Op), "A move doesn't expect this step.")
		}
	}

	sortKept(result.Kept)
	for _, list := range [][]Change{result.Left, result.Released, result.Created, result.Replaced} {
		sortChanges(list)
	}
	sort.Slice(result.Problems, func(i, j int) bool {
		return result.Problems[i].URN < result.Problems[j].URN
	})
	return result
}

// The name in an address
func nameOf(urn string) string {
	return urn[strings.LastIndex(urn, "::")+2:]
}

// Whether any of the steps is of something that holds data, by what it is
// and by what it was
func groupHoldsData(steps []apitype.StepEventMetadata) bool {
	for _, step := range steps {
		if holdsData(step.Type, step.URN) {
			return true
		}
		for _, state := range []*apitype.StepEventStateMetadata{step.Old, step.New} {
			if state != nil && holdsData(state.Type, state.URN) {
				return true
			}
		}
	}
	return false
}

// Whether any of the steps is of something that sets when what's stored
// expires, like a bucket's lifecycle rules
func setsExpiry(steps []apitype.StepEventMetadata) bool {
	for _, step := range steps {
		if expiryTypes[step.Type] {
			return true
		}
		for _, state := range []*apitype.StepEventStateMetadata{step.Old, step.New} {
			if state != nil && expiryTypes[state.Type] {
				return true
			}
		}
	}
	return false
}

func isReplace(op apitype.OpType) bool {
	switch op {
	case apitype.OpReplace, apitype.OpCreateReplacement, apitype.OpDeleteReplaced, apitype.OpImportReplacement, apitype.OpReadReplacement:
		return true
	}
	return false
}

// A resource with nothing behind it in the cloud: a component, the stack, or
// a provider
func isCustom(step apitype.StepEventMetadata) bool {
	if strings.HasPrefix(step.Type, "pulumi:providers:") || step.Type == "pulumi:pulumi:Stack" {
		return false
	}
	for _, state := range []*apitype.StepEventStateMetadata{step.New, step.Old} {
		if state != nil {
			return state.Custom
		}
	}
	// Without either, it's taken as one, which only makes the check stricter
	return true
}

// The fields that make a replace, from each of its steps
func replaceKeys(group []apitype.StepEventMetadata) []string {
	keys := []string{}
	for _, step := range group {
		for _, key := range step.Keys {
			if !contains(keys, key) {
				keys = append(keys, key)
			}
		}
	}
	sort.Strings(keys)
	return keys
}

func changedBecause(fields []string) string {
	if len(fields) == 0 {
		return ""
	}
	return " Changed: " + strings.Join(fields, ", ") + "."
}

// The top-level fields an update changes
func changedFields(step apitype.StepEventMetadata) []string {
	fields := []string{}
	add := func(path string) {
		top := topField(path)
		if !contains(fields, top) {
			fields = append(fields, top)
		}
	}
	for path := range step.DetailedDiff {
		add(path)
	}
	for _, path := range step.Diffs {
		add(path)
	}
	sort.Strings(fields)
	return fields
}

func topField(path string) string {
	end := strings.IndexAny(path, ".[")
	if end == -1 {
		return path
	}
	return path[:end]
}

func contains(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

func sortKept(list []Kept) {
	sort.Slice(list, func(i, j int) bool { return list[i].URN < list[j].URN })
}

func sortChanges(list []Change) {
	sort.Slice(list, func(i, j int) bool { return list[i].URN < list[j].URN })
}
