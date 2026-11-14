package project

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/sst/sst/v3/pkg/js"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Builds an app that uses a component package, and a package that isn't one
func buildWithPackages(t *testing.T) js.Metafile {
	t.Helper()
	dir := t.TempDir()
	files := map[string]string{
		".sst/platform/src/components/index.ts": `export function component() {}`,
		"node_modules/@acme/email/package.json": `{
			"name": "@acme/email",
			"type": "module",
			"main": "index.mjs",
			"peerDependencies": {
				"sst": ">=5.0.0-0",
				"@pulumi/aws": "^7",
				"@pulumi/cloudflare": "^6",
				"@pulumi/pulumi": "^3"
			}
		}`,
		"node_modules/@acme/email/index.mjs": `
import { component } from "sst/components";
import * as aws from "@pulumi/aws";
import * as cloudflare from "@pulumi/cloudflare";
export const parts = { identity: aws.ses.DomainIdentity, record: cloudflare.DnsRecord, component };
`,
		"node_modules/other/package.json": `{"name":"other","type":"module","main":"index.mjs","peerDependencies":{"@pulumi/gcp":"^8"}}`,
		"node_modules/other/index.mjs":    `export const other = 1;`,
	}
	for name, contents := range files {
		path := filepath.Join(dir, name)
		require.NoError(t, os.MkdirAll(filepath.Dir(path), 0755))
		require.NoError(t, os.WriteFile(path, []byte(contents), 0644))
	}
	result, err := js.Build(js.EvalOptions{
		Dir:      dir,
		Globals:  []js.Global{{Name: "sst", Module: filepath.Join(dir, ".sst/platform/src/components")}},
		Platform: map[string]string{"sst/components": filepath.Join(dir, ".sst/platform/src/components/index.ts")},
		Code:     `import "@acme/email"; import "other";`,
	})
	require.NoError(t, err)
	js.Cleanup(result)
	var meta js.Metafile
	require.NoError(t, json.Unmarshal([]byte(result.Metafile), &meta))
	return meta
}

func TestCheckPackages(t *testing.T) {
	meta := buildWithPackages(t)
	aws := &ProviderLockEntry{Name: "aws", Package: "@pulumi/aws", Version: "7.48.0"}

	t.Run("a provider the app doesn't have", func(t *testing.T) {
		err := checkPackages(meta, "5.0.0", ProviderLock{aws}, sst5Modules)
		require.Error(t, err)
		assert.Equal(t, `"@acme/email" needs the cloudflare provider. Add it with "sst add cloudflare".`, err.Error())
	})

	t.Run("a provider's version the package doesn't work with", func(t *testing.T) {
		cloudflare := &ProviderLockEntry{Name: "cloudflare", Package: "@pulumi/cloudflare", Version: "5.40.0"}
		err := checkPackages(meta, "5.0.0", ProviderLock{aws, cloudflare}, sst5Modules)
		require.Error(t, err)
		assert.Equal(t, `"@acme/email" needs @pulumi/cloudflare ^6, and the app has 5.40.0.`, err.Error())
	})

	t.Run("a version of SST the package doesn't work with", func(t *testing.T) {
		cloudflare := &ProviderLockEntry{Name: "cloudflare", Package: "@pulumi/cloudflare", Version: "6.15.0"}
		err := checkPackages(meta, "4.17.3", ProviderLock{aws, cloudflare}, sst5Modules)
		require.Error(t, err)
		assert.Equal(t, `"@acme/email" needs sst >=5.0.0-0, and this is 4.17.3.`, err.Error())
	})

	t.Run("everything it needs", func(t *testing.T) {
		cloudflare := &ProviderLockEntry{Name: "cloudflare", Package: "@pulumi/cloudflare", Version: "6.15.0"}
		assert.NoError(t, checkPackages(meta, "5.0.0-alpha.1", ProviderLock{aws, cloudflare}, sst5Modules))
		// A dev build isn't checked against the package's range
		assert.NoError(t, checkPackages(meta, "dev", ProviderLock{aws, cloudflare}, sst5Modules))
	})
}

// A package that imports only the components of a provider, like
// `sst/components/aws`, is a component package too
func TestComponentPackagesImportingAGroup(t *testing.T) {
	dir := t.TempDir()
	components := filepath.Join(dir, ".sst/platform/src/components")
	files := map[string]string{
		".sst/platform/src/components/index.ts":     "export * from \"./core\";\nexport * as aws from \"./aws/index\";",
		".sst/platform/src/components/core.ts":      `export function component() {}`,
		".sst/platform/src/components/aws/index.ts": `export class Bucket {}`,
		"node_modules/@acme/uploads/package.json":   `{"name":"@acme/uploads","type":"module","main":"index.mjs"}`,
		"node_modules/@acme/uploads/index.mjs":      `export { Bucket } from "sst/components/aws";`,
	}
	for name, contents := range files {
		path := filepath.Join(dir, name)
		require.NoError(t, os.MkdirAll(filepath.Dir(path), 0755))
		require.NoError(t, os.WriteFile(path, []byte(contents), 0644))
	}
	result, err := js.Build(js.EvalOptions{
		Dir:     dir,
		Globals: []js.Global{{Name: "sst", Module: components}},
		Platform: map[string]string{
			"sst/components":     filepath.Join(components, "core.ts"),
			"sst/components/aws": filepath.Join(components, "aws/index.ts"),
		},
		Code: `import "@acme/uploads";`,
	})
	require.NoError(t, err)
	js.Cleanup(result)
	var meta js.Metafile
	require.NoError(t, json.Unmarshal([]byte(result.Metafile), &meta))

	found := componentPackages(meta, sst5Modules)
	require.Len(t, found, 1)
	assert.True(t, strings.HasSuffix(filepath.ToSlash(found[0]), "node_modules/@acme/uploads"), found[0])
}

