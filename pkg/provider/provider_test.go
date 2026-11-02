package provider

import (
	"context"
	"net/http"
	"os"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource/plugin"
	pulumirpc "github.com/pulumi/pulumi/sdk/v3/proto/go"
	sstresource "github.com/sst/sst/v3/pkg/server/resource"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/structpb"
)

const (
	filesUrn = "urn:pulumi:dev::app::sst:aws:StaticSite$sst:aws:BucketFiles::SiteFiles"
	keysUrn  = "urn:pulumi:dev::app::sst:aws:KvKeys::RouterKeys"
)

// recorder stands in for a resource, keeping what each call was given
type recorder[I any, O any] struct {
	name    string
	calls   *[]string
	outs    O
	created *I
	updated *sstresource.UpdateInput[I, O]
	deleted *sstresource.DeleteInput[O]
}

func (r *recorder[I, O]) Create(input *I, output *sstresource.CreateResult[O]) error {
	*r.calls = append(*r.calls, r.name+".Create")
	r.created = input
	*output = sstresource.CreateResult[O]{ID: r.name, Outs: r.outs}
	return nil
}

func (r *recorder[I, O]) Update(input *sstresource.UpdateInput[I, O], output *sstresource.UpdateResult[O]) error {
	*r.calls = append(*r.calls, r.name+".Update")
	r.updated = input
	*output = sstresource.UpdateResult[O]{Outs: r.outs}
	return nil
}

func (r *recorder[I, O]) Delete(input *sstresource.DeleteInput[O], output *int) error {
	*r.calls = append(*r.calls, r.name+".Delete")
	r.deleted = input
	return nil
}

type fakes struct {
	calls []string
	files *recorder[sstresource.BucketFilesInputs, sstresource.BucketFilesOutputs]
	keys  *recorder[sstresource.KvKeysInputs, sstresource.KvKeysOutputs]
}

// fakeServer serves both resources with recorders in place of AWS
func fakeServer() (*server, *fakes) {
	f := &fakes{}
	f.files = &recorder[sstresource.BucketFilesInputs, sstresource.BucketFilesOutputs]{
		name:  "files",
		calls: &f.calls,
		outs:  sstresource.BucketFilesOutputs{BucketName: "assets", Region: "us-east-1"},
	}
	f.keys = &recorder[sstresource.KvKeysInputs, sstresource.KvKeysOutputs]{
		name:  "entries",
		calls: &f.calls,
		outs:  sstresource.KvKeysOutputs{Store: "store-arn", Namespace: "site"},
	}
	return newServer("5.0.0", map[string]handler{
		"sst:aws:BucketFiles": typed[sstresource.BucketFilesInputs, sstresource.BucketFilesOutputs]{
			open: func(context.Context) implementation[sstresource.BucketFilesInputs, sstresource.BucketFilesOutputs] {
				return f.files
			},
		},
		"sst:aws:KvKeys": typed[sstresource.KvKeysInputs, sstresource.KvKeysOutputs]{
			open: func(context.Context) implementation[sstresource.KvKeysInputs, sstresource.KvKeysOutputs] {
				return f.keys
			},
		},
	}), f
}

// props is Pulumi's wire form of values, unknowns kept
func props(t *testing.T, values resource.PropertyMap) *structpb.Struct {
	t.Helper()
	s, err := plugin.MarshalProperties(values, plugin.MarshalOptions{KeepUnknowns: true})
	require.NoError(t, err)
	return s
}

// plain is the wire form's values, to compare
func plain(t *testing.T, s *structpb.Struct) map[string]any {
	t.Helper()
	values, err := plugin.UnmarshalProperties(s, plugin.MarshalOptions{KeepUnknowns: true})
	require.NoError(t, err)
	return values.Mappable()
}

func filesInputs(purge any) resource.PropertyMap {
	m := map[string]any{
		"bucketName": "assets",
		"region":     "us-east-1",
		"files": []any{
			map[string]any{"source": "/tmp/index.html", "key": "index.html", "contentType": "text/html", "hash": "abc"},
		},
	}
	if purge != nil {
		m["purge"] = purge
	}
	return resource.NewPropertyMapFromMap(m)
}

