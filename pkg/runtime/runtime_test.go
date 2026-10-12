package runtime_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/sst/sst/v3/pkg/runtime"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type mockRuntime struct {
	matchFn func(string) bool
}

func (m *mockRuntime) Match(r string) bool {
	return m.matchFn(r)
}
func (m *mockRuntime) Build(ctx context.Context, input *runtime.BuildInput) (*runtime.BuildOutput, error) {
	return nil, nil
}
func (m *mockRuntime) Run(ctx context.Context, input *runtime.RunInput) (runtime.Worker, error) {
	return nil, nil
}
func (m *mockRuntime) ShouldRebuild(functionID string, path string) bool {
	return false
}
func (m *mockRuntime) ShouldRunEagerly() bool {
	return true
}

// outputRuntime returns a build output, like a real runtime does
type outputRuntime struct{ mockRuntime }

func (m *outputRuntime) Build(ctx context.Context, input *runtime.BuildInput) (*runtime.BuildOutput, error) {
	return &runtime.BuildOutput{Out: input.Out(), Handler: input.Handler}, nil
}

func TestBuildInputOut(t *testing.T) {
	cfgPath := filepath.Join("/project", "sst.config.ts")
	workingDir := filepath.Join("/project", ".sst")

	t.Run("dev mode", func(t *testing.T) {
		input := &runtime.BuildInput{
			CfgPath:    cfgPath,
			Dev:        true,
			FunctionID: "myFunc",
		}
		expected := filepath.Join(workingDir, "artifacts", "myFunc-dev")
		assert.Equal(t, expected, input.Out())
	})

	t.Run("prod mode", func(t *testing.T) {
		input := &runtime.BuildInput{
			CfgPath:    cfgPath,
			Dev:        false,
			FunctionID: "myFunc",
		}
		expected := filepath.Join(workingDir, "artifacts", "myFunc-src")
		assert.Equal(t, expected, input.Out())
	})
}

func TestCollectionBuildCustomBundle(t *testing.T) {
	projectDir := t.TempDir()
	absoluteBundle := filepath.Join(t.TempDir(), "dist")
	tests := []struct {
		name   string
		bundle string
		want   string
	}{
		{
			name:   "relative path",
			bundle: "./dist",
			want:   filepath.Join(projectDir, "dist"),
		},
		{
			name:   "absolute path",
			bundle: absoluteBundle,
			want:   absoluteBundle,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			input := &runtime.BuildInput{
				CfgPath: filepath.Join(projectDir, "sst.config.ts"),
				Bundle:  tt.bundle,
				Handler: "lambda.handler",
			}

			result, err := runtime.NewCollection(input.CfgPath).Build(context.Background(), input)
			require.NoError(t, err)
			assert.Equal(t, tt.want, result.Out)
			assert.True(t, filepath.IsAbs(result.Out))
			assert.Equal(t, filepath.Join(tt.want, "lambda.handler"), filepath.Join(result.Out, result.Handler))
		})
	}
}

func TestCollectionRuntime(t *testing.T) {
	t.Run("matching runtime found", func(t *testing.T) {
		mr := &mockRuntime{matchFn: func(r string) bool { return r == "nodejs" }}
		c := runtime.NewCollection("cfg", mr)

		rt, ok := c.Runtime("nodejs")
		require.True(t, ok)
		assert.Equal(t, mr, rt)
	})

	t.Run("no match", func(t *testing.T) {
		mr := &mockRuntime{matchFn: func(r string) bool { return false }}
		c := runtime.NewCollection("cfg", mr)

		_, ok := c.Runtime("python")
		assert.False(t, ok)
	})

	t.Run("empty collection", func(t *testing.T) {
		c := runtime.NewCollection("cfg")

		_, ok := c.Runtime("anything")
		assert.False(t, ok)
	})
}

