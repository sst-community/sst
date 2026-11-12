package move

import (
	"errors"
	"testing"

	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource/sig"
	"github.com/pulumi/pulumi/sdk/v3/go/common/tokens"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const (
	sst4Aws      = "urn:pulumi:dev::app::pulumi:providers:aws::default_7_54_0"
	sst5Aws      = "urn:pulumi:dev::app::pulumi:providers:aws::default_7_54_0"
	sst4Old      = "urn:pulumi:dev::app::pulumi:providers:aws::default_7_20_0"
	nodejs       = "urn:pulumi:dev::app::pulumi:providers:pulumi-nodejs::default"
	function     = "aws:lambda/function:Function"
	object       = "aws:s3/bucketObjectv2:BucketObjectv2"
	sst4Fn       = "urn:pulumi:dev::app::sst:aws:Function$aws:lambda/function:Function::ApiFunction"
	sst5Fn       = "urn:pulumi:dev::app::sst:aws:Function$aws:lambda/function:Function::Api"
	sst4Code     = "urn:pulumi:dev::app::sst:aws:Function$aws:s3/bucketObjectv2:BucketObjectv2::ApiCode"
	sst5Code     = "urn:pulumi:dev::app::sst:aws:Function$aws:s3/bucketObjectv2:BucketObjectv2::ApiCode5"
	providerType = "pulumi:providers:"
)

func providerAt(urn, pkg, version string) apitype.ResourceV3 {
	return apitype.ResourceV3{
		URN:    resource.URN(urn),
		Type:   tokens.Type(providerType + pkg),
		Custom: true,
		ID:     "pid",
		Inputs: map[string]interface{}{"version": version},
	}
}

func custom(urn, typ, id, provider string, outputs map[string]interface{}) apitype.ResourceV3 {
	return apitype.ResourceV3{
		URN:      resource.URN(urn),
		Type:     tokens.Type(typ),
		Custom:   true,
		ID:       resource.ID(id),
		Provider: provider + "::pid",
		Inputs:   map[string]interface{}{"in": "sst4"},
		Outputs:  outputs,
	}
}

func checkpoint(resources ...apitype.ResourceV3) *apitype.CheckpointV3 {
	return &apitype.CheckpointV3{Latest: &apitype.DeploymentV3{Resources: resources}}
}

func nothingGone(apitype.ResourceV3) (bool, error) { return false, nil }

// withSecret is outputs whose environment is a secret, as a function's is
// when SST's key for its links is in it
func withSecret(ciphertext string) map[string]interface{} {
	return map[string]interface{}{
		"environment": map[string]interface{}{sig.Key: sig.Secret, "ciphertext": ciphertext},
		"timeout":     float64(20),
		"layers":      []interface{}{"arn", map[string]interface{}{sig.Key: sig.Secret, "ciphertext": "layer " + ciphertext}},
	}
}

// What the move kept and changed in place, like a function's environment, is
// given SST 5's view of it, so SST 4's deploy sees what to put back. Its
// inputs and address stay SST 4's.
func TestRestoreRefreshesWhatTheMoveKept(t *testing.T) {
	saved := checkpoint(
		providerAt(sst4Aws, "aws", "7.54.0"),
		custom(sst4Fn, function, "app-dev-Api", sst4Aws, map[string]interface{}{"environment": "SST 4's"}),
	)
	current := checkpoint(
		providerAt(sst5Aws, "aws", "7.54.0"),
		custom(sst5Fn, function, "app-dev-Api", sst5Aws, map[string]interface{}{"environment": "SST 5's"}),
	)
	restored, err := Restore(saved, current, nothingGone, nil)
	require.NoError(t, err)
	assert.Equal(t, 1, restored.Refreshed)
	assert.Empty(t, restored.Stale)
	fn := restored.State.Latest.Resources[1]
	assert.Equal(t, resource.URN(sst4Fn), fn.URN)
	assert.Equal(t, "SST 5's", fn.Outputs["environment"])
	assert.Equal(t, "sst4", fn.Inputs["in"])
	assert.Equal(t, sst4Aws+"::pid", fn.Provider)
}

// Outputs another version of the provider wrote, or that hold secrets for
// another secrets provider, or that hold a dynamic resource's code, aren't
// carried over: the resource is listed as stale
func TestRestoreKeepsWhatItCantCarryOver(t *testing.T) {
	sst4 := map[string]interface{}{"environment": "SST 4's"}
	sst5 := map[string]interface{}{"environment": "SST 5's"}
	cases := map[string]struct {
		saved, current *apitype.CheckpointV3
	}{
		"another version of the provider": {
			saved:   checkpoint(providerAt(sst4Old, "aws", "7.20.0"), custom(sst4Fn, function, "fn", sst4Old, sst4)),
			current: checkpoint(providerAt(sst5Aws, "aws", "7.54.0"), custom(sst5Fn, function, "fn", sst5Aws, sst5)),
		},
		"two of SST 5's with the id": {
			saved: checkpoint(providerAt(sst4Aws, "aws", "7.54.0"), custom(sst4Fn, function, "fn", sst4Aws, sst4)),
			current: checkpoint(
				providerAt(sst5Aws, "aws", "7.54.0"),
				custom(sst5Fn, function, "fn", sst5Aws, sst5),
				custom(sst5Fn+"Again", function, "fn", sst5Aws, sst5),
			),
		},
	}
	secrets := checkpoint(providerAt(sst4Aws, "aws", "7.54.0"), custom(sst4Fn, function, "fn", sst4Aws, sst4))
	secrets.Latest.SecretsProviders = &apitype.SecretsProvidersV1{Type: "passphrase"}
	cases["a secret, for another secrets provider, with nothing to encrypt it again"] = struct{ saved, current *apitype.CheckpointV3 }{
		saved:   secrets,
		current: checkpoint(providerAt(sst5Aws, "aws", "7.54.0"), custom(sst5Fn, function, "fn", sst5Aws, withSecret("SST 5's"))),
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			restored, err := Restore(c.saved, c.current, nothingGone, nil)
			require.NoError(t, err)
			assert.Equal(t, 0, restored.Refreshed)
			assert.Equal(t, []resource.URN{sst4Fn}, restored.Stale)
			assert.Equal(t, "SST 4's", restored.State.Latest.Resources[1].Outputs["environment"])
		})
	}
	// A dynamic resource holds the code that serves it: SST 4's own, which
	// isn't one of the cloud's to carry over or list
	restored, err := Restore(
		checkpoint(providerAt(nodejs, "pulumi-nodejs", ""), custom(sst4Fn, "pulumi-nodejs:dynamic:Resource", "fn", nodejs, sst4)),
		checkpoint(providerAt(nodejs, "pulumi-nodejs", ""), custom(sst5Fn, "pulumi-nodejs:dynamic:Resource", "fn", nodejs, sst5)),
		nothingGone, nil,
	)
	require.NoError(t, err)
	assert.Equal(t, 0, restored.Refreshed)
	assert.Empty(t, restored.Stale)
	assert.Empty(t, restored.Replaced)
	assert.Equal(t, "SST 4's", restored.State.Latest.Resources[1].Outputs["environment"])
}

