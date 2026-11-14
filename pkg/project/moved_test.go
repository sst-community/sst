package project

import (
	"testing"

	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
	"github.com/sst/sst/v3/pkg/move"
	"github.com/stretchr/testify/assert"
)

func TestHoldsResources(t *testing.T) {
	stack := resourceAt("urn:pulumi:dev::app::pulumi:pulumi:Stack::app-dev", "pulumi:pulumi:Stack")
	provider := resourceAt("urn:pulumi:dev::app::pulumi:providers:aws::default_7_0_0", "pulumi:providers:aws")
	bucket := resourceAt("urn:pulumi:dev::app::sst:aws:Bucket::Uploads", "sst:aws:Bucket")

	marker := resourceAt("urn:pulumi:dev::app::sst:sst:Moved::Moved", MovedMarker)

	assert.False(t, holdsResources(nil), "a new stage")
	record := resourceAt("urn:pulumi:dev::app::sst:sst:Versions::Versions", VersionsRecord)
	assert.False(t, holdsResources([]apitype.ResourceV3{stack, provider, marker, record}), "the stack, its providers, the marker and the record aren't deployed")
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
	types, nested := componentTypes([]apitype.ResourceV3{
		component("urn:pulumi:dev::app::pulumi:pulumi:Stack::app-dev", "pulumi:pulumi:Stack"),
		component("urn:pulumi:dev::app::sst:sst:Moved::Moved", MovedMarker),
		component("urn:pulumi:dev::app::sst:sst:Versions::Versions", VersionsRecord),
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
	// What it has only inside SST's components: a function, here
	assert.Equal(t, []string{"sst:aws:Function"}, nested)
}

func TestMovedComponents(t *testing.T) {
	assert.Equal(t, map[string]int{"sst:aws:Bucket": 1, "acme:index:Uploads": 2}, movedComponents(map[string]interface{}{
		"components": map[string]interface{}{"sst:aws:Bucket": float64(1), "acme:index:Uploads": float64(2)},
	}))
	// A marker written before components had versions
	assert.Equal(t, map[string]int{"sst:aws:Bucket": 1, "sst:aws:Nextjs": 1}, movedComponents(map[string]interface{}{
		"components": []interface{}{"sst:aws:Bucket", "sst:aws:Nextjs"},
	}))
	assert.Empty(t, movedComponents(map[string]interface{}{"components": map[string]interface{}{"x": "1", "y": float64(0)}}))
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
	// SST 4's origin access control, which a move adopts by its id
	control := resourceAt("urn:pulumi:dev::app::sst:aws:StaticSite$pulumi-nodejs:dynamic:Resource::WebS3AccessControl.sst.aws.OriginAccessControl", "pulumi-nodejs:dynamic:Resource")
	control.Custom, control.ID = true, "E2OAC"
	state := stageState(&CompleteEvent{
		Moved: true,
		// A deploy that began to create the first "Uploads", with version 2
		// of it, and failed partway, wrote the marker as it began
		MovedComponents: map[string]int{"sst:aws:Bucket": 1, "acme:index:Uploads": 2},
		// The last deploy that finished recorded every component it knew at
		// its own version, the first "Uploads" not yet created, and what an
		// app registered as its program ran, which the marker can't list
		RecordedVersions: map[string]int{"acme:index:Uploads": 1, "acme:index:Late": 3},
		Resources:        []apitype.ResourceV3{bucket, control},
	})
	assert.Equal(t, StageState{
		Moved:      true,
		Components: map[string]int{"sst:aws:Bucket": 1, "acme:index:Uploads": 2, "acme:index:Late": 3},
		Types:      []string{"sst:aws:Bucket"},
		Nested:     []string{},
		Empty:      false,
		Adopt:      map[string]string{"WebS3AccessControl.sst.aws.OriginAccessControl": "E2OAC"},
	}, state)
	assert.True(t, stageState(&CompleteEvent{}).Empty)
}

func TestRefuseUnmoved(t *testing.T) {
	p := sst5(&Project{app: &App{Name: "app", Stage: "dev"}})
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

	// What changes nothing runs
	for _, command := range []string{"diff", "refresh"} {
		assert.NoError(t, p.refuseUnmoved(&StackInput{Command: command}, unmoved), command)
	}

	// A remove deletes SST 4's own resources through code only SST 4 serves
	err = p.refuseUnmoved(&StackInput{Command: "remove"}, unmoved)
	assert.ErrorContains(t, err, "can't remove it")
	assert.ErrorContains(t, err, "Remove it with SST 4")
	assert.ErrorContains(t, err, "`sst migrate`")

	// A stage that moved, and a new one or a removed one
	for _, command := range []string{"deploy", "remove"} {
		assert.NoError(t, p.refuseUnmoved(&StackInput{Command: command}, moved), command)
		assert.NoError(t, p.refuseUnmoved(&StackInput{Command: command}, empty), command)
	}

	// One with components of SST 4's that have no 5.0 form: the move and its
	// check are refused, naming each, and a deploy's refusal names them too
	stranded := StageState{Stranded: []move.Stranded{
		{Name: "Control", Type: "sst:aws:OpenControl", What: "an `OpenControl`, which has no 5.0 form: remove it."},
		{Name: "OldNet", Type: "sst:aws:Vpc", What: "a `Vpc.v1`, which has no 5.0 form: move it."},
	}}
	for _, command := range []string{"diff", "deploy"} {
		err = p.refuseUnmoved(&StackInput{Command: command, Move: true}, stranded)
		assert.ErrorContains(t, err, "can't move to SST 5's components yet", command)
		assert.ErrorContains(t, err, "\n  - \"Control\" is an `OpenControl`", command)
		assert.ErrorContains(t, err, "\n  - \"OldNet\" is a `Vpc.v1`", command)
	}
	err = p.refuseUnmoved(&StackInput{Command: "deploy"}, stranded)
	assert.ErrorContains(t, err, "hasn't moved to SST 5's")
	assert.ErrorContains(t, err, "Before it can move, each of these has to be dealt with on SST 4")
	assert.ErrorContains(t, err, "\"Control\"")
	assert.NotContains(t, p.refuseUnmoved(&StackInput{Command: "deploy"}, unmoved).Error(), "Before it can move")
	// A diff of it that isn't the move's check still runs
	assert.NoError(t, p.refuseUnmoved(&StackInput{Command: "diff"}, stranded))
}

func TestStageStateStranded(t *testing.T) {
	stack := "urn:pulumi:dev::app::pulumi:pulumi:Stack::app-dev"
	control := resourceAt("urn:pulumi:dev::app::sst:aws:OpenControl::Control", "sst:aws:OpenControl")
	control.Parent = resource.URN(stack)
	// A stage SST 4 deployed
	stranded := stageState(&CompleteEvent{Resources: []apitype.ResourceV3{control}}).Stranded
	assert.Equal(t, []string{"Control"}, []string{stranded[0].Name})
	// One that moved isn't read that way: its own components have the `.v1`
	// forms' types and no version marker
	assert.Nil(t, stageState(&CompleteEvent{Moved: true, Resources: []apitype.ResourceV3{control}}).Stranded)
}