func TestDiff(t *testing.T) {
	s, _ := fakeServer()
	ctx := context.Background()

	t.Run("the same inputs", func(t *testing.T) {
		resp, err := s.Diff(ctx, &pulumirpc.DiffRequest{
			Urn: filesUrn, Id: "files",
			OldInputs: props(t, filesInputs(true)),
			News:      props(t, filesInputs(true)),
		})
		require.NoError(t, err)
		assert.Equal(t, pulumirpc.DiffResponse_DIFF_NONE, resp.Changes)
		assert.Empty(t, resp.Diffs)
		assert.Empty(t, resp.Replaces)
	})

	t.Run("a changed field", func(t *testing.T) {
		news := filesInputs(true)
		news["files"] = resource.NewPropertyValue([]any{
			map[string]any{"source": "/tmp/index.html", "key": "index.html", "contentType": "text/html", "hash": "def"},
		})
		resp, err := s.Diff(ctx, &pulumirpc.DiffRequest{
			Urn: filesUrn, Id: "files",
			OldInputs: props(t, filesInputs(true)),
			News:      props(t, news),
		})
		require.NoError(t, err)
		assert.Equal(t, pulumirpc.DiffResponse_DIFF_SOME, resp.Changes)
		assert.Equal(t, []string{"files"}, resp.Diffs)
		assert.Equal(t, pulumirpc.PropertyDiff_UPDATE, resp.DetailedDiff["files"].Kind)
		assert.True(t, resp.DetailedDiff["files"].InputDiff)
		assert.Len(t, resp.DetailedDiff, 1)
		assert.Empty(t, resp.Replaces)
	})

	t.Run("purge false against an output that leaves it out", func(t *testing.T) {
		// The outputs drop `purge: false` (omitempty), and an engine that
		// doesn't send the old inputs gives only those
		resp, err := s.Diff(ctx, &pulumirpc.DiffRequest{
			Urn: filesUrn, Id: "files",
			Olds: props(t, filesInputs(nil)),
			News: props(t, filesInputs(false)),
		})
		require.NoError(t, err)
		assert.Equal(t, pulumirpc.DiffResponse_DIFF_NONE, resp.Changes)
		assert.Empty(t, resp.Diffs)
	})

	t.Run("the old inputs over the outputs", func(t *testing.T) {
		olds := filesInputs(true)
		olds["bucketName"] = resource.NewPropertyValue("elsewhere")
		resp, err := s.Diff(ctx, &pulumirpc.DiffRequest{
			Urn: filesUrn, Id: "files",
			OldInputs: props(t, filesInputs(true)),
			Olds:      props(t, olds),
			News:      props(t, filesInputs(true)),
		})
		require.NoError(t, err)
		assert.Equal(t, pulumirpc.DiffResponse_DIFF_NONE, resp.Changes)
	})

	t.Run("an unknown in a preview", func(t *testing.T) {
		news := filesInputs(true)
		news["bucketName"] = resource.MakeComputed(resource.NewPropertyValue(""))
		resp, err := s.Diff(ctx, &pulumirpc.DiffRequest{
			Urn: filesUrn, Id: "files",
			OldInputs: props(t, filesInputs(true)),
			News:      props(t, news),
		})
		require.NoError(t, err)
		assert.Equal(t, pulumirpc.DiffResponse_DIFF_SOME, resp.Changes)
		assert.Equal(t, []string{"bucketName"}, resp.Diffs)
		assert.Equal(t, pulumirpc.PropertyDiff_UPDATE, resp.DetailedDiff["bucketName"].Kind)
	})

	t.Run("an unknown inside a property", func(t *testing.T) {
		news := filesInputs(true)
		news["files"] = resource.NewPropertyValue([]any{
			resource.MakeComputed(resource.NewPropertyValue("")),
		})
		resp, err := s.Diff(ctx, &pulumirpc.DiffRequest{
			Urn: filesUrn, Id: "files",
			OldInputs: props(t, filesInputs(true)),
			News:      props(t, news),
		})
		require.NoError(t, err)
		assert.Equal(t, []string{"files"}, resp.Diffs)
	})

	t.Run("an unknown type", func(t *testing.T) {
		_, err := s.Diff(ctx, &pulumirpc.DiffRequest{
			Urn: "urn:pulumi:dev::app::sst:aws:Nothing::X", Id: "x",
			OldInputs: props(t, filesInputs(true)),
			News:      props(t, filesInputs(true)),
		})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "sst:aws:Nothing")
	})
}

func TestCheck(t *testing.T) {
	s, _ := fakeServer()
	news := filesInputs(true)
	news["region"] = resource.MakeComputed(resource.NewPropertyValue(""))
	wire := props(t, news)
	resp, err := s.Check(context.Background(), &pulumirpc.CheckRequest{Urn: filesUrn, News: wire})
	require.NoError(t, err)
	assert.Empty(t, resp.Failures)
	assert.Equal(t, plain(t, wire), plain(t, resp.Inputs))
	checked, err := plugin.UnmarshalProperties(resp.Inputs, plugin.MarshalOptions{KeepUnknowns: true})
	require.NoError(t, err)
	assert.True(t, checked["region"].IsComputed())

	_, err = s.Check(context.Background(), &pulumirpc.CheckRequest{Urn: "urn:pulumi:dev::app::sst:aws:Nothing::X", News: wire})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "sst:aws:Nothing")
}

