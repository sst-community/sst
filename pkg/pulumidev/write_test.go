package pulumidev

import (
	"encoding/base64"
	"path/filepath"
	"strings"
	"testing"
)

func TestGuessFunction(t *testing.T) {
	root := t.TempDir()
	// a folder of plain JavaScript, deployed as it is
	write(t, filepath.Join(root, "functions", "api.js"), "export const handler = () => {}")
	// a folder of Python
	write(t, filepath.Join(root, "py", "main.py"), "def handler(e, c): pass")
	// a build with a source map, of a source and a package
	write(t, filepath.Join(root, "src", "orders.ts"), "")
	write(t, filepath.Join(root, "node_modules", "lib", "index.js"), "")
	write(t, filepath.Join(root, "dist", "orders", "index.mjs"), "export const handler = 1\n//# sourceMappingURL=index.mjs.map\n")
	write(t, filepath.Join(root, "dist", "orders", "index.mjs.map"), `{"version":3,"sources":["../../src/orders.ts","../../node_modules/lib/index.js"]}`)
	// a build with an inline source map
	write(t, filepath.Join(root, "src", "billing", "index.ts"), "")
	inline := base64.StdEncoding.EncodeToString([]byte(`{"version":3,"sources":["../../src/billing/index.ts"]}`))
	write(t, filepath.Join(root, "dist", "billing", "index.mjs"), "export const handler = 1\n//# sourceMappingURL=data:application/json;base64,"+inline+"\n")
	// a build that isn't built yet, found by its name
	write(t, filepath.Join(root, "src", "reports.ts"), "")
	// two sources of the same name
	write(t, filepath.Join(root, "src", "users.ts"), "")
	write(t, filepath.Join(root, "legacy", "users.ts"), "")
	// a Go function's folder
	write(t, filepath.Join(root, "cmd", "worker", "main.go"), "package main")

	folder := func(path string) map[string]interface{} {
		return map[string]interface{}{"path": path}
	}
	for name, test := range map[string]struct {
		function previewedFunction
		want     guess
	}{
		"plain JavaScript": {
			previewedFunction{runtime: "nodejs22.x", handler: "api.handler", code: folder("./functions")},
			guess{handler: "functions/api.handler"},
		},
		"Python": {
			previewedFunction{runtime: "python3.12", handler: "main.handler", code: folder("./py")},
			guess{handler: "py/main.handler"},
		},
		"a build's source map": {
			previewedFunction{runtime: "nodejs22.x", handler: "index.handler", code: folder("./dist/orders")},
			guess{handler: "src/orders.handler", note: "from the source map in ./dist/orders"},
		},
		"a build's inline source map": {
			previewedFunction{runtime: "nodejs22.x", handler: "index.handler", code: folder("./dist/billing")},
			guess{handler: "src/billing/index.handler", note: "from the source map in ./dist/billing"},
		},
		"a build not built yet": {
			previewedFunction{runtime: "nodejs22.x", handler: "index.handler", code: folder("./dist/reports")},
			guess{handler: "src/reports.handler", note: "guessed by its name from ./dist/reports"},
		},
		"a zip": {
			previewedFunction{runtime: "nodejs22.x", handler: "index.handler", code: folder("./dist/reports.zip")},
			guess{handler: "src/reports.handler", note: "guessed by its name from ./dist/reports.zip"},
		},
		"a file in an archive": {
			previewedFunction{runtime: "nodejs22.x", handler: "index.handler", code: map[string]interface{}{"assets": map[string]interface{}{
				"index.mjs": map[string]interface{}{"path": "dist/reports.mjs"},
			}}},
			guess{handler: "src/reports.handler", note: "guessed by its name from ./dist/reports.mjs"},
		},
		"two of the name": {
			previewedFunction{runtime: "nodejs22.x", handler: "index.handler", code: folder("./dist/users")},
			guess{handler: "legacy/users.handler", unsure: "sst pulumi dev found more than one source like it: legacy/users.ts, src/users.ts"},
		},
		"none of the name": {
			previewedFunction{runtime: "nodejs22.x", handler: "index.handler", code: folder("./dist/nothing")},
			guess{handler: "path/to/source.handler", unsure: "sst pulumi dev couldn't find its source from ./dist/nothing"},
		},
		"Go": {
			previewedFunction{runtime: "provided.al2023", handler: "bootstrap", code: folder("./dist/worker")},
			guess{handler: "cmd/worker", runtime: "go", note: "guessed by its name from ./dist/worker"},
		},
		"Go from an archive": {
			previewedFunction{runtime: "provided.al2023", handler: "bootstrap", code: map[string]interface{}{"assets": map[string]interface{}{
				"bootstrap": map[string]interface{}{"path": "dist/worker/bootstrap"},
			}}},
			guess{handler: "cmd/worker", runtime: "go", note: "guessed by its name from ./dist/worker"},
		},
		"code in the program": {
			previewedFunction{runtime: "nodejs22.x", handler: "index.handler", code: map[string]interface{}{"assets": map[string]interface{}{
				"index.mjs": map[string]interface{}{"text": "export const handler = () => 1"},
			}}},
			guess{cloud: "its code is written in the program"},
		},
		"code in S3": {
			previewedFunction{runtime: "nodejs22.x", handler: "index.handler"},
			guess{cloud: "its code isn't on this machine"},
		},
		"an image": {
			previewedFunction{image: true},
			guess{cloud: "a container image"},
		},
		"Java": {
			previewedFunction{runtime: "java21", handler: "example.Handler::handleRequest", code: folder("./build/app.jar")},
			guess{cloud: "sst pulumi dev doesn't run java21"},
		},
		"a runtime not known yet": {
			previewedFunction{handler: "index.handler", code: folder("./functions")},
			guess{cloud: "its runtime isn't known before it's deployed"},
		},
	} {
		if got := guessFunction(root, root, test.function); got != test.want {
			t.Errorf("%s: got %+v, want %+v", name, got, test.want)
		}
	}
}

