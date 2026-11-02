package project

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/pulumi/pulumi/sdk/v3/go/common/workspace"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestWritePulumiYaml(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "Pulumi.yaml")
	// A path YAML would read wrongly if it weren't quoted
	main := filepath.Join(dir, "platform: #1", "sst.config.1.mjs")
	plugins := filepath.Join(dir, "plugins", "sst")
	require.NoError(t, writePulumiYaml(path, "my-app", main, plugins))

	// As Pulumi reads it
	project, err := workspace.LoadProject(path)
	require.NoError(t, err)
	assert.Equal(t, "my-app", string(project.Name))
	assert.Equal(t, "nodejs", project.Runtime.Name())
	assert.Equal(t, main, project.Main)
	require.NotNil(t, project.Plugins)
	assert.Equal(t, []workspace.PluginOptions{{Name: "sst", Path: plugins}}, project.Plugins.Providers)
}

func TestLinkPlugin(t *testing.T) {
	dir := t.TempDir()
	plugins := filepath.Join(dir, "plugins", "sst")
	name := sstPlugin
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	path := filepath.Join(plugins, name)
	write := func(name, content string) string {
		exe := filepath.Join(dir, name)
		require.NoError(t, os.WriteFile(exe, []byte(content), 0755))
		return exe
	}
	first := write("sst-first", "first")
	second := write("sst-second", "second build")

	require.NoError(t, linkPlugin(plugins, first))
	assert.True(t, pluginIs(path, first))
	content, err := os.ReadFile(path)
	require.NoError(t, err)
	assert.Equal(t, "first", string(content))
	before, err := os.Lstat(path)
	require.NoError(t, err)

	// Left alone when it's the binary already
	require.NoError(t, linkPlugin(plugins, first))
	after, err := os.Lstat(path)
	require.NoError(t, err)
	assert.True(t, os.SameFile(before, after))

	// Made again when the binary is another
	require.NoError(t, linkPlugin(plugins, second))
	assert.True(t, pluginIs(path, second))
	assert.False(t, pluginIs(path, first))
	content, err = os.ReadFile(path)
	require.NoError(t, err)
	assert.Equal(t, "second build", string(content))

	// Nothing left beside it
	entries, err := os.ReadDir(plugins)
	require.NoError(t, err)
	assert.Len(t, entries, 1)
}

func TestPluginCopy(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "sst")
	require.NoError(t, os.WriteFile(exe, []byte("binary"), 0755))
	copied := filepath.Join(dir, "copy")
	require.NoError(t, copyExecutable(exe, copied))
	assert.True(t, pluginIs(copied, exe))
	content, err := os.ReadFile(copied)
	require.NoError(t, err)
	assert.Equal(t, "binary", string(content))

	// A new build of the same size, from later
	require.NoError(t, os.WriteFile(exe, []byte("BINARY"), 0755))
	later := time.Now().Add(time.Minute)
	require.NoError(t, os.Chtimes(exe, later, later))
	assert.False(t, pluginIs(copied, exe))

	// A copy is replaced by a link when one can be made
	plugins := filepath.Join(dir, "plugins")
	require.NoError(t, os.MkdirAll(plugins, 0755))
	name := sstPlugin
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	require.NoError(t, os.Rename(copied, filepath.Join(plugins, name)))
	require.NoError(t, linkPlugin(plugins, exe))
	content, err = os.ReadFile(filepath.Join(plugins, name))
	require.NoError(t, err)
	assert.Equal(t, "BINARY", string(content))
}
