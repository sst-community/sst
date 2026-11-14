package target

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const settings = `{
  "name": "emulator",
  "endpoint": "http://127.0.0.1:4566",
  "region": "us-east-1",
  "credentials": { "accessKeyId": "test", "secretAccessKey": "test" },
  "providers": { "aws": { "s3UsePathStyle": true } },
  "container": {
    "image": "example/emulator:1.0.0",
    "ports": [4566, 4510],
    "env": { "EMULATOR_MODE": "persistent" },
    "volumes": { "/app/data": "data" }
  }
}`

func parse(t *testing.T, change func(map[string]any)) (*Local, error) {
	t.Helper()
	var raw map[string]any
	require.NoError(t, json.Unmarshal([]byte(settings), &raw))
	if change != nil {
		change(raw)
	}
	data, err := json.Marshal(raw)
	require.NoError(t, err)
	return Parse(data)
}

func TestParse(t *testing.T) {
	local, err := parse(t, nil)
	require.NoError(t, err)
	assert.Equal(t, "emulator", local.Name())

	cases := map[string]struct {
		change func(map[string]any)
		err    string
	}{
		"a name that isn't one": {func(s map[string]any) { s["name"] = "My Emulator" }, "lowercase letters"},
		// A target's calls stay on this machine
		"an endpoint elsewhere":      {func(s map[string]any) { s["endpoint"] = "https://s3.amazonaws.com" }, "on this machine"},
		"an endpoint on the network": {func(s map[string]any) { s["endpoint"] = "http://192.168.1.20:4566" }, "on this machine"},
		"no region":                  {func(s map[string]any) { s["region"] = "" }, "needs a region"},
		"no credentials":             {func(s map[string]any) { s["credentials"] = map[string]any{} }, "needs credentials"},
		"no aws settings":            {func(s map[string]any) { s["providers"] = map[string]any{} }, "aws provider"},
		"another provider": {func(s map[string]any) {
			s["providers"] = map[string]any{"aws": map[string]any{}, "cloudflare": map[string]any{}}
		}, "cloudflare"},
		"no image": {func(s map[string]any) { s["container"].(map[string]any)["image"] = "" }, "needs an image"},
		// Only Docker volumes of its own: no folder of this machine
		"a folder that isn't one": {func(s map[string]any) {
			s["container"].(map[string]any)["volumes"] = map[string]any{"data": "data"}
		}, "isn't a folder"},
		"a volume that's a path": {func(s map[string]any) {
			s["container"].(map[string]any)["volumes"] = map[string]any{"/data": "/Users/me"}
		}, "names a volume"},
		"a port that isn't one": {func(s map[string]any) { s["container"].(map[string]any)["ports"] = []any{70000} }, "port"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := parse(t, c.change)
			require.Error(t, err)
			assert.Contains(t, err.Error(), c.err)
		})
	}

	t.Run("localhost", func(t *testing.T) {
		_, err := parse(t, func(s map[string]any) { s["endpoint"] = "http://localhost:4566" })
		assert.NoError(t, err)
	})
}

func TestRunArgs(t *testing.T) {
	local, err := parse(t, nil)
	require.NoError(t, err)
	args, digest := local.settings.Container.runArgs("emulator")
	line := strings.Join(args, " ")

	// Every port on 127.0.0.1, and nothing published elsewhere
	assert.Contains(t, line, "--publish 127.0.0.1:4510:4510 --publish 127.0.0.1:4566:4566")
	assert.Equal(t, 2, strings.Count(line, "--publish"))
	assert.Contains(t, line, "--volume sst-target-emulator-data:/app/data")
	assert.Contains(t, line, "--env EMULATOR_MODE=persistent")
	assert.Contains(t, line, "--label sst.target.settings="+digest)
	assert.Equal(t, "example/emulator:1.0.0", args[len(args)-1])
	// The Docker socket only when the target says it needs it
	assert.NotContains(t, line, "docker.sock")

	local.settings.Container.DockerSocket = true
	withSocket, other := local.settings.Container.runArgs("emulator")
	assert.Contains(t, strings.Join(withSocket, " "), "--volume /var/run/docker.sock:/var/run/docker.sock")
	assert.NotEqual(t, digest, other, "other settings make another container")
}

// a docker that answers from a script, and records what it was asked
type fakeDocker struct {
	calls   []string
	inspect string
	missing bool
	down    bool
}

func (f *fakeDocker) run(ctx context.Context, args ...string) ([]byte, error) {
	f.calls = append(f.calls, strings.Join(args, " "))
	switch args[0] {
	case "version":
		if f.down {
			return nil, errors.New("Cannot connect to the Docker daemon")
		}
	case "container":
		if f.missing {
			return nil, errors.New("No such container")
		}
		return []byte(f.inspect), nil
	}
	return nil, nil
}

