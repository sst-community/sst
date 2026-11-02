package move

import (
	"strings"
	"testing"

	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
	"github.com/stretchr/testify/assert"
)

const prefix = "urn:pulumi:dev::app::"

func urn(chain, name string) string {
	return prefix + chain + "::" + name
}

type stepOption func(*apitype.StepEventMetadata)

func from(old string) stepOption {
	return func(s *apitype.StepEventMetadata) { s.Old.URN = old }
}

func fields(paths ...string) stepOption {
	return func(s *apitype.StepEventMetadata) {
		s.DetailedDiff = map[string]apitype.PropertyDiff{}
		for _, path := range paths {
			s.DetailedDiff[path] = apitype.PropertyDiff{Kind: apitype.DiffUpdate}
		}
	}
}

func keys(paths ...string) stepOption {
	return func(s *apitype.StepEventMetadata) { s.Keys = paths }
}

// SST's own provider resources in 5.0 are in the cloud too
func inTheCloud() stepOption {
	return func(s *apitype.StepEventMetadata) {
		for _, state := range []*apitype.StepEventStateMetadata{s.Old, s.New} {
			if state != nil {
				state.Custom = true
			}
		}
	}
}

func retained() stepOption {
	return func(s *apitype.StepEventMetadata) { s.Old.RetainOnDelete = true }
}

// A step as Pulumi's preview reports it. A component's type starts with
// "sst:"; anything else is a resource in the cloud.
func step(op apitype.OpType, address string, options ...stepOption) apitype.StepEventMetadata {
	chain := strings.Split(address, "::")[2]
	typ := chain[strings.LastIndex(chain, "$")+1:]
	custom := !strings.HasPrefix(typ, "sst:")
	s := apitype.StepEventMetadata{Op: op, URN: address, Type: typ}
	state := &apitype.StepEventStateMetadata{URN: address, Type: typ, Custom: custom}
	switch op {
	case apitype.OpCreate, apitype.OpImport:
		s.New = state
	case apitype.OpDelete:
		s.Old = state
	default:
		old := *state
		s.Old = &old
		s.New = state
	}
	// A lookup is of something the app doesn't manage
	if op == apitype.OpRead {
		s.Old.External, s.New.External = true, true
	}
	for _, option := range options {
		option(&s)
	}
	return s
}

func problems(r *Result) [][2]string {
	out := [][2]string{}
	for _, p := range r.Problems {
		out = append(out, [2]string{p.Does + " " + nameOf(p.URN), p.Why})
	}
	return out
}

var (
	bucket     = urn("sst:aws:Bucket$aws:s3/bucketV2:BucketV2", "FilesBucket")
	policy     = urn("sst:aws:Bucket$aws:s3/bucketPolicy:BucketPolicy", "FilesPolicy")
	oldPolicy  = urn("sst:aws:Bucket$aws:s3/bucketPolicy:BucketPolicy", "FilesBucketPolicy")
	wrapper    = urn("sst:aws:Bucket$sst:aws:BucketNotification", "FilesNotification")
	version    = urn("sst:sst:Version", "FilesVersion")
	code       = urn("sst:aws:Function$aws:s3/bucketObjectv2:BucketObjectv2", "ApiCode")
	queue      = urn("sst:aws:Queue$aws:sqs/queue:Queue", "JobsQueue")
	logs       = urn("sst:aws:Function$aws:cloudwatch/logGroup:LogGroup", "ApiLogGroup")
	oldFiles   = urn("sst:aws:StaticSite$pulumi-nodejs:dynamic:Resource", "SiteAssetFiles.sst.aws.BucketFiles")
	newFiles   = urn("sst:aws:StaticSite$sst:aws:BucketFiles", "SiteFiles")
	vector     = urn("sst:aws:Vector$pulumi-nodejs:dynamic:Resource", "EmbeddingsTable.sst.aws.VectorTable")
	userBucket = urn("aws:s3/bucketV2:BucketV2", "Uploads")
	provider   = prefix + "pulumi:providers:aws::default_7_10_0"
)

