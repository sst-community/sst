package pulumidev

import (
	"errors"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/sst/sst/v3/pkg/project"
)

// noSecretsShown is a read of the state in the clear that a test doesn't
// expect: an export with no record that holds a secret never asks for one
func noSecretsShown(t *testing.T) func() ([]byte, error) {
	return func() ([]byte, error) {
		t.Fatal("the state was read in the clear")
		return nil, nil
	}
}

// What SST's components record in a stack's state for sst pulumi dev, as `pulumi
// stack export` prints it. The DevCommand's token and the secret's value are
// secrets, encrypted here, and in the clear in exportShown.
const exportWithRecords = `{"version": 3, "deployment": {"manifest": {"time": "2026-11-12T00:00:00Z", "magic": "", "version": ""}, "resources": [
  {"urn": "urn:pulumi:dev::shop::pulumi:pulumi:Stack::shop-dev", "type": "pulumi:pulumi:Stack", "outputs": {"url": "https://shop.example.com"}},
  {"urn": "urn:pulumi:dev::shop::sst:aws:Function::Api", "type": "sst:aws:Function", "outputs": {"_sst": {"contract": 1, "function": {"handler": "functions/api.handler", "dev": true}}}},
  {"urn": "urn:pulumi:dev::shop::sst:aws:Function::Warmer", "type": "sst:aws:Function", "outputs": {"_sst": {"contract": 1, "function": {"handler": "index.handler", "internal": true, "dev": true}}}},
  {"urn": "urn:pulumi:dev::shop::sst:aws:Function::Cron", "type": "sst:aws:Function", "outputs": {"_sst": {"contract": 1, "function": {"handler": "functions/cron.handler"}}}},
  {"urn": "urn:pulumi:dev::shop::sst:sst:DevCommand::Worker", "type": "sst:sst:DevCommand", "outputs": {"_sst": {"contract": 1, "dev": {"command": "node worker.mjs", "autostart": true, "links": ["Files", "Key"], "environment": {"TOKEN": {"4dabf18193072939515e22adb298388d": "1b47061264138c4ac30d75fd1eb44270", "ciphertext": "v1:abc"}}}}}},
  {"urn": "urn:pulumi:dev::shop::sst:sst:LinkRef::FilesLinkRef", "type": "sst:sst:LinkRef", "outputs": {"target": "Files", "properties": {"type": "sst.aws.Bucket", "name": "shop-dev-files-abc"}}},
  {"urn": "urn:pulumi:dev::shop::sst:sst:LinkRef::KeyLinkRef", "type": "sst:sst:LinkRef", "outputs": {"target": "Key", "properties": {"4dabf18193072939515e22adb298388d": "1b47061264138c4ac30d75fd1eb44270", "ciphertext": "v1:def"}}},
  {"urn": "urn:pulumi:dev::shop::aws:s3/bucketV2:BucketV2::Raw", "type": "aws:s3/bucketV2:BucketV2", "outputs": {"bucket": "raw", "secretish": {"4dabf18193072939515e22adb298388d": "1b47061264138c4ac30d75fd1eb44270", "ciphertext": "v1:ghi"}}}
]}}`

// exportWithRecords with its secrets in the clear, as
// `pulumi stack export --show-secrets` prints it
var exportShown = strings.NewReplacer(
	`"ciphertext": "v1:abc"`, `"plaintext": "\"shh\""`,
	`"ciphertext": "v1:def"`, `"plaintext": "{\"type\":\"sst.sst.Secret\",\"value\":\"open sesame\"}"`,
	`"ciphertext": "v1:ghi"`, `"plaintext": "\"not read\""`,
).Replace(exportWithRecords)

func TestCompletedReadsComponentRecords(t *testing.T) {
	dev := mustParse(t, `
commands:
  Worker:
    command: node other.mjs
  Web:
    command: npm run dev
`)
	shown := 0
	showingSecrets := func() ([]byte, error) {
		shown++
		return []byte(exportShown), nil
	}
	complete, err := completedFromExport([]byte(exportWithRecords), dev, nil, showingSecrets)
	if err != nil {
		t.Fatal(err)
	}
	if shown != 1 {
		t.Fatalf("the state was read in the clear %d times", shown)
	}

	// the functions SST's components run here, and those they don't
	if api := complete.Functions["Api"]; api.Handler != "functions/api.handler" || !api.Dev || api.Internal {
		t.Fatalf("api %+v", api)
	}
	if warmer := complete.Functions["Warmer"]; !warmer.Internal {
		t.Fatalf("warmer %+v", warmer)
	}
	if cron := complete.Functions["Cron"]; cron.Dev {
		t.Fatalf("cron %+v", cron)
	}

	// a DevCommand's record, its secret in the clear, and its links
	worker := complete.Devs["Worker"]
	if worker.Name != "Worker" || worker.Command != "node worker.mjs" || !worker.Autostart || worker.Environment["TOKEN"] != "shh" || !slices.Equal(worker.Links, []string{"Files", "Key"}) {
		t.Fatalf("worker %+v", worker)
	}
	if files := complete.Links["Files"].Properties; files["name"] != "shop-dev-files-abc" {
		t.Fatalf("files %+v", files)
	}
	if key := complete.Links["Key"].Properties; key["value"] != "open sesame" {
		t.Fatalf("key %+v", key)
	}
	// what the dev command runs with, as for an SST app
	env := map[string]string{}
	project.AddDevEnv(env, complete, "Worker", "shop", "dev")
	if !strings.Contains(env["SST_RESOURCE_Files"], "shop-dev-files-abc") || !strings.Contains(env["SST_RESOURCE_Key"], "open sesame") || env["TOKEN"] != "shh" {
		t.Fatalf("env %v", env)
	}

	// DevFile's commands are there too, but one named as a DevCommand is
	if web := complete.Devs["Web"]; web.Command != "npm run dev" {
		t.Fatalf("web %+v", web)
	}
	if len(complete.Errors) != 1 || !strings.Contains(complete.Errors[0].Message, `the dev command "Worker"`) {
		t.Fatalf("errors %+v", complete.Errors)
	}

	// nothing of the state in the clear is kept but the records: a secret
	// output stays hidden
	if complete.Outputs["url"] != "https://shop.example.com" {
		t.Fatalf("outputs %v", complete.Outputs)
	}
	for _, link := range complete.Links {
		for _, value := range link.Properties {
			if value == "not read" {
				t.Fatal("a resource's own secret was read")
			}
		}
	}
}

