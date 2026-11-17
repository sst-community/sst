package move

import (
	"testing"

	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
	"github.com/pulumi/pulumi/sdk/v3/go/common/tokens"
	"github.com/stretchr/testify/assert"
)

// The rules only a move from SST 4 needs (sst4.go). The steps are made
// with check_test.go's helpers.

// The dev stub code every stage in an account and region shares: SST 5 keeps
// it when it's deleted, and the move keeps the one an SST 4 without that rule
// uploaded, which other stages' functions are created from.
func TestKeptWhenReplaced(t *testing.T) {
	const before = "31949f392f6e9c7db434e78a711e595c401e8bdd4feb6d95f62e1ae9876574d3"
	const after = "16202918c4b0e2f1a9d7c3b5e8f0a2c4d6e8f0a1b3c5d7e9f1a3b5c7d9e1f3a5"
	bridge := urn("aws:s3/bucketObjectv2:BucketObjectv2", "DevBridgeCodeUswest2Bridge")
	// Its replace, with whether the one SST 4 deployed and the one in its
	// place are kept when they're deleted
	stub := func(oldKept, newKept bool) []apitype.StepEventMetadata {
		withKeys := inputs(
			map[string]any{"key": "assets/dev-bridge-code-" + before + ".zip"},
			map[string]any{"key": "assets/dev-bridge-code-" + after + ".zip"},
		)
		kept := func(s *apitype.StepEventMetadata) {
			s.Old.RetainOnDelete = oldKept
			s.New.RetainOnDelete = newKept
		}
		deleted := step(apitype.OpDeleteReplaced, bridge, func(s *apitype.StepEventMetadata) { s.Old.RetainOnDelete = oldKept })
		deleted.New = nil
		return []apitype.StepEventMetadata{
			step(apitype.OpCreateReplacement, bridge, keys("key"), withKeys, kept),
			step(apitype.OpReplace, bridge, keys("key"), withKeys, kept),
			deleted,
		}
	}

	// An upstream SST 4's, not kept on delete: the move keeps it
	r := Check(stub(false, true), nil)
	assert.Empty(t, problems(r))
	assert.Equal(t, []Change{{URN: bridge, Type: "aws:s3/bucketObjectv2:BucketObjectv2", Why: "SST 5 keeps it when it's deleted, so the move keeps the one SST 4 deployed."}}, r.Retained)
	if assert.Len(t, r.Replaced, 1) {
		assert.Equal(t, "Its file changed, and its key follows from the file: any deploy uploads it again under the new key. The one SST 4 deployed is kept in the cloud, as SST 5 keeps this one when it's deleted.", r.Replaced[0].Why)
	}
	// One already kept on delete, as sst-community's SST 4 uploads it
	assert.Empty(t, Check(stub(true, true), nil).Retained)
	// What SST 5 doesn't keep either, like a function's own code
	assert.Empty(t, Check(stub(false, false), nil).Retained)
	// A replace the move may not make keeps nothing
	refused := stub(false, true)
	for i := range refused {
		if refused[i].Op != apitype.OpDeleteReplaced {
			refused[i].Keys = []string{"bucket", "key"}
		}
	}
	r = Check(refused, nil)
	assert.Len(t, problems(r), 1)
	assert.Empty(t, r.Retained)
}

func TestKindOf(t *testing.T) {
	assert.Equal(t, "sst.aws.VectorTable", kindOf(vector))
	assert.Equal(t, "", kindOf(bucket))
	assert.Equal(t, "", kindOf("no address"))
	assert.True(t, holdsData("pulumi-nodejs:dynamic:Resource", vector))
	assert.False(t, holdsData("pulumi-nodejs:dynamic:Resource", oldFiles))
}

// SST 4 looked up a domain's hosted zone with a resource, which SST 5 does
// with a function of its provider
func TestLookups(t *testing.T) {
	zone := urn("sst:aws:CDN$pulumi-nodejs:dynamic:Resource", "WebAZoneLookupExamplecom.sst.aws.HostedZoneLookup")
	cloudflare := urn("sst:aws:CDN$pulumi-nodejs:dynamic:Resource", "WebCNAMEexample.comZoneLookup.sst.cloudflare.ZoneLookup")
	r := Check([]apitype.StepEventMetadata{
		step(apitype.OpDelete, zone),
		step(apitype.OpDelete, cloudflare),
	}, nil)
	assert.Empty(t, problems(r))
	assert.Len(t, r.Released, 2)
	assert.Contains(t, r.Released[0].Why, "SST 4's lookups")

	// SST 4's Cloudflare lookups have the domain in their name
	docs := urn("sst:aws:CDN$pulumi-nodejs:dynamic:Resource", "WebCNAMEdocs.sst.devZoneLookup.sst.cloudflare.ZoneLookup")
	r = Check([]apitype.StepEventMetadata{step(apitype.OpDelete, docs)}, nil)
	assert.Empty(t, problems(r))
	assert.Len(t, r.Released, 1)

	// Another of SST's resources isn't one
	waiter := urn("sst:aws:CDN$pulumi-nodejs:dynamic:Resource", "WebWaiter.sst.aws.DistributionDeploymentWaiter")
	assert.Len(t, problems(Check([]apitype.StepEventMetadata{step(apitype.OpDelete, waiter)}, nil)), 1)
}

