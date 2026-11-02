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

	marker := resourceAt("urn:pulumi:dev::app::sst:sst:Moved::Moved", MovedMarker)

	assert.False(t, holdsResources(nil), "a new stage")
	assert.False(t, holdsResources([]apitype.ResourceV3{stack, provider, marker}), "the stack, its providers and the marker aren't deployed")
	assert.True(t, holdsResources([]apitype.ResourceV3{stack, provider, bucket}))
}

func TestComponentTypes(t *testing.T) {
	component := func(urn, typ string) apitype.ResourceV3 {
		res := resourceAt(urn, typ)
		res.Custom = false
		return res
	}
	custom := resourceAt("urn:pulumi:dev::app::sst:aws:Bucket$aws:s3/bucketV2:BucketV2::UploadsBucket", "aws:s3/bucketV2:BucketV2")
	custom.Custom = true
	types := componentTypes([]apitype.ResourceV3{
		component("urn:pulumi:dev::app::pulumi:pulumi:Stack::app-dev", "pulumi:pulumi:Stack"),
		component("urn:pulumi:dev::app::sst:sst:Moved::Moved", MovedMarker),
		component("urn:pulumi:dev::app::sst:aws:Bucket::Uploads", "sst:aws:Bucket"),
		custom,
		// Inside one of SST's components, it moves with it
		component("urn:pulumi:dev::app::sst:aws:StaticSite$sst:aws:Bucket::SiteAssets", "sst:aws:Bucket"),
		component("urn:pulumi:dev::app::sst:aws:StaticSite$sst:aws:Function::SiteWarmer", "sst:aws:Function"),
		// Inside an app's own, it doesn't
		component("urn:pulumi:dev::app::acme:index:Wrapper$sst:aws:Nextjs::Web", "sst:aws:Nextjs"),
		component("urn:pulumi:dev::app::acme:index:Wrapper::Wrapper", "acme:index:Wrapper"),
	})
	assert.Equal(t, []string{"acme:index:Wrapper", "sst:aws:Bucket", "sst:aws:Nextjs"}, types)
}

func TestMovedComponents(t *testing.T) {
	assert.Equal(t, []string{"sst:aws:Bucket", "sst:aws:Nextjs"}, movedComponents(map[string]interface{}{
		"components": []interface{}{"sst:aws:Bucket", "sst:aws:Nextjs"},
	}))
	assert.Empty(t, movedComponents(map[string]interface{}{}))
	assert.Empty(t, movedComponents(nil))
}

func TestKeepMarker(t *testing.T) {
	stack := resourceAt("urn:pulumi:dev::app::pulumi:pulumi:Stack::app-dev", "pulumi:pulumi:Stack")
	marker := resourceAt("urn:pulumi:dev::app::sst:sst:Moved::Moved", MovedMarker)
	bucket := resourceAt("urn:pulumi:dev::app::sst:aws:Bucket::Uploads", "sst:aws:Bucket")

	// A remove that stopped partway, which had deleted the marker first
	state := stateWith(stack, bucket)
	assert.True(t, keepMarker(state, &marker))
	assert.Equal(t, []apitype.ResourceV3{stack, bucket, marker}, state.Latest.Resources)

	// One that finished, or that left the marker, or a stage without one
	assert.False(t, keepMarker(stateWith(), &marker))
	assert.False(t, keepMarker(stateWith(stack, bucket, marker), &marker))
	assert.False(t, keepMarker(stateWith(stack, bucket), nil))
}

func TestStageState(t *testing.T) {
	bucket := resourceAt("urn:pulumi:dev::app::sst:aws:Bucket::Uploads", "sst:aws:Bucket")
	state := stageState(&CompleteEvent{
		Versions:        map[string]int{"Uploads": 1},
		Moved:           true,
		MovedComponents: []string{"sst:aws:Bucket"},
		Resources:       []apitype.ResourceV3{bucket},
	})
	assert.Equal(t, StageState{
		Versions:   map[string]int{"Uploads": 1},
		Moved:      true,
		Components: []string{"sst:aws:Bucket"},
		Types:      []string{"sst:aws:Bucket"},
		Empty:      false,
	}, state)
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