func TestCompletedReadsRecordsWithoutSecrets(t *testing.T) {
	// with no secret in a record, the state isn't read in the clear, even
	// though another resource has one
	export := strings.ReplaceAll(exportWithRecords, `{"4dabf18193072939515e22adb298388d": "1b47061264138c4ac30d75fd1eb44270", "ciphertext": "v1:abc"}`, `"plain"`)
	export = strings.ReplaceAll(export, `{"4dabf18193072939515e22adb298388d": "1b47061264138c4ac30d75fd1eb44270", "ciphertext": "v1:def"}`, `{"type": "sst.sst.Secret", "value": "v"}`)
	complete, err := completedFromExport([]byte(export), nil, nil, noSecretsShown(t))
	if err != nil {
		t.Fatal(err)
	}
	if complete.Devs["Worker"].Environment["TOKEN"] != "plain" || complete.Links["Key"].Properties["value"] != "v" {
		t.Fatalf("got %+v", complete)
	}
}

func TestCompletedRecordsShownFails(t *testing.T) {
	_, err := completedFromExport([]byte(exportWithRecords), nil, nil, func() ([]byte, error) {
		return nil, errors.New("no passphrase")
	})
	if err == nil || !strings.Contains(err.Error(), "no passphrase") {
		t.Fatalf("got %v", err)
	}
}

func TestDevFileWithComponents(t *testing.T) {
	root := t.TempDir()
	// a program of SST's components needs no DevFile
	if dev, err := readDevFileFor(root, true); err != nil || dev == nil || len(dev.Commands) != 0 {
		t.Fatalf("got %+v, %v", dev, err)
	}
	// and one without them does, as before
	if _, err := readDevFileFor(root, false); !errors.Is(err, ErrNoDevFile) {
		t.Fatalf("got %v", err)
	}
	// a DevFile there is read either way
	write(t, filepath.Join(root, DevFile), "commands:\n  Web:\n    command: npm run dev\n")
	if dev, err := readDevFileFor(root, true); err != nil || dev.Commands["Web"].Command != "npm run dev" {
		t.Fatalf("got %+v, %v", dev, err)
	}
}

func TestScanFindsComponents(t *testing.T) {
	for name, test := range map[string]struct {
		program    string
		components bool
	}{
		"a group":           {`import { Function } from "sst/components/aws";`, true},
		"the core":          {`import { Linkable } from "sst/components";`, true},
		"through a file":    {`import "./infra";`, true},
		"sst/pulumi alone":  {`import "sst/pulumi";`, false},
		"Pulumi's own only": {`import * as aws from "@pulumi/aws";`, false},
	} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			write(t, filepath.Join(root, "index.ts"), test.program+"\n")
			write(t, filepath.Join(root, "infra.ts"), `export { StaticSite } from "sst/components/aws";`+"\n")
			scan := scanProgram(root, filepath.Join(root, "index.ts"))
			if scan.components != test.components {
				t.Fatalf("components %v", scan.components)
			}
			if !slices.Contains(scan.files, filepath.Join(root, "index.ts")) {
				t.Fatalf("files %v", scan.files)
			}
		})
	}
}

func TestFunctionInComponent(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "functions", "api.ts"), "")
	p := &Program{
		root:       root,
		runtimes:   project.NewRuntimes("", "dev"),
		live:       map[string]project.FunctionReport{},
		asked:      map[string]bool{},
		askedRoles: map[string]bool{},
		cloud:      map[string]string{},
		here:       map[string]string{},
		dev: mustParse(t, `
functions:
  ApiFunction: functions/api.handler
  "*": functions/{name}.handler
`),
	}
	contract := &devContract{program: p}
	component := &ComponentInput{Type: "sst:aws:Function", Name: "Api"}
	function := func(name string) (FunctionAnswer, error) {
		var answer FunctionAnswer
		err := contract.Function(&FunctionInput{Name: name, Runtime: "nodejs22.x", Component: component}, &answer)
		return answer, err
	}

	// a pattern doesn't take a function SST's component makes, and it isn't
	// listed as left in the cloud: the component runs it here or doesn't
	if answer, err := function("WebFunction"); err != nil || answer.Live {
		t.Fatalf("got %+v, %v", answer, err)
	}
	if len(p.cloud) != 0 || len(p.live) != 0 {
		t.Fatalf("cloud %v, live %v", p.cloud, p.live)
	}
	// and a name the file gives it exactly says whose it is
	_, err := function("ApiFunction")
	if err == nil || !strings.Contains(err.Error(), `SST's sst:aws:Function "Api"`) || !strings.Contains(err.Error(), "take it out of "+DevFile) {
		t.Fatalf("got %v", err)
	}
	if !p.asked["ApiFunction"] || !p.asked["WebFunction"] {
		t.Fatalf("asked %v", p.asked)
	}
}
