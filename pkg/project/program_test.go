package project

import (
	"encoding/json"
	"path/filepath"
	"reflect"
	"sort"
	"testing"

	"github.com/sst/sst/v3/pkg/global"
	"github.com/sst/sst/v3/pkg/js"
)

// What the core gives the Pulumi program today, item by item. The 5.0
// program contract replaces it; until then a change here is on purpose.

func TestProgramDefine(t *testing.T) {
	root := filepath.Join(t.TempDir(), "app")
	retention := 5
	p := &Project{
		root:   root,
		config: filepath.Join(root, "sst.config.ts"),
		app: &App{
			Name:      "my-app",
			Stage:     "dev",
			Removal:   "retain",
			Home:      "aws",
			Providers: map[string]interface{}{"aws": map[string]interface{}{"region": "us-west-2"}},
			State:     &State{Retention: &retention},
		},
	}
	define, err := p.programDefine(&StackInput{Command: "deploy", Dev: true}, map[string]int{"Bucket": 2})
	if err != nil {
		t.Fatal(err)
	}

	if keys := sortedKeys(define); !reflect.DeepEqual(keys, []string{"$app", "$cli", "$dev"}) {
		t.Fatalf("the program gets %v", keys)
	}
	if define["$dev"] != "true" {
		t.Fatalf("$dev is %q", define["$dev"])
	}

	// $app is the config's app() as the CLI read it, field by field.
	var app map[string]interface{}
	if err := json.Unmarshal([]byte(define["$app"]), &app); err != nil {
		t.Fatal(err)
	}
	if keys := sortedKeys(app); !reflect.DeepEqual(keys, []string{
		"backend", "dev", "home", "name", "packages", "protect", "providers", "removal",
		"removalPolicy", "stage", "state", "types", "version", "watch",
	}) {
		t.Fatalf("$app has %v", keys)
	}
	if app["name"] != "my-app" || app["stage"] != "dev" || app["removal"] != "retain" || app["home"] != "aws" {
		t.Fatalf("$app is %v", app)
	}

	// $cli is the command, whether it's sst dev, the paths, and the versions
	// of the components in the state.
	var cli struct {
		Command string            `json:"command"`
		Dev     bool              `json:"dev"`
		Paths   map[string]string `json:"paths"`
		State   struct {
			Version map[string]int `json:"version"`
		} `json:"state"`
	}
	if err := json.Unmarshal([]byte(define["$cli"]), &cli); err != nil {
		t.Fatal(err)
	}
	var raw map[string]interface{}
	json.Unmarshal([]byte(define["$cli"]), &raw)
	if keys := sortedKeys(raw); !reflect.DeepEqual(keys, []string{"command", "dev", "paths", "state"}) {
		t.Fatalf("$cli has %v", keys)
	}
	if cli.Command != "deploy" || !cli.Dev {
		t.Fatalf("$cli is %+v", cli)
	}
	wantPaths := map[string]string{
		"home":     global.ConfigDir(),
		"root":     root,
		"work":     filepath.Join(root, ".sst"),
		"platform": filepath.Join(root, ".sst", "platform"),
	}
	if !reflect.DeepEqual(cli.Paths, wantPaths) {
		t.Fatalf("$cli.paths is %v, want %v", cli.Paths, wantPaths)
	}
	if !reflect.DeepEqual(cli.State.Version, map[string]int{"Bucket": 2}) {
		t.Fatalf("$cli.state.version is %v", cli.State.Version)
	}
}

