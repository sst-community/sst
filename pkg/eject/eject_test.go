package eject

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
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
		"export function ejected(providers: {\n  east: pulumi.ProviderResource;\n})",
		"provider: providers.east",
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
						r["type"] = "sst:aws:RdsRoleLookup"
					}
				}
				return resources
			},
			error: "FilesUpload (sst:aws:RdsRoleLookup) is one of SST's own resources",
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
	edited, err := withoutResources(data, remove)
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
	if _, err := withoutResources(data, map[resource.URN]bool{urn: true}); err == nil || !strings.Contains(err.Error(), "FilesBucket is in Files") {
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