// A code object the move deleted is taken out, with what depends on it, so
// SST 4's deploy uploads it again. One that's still there stays, and one
// the move kept isn't looked for.
func TestRestoreDropsTheCodeTheMoveDeleted(t *testing.T) {
	fn := custom(sst4Fn, function, "fn", sst4Aws, map[string]interface{}{})
	fn.Dependencies = []resource.URN{sst4Code, sst4Aws}
	fn.PropertyDependencies = map[resource.PropertyKey][]resource.URN{"s3Key": {sst4Code}}
	kept := "urn:pulumi:dev::app::sst:aws:Function$aws:s3/bucketObjectv2:BucketObjectv2::KeptCode"
	there := "urn:pulumi:dev::app::sst:aws:Function$aws:s3/bucketObjectv2:BucketObjectv2::DevBridgeCode"
	saved := checkpoint(
		providerAt(sst4Aws, "aws", "7.54.0"),
		custom(sst4Code, object, "bucket/old.zip", sst4Aws, map[string]interface{}{}),
		custom(kept, object, "bucket/kept.zip", sst4Aws, map[string]interface{}{}),
		custom(there, object, "bucket/bridge.zip", sst4Aws, map[string]interface{}{}),
		fn,
	)
	current := checkpoint(
		providerAt(sst5Aws, "aws", "7.54.0"),
		custom(sst5Code, object, "bucket/new.zip", sst5Aws, map[string]interface{}{}),
		custom(kept, object, "bucket/kept.zip", sst5Aws, map[string]interface{}{}),
	)
	asked := []string{}
	restored, err := Restore(saved, current, func(r apitype.ResourceV3) (bool, error) {
		asked = append(asked, string(r.ID))
		return r.ID == "bucket/old.zip", nil
	}, nil)
	require.NoError(t, err)
	assert.Equal(t, []string{"bucket/old.zip", "bucket/bridge.zip"}, asked)
	assert.Equal(t, []resource.URN{sst4Code}, restored.Dropped)
	urns := []resource.URN{}
	for _, r := range restored.State.Latest.Resources {
		urns = append(urns, r.URN)
	}
	assert.Equal(t, []resource.URN{sst4Aws, resource.URN(kept), resource.URN(there), sst4Fn}, urns)
	left := restored.State.Latest.Resources[3]
	assert.Equal(t, []resource.URN{sst4Aws}, left.Dependencies)
	assert.Empty(t, left.PropertyDependencies["s3Key"])
	// What SST 5 uploaded under a new key stays in the cloud, untracked
	assert.Equal(t, []resource.URN{sst5Code}, restored.Unknown)
}