func TestCreateUpdateDelete(t *testing.T) {
	s, f := fakeServer()
	ctx := context.Background()

	created, err := s.Create(ctx, &pulumirpc.CreateRequest{Urn: filesUrn, Properties: props(t, filesInputs(true))})
	require.NoError(t, err)
	assert.Equal(t, "files", created.Id)
	assert.Equal(t, map[string]any{"bucketName": "assets", "region": "us-east-1"}, plain(t, created.Properties))
	require.NotNil(t, f.files.created)
	assert.Equal(t, "assets", f.files.created.BucketName)
	assert.True(t, f.files.created.Purge)
	require.Len(t, f.files.created.Files, 1)
	assert.Equal(t, "index.html", f.files.created.Files[0].Key)
	require.NotNil(t, f.files.created.Files[0].Hash)
	assert.Equal(t, "abc", *f.files.created.Files[0].Hash)

	keys := resource.NewPropertyMapFromMap(map[string]any{
		"store": "store-arn", "namespace": "site", "purge": true,
		"entries": map[string]any{"/": "index"},
	})
	updated, err := s.Update(ctx, &pulumirpc.UpdateRequest{
		Urn: keysUrn, Id: "entries",
		Olds: props(t, resource.NewPropertyMapFromMap(map[string]any{"store": "old-arn", "namespace": "site"})),
		News: props(t, keys),
	})
	require.NoError(t, err)
	assert.Equal(t, map[string]any{"store": "store-arn", "namespace": "site"}, plain(t, updated.Properties))
	require.NotNil(t, f.keys.updated)
	assert.Equal(t, "entries", f.keys.updated.ID)
	assert.Equal(t, "old-arn", f.keys.updated.Olds.Store)
	assert.Equal(t, "store-arn", f.keys.updated.News.Store)
	assert.Equal(t, map[string]string{"/": "index"}, f.keys.updated.News.Entries)
	assert.True(t, f.keys.updated.News.Purge)

	_, err = s.Delete(ctx, &pulumirpc.DeleteRequest{
		Urn: filesUrn, Id: "files",
		Properties: props(t, filesInputs(nil)),
	})
	require.NoError(t, err)
	require.NotNil(t, f.files.deleted)
	assert.Equal(t, "files", f.files.deleted.ID)
	assert.Equal(t, "assets", f.files.deleted.Outs.BucketName)
	assert.False(t, f.files.deleted.Outs.Purge)

	assert.Equal(t, []string{"files.Create", "entries.Update", "files.Delete"}, f.calls)
}

func TestCreateInPreview(t *testing.T) {
	s, f := fakeServer()
	wire := props(t, filesInputs(true))
	resp, err := s.Create(context.Background(), &pulumirpc.CreateRequest{Urn: filesUrn, Properties: wire, Preview: true})
	require.NoError(t, err)
	assert.Equal(t, plain(t, wire), plain(t, resp.Properties))
	assert.Empty(t, f.calls)
}

func TestRead(t *testing.T) {
	s, f := fakeServer()
	properties := props(t, filesInputs(nil))
	inputs := props(t, filesInputs(false))
	resp, err := s.Read(context.Background(), &pulumirpc.ReadRequest{
		Urn: filesUrn, Id: "files", Properties: properties, Inputs: inputs,
	})
	require.NoError(t, err)
	assert.Equal(t, "files", resp.Id)
	assert.Equal(t, plain(t, properties), plain(t, resp.Properties))
	assert.Equal(t, plain(t, inputs), plain(t, resp.Inputs))
	assert.Empty(t, f.calls)
}

func TestResources(t *testing.T) {
	served := resources(envAws())
	assert.Len(t, served, 2)

	files, ok := served["sst:aws:BucketFiles"].(typed[sstresource.BucketFilesInputs, sstresource.BucketFilesOutputs])
	require.True(t, ok)
	assert.IsType(t, &sstresource.BucketFiles{}, files.open(context.Background()))

	keys, ok := served["sst:aws:KvKeys"].(typed[sstresource.KvKeysInputs, sstresource.KvKeysOutputs])
	require.True(t, ok)
	assert.IsType(t, &sstresource.KvKeys{}, keys.open(context.Background()))
}