func TestKeptAndMoved(t *testing.T) {
	r := Check([]apitype.StepEventMetadata{
		step(apitype.OpSame, bucket),
		// Moved by the map, and updated in place
		step(apitype.OpUpdate, policy, from(oldPolicy), fields("policy.Statement[0]", "tags.sst:app")),
		step(apitype.OpRead, urn("aws:route53/zone:Zone", "Zone")),
	}, nil)
	assert.True(t, r.OK())
	assert.ElementsMatch(t, []Kept{
		{URN: bucket, Type: "aws:s3/bucketV2:BucketV2"},
		{URN: policy, Type: "aws:s3/bucketPolicy:BucketPolicy", From: oldPolicy, Fields: []string{"policy", "tags"}},
		{URN: urn("aws:route53/zone:Zone", "Zone"), Type: "aws:route53/zone:Zone"},
	}, r.Kept)
}

func TestNothingInTheCloud(t *testing.T) {
	r := Check([]apitype.StepEventMetadata{
		step(apitype.OpDelete, wrapper),
		step(apitype.OpDelete, version),
		step(apitype.OpCreate, urn("sst:aws:Bucket$sst:aws:Wrapper", "FilesWrapper")),
		step(apitype.OpCreate, provider),
	}, nil)
	assert.Empty(t, problems(r))
	assert.Len(t, r.Left, 2)
	assert.Len(t, r.Created, 2)
}

// A 4.x site builds with a command run on this machine, which the V5 one
// doesn't keep in the state
func TestLocalCommand(t *testing.T) {
	builder := urn("sst:aws:Nextjs$command:local:Command", "WebBuilder")
	r := Check([]apitype.StepEventMetadata{step(apitype.OpDelete, builder)}, nil)
	assert.Empty(t, problems(r))
	assert.Len(t, r.Left, 1)

	// Deleting one with a delete command runs it
	withDelete := step(apitype.OpDelete, builder)
	withDelete.Old.Inputs = map[string]interface{}{"delete": "rm -rf build"}
	r = Check([]apitype.StepEventMetadata{withDelete}, nil)
	assert.Len(t, problems(r), 1)

	// A 4.x site that stays 4.x builds again, as on every deploy
	astro := urn("sst:aws:Astro$command:local:Command", "WebBuilder")
	rebuild := step(apitype.OpReplace, astro)
	rebuild.Keys = []string{"triggers[0]"}
	assert.Empty(t, problems(Check([]apitype.StepEventMetadata{rebuild}, nil)))
	inside := urn("acme:index:Web$sst:aws:StaticSite$command:local:Command", "DocsBuilder")
	assert.Empty(t, problems(Check([]apitype.StepEventMetadata{step(apitype.OpCreate, inside)}, nil)))

	// A command of the user's: creating or replacing one runs it
	userCommand := urn("command:local:Command", "Seed")
	r = Check([]apitype.StepEventMetadata{step(apitype.OpCreate, userCommand)}, nil)
	assert.Len(t, problems(r), 1)
	replace := step(apitype.OpReplace, userCommand)
	replace.Keys = []string{"create"}
	r = Check([]apitype.StepEventMetadata{replace}, nil)
	assert.Len(t, problems(r), 1)
	inTheirs := urn("acme:index:Web$command:local:Command", "WebBuilder")
	r = Check([]apitype.StepEventMetadata{step(apitype.OpCreate, inTheirs)}, nil)
	assert.Len(t, problems(r), 1)
}