// SST 4's origin access control is adopted by its id: a create would make a
// second one in the cloud, and leave this one there
func TestAdopting(t *testing.T) {
	oldControl := urn("sst:aws:StaticSite$pulumi-nodejs:dynamic:Resource", "SiteS3AccessControl.sst.aws.OriginAccessControl")
	newControl := urn("sst:aws:StaticSite$sst:aws:OriginAccessControl", "SiteS3AccessControl")
	part := []Part{{URN: newControl, Key: "accessControl", Releases: []string{oldControl}}}

	r := Check([]apitype.StepEventMetadata{
		step(apitype.OpDelete, oldControl, withID("E2OAC")),
		step(apitype.OpCreate, newControl, inTheCloud()),
	}, part)
	assert.Equal(t, [][2]string{
		{"delete SiteS3AccessControl.sst.aws.OriginAccessControl", "SiteS3AccessControl, in its place, doesn't adopt it by its id, so a second one would be made in the cloud and this one left there."},
	}, problems(r))

	r = Check([]apitype.StepEventMetadata{
		step(apitype.OpDelete, oldControl, withID("E2OAC")),
		step(apitype.OpImport, newControl, withID("E2OAC"), inTheCloud()),
	}, part)
	assert.True(t, r.OK(), problems(r))
	assert.Len(t, r.Released, 1)
	assert.Len(t, r.Created, 1)

	// What's written again isn't adopted
	r = Check([]apitype.StepEventMetadata{
		step(apitype.OpDelete, oldFiles, withID("files")),
		step(apitype.OpCreate, newFiles, inTheCloud()),
	}, []Part{{URN: newFiles, Key: "files", Releases: []string{oldFiles}}})
	assert.True(t, r.OK(), problems(r))
}

func TestAdoptable(t *testing.T) {
	res := func(typ, address, id string) apitype.ResourceV3 {
		return apitype.ResourceV3{URN: resource.URN(address), Type: tokens.Type(typ), ID: resource.ID(id), Custom: true}
	}
	const dynamic = "pulumi-nodejs:dynamic:Resource"
	ids := Adoptable([]apitype.ResourceV3{
		res(dynamic, urn("sst:aws:StaticSite$pulumi-nodejs:dynamic:Resource", "SiteS3AccessControl.sst.aws.OriginAccessControl"), "E2OAC"),
		// What's written again
		res(dynamic, oldFiles, "files"),
		// The 5.0 one
		res("sst:aws:OriginAccessControl", urn("sst:aws:StaticSite$sst:aws:OriginAccessControl", "DocsS3AccessControl"), "E3OAC"),
		// Two of the same name, in different components: neither
		res(dynamic, urn("sst:aws:StaticSite$pulumi-nodejs:dynamic:Resource", "WebS3AccessControl.sst.aws.OriginAccessControl"), "E4OAC"),
		res(dynamic, urn("test:Parent$sst:aws:StaticSite$pulumi-nodejs:dynamic:Resource", "WebS3AccessControl.sst.aws.OriginAccessControl"), "E5OAC"),
	})
	pending := res(dynamic, urn("sst:aws:StaticSite$pulumi-nodejs:dynamic:Resource", "DocsS3AccessControl.sst.aws.OriginAccessControl"), "E6OAC")
	pending.Delete = true
	assert.Equal(t, map[string]string{"SiteS3AccessControl.sst.aws.OriginAccessControl": "E2OAC"}, ids)
	// One a replace left to delete
	assert.Empty(t, Adoptable([]apitype.ResourceV3{pending}))
}