// Only what's in SST 5's state and the cloud is unknown to SST 4: not a
// provider, a component, or what's being deleted
func TestRestoreUnknown(t *testing.T) {
	marker := apitype.ResourceV3{URN: "urn:pulumi:dev::app::sst:sst:Moved::Moved", Type: "sst:sst:Moved"}
	deleting := custom(sst5Fn+"Old", function, "old", sst5Aws, nil)
	deleting.Delete = true
	restored, err := Restore(
		checkpoint(providerAt(sst4Aws, "aws", "7.54.0")),
		checkpoint(providerAt(sst5Aws+"Other", "aws", "7.54.0"), marker, deleting, custom(sst5Fn, function, "fn", sst5Aws, nil)),
		nothingGone, nil,
	)
	require.NoError(t, err)
	assert.Equal(t, []resource.URN{sst5Fn}, restored.Unknown)
}

func TestRestoreFailsWhenItCantLook(t *testing.T) {
	saved := checkpoint(providerAt(sst4Aws, "aws", "7.54.0"), custom(sst4Code, object, "bucket/old.zip", sst4Aws, nil))
	_, err := Restore(saved, checkpoint(), func(apitype.ResourceV3) (bool, error) { return false, errors.New("denied") }, nil)
	assert.ErrorContains(t, err, "denied")
	_, err = Restore(&apitype.CheckpointV3{}, checkpoint(), nothingGone, nil)
	assert.ErrorContains(t, err, "no state")
}

// Each run of SST 5 can give the state another salt, so a secret SST 5's
// state has is encrypted again for the copy's. Outputs without a secret are
// carried over as they are.
func TestRestoreEncryptsSecretsAgain(t *testing.T) {
	saved := checkpoint(
		providerAt(sst4Aws, "aws", "7.54.0"),
		custom(sst4Fn, function, "fn", sst4Aws, withSecret("SST 4's")),
		custom(sst4Fn+"Plain", function, "plain", sst4Aws, map[string]interface{}{"timeout": float64(10)}),
	)
	saved.Latest.SecretsProviders = &apitype.SecretsProvidersV1{Type: "passphrase", State: []byte(`{"salt":"sst4"}`)}
	current := checkpoint(
		providerAt(sst5Aws, "aws", "7.54.0"),
		custom(sst5Fn, function, "fn", sst5Aws, withSecret("SST 5's")),
		custom(sst5Fn+"Plain", function, "plain", sst5Aws, map[string]interface{}{"timeout": float64(20)}),
	)
	current.Latest.SecretsProviders = &apitype.SecretsProvidersV1{Type: "passphrase", State: []byte(`{"salt":"sst5"}`)}
	restored, err := Restore(saved, current, nothingGone, func(ciphertext string) (string, error) {
		return "again: " + ciphertext, nil
	})
	require.NoError(t, err)
	assert.Equal(t, 2, restored.Refreshed)
	assert.Empty(t, restored.Stale)
	assert.Equal(t, withSecret("again: SST 5's")["environment"], restored.State.Latest.Resources[1].Outputs["environment"])
	assert.Equal(t, []interface{}{"arn", map[string]interface{}{sig.Key: sig.Secret, "ciphertext": "again: layer SST 5's"}}, restored.State.Latest.Resources[1].Outputs["layers"])
	assert.Equal(t, float64(20), restored.State.Latest.Resources[2].Outputs["timeout"])
	// SST 5's state is left as it was
	assert.Equal(t, "SST 5's", current.Latest.Resources[1].Outputs["environment"].(map[string]interface{})["ciphertext"])

	_, err = Restore(saved, current, nothingGone, func(string) (string, error) { return "", errors.New("wrong passphrase") })
	assert.ErrorContains(t, err, "wrong passphrase")
}