func TestCreatesAndDeletesNeedTheMap(t *testing.T) {
	steps := []apitype.StepEventMetadata{
		step(apitype.OpCreate, urn("sst:aws:Function$aws:lambda:Permission", "ApiUrlAccess")),
		step(apitype.OpDelete, urn("sst:aws:Function$aws:lambda:Permission", "ApiPublicUrlAccess")),
		step(apitype.OpCreate, userBucket),
	}
	assert.ElementsMatch(t, [][2]string{
		{"create ApiUrlAccess", "No component's state map says it's new. If it's new in sst.config.ts, add it after the move."},
		{"delete ApiPublicUrlAccess", "No component's state map releases it."},
		{"create Uploads", "No component's state map says it's new. If it's new in sst.config.ts, add it after the move."},
	}, problems(Check(steps, nil)))

	r := Check(steps, []Part{
		{URN: urn("sst:aws:Function$aws:lambda:Permission", "ApiUrlAccess"), Key: "urlAccess", Added: true},
	})
	assert.ElementsMatch(t, [][2]string{
		{"delete ApiPublicUrlAccess", "No component's state map releases it."},
		{"create Uploads", "No component's state map says it's new. If it's new in sst.config.ts, add it after the move."},
	}, problems(r))
	assert.Equal(t, []Change{{
		URN:  urn("sst:aws:Function$aws:lambda:Permission", "ApiUrlAccess"),
		Type: "aws:lambda:Permission",
		Why:  "It's new in this version of the component.",
	}}, r.Created)
}

func TestInsideANewPart(t *testing.T) {
	function := urn("sst:aws:Queue$sst:aws:Function", "JobsDeadLetterHandler")
	role := urn("sst:aws:Queue$sst:aws:Function$aws:iam/role:Role", "JobsDeadLetterHandlerRole")
	parent := func(of string) stepOption {
		return func(s *apitype.StepEventMetadata) { s.New.Parent = of }
	}
	steps := []apitype.StepEventMetadata{
		step(apitype.OpCreate, function, parent(urn("sst:aws:Queue", "Jobs"))),
		step(apitype.OpCreate, role, parent(function)),
	}
	assert.Len(t, Check(steps, nil).Problems, 1)
	r := Check(steps, []Part{{URN: function, Key: "deadLetterHandler", Added: true}})
	assert.True(t, r.OK())
	assert.Len(t, r.Created, 2)
}

func TestReleased(t *testing.T) {
	steps := []apitype.StepEventMetadata{
		step(apitype.OpDelete, oldFiles),
		step(apitype.OpCreate, newFiles, inTheCloud()),
	}
	assert.Len(t, Check(steps, nil).Problems, 2)

	r := Check(steps, []Part{{URN: newFiles, Key: "files", Releases: []string{oldFiles}}})
	assert.True(t, r.OK())
	assert.Equal(t, []Change{{URN: oldFiles, Type: "pulumi-nodejs:dynamic:Resource", Why: "Taken out of the state without being deleted, with SiteFiles in its place."}}, r.Released)
	assert.Equal(t, []Change{{URN: newFiles, Type: "sst:aws:BucketFiles", Why: "It takes the place of what's released."}}, r.Created)
}

func TestReplaced(t *testing.T) {
	// Pulumi's preview has three steps for a replace
	replace := func(address string) []apitype.StepEventMetadata {
		return []apitype.StepEventMetadata{
			step(apitype.OpCreateReplacement, address, keys("key")),
			step(apitype.OpReplace, address, keys("key")),
			step(apitype.OpDeleteReplaced, address),
		}
	}
	assert.Equal(t, [][2]string{
		{"replace ApiCode", "No component's state map says it's replaced. Changed: key."},
	}, problems(Check(replace(code), nil)))

	r := Check(replace(code), []Part{{URN: code, Key: "code", Replaced: "Its code is uploaded again under the function's new name."}})
	assert.True(t, r.OK())
	assert.Equal(t, []Change{{URN: code, Type: "aws:s3/bucketObjectv2:BucketObjectv2", Why: "Its code is uploaded again under the function's new name."}}, r.Replaced)
}