func TestProgramEnv(t *testing.T) {
	p := &Project{
		app: &App{Name: "my-app", Stage: "dev"},
		env: map[string]string{"SST_AWS_REGION": "us-west-2"},
	}
	base := []string{"HOME=/home/me", "NODE_OPTIONS=--max-old-space-size=4096"}
	env := p.programEnv(
		base,
		"passphrase",
		filepath.Join("work", "pulumi", "id"),
		map[string]string{"Token": "stage"},
		map[string]string{"Token": "fallback", "Other": "fallback"},
		"http://127.0.0.1:50123/token",
	)

	got := map[string]string{}
	for _, entry := range env {
		for i := 0; i < len(entry); i++ {
			if entry[i] == '=' {
				// The last value wins, as it does for the process.
				got[entry[:i]] = entry[i+1:]
				break
			}
		}
	}
	want := map[string]string{
		// the user's
		"HOME": "/home/me",
		// the providers'
		"SST_AWS_REGION": "us-west-2",
		// the secrets, the stage's over the fallback's
		"SST_SECRET_Token": "stage",
		"SST_SECRET_Other": "fallback",
		// Pulumi's settings
		"PULUMI_CONFIG_PASSPHRASE":      "passphrase",
		"PULUMI_SKIP_UPDATE_CHECK":      "true",
		"PULUMI_BACKEND_URL":            "file://" + filepath.ToSlash(filepath.Join("work", "pulumi", "id")),
		"PULUMI_DEBUG_COMMANDS":         "true",
		"PULUMI_IGNORE_AMBIENT_PLUGINS": "true",
		"PULUMI_HOME":                   global.ConfigDir(),
		"NODE_OPTIONS":                  "--max-old-space-size=4096 --enable-source-maps --no-deprecation --no-warnings",
		// the RPC the program calls back into
		"SST_SERVER": "http://127.0.0.1:50123/token",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("the program's environment is\n%v\nwant\n%v", got, want)
	}
	// The user's come first, so everything after them wins.
	if !reflect.DeepEqual(env[:len(base)], base) {
		t.Fatalf("the environment starts %v", env[:len(base)])
	}

	noServer := p.programEnv(nil, "p", "w", nil, nil, "")
	for _, entry := range noServer {
		if len(entry) > 11 && entry[:11] == "SST_SERVER=" {
			t.Fatalf("SST_SERVER is set with no server: %v", entry)
		}
	}
}

func TestProgramGlobals(t *testing.T) {
	root := filepath.Join(t.TempDir(), "app")
	p := &Project{
		root: root,
		lock: ProviderLock{
			{Name: "aws", Package: "@pulumi/aws", Alias: "aws"},
			{Name: "cloudflare", Package: "@pulumi/cloudflare", Alias: "cloudflare"},
		},
	}
	globals, platform := p.programGlobals()
	components := filepath.ToSlash(filepath.Join(root, ".sst", "platform", "src", "components"))
	want := []js.Global{
		{Name: "aws", Module: "@pulumi/aws"},
		{Name: "cloudflare", Module: "@pulumi/cloudflare"},
		{Name: "sst", Module: components},
	}
	if !reflect.DeepEqual(globals, want) {
		t.Fatalf("globals are %v, want %v", globals, want)
	}
	wantPlatform := map[string]string{
		"sst/components":            components + "/core.ts",
		"sst/components/aws":        components + "/aws/index.ts",
		"sst/components/cloudflare": components + "/cloudflare/index.ts",
		"sst/components/vercel":     components + "/vercel/index.ts",
	}
	if !reflect.DeepEqual(platform, wantPlatform) {
		t.Fatalf("the platform modules are %v, want %v", platform, wantPlatform)
	}
}

func TestProviderConfigArgs(t *testing.T) {
	args, err := providerConfigArgs(map[string]interface{}{
		"aws": map[string]interface{}{
			"region":            "us-west-2",
			"package":           "@pulumi/aws",
			"defaultTags":       map[string]interface{}{"tags": map[string]interface{}{"sst:app": "my-app"}},
			"allowedAccountIds": []interface{}{"123456789012"},
			// Dropped today: the bug step 3 fixes.
			"skipCredentialsValidation": true,
			"maxRetries":                float64(5),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	var config []string
	for i := 0; i < len(args); i += 2 {
		if args[i] != "--config" {
			t.Fatalf("expected --config, got %v", args)
		}
		config = append(config, args[i+1])
	}
	sort.Strings(config)
	want := []string{
		`aws:allowedAccountIds=["123456789012"]`,
		`aws:defaultTags={"tags":{"sst:app":"my-app"}}`,
		`aws:region=us-west-2`,
	}
	if !reflect.DeepEqual(config, want) {
		t.Fatalf("the provider settings are\n%v\nwant\n%v", config, want)
	}
}