func TestStart(t *testing.T) {
	local, err := parse(t, func(s map[string]any) { s["container"].(map[string]any)["dockerSocket"] = true })
	require.NoError(t, err)
	container := local.settings.Container
	_, digest := container.runArgs("emulator")
	said := []string{}
	Say = func(message string) { said = append(said, message) }
	t.Cleanup(func() { Say = func(string) {} })
	ctx := context.Background()

	t.Run("none there", func(t *testing.T) {
		said = nil
		docker := &fakeDocker{missing: true}
		require.NoError(t, container.start(ctx, "emulator", docker.run))
		assert.True(t, strings.HasPrefix(docker.calls[len(docker.calls)-1], "run --detach --name sst-target-emulator"))
		require.Len(t, said, 1)
		assert.Contains(t, said[0], "Docker socket", "it says the target is given the socket")
	})

	t.Run("running, as started", func(t *testing.T) {
		docker := &fakeDocker{inspect: `{"State":{"Running":true},"Config":{"Labels":{"sst.target.settings":"` + digest + `"}}}`}
		require.NoError(t, container.start(ctx, "emulator", docker.run))
		assert.Len(t, docker.calls, 1)
	})

	t.Run("stopped", func(t *testing.T) {
		docker := &fakeDocker{inspect: `{"State":{"Running":false},"Config":{"Labels":{"sst.target.settings":"` + digest + `"}}}`}
		require.NoError(t, container.start(ctx, "emulator", docker.run))
		assert.Equal(t, "start sst-target-emulator", docker.calls[1])
	})

	t.Run("started with other settings", func(t *testing.T) {
		docker := &fakeDocker{inspect: `{"State":{"Running":true},"Config":{"Labels":{"sst.target.settings":"older"}}}`}
		require.NoError(t, container.start(ctx, "emulator", docker.run))
		assert.Equal(t, "rm --force sst-target-emulator", docker.calls[1])
		assert.True(t, strings.HasPrefix(docker.calls[2], "run "))
	})

	// One the core didn't start is someone else's
	t.Run("not SST's", func(t *testing.T) {
		docker := &fakeDocker{inspect: `{"State":{"Running":true},"Config":{"Labels":{}}}`}
		err := container.start(ctx, "emulator", docker.run)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "SST didn't start it")
		assert.Len(t, docker.calls, 1, "nothing is changed")
	})

	t.Run("no Docker", func(t *testing.T) {
		docker := &fakeDocker{missing: true, down: true}
		err := container.start(ctx, "emulator", docker.run)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "Docker, which isn't running")
	})
}

func TestStrip(t *testing.T) {
	env := Strip([]string{
		"PATH=/usr/bin",
		"AWS_PROFILE=production",
		"AWS_ACCESS_KEY_ID=AKIAREAL",
		"AWS_SESSION_TOKEN=real",
		"aws_secret_access_key=lowercase",
		"AWS_ROLE_ARN=arn:aws:iam::123456789012:role/admin",
		"AWS_WEB_IDENTITY_TOKEN_FILE=/var/token",
		"AWS_CONTAINER_CREDENTIALS_FULL_URI=http://169.254.170.2/creds",
		"SST_AWS_ACCESS_KEY_ID=AKIAREAL",
		"HTTPS_PROXY=http://proxy.example.com:3128",
		"no_proxy=example.com",
		"AWS_LAMBDA_FUNCTION_NAME=my-function",
	}, "http://127.0.0.1:4566", "us-east-1", "test", "secret")

	values := map[string]string{}
	for _, entry := range env {
		key, value, _ := strings.Cut(entry, "=")
		_, seen := values[key]
		assert.False(t, seen, "%s is set once", key)
		values[key] = value
	}
	for _, gone := range []string{"AWS_PROFILE", "AWS_SESSION_TOKEN", "aws_secret_access_key", "AWS_ROLE_ARN", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "HTTPS_PROXY", "no_proxy"} {
		assert.NotContains(t, values, gone)
	}
	assert.Equal(t, "/usr/bin", values["PATH"])
	assert.Equal(t, "my-function", values["AWS_LAMBDA_FUNCTION_NAME"], "what Lambda sets for a function stays")
	assert.Equal(t, "test", values["AWS_ACCESS_KEY_ID"])
	assert.Equal(t, "test", values["SST_AWS_ACCESS_KEY_ID"])
	assert.Equal(t, "http://127.0.0.1:4566", values["AWS_ENDPOINT_URL"])
	assert.Equal(t, os.DevNull, values["AWS_SHARED_CREDENTIALS_FILE"])
	assert.Equal(t, os.DevNull, values["AWS_CONFIG_FILE"])
	assert.Equal(t, "true", values["AWS_EC2_METADATA_DISABLED"])
}