func TestReplacedWhereItMoved(t *testing.T) {
	// The map moves the code to a new address, and its key changes with it.
	// What deletes the old code is at the old address.
	oldCode := urn("sst:aws:Function$aws:s3/bucketObjectv2:BucketObjectv2", "ApiOldCode")
	steps := []apitype.StepEventMetadata{
		step(apitype.OpCreateReplacement, code, from(oldCode), keys("key")),
		step(apitype.OpReplace, code, from(oldCode), keys("key")),
		step(apitype.OpDeleteReplaced, oldCode),
	}
	assert.Equal(t, [][2]string{
		{"replace ApiCode", "No component's state map says it's replaced. Changed: key."},
	}, problems(Check(steps, nil)))
	r := Check(steps, []Part{{URN: code, Key: "code", Replaced: "Uploaded again."}})
	assert.True(t, r.OK())
	assert.Len(t, r.Replaced, 1)
}

// A 4.x server-rendered site that stays 4.x builds again on every deploy, and
// its server's code and source maps are uploaded again under new keys. So is
// any function's code that changed since the last deploy.
func TestNewUpload(t *testing.T) {
	const before = "3f1c9a0e5b7d2c4f6a8e0b1d3c5f7a9e2b4d6f8a0c1e3b5d7f9a2c4e6b8d0f1a"
	const after = "9b8a7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b"
	upload := func(address, old, new string, replaceKeys ...string) []apitype.StepEventMetadata {
		if len(replaceKeys) == 0 {
			replaceKeys = []string{"key"}
		}
		withKeys := inputs(map[string]any{"key": old}, map[string]any{"key": new})
		deleted := step(apitype.OpDeleteReplaced, address)
		deleted.New = nil
		return []apitype.StepEventMetadata{
			step(apitype.OpCreateReplacement, address, keys(replaceKeys...), withKeys),
			step(apitype.OpReplace, address, keys(replaceKeys...), withKeys),
			deleted,
		}
	}
	server := urn("sst:aws:Astro$sst:aws:Function$aws:s3/bucketObjectv2:BucketObjectv2", "AstroServerUswest2Code")
	sourcemap := urn("sst:aws:Astro$sst:aws:Function$aws:s3/bucketObjectv2:BucketObjectv2", "AstroServerUswest2Sourcemap0")
	arn := "arn:aws:logs:us-west-2:123456789012:log-group:/aws/lambda/app-dev-AstroServerUswest2Function-abcdef"

	steps := append(
		upload(server, "assets/AstroServerUswest2-code-"+before+".zip", "assets/AstroServerUswest2-code-"+after+".zip"),
		upload(sourcemap, "sourcemap/"+arn+"/"+before+".index.mjs.map", "sourcemap/"+arn+"/"+after+".index.mjs.map")...,
	)
	r := Check(steps, nil)
	assert.Empty(t, problems(r))
	assert.Equal(t, []Change{
		{URN: server, Type: "aws:s3/bucketObjectv2:BucketObjectv2", Why: "Its file changed, and its key follows from the file: any deploy uploads it again under the new key."},
		{URN: sourcemap, Type: "aws:s3/bucketObjectv2:BucketObjectv2", Why: "Its file changed, and its key follows from the file: any deploy uploads it again under the new key."},
	}, r.Replaced)

	// What the map says comes first
	r = Check(upload(code, "assets/Api-code-"+before+".zip", "assets/Api-code-"+after+".zip"), []Part{{URN: code, Key: "code", Replaced: "Uploaded again."}})
	assert.Equal(t, "Uploaded again.", r.Replaced[0].Why)

	failed := func(steps []apitype.StepEventMetadata) [][2]string {
		return problems(Check(steps, nil))
	}
	// A key that changes in more than its hash, as when a map renames the
	// function, needs the map
	assert.Len(t, failed(upload(code, "assets/ApiOld-code-"+before+".zip", "assets/Api-code-"+after+".zip")), 1)
	// A key with no hash in it doesn't follow from the file
	assert.Len(t, failed(upload(code, "assets/api.zip", "assets/api-v2.zip")), 1)
	assert.Len(t, failed(upload(code, "assets/api-1.zip", "assets/api-2.zip")), 1)
	// A key a preview doesn't know yet
	assert.Len(t, failed(upload(code, "assets/Api-code-"+before+".zip", "04da6b54-80e4-46f7-96ec-b56ff0331ba9")), 1)
	// Into another bucket
	assert.Len(t, failed(upload(code, "assets/Api-code-"+before+".zip", "assets/Api-code-"+after+".zip", "bucket", "key")), 1)
	// Nor anything that isn't an object in a bucket
	layer := urn("aws:lambda/layerVersion:LayerVersion", "Deps")
	assert.Len(t, failed(upload(layer, "deps-"+before, "deps-"+after)), 1)
}