func TestVersion(t *testing.T) {
	for version, want := range map[string]string{
		"5.0.0-alpha.2": "5.0.0-alpha.2",
		"v4.23.1":       "4.23.1",
		// A dev build's, which Pulumi can't read
		"dev": "",
	} {
		s := newServer(version, nil)
		info, err := s.GetPluginInfo(context.Background(), nil)
		require.NoError(t, err)
		assert.Equal(t, want, info.Version, version)
	}
	schema, err := newServer("5.0.0", nil).GetSchema(context.Background(), nil)
	require.NoError(t, err)
	assert.JSONEq(t, `{"name":"sst","version":"5.0.0"}`, schema.Schema)
}

// isolate keeps the developer's own AWS setup out of a test
func isolate(t *testing.T) {
	for _, key := range []string{
		"AWS_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_ACCESS_KEY_ID",
		"AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_ENDPOINT_URL",
		"SST_AWS_ACCESS_KEY_ID", "SST_AWS_SECRET_ACCESS_KEY", "SST_AWS_SESSION_TOKEN", "SST_AWS_REGION",
	} {
		t.Setenv(key, "")
		os.Unsetenv(key)
	}
	t.Setenv("AWS_CONFIG_FILE", os.DevNull)
	t.Setenv("AWS_SHARED_CREDENTIALS_FILE", os.DevNull)
	t.Setenv("AWS_EC2_METADATA_DISABLED", "true")
}

func TestAwsConfig(t *testing.T) {
	ctx := context.Background()

	t.Run("the cloud", func(t *testing.T) {
		isolate(t)
		t.Setenv("SST_AWS_REGION", "eu-west-2")
		t.Setenv("SST_AWS_ACCESS_KEY_ID", "test-access-key")
		t.Setenv("SST_AWS_SECRET_ACCESS_KEY", "test-secret-key")
		t.Setenv("SST_AWS_SESSION_TOKEN", "test-session-token")
		// What the developer's shell has isn't used over what the CLI resolved
		t.Setenv("AWS_REGION", "ap-south-1")
		t.Setenv("AWS_ACCESS_KEY_ID", "shell-access-key")
		t.Setenv("AWS_SECRET_ACCESS_KEY", "shell-secret-key")

		cfg, err := awsConfig(ctx)
		require.NoError(t, err)
		assert.Equal(t, "eu-west-2", cfg.Region)
		assert.Equal(t, 10, cfg.RetryMaxAttempts)
		assert.Nil(t, cfg.BaseEndpoint)
		creds, err := cfg.Credentials.Retrieve(ctx)
		require.NoError(t, err)
		// Compared without printing them
		if creds.AccessKeyID != "test-access-key" || creds.SecretAccessKey != "test-secret-key" || creds.SessionToken != "test-session-token" {
			t.Error("the credentials aren't the ones the CLI gave")
		}
	})

	t.Run("a target", func(t *testing.T) {
		isolate(t)
		t.Setenv("SST_AWS_REGION", "us-east-1")
		t.Setenv("SST_AWS_ACCESS_KEY_ID", "test")
		t.Setenv("SST_AWS_SECRET_ACCESS_KEY", "test")
		t.Setenv("AWS_ENDPOINT_URL", "http://127.0.0.1:4566")

		cfg, err := awsConfig(ctx)
		require.NoError(t, err)
		require.NotNil(t, cfg.BaseEndpoint)
		assert.Equal(t, "http://127.0.0.1:4566", *cfg.BaseEndpoint)
		assert.Equal(t, 3, cfg.RetryMaxAttempts)
		assert.True(t, s3.NewFromConfig(cfg).Options().UsePathStyle, "a bucket is a path on the target's endpoint")
		creds, err := cfg.Credentials.Retrieve(ctx)
		require.NoError(t, err)
		if creds.AccessKeyID != "test" || creds.SecretAccessKey != "test" || creds.SessionToken != "" {
			t.Error("the credentials aren't the target's")
		}
		// A call anywhere but the endpoint is refused
		_, err = cfg.HTTPClient.Do(mustRequest(t, "https://s3.amazonaws.com/"))
		require.Error(t, err)
		assert.Contains(t, err.Error(), "refused")
	})

	t.Run("no region", func(t *testing.T) {
		isolate(t)
		cfg, err := awsConfig(ctx)
		require.NoError(t, err)
		assert.Equal(t, "us-east-1", cfg.Region)
	})
}

func mustRequest(t *testing.T, url string) *http.Request {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, url, nil)
	require.NoError(t, err)
	return req
}