// A move that stopped after it adopted one: its retry finds the part in the
// state with the id, and a name two of SST 4's share is said why it's refused
func TestAdoptingAgain(t *testing.T) {
	oldControl := urn("sst:aws:StaticSite$pulumi-nodejs:dynamic:Resource", "WebS3AccessControl.sst.aws.OriginAccessControl")
	newControl := urn("sst:aws:StaticSite$sst:aws:OriginAccessControl", "WebS3AccessControl")
	part := []Part{{URN: newControl, Key: "accessControl", Releases: []string{oldControl}}}
	r := Check([]apitype.StepEventMetadata{
		step(apitype.OpDelete, oldControl, withID("E2OAC")),
		step(apitype.OpSame, newControl, withID("E2OAC"), inTheCloud()),
	}, part)
	assert.True(t, r.OK(), problems(r))

	other := urn("test:Parent$sst:aws:StaticSite$pulumi-nodejs:dynamic:Resource", "WebS3AccessControl.sst.aws.OriginAccessControl")
	r = Check([]apitype.StepEventMetadata{
		step(apitype.OpDelete, oldControl, withID("E2OAC")),
		step(apitype.OpDelete, other, withID("E3OAC")),
		step(apitype.OpCreate, newControl, inTheCloud()),
	}, part)
	assert.Contains(t, problems(r), [2]string{
		"delete WebS3AccessControl.sst.aws.OriginAccessControl",
		"WebS3AccessControl, in its place, doesn't adopt it by its id, so a second one would be made in the cloud and this one left there. The stage has more than one named WebS3AccessControl.sst.aws.OriginAccessControl, in different components, so the core can't tell which is whose.",
	})
}

func TestExplain(t *testing.T) {
	fn := urn("sst:aws:Function$aws:lambda/function:Function", "ApiFunction")
	other := urn("sst:aws:Bucket$aws:s3/bucketV2:BucketV2", "FilesBucket")
	result := &Result{Kept: []Kept{
		{URN: fn, Fields: []string{"loggingConfig", "timeout"}},
		{URN: other, Fields: []string{"tags"}},
		{URN: urn("sst:aws:Queue$aws:sqs/queue:Queue", "JobsQueue")},
	}}
	result.Explain([]Merged{
		{URN: fn, Fields: []MergedField{
			{Field: "loggingConfig", Kept: []string{"logFormat", "logGroup"}},
			// Merged, but nothing changes there: not why it updates
			{Field: "environment", Kept: []string{"variables.SST_KEY"}},
		}},
	})
	assert.Equal(t, []MergedField{{Field: "loggingConfig", Kept: []string{"logFormat", "logGroup"}}}, result.Kept[0].Merged)
	assert.Nil(t, result.Kept[1].Merged)
	assert.Nil(t, result.Kept[2].Merged)
}

// A merge explains a replace that may not happen only through the fields the
// replace is keyed on, and never one the move allows, which a map or the
// cloud is why; a merge reported for a component, like a function part's,
// explains a field of the same name a resource inside it updates.
func TestExplainReplacedAndInside(t *testing.T) {
	component := urn("sst:aws:Bus$sst:aws:Function", "BusSubscriber")
	lambda := urn("sst:aws:Bus$sst:aws:Function$aws:lambda/function:Function", "BusSubscriberFunction")
	role := urn("sst:aws:Bus$sst:aws:Function$aws:iam/role:Role", "BusSubscriberRole")
	replaced := urn("sst:aws:Queue$aws:sqs/queue:Queue", "JobsQueue")
	blocked := urn("sst:aws:Dynamo$aws:dynamodb/table:Table", "UsersTable")
	other := urn("sst:aws:Dynamo$aws:dynamodb/table:Table", "OrdersTable")
	result := &Result{
		Kept: []Kept{
			{URN: lambda, Fields: []string{"environment"}},
			{URN: role, Fields: []string{"inlinePolicies"}},
		},
		Replaced: []Change{{URN: replaced}},
		Problems: []Problem{
			{URN: blocked, Does: "replace", Fields: []string{"pointInTimeRecovery"}},
			// Replaced for another field than the one merged
			{URN: other, Does: "replace", Fields: []string{"hashKey"}},
			// Said under the kept resource already
			{URN: lambda, Does: "update"},
		},
		parents: map[string]string{lambda: component, role: component},
	}
	env := MergedField{Field: "environment", Kept: []string{"SST_RESOURCE_App"}}
	table := MergedField{Field: "pointInTimeRecovery", Kept: []string{"enabled"}}
	result.Explain([]Merged{
		{URN: component, Fields: []MergedField{env}},
		{URN: replaced, Fields: []MergedField{{Field: "redrivePolicy", Kept: []string{"maxReceiveCount"}}}},
		{URN: blocked, Fields: []MergedField{table}},
		{URN: other, Fields: []MergedField{table}},
	})
	assert.Equal(t, []MergedField{env}, result.Kept[0].Merged)
	// Inside the component, but it doesn't update what was merged
	assert.Nil(t, result.Kept[1].Merged)
	assert.Equal(t, []MergedField{table}, result.Problems[0].Merged)
	assert.Nil(t, result.Problems[1].Merged)
	assert.Nil(t, result.Problems[2].Merged)
}
