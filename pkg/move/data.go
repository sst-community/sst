package move

import (
	"fmt"
	"strings"

	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
)

// The types of resources that hold data (goals.md, goal 2): a move never
// deletes, replaces or empties one, whatever a state map says.
var dataTypes = map[string]bool{
	// Buckets and tables
	"aws:s3/bucket:Bucket":         true,
	"aws:s3/bucketV2:BucketV2":     true,
	"aws:dynamodb/table:Table":     true,
	"aws:kinesis/stream:Stream":    true,
	"aws:opensearch/domain:Domain": true,
	// Databases and caches
	"aws:rds/instance:Instance":                         true,
	"aws:rds/cluster:Cluster":                           true,
	"aws:dsql/cluster:Cluster":                          true,
	"aws:elasticache/cluster:Cluster":                   true,
	"aws:elasticache/replicationGroup:ReplicationGroup": true,
	"aws:elasticache/serverlessCache:ServerlessCache":   true,
	// File systems, users and messages
	"aws:efs/fileSystem:FileSystem":         true,
	"aws:cognito/userPool:UserPool":         true,
	"aws:cognito/identityPool:IdentityPool": true,
	"aws:sqs/queue:Queue":                   true,
	// Backups, which `Dsql` keeps in a vault
	"aws:backup/vault:Vault": true,
	// Logs
	"aws:cloudwatch/logGroup:LogGroup": true,
	// The secrets and generated passwords a database or a cache uses
	"random:index/randomPassword:RandomPassword":     true,
	"aws:secretsmanager/secret:Secret":               true,
	"aws:secretsmanager/secretVersion:SecretVersion": true,
	// The key a 4.x `Auth` signs tokens with: a new one signs everyone out
	"tls:index/privateKey:PrivateKey": true,
	// Cloudflare's
	"cloudflare:index/r2Bucket:R2Bucket":                     true,
	"cloudflare:index/d1Database:D1Database":                 true,
	"cloudflare:index/workersKvNamespace:WorkersKvNamespace": true,
	"cloudflare:index/queue:Queue":                           true,
}

// SST's own provider resources that hold data, by the kind they add to their
// name ("MyVectorTable.sst.aws.VectorTable"), and the inputs that empty one
// when they change. In 4.x a `Vector`'s table is dropped and created again
// when its dimension changes (VectorTable.Update).
var dataKinds = map[string][]string{
	"sst.aws.VectorTable": {"dimension"},
}

// SST 4's provider resources that a move adopts, by the kind each adds to its
// name: what takes the place of one imports it by its id, as its create would
// make a second one in the cloud and leave the first behind
// (docs/plans/v5-rewrite/reference.md, SST's provider resources).
var adoptKinds = map[string]bool{
	"sst.aws.OriginAccessControl": true,
}

// Adoptable is the id of each of SST 4's provider resources in a state that a
// move adopts, by its name, which the program is told while the stage moves:
// the part in its place imports it. A name two of them share is left out, so
// neither is adopted, and the check refuses the move.
func Adoptable(resources []apitype.ResourceV3) map[string]string {
	ids := map[string]string{}
	shared := map[string]bool{}
	for _, res := range resources {
		if !res.Custom || res.Delete || res.Type != dynamicType || res.ID == "" || !adoptKinds[kindOf(string(res.URN))] {
			continue
		}
		name := res.URN.Name()
		if _, ok := ids[name]; ok {
			shared[name] = true
		}
		ids[name] = string(res.ID)
	}
	for name := range shared {
		delete(ids, name)
	}
	return ids
}

// The type of SST 4's provider resources: Pulumi's dynamic resources
const dynamicType = "pulumi-nodejs:dynamic:Resource"

// SST 4's lookups, made with resources, by the kind each adds to its name.
// SST 5 makes them with functions. Nothing in the cloud is behind one, so a
// move releases it: it leaves the state without its delete being called, so
// the move doesn't need what ran SST 4's lookups, which goes with SST 4's
// components (docs/plans/v5-rewrite/reference.md, SST's provider resources).
var lookupKinds = map[string]bool{
	"sst.aws.HostedZoneLookup":  true,
	"sst.cloudflare.ZoneLookup": true,
}

// What sets when what a bucket stores expires. A move doesn't create one or
// change it: set it after the move.
var expiryTypes = map[string]bool{
	"aws:s3/bucketLifecycleConfiguration:BucketLifecycleConfiguration":     true,
	"aws:s3/bucketLifecycleConfigurationV2:BucketLifecycleConfigurationV2": true,
}

