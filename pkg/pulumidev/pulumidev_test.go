package pulumidev

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/pulumi/pulumi/sdk/v3/go/auto/events"
	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
	"github.com/sst/sst/v3/internal/util"
	"github.com/sst/sst/v3/pkg/project"
)

func TestIsProgram(t *testing.T) {
	for path, want := range map[string]bool{
		"/app/Pulumi.yaml":     true,
		"/app/Pulumi.yml":      true,
		"/app/sst.config.ts":   false,
		"/app/Pulumi.dev.yaml": false,
	} {
		if got := IsProgram(path); got != want {
			t.Errorf("IsProgram(%q) = %v", path, got)
		}
	}
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

func TestProgramEntry(t *testing.T) {
	t.Run("index file", func(t *testing.T) {
		root := t.TempDir()
		write(t, filepath.Join(root, "index.ts"), "")
		if got := programEntry(root, ""); got != filepath.Join(root, "index.ts") {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("package.json main", func(t *testing.T) {
		root := t.TempDir()
		write(t, filepath.Join(root, "package.json"), `{"main": "src/infra.ts"}`)
		write(t, filepath.Join(root, "src", "infra.ts"), "")
		write(t, filepath.Join(root, "index.ts"), "")
		if got := programEntry(root, ""); got != filepath.Join(root, "src", "infra.ts") {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("main in Pulumi.yaml, a folder", func(t *testing.T) {
		root := t.TempDir()
		write(t, filepath.Join(root, "infra", "index.ts"), "")
		if got := programEntry(root, "infra"); got != filepath.Join(root, "infra", "index.ts") {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("main in Pulumi.yaml, a file", func(t *testing.T) {
		root := t.TempDir()
		write(t, filepath.Join(root, "infra.ts"), "")
		if got := programEntry(root, "infra.ts"); got != filepath.Join(root, "infra.ts") {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("none", func(t *testing.T) {
		if got := programEntry(t.TempDir(), ""); got != "" {
			t.Fatalf("got %q", got)
		}
	})
}

// fakePulumi puts a pulumi on the PATH that answers `stack --show-name` with
// the stack, and `config --json` with the config, and fails otherwise
func fakePulumi(t *testing.T, stack string, config map[string]interface{}) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the fake pulumi is a shell script")
	}
	bin := t.TempDir()
	data, _ := json.Marshal(config)
	write(t, filepath.Join(bin, "config.json"), string(data))
	script := `#!/bin/sh
case "$1" in
  stack)
    if [ -z "` + stack + `" ]; then echo 'error: no stack selected; please use pulumi stack select' >&2; exit 1; fi
    if [ "` + stack + `" = "!login" ]; then echo 'error: PULUMI_ACCESS_TOKEN must be set for login during non-interactive CLI sessions' >&2; exit 1; fi
    echo "` + stack + `" ;;
  config) cat "` + filepath.Join(bin, "config.json") + `" ;;
  *) echo "error: unexpected $*" >&2; exit 1 ;;
esac
`
	if err := os.WriteFile(filepath.Join(bin, "pulumi"), []byte(script), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func pulumiProject(t *testing.T, yaml string) string {
	t.Helper()
	root := t.TempDir()
	write(t, filepath.Join(root, "Pulumi.yaml"), yaml)
	write(t, filepath.Join(root, "index.ts"), "")
	write(t, filepath.Join(root, DevFile), "functions:\n  Api: functions/api.handler\n")
	write(t, filepath.Join(root, "functions", "api.ts"), "")
	return filepath.Join(root, "Pulumi.yaml")
}

func readable(t *testing.T, err error) string {
	t.Helper()
	var r *util.ReadableError
	if !errors.As(err, &r) {
		t.Fatalf("got %v, not a readable error", err)
	}
	return r.Error()
}

func TestNew(t *testing.T) {
	t.Run("a stack that opted in", func(t *testing.T) {
		fakePulumi(t, "dev", map[string]interface{}{
			"sst:dev":     map[string]interface{}{"value": "true", "secret": false},
			"aws:region":  map[string]interface{}{"value": "us-west-2", "secret": false},
			"aws:profile": map[string]interface{}{"value": "lab", "secret": false},
			"shop:token":  map[string]interface{}{"secret": true},
		})
		cfg := pulumiProject(t, "name: shop\nruntime: nodejs\n")
		p, err := New(cfg, "", "dev")
		if err != nil {
			t.Fatal(err)
		}
		if p.Name() != "shop" || p.Stage() != "dev" || p.stack != "dev" {
			t.Fatalf("got %q, %q, %q", p.Name(), p.Stage(), p.stack)
		}
		if p.aws.profile != "lab" || p.aws.region != "us-west-2" {
			t.Fatalf("aws %+v", p.aws)
		}
		if !reflect.DeepEqual(p.Providers(), map[string]interface{}{"aws": map[string]interface{}{"region": "us-west-2"}}) {
			t.Fatalf("providers %v", p.Providers())
		}
		if p.entry != filepath.Join(filepath.Dir(cfg), "index.ts") {
			t.Fatalf("entry %q", p.entry)
		}
		// nothing of SST's: no home, no target, no transport before Load
		if p.Home() != "" || p.Target().Name() != "cloud" {
			t.Fatalf("home %q, target %q", p.Home(), p.Target().Name())
		}
		if _, ok := p.Transport(); ok {
			t.Fatal("a transport before the aws provider is loaded")
		}
	})
	t.Run("no dev file", func(t *testing.T) {
		fakePulumi(t, "dev", map[string]interface{}{
			"sst:dev": map[string]interface{}{"value": "true"},
		})
		cfg := pulumiProject(t, "name: shop\nruntime: nodejs\n")
		os.Remove(filepath.Join(filepath.Dir(cfg), DevFile))
		_, err := New(cfg, "", "dev")
		if message := readable(t, err); !strings.Contains(message, "there's none") || !strings.Contains(message, "functions:") {
			t.Fatalf("got %q", message)
		}
	})
	t.Run("a stack in an organization", func(t *testing.T) {
		fakePulumi(t, "acme/shop/dev", map[string]interface{}{
			"sst:dev": map[string]interface{}{"value": "true"},
		})
		p, err := New(pulumiProject(t, "name: shop\nruntime: nodejs\n"), "", "dev")
		if err != nil {
			t.Fatal(err)
		}
		// pulumi gets the stack as it's named, and SST knows it by its name
		if p.stack != "acme/shop/dev" || p.Stage() != "dev" {
			t.Fatalf("stack %q, stage %q", p.stack, p.Stage())
		}
	})
	t.Run("the stack named", func(t *testing.T) {
		fakePulumi(t, "", map[string]interface{}{
			"sst:dev": map[string]interface{}{"value": "true"},
		})
		cfg := pulumiProject(t, "name: shop\nruntime: nodejs\n")
		p, err := New(cfg, "alice", "dev")
		if err != nil {
			t.Fatal(err)
		}
		if p.Stage() != "alice" {
			t.Fatalf("stage %q", p.Stage())
		}
	})
	t.Run("a stack that didn't opt in", func(t *testing.T) {
		fakePulumi(t, "prod", map[string]interface{}{
			"aws:region": map[string]interface{}{"value": "us-west-2"},
		})
		_, err := New(pulumiProject(t, "name: shop\nruntime: nodejs\n"), "", "dev")
		if message := readable(t, err); !strings.Contains(message, `"prod" hasn't`) || !strings.Contains(message, "pulumi config set sst:dev true --stack prod") {
			t.Fatalf("got %q", message)
		}
	})
	t.Run("sst:dev set to anything but true", func(t *testing.T) {
		fakePulumi(t, "dev", map[string]interface{}{
			"sst:dev": map[string]interface{}{"value": "false"},
		})
		_, err := New(pulumiProject(t, "name: shop\nruntime: nodejs\n"), "", "dev")
		readable(t, err)
	})
	t.Run("no stack selected", func(t *testing.T) {
		fakePulumi(t, "", map[string]interface{}{})
		_, err := New(pulumiProject(t, "name: shop\nruntime: nodejs\n"), "", "dev")
		if message := readable(t, err); !strings.Contains(message, "No Pulumi stack is selected") {
			t.Fatalf("got %q", message)
		}
	})
	t.Run("a backend it can't reach", func(t *testing.T) {
		fakePulumi(t, "!login", map[string]interface{}{})
		_, err := New(pulumiProject(t, "name: shop\nruntime: nodejs\n"), "", "dev")
		if message := readable(t, err); !strings.Contains(message, "PULUMI_ACCESS_TOKEN must be set") || strings.Contains(message, "No Pulumi stack is selected") {
			t.Fatalf("got %q", message)
		}
	})
	t.Run("a program in another language", func(t *testing.T) {
		fakePulumi(t, "dev", map[string]interface{}{})
		_, err := New(pulumiProject(t, "name: shop\nruntime: python\n"), "", "dev")
		if message := readable(t, err); !strings.Contains(message, `"python"`) {
			t.Fatalf("got %q", message)
		}
	})
	t.Run("names SST can't use", func(t *testing.T) {
		fakePulumi(t, "dev_alice", map[string]interface{}{
			"sst:dev": map[string]interface{}{"value": "true"},
		})
		_, err := New(pulumiProject(t, "name: my_shop\nruntime: nodejs\n"), "", "dev")
		if message := readable(t, err); !strings.Contains(message, `"my_shop"`) {
			t.Fatalf("got %q", message)
		}
		_, err = New(pulumiProject(t, "name: shop\nruntime: nodejs\n"), "", "dev")
		if message := readable(t, err); !strings.Contains(message, `"dev_alice"`) {
			t.Fatalf("got %q", message)
		}
	})
}

func TestRunsOnlyDev(t *testing.T) {
	p := &Program{}
	for _, input := range []*project.StackInput{{Command: "deploy"}, {Command: "remove", Dev: true}, {Command: "diff"}} {
		if err := p.Run(t.Context(), input); err != ErrCommand {
			t.Errorf("%+v: got %v", input, err)
		}
	}
}

// What `pulumi stack export --show-secrets` prints of a stack with outputs,
// one of them secret, two roles of the same name in other components, and a
// function whose environment has a secret
const exported = `{
  "version": 3,
  "deployment": {
    "manifest": {"time": "2026-11-12T00:00:00Z", "magic": "", "version": "v3.270.0"},
    "resources": [
      {
        "urn": "urn:pulumi:dev::shop::pulumi:pulumi:Stack::shop-dev",
        "type": "pulumi:pulumi:Stack",
        "outputs": {
          "apiUrl": "https://abc.lambda-url.us-west-2.on.aws/",
          "port": 5432,
          "_hidden": "x",
          "token": {"4dabf18193072939515e22adb298388d": "1b47061264138c4ac30d75fd1eb44270", "ciphertext": "v1:token"},
          "settings": {"region": "us-west-2", "key": {"4dabf18193072939515e22adb298388d": "1b47061264138c4ac30d75fd1eb44270", "ciphertext": "v1:key"}},
          "other": {"4dabf18193072939515e22adb298388d": "1b47061264138c4ac30d75fd1eb44270", "ciphertext": "v1:other"}
        }
      },
      {
        "urn": "urn:pulumi:dev::shop::aws:iam/role:Role::Reporter",
        "type": "aws:iam/role:Role",
        "outputs": {"arn": "arn:aws:iam::123456789012:role/Reporter-1234"}
      },
      {
        "urn": "urn:pulumi:dev::shop::app:index:Worker$aws:iam/role:Role::WorkerRole",
        "type": "aws:iam/role:Role",
        "outputs": {"arn": "arn:aws:iam::123456789012:role/WorkerRole-1"}
      },
      {
        "urn": "urn:pulumi:dev::shop::app:index:Other$aws:iam/role:Role::WorkerRole",
        "type": "aws:iam/role:Role",
        "outputs": {"arn": "arn:aws:iam::123456789012:role/WorkerRole-2"}
      },
      {
        "urn": "urn:pulumi:dev::shop::aws:lambda/function:Function::Api",
        "type": "aws:lambda/function:Function",
        "inputs": {"environment": {"variables": {"KEY": {"4dabf18193072939515e22adb298388d": "1b47061264138c4ac30d75fd1eb44270", "ciphertext": "v1:fn"}}}},
        "outputs": {"name": "Api-1234", "environment": {"variables": {"KEY": {"4dabf18193072939515e22adb298388d": "1b47061264138c4ac30d75fd1eb44270", "ciphertext": "v1:fn"}}}}
      }
    ]
  }
}`

func mustParse(t *testing.T, text string) *devFile {
	t.Helper()
	file, err := parseDevFile([]byte(text))
	if err != nil {
		t.Fatal(err)
	}
	return file
}

func TestCompletedFromExport(t *testing.T) {
	dev := mustParse(t, `
commands:
  Web:
    command: npm run dev
    directory: web
    autostart: false
    title: Web app
    environment:
      API_URL: ${apiUrl}
      TOKEN: ${token}
      DATABASE: postgres://localhost:${port}/app
      SETTINGS: ${settings}
  Again:
    command: node again.mjs
    environment:
      TOKEN: ${token}
  Unreadable:
    command: node unreadable.mjs
    environment:
      VALUE: ${other}
  Report:
    command: node report.mjs
    role: Reporter
  Prebuilt:
    command: node report.mjs
    role: arn:aws:iam::123456789012:role/elsewhere
  Missing:
    command: node missing.mjs
    environment:
      VALUE: ${nope}
  NoRole:
    command: node missing.mjs
    role: Nobody
  Twice:
    command: node worker.mjs
    role: WorkerRole
  Misspelt:
    command: node report.mjs
    role: Reportr
    environment:
      URL: ${apiUrl}
`)
	// only a secret output a command's environment names is read in the
	// clear, and once
	revealed := []string{}
	reveal := func(name string) (interface{}, error) {
		revealed = append(revealed, name)
		switch name {
		case "token":
			return "shh", nil
		case "settings":
			return map[string]interface{}{"region": "us-west-2", "key": "k"}, nil
		}
		return nil, errors.New("pulumi stack output: no")
	}
	complete, err := completedFromExport([]byte(exported), dev, reveal, noSecretsShown(t))
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(revealed)
	if strings.Join(revealed, ",") != "other,settings,token" {
		t.Fatalf("revealed %v", revealed)
	}
	if complete.Devs["Again"].Environment["TOKEN"] != "shh" {
		t.Fatalf("again %+v", complete.Devs["Again"])
	}
	web := complete.Devs["Web"]
	if web.Name != "Web" || web.Command != "npm run dev" || web.Directory != "web" || web.Autostart || web.Title != "Web app" || web.Aws != nil || web.Links == nil {
		t.Fatalf("web %+v", web)
	}
	// the outputs a dev command is given are in the clear
	want := map[string]string{"API_URL": "https://abc.lambda-url.us-west-2.on.aws/", "TOKEN": "shh", "DATABASE": "postgres://localhost:5432/app", "SETTINGS": `{"key":"k","region":"us-west-2"}`}
	if !reflect.DeepEqual(web.Environment, want) {
		t.Fatalf("environment %v", web.Environment)
	}
	if report := complete.Devs["Report"]; !report.Autostart || report.Aws == nil || report.Aws.Role != "arn:aws:iam::123456789012:role/Reporter-1234" || !report.Aws.Only {
		t.Fatalf("report %+v", report)
	}
	if prebuilt := complete.Devs["Prebuilt"]; prebuilt.Aws == nil || prebuilt.Aws.Role != "arn:aws:iam::123456789012:role/elsewhere" {
		t.Fatalf("prebuilt %+v", prebuilt)
	}
	// a command that can't run is left out, and says why
	for _, name := range []string{"Missing", "NoRole", "Twice", "Misspelt", "Unreadable"} {
		if _, ok := complete.Devs[name]; ok {
			t.Fatalf("%s should be left out", name)
		}
	}
	messages := []string{}
	for _, problem := range complete.Errors {
		messages = append(messages, problem.Message)
	}
	joined := strings.Join(messages, "\n")
	for _, part := range []string{`"Missing" dev command`, `no output "nope"`, `"NoRole" dev command`, `no role of that name`, `"Twice" dev command`, `2 roles of that name`, `runs as "Reportr", and the stack has no role of that name: did you mean "Reporter"?`, `"Unreadable" dev command`, `reading the secret output "other": pulumi stack output: no`} {
		if !strings.Contains(joined, part) {
			t.Fatalf("errors %q don't say %q", joined, part)
		}
	}
	for _, message := range messages {
		if strings.HasSuffix(message, "?.") || !(strings.HasSuffix(message, ".") || strings.HasSuffix(message, "?")) {
			t.Errorf("%q doesn't end as a sentence", message)
		}
	}
	// a secret output stays hidden, as pulumi shows it
	if complete.Outputs["apiUrl"] != "https://abc.lambda-url.us-west-2.on.aws/" || complete.Outputs["token"] != "[secret]" {
		t.Fatalf("outputs %v", complete.Outputs)
	}
	if _, ok := complete.Outputs["_hidden"]; ok {
		t.Fatal("an output that starts with _ isn't shown")
	}
	// nothing of the state but its outputs and roles is kept
	if len(complete.Resources) != 0 || complete.Functions == nil || complete.Tunnels == nil {
		t.Fatalf("got %+v", complete)
	}
}

func TestCompletedFromExportEmpty(t *testing.T) {
	complete, err := completedFromExport([]byte(`{"version": 3, "deployment": {"manifest": {"time": "2026-11-12T00:00:00Z", "magic": "", "version": ""}}}`), &devFile{}, nil, noSecretsShown(t))
	if err != nil {
		t.Fatal(err)
	}
	if len(complete.Devs) != 0 || len(complete.Outputs) != 0 || len(complete.Errors) != 0 {
		t.Fatalf("got %+v", complete)
	}
}

func TestCompletedFromExportNewer(t *testing.T) {
	if _, err := completedFromExport([]byte(`{"version": 99, "deployment": {}}`), &devFile{}, nil, noSecretsShown(t)); err == nil {
		t.Fatal("a newer format can't be read")
	}
}

func TestSecrets(t *testing.T) {
	secret := func(ciphertext string) map[string]interface{} {
		return map[string]interface{}{"4dabf18193072939515e22adb298388d": "1b47061264138c4ac30d75fd1eb44270", "ciphertext": ciphertext}
	}
	value := map[string]interface{}{
		"list":  []interface{}{secret("v1:a"), "b"},
		"inner": map[string]interface{}{"value": secret("v1:x")},
	}
	if got := hideSecrets(value); !reflect.DeepEqual(got, map[string]interface{}{
		"list":  []interface{}{"[secret]", "b"},
		"inner": map[string]interface{}{"value": "[secret]"},
	}) {
		t.Fatalf("hidden %#v", got)
	}
	// it doesn't change what it was given
	if _, ok := value["list"].([]interface{})[0].(map[string]interface{}); !ok {
		t.Fatal("the value was changed")
	}
	for value, want := range map[string]bool{"plain": false, "secret": true, "list": true, "inner": true, "none": false} {
		values := map[string]interface{}{"plain": "a", "secret": secret("v1:s"), "list": []interface{}{"a", secret("v1:l")}, "inner": map[string]interface{}{"x": secret("v1:i")}, "none": map[string]interface{}{"x": []interface{}{1, "b"}}}
		if got := hasSecret(values[value]); got != want {
			t.Errorf("%s: got %v", value, got)
		}
	}
}

func TestParseDevFile(t *testing.T) {
	file := mustParse(t, `
functions:
  Api: functions/api.handler
  Worker:
    handler: cmd/worker
    runtime: go
    streaming: true
commands:
  Web:
    command: npm run dev
`)
	if file.Functions.byName["Api"] != (devFunction{Handler: "functions/api.handler"}) {
		t.Fatalf("api %+v", file.Functions.byName["Api"])
	}
	if file.Functions.byName["Worker"] != (devFunction{Handler: "cmd/worker", Runtime: "go", Streaming: true}) {
		t.Fatalf("worker %+v", file.Functions.byName["Worker"])
	}
	if file.Commands["Web"].Command != "npm run dev" || file.Commands["Web"].Autostart != nil {
		t.Fatalf("web %+v", file.Commands["Web"])
	}
	if _, err := parseDevFile(nil); err != nil {
		t.Fatalf("an empty file: %v", err)
	}
	for text, want := range map[string]string{
		"function:\n  Api: functions/api.handler\n":                              "field function not found: did you mean functions?",
		"commands:\n  Web:\n    command: x\n    env:\n      A: b\n":              "field env not found: did you mean environment?",
		"commands:\n  Web:\n    comand: x\n":                                     "field comand not found: did you mean command?",
		"functions:\n  Api:\n    handlr: a.handler\n":                            "field handlr not found: did you mean handler?",
		"functions:\n  Api:\n    handler: a.handler\n    memory: 128\n":          "field memory not found, expected handler, runtime, streaming",
		"commands:\n  Web: npm run dev\n":                                        "a dev command is a mapping of command,",
		"- functions\n":                                                          "sst.dev.yaml is a mapping of functions and commands",
		"functions:\n  Api:\n    runtime: go\n":                                  `"Api" function needs its handler`,
		"commands:\n  Web:\n    directory: web\n":                                `"Web" dev command needs its command`,
		"functions:\n  api/a: a.handler\n  api-a: b.handler\n":                   `would share the id "api-a"`,
		"commands:\n  Web:\n    command: x\n    autostart: maybe\n":              "a string isn't expected here",
		"functions: [Api]\n":                                                     "a mapping of names to handlers",
		"functions:\n  Api:\n    handler: crates/api\n    runtime: rust\n":       "runtime is rust, which sst pulumi dev doesn't run for a Pulumi program yet",
		"commands:\n  Web:\n    command: npm run dev\n    directory: /srv/web\n": "/srv/web is a full path",
	} {
		_, err := parseDevFile([]byte(text))
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%q: got %v, want %q", text, err, want)
		}
		if err != nil && strings.Contains(err.Error(), "pulumidev") {
			t.Errorf("%q: the error names a type of the CLI's: %v", text, err)
		}
	}
}

func TestFillOutputs(t *testing.T) {
	outputs := map[string]interface{}{"url": "https://api", "port": float64(5432), "tags": map[string]interface{}{"a": "b"}}
	for value, want := range map[string]string{
		"${url}":                     "https://api",
		"${ url }/v1":                "https://api/v1",
		"localhost:${port}":          "localhost:5432",
		"${tags}":                    `{"a":"b"}`,
		"no reference, $HOME, ${url": "no reference, $HOME, ${url",
	} {
		if got, err := fillOutputs(value, outputs, nil); err != nil || got != want {
			t.Errorf("%q: got %q, %v", value, got, err)
		}
	}
	if _, err := fillOutputs("${nope}", outputs, nil); err == nil || !strings.Contains(err.Error(), `"nope"`) || strings.Contains(err.Error(), "did you mean") {
		t.Fatalf("got %v", err)
	}
	if _, err := fillOutputs("${URL}/v1", outputs, nil); err == nil || !strings.HasSuffix(err.Error(), `the stack has no output "URL": did you mean "url"?`) {
		t.Fatalf("got %v", err)
	}
}

func TestDeployErrors(t *testing.T) {
	found := newDeployErrors()
	diagnostic := func(urn, message, severity string) *events.EngineEvent {
		return &events.EngineEvent{EngineEvent: apitype.EngineEvent{DiagnosticEvent: &apitype.DiagnosticEvent{URN: urn, Message: message, Severity: severity}}}
	}
	found.add(diagnostic("urn:a", "  AccessDenied: no  \n", "error"))
	found.add(diagnostic("urn:a", "AccessDenied again", "error"))
	found.add(diagnostic("", "update failed", "error"))
	found.add(diagnostic("urn:b", "failed to register new resource b", "error"))
	found.add(diagnostic("urn:c", "a warning", "warning"))
	found.add(diagnostic("", "the program threw", "error"))
	found.add(&events.EngineEvent{EngineEvent: apitype.EngineEvent{PolicyEvent: &apitype.PolicyEvent{PolicyName: "no-public", Message: " public bucket ", EnforcementLevel: "mandatory", ResourceURN: "urn:d"}}})
	found.add(&events.EngineEvent{EngineEvent: apitype.EngineEvent{PolicyEvent: &apitype.PolicyEvent{PolicyName: "tags", Message: "untagged", EnforcementLevel: "advisory"}}})
	want := []project.Error{
		{Message: "AccessDenied: no", URN: "urn:a"},
		{Message: "the program threw"},
		{Message: "Policy: no-public\npublic bucket", URN: "urn:d"},
	}
	if !reflect.DeepEqual(found.errors, want) {
		t.Fatalf("got %+v", found.errors)
	}
}

func TestTailEvents(t *testing.T) {
	path := filepath.Join(t.TempDir(), "events.json")
	writer, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	reader, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	exited := make(chan struct{})
	got := make(chan []int, 1)
	go func() {
		seen := []int{}
		tailEvents(reader, exited, func(event *events.EngineEvent) {
			seen = append(seen, event.Sequence)
		})
		got <- seen
	}()
	writer.WriteString(`{"sequence": 1}` + "\n" + `{"seque`)
	time.Sleep(150 * time.Millisecond)
	// the rest of a line it had started, and one written as it exits
	writer.WriteString(`nce": 2}` + "\n")
	time.Sleep(150 * time.Millisecond)
	writer.WriteString(`{"sequence": 3}` + "\n")
	writer.Close()
	close(exited)
	select {
	case seen := <-got:
		if !reflect.DeepEqual(seen, []int{1, 2, 3}) {
			t.Fatalf("got %v", seen)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("still reading after pulumi exited")
	}
}

func TestAddLive(t *testing.T) {
	p := &Program{live: map[string]project.FunctionReport{}}
	if _, ok := p.AddLive("api.v1", "api-v1", project.FunctionReport{Handler: "src/api.handler", Dev: true}); !ok {
		t.Fatal("refused")
	}
	// the same function again, as a deploy can ask twice, or another with
	// the same handler
	if _, ok := p.AddLive("api-v1", "api-v1", project.FunctionReport{Handler: "src/api.handler", Dev: true}); !ok {
		t.Fatal("refused")
	}
	// another handler can't share it, and the function that has it is named
	if other, ok := p.AddLive("api-v1", "api-v1", project.FunctionReport{Handler: "src/other.handler", Dev: true}); ok || other != "api.v1" {
		t.Fatalf("got %q, %v", other, ok)
	}
}

func TestProgramFiles(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "index.ts"), `
import * as pulumi from "@pulumi/pulumi";
import { api } from "./infra/api";
import "node:fs";
import shared from "@shop/shared";
export const url = api + shared;
`)
	write(t, filepath.Join(root, "infra", "api.ts"), `import { name } from "../config.json"; export const api = name;`)
	write(t, filepath.Join(root, "config.json"), `{"name": "api"}`)
	// a package, and a workspace package, linked from outside node_modules
	write(t, filepath.Join(root, "node_modules", "@pulumi", "pulumi", "package.json"), `{"name": "@pulumi/pulumi", "main": "index.js"}`)
	write(t, filepath.Join(root, "node_modules", "@pulumi", "pulumi", "index.js"), `module.exports = {}`)
	write(t, filepath.Join(root, "packages", "shared", "package.json"), `{"name": "@shop/shared", "main": "index.ts"}`)
	write(t, filepath.Join(root, "packages", "shared", "index.ts"), `export default 1`)
	if err := os.MkdirAll(filepath.Join(root, "node_modules", "@shop"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "packages", "shared"), filepath.Join(root, "node_modules", "@shop", "shared")); err != nil {
		t.Skip("can't make a symlink here")
	}
	real, _ := filepath.EvalSymlinks(root)
	p := &Program{root: real, config: filepath.Join(real, "Pulumi.yaml"), entry: filepath.Join(real, "index.ts")}
	files := p.programFiles()
	slices.Sort(files)
	want := []string{
		filepath.Join(real, "config.json"),
		filepath.Join(real, "index.ts"),
		filepath.Join(real, "infra", "api.ts"),
		filepath.Join(real, "packages", "shared", "index.ts"),
	}
	if !reflect.DeepEqual(files, want) {
		t.Fatalf("got %v", files)
	}
}

func TestStageOf(t *testing.T) {
	for stack, want := range map[string]string{
		"dev":                         "dev",
		"acme/shop/dev":               "dev",
		"organization/pulumi-dev/dev": "dev",
	} {
		if got := StageOf(stack); got != want {
			t.Errorf("StageOf(%q) = %q", stack, got)
		}
	}
}

func TestStackAws(t *testing.T) {
	value := func(v string) configValue { return configValue{Value: &v} }
	object := func(v string) configValue { return configValue{ObjectValue: json.RawMessage(v)} }

	aws, err := readStackAws(map[string]configValue{
		"aws:profile":     value("lab"),
		"aws:region":      value("us-west-2"),
		"aws:assumeRoles": object(`[{"roleArn": "arn:aws:iam::1:role/a", "sessionName": "s"}, {"roleArn": "arn:aws:iam::1:role/b"}]`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if aws.profile != "lab" || aws.region != "us-west-2" || len(aws.roles) != 2 || aws.roles[0].RoleArn != "arn:aws:iam::1:role/a" || aws.roles[0].SessionName != "s" {
		t.Fatalf("got %+v", aws)
	}

	aws, err = readStackAws(map[string]configValue{"aws:assumeRole": object(`{"roleArn": "arn:aws:iam::1:role/old"}`)})
	if err != nil || len(aws.roles) != 1 || aws.roles[0].RoleArn != "arn:aws:iam::1:role/old" {
		t.Fatalf("got %+v, %v", aws, err)
	}

	if _, err := readStackAws(map[string]configValue{"aws:assumeRoles": object(`[{"roleArn": "arn:aws:iam::1:role/a", "externalId": "x"}]`)}); err == nil {
		t.Fatal("a role with an external ID can't be taken yet")
	}
	// a secret, as an external ID set with --secret makes the whole list,
	// isn't passed over
	for _, key := range []string{"aws:assumeRoles", "aws:profile"} {
		if _, err := readStackAws(map[string]configValue{key: {Secret: true}}); err == nil || !strings.Contains(err.Error(), key+" is a secret") {
			t.Fatalf("%s: got %v", key, err)
		}
	}
	// any other secret is the program's own
	if _, err := readStackAws(map[string]configValue{"shop:token": {Secret: true}}); err != nil {
		t.Fatal(err)
	}

	aws, err = readStackAws(map[string]configValue{})
	if err != nil || aws.profile != "" || aws.region != "" || len(aws.roles) != 0 {
		t.Fatalf("got %+v, %v", aws, err)
	}
}

func TestPathWatch(t *testing.T) {
	repo := t.TempDir()
	if err := os.Mkdir(filepath.Join(repo, ".git"), 0755); err != nil {
		t.Fatal(err)
	}
	infra := filepath.Join(repo, "infra")
	p := &Program{root: infra}
	if got := p.PathWatch(); got != repo {
		t.Fatalf("a Pulumi project watches its repository: got %q", got)
	}
	// without a repository, its own folder
	alone := t.TempDir()
	if got := (&Program{root: alone}).PathWatch(); got != alone {
		t.Fatalf("got %q", got)
	}
}

func TestEnvFor(t *testing.T) {
	p := &Program{name: "shop", stage: "dev"}
	complete := &project.CompleteEvent{Devs: project.Devs{
		"Web":    {Name: "Web", Environment: map[string]string{"API_URL": "https://api"}},
		"Report": {Name: "Report", Aws: &project.DevAws{Role: "arn:aws:iam::123456789012:role/reporter", Only: true}},
	}}
	env, err := p.EnvFor(t.Context(), complete, "Web")
	if err != nil {
		t.Fatal(err)
	}
	if env["API_URL"] != "https://api" || !strings.Contains(env["SST_RESOURCE_App"]+env["SST_RESOURCES_JSON"], `"shop"`) {
		t.Fatalf("got %v", env)
	}
	// a dev command with a role runs as it or not at all
	_, err = p.EnvFor(t.Context(), complete, "Report")
	if err == nil || !strings.Contains(err.Error(), "arn:aws:iam::123456789012:role/reporter") || !strings.Contains(err.Error(), "named in sst.dev.yaml's role") {
		t.Fatalf("got %v", err)
	}
}

func TestLiveID(t *testing.T) {
	for name, want := range map[string]string{
		"Api":             "Api",
		"api-handler_v2":  "api-handler_v2",
		"api/handler":     "api-handler",
		"../escape":       "---escape",
		"urn:with spaces": "urn-with-spaces",
	} {
		if got := liveID(name); got != want {
			t.Errorf("liveID(%q) = %q", name, got)
		}
	}
}

func TestDevContract(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "functions", "api.ts"), "")
	write(t, filepath.Join(root, "functions", "worker.py"), "")
	p := &Program{
		name:       "shop",
		stage:      "dev",
		root:       root,
		config:     filepath.Join(root, "Pulumi.yaml"),
		runtimes:   project.NewRuntimes("", "dev"),
		live:       map[string]project.FunctionReport{},
		asked:      map[string]bool{},
		askedRoles: map[string]bool{},
		here:       map[string]string{},
		dev: mustParse(t, `
functions:
  Api: functions/api.handler
  Image: functions/image.handler
  Worker: functions/worker.handler
  Native: cmd/native
  Cobol:
    handler: src/main
    runtime: cobol
commands:
  Report:
    command: node report.mjs
    role: Reporter
  Elsewhere:
    command: node report.mjs
    role: arn:aws:iam::123456789012:role/Elsewhere
`),
	}
	contract := &devContract{program: p}
	function := func(name, runtime string, image bool) (FunctionAnswer, error) {
		var answer FunctionAnswer
		err := contract.Function(&FunctionInput{Name: name, Runtime: runtime, Image: image}, &answer)
		return answer, err
	}

	// a function the file doesn't name stays as it is
	if answer, err := function("Cron", "nodejs22.x", false); err != nil || answer.Live || answer.Stub != nil {
		t.Fatalf("got %+v, %v", answer, err)
	}
	for name, want := range map[string]string{
		"Image":  "container image",
		"Native": "needs a runtime",
		"Cobol":  `doesn't know the runtime "cobol"`,
		// its source is Python's, and the function is on Node.js
		"Worker": "has no functions/worker.ts, .js or the like",
	} {
		runtime := "nodejs22.x"
		if name == "Native" {
			runtime = ""
		}
		if _, err := function(name, runtime, name == "Image"); err == nil || !strings.Contains(err.Error(), want) || !strings.Contains(err.Error(), DevFile) {
			t.Errorf("%s: got %v, want %q", name, err, want)
		}
	}
	// recorded for the deploy, then refused here for want of a transport, as
	// the CLI's aws provider isn't loaded
	if _, err := function("Api", "nodejs22.x", false); err == nil || !strings.Contains(err.Error(), "aws provider") {
		t.Fatalf("got %v", err)
	}
	if report := p.live["Api"]; report.Handler != "functions/api.handler" || !report.Dev {
		t.Fatalf("live %+v", p.live)
	}
	for _, name := range []string{"Cron", "Image", "Native", "Cobol", "Api"} {
		if !p.asked[name] {
			t.Errorf("%s wasn't recorded as asked about", name)
		}
	}

	// the account takes a role a dev command runs as, by its name
	for name, want := range map[string]bool{"Reporter": true, "Elsewhere": false, "ApiRole": false} {
		var answer RoleAnswer
		if err := contract.Role(&RoleInput{Name: name}, &answer); err != nil || answer.Trust != want {
			t.Errorf("%s: got %+v, %v", name, answer, err)
		}
		if !p.askedRoles[name] {
			t.Errorf("%s wasn't recorded as asked about", name)
		}
	}
}

func TestUnasked(t *testing.T) {
	dev := mustParse(t, `
functions:
  Api: functions/api.handler
  Gone: functions/gone.handler
commands:
  Report:
    command: node report.mjs
    role: Reporter
  Late:
    command: node late.mjs
    role: LateRole
  LeftOut:
    command: node late.mjs
    role: Nobody
  Elsewhere:
    command: node report.mjs
    role: arn:aws:iam::123456789012:role/Elsewhere
`)
	devs := project.Devs{"Report": {}, "Late": {}, "Elsewhere": {}}
	problems := unasked(dev, devs, map[string]bool{"Api": true}, map[string]bool{"Reporter": true})
	if len(problems) != 2 || !strings.Contains(problems[0].Message, `"Gone" function`) || !strings.Contains(problems[0].Message, "The program made Api.") || !strings.Contains(problems[1].Message, `"LateRole"`) {
		t.Fatalf("got %+v", problems)
	}
	// a name like one the program made is likely misspelt
	misspelt := mustParse(t, "functions:\n  OrdersCreate: orders/create.handler\n  Web: web.handler\n")
	problems = unasked(misspelt, project.Devs{}, map[string]bool{"OrderCreate": true, "Api": true, "WebHandler": true}, map[string]bool{})
	if len(problems) != 2 || !strings.HasSuffix(problems[0].Message, `"OrdersCreate" function, which the program didn't make: did you mean "OrderCreate"?`) || !strings.HasSuffix(problems[1].Message, `did you mean "WebHandler"?`) {
		t.Fatalf("got %+v", problems)
	}
}

func TestCommandDirectory(t *testing.T) {
	root, _ := filepath.EvalSymlinks(t.TempDir())
	write(t, filepath.Join(root, DevFile), "commands:\n  Web:\n    command: npm run dev\n    directory: web\n  Here:\n    command: ls\n")
	dev, err := readDevFile(root)
	if err != nil {
		t.Fatal(err)
	}
	// from the file's folder, wherever sst pulumi dev runs
	for cwd, want := range map[string][2]string{
		root:                         {"web", "."},
		filepath.Join(root, "infra"): {filepath.Join("..", "web"), ".."},
	} {
		os.MkdirAll(cwd, 0755)
		t.Chdir(cwd)
		devs, _ := dev.devs(nil, nil, nil)
		if devs["Web"].Directory != want[0] || devs["Here"].Directory != want[1] {
			t.Errorf("from %s: got %q and %q", cwd, devs["Web"].Directory, devs["Here"].Directory)
		}
	}
}

func TestFunctionPatterns(t *testing.T) {
	file := mustParse(t, `
functions:
  Legacy: old/legacy.handler
  orders-*: orders/{name}.handler
  "*": functions/{name}.handler
`)
	for name, want := range map[string][2]string{
		"Legacy":        {"old/legacy.handler", ""},
		"orders-create": {"orders/orders-create.handler", "orders-*"},
		"Api":           {"functions/Api.handler", "*"},
		"api/v2":        {"functions/api/v2.handler", "*"},
	} {
		function, pattern, ok := file.Functions.find(name)
		if !ok || function.Handler != want[0] || pattern != want[1] {
			t.Errorf("%s: got %q from %q, %v", name, function.Handler, pattern, ok)
		}
	}
	// the first pattern that matches, in the file's order
	first := mustParse(t, "functions:\n  \"*\": functions/{name}.handler\n  orders-*: orders/{name}.handler\n")
	if function, pattern, _ := first.Functions.find("orders-create"); pattern != "*" || function.Handler != "functions/orders-create.handler" {
		t.Fatalf("got %q from %q", function.Handler, pattern)
	}
	// ? is one character
	one := mustParse(t, "functions:\n  Api?: functions/{name}.handler\n")
	if _, _, ok := one.Functions.find("Api2"); !ok {
		t.Fatal("Api? should match Api2")
	}
	if _, _, ok := one.Functions.find("Api22"); ok {
		t.Fatal("Api? shouldn't match Api22")
	}
	for text, want := range map[string]string{
		"functions:\n  \"*\": functions/{Name}.handler\n":  "isn't {name}",
		"functions:\n  Api: a.handler\n  Api: b.handler\n": `"Api" function is named twice`,
		"functions: functions/api.handler\n":               "a mapping of names to handlers",
	} {
		if _, err := parseDevFile([]byte(text)); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%q: got %v, want %q", text, err, want)
		}
	}
}

func TestHasSource(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "functions", "api.ts"), "")
	write(t, filepath.Join(root, "py", "main.py"), "")
	write(t, filepath.Join(root, "cmd", "worker", "main.go"), "")
	for handler, want := range map[string]map[string]bool{
		"functions/api.handler":  {"nodejs22.x": true, "python3.12": false},
		"functions/cron.handler": {"nodejs22.x": false},
		"py/main.handler":        {"python3.12": true, "nodejs22.x": false},
		"cmd/worker":             {"go": true},
		"cmd/missing":            {"go": false, "rust": false},
	} {
		for runtime, found := range want {
			if got := hasSource(root, handler, runtime); got != found {
				t.Errorf("%s on %s: got %v", handler, runtime, got)
			}
		}
	}
}

func TestDevContractPattern(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "functions", "Api.ts"), "")
	p := &Program{
		name:       "shop",
		stage:      "dev",
		root:       root,
		config:     filepath.Join(root, "Pulumi.yaml"),
		runtimes:   project.NewRuntimes("", "dev"),
		live:       map[string]project.FunctionReport{},
		asked:      map[string]bool{},
		askedRoles: map[string]bool{},
		here:       map[string]string{},
		cloud:      map[string]string{},
		dev:        mustParse(t, "functions:\n  \"*\": functions/{name}.handler\n"),
	}
	contract := &devContract{program: p}
	function := func(name, runtime string, image bool) (FunctionAnswer, error) {
		var answer FunctionAnswer
		err := contract.Function(&FunctionInput{Name: name, Runtime: runtime, Image: image}, &answer)
		return answer, err
	}
	// what * can't run stays in the cloud, without an error
	for name, input := range map[string]struct {
		runtime string
		image   bool
		reason  string
	}{
		"Cron":   {"nodejs22.x", false, "no functions/Cron.handler"},
		"Image":  {"nodejs22.x", true, "a container image"},
		"Java":   {"java21", false, "sst pulumi dev doesn't run java21"},
		"Native": {"", false, "its runtime isn't known yet"},
	} {
		answer, err := function(name, input.runtime, input.image)
		if err != nil || answer.Live || p.cloud[name] != input.reason {
			t.Errorf("%s: got %+v, %v, %q", name, answer, err, p.cloud[name])
		}
	}
	if got := listFunctions(p.cloud); got != "Cron (no functions/Cron.handler), Image (a container image), Java (sst pulumi dev doesn't run java21), Native (its runtime isn't known yet)" {
		t.Fatalf("got %q", got)
	}
	// one whose source is there runs here: recorded, then refused for want of
	// a transport, as the CLI's aws provider isn't loaded
	if _, err := function("Api", "nodejs22.x", false); err == nil || !strings.Contains(err.Error(), "aws provider") {
		t.Fatalf("got %v", err)
	}
	if report := p.live["Api"]; report.Handler != "functions/Api.handler" {
		t.Fatalf("live %+v", p.live)
	}
	// two whose ids clash, with other handlers: the second stays in the cloud
	write(t, filepath.Join(root, "functions", "a.b.ts"), "")
	write(t, filepath.Join(root, "functions", "a-b.ts"), "")
	if _, err := function("a.b", "nodejs22.x", false); err == nil || !strings.Contains(err.Error(), "aws provider") {
		t.Fatalf("got %v", err)
	}
	if answer, err := function("a-b", "nodejs22.x", false); err != nil || answer.Live || p.cloud["a-b"] != "its id in sst pulumi dev, a-b, is a.b's" {
		t.Fatalf("got %+v, %v, %q", answer, err, p.cloud["a-b"])
	}
	// a pattern that matches no function isn't an error
	if problems := unasked(p.dev, project.Devs{}, p.asked, p.askedRoles); len(problems) != 0 {
		t.Fatalf("got %+v", problems)
	}
}

func TestClosest(t *testing.T) {
	for name, want := range map[string]string{
		"Apii":                "Api",
		"api":                 "Api",
		"Reportr":             "Reporter",
		"OrdersCreateHandlr":  "OrdersCreateHandler",
		"OrdersCreateHandler": "",
		// what holds the name, when it's the only one
		"Web": "WebHandler",
		// too far from any
		"Billing": "",
		"":        "",
	} {
		got := closest(name, []string{"Api", "Reporter", "OrdersDeleteHandler", "OrdersCreateHandler", "WebHandler", "Worker"})
		if got != want {
			t.Errorf("closest(%q) = %q, want %q", name, got, want)
		}
	}
	// more than one holds it: none is likely
	if got := closest("Api", []string{"ApiOne", "ApiTwo"}); got != "" {
		t.Fatalf("got %q", got)
	}
	if got := editDistance("kitten", "sitting"); got != 3 {
		t.Fatalf("got %d", got)
	}
}

func TestReadDevFileSources(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "functions", "api.ts"), "")
	write(t, filepath.Join(root, "functions", "worker.py"), "")
	write(t, filepath.Join(root, "cmd", "native", "main.go"), "")
	write(t, filepath.Join(root, "functions", "nested", "index.ts"), "")
	read := func(text string) error {
		write(t, filepath.Join(root, DevFile), text)
		_, err := readDevFile(root)
		return err
	}
	// a source for any runtime will do before the program says which
	for _, text := range []string{
		"functions:\n  Api: functions/api.handler\n",
		"functions:\n  Worker: functions/worker.handler\n",
		"functions:\n  Native:\n    handler: cmd/native\n    runtime: go\n",
		"functions:\n  Nested: ./functions/nested/index.handler\n",
		"functions:\n  api: functions/{name}.handler\n",
		// a pattern is checked as the program makes each function
		"functions:\n  \"*\": nowhere/{name}.handler\n",
	} {
		if err := read(text); err != nil {
			t.Errorf("%q: %v", text, err)
		}
	}
	for text, want := range map[string]string{
		"functions:\n  Api: functions/apis.handler\n":                                             `the "Api" function's handler is functions/apis.handler, and the folder of Pulumi.yaml has no functions/apis.ts, .js, .py or the like: did you mean functions/api.handler?`,
		"functions:\n  Api: function/api.handler\n":                                               "did you mean functions/api.handler?",
		"functions:\n  Api: functions/nestd/index.handler\n":                                      "did you mean functions/nested/index.handler?",
		"functions:\n  Worker:\n    handler: functions/worker.handler\n    runtime: nodejs22.x\n": "has no functions/worker.ts, .js or the like",
		"functions:\n  Native:\n    handler: cmd/nativ\n    runtime: go\n":                        "has no cmd/nativ: did you mean cmd/native?",
		"functions:\n  Billing: billing/charge.handler\n":                                         "has no billing/charge.ts, .js, .py or the like",
	} {
		err := read(text)
		if err == nil {
			t.Errorf("%q: no error", text)
			continue
		}
		message := readable(t, err)
		if !strings.Contains(message, want) || !strings.HasPrefix(message, DevFile+": ") {
			t.Errorf("%q: got %q, want %q", text, message, want)
		}
	}
	if message := readable(t, read("functions:\n  Billing: billing/charge.handler\n")); strings.Contains(message, "did you mean") {
		t.Errorf("a suggestion for what has nothing near: %q", message)
	}
}

func TestListFunctions(t *testing.T) {
	if got := listFunctions(map[string]string{}); got != "" {
		t.Fatalf("got %q", got)
	}
	if got := listFunctions(map[string]string{"Worker": "functions/Worker.handler", "Api": "functions/api.handler"}); got != "Api (functions/api.handler), Worker (functions/Worker.handler)" {
		t.Fatalf("got %q", got)
	}
	many := map[string]string{}
	for i := 0; i < maxListed+3; i++ {
		many[fmt.Sprintf("Fn%02d", i)] = "functions/{name}.handler"
	}
	if got := listFunctions(many); !strings.HasPrefix(got, "Fn00 (") || !strings.HasSuffix(got, "Fn19 (functions/{name}.handler), and 3 more") {
		t.Fatalf("got %q", got)
	}
}

func TestBuildHandler(t *testing.T) {
	root := filepath.Join(string(filepath.Separator), "repo", "infra")
	for _, test := range []struct{ handler, runtime, want string }{
		{"functions/api.handler", "nodejs22.x", "functions/api.handler"},
		{"worker/main.handler", "python3.12", "worker/main.handler"},
		{"../cmd/worker", "go", filepath.Join(string(filepath.Separator), "repo", "cmd", "worker")},
		{"./", "rust", "./"},
	} {
		if got := buildHandler(root, test.handler, test.runtime); got != test.want {
			t.Errorf("%s on %s: got %q", test.handler, test.runtime, got)
		}
	}
}