func TestReadPreview(t *testing.T) {
	log := strings.Join([]string{
		`{"sequence":1,"timestamp":1,"resourcePreEvent":{"metadata":{"op":"create","urn":"urn:pulumi:dev::shop::aws:lambda/function:Function::Api","type":"aws:lambda/function:Function","new":{"type":"aws:lambda/function:Function","urn":"urn:pulumi:dev::shop::aws:lambda/function:Function::Api","inputs":{"runtime":"nodejs22.x","handler":"index.handler","packageType":"Zip","code":{"path":"./dist/api"}}}}}}`,
		`{"sequence":2,"timestamp":1,"resourcePreEvent":{"metadata":{"op":"create","urn":"urn:pulumi:dev::shop::my:Component$aws:lambda/function:Function::Image","type":"aws:lambda/function:Function","new":{"inputs":{"packageType":"Image","imageUri":"123.dkr.ecr/x:latest"}}}}}`,
		`{"sequence":3,"timestamp":1,"resourcePreEvent":{"metadata":{"op":"same","urn":"urn:pulumi:dev::shop::aws:lambda/function:Function::Later","type":"aws:lambda/function:Function","new":{"inputs":{"runtime":"04da6b54-80e4-46f7-96ec-b56ff0331ba9","handler":"index.handler"}}}}}`,
		`{"sequence":4,"timestamp":1,"resourcePreEvent":{"metadata":{"op":"create","urn":"urn:pulumi:dev::shop::aws:iam/role:Role::Reporter","type":"aws:iam/role:Role","new":{"inputs":{}}}}}`,
		`{"sequence":5,"timestamp":1,"resourcePreEvent":{"metadata":{"op":"delete","urn":"urn:pulumi:dev::shop::aws:iam/role:Role::Gone","type":"aws:iam/role:Role","old":{"inputs":{}}}}}`,
		`{"sequence":6,"timestamp":1,"resOutputsEvent":{"metadata":{"op":"create","urn":"urn:pulumi:dev::shop::pulumi:pulumi:Stack::shop-dev","type":"pulumi:pulumi:Stack","new":{"outputs":{}}}}}`,
		`not an event`,
		`{"sequence":7,"timestamp":1,"resOutputsEvent":{"metadata":{"op":"create","urn":"urn:pulumi:dev::shop::pulumi:pulumi:Stack::shop-dev","type":"pulumi:pulumi:Stack","new":{"outputs":{"apiUrl":"04da6b54-80e4-46f7-96ec-b56ff0331ba9","bucket":"b","_internal":"x"}}}}}`,
	}, "\n")
	found := readPreview(readEvents([]byte(log)))
	if len(found.functions) != 3 {
		t.Fatalf("functions %+v", found.functions)
	}
	if api := found.functions["Api"]; api.runtime != "nodejs22.x" || api.handler != "index.handler" || api.image || api.code["path"] != "./dist/api" {
		t.Fatalf("api %+v", api)
	}
	if !found.functions["Image"].image {
		t.Fatal("Image is a container image")
	}
	// what the preview doesn't know yet
	if later := found.functions["Later"]; later.runtime != "" || later.handler != "index.handler" {
		t.Fatalf("later %+v", later)
	}
	// a role deleted isn't the program's
	if strings.Join(found.roles, ",") != "Reporter" {
		t.Fatalf("roles %v", found.roles)
	}
	if strings.Join(found.outputs, ",") != "apiUrl,bucket" {
		t.Fatalf("outputs %v", found.outputs)
	}
}

