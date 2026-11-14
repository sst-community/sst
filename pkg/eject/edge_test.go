package eject

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/pulumi/pulumi/sdk/v3/go/common/resource/sig"
)

// Cases a review of the eject found, each a state it wrote wrong or refused

// named is the fixture's resource of a name, from its resources
func named(resources []map[string]any, name string) map[string]any {
	for _, r := range resources {
		if strings.HasSuffix(r["urn"].(string), "::"+name) {
			return r
		}
	}
	panic("no " + name + " in the fixture")
}

// secretOf is a value as a state shown with its secrets has a secret
func secretOf(t *testing.T, value any) map[string]any {
	t.Helper()
	text, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return map[string]any{sig.Key: sig.Secret, "plaintext": string(text)}
}

// settingsOf are a stack's settings, by key
func settingsOf(stack *StackPlan) map[string]Setting {
	result := map[string]Setting{}
	for _, setting := range stack.Config {
		result[setting.Key] = setting
	}
	return result
}

// withTags is the fixture with the bucket's tags, for the stack given
func withTags(t *testing.T, shown []byte, tags map[string]any) []byte {
	t.Helper()
	var parsed map[string]any
	if err := json.Unmarshal(shown, &parsed); err != nil {
		t.Fatal(err)
	}
	for _, r := range parsed["deployment"].(map[string]any)["resources"].([]any) {
		r := r.(map[string]any)
		if strings.HasSuffix(r["urn"].(string), "::FilesBucket") {
			r["inputs"].(map[string]any)["tags"] = tags
		}
	}
	data, err := json.Marshal(parsed)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestBuildMakesConfigKeysPulumiTakes(t *testing.T) {
	// An object's key with a ":" in it, which a config key can't have but
	// after its namespace, in a value each stack has its own of
	dev := withTags(t, readFixture(t), map[string]any{"team:owner": "shop-dev"})
	prod := withTags(t, prodFixture(t), map[string]any{"team:owner": "shop-prod"})
	plan, err := build(t, dev, StackState{Stack: "prod", Shown: prod})
	if err != nil {
		t.Fatal(err)
	}
	for _, stack := range plan.Stacks {
		for _, setting := range stack.Config {
			if strings.Count(setting.Key, ":") != 1 {
				t.Errorf("the %s stack's config key %q has more than one \":\"", stack.Name, setting.Key)
			}
		}
	}
	if got := settingsOf(plan.Stacks[1])["sst-ejected:FilesBucket.tags.team_owner"]; got.Value != "shop-prod" {
		t.Errorf("prod's tag: %+v", got)
	}
	if !strings.Contains(plan.Module, `"team:owner": config.require("FilesBucket.tags.team_owner")`) {
		t.Errorf("the module doesn't read the tag:\n%s", plan.Module)
	}
}

func TestBuildKeepsAValuesLastNewline(t *testing.T) {
	// pulumi config set takes a newline off the end of what it reads, so
	// such a string is set as JSON, and so is a string read as an object for
	// another stack's value of another kind
	dev := withTags(t, readFixture(t), map[string]any{"note": "first line\n", "size": "large"})
	prod := withTags(t, prodFixture(t), map[string]any{"note": "other\n", "size": json.Number("3")})
	plan, err := build(t, dev, StackState{Stack: "prod", Shown: prod})
	if err != nil {
		t.Fatal(err)
	}
	devSettings, prodSettings := settingsOf(plan.Stacks[0]), settingsOf(plan.Stacks[1])
	if got := devSettings["sst-ejected:FilesBucket.tags.note"].Value; got != `"first line\n"` {
		t.Errorf("dev's note is set as %q", got)
	}
	if got := devSettings["sst-ejected:FilesBucket.tags.size"].Value; got != `"large"` {
		t.Errorf("dev's size is set as %q", got)
	}
	if got := prodSettings["sst-ejected:FilesBucket.tags.size"].Value; got != "3" {
		t.Errorf("prod's size is set as %q", got)
	}
	for _, want := range []string{
		`note: config.requireObject<any>("FilesBucket.tags.note")`,
		`size: config.requireObject<any>("FilesBucket.tags.size")`,
	} {
		if !strings.Contains(plan.Module, want) {
			t.Errorf("the module has no %s:\n%s", want, plan.Module)
		}
	}
}

func TestBuildRefusesTwoStacksOfOneName(t *testing.T) {
	_, err := build(t, readFixture(t), StackState{Stack: "other-org/shop/dev", Shown: readFixture(t)})
	if err == nil || !strings.Contains(err.Error(), `Two stacks of the project are named "dev": dev and other-org/shop/dev`) {
		t.Fatalf("got %v", err)
	}
}

func TestBuildWritesNoPartOfASecret(t *testing.T) {
	// A secret that starts with an output of what it depends on: the rest of
	// it would be written in the code as text after the reference
	shown := editFixture(t, func(resources []map[string]any) []map[string]any {
		role := named(resources, "ApiRole")
		arn := role["outputs"].(map[string]any)["arn"].(string)
		fn := named(resources, "ApiFunction")
		fn["inputs"].(map[string]any)["description"] = secretOf(t, arn+"/hunter2token")
		fn["propertyDependencies"].(map[string]any)["description"] = []any{role["urn"]}
		return resources
	})
	plan, err := build(t, shown)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(plan.Module, "hunter2token") {
		t.Errorf("the module has part of the secret:\n%s", plan.Module)
	}
	if got := settingsOf(plan.Stacks[0])["sst-ejected:ApiFunction.description"]; !got.Secret || !strings.HasSuffix(got.Value, "/hunter2token") {
		t.Errorf("the secret's setting: %+v", got)
	}
}

func TestBuildAddsToAnEnvironmentThatsASecret(t *testing.T) {
	// The function's whole environment a secret, as a transform can make it
	shown := editFixture(t, func(resources []map[string]any) []map[string]any {
		inputs := named(resources, "ApiFunction")["inputs"].(map[string]any)
		inputs["environment"] = secretOf(t, map[string]any{"variables": map[string]any{"STAGE": "dev"}})
		return resources
	})
	plan, err := build(t, shown)
	if err != nil {
		t.Fatal(err)
	}
	got := settingsOf(plan.Stacks[0])["sst-ejected:ApiFunction.environment"]
	if !got.Secret || !strings.Contains(got.Value, `"LATE":"https://example.com"`) || !strings.Contains(got.Value, `"STAGE":"dev"`) {
		t.Errorf("the environment's setting: %+v", got)
	}
	if !strings.Contains(plan.Module, `environment: config.requireSecretObject<any>("ApiFunction.environment")`) {
		t.Errorf("the module doesn't read the environment as a secret:\n%s", plan.Module)
	}
}

func TestBuildKeepsAnAdditionThatsASecret(t *testing.T) {
	// addEnvironment given one secret, with the function's own variables
	// plain
	shown := editFixture(t, func(resources []map[string]any) []map[string]any {
		named(resources, "ApiFunction")["inputs"].(map[string]any)["environment"] = map[string]any{"variables": map[string]any{"STAGE": "dev"}}
		named(resources, "ApiEnvironmentUpdate")["inputs"].(map[string]any)["environment"] = secretOf(t, map[string]any{"TOKEN": "hunter2token"})
		return resources
	})
	plan, err := build(t, shown)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(plan.Module, "hunter2token") {
		t.Errorf("the module has the secret:\n%s", plan.Module)
	}
	if got := settingsOf(plan.Stacks[0])["sst-ejected:ApiFunction.environment.variables"]; !got.Secret || !strings.Contains(got.Value, "hunter2token") {
		t.Errorf("the variables' setting: %+v", got)
	}
}

func TestBuildTakesAnObjectWithNoSource(t *testing.T) {
	// A part that's an object written from text, not uploaded from a file
	shown := editFixture(t, func(resources []map[string]any) []map[string]any {
		code := named(resources, "ApiCode")
		note := map[string]any{}
		for key, value := range code {
			note[key] = value
		}
		note["urn"] = strings.TrimSuffix(code["urn"].(string), "ApiCode") + "ApiNote"
		note["id"] = "assets/note.txt"
		note["inputs"] = map[string]any{"bucket": "shop-dev-filesbucket-abcdefgh", "key": "assets/note.txt", "content": "hello"}
		note["outputs"] = map[string]any{"bucket": "shop-dev-filesbucket-abcdefgh", "key": "assets/note.txt", "content": "hello"}
		return append(resources, note)
	})
	if _, err := build(t, shown); err != nil {
		t.Fatal(err)
	}
}

func TestBuildKeepsADependencyOnTheProgramsProvider(t *testing.T) {
	// A dependency on a provider of the program's, and a part deleted with
	// it, which the module is given and doesn't make, so they're kept without
	// putting it in the module's order
	shown := editFixture(t, func(resources []map[string]any) []map[string]any {
		fn := named(resources, "ApiFunction")
		fn["dependencies"] = append(fn["dependencies"].([]any), "urn:pulumi:dev::shop::pulumi:providers:aws::east")
		named(resources, "ApiLogGroup")["deletedWith"] = "urn:pulumi:dev::shop::pulumi:providers:aws::east"
		return resources
	})
	plan, err := build(t, shown)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"program.providers.east,", "deletedWith: program.providers.east"} {
		if !strings.Contains(plan.Module, want) {
			t.Errorf("the module has no %s:\n%s", want, plan.Module)
		}
	}
}