func TestApply(t *testing.T) {
	local, err := parse(t, nil)
	require.NoError(t, err)
	t.Setenv("AWS_PROFILE", "production")
	t.Setenv("AWS_SESSION_TOKEN", "real")
	t.Setenv("HTTPS_PROXY", "http://proxy.example.com:3128")
	local.Apply()
	_, profile := os.LookupEnv("AWS_PROFILE")
	assert.False(t, profile)
	_, token := os.LookupEnv("AWS_SESSION_TOKEN")
	assert.False(t, token)
	assert.Equal(t, "test", os.Getenv("AWS_ACCESS_KEY_ID"))
	assert.Equal(t, "http://127.0.0.1:4566", os.Getenv("AWS_ENDPOINT_URL"))
	// The CLI keeps its proxy for what it downloads
	assert.Equal(t, "http://proxy.example.com:3128", os.Getenv("HTTPS_PROXY"))
	for _, key := range []string{"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_ENDPOINT_URL", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_EC2_METADATA_DISABLED", "SST_AWS_ACCESS_KEY_ID", "SST_AWS_SECRET_ACCESS_KEY", "SST_AWS_REGION"} {
		t.Setenv(key, os.Getenv(key)) // restored after the test
	}
}

func TestCloud(t *testing.T) {
	base := []string{"AWS_PROFILE=production", "HTTPS_PROXY=http://proxy.example.com:3128"}
	assert.Equal(t, base, Cloud{}.Env(base), "the real cloud's stage gets the developer's settings")
	assert.True(t, IsCloud(Cloud{}))
	local, err := parse(t, nil)
	require.NoError(t, err)
	assert.False(t, IsCloud(local))
}

func TestProviders(t *testing.T) {
	local, err := parse(t, func(s map[string]any) {
		s["providers"] = map[string]any{"aws": map[string]any{
			"s3UsePathStyle": true,
			"endpoints":      []any{map[string]any{"s3": "http://127.0.0.1:4566"}},
		}}
	})
	require.NoError(t, err)

	t.Run("the app's credentials and routes go, and the target's settings win", func(t *testing.T) {
		settings := map[string]interface{}{"aws": map[string]interface{}{
			"region":         "us-west-2",
			"profile":        "production",
			"assumeRoles":    []any{map[string]any{"roleArn": "arn:aws:iam::123456789012:role/admin"}},
			"endpoints":      []any{map[string]any{"s3": "https://s3.example.com"}},
			"httpsProxy":     "http://proxy.example.com:3128",
			"customCaBundle": "/etc/ca.pem",
			"defaultTags":    map[string]any{"tags": map[string]any{"team": "a"}},
		}}
		args := local.awsSettings(settings)
		for _, gone := range []string{"profile", "assumeRoles", "httpsProxy", "customCaBundle"} {
			assert.NotContains(t, args, gone)
		}
		assert.Equal(t, []any{map[string]any{"s3": "http://127.0.0.1:4566"}}, args["endpoints"], "the target's endpoints, not the app's")
		assert.Equal(t, true, args["s3UsePathStyle"])
		assert.Contains(t, args, "defaultTags", "what doesn't pick credentials or routes stays")
	})

	t.Run("another cloud is turned down", func(t *testing.T) {
		for _, cloud := range []string{"cloudflare", "vercel"} {
			err := CheckProviders(local, map[string]interface{}{"aws": map[string]any{}, cloud: map[string]any{}})
			require.Error(t, err)
			assert.Contains(t, err.Error(), cloud)
		}
		assert.NoError(t, CheckProviders(local, map[string]interface{}{"aws": map[string]any{}, "random": map[string]any{"version": "4.16.0"}}))
	})
}

func TestOtherCloudsCredentials(t *testing.T) {
	env := Strip([]string{"CLOUDFLARE_API_TOKEN=real", "VERCEL_API_TOKEN=real", "CLOUDFLARE_DEFAULT_ACCOUNT_ID=1"}, "http://127.0.0.1:4566", "us-east-1", "test", "test")
	for _, entry := range env {
		assert.False(t, strings.HasPrefix(entry, "CLOUDFLARE_") || strings.HasPrefix(entry, "VERCEL_"), entry)
	}
}

func TestImageThatsAFlag(t *testing.T) {
	_, err := parse(t, func(s map[string]any) { s["container"].(map[string]any)["image"] = "--privileged" })
	require.Error(t, err)
	assert.Contains(t, err.Error(), "image name")
}

