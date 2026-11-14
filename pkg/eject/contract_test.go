package eject

import (
	"os"
	"strings"
	"testing"

	"github.com/sst/sst/v3/pkg/provider"
)

// Each of SST's own resources, which the provider the sst binary serves
// runs, is one the eject takes out of a state, makes something in the place
// of, or refuses with a reason. One added to the provider fails here until
// the eject says what it does with it.
func TestKnowsEveryOneOfSSTsOwnResources(t *testing.T) {
	for _, served := range provider.ResourceTypes() {
		_, own := ownResources[served]
		_, refused := refusedResources[served]
		if !own && !refused && served != envUpdateType && served != workerURLType {
			t.Errorf("SST's provider serves %s, which the eject doesn't know", served)
		}
	}
}

// The names SST's TypeScript gives what it makes once for a stack, which the
// eject knows them by, are still the ones it gives
func TestKnowsTheNamesSSTsComponentsGive(t *testing.T) {
	const aws = "../../platform/src/components/aws/"
	for file, name := range map[string]string{
		"helpers/provider.ts":        "`" + regionProviderPrefix + "${region}`",
		"helpers/function-shared.ts": `"` + linkKeyName + `"`,
		"function.ts":                "`" + devStubCodePrefix + "${",
	} {
		data, err := os.ReadFile(aws + file)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(data), name) {
			t.Errorf("%s doesn't name what it makes %s, which the eject knows it by", file, name)
		}
	}
}
