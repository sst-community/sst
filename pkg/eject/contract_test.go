package eject

import (
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