func TestStop(t *testing.T) {
	local, err := parse(t, nil)
	require.NoError(t, err)
	container := local.settings.Container
	ctx := context.Background()

	t.Run("running, started by SST", func(t *testing.T) {
		docker := &fakeDocker{inspect: `{"State":{"Running":true},"Config":{"Labels":{"sst.target.settings":"any"}}}`}
		stopped, err := container.stop(ctx, "emulator", docker.run)
		require.NoError(t, err)
		assert.True(t, stopped)
		assert.Equal(t, "stop sst-target-emulator", docker.calls[1])
	})

	t.Run("stopped already", func(t *testing.T) {
		docker := &fakeDocker{inspect: `{"State":{"Running":false},"Config":{"Labels":{"sst.target.settings":"any"}}}`}
		stopped, err := container.stop(ctx, "emulator", docker.run)
		require.NoError(t, err)
		assert.False(t, stopped)
		assert.Len(t, docker.calls, 1)
	})

	t.Run("not SST's", func(t *testing.T) {
		docker := &fakeDocker{inspect: `{"State":{"Running":true},"Config":{"Labels":{}}}`}
		stopped, err := container.stop(ctx, "emulator", docker.run)
		require.NoError(t, err)
		assert.False(t, stopped)
		assert.Len(t, docker.calls, 1, "it's left alone")
	})

	t.Run("none there", func(t *testing.T) {
		docker := &fakeDocker{missing: true}
		stopped, err := container.stop(ctx, "emulator", docker.run)
		require.NoError(t, err)
		assert.False(t, stopped)
	})

	t.Run("no Docker", func(t *testing.T) {
		docker := &fakeDocker{missing: true, down: true}
		_, err := container.stop(ctx, "emulator", docker.run)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "Docker, which isn't running")
	})
}

func TestReset(t *testing.T) {
	local, err := parse(t, func(s map[string]any) {
		s["container"].(map[string]any)["volumes"] = map[string]any{"/data": "data", "/cache": "cache"}
	})
	require.NoError(t, err)
	container := local.settings.Container
	ctx := context.Background()

	t.Run("its container and volumes", func(t *testing.T) {
		docker := &fakeDocker{inspect: `{"State":{"Running":true},"Config":{"Labels":{"sst.target.settings":"any"}}}`}
		require.NoError(t, container.reset(ctx, "emulator", docker.run))
		assert.Equal(t, []string{
			"rm --force sst-target-emulator",
			"volume rm --force sst-target-emulator-cache",
			"volume rm --force sst-target-emulator-data",
		}, docker.calls[1:])
	})

	t.Run("no container, its volumes still", func(t *testing.T) {
		docker := &fakeDocker{missing: true}
		require.NoError(t, container.reset(ctx, "emulator", docker.run))
		// it asks Docker if it's running, as no container answered
		assert.Equal(t, "volume rm --force sst-target-emulator-cache", docker.calls[2])
	})

	t.Run("not SST's", func(t *testing.T) {
		docker := &fakeDocker{inspect: `{"State":{"Running":true},"Config":{"Labels":{}}}`}
		err := container.reset(ctx, "emulator", docker.run)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "SST didn't start it")
		assert.Len(t, docker.calls, 1, "nothing is removed")
	})
}

func TestDeployed(t *testing.T) {
	home := t.TempDir()
	write := func(app, stage string, gzipped bool, types ...string) {
		resources := []map[string]string{}
		for _, t := range types {
			resources = append(resources, map[string]string{"type": t})
		}
		data, err := json.Marshal(map[string]any{"version": 3, "checkpoint": map[string]any{"latest": map[string]any{"resources": resources}}})
		require.NoError(t, err)
		if gzipped {
			var buf bytes.Buffer
			w := gzip.NewWriter(&buf)
			w.Write(data)
			w.Close()
			data = buf.Bytes()
		}
		dir := filepath.Join(home, "state", "app", app)
		require.NoError(t, os.MkdirAll(dir, 0755))
		require.NoError(t, os.WriteFile(filepath.Join(dir, stage+".json"), data, 0644))
	}
	// What `sst remove` leaves
	write("shop", "local", false, "pulumi:pulumi:Stack")
	write("shop", "removed", false)
	write("shop", "dev", false, "pulumi:pulumi:Stack", "pulumi:providers:aws", "aws:s3/bucket:Bucket")
	write("blog", "local", true, "pulumi:pulumi:Stack", "sst:aws:Function")

	deployed, err := deployedIn(home)
	require.NoError(t, err)
	assert.ElementsMatch(t, []string{"shop/dev", "blog/local"}, deployed)

	none, err := deployedIn(t.TempDir())
	require.NoError(t, err)
	assert.Empty(t, none)
}
