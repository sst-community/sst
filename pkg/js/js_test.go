package js_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	esbuild "github.com/evanw/esbuild/pkg/api"
	"github.com/sst/sst/v3/pkg/js"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestFormatError(t *testing.T) {
	t.Run("empty slice", func(t *testing.T) {
		assert.Equal(t, "", js.FormatError([]esbuild.Message{}))
	})

	t.Run("no location", func(t *testing.T) {
		msgs := []esbuild.Message{{Text: "something broke"}}
		assert.Equal(t, "something broke", js.FormatError(msgs))
	})

	t.Run("with location", func(t *testing.T) {
		msgs := []esbuild.Message{{
			Text:     "unexpected token",
			Location: &esbuild.Location{File: "app.ts", Line: 10, Column: 5},
		}}
		assert.Equal(t, "app.ts:10:5: unexpected token", js.FormatError(msgs))
	})

	t.Run("multiple errors", func(t *testing.T) {
		msgs := []esbuild.Message{
			{Text: "err1"},
			{Text: "err2", Location: &esbuild.Location{File: "b.ts", Line: 2, Column: 3}},
		}
		assert.Equal(t, "err1\nb.ts:2:3: err2", js.FormatError(msgs))
	})
}

// Builds the code in dir and runs it with node, returning what it printed
func buildAndRun(t *testing.T, input js.EvalOptions) string {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	result, err := js.Build(input)
	require.NoError(t, err)
	defer js.Cleanup(result)
	var bundle string
	for _, file := range result.OutputFiles {
		if strings.HasSuffix(file.Path, ".mjs") {
			bundle = file.Path
		}
	}
	out, err := exec.Command(node, bundle).CombinedOutput()
	require.NoError(t, err, string(out))
	return strings.TrimSpace(string(out))
}

func writeFiles(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for name, contents := range files {
		path := filepath.Join(dir, name)
		require.NoError(t, os.MkdirAll(filepath.Dir(path), 0755))
		require.NoError(t, os.WriteFile(path, []byte(contents), 0644))
	}
}

// The globals a config is given, like `sst` and `aws`, reach every file that
// uses them without declaring them: the config's own files and the packages
// it imports. A file that imports a module under the same name keeps its own,
// and a .cjs file is left as it is.
func TestBuildGlobals(t *testing.T) {
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{
		".sst/platform/fake.mjs":             `export const name = "the global";`,
		"infra.ts":                           `export const name: string = fake.name;`,
		"node_modules/esm/package.json":      `{"name":"esm","type":"module","main":"index.mjs"}`,
		"node_modules/esm/index.mjs":         `export const name = fake.name;`,
		"node_modules/commonjs/package.json": `{"name":"commonjs","main":"index.js"}`,
		"node_modules/commonjs/index.js":     `module.exports = { name: fake.name };`,
		"node_modules/own/package.json":      `{"name":"own","type":"module","main":"index.js"}`,
		"node_modules/own/index.js":          "import * as fake from \"./fake.js\";\nexport const name = fake.name;",
		"node_modules/own/fake.js":           `export const name = "its own";`,
		"node_modules/cjs/package.json":      `{"name":"cjs","main":"index.cjs"}`,
		"node_modules/cjs/index.cjs":         "module.exports = { name: \"commonjs only\" };\nif (true) return;",
	})

	out := buildAndRun(t, js.EvalOptions{
		Dir: dir,
		Globals: []js.Global{{
			Name:   "fake",
			Module: filepath.ToSlash(filepath.Join(dir, ".sst", "platform", "fake.mjs")),
		}},
		Code: `
import { name as infra } from "./infra.ts";
import { name as esm } from "esm";
import commonjs from "commonjs";
import { name as own } from "own";
import cjs from "cjs";
console.log(JSON.stringify([infra, esm, commonjs.name, own, cjs.name]));
`,
	})
	assert.Equal(t, `["the global","the global","the global","its own","commonjs only"]`, out)
}