// Something else the move replaced, like a REST API's deployment, is listed,
// and what depends on it keeps the copy's view, so SST 4's deploy doesn't
// point it at SST 5's or back at one that's gone
func TestRestoreKeepsWhatDependsOnWhatTheMoveReplaced(t *testing.T) {
	deployment := "urn:pulumi:dev::app::sst:aws:ApiGatewayV1$aws:apigateway/deployment:Deployment::ApiDeployment"
	stage := custom("urn:pulumi:dev::app::sst:aws:ApiGatewayV1$aws:apigateway/stage:Stage::ApiStage", "aws:apigateway/stage:Stage", "stage", sst4Aws, map[string]interface{}{"deploymentId": "sst4"})
	stage.Dependencies = []resource.URN{resource.URN(deployment)}
	saved := checkpoint(
		providerAt(sst4Aws, "aws", "7.54.0"),
		custom(deployment, "aws:apigateway/deployment:Deployment", "sst4", sst4Aws, nil),
		stage,
	)
	current := checkpoint(
		providerAt(sst5Aws, "aws", "7.54.0"),
		custom(deployment+"5", "aws:apigateway/deployment:Deployment", "sst5", sst5Aws, nil),
		custom("urn:pulumi:dev::app::sst:aws:ApiGatewayRest$aws:apigateway/stage:Stage::ApiStage", "aws:apigateway/stage:Stage", "stage", sst5Aws, map[string]interface{}{"deploymentId": "sst5"}),
	)
	restored, err := Restore(saved, current, nothingGone, nil)
	require.NoError(t, err)
	assert.Equal(t, []resource.URN{resource.URN(deployment)}, restored.Replaced)
	assert.Equal(t, []resource.URN{stage.URN}, restored.Stale)
	assert.Equal(t, 0, restored.Refreshed)
	assert.Equal(t, "sst4", restored.State.Latest.Resources[2].Outputs["deploymentId"])
	// Both are still in the state, for SST 4's refresh to sort out
	assert.Len(t, restored.State.Latest.Resources, 3)
	assert.Equal(t, []resource.URN{resource.URN(deployment + "5")}, restored.Unknown)
}

// Unknown is only what's in the cloud and nowhere in the copy: not what SST
// 5 took over from SST 4 under its own type and SST 4's id, like an origin
// access control, not SST's own resources, not what SST 5 keeps when it's
// deleted, like the code every stub shares, and not what it only reads
func TestRestoreUnknownLeavesOutWhatSST4StillUses(t *testing.T) {
	oac := custom("urn:pulumi:dev::app::sst:aws:Router$pulumi-nodejs:dynamic:Resource::RouterOac", "pulumi-nodejs:dynamic:Resource", "E2OAC", nodejs, nil)
	adopted := custom("urn:pulumi:dev::app::sst:aws:Router$aws:cloudfront/originAccessControl:OriginAccessControl::RouterOac", "aws:cloudfront/originAccessControl:OriginAccessControl", "E2OAC", sst5Aws, nil)
	files := custom("urn:pulumi:dev::app::sst:aws:StaticSite$sst:aws:BucketFiles::SiteFiles", "sst:aws:BucketFiles", "files", "urn:pulumi:dev::app::pulumi:providers:sst::default", nil)
	stub := custom("urn:pulumi:dev::app::sst:aws:Function$aws:s3/bucketObjectv2:BucketObjectv2::DevBridgeCode", object, "bucket/bridge5.zip", sst5Aws, nil)
	stub.RetainOnDelete = true
	read := custom("urn:pulumi:dev::app::aws:route53/zone:Zone::Zone", "aws:route53/zone:Zone", "Z1", sst5Aws, nil)
	read.External = true
	restored, err := Restore(
		checkpoint(providerAt(sst4Aws, "aws", "7.54.0"), oac),
		checkpoint(providerAt(sst5Aws, "aws", "7.54.0"), adopted, files, stub, read),
		nothingGone, nil,
	)
	require.NoError(t, err)
	assert.Empty(t, restored.Unknown)
	// SST 4's dynamic resource isn't one the move replaced either
	assert.Empty(t, restored.Replaced)
}

