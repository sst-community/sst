package eject

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource/sig"
)

func readFixture(t *testing.T) []byte {
	t.Helper()
	data, err := os.ReadFile("testdata/state.json")
	if err != nil {
		t.Fatal(err)
	}
	return data
}

var fixtureOptions = Options{Project: "shop", Date: "2026-11-12"}

// build ejects the fixture as the "dev" stack, and the other states given
func build(t *testing.T, shown []byte, more ...StackState) (*Plan, error) {
	t.Helper()
	return Build(append([]StackState{{Stack: "dev", Shown: shown}}, more...), fixtureOptions)
}

// editFixture changes the fixture's resources before it's read
func editFixture(t *testing.T, edit func(resources []map[string]any) []map[string]any) []byte {
	t.Helper()
	var parsed map[string]any
	if err := json.Unmarshal(readFixture(t), &parsed); err != nil {
		t.Fatal(err)
	}
	deployment := parsed["deployment"].(map[string]any)
	var resources []map[string]any
	for _, r := range deployment["resources"].([]any) {
		resources = append(resources, r.(map[string]any))
	}
	deployment["resources"] = edit(resources)
	data, err := json.Marshal(parsed)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestBuildWritesTheComponentsAsPulumisResources(t *testing.T) {
	plan, err := build(t, readFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	module := plan.Module
	for _, want := range []string{
		// SST's components, with their types and names, so the URNs stay
		`const files = new pulumi.ComponentResource("sst:aws:Bucket", "Files");`,
		`const api = new pulumi.ComponentResource("sst:aws:Function", "Api");`,
		"// Files, SST's sst:aws:Bucket, made at infra/storage.ts:3",
		// A part, with the inputs the provider didn't fill in itself
		"const filesBucket = new aws.s3.Bucket(\n    \"FilesBucket\",\n    { bucket: \"shop-dev-filesbucket-abcdefgh\", forceDestroy: true },\n    { parent: files, ignoreChanges: [\"bucket\"] },\n  );",
		// References to what a part depends on
		"bucket: filesBucket.bucket",
		"role: apiRole.arn",
		"logGroup: apiLogGroup.name",
		"function: apiFunction.name",
		// in a policy too, written as the value it's made from
		"policy: pulumi.jsonStringify(",
		"pulumi.interpolate`${filesBucket.arn}/*`",
		"}, undefined, 2),",
		// A string that's JSON with nothing to refer to
		`assumeRolePolicy: JSON.stringify({ Version: "2012-10-17" })`,
		// What the state keeps of its options
		"deletedWith: filesBucket",
		"dependsOn: [filesPublicAccessBlock]",
		"protect: true",
		`customTimeouts: { create: "600s", delete: "90.5s" }`,
		// A provider of the program's, given by name
		"export function ejected(program: {\n  /** The program's own providers SST's components were given. */\n  providers: {\n    east: pulumi.ProviderResource;\n  };\n})",
		"provider: program.providers.east",
		// Secrets, read from the config
		`variables: config.requireSecretObject<any>("ApiFunction.environment.variables")`,
		`s3Key: config.requireSecret("ApiFunction.s3Key")`,
		`const config = new pulumi.Config("sst-ejected");`,
		// The build to switch to
		`...nodeBuild("functions/api.handler") from ./sst-ejected-build`,
		// The stack it's from
		`if (pulumi.getStack() !== "dev")`,
		// What it returns
		"    Files: {\n      bucket: filesBucket,\n      publicAccessBlock: filesPublicAccessBlock,\n      policy: filesPolicy,\n    },",
		"function: apiFunction,",
	} {
		if !strings.Contains(module, want) {
			t.Errorf("the module has no\n%s\nin\n%s", want, module)
		}
	}
	for _, unwanted := range []string{
		"__defaults", "tagsAll", "maxSessionDuration", "reservedConcurrentExecutions", "skipDestroy",
		`region: "us-west-2"`, `region: "us-east-1"`, "description",
		// What leaves the state isn't written
		"ApiCode", "LambdaEncryptionKey", "FilesUpload", "LinkRef", "Readme",
		// and no secret is in the code
		"c2VjcmV0LWtleQ", "assets/Api-code",
	} {
		if strings.Contains(module, unwanted) {
			t.Errorf("the module has %q", unwanted)
		}
	}
	// Each policy keeps its spacing: the bucket's indented, the role's not
	if strings.Count(module, "pulumi.jsonStringify(") != 2 || strings.Count(module, "}, undefined, 2),") != 1 {
		t.Error("the policies aren't written with their spacing")
	}
	// A component's parts come after what they refer to, in another
	// component too
	if strings.Index(module, "const filesBucket") > strings.Index(module, "const apiRole") {
		t.Error("ApiRole is made before the bucket its policy refers to")
	}

	if plan.Build == "" {
		t.Error("no build for the Node.js function")
	}
	if len(plan.Stacks) != 1 {
		t.Fatalf("stacks %v", plan.Stacks)
	}
	stack := plan.Stacks[0]
	secrets := map[string]string{}
	for _, setting := range stack.Config {
		if !setting.Secret {
			t.Errorf("%s isn't a secret", setting.Key)
		}
		secrets[setting.Key] = setting.Value
	}
	wantSecrets := map[string]string{
		// with what addEnvironment added
		"sst-ejected:ApiFunction.environment.variables": `{"LATE":"https://example.com","SST_KEY":"c2VjcmV0LWtleQ==","SST_KEY_FILE":"resource.enc","SST_RESOURCE_App":"{\"name\":\"shop\",\"stage\":\"dev\"}"}`,
		"sst-ejected:ApiFunction.s3Key":                 "assets/Api-code-1234.zip",
	}
	if len(secrets) != len(wantSecrets) {
		t.Errorf("secrets %v", secrets)
	}
	for key, value := range wantSecrets {
		if secrets[key] != value {
			t.Errorf("secret %s is %q, not %q", key, secrets[key], value)
		}
	}

	var removed []string
	for _, urn := range stack.Remove {
		removed = append(removed, urn.Name())
	}
	if got, want := strings.Join(removed, " "), "sst LambdaEncryptionKey FilesLinkRef FilesUpload ApiCode ApiEnvironmentUpdate Worker default_4_21_2"; got != want {
		t.Errorf("removes %s, not %s", got, want)
	}
	if len(plan.Components) != 2 || plan.Components[1].MadeAt != "index.ts:6" {
		t.Errorf("components %+v", plan.Components)
	}
	if got := strings.Join(plan.Uses, "; "); got != "Readme uses FilesBucket" {
		t.Errorf("uses %q", got)
	}
	if got := strings.Join(stack.Updates, "; "); got != "ApiFunction's environment gets LATE, which addEnvironment added after it was made" {
		t.Errorf("updates %q", got)
	}

	// The same state writes the same module
	again, err := build(t, readFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	if again.Module != module {
		t.Error("the module isn't the same twice")
	}
}

func TestBuildRefuses(t *testing.T) {
	for _, tc := range []struct {
		name  string
		edit  func([]map[string]any) []map[string]any
		error string
	}{
		{
			name: "a stack sst dev deployed",
			edit: func(resources []map[string]any) []map[string]any {
				for _, r := range resources {
					if r["type"] == "sst:aws:Function" {
						r["outputs"].(map[string]any)["_sst"].(map[string]any)["function"].(map[string]any)["dev"] = true
					}
				}
				return resources
			},
			error: `The "dev" stack was last deployed by sst dev`,
		},
		{
			name: "one of SST's own resources it doesn't take out yet",
			edit: func(resources []map[string]any) []map[string]any {
				for _, r := range resources {
					if r["type"] == "sst:aws:BucketFiles" {
						r["type"] = "sst:aws:OriginAccessControl"
					}
				}
				return resources
			},
			error: "FilesUpload (sst:aws:OriginAccessControl) is one of SST's own resources",
		},
		{
			name: "a file it doesn't write",
			edit: func(resources []map[string]any) []map[string]any {
				for _, r := range resources {
					if strings.HasSuffix(r["urn"].(string), "::FilesPolicy") {
						r["inputs"].(map[string]any)["policy"] = map[string]any{"4dabf18193072939515e22adb298388d": "c44067f5952c0a294b673a41bacd8c17", "path": "policy.json"}
					}
				}
				return resources
			},
			error: "FilesPolicy takes a file at FilesPolicy.policy",
		},
		{
			name: "a resource waiting to be deleted",
			edit: func(resources []map[string]any) []map[string]any {
				for _, r := range resources {
					if strings.HasSuffix(r["urn"].(string), "::FilesBucket") {
						r["delete"] = true
					}
				}
				return resources
			},
			error: "has FilesBucket waiting to be deleted",
		},
		{
			name: "none of SST's components",
			edit: func(resources []map[string]any) []map[string]any {
				return resources[:1]
			},
			error: "has none of SST's components",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := build(t, editFixture(t, tc.edit))
			if err == nil || !strings.Contains(err.Error(), tc.error) {
				t.Fatalf("got %v, want %q", err, tc.error)
			}
		})
	}
}

func TestWithoutResources(t *testing.T) {
	data := readFixture(t)
	plan, err := build(t, data)
	if err != nil {
		t.Fatal(err)
	}
	remove := map[resource.URN]bool{}
	for _, urn := range plan.Stacks[0].Remove {
		remove[urn] = true
	}
	edited, err := withoutResources(data, remove, nil)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := readExport(edited)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := len(parsed.Deployment.Resources), 21-len(plan.Stacks[0].Remove); got != want {
		t.Errorf("%d resources left, not %d", got, want)
	}
	for _, r := range parsed.Deployment.Resources {
		if remove[r.URN] {
			t.Errorf("%s is still there", r.URN)
		}
		for _, urn := range r.Dependencies {
			if remove[urn] {
				t.Errorf("%s still depends on %s", r.name(), urn.Name())
			}
		}
		for key, urns := range r.PropertyDependencies {
			for _, urn := range urns {
				if remove[urn] {
					t.Errorf("%s.%s still depends on %s", r.name(), key, urn.Name())
				}
			}
		}
		if r.name() == "ApiFunction" {
			if len(r.Dependencies) != 2 || len(r.PropertyDependencies["s3Key"]) != 0 || r.PropertyDependencies["s3Key"] == nil {
				t.Errorf("ApiFunction's dependencies: %v %v", r.Dependencies, r.PropertyDependencies)
			}
			// The rest is kept as it was, its secrets too
			secret := r.Inputs["s3Key"].(map[string]any)
			if secret["plaintext"] != `"assets/Api-code-1234.zip"` {
				t.Errorf("s3Key is %v", secret)
			}
		}
	}
	if !strings.Contains(string(edited), `"secrets_providers":{"type":"passphrase","state":{"salt":"v1:test"}}`) {
		t.Errorf("the secrets provider isn't kept: %s", edited[:300])
	}

	// A resource left in one that leaves isn't
	var urn resource.URN
	for _, r := range parsed.Deployment.Resources {
		if r.name() == "Files" {
			urn = r.URN
		}
	}
	if _, err := withoutResources(data, map[resource.URN]bool{urn: true}, nil); err == nil || !strings.Contains(err.Error(), "FilesBucket is in Files") {
		t.Errorf("got %v", err)
	}
}

func TestJSONText(t *testing.T) {
	for _, tc := range []struct {
		text   string
		indent string
		ok     bool
	}{
		{`{"a":1,"b":[true,null,"x"]}`, "", true},
		{"{\n  \"b\": 1,\n  \"a\": {\n    \"c\": []\n  }\n}", "  ", true},
		{"{\n    \"a\": \"x\"\n}", "    ", true},
		{"[\n\t1\n]", "\t", true},
		// Not as JSON.stringify writes it
		{`{"a": 1}`, "", false},
		{`{"a":1.0}`, "", false},
		// A key JavaScript puts first
		{`{"b":1,"2":2}`, "", false},
		{`"just a string"`, "", false},
	} {
		parsed, ok := parseJSONText(tc.text)
		if ok {
			var indent string
			indent, ok = jsonIndent(tc.text, parsed)
			if ok && indent != tc.indent {
				t.Errorf("%q: indent %q, not %q", tc.text, indent, tc.indent)
			}
		}
		if ok != tc.ok {
			t.Errorf("%q: %v, not %v", tc.text, ok, tc.ok)
		}
	}
}

func TestStrings(t *testing.T) {
	if got := tsString("a \"b\" <c>", ""); got != `"a \"b\" <c>"` {
		t.Error(got)
	}
	if got := tsString("one\ntwo `x` ${y} \\z\n", ""); got != "`one\ntwo \\`x\\` \\${y} \\\\z\n`" {
		t.Error(got)
	}
	for name, want := range map[string]string{
		"ApiFunction":               "apiFunction",
		"AwsProvider.sst.us-east-1": "awsProviderSstUsEast1",
		"Function":                  "function_",
		"3d":                        "_3d",
	} {
		if got := varName(name); got != want {
			t.Errorf("varName(%q) = %q, not %q", name, got, want)
		}
	}
	if got := partKey("WebAssets", "WebAssetsBucket"); got != "bucket" {
		t.Error(got)
	}
	if got := partKey("Api", "ApiFunction"); got != "function" {
		t.Error(got)
	}
}

// prodFixture is the fixture as another stack has it: its own names, a
// function given a role that isn't the component's, and a queue only it has
func prodFixture(t *testing.T) []byte {
	t.Helper()
	text := strings.NewReplacer("dev::shop", "prod::shop", "Stack::shop-dev", "Stack::shop-prod", "shop-dev-", "shop-prod-", `\"stage\\\":\\\"dev`, `\"stage\\\":\\\"prod`).Replace(string(readFixture(t)))
	var parsed map[string]any
	if err := json.Unmarshal([]byte(text), &parsed); err != nil {
		t.Fatal(err)
	}
	deployment := parsed["deployment"].(map[string]any)
	resources := deployment["resources"].([]any)
	for _, r := range resources {
		r := r.(map[string]any)
		if strings.HasSuffix(r["urn"].(string), "::ApiFunction") {
			r["inputs"].(map[string]any)["role"] = "arn:aws:iam::123456789012:role/external"
		}
	}
	stack := "urn:pulumi:prod::shop::pulumi:pulumi:Stack::shop-prod"
	resources = append(resources,
		map[string]any{"urn": "urn:pulumi:prod::shop::sst:aws:Queue::Extra", "custom": false, "type": "sst:aws:Queue", "parent": stack},
		map[string]any{
			"urn": "urn:pulumi:prod::shop::sst:aws:Queue$aws:sqs/queue:Queue::ExtraQueue", "custom": true, "id": "https://sqs/extra",
			"type": "aws:sqs/queue:Queue", "parent": "urn:pulumi:prod::shop::sst:aws:Queue::Extra",
			"provider": "urn:pulumi:prod::shop::pulumi:providers:aws::default_7_54_0::0bbb",
			"inputs":   map[string]any{"name": "shop-prod-ExtraQueue-abcdefgh", "visibilityTimeoutSeconds": 30},
			"outputs":  map[string]any{"arn": "arn:aws:sqs:us-west-2:123456789012:shop-prod-ExtraQueue-abcdefgh", "url": "https://sqs/extra"},
		},
	)
	deployment["resources"] = resources
	data, err := json.Marshal(parsed)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestBuildWritesOneModuleForEveryStack(t *testing.T) {
	plan, err := build(t, readFixture(t), StackState{Stack: "acme/shop/prod", Shown: prodFixture(t)})
	if err != nil {
		t.Fatal(err)
	}
	module := plan.Module
	for _, want := range []string{
		"from the state of the \"dev\" and \"prod\" stacks of shop.",
		`if (!["dev", "prod"].includes(pulumi.getStack()))`,
		// What's the same in both, as it is
		"bucket: filesBucket.bucket",
		"forceDestroy: true",
		"pulumi.interpolate`${filesBucket.arn}/*`",
		// A plain value each stack has its own of, from its config
		`bucket: config.require("FilesBucket.bucket")`,
		`name: config.require("ApiRole.name")`,
		// A secret, from each stack's config
		`variables: config.requireSecretObject<any>("ApiFunction.environment.variables")`,
		// A value that's a reference in one stack and not in the other
		"role: byStack({\n        dev: () => apiRole.arn,\n        prod: () => \"arn:aws:iam::123456789012:role/external\",\n      }),",
		"function byStack<T>(values: Record<string, () => T>): T {",
		// What only one stack has
		"function onStack(...stacks: string[]) {",
		"// Extra, SST's sst:aws:Queue, in the \"prod\" stack",
		"const extra = onStack(\"prod\")\n    ? new pulumi.ComponentResource(\"sst:aws:Queue\", \"Extra\")\n    : undefined;",
		"const extraQueue = onStack(\"prod\")\n    ? new aws.sqs.Queue(\n",
		"{ parent: extra! }",
		`name: "shop-prod-ExtraQueue-abcdefgh"`,
		"Extra: { queue: extraQueue },",
	} {
		if !strings.Contains(module, want) {
			t.Errorf("the module has no\n%s\nin\n%s", want, module)
		}
	}

	if len(plan.Stacks) != 2 || plan.Stacks[1].Stack != "acme/shop/prod" || plan.Stacks[1].Name != "prod" {
		t.Fatalf("stacks %+v", plan.Stacks)
	}
	settings := func(stack *StackPlan) map[string]Setting {
		result := map[string]Setting{}
		for _, setting := range stack.Config {
			result[setting.Key] = setting
		}
		return result
	}
	dev, prod := settings(plan.Stacks[0]), settings(plan.Stacks[1])
	if got := dev["sst-ejected:FilesBucket.bucket"]; got.Value != "shop-dev-filesbucket-abcdefgh" || got.Secret {
		t.Errorf("dev's bucket: %+v", got)
	}
	if got := prod["sst-ejected:FilesBucket.bucket"]; got.Value != "shop-prod-filesbucket-abcdefgh" || got.Secret {
		t.Errorf("prod's bucket: %+v", got)
	}
	if got := prod["sst-ejected:ApiFunction.environment.variables"]; !got.Secret || !strings.Contains(got.Value, `\"stage\":\"prod\"`) {
		t.Errorf("prod's environment: %+v", got)
	}
	if len(dev) != len(prod) {
		t.Errorf("dev has %d settings and prod %d", len(dev), len(prod))
	}
	if got := len(plan.Stacks[1].Remove); got != len(plan.Stacks[0].Remove) {
		t.Errorf("prod has %d to take out", got)
	}
	if strings.Contains(module, "shop-dev-") {
		t.Error("the module has dev's names in it")
	}
}

func TestBuildLeavesOutAStackWithoutComponents(t *testing.T) {
	empty := []byte(`{"version":3,"deployment":{"resources":[{"urn":"urn:pulumi:old::shop::pulumi:pulumi:Stack::shop-old","custom":false,"type":"pulumi:pulumi:Stack"}]}}`)
	plan, err := build(t, readFixture(t), StackState{Stack: "old", Shown: empty})
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Stacks) != 1 || strings.Join(plan.Skipped, " ") != "old" {
		t.Errorf("stacks %v, skipped %v", plan.Stacks, plan.Skipped)
	}
	if !strings.Contains(plan.Module, `if (pulumi.getStack() !== "dev")`) {
		t.Error("the module isn't the dev stack's alone")
	}
}

func TestBuildTakesTheProgramsComponentSSTsIsIn(t *testing.T) {
	data := editFixture(t, func(resources []map[string]any) []map[string]any {
		stack := "urn:pulumi:dev::shop::pulumi:pulumi:Stack::shop-dev"
		shop := "urn:pulumi:dev::shop::acme:index:Shop::Shop"
		inner := "urn:pulumi:dev::shop::acme:index:Shop$sst:aws:Queue::Jobs"
		return append(resources,
			map[string]any{"urn": shop, "custom": false, "type": "acme:index:Shop", "parent": stack},
			map[string]any{"urn": inner, "custom": false, "type": "sst:aws:Queue", "parent": shop},
			map[string]any{
				"urn": "urn:pulumi:dev::shop::acme:index:Shop$sst:aws:Queue$aws:sqs/queue:Queue::JobsQueue", "custom": true, "id": "https://sqs/jobs",
				"type": "aws:sqs/queue:Queue", "parent": inner,
				"provider": "urn:pulumi:dev::shop::pulumi:providers:aws::default_7_54_0::0bbb",
				"inputs":   map[string]any{"name": "shop-dev-JobsQueue-abcdefgh"},
			},
		)
	})
	plan, err := build(t, data)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"  /** The program's own components SST's components are in. */\n  parents: {\n    shop: pulumi.Resource;\n  };\n",
		`const jobs = new pulumi.ComponentResource("sst:aws:Queue", "Jobs", {}, { parent: program.parents.shop });`,
		"{ parent: jobs }",
		"Jobs: { queue: jobsQueue },",
	} {
		if !strings.Contains(plan.Module, want) {
			t.Errorf("the module has no\n%s\nin\n%s", want, plan.Module)
		}
	}
	if got := strings.Join(plan.Takes, "; "); !strings.Contains(got, `parents.shop: the program's "Shop" (acme:index:Shop), which SST's components are in`) {
		t.Errorf("takes %q", got)
	}
	// The program's own component stays the program's
	for _, urn := range plan.Stacks[0].Remove {
		if urn.Name() == "Shop" {
			t.Error("the program's component leaves the state")
		}
	}
}

// assetsFixture is the fixture with the function's code in the program's
// Assets, as SST's components keep it in a Pulumi program, and a source map
// beside it
func assetsFixture(t *testing.T) []byte {
	t.Helper()
	stack := "urn:pulumi:dev::shop::pulumi:pulumi:Stack::shop-dev"
	assets := "urn:pulumi:dev::shop::sst:aws:Assets::Assets"
	bucket := "urn:pulumi:dev::shop::sst:aws:Assets$aws:s3/bucket:Bucket::AssetsBucket"
	provider := "urn:pulumi:dev::shop::pulumi:providers:aws::default_7_54_0::0bbb"
	code := "urn:pulumi:dev::shop::sst:aws:Function$aws:s3/bucketObjectv2:BucketObjectv2::ApiCode"
	return editFixture(t, func(resources []map[string]any) []map[string]any {
		var out []map[string]any
		for _, r := range resources {
			if r["urn"] == code {
				r["id"] = "shop-dev-assetsbucket-abcdefgh/assets/Api-code-1234.zip"
				r["inputs"].(map[string]any)["bucket"] = "shop-dev-assetsbucket-abcdefgh"
				r["propertyDependencies"] = map[string]any{"bucket": []any{bucket}}
				r["dependencies"] = []any{bucket}
			}
			if strings.HasSuffix(r["urn"].(string), "::ApiFunction") {
				r["inputs"].(map[string]any)["s3Bucket"] = "shop-dev-assetsbucket-abcdefgh"
			}
			out = append(out, r)
			if r["urn"] == stack {
				out = append(out,
					map[string]any{"urn": assets, "custom": false, "type": "sst:aws:Assets", "parent": stack},
					map[string]any{
						"urn": bucket, "custom": true, "id": "shop-dev-assetsbucket-abcdefgh",
						"type": "aws:s3/bucket:Bucket", "parent": assets, "provider": provider,
						"inputs":  map[string]any{"bucket": "shop-dev-assetsbucket-abcdefgh", "forceDestroy": true},
						"outputs": map[string]any{"bucket": "shop-dev-assetsbucket-abcdefgh", "id": "shop-dev-assetsbucket-abcdefgh"},
					},
				)
			}
		}
		return append(out, map[string]any{
			"urn":    "urn:pulumi:dev::shop::sst:aws:Function$aws:s3/bucketObjectv2:BucketObjectv2::ApiSourcemap0",
			"custom": true, "id": "shop-dev-assetsbucket-abcdefgh/sourcemap/arn/1234.index.mjs.map",
			"type": "aws:s3/bucketObjectv2:BucketObjectv2", "parent": "urn:pulumi:dev::shop::sst:aws:Function::Api", "provider": provider,
			"inputs": map[string]any{
				"bucket": "shop-dev-assetsbucket-abcdefgh",
				"key":    "sourcemap/arn/1234.index.mjs.map",
				"source": map[string]any{sig.Key: sig.AssetSig, "path": "/tmp/index.mjs.map"},
			},
			"propertyDependencies": map[string]any{"bucket": []any{bucket}},
			"dependencies":         []any{bucket},
		})
	})
}

func TestBuildWritesTheProgramsAssets(t *testing.T) {
	plan, err := build(t, assetsFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`const assets = new pulumi.ComponentResource("sst:aws:Assets", "Assets");`,
		`new aws.s3.Bucket(`,
		"forceDestroy: true",
		"Assets: { bucket: assetsBucket },",
		// The code object leaves the state, and the function refers to the
		// bucket it's in
		"s3Bucket: assetsBucket.bucket,",
	} {
		if !strings.Contains(plan.Module, want) {
			t.Errorf("the module has no\n%s\nin\n%s", want, plan.Module)
		}
	}
	reasons := map[string]string{}
	for _, removed := range plan.Stacks[0].Removed {
		reasons[removed.Name] = removed.Why
	}
	for name, want := range map[string]string{
		"ApiCode":       "the code SST built, which stays at s3://shop-dev-assetsbucket-abcdefgh/assets/Api-code-1234.zip while the function points at it: delete it once the function has a build of its own, or it goes with the stack's bucket",
		"ApiSourcemap0": "a source map of SST's build, which stays at s3://shop-dev-assetsbucket-abcdefgh/sourcemap/arn/1234.index.mjs.map until the stack's bucket is deleted",
	} {
		if reasons[name] != want {
			t.Errorf("%s leaves the state as\n%s\nnot\n%s", name, reasons[name], want)
		}
	}
	// The bucket stays the program's
	for _, urn := range plan.Stacks[0].Remove {
		if urn.Name() == "AssetsBucket" || urn.Name() == "Assets" {
			t.Errorf("%s leaves the state", urn.Name())
		}
	}
}

// A database's proxy waits for the role RDS gives it, and a MicroVM's image
// has its old versions deleted after each build: SST's own resources with
// nothing in the cloud, which leave the state
func TestBuildTakesOutTheRoleLookupAndTheImagePrune(t *testing.T) {
	stack := "urn:pulumi:dev::shop::pulumi:pulumi:Stack::shop-dev"
	aws := "urn:pulumi:dev::shop::pulumi:providers:aws::default_7_54_0::0bbb"
	sst := "urn:pulumi:dev::shop::pulumi:providers:sst::sst::0aaa"
	db := "urn:pulumi:dev::shop::sst:aws:Postgres::Db"
	lookup := "urn:pulumi:dev::shop::sst:aws:Postgres$sst:aws:RdsRoleLookup::DbProxyRoleLookup"
	vm := "urn:pulumi:dev::shop::sst:aws:MicroVm::Sandbox"
	data := editFixture(t, func(resources []map[string]any) []map[string]any {
		return append(resources,
			map[string]any{"urn": db, "custom": false, "type": "sst:aws:Postgres", "parent": stack},
			map[string]any{
				"urn": lookup, "custom": true, "id": "lookup", "type": "sst:aws:RdsRoleLookup", "parent": db, "provider": sst,
				"inputs": map[string]any{"name": "AWSServiceRoleForRDS"},
			},
			map[string]any{
				"urn": "urn:pulumi:dev::shop::sst:aws:Postgres$aws:rds/proxy:Proxy::DbProxy", "custom": true, "id": "shop-dev-dbproxy",
				"type": "aws:rds/proxy:Proxy", "parent": db, "provider": aws,
				"inputs":       map[string]any{"name": "shop-dev-dbproxy", "engineFamily": "POSTGRESQL"},
				"dependencies": []any{lookup},
			},
			map[string]any{"urn": vm, "custom": false, "type": "sst:aws:MicroVm", "parent": stack},
			map[string]any{
				"urn": "urn:pulumi:dev::shop::sst:aws:MicroVm$sst:aws:MicrovmImagePrune::SandboxImagePrune", "custom": true,
				"id": "arn:aws:lambda:us-east-1:123456789012:microvm-image:sandbox", "type": "sst:aws:MicrovmImagePrune", "parent": vm, "provider": sst,
				"inputs": map[string]any{"imageArn": "arn:aws:lambda:us-east-1:123456789012:microvm-image:sandbox", "imageVersion": "3", "keep": 3},
			},
			map[string]any{
				"urn": "urn:pulumi:dev::shop::sst:aws:MicroVm$aws:s3/bucketObjectv2:BucketObjectv2::SandboxCode", "custom": true,
				"id": "sst-asset-abc/assets/microvm/sandbox.zip", "type": "aws:s3/bucketObjectv2:BucketObjectv2", "parent": vm, "provider": aws,
				"inputs": map[string]any{
					"bucket": "sst-asset-abc",
					"key":    "assets/microvm/sandbox.zip",
					"source": map[string]any{sig.Key: sig.ArchiveSig, "path": ".sst/artifacts/sandbox.zip"},
				},
			},
		)
	})
	plan, err := build(t, data)
	if err != nil {
		t.Fatal(err)
	}
	reasons := map[string]string{}
	for _, removed := range plan.Stacks[0].Removed {
		reasons[removed.Name] = removed.Why
	}
	for name, want := range map[string]string{
		"DbProxyRoleLookup": "a wait for the role RDS gives a proxy",
		"SandboxImagePrune": "nothing deletes them after the eject",
		"SandboxCode":       "the code the image was built from, which stays at s3://sst-asset-abc/assets/microvm/sandbox.zip while the image points at it",
	} {
		if !strings.Contains(reasons[name], want) {
			t.Errorf("%s leaves the state as %q", name, reasons[name])
		}
	}
	// The proxy stays, without waiting on what left
	if !strings.Contains(plan.Module, `new aws.rds.Proxy(`) || strings.Contains(plan.Module, "RoleLookup") {
		t.Errorf("the module has the proxy without the lookup:\n%s", plan.Module)
	}
}

// Cloudflare's and Vercel's own resources of SST's: a Worker's URL is made
// with Pulumi's resource, and its placement and a DNS record are left as they
// are, as Pulumi's provider can't set a placement
func TestBuildWritesAWorkersURL(t *testing.T) {
	stack := "urn:pulumi:dev::shop::pulumi:pulumi:Stack::shop-dev"
	cf := "urn:pulumi:dev::shop::pulumi:providers:cloudflare::default_6_15_0"
	sst := "urn:pulumi:dev::shop::pulumi:providers:sst::sst-cloudflare"
	worker := "urn:pulumi:dev::shop::sst:cloudflare:Worker::Edge"
	script := "urn:pulumi:dev::shop::sst:cloudflare:Worker$cloudflare:index/workersScript:WorkersScript::EdgeScript"
	router := "urn:pulumi:dev::shop::sst:aws:Router::Web"
	data := editFixture(t, func(resources []map[string]any) []map[string]any {
		return append(resources,
			map[string]any{"urn": cf, "custom": true, "id": "0ccc", "type": "pulumi:providers:cloudflare", "inputs": map[string]any{"version": "6.15.0"}},
			map[string]any{"urn": sst, "custom": true, "id": "0aaa", "type": "pulumi:providers:sst", "inputs": map[string]any{"cloudflareApiToken": map[string]any{sig.Key: sig.Secret, "ciphertext": "x"}}},
			map[string]any{"urn": worker, "custom": false, "type": "sst:cloudflare:Worker", "parent": stack},
			map[string]any{
				"urn": script, "custom": true, "id": "shop-dev-edgescript", "type": "cloudflare:index/workersScript:WorkersScript", "parent": worker, "provider": cf + "::0ccc",
				"inputs":  map[string]any{"accountId": "acct", "scriptName": "shop-dev-edgescript", "content": "export default {}"},
				"outputs": map[string]any{"accountId": "acct", "scriptName": "shop-dev-edgescript", "etag": "e1"},
			},
			map[string]any{
				"urn": "urn:pulumi:dev::shop::sst:cloudflare:Worker$sst:cloudflare:WorkerUrl::EdgeUrl", "custom": true, "id": "shop-dev-edgescript",
				"type": "sst:cloudflare:WorkerUrl", "parent": worker, "provider": sst + "::0aaa",
				"inputs":               map[string]any{"accountId": "acct", "scriptName": "shop-dev-edgescript", "enabled": true, "etag": "e1"},
				"dependencies":         []any{script},
				"propertyDependencies": map[string]any{"scriptName": []any{script}, "etag": []any{script}},
			},
			map[string]any{
				"urn": "urn:pulumi:dev::shop::sst:cloudflare:Worker$sst:cloudflare:WorkerPlacement::EdgePlacement", "custom": true, "id": "shop-dev-edgescript",
				"type": "sst:cloudflare:WorkerPlacement", "parent": worker, "provider": sst + "::0aaa",
				"inputs":               map[string]any{"accountId": "acct", "scriptName": "shop-dev-edgescript", "mode": "smart", "etag": "e1"},
				"dependencies":         []any{script},
				"propertyDependencies": map[string]any{"scriptName": []any{script}},
			},
			map[string]any{"urn": router, "custom": false, "type": "sst:aws:Router", "parent": stack},
			map[string]any{
				"urn": "urn:pulumi:dev::shop::sst:aws:Router$sst:cloudflare:DnsRecord::WebCaaRecord", "custom": true, "id": "rec1",
				"type": "sst:cloudflare:DnsRecord", "parent": router, "provider": sst + "::0aaa",
				"inputs": map[string]any{"zoneId": "zone", "type": "CAA", "name": "web.example.com"},
			},
			map[string]any{
				"urn": "urn:pulumi:dev::shop::sst:aws:Router$sst:vercel:DnsRecord::WebCaaWildcardRecord", "custom": true, "id": "rec2",
				"type": "sst:vercel:DnsRecord", "parent": router, "provider": sst + "::0aaa",
				"inputs": map[string]any{"domain": "example.com", "type": "CAA", "name": "web"},
			},
		)
	})
	plan, err := build(t, data)
	if err != nil {
		t.Fatal(err)
	}
	reasons := map[string]string{}
	for _, removed := range plan.Stacks[0].Removed {
		reasons[removed.Name] = removed.Why
	}
	for name, want := range map[string]string{
		"EdgeUrl":              "turns on or off with Pulumi's WorkersScriptSubdomain",
		"EdgePlacement":        "which stays until its script is next uploaded, and is Cloudflare's default after that",
		"WebCaaRecord":         "a DNS record, like the CAA record a certificate needs, which stays",
		"WebCaaWildcardRecord": "a DNS record, like the CAA record a certificate needs, which stays",
		"sst-cloudflare":       "SST's provider",
	} {
		if !strings.Contains(reasons[name], want) {
			t.Errorf("%s leaves the state as %q", name, reasons[name])
		}
	}
	for _, want := range []string{
		"new cloudflare.WorkersScriptSubdomain(",
		`"EdgeUrl",`,
		"enabled: true,",
		"scriptName: edgeScript.scriptName,",
	} {
		if !strings.Contains(plan.Module, want) {
			t.Errorf("the module has no %q:\n%s", want, plan.Module)
		}
	}
	if strings.Contains(plan.Module, "WorkerUrl") || strings.Contains(plan.Module, "placement") || strings.Contains(plan.Module, "DnsRecord") {
		t.Errorf("the module has SST's own resources:\n%s", plan.Module)
	}
	updates := strings.Join(plan.Stacks[0].Updates, "\n")
	if want := "EdgeUrl is made with Pulumi's WorkersScriptSubdomain, which turns the Worker's workers.dev URL on, as it already is"; !strings.Contains(updates, want) || strings.Contains(updates, "placement") {
		t.Errorf("the updates are %q", updates)
	}
}

// A Worker's code is its last build, in the project's .sst, which a checkout
// of the program doesn't have: it's copied beside the module, and the module
// and the state point at the copy. A path in the project is written from it.
func TestBuildCopiesAWorkersBuild(t *testing.T) {
	root := t.TempDir()
	built := filepath.Join(root, ".sst", "artifacts", "Edge-src", "worker.ts")
	if err := os.MkdirAll(filepath.Dir(built), 0755); err != nil {
		t.Fatal(err)
	}
	code := "export default { fetch: () => new Response('hi') };\n"
	if err := os.WriteFile(built, []byte(code), 0644); err != nil {
		t.Fatal(err)
	}
	sum := fmt.Sprintf("%x", sha256.Sum256([]byte(code)))
	stack := "urn:pulumi:dev::shop::pulumi:pulumi:Stack::shop-dev"
	cf := "urn:pulumi:dev::shop::pulumi:providers:cloudflare::default_6_15_0"
	worker := "urn:pulumi:dev::shop::sst:cloudflare:Worker::Edge"
	script := "urn:pulumi:dev::shop::sst:cloudflare:Worker$cloudflare:index/workersScript:WorkersScript::EdgeScript"
	state := func(sum string) []byte {
		return editFixture(t, func(resources []map[string]any) []map[string]any {
			return append(resources,
				map[string]any{"urn": cf, "custom": true, "id": "0ccc", "type": "pulumi:providers:cloudflare", "inputs": map[string]any{"version": "6.15.0"}},
				map[string]any{"urn": worker, "custom": false, "type": "sst:cloudflare:Worker", "parent": stack},
				map[string]any{
					"urn": script, "custom": true, "id": "shop-dev-edgescript", "type": "cloudflare:index/workersScript:WorkersScript", "parent": worker, "provider": cf + "::0ccc",
					"inputs": map[string]any{
						"accountId": "acct", "scriptName": "shop-dev-edgescript", "mainModule": "placeholder",
						"contentFile": built, "contentSha256": sum,
						"assets": map[string]any{"directory": filepath.Join(root, "sites", "web")},
					},
					"outputs": map[string]any{"scriptName": "shop-dev-edgescript", "contentFile": built},
				},
			)
		})
	}
	options := fixtureOptions
	options.Root = root
	plan, err := Build([]StackState{{Stack: "dev", Shown: state(sum)}}, options)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Files) != 1 || plan.Files[0] != (CopiedFile{Path: "sst-ejected-workers/EdgeScript.js", From: built, Sum: sum}) {
		t.Errorf("the eject copies %+v", plan.Files)
	}
	for _, want := range []string{
		`import * as path from "path";`,
		"const projectRoot: string =\n  (pulumi as any).getRootDirectory?.() || process.cwd();",
		`contentFile: path.join(projectRoot, "sst-ejected-workers/EdgeScript.js"),`,
		`assets: { directory: path.join(projectRoot, "sites/web") },`,
	} {
		if !strings.Contains(plan.Module, want) {
			t.Errorf("the module has no %q:\n%s", want, plan.Module)
		}
	}
	copied := filepath.Join(root, "sst-ejected-workers", "EdgeScript.js")
	if got := plan.Stacks[0].Inputs[resource.URN(script)]; got["contentFile"] != copied {
		t.Errorf("the state's contentFile is set to %v", got)
	}

	// The state, with the copy in its inputs and outputs, and no other change
	edited, err := withoutResources(state(sum), nil, plan.Stacks[0].Inputs)
	if err != nil {
		t.Fatal(err)
	}
	var parsed export
	if err := json.Unmarshal(edited, &parsed); err != nil {
		t.Fatal(err)
	}
	for _, r := range parsed.Deployment.Resources {
		if string(r.URN) == script && (r.Inputs["contentFile"] != copied || r.Outputs["contentFile"] != copied || r.Inputs["contentSha256"] != sum) {
			t.Errorf("the edited state has %v and %v", r.Inputs, r.Outputs)
		}
	}

	// Another build than the state's isn't copied
	if _, err := Build([]StackState{{Stack: "dev", Shown: state("0000")}}, options); err == nil || !strings.Contains(err.Error(), "EdgeScript's code is its last build") {
		t.Errorf("another build is copied: %v", err)
	}
}