// An app file or a package that imports \`sst/components\`, or the components
// of a provider like \`sst/components/aws\`, gets the files the \`sst\` global
// is made of, so they share one copy of the components.
func TestBuildPlatformModules(t *testing.T) {
	dir := t.TempDir()
	components := filepath.ToSlash(filepath.Join(dir, ".sst", "platform", "src", "components"))
	writeFiles(t, dir, map[string]string{
		".sst/platform/src/components/index.ts":     "export * from \"./core\";\nexport * as aws from \"./aws/index\";",
		".sst/platform/src/components/core.ts":      `export function component() {}`,
		".sst/platform/src/components/aws/index.ts": `export class Bucket {}`,
		"global.ts":                     `export const component = sst.component; export const Bucket = sst.aws.Bucket;`,
		"infra.ts":                      "export { component } from \"sst/components\";\nexport { Bucket } from \"sst/components/aws\";",
		"node_modules/pkg/package.json": `{"name":"pkg","type":"module","main":"index.mjs"}`,
		"node_modules/pkg/index.mjs":    "export { component } from \"sst/components\";\nexport { Bucket } from \"sst/components/aws\";",
	})

	out := buildAndRun(t, js.EvalOptions{
		Dir:     dir,
		Globals: []js.Global{{Name: "sst", Module: components + "/index.ts"}},
		Platform: map[string]string{
			"sst/components":     components + "/core.ts",
			"sst/components/aws": components + "/aws/index.ts",
		},
		Code: `
import * as global from "./global.ts";
import * as infra from "./infra.ts";
import * as pkg from "pkg";
console.log(typeof global.component, global.component === infra.component, infra.component === pkg.component);
console.log(typeof global.Bucket, global.Bucket === infra.Bucket, infra.Bucket === pkg.Bucket);
`,
	})
	assert.Equal(t, "function true true\nfunction true true", out)
}

// Reading \`app()\` doesn't load what \`run()\` imports from the platform or the
// providers. That build runs before they're installed.
func TestBuildReadingApp(t *testing.T) {
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{
		"sst.config.ts": `
export default $config({
  app() {
    return { name: "my-app" };
  },
  async run() {
    await import("./infra");
    await import("pkg");
  },
});
`,
		"infra.ts": `
import { component } from "sst/components";
import { Bucket } from "sst/components/aws";
import * as aws from "@pulumi/aws";
export const bucket = component("acme:index:Bucket", { bucket: aws.s3.Bucket });
export const files = component("acme:index:Files", { files: Bucket });
`,
		"node_modules/pkg/package.json": `{"name":"pkg","type":"module","main":"index.mjs"}`,
		"node_modules/pkg/index.mjs":    "import * as cloudflare from \"@pulumi/cloudflare\";\nexport const record = cloudflare.DnsRecord;",
	})

	out := buildAndRun(t, js.EvalOptions{
		Dir:    dir,
		Banner: `function $config(input) { return input }`,
		Code:   "import mod from './sst.config.ts';\nconsole.log(JSON.stringify(await mod.app({})));",
	})
	assert.Equal(t, `{"name":"my-app"}`, out)
}

// An error in a file that's given the globals is reported at its own line
func TestBuildErrorLineInAFileWithGlobals(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{
		"sst.ts":   `export const name = "sst";`,
		"aws.ts":   `export const name = "aws";`,
		"infra.ts": "export function fail() {\n  throw new Error(sst.name + aws.name);\n}",
	})
	result, err := js.Build(js.EvalOptions{
		Dir:     dir,
		Globals: []js.Global{{Name: "sst", Module: filepath.Join(dir, "sst.ts")}, {Name: "aws", Module: filepath.Join(dir, "aws.ts")}},
		Code:    "const { fail } = await import(\"./infra.ts\");\nfail();",
	})
	require.NoError(t, err)
	defer js.Cleanup(result)
	var bundle string
	for _, file := range result.OutputFiles {
		if strings.HasSuffix(file.Path, ".mjs") {
			bundle = file.Path
		}
	}
	out, _ := exec.Command(node, "--enable-source-maps", bundle).CombinedOutput()
	assert.Contains(t, string(out), "Error: sstaws")
	assert.Contains(t, string(out), "infra.ts:2:", string(out))
}

// Each group of SST's components the `sst` global has, in groups.ts, is a
// module an app or a package imports, like `sst/components/aws`
func TestPlatformModulesAreTheGroups(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "platform", "src", "components", "groups.ts"))
	require.NoError(t, err)
	expected := []string{"sst/components"}
	for _, match := range regexp.MustCompile(`(\w+): \(\) => import\("\./(\w+)/index"\)`).FindAllStringSubmatch(string(data), -1) {
		require.Equal(t, match[1], match[2], "a group is named for its folder")
		expected = append(expected, "sst/components/"+match[1])
	}
	require.Greater(t, len(expected), 1, "groups.ts lists the groups")
	assert.ElementsMatch(t, expected, js.PlatformModules)
}

