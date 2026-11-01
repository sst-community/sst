package project

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestWriteTsconfig(t *testing.T) {
	dir := t.TempDir()
	platform := filepath.Join(dir, ".sst", "platform")
	for _, d := range []string{
		"dist/types",
		"node_modules/@pulumi/pulumi",
		"node_modules/@pulumi/aws",
		"node_modules/@pulumiverse/vercel",
	} {
		require.NoError(t, os.MkdirAll(filepath.Join(platform, d), 0755))
	}
	require.NoError(t, os.WriteFile(filepath.Join(platform, "dist/types/global.d.ts"), nil, 0644))
	// A provider's types are where its package.json says
	require.NoError(t, os.WriteFile(filepath.Join(platform, "node_modules/@pulumi/aws/package.json"), []byte(`{"types": "./index.d.ts"}`), 0644))
	require.NoError(t, os.WriteFile(filepath.Join(platform, "node_modules/@pulumi/aws/index.d.ts"), nil, 0644))

	p := &Project{root: dir}
	require.NoError(t, p.writeTsconfig())

	data, err := os.ReadFile(filepath.Join(dir, ".sst", "tsconfig.json"))
	require.NoError(t, err)
	var config struct {
		CompilerOptions struct {
			Paths map[string][]string `json:"paths"`
		} `json:"compilerOptions"`
	}
	require.NoError(t, json.Unmarshal(data, &config))
	assert.Equal(t, map[string][]string{
		"sst/components":            {"./platform/dist/types/components/core.d.ts"},
		"sst/components/aws":        {"./platform/dist/types/components/aws/index.d.ts"},
		"sst/components/cloudflare": {"./platform/dist/types/components/cloudflare/index.d.ts"},
		"sst/components/vercel":     {"./platform/dist/types/components/vercel/index.d.ts"},
		"sst/testing":               {"./platform/dist/types/testing/index.d.ts"},
		"@pulumi/pulumi":            {"./platform/node_modules/@pulumi/pulumi"},
		"@pulumi/pulumi/*":          {"./platform/node_modules/@pulumi/pulumi/*"},
		"@pulumi/aws":               {"./platform/node_modules/@pulumi/aws/index.d.ts"},
		"@pulumi/aws/*":             {"./platform/node_modules/@pulumi/aws/*"},
		"@pulumiverse/vercel":       {"./platform/node_modules/@pulumiverse/vercel"},
		"@pulumiverse/vercel/*": {
			"./platform/node_modules/@pulumiverse/vercel/*",
		},
	}, config.CompilerOptions.Paths)
}

// A package the config lists is where `sst install` puts it, in the platform
func TestWriteTsconfigWithPackages(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(dir, ".sst", "platform"), 0755))
	p := &Project{root: dir, app: &App{Packages: map[string]string{"@acme/email": "1.2.0"}}}
	require.NoError(t, p.writeTsconfig())

	data, err := os.ReadFile(filepath.Join(dir, ".sst", "tsconfig.json"))
	require.NoError(t, err)
	var config struct {
		CompilerOptions struct {
			Paths map[string][]string `json:"paths"`
		} `json:"compilerOptions"`
	}
	require.NoError(t, json.Unmarshal(data, &config))
	assert.Equal(t, []string{"./platform/node_modules/@acme/email"}, config.CompilerOptions.Paths["@acme/email"])
	assert.Equal(t, []string{"./platform/node_modules/@acme/email/*"}, config.CompilerOptions.Paths["@acme/email/*"])
}

// Under NodeNext, TypeScript follows a path only to a file
func TestPackageTypes(t *testing.T) {
	for name, tc := range map[string]struct {
		pkg   string
		files []string
		want  string
	}{
		"main export":  {`{"types": "old.d.ts", "exports": {".": {"types": "./dist/index.d.ts", "default": "./dist/index.js"}}}`, []string{"old.d.ts", "dist/index.d.ts"}, "dist/index.d.ts"},
		"condition":    {`{"exports": {".": {"import": {"types": "./esm/index.d.ts", "default": "./esm/index.js"}}}}`, []string{"esm/index.d.ts"}, "esm/index.d.ts"},
		"types":        {`{"types": "./lib/index.d.ts"}`, []string{"lib/index.d.ts"}, "lib/index.d.ts"},
		"typings":      {`{"typings": "index.d.ts"}`, []string{"index.d.ts"}, "index.d.ts"},
		"no extension": {`{"types": "dist/index"}`, []string{"dist/index.d.ts"}, "dist/index.d.ts"},
		"beside main":  {`{"main": "lib/index.js"}`, []string{"lib/index.d.ts"}, "lib/index.d.ts"},
		"index":        {`{"exports": "./index.js"}`, []string{"index.d.ts"}, "index.d.ts"},
		// A file that isn't there is passed over
		"missing": {`{"types": "gone.d.ts", "main": "bin/index.js"}`, nil, ""},
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			require.NoError(t, os.WriteFile(filepath.Join(dir, "package.json"), []byte(tc.pkg), 0644))
			for _, file := range tc.files {
				require.NoError(t, os.MkdirAll(filepath.Dir(filepath.Join(dir, file)), 0755))
				require.NoError(t, os.WriteFile(filepath.Join(dir, file), nil, 0644))
			}
			assert.Equal(t, tc.want, packageTypes(dir))
		})
	}
	assert.Equal(t, "", packageTypes(t.TempDir()))
}