func TestDataIsNeverLost(t *testing.T) {
	steps := []apitype.StepEventMetadata{
		step(apitype.OpCreateReplacement, queue, keys("fifoQueue")),
		step(apitype.OpReplace, queue, keys("fifoQueue")),
		step(apitype.OpDeleteReplaced, queue),
		step(apitype.OpDelete, logs, retained()),
		step(apitype.OpUpdate, vector, fields("dimension")),
	}
	// Whatever the map says
	parts := []Part{
		{URN: queue, Key: "queue", Replaced: "A new queue."},
	}
	assert.ElementsMatch(t, [][2]string{
		{"update EmbeddingsTable.sst.aws.VectorTable", `Its "dimension" changes, which empties it.`},
		{"delete ApiLogGroup", "No component's state map releases it. It holds data. The cloud keeps it, but the app would lose it."},
		{"replace JobsQueue", "It holds data. Changed: fifoQueue."},
	}, problems(Check(steps, parts)))
}

func TestKindOf(t *testing.T) {
	assert.Equal(t, "sst.aws.VectorTable", kindOf(vector))
	assert.Equal(t, "", kindOf(bucket))
	assert.Equal(t, "", kindOf("no address"))
	assert.True(t, holdsData("pulumi-nodejs:dynamic:Resource", vector))
	assert.False(t, holdsData("pulumi-nodejs:dynamic:Resource", oldFiles))
}

func inputs(old, new map[string]any) stepOption {
	return func(s *apitype.StepEventMetadata) {
		s.Old.Inputs, s.New.Inputs = old, new
	}
}

func withID(id string) stepOption {
	return func(s *apitype.StepEventMetadata) {
		for _, state := range []*apitype.StepEventStateMetadata{s.Old, s.New} {
			if state != nil {
				state.ID = id
			}
		}
	}
}

// What it was decides as much as what it is
func TestDataBySideItWas(t *testing.T) {
	// The 4.x table, moved to a part of another type, which the map says is
	// replaced
	table := urn("sst:aws:Vector$sst:aws:VectorTable", "EmbeddingsTable")
	replace := []apitype.StepEventMetadata{
		step(apitype.OpCreateReplacement, table, from(vector)),
		step(apitype.OpReplace, table, from(vector)),
		step(apitype.OpDeleteReplaced, vector),
	}
	for i := range replace[:2] {
		replace[i].Old.Type = "pulumi-nodejs:dynamic:Resource"
	}
	assert.Equal(t, [][2]string{
		{"replace EmbeddingsTable", "It holds data."},
	}, problems(Check(replace, []Part{{URN: table, Key: "table", Replaced: "A new table."}})))

	// Moved there and updated
	update := step(apitype.OpUpdate, table, from(vector), fields("dimension"))
	assert.Equal(t, [][2]string{
		{"update EmbeddingsTable", `Its "dimension" changes, which empties it.`},
	}, problems(Check([]apitype.StepEventMetadata{update}, nil)))
}