// What depends on code the move deleted loses the dependency, and one deleted
// with it no longer names it
func TestRestoreDropsWhatPointsAtDroppedCode(t *testing.T) {
	file := custom("urn:pulumi:dev::app::aws:s3/bucketObjectv2:BucketObjectv2::Note", object, "bucket/note.txt", sst4Aws, nil)
	file.DeletedWith = sst4Code
	file.ReplaceWith = []resource.URN{sst4Code, sst4Aws}
	saved := checkpoint(
		providerAt(sst4Aws, "aws", "7.54.0"),
		custom(sst4Code, object, "bucket/old.zip", sst4Aws, nil),
		file,
	)
	current := checkpoint(providerAt(sst5Aws, "aws", "7.54.0"), custom(string(file.URN), object, "bucket/note.txt", sst5Aws, nil))
	restored, err := Restore(saved, current, func(r apitype.ResourceV3) (bool, error) { return r.ID == "bucket/old.zip", nil }, nil)
	require.NoError(t, err)
	assert.Equal(t, []resource.URN{sst4Code}, restored.Dropped)
	require.Len(t, restored.State.Latest.Resources, 2)
	assert.Equal(t, resource.URN(""), restored.State.Latest.Resources[1].DeletedWith)
	assert.Equal(t, []resource.URN{sst4Aws}, restored.State.Latest.Resources[1].ReplaceWith)
}

func TestChanged(t *testing.T) {
	before := checkpoint(
		providerAt(sst5Aws, "aws", "7.54.0"),
		custom(sst5Fn, function, "fn", sst5Aws, map[string]interface{}{"environment": "a"}),
		custom(sst5Code, object, "bucket/a.zip", sst5Aws, nil),
	)
	same := checkpoint(
		providerAt(sst5Aws+"Again", "aws", "7.54.0"),
		custom(sst5Fn, function, "fn", sst5Aws, map[string]interface{}{"environment": "changed in place"}),
		custom(sst5Code, object, "bucket/a.zip", sst5Aws, nil),
		apitype.ResourceV3{URN: "urn:pulumi:dev::app::sst:sst:Moved::Moved", Type: "sst:sst:Moved"},
	)
	created, gone := Changed(before, same)
	assert.Empty(t, created)
	assert.Empty(t, gone)

	replaced := checkpoint(
		custom(sst5Fn, function, "fn-replaced", sst5Aws, nil),
		custom(sst5Code, object, "bucket/b.zip", sst5Aws, nil),
		custom(sst5Fn+"New", function, "new", sst5Aws, nil),
	)
	created, gone = Changed(before, replaced)
	assert.Equal(t, []resource.URN{sst5Fn, sst5Fn + "New"}, created)
	assert.Equal(t, []resource.URN{sst5Fn}, gone)
}

// What runs again on every deploy, like a site's build, and code swapped for
// the stub's between a deploy and `sst dev`, aren't changes that keep a stage
// from going back
func TestChangedLeavesOutCodeAndBuilds(t *testing.T) {
	builder := func(id string) apitype.ResourceV3 {
		return custom("urn:pulumi:dev::app::sst:aws:Nextjs$command:local:Command::WebBuilder", "command:local:Command", id, "", nil)
	}
	stub := custom("urn:pulumi:dev::app::sst:aws:Function$aws:s3/bucketObjectv2:BucketObjectv2::DevBridgeCodeUswest2", object, "bucket/bridge.zip", sst5Aws, nil)
	stub.RetainOnDelete = true
	deployed := checkpoint(builder("WebBuilder1a2b"), custom(sst5Code, object, "bucket/code.zip", sst5Aws, nil))
	inDev := checkpoint(builder("WebBuilder3c4d"), stub)
	created, gone := Changed(deployed, inDev)
	assert.Empty(t, created)
	assert.Empty(t, gone)
}

// SST 4's site build in the copy isn't one the move replaced: nothing in the
// cloud is behind it
func TestRestoreLeavesOutBuilds(t *testing.T) {
	restored, err := Restore(
		checkpoint(custom("urn:pulumi:dev::app::sst:aws:Nextjs$command:local:Command::WebBuilder", "command:local:Command", "WebBuilder1a2b", "", nil)),
		checkpoint(custom("urn:pulumi:dev::app::sst:aws:Nextjs$command:local:Command::WebBuilder", "command:local:Command", "WebBuilder3c4d", "", nil)),
		nothingGone, nil,
	)
	require.NoError(t, err)
	assert.Empty(t, restored.Replaced)
	assert.Empty(t, restored.Unknown)
}

// On a stage SST keeps everything of when it's removed, what SST 5 uploaded
// is still listed: only the code the stubs share is left out
func TestRestoreUnknownOnAStageThatsKept(t *testing.T) {
	code := custom(sst5Code, object, "bucket/new.zip", sst5Aws, nil)
	code.RetainOnDelete = true
	restored, err := Restore(checkpoint(providerAt(sst4Aws, "aws", "7.54.0")), checkpoint(providerAt(sst5Aws, "aws", "7.54.0"), code), nothingGone, nil)
	require.NoError(t, err)
	assert.Equal(t, []resource.URN{sst5Code}, restored.Unknown)
}