func TestCollectionBuildEncryptedResourceFileWithBundle(t *testing.T) {
	// A 32-byte AES-256 key (all zeroes is fine for testing purposes).
	encryptionKey := base64.StdEncoding.EncodeToString(make([]byte, 32))

	t.Run("writes per-function subdirectory when bundle is set", func(t *testing.T) {
		bundleDir := t.TempDir()

		mr := &mockRuntime{matchFn: func(r string) bool { return r == "nodejs" }}
		c := runtime.NewCollection("cfg", mr)

		input := &runtime.BuildInput{
			FunctionID:    "my-function",
			Handler:       "index.handler",
			Bundle:        bundleDir,
			Runtime:       "nodejs",
			EncryptionKey: encryptionKey,
			Links:         map[string]json.RawMessage{},
		}

		_, err := c.Build(context.Background(), input)
		require.NoError(t, err)

		// Per-function file lives under .sst/<FunctionID>/ so concurrent
		// Build calls sharing the same bundle directory don't race, and the
		// uploaded zip for each function can exclude every sibling's subtree.
		perFunctionPath := filepath.Join(bundleDir, ".sst", "my-function", "resource.enc")
		_, err = os.Stat(perFunctionPath)
		assert.NoError(t, err, "expected %s to exist", perFunctionPath)

		// Default top-level filename is reserved for the non-bundle
		// (per-function artifact directory) path.
		defaultPath := filepath.Join(bundleDir, "resource.enc")
		_, err = os.Stat(defaultPath)
		assert.True(t, os.IsNotExist(err), "default resource.enc should not exist when bundle is set")
	})

	t.Run("distinct functions sharing a bundle write to distinct subdirs", func(t *testing.T) {
		bundleDir := t.TempDir()

		mr := &mockRuntime{matchFn: func(r string) bool { return r == "nodejs" }}
		c := runtime.NewCollection("cfg", mr)

		for _, id := range []string{"fn-a", "fn-b"} {
			input := &runtime.BuildInput{
				FunctionID:    id,
				Handler:       "index.handler",
				Bundle:        bundleDir,
				Runtime:       "nodejs",
				EncryptionKey: encryptionKey,
				Links:         map[string]json.RawMessage{},
			}
			_, err := c.Build(context.Background(), input)
			require.NoError(t, err)
		}

		for _, id := range []string{"fn-a", "fn-b"} {
			p := filepath.Join(bundleDir, ".sst", id, "resource.enc")
			_, err := os.Stat(p)
			assert.NoError(t, err, "expected %s to exist", p)
		}
	})

	t.Run("writes resource.enc at the root of the output when there is no bundle", func(t *testing.T) {
		projectDir := t.TempDir()
		mr := &outputRuntime{mockRuntime{matchFn: func(r string) bool { return r == "nodejs" }}}
		c := runtime.NewCollection(filepath.Join(projectDir, "sst.config.ts"), mr)

		input := &runtime.BuildInput{
			CfgPath:       filepath.Join(projectDir, "sst.config.ts"),
			FunctionID:    "my-function",
			Handler:       "index.handler",
			Runtime:       "nodejs",
			EncryptionKey: encryptionKey,
			Links:         map[string]json.RawMessage{},
		}
		out := input.Out()
		_, err := c.Build(context.Background(), input)
		require.NoError(t, err)
		_, err = os.Stat(filepath.Join(out, "resource.enc"))
		assert.NoError(t, err)
	})
}

func TestCollectionBuildKeepsOutputInDev(t *testing.T) {
	projectDir := t.TempDir()
	cfg := filepath.Join(projectDir, "sst.config.ts")
	mr := &outputRuntime{mockRuntime{matchFn: func(r string) bool { return r == "nodejs" }}}
	c := runtime.NewCollection(cfg, mr)

	input := func(dev bool) *runtime.BuildInput {
		return &runtime.BuildInput{
			CfgPath:    cfg,
			Dev:        dev,
			FunctionID: "my-function",
			Handler:    "index.handler",
			Runtime:    "nodejs",
		}
	}

	// a file a running worker still needs
	out := input(true).Out()
	require.NoError(t, os.MkdirAll(out, 0755))
	bundle := filepath.Join(out, "bundle.mjs")
	require.NoError(t, os.WriteFile(bundle, []byte("// bundle"), 0644))

	_, err := c.Build(context.Background(), input(true))
	require.NoError(t, err)
	_, err = os.Stat(bundle)
	assert.NoError(t, err, "a dev rebuild should leave the output folder alone")

	// a deploy build still starts from an empty folder
	deploy := input(false).Out()
	require.NoError(t, os.MkdirAll(deploy, 0755))
	stale := filepath.Join(deploy, "stale.mjs")
	require.NoError(t, os.WriteFile(stale, []byte("// stale"), 0644))
	_, err = c.Build(context.Background(), input(false))
	require.NoError(t, err)
	_, err = os.Stat(stale)
	assert.True(t, os.IsNotExist(err), "a deploy build should clear the output folder")
}

func TestCollectionBuildDevRelinksCopyFiles(t *testing.T) {
	projectDir := t.TempDir()
	cfg := filepath.Join(projectDir, "sst.config.ts")
	first := filepath.Join(projectDir, "first.txt")
	second := filepath.Join(projectDir, "second.txt")
	require.NoError(t, os.WriteFile(first, []byte("1"), 0644))
	require.NoError(t, os.WriteFile(second, []byte("2"), 0644))

	mr := &outputRuntime{mockRuntime{matchFn: func(r string) bool { return r == "nodejs" }}}
	c := runtime.NewCollection(cfg, mr)
	build := func(from string) *runtime.BuildInput {
		return &runtime.BuildInput{
			CfgPath:    cfg,
			Dev:        true,
			FunctionID: "my-function",
			Handler:    "index.handler",
			Runtime:    "nodejs",
			CopyFiles: []struct {
				From string `json:"from"`
				To   string `json:"to"`
			}{{From: from, To: "data.txt"}},
		}
	}

	input := build(first)
	_, err := c.Build(context.Background(), input)
	require.NoError(t, err)
	link := filepath.Join(input.Out(), "data.txt")
	target, err := os.Readlink(link)
	require.NoError(t, err)
	assert.Equal(t, first, target)

	// the same file again leaves the link alone, a different one replaces it
	_, err = c.Build(context.Background(), build(first))
	require.NoError(t, err)
	_, err = c.Build(context.Background(), build(second))
	require.NoError(t, err)
	target, err = os.Readlink(link)
	require.NoError(t, err)
	assert.Equal(t, second, target)
}