// Before the first install, a package `sst install` installs, like one the
// config lists under `packages`, can't be found. Reading `app()` leaves it out,
// and says so if something uses it then. A build that runs the app still
// fails on it.
func TestBuildReadingAppBeforeInstall(t *testing.T) {
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{
		"sst.config.ts": `
export default $config({
  app() {
    return { name: "my-app" };
  },
  async run() {
    await import("./infra");
    await import("@acme/email");
  },
});
`,
		"infra.ts": `import { Uploads } from "@acme/uploads";
export const uploads = Uploads;
`,
		"used.ts": `import stages from "@acme/stages";
export function read() {
  try {
    return stages.stage;
  } catch (e) {
    return e.message;
  }
}
`,
	})
	out := buildAndRun(t, js.EvalOptions{
		Dir:    dir,
		Banner: `function $config(input) { return input }`,
		Code:   "import mod from './sst.config.ts';\nimport { read } from './used.ts';\nconsole.log(JSON.stringify(await mod.app({})));\nconsole.log(read());",
	})
	assert.Equal(t, "{\"name\":\"my-app\"}\n@acme/stages isn't installed yet. A package that `sst install` installs, like one under `packages`, is only loaded in run()", out)

	_, err := js.Build(js.EvalOptions{
		Dir:     dir,
		Globals: []js.Global{{Name: "sst", Module: filepath.Join(dir, "used.ts")}},
		Banner:  `function $config(input) { return input }`,
		Code:    "import mod from './sst.config.ts';\nconsole.log(typeof mod.run);",
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), `Could not resolve "@acme/uploads"`)
	assert.Contains(t, err.Error(), `Could not resolve "@acme/email"`)
}

// A global made of a module that only sets `injectedGlobals`, so a bundle has
// it only when some file was given the globals. The module is in the project's
// .sst folder, as the platform is.
func injectedGlobal(t *testing.T, dir string) []js.Global {
	t.Helper()
	writeFiles(t, dir, map[string]string{
		".sst/platform/injected.mjs": "globalThis.injectedGlobals = true;\nexport const yes = true;",
	})
	return []js.Global{{Name: "injected", Module: filepath.ToSlash(filepath.Join(dir, ".sst", "platform", "injected.mjs"))}}
}

func buildToFile(t *testing.T, input js.EvalOptions) string {
	t.Helper()
	input.Outfile = filepath.Join(input.Dir, ".sst", "platform", "config.mjs")
	result, err := js.Build(input)
	require.NoError(t, err)
	defer js.Cleanup(result)
	contents, err := os.ReadFile(input.Outfile)
	require.NoError(t, err)
	return string(contents)
}

func TestBuildInjectsGlobalsForProjectPathContainingSST(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "app.sst-branch")
	writeFiles(t, dir, map[string]string{
		"source.ts": `if (!injected.yes) throw new Error("missing globals")`,
	})
	contents := buildToFile(t, js.EvalOptions{
		Dir:     dir,
		Code:    `import "./source"`,
		Globals: injectedGlobal(t, dir),
	})
	assert.Contains(t, contents, "injectedGlobals = true")
}

func TestBuildInjectsGlobalsForDirectoryNextToSST(t *testing.T) {
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{
		".sst-old/source.ts": `if (!injected.yes) throw new Error("missing globals")`,
	})
	contents := buildToFile(t, js.EvalOptions{
		Dir:     dir,
		Code:    `import "./.sst-old/source"`,
		Globals: injectedGlobal(t, dir),
	})
	assert.Contains(t, contents, "injectedGlobals = true")
}

func TestBuildLeavesTheProjectSSTDirectoryAlone(t *testing.T) {
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{
		// It uses the global, since an import a .ts file doesn't use is dropped
		".sst/platform/own.ts": `export const own = typeof injected === "undefined" ? "own file" : "given the globals"`,
	})
	contents := buildToFile(t, js.EvalOptions{
		Dir:     dir,
		Code:    `import { own } from "./.sst/platform/own"; console.log(own)`,
		Globals: injectedGlobal(t, dir),
	})
	assert.Contains(t, contents, "own file")
	assert.NotContains(t, contents, "injectedGlobals")
}

func TestBuildLeavesTheProjectSSTDirectoryAloneThroughASymlink(t *testing.T) {
	real := t.TempDir()
	link := filepath.Join(t.TempDir(), "link")
	require.NoError(t, os.Symlink(real, link))
	writeFiles(t, real, map[string]string{
		// It uses the global, since an import a .ts file doesn't use is dropped
		".sst/platform/own.ts": `export const own = typeof injected === "undefined" ? "own file" : "given the globals"`,
	})
	contents := buildToFile(t, js.EvalOptions{
		Dir:     link,
		Code:    `import { own } from "./.sst/platform/own"; console.log(own)`,
		Globals: injectedGlobal(t, link),
	})
	assert.Contains(t, contents, "own file")
	assert.NotContains(t, contents, "injectedGlobals")
}
