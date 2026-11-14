package project

import (
	"testing"

	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
	"github.com/pulumi/pulumi/sdk/v3/go/common/tokens"
	"github.com/stretchr/testify/assert"
)

const dynamic = "pulumi-nodejs:dynamic:Resource"

func stateWith(resources ...apitype.ResourceV3) *apitype.CheckpointV3 {
	return &apitype.CheckpointV3{Latest: &apitype.DeploymentV3{Resources: resources}}
}

func resourceAt(urn string, typ string) apitype.ResourceV3 {
	return apitype.ResourceV3{URN: resource.URN(urn), Type: tokens.Type(typ)}
}

func TestRetain(t *testing.T) {
	files := "urn:pulumi:dev::app::sst:aws:Nextjs$pulumi-nodejs:dynamic:Resource::WebAssetFiles.sst.aws.BucketFiles"
	bucket := "urn:pulumi:dev::app::sst:aws:Nextjs$sst:aws:Bucket$aws:s3/bucketV2:BucketV2::WebAssetsBucket"
	state := stateWith(resourceAt(files, dynamic), resourceAt(bucket, "aws:s3/bucketV2:BucketV2"))

	assert.NoError(t, retain(state, []Released{{URN: files, Type: dynamic}}))
	assert.True(t, state.Latest.Resources[0].RetainOnDelete)
	// Only what's released
	assert.False(t, state.Latest.Resources[1].RetainOnDelete)
}

func TestRetainRefusesAChangedStage(t *testing.T) {
	files := "urn:pulumi:dev::app::sst:aws:Nextjs$pulumi-nodejs:dynamic:Resource::WebAssetFiles.sst.aws.BucketFiles"
	keys := "urn:pulumi:dev::app::sst:aws:Nextjs$pulumi-nodejs:dynamic:Resource::WebKvKeys.sst.aws.KvKeys"

	// Gone since the check: nothing is marked
	state := stateWith(resourceAt(files, dynamic))
	err := retain(state, []Released{{URN: files, Type: dynamic}, {URN: keys, Type: dynamic}})
	assert.ErrorContains(t, err, "isn't in the stage's state any more")
	assert.False(t, state.Latest.Resources[0].RetainOnDelete)

	// Another type at the same address
	state = stateWith(resourceAt(files, "sst:aws:BucketFiles"))
	assert.ErrorContains(t, retain(state, []Released{{URN: files, Type: dynamic}}), "not the pulumi-nodejs:dynamic:Resource the move releases")
	assert.False(t, state.Latest.Resources[0].RetainOnDelete)

	assert.ErrorContains(t, retain(&apitype.CheckpointV3{}, []Released{{URN: files, Type: dynamic}}), "no state")
}
