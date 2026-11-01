package project

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestPluginsIn(t *testing.T) {
	dir := t.TempDir()
	write := func(name, pkg string) {
		require.NoError(t, os.MkdirAll(filepath.Join(dir, name), 0755))
		require.NoError(t, os.WriteFile(filepath.Join(dir, name, "package.json"), []byte(pkg), 0644))
	}
	write("@pulumi/aws", `{"name": "@pulumi/aws", "version": "7.48.0", "pulumi": {"resource": true, "name": "aws", "version": "7.48.0"}}`)
	write("@pulumiverse/vercel", `{"name": "@pulumiverse/vercel", "version": "4.6.0", "pulumi": {"resource": true, "name": "vercel", "version": "4.6.0", "server": "github://api.github.com/pulumiverse"}}`)
	// Its name and version from the package's when its pulumi field has none
	write("@pulumi/random", `{"name": "@pulumi/random", "version": "4.21.2", "pulumi": {"resource": true}}`)
	write("plain-provider", `{"name": "plain-provider", "version": "1.0.0", "pulumi": {"resource": true, "name": "plain"}}`)
	// Not providers
	write("@pulumi/pulumi", `{"name": "@pulumi/pulumi", "version": "3.267.0", "pulumi": {"comment": "deployment-time only"}}`)
	write("esbuild", `{"name": "esbuild", "version": "0.21.5"}`)
	require.NoError(t, os.MkdirAll(filepath.Join(dir, ".bin"), 0755))

	assert.ElementsMatch(t, []plugin{
		{Name: "aws", Version: "7.48.0"},
		{Name: "vercel", Version: "4.6.0", Server: "github://api.github.com/pulumiverse"},
		{Name: "random", Version: "4.21.2"},
		{Name: "plain", Version: "1.0.0"},
	}, pluginsIn(dir))
	assert.Empty(t, pluginsIn(filepath.Join(dir, "missing")))
}

func TestPluginInstalled(t *testing.T) {
	home := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(home, "plugins", "resource-aws-v7.48.0"), 0755))
	assert.True(t, plugin{Name: "aws", Version: "7.48.0"}.installed(home))
	assert.True(t, plugin{Name: "aws", Version: "v7.48.0"}.installed(home))
	assert.False(t, plugin{Name: "aws", Version: "7.49.0"}.installed(home))
	assert.False(t, plugin{Name: "random", Version: "4.21.2"}.installed(home))

	// An install stopped partway
	require.NoError(t, os.MkdirAll(filepath.Join(home, "plugins", "resource-tls-v5.6.1"), 0755))
	require.NoError(t, os.WriteFile(filepath.Join(home, "plugins", "resource-tls-v5.6.1.partial"), nil, 0644))
	assert.False(t, plugin{Name: "tls", Version: "5.6.1"}.installed(home))
}