// The packages a config lists are installed in the platform, so each one has
// to be a package nothing else installs there
func TestCheckConfigPackages(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"devDependencies":{"@acme/both":"1.0.0"}}`), 0644))
	check := func(packages map[string]string) error {
		p := sst5(&Project{root: dir, app: &App{Packages: packages}})
		return p.checkConfigPackages()
	}
	assert.NoError(t, check(nil))
	assert.NoError(t, check(map[string]string{"@acme/email": "1.2.0", "email-domain": "^2.0.0"}))
	for packages, message := range map[string]string{
		`{"@acme/email":""}`:         `The package "@acme/email" is missing a version.`,
		`{"@pulumi/pulumi":"3.0.0"}`: `SST installs "@pulumi/pulumi" itself. Remove it from packages.`,
		`{"@pulumi/gcp":"8.0.0"}`:    `"@pulumi/gcp" is a provider. Add it to providers instead, with "sst add".`,
		`{"esbuild":"0.21.5"}`:       `SST installs "esbuild" itself. Remove it from packages.`,
		`{"@acme/both":"1.0.0"}`:     `"@acme/both" is in both package.json and the packages in sst.config.ts. Keep it in one of them.`,
	} {
		var parsed map[string]string
		require.NoError(t, json.Unmarshal([]byte(packages), &parsed))
		err := check(parsed)
		require.Error(t, err, packages)
		assert.Equal(t, message, err.Error())
	}
}

// A package the config lists is installed again when it isn't in the
// platform, or the config has another version of it, or no longer lists it.
// What was installed is what the last install that succeeded recorded.
func TestPackagesNeedInstall(t *testing.T) {
	dir := t.TempDir()
	platform := filepath.Join(dir, ".sst", "platform")
	require.NoError(t, os.MkdirAll(platform, 0755))
	p := sst5(&Project{root: dir, app: &App{}})
	assert.False(t, p.packagesNeedInstall(), "none, and none installed")

	p.app.Packages = map[string]string{"@acme/email": "1.2.0"}
	assert.True(t, p.packagesNeedInstall(), "never installed")
	require.NoError(t, p.writeInstalledPackages())
	assert.True(t, p.packagesNeedInstall(), "recorded, but not in node_modules")

	installed := filepath.Join(platform, "node_modules", "@acme", "email")
	require.NoError(t, os.MkdirAll(installed, 0755))
	require.NoError(t, os.WriteFile(filepath.Join(installed, "package.json"), []byte(`{"name":"@acme/email"}`), 0644))
	assert.False(t, p.packagesNeedInstall())

	p.app.Packages = map[string]string{"@acme/email": "1.3.0"}
	assert.True(t, p.packagesNeedInstall(), "another version")
	p.app.Packages = map[string]string{"@acme/email": "1.2.0", "@acme/other": "1.0.0"}
	assert.True(t, p.packagesNeedInstall(), "a package added")
	p.app.Packages = nil
	assert.True(t, p.packagesNeedInstall(), "a package removed")
	require.NoError(t, p.writeInstalledPackages())
	assert.False(t, p.packagesNeedInstall(), "none, after an install")
}

// The platform's package.json gets the packages the config lists, and loses
// one the config no longer lists, which is taken out of node_modules too.
// SST's own dependencies stay.
func TestWritePackageJsonWithPackages(t *testing.T) {
	dir := t.TempDir()
	platform := filepath.Join(dir, ".sst", "platform")
	require.NoError(t, os.MkdirAll(platform, 0755))
	require.NoError(t, os.WriteFile(filepath.Join(platform, "package.json"), []byte(`{"dependencies":{"esbuild":"0.21.5","@acme/old":"1.0.0"}}`), 0644))
	old := filepath.Join(platform, "node_modules", "@acme", "old")
	require.NoError(t, os.MkdirAll(old, 0755))
	p := sst5(&Project{root: dir, app: &App{Packages: map[string]string{"@acme/old": "1.0.0"}}})
	require.NoError(t, p.writeInstalledPackages())

	p.app.Packages = map[string]string{"@acme/email": "1.2.0"}
	require.NoError(t, p.writePackageJson())
	data, err := os.ReadFile(filepath.Join(platform, "package.json"))
	require.NoError(t, err)
	var written js.PackageJson
	require.NoError(t, json.Unmarshal(data, &written))
	assert.Equal(t, "1.2.0", written.Dependencies["@acme/email"])
	assert.Equal(t, "0.21.5", written.Dependencies["esbuild"])
	assert.NotContains(t, written.Dependencies, "@acme/old")
	assert.NoDirExists(t, old)
}