func TestReleasingData(t *testing.T) {
	oldLogs := urn("sst:aws:Function$aws:cloudwatch/logGroup:LogGroup", "ApiLogGroup")
	newLogs := urn("sst:aws:Function$aws:cloudwatch/logGroup:LogGroup", "ApiLogs")
	part := []Part{{URN: newLogs, Key: "logs", Releases: []string{oldLogs}}}

	// Created again, empty
	r := Check([]apitype.StepEventMetadata{
		step(apitype.OpDelete, oldLogs, withID("/aws/lambda/api")),
		step(apitype.OpCreate, newLogs),
	}, part)
	assert.Equal(t, [][2]string{
		{"delete ApiLogGroup", "It holds data, and ApiLogs, in its place, doesn't adopt it by its id."},
	}, problems(r))

	// Adopted by its id
	r = Check([]apitype.StepEventMetadata{
		step(apitype.OpDelete, oldLogs, withID("/aws/lambda/api")),
		step(apitype.OpImport, newLogs, withID("/aws/lambda/api")),
	}, part)
	assert.True(t, r.OK())
	assert.Len(t, r.Released, 1)

	// Another one adopted
	r = Check([]apitype.StepEventMetadata{
		step(apitype.OpDelete, oldLogs, withID("/aws/lambda/api")),
		step(apitype.OpImport, newLogs, withID("/aws/lambda/other")),
	}, part)
	assert.False(t, r.OK())
}

func TestReleaseThatDoesntHappen(t *testing.T) {
	// The map says the files are released, but the old ones are kept, so
	// nothing is in their place
	r := Check([]apitype.StepEventMetadata{
		step(apitype.OpSame, oldFiles),
		step(apitype.OpCreate, newFiles, inTheCloud()),
	}, []Part{{URN: newFiles, Key: "files", Releases: []string{oldFiles}}})
	assert.Equal(t, [][2]string{
		{"create SiteFiles", "No component's state map says it's new. If it's new in sst.config.ts, add it after the move."},
	}, problems(r))
}

func TestUpdatesThatLoseData(t *testing.T) {
	logGroup := func(old, new map[string]any) []apitype.StepEventMetadata {
		return []apitype.StepEventMetadata{step(apitype.OpUpdate, logs, fields("retentionInDays"), inputs(old, new))}
	}
	shorter := `Its "retentionInDays" changes, which can keep what it holds for less time.`
	cases := []struct {
		old, new map[string]any
		loses    bool
	}{
		{map[string]any{"retentionInDays": 30.0}, map[string]any{"retentionInDays": 7.0}, true},
		{map[string]any{"retentionInDays": 7.0}, map[string]any{"retentionInDays": 30.0}, false},
		// Not set, and 0, are for ever
		{map[string]any{}, map[string]any{"retentionInDays": 30.0}, true},
		{map[string]any{"retentionInDays": 30.0}, map[string]any{"retentionInDays": 0.0}, false},
		{map[string]any{"retentionInDays": 30.0}, map[string]any{}, false},
		// Not known in the preview
		{map[string]any{"retentionInDays": 30.0}, map[string]any{"retentionInDays": "04da6b54-80e4-46f7-96ec-b56ff0331ba9"}, true},
	}
	for _, c := range cases {
		r := Check(logGroup(c.old, c.new), nil)
		if c.loses {
			assert.Equal(t, [][2]string{{"update ApiLogGroup", shorter}}, problems(r), "%v to %v", c.old, c.new)
		} else {
			assert.True(t, r.OK(), "%v to %v", c.old, c.new)
		}
	}

	// A queue keeps messages for 4 days when it isn't set
	r := Check([]apitype.StepEventMetadata{
		step(apitype.OpUpdate, queue, fields("messageRetentionSeconds"), inputs(map[string]any{}, map[string]any{"messageRetentionSeconds": 60.0})),
	}, nil)
	assert.Len(t, r.Problems, 1)

	// Which items expire
	table := urn("sst:aws:Dynamo$aws:dynamodb/table:Table", "ItemsTable")
	r = Check([]apitype.StepEventMetadata{step(apitype.OpUpdate, table, fields("ttl.enabled"))}, nil)
	assert.Equal(t, [][2]string{
		{"update ItemsTable", `Its "ttl" changes, which changes what expires.`},
	}, problems(r))
}

