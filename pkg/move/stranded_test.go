package move

import (
	"strings"
	"testing"

	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
	"github.com/pulumi/pulumi/sdk/v3/go/common/tokens"
	"github.com/stretchr/testify/assert"
)

// A component at a chain of types, as a URN has it, and its parent
func component(chain, name, parent string) apitype.ResourceV3 {
	types := strings.Split(chain, "$")
	return apitype.ResourceV3{
		URN:    resource.URN("urn:pulumi:dev::app::" + chain + "::" + name),
		Type:   tokens.Type(types[len(types)-1]),
		Parent: resource.URN(parent),
	}
}

func TestFindStranded(t *testing.T) {
	stack := "urn:pulumi:dev::app::pulumi:pulumi:Stack::app-dev"
	cron := component("sst:aws:Cron", "Nightly", stack)
	cronV2 := component("sst:aws:CronV2", "Hourly", stack)
	vector := component("sst:aws:Vector", "Embeddings", stack)
	// The `Postgres.v1` a `Vector` keeps its vectors in moves with it
	vectorDb := component("sst:aws:Vector$sst:aws:Postgres", "EmbeddingsDatabase", string(vector.URN))
	// The `Cron` that warms a site moves with the site
	site := component("sst:aws:Nextjs", "Web", stack)
	warmer := component("sst:aws:Nextjs$sst:aws:Cron", "WebWarmer", string(site.URN))
	// The current `Vpc` records its version inside it; a `Vpc.v1` doesn't
	vpc := component("sst:aws:Vpc", "Net", stack)
	vpcVersion := component("sst:aws:Vpc$sst:sst:Version", "NetVersion", string(vpc.URN))
	vpcV1 := component("sst:aws:Vpc", "OldNet", stack)
	// Cloudflare's first `StaticSite` keeps its files in a `Kv`
	firstSite := component("sst:cloudflare:StaticSite", "Docs", stack)
	firstSiteKv := component("sst:cloudflare:StaticSite$sst:cloudflare:Kv", "DocsAssets", string(firstSite.URN))
	siteV2 := component("sst:cloudflare:StaticSite", "Blog", stack)
	// One inside an app's own component is the app's
	wrapper := component("acme:index:Jobs", "Jobs", stack)
	wrapped := component("acme:index:Jobs$sst:aws:Cron", "JobsCleanup", string(wrapper.URN))
	// A resource of a type with no 5.0 form isn't a component
	custom := component("sst:aws:Cron$aws:cloudwatch/eventRule:EventRule", "NightlyRule", string(cron.URN))
	custom.Custom = true

	found := FindStranded([]apitype.ResourceV3{
		cron, cronV2, vector, vectorDb, site, warmer, vpc, vpcVersion, vpcV1,
		firstSite, firstSiteKv, siteV2, wrapper, wrapped, custom,
	})
	names := []string{}
	for _, s := range found {
		names = append(names, s.Name)
	}
	assert.Equal(t, []string{"Docs", "Embeddings", "JobsCleanup", "Nightly", "OldNet"}, names)
	assert.Equal(t, `"Nightly" is SST 4's first `+"`Cron`"+`, which has no 5.0 form: move it to `+"`sst.aws.CronV2`"+` with SST 4, which is `+"`Cron`"+` in 5.0.`, found[3].String())
	assert.Contains(t, found[4].String(), "`Vpc.v1`")
	assert.Contains(t, found[0].String(), "Cloudflare's first `StaticSite`")

	assert.Nil(t, FindStranded([]apitype.ResourceV3{cronV2, site, warmer, vpc, vpcVersion, siteV2}))
	assert.Nil(t, FindStranded(nil))
}

// SST 4's `Vector.get` looks up its database as a `Postgres.v1` beside it,
// which the app didn't write: only the `Vector` is listed. Two listed with one
// name say which component each is in.
func TestFindStrandedVectorGetAndSameNames(t *testing.T) {
	stack := "urn:pulumi:dev::app::pulumi:pulumi:Stack::app-dev"
	vector := component("sst:aws:Vector", "Search", stack)
	lookedUp := component("sst:aws:Postgres", "SearchDatabase", stack)
	// A `Postgres.v1` the app wrote itself is still listed
	own := component("sst:aws:Postgres", "Reports", stack)
	api := component("acme:index:Api", "Api", stack)
	worker := component("acme:index:Worker", "Worker", stack)
	inApi := component("acme:index:Api$sst:aws:Cron", "Cleanup", string(api.URN))
	inWorker := component("acme:index:Worker$sst:aws:Cron", "Cleanup", string(worker.URN))

	found := FindStranded([]apitype.ResourceV3{vector, lookedUp, own, api, worker, inApi, inWorker})
	lines := []string{}
	for _, s := range found {
		lines = append(lines, s.String())
	}
	assert.Len(t, lines, 4)
	assert.True(t, strings.HasPrefix(lines[0], `"Cleanup", in "Api", is SST 4's first`), lines[0])
	assert.True(t, strings.HasPrefix(lines[1], `"Cleanup", in "Worker", is SST 4's first`), lines[1])
	assert.True(t, strings.HasPrefix(lines[2], `"Reports" is a `+"`Postgres.v1`"), lines[2])
	assert.True(t, strings.HasPrefix(lines[3], `"Search" is a `+"`Vector`"), lines[3])
}

// Every type the codemod leaves out has a line here, as the two lists say the
// same of a config and a state
func TestStrandedTypes(t *testing.T) {
	for _, typ := range []string{"sst:aws:Cron", "sst:aws:OpenControl", "sst:aws:Vector", "sst:cloudflare:Auth", "sst:cloudflare:SolidStart"} {
		assert.Contains(t, leftOut[typ], "no 5.0 form", typ)
	}
	for _, typ := range []string{"sst:aws:Auth", "sst:aws:Vpc", "sst:aws:Cluster", "sst:aws:Postgres", "sst:aws:Redis"} {
		assert.Contains(t, v1[typ], ".v1`", typ)
	}
}

// Every `.v1` is told from its current version by the version marker the
// current one records inside it
func TestFindStrandedEachFirstVersion(t *testing.T) {
	stack := "urn:pulumi:dev::app::pulumi:pulumi:Stack::app-dev"
	for _, name := range []string{"Auth", "Vpc", "Cluster", "Postgres", "Redis"} {
		old := component("sst:aws:"+name, "Old", stack)
		current := component("sst:aws:"+name, "Current", stack)
		marker := component("sst:aws:"+name+"$sst:sst:Version", "CurrentVersion", string(current.URN))
		found := FindStranded([]apitype.ResourceV3{old, current, marker})
		if assert.Len(t, found, 1, name) {
			assert.Equal(t, "Old", found[0].Name, name)
			assert.Contains(t, found[0].String(), "`"+name+".v1`", name)
		}
	}
}