// Inputs that lose data when they change, by type
var expiryFields = map[string][]string{
	// Which items expire
	"aws:dynamodb/table:Table": {"ttl"},
	// Which objects expire
	"aws:s3/bucket:Bucket":     {"lifecycleRules"},
	"aws:s3/bucketV2:BucketV2": {"lifecycleRules"},
}

// How long something keeps what it holds, which a move can lengthen but not
// shorten
type retention struct {
	field string
	// What it is when it isn't set, if that's known
	unset *float64
	// Whether 0 means for ever
	zeroIsForever bool
}

func days(n float64) *float64 { return &n }

var retentions = map[string][]retention{
	"aws:cloudwatch/logGroup:LogGroup":                  {{field: "retentionInDays", unset: days(0), zeroIsForever: true}},
	"aws:sqs/queue:Queue":                               {{field: "messageRetentionSeconds", unset: days(345600)}},
	"aws:kinesis/stream:Stream":                         {{field: "retentionPeriod", unset: days(24)}},
	"aws:rds/instance:Instance":                         {{field: "backupRetentionPeriod"}},
	"aws:rds/cluster:Cluster":                           {{field: "backupRetentionPeriod"}},
	"aws:elasticache/cluster:Cluster":                   {{field: "snapshotRetentionLimit", unset: days(0)}},
	"aws:elasticache/replicationGroup:ReplicationGroup": {{field: "snapshotRetentionLimit", unset: days(0)}},
	"aws:elasticache/serverlessCache:ServerlessCache":   {{field: "snapshotRetentionLimit", unset: days(0)}},
}

// What an update would lose: each input that changes so that something is
// emptied, expires, or is kept for less time
func losses(step apitype.StepEventMetadata, fields []string) []string {
	typ, urns := step.Type, []string{step.URN}
	var old, new map[string]any
	if step.Old != nil {
		urns = append(urns, step.Old.URN)
		old = step.Old.Inputs
	}
	if step.New != nil {
		urns = append(urns, step.New.URN)
		new = step.New.Inputs
	}
	found := []string{}
	add := func(why string) {
		if !contains(found, why) {
			found = append(found, why)
		}
	}
	for _, urn := range urns {
		for _, field := range emptiedBy(urn) {
			if contains(fields, field) {
				add(fmt.Sprintf("Its %q changes, which empties it.", field))
			}
		}
	}
	if expiryTypes[typ] && len(fields) > 0 {
		add("It changes when what's stored expires.")
	}
	for _, field := range expiryFields[typ] {
		if contains(fields, field) {
			add(fmt.Sprintf("Its %q changes, which changes what expires.", field))
		}
	}
	for _, r := range retentions[typ] {
		if !contains(fields, r.field) {
			continue
		}
		before, knownBefore := keptFor(old, r)
		after, knownAfter := keptFor(new, r)
		if !knownBefore || !knownAfter || after < before {
			add(fmt.Sprintf("Its %q changes, which can keep what it holds for less time.", r.field))
		}
	}
	return found
}

// How long a retention keeps things for, with for ever as the largest number
func keptFor(inputs map[string]any, r retention) (float64, bool) {
	value, set := inputs[r.field]
	var n float64
	switch {
	case !set || value == nil:
		if r.unset == nil {
			return 0, false
		}
		n = *r.unset
	default:
		number, ok := value.(float64)
		if !ok {
			// Not known in the preview
			return 0, false
		}
		n = number
	}
	if n == 0 && r.zeroIsForever {
		return 1e18, true
	}
	return n, true
}

func holdsData(typ, urn string) bool {
	if dataTypes[typ] {
		return true
	}
	_, ok := dataKinds[kindOf(urn)]
	return ok
}

// The inputs of a resource that empty it when they change
func emptiedBy(urn string) []string {
	return dataKinds[kindOf(urn)]
}

// The kind one of SST's provider resources adds to the end of its name, as
// "sst.aws.VectorTable". The name before it may have ".sst." in it too: SST
// 4's Cloudflare lookups put a domain in it, like "docs.sst.dev".
func kindOf(urn string) string {
	name := urn[strings.LastIndex(urn, "::")+2:]
	at := strings.LastIndex(name, ".sst.")
	if at == -1 {
		return ""
	}
	return name[at+1:]
}
