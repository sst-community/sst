package move

import (
	"fmt"
	"sort"

	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
)

// Seen checks that the steps are all of the preview's, against what its
// summary counts. A step lost on the way would be a change the check didn't
// see.
func Seen(steps []apitype.StepEventMetadata, summary *apitype.SummaryEvent) error {
	if summary == nil {
		return fmt.Errorf("the preview didn't say it finished")
	}
	// The summary counts what changes: not what stays the same, or what's
	// only looked up
	counts := func(op apitype.OpType) bool {
		return op != apitype.OpSame && op != apitype.OpRead && op != apitype.OpRefresh
	}
	seen := map[apitype.OpType]int{}
	// A step can be reported twice: a component's, once when it's registered
	// and once with its outputs
	once := map[string]bool{}
	for _, step := range steps {
		key := string(step.Op) + " " + step.URN
		if !step.Logical || !counts(step.Op) || once[key] {
			continue
		}
		once[key] = true
		seen[step.Op]++
	}
	ops := map[apitype.OpType]bool{}
	for op := range summary.ResourceChanges {
		ops[op] = true
	}
	for op := range seen {
		ops[op] = true
	}
	missing := []string{}
	for op := range ops {
		if counts(op) && seen[op] != summary.ResourceChanges[op] {
			missing = append(missing, fmt.Sprintf("%v of %v %v", seen[op], summary.ResourceChanges[op], op))
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		return fmt.Errorf("not every step of the preview was seen: %v", missing)
	}
	return nil
}
