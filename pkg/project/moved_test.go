package project

import (
	"testing"

	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
	"github.com/stretchr/testify/assert"
)

func TestHoldsResources(t *testing.T) {
	stack := resourceAt("urn:pulumi:dev::app::pulumi:pulumi:Stack::app-dev", "pulumi:pulumi:Stack")
	provider := resourceAt("urn:pulumi:dev::app::pulumi:providers:aws::default_7_0_0", "pulumi:providers:aws")
	bucket := resourceAt("urn:pulumi:dev::app::sst:aws:Bucket::Uploads", "sst:aws:Bucket")

	assert.False(t, holdsResources(nil), "a new stage")
	assert.False(t, holdsResources([]apitype.ResourceV3{stack, provider}), "the stack and its providers aren't deployed")
	assert.True(t, holdsResources([]apitype.ResourceV3{stack, provider, bucket}))
}

func TestStageState(t *testing.T) {
	bucket := resourceAt("urn:pulumi:dev::app::sst:aws:Bucket::Uploads", "sst:aws:Bucket")
	state := stageState(&CompleteEvent{
		Versions:  map[string]int{"Uploads": 1},
		Moved:     true,
		Resources: []apitype.ResourceV3{bucket},
	})
	assert.Equal(t, StageState{Versions: map[string]int{"Uploads": 1}, Moved: true, Empty: false}, state)
	assert.True(t, stageState(&CompleteEvent{}).Empty)
}

func TestRefuseUnmoved(t *testing.T) {
	p := &Project{app: &App{Name: "app", Stage: "dev"}}
	unmoved := StageState{}
	moved := StageState{Moved: true}
	empty := StageState{Empty: true}

	// A stage deployed with SST 4's components: only the move deploys it,
	// with sst migrate or sst dev
	err := p.refuseUnmoved(&StackInput{Command: "deploy"}, unmoved)
	assert.ErrorContains(t, err, "hasn't moved to SST 5's")
	assert.ErrorContains(t, err, "`sst migrate`")
	assert.Error(t, p.refuseUnmoved(&StackInput{Command: "deploy", Dev: true}, unmoved))
	assert.NoError(t, p.refuseUnmoved(&StackInput{Command: "deploy", Move: true}, unmoved))
	assert.NoError(t, p.refuseUnmoved(&StackInput{Command: "deploy", Move: true, Dev: true}, unmoved))

	// What changes nothing, and what deploys nothing, runs
	for _, command := range []string{"diff", "refresh", "remove"} {
		assert.NoError(t, p.refuseUnmoved(&StackInput{Command: command}, unmoved), command)
	}

	// A stage that moved, and a new one
	assert.NoError(t, p.refuseUnmoved(&StackInput{Command: "deploy"}, moved))
	assert.NoError(t, p.refuseUnmoved(&StackInput{Command: "deploy"}, empty))
}