func TestBuildKeepsTheDependencyOfASecretItWritesInTheConfig(t *testing.T) {
	// A secret that starts with an output of what it depends on goes in the
	// config, and what it depends on stays a dependency
	shown := editFixture(t, func(resources []map[string]any) []map[string]any {
		logGroup := named(resources, "ApiLogGroup")
		arn := logGroup["outputs"].(map[string]any)["arn"].(string)
		invoke := named(resources, "ApiUrlInvoke")
		invoke["inputs"].(map[string]any)["sourceArn"] = secretOf(t, arn+":hunter2token")
		invoke["propertyDependencies"].(map[string]any)["sourceArn"] = []any{logGroup["urn"]}
		invoke["dependencies"] = append(invoke["dependencies"].([]any), logGroup["urn"])
		return resources
	})
	plan, err := build(t, shown)
	if err != nil {
		t.Fatal(err)
	}
	start := strings.Index(plan.Module, "const apiUrlInvoke")
	if start == -1 {
		t.Fatalf("no apiUrlInvoke in:\n%s", plan.Module)
	}
	declaration := plan.Module[start:]
	declaration = declaration[:strings.Index(declaration, ");")]
	if !strings.Contains(declaration, "dependsOn: [apiLogGroup]") {
		t.Errorf("apiUrlInvoke doesn't depend on apiLogGroup:\n%s", declaration)
	}
}