func TestExpiry(t *testing.T) {
	rules := urn("sst:aws:Bucket$aws:s3/bucketLifecycleConfiguration:BucketLifecycleConfiguration", "FilesLifecycle")
	steps := []apitype.StepEventMetadata{step(apitype.OpCreate, rules)}
	// Whatever the map says
	r := Check(steps, []Part{{URN: rules, Key: "lifecycle", Added: true}})
	assert.Equal(t, [][2]string{{"create FilesLifecycle", "It sets when what's stored expires."}}, problems(r))

	r = Check([]apitype.StepEventMetadata{step(apitype.OpUpdate, rules, fields("rules"))}, nil)
	assert.Equal(t, [][2]string{{"update FilesLifecycle", "It changes when what's stored expires."}}, problems(r))

	// Kept as it is, at a new address
	r = Check([]apitype.StepEventMetadata{step(apitype.OpSame, rules, from(rules+"Old"))}, nil)
	assert.True(t, r.OK())
}

func TestLeftOverFromAnEarlierReplace(t *testing.T) {
	// An earlier deploy replaced these, and couldn't delete the old ones
	pending := func(address string) apitype.StepEventMetadata {
		s := step(apitype.OpDeleteReplaced, address)
		s.Old.Delete = true
		return s
	}
	r := Check([]apitype.StepEventMetadata{
		step(apitype.OpSame, code),
		pending(code),
		step(apitype.OpSame, bucket),
		pending(bucket),
	}, nil)
	assert.Equal(t, [][2]string{
		{"delete FilesBucket", "An earlier deploy replaced it, and a deploy now deletes it. It holds data."},
	}, problems(r))
	assert.Len(t, r.Kept, 2)
	assert.Len(t, r.Left, 1)
}

func TestLookingUpWhatsManaged(t *testing.T) {
	s := step(apitype.OpRead, bucket)
	s.Old.External = false
	assert.Equal(t, [][2]string{
		{"read FilesBucket", "The app manages it now, and would only look it up."},
	}, problems(Check([]apitype.StepEventMetadata{s}, nil)))
}

func TestSeen(t *testing.T) {
	logical := func(s apitype.StepEventMetadata) apitype.StepEventMetadata {
		s.Logical = true
		return s
	}
	steps := []apitype.StepEventMetadata{
		logical(step(apitype.OpSame, bucket)),
		logical(step(apitype.OpDelete, wrapper)),
		logical(step(apitype.OpCreate, userBucket)),
		// Reported again with its outputs
		logical(step(apitype.OpCreate, userBucket)),
		// A replace counts once
		step(apitype.OpCreateReplacement, code),
		logical(step(apitype.OpReplace, code)),
		step(apitype.OpDeleteReplaced, code),
		// Default providers, which the summary doesn't count: SST's own,
		// first used, and one nothing uses any more
		logical(step(apitype.OpCreate, "urn:pulumi:dev::app::pulumi:providers:sst::default")),
		logical(step(apitype.OpDelete, "urn:pulumi:dev::app::pulumi:providers:command::default_1_2_1")),
	}
	summary := &apitype.SummaryEvent{ResourceChanges: map[apitype.OpType]int{
		apitype.OpSame: 4, apitype.OpDelete: 1, apitype.OpCreate: 1, apitype.OpReplace: 1,
	}}
	assert.NoError(t, Seen(steps, summary))

	// A delete that wasn't seen
	summary.ResourceChanges[apitype.OpDelete] = 2
	assert.EqualError(t, Seen(steps, summary), "not every step of the preview was seen: [1 of 2 delete]")
	assert.Error(t, Seen(steps, nil))
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

	// Another of SST's resources isn't one
	waiter := urn("sst:aws:CDN$pulumi-nodejs:dynamic:Resource", "WebWaiter.sst.aws.DistributionDeploymentWaiter")
	assert.Len(t, problems(Check([]apitype.StepEventMetadata{step(apitype.OpDelete, waiter)}, nil)), 1)
}