func TestDevFileText(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "src", "api.ts"), "")
	write(t, filepath.Join(root, "functions", "plain.js"), "")
	write(t, filepath.Join(root, "cmd", "worker", "main.go"), "package main")
	write(t, filepath.Join(root, "node_modules", "sst", "schema", "sst.dev.json"), "{}")
	found := &previewed{
		functions: map[string]previewedFunction{
			"Api":    {runtime: "nodejs22.x", handler: "index.handler", code: map[string]interface{}{"path": "./dist/api"}},
			"Plain":  {runtime: "nodejs22.x", handler: "plain.handler", code: map[string]interface{}{"path": "./functions"}},
			"Worker": {runtime: "provided.al2023", handler: "bootstrap", code: map[string]interface{}{"path": "./dist/worker"}},
			"Lost":   {runtime: "provided.al2023", handler: "bootstrap", code: map[string]interface{}{"path": "./dist/lost"}},
			"Cron":   {runtime: "nodejs22.x", handler: "index.handler", code: map[string]interface{}{"assets": map[string]interface{}{"index.mjs": map[string]interface{}{"text": "x"}}}},
			"api v2": {runtime: "nodejs22.x", handler: "index.handler", code: map[string]interface{}{"path": "./dist/nothing"}},
		},
		roles:   []string{"ApiRole", "Reporter"},
		outputs: []string{"apiUrl", "reportsBucket"},
	}
	written := devFileText(root, "dev", found)
	for _, part := range []string{
		"# yaml-language-server: $schema=./node_modules/sst/schema/sst.dev.json\n",
		`a preview of the` + "\n# \"dev\" stack",
		"  Api: src/api.handler # guessed by its name from ./dist/api: check it\n",
		"  Plain: functions/plain.handler\n",
		"  Worker: # guessed by its name from ./dist/worker: check it\n    handler: cmd/worker\n    runtime: go\n",
		"  # Lost: # on provided.al2023, it needs its source, and runtime: go\n  #   handler: path/to/source\n  #   runtime: go\n",
		`  # "api v2": path/to/source.handler # sst pulumi dev couldn't find its source from ./dist/nothing` + "\n",
		"# Cron: its code is written in the program\n",
		"#       API_URL: ${apiUrl}\n",
		"# The stack's outputs, for ${name}: apiUrl, reportsBucket\n",
		"# Its roles, for a command's role: ApiRole, Reporter\n",
	} {
		if !strings.Contains(written.Text, part) {
			t.Errorf("the file doesn't have %q:\n%s", part, written.Text)
		}
	}
	if written.Here != 3 || written.Cloud != 3 || strings.Join(written.Guessed, ",") != "Api,Worker" {
		t.Fatalf("got %d here, %d in the cloud, guessed %v", written.Here, written.Cloud, written.Guessed)
	}
	// sst pulumi dev reads what it wrote, and finds the sources
	write(t, filepath.Join(root, DevFile), written.Text)
	dev, err := readDevFile(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(dev.Functions.byName) != 3 || dev.Functions.byName["Worker"].Runtime != "go" || len(dev.Commands) != 0 {
		t.Fatalf("got %+v", dev)
	}

	// a program with no function
	empty := devFileText(root, "dev", &previewed{functions: map[string]previewedFunction{}})
	if !strings.Contains(empty.Text, "# The program made no function.\nfunctions:\n") {
		t.Fatalf("got %s", empty.Text)
	}
	if _, err := parseDevFile([]byte(empty.Text)); err != nil {
		t.Fatal(err)
	}
}

func TestSchemaPath(t *testing.T) {
	repo := t.TempDir()
	project := filepath.Join(repo, "infra")
	if got := schemaPath(project); got != "./node_modules/sst/schema/sst.dev.json" {
		t.Fatalf("with none installed: %q", got)
	}
	// in a monorepo, installed a folder up
	write(t, filepath.Join(repo, "node_modules", "sst", "schema", "sst.dev.json"), "{}")
	if got := schemaPath(project); got != "../node_modules/sst/schema/sst.dev.json" {
		t.Fatalf("got %q", got)
	}
}

func TestYamlScalar(t *testing.T) {
	for value, want := range map[string]string{
		"Api":                   "Api",
		"orders-create":         "orders-create",
		"functions/api.handler": "functions/api.handler",
		"api v2":                `"api v2"`,
		"a:b":                   `"a:b"`,
		"true":                  `"true"`,
		"#hash":                 `"#hash"`,
	} {
		if got := yamlScalar(value); got != want {
			t.Errorf("%q: got %s", value, got)
		}
	}
	for output, want := range map[string]string{"apiUrl": "API_URL", "bucket": "BUCKET", "db-host": "DB_HOST"} {
		if got := envName(output); got != want {
			t.Errorf("%q: got %s", output, got)
		}
	}
}
