package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	_ "unsafe"

	cloudflare "github.com/cloudflare/cloudflare-go"
	"github.com/sst/sst/v3/internal/util"
)

// CloudflareHome keeps state in the R2 bucket `sst-state`, at
// `<kind>/<app>/<stage>` with no extension, and each stage's passphrase as the
// object `passphrase/<app>/<stage>`.
//
// The keys are joined with filepath.Join, as they always were, so on Windows
// they hold backslashes. Changing that would lose those stages' state.
type CloudflareHome struct {
	sync.Mutex
	provider  *CloudflareProvider
	bootstrap *bootstrap
	compress  bool
}

var _ Home = (*CloudflareHome)(nil)

func NewCloudflareHome(provider *CloudflareProvider, compress bool) *CloudflareHome {
	return &CloudflareHome{
		provider: provider,
		compress: compress,
	}
}

type bootstrap struct {
	State string `json:"state"`
}

func (c *CloudflareHome) Bootstrap() error {
	ctx := context.Background()
	buckets, err := c.provider.api.ListR2Buckets(ctx, c.provider.identifier, cloudflare.ListR2BucketsParams{
		Name: "sst-state",
	})
	if err != nil {
		return err
	}
	for _, bucket := range buckets {
		if bucket.Name == "sst-state" {
			slog.Info("found existing bucket", "bucket", bucket.Name)
			c.bootstrap = &bootstrap{
				State: bucket.Name,
			}
		}
	}

	if c.bootstrap == nil {
		slog.Info("creating new bucket", "bucket", "sst-state")
		_, err = c.provider.api.CreateR2Bucket(ctx, c.provider.identifier, cloudflare.CreateR2BucketParameters{
			Name: "sst-state",
		})
		if err != nil {
			return err
		}
		c.bootstrap = &bootstrap{
			State: "sst-state",
		}
	}

	return nil
}

//go:linkname makeRequestContext github.com/cloudflare/cloudflare-go.(*API).makeRequestContext
func makeRequestContext(*cloudflare.API, context.Context, string, string, interface{}) ([]byte, error)

func (c *CloudflareHome) objectPath(key string) string {
	return "/accounts/" + c.provider.identifier.Identifier + "/r2/buckets/" + c.bootstrap.State + "/objects/" + key
}

func (c *CloudflareHome) objectKey(key Key) string {
	return filepath.Join(key.Kind, key.App, key.Stage)
}

func isCloudflareNotFound(err error) bool {
	return err != nil && err.Error() == "The specified key does not exist. (10007)"
}

func (c *CloudflareHome) Get(ctx context.Context, key Key) ([]byte, error) {
	c.Lock()
	defer c.Unlock()
	data, err := makeRequestContext(c.provider.api, ctx, http.MethodGet, c.objectPath(c.objectKey(key)), nil)
	if err != nil {
		if isCloudflareNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	reader, err := gzipDecode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	return io.ReadAll(reader)
}

// Put with IfAbsent reads, then writes, as the CLIs before it did: the API
// this home uses takes no conditional headers, so two writers that race can
// both succeed.
func (c *CloudflareHome) Put(ctx context.Context, key Key, data []byte, opts PutOptions) error {
	if opts.IfAbsent {
		existing, err := c.Get(ctx, key)
		if err != nil {
			return err
		}
		if existing != nil {
			return ErrExists
		}
	}
	c.Lock()
	defer c.Unlock()
	body := data
	if c.compress {
		encoded, err := gzipEncode(bytes.NewReader(data))
		if err != nil {
			return err
		}
		if body, err = io.ReadAll(encoded); err != nil {
			return err
		}
	}
	// Bytes, not a reader: the client sends the body again when it retries,
	// and a reader would be empty by then.
	_, err := makeRequestContext(c.provider.api, ctx, http.MethodPut, c.objectPath(c.objectKey(key)), body)
	return err
}

func (c *CloudflareHome) Remove(ctx context.Context, keys ...Key) error {
	for _, key := range keys {
		if err := c.removeObject(ctx, c.objectKey(key)); err != nil {
			return err
		}
	}
	return nil
}

func (c *CloudflareHome) removeObject(ctx context.Context, key string) error {
	c.Lock()
	defer c.Unlock()
	_, err := makeRequestContext(c.provider.api, ctx, http.MethodDelete, c.objectPath(key), nil)
	if isCloudflareNotFound(err) {
		return nil
	}
	return err
}

func (c *CloudflareHome) List(ctx context.Context, prefix Key) ([]Key, error) {
	folder := filepath.Join(prefix.Kind, prefix.App, prefix.Stage) + string(filepath.Separator)
	objects, err := c.listObjects(ctx, folder)
	if err != nil {
		return nil, err
	}
	keys := make([]Key, 0, len(objects))
	for _, object := range objects {
		name := strings.TrimPrefix(object, folder)
		stage := name
		if prefix.Stage != "" {
			stage = prefix.Stage + "/" + name
		}
		keys = append(keys, Key{Kind: prefix.Kind, App: prefix.App, Stage: stage})
	}
	return keys, nil
}

func (c *CloudflareHome) listObjects(ctx context.Context, prefix string) ([]string, error) {
	type r2Object struct {
		Key string `json:"key"`
	}
	type r2Response struct {
		Result []r2Object `json:"result"`
		Info   struct {
			Cursor      string `json:"cursor"`
			IsTruncated bool   `json:"is_truncated"`
		} `json:"result_info"`
	}

	c.Lock()
	defer c.Unlock()

	var keys []string
	cursor := ""
	for {
		query := url.Values{"prefix": []string{prefix}, "per_page": []string{"1000"}}
		if cursor != "" {
			query.Set("cursor", cursor)
		}
		listPath := "/accounts/" + c.provider.identifier.Identifier + "/r2/buckets/" + c.bootstrap.State + "/objects?" + query.Encode()
		data, err := makeRequestContext(c.provider.api, ctx, http.MethodGet, listPath, nil)
		if err != nil {
			return nil, err
		}
		var response r2Response
		if err := json.Unmarshal(data, &response); err != nil {
			return nil, err
		}
		for _, object := range response.Result {
			keys = append(keys, object.Key)
		}
		if !response.Info.IsTruncated || response.Info.Cursor == "" {
			break
		}
		cursor = response.Info.Cursor
	}
	return keys, nil
}

func (c *CloudflareHome) Passphrase(ctx context.Context, app, stage string) (string, error) {
	data, err := c.Get(ctx, passphraseKey(app, stage))
	return string(data), err
}

func (c *CloudflareHome) CreatePassphrase(ctx context.Context, app, stage, passphrase string) error {
	return c.Put(ctx, passphraseKey(app, stage), []byte(passphrase), PutOptions{IfAbsent: true})
}

func (c *CloudflareHome) RemovePassphrase(ctx context.Context, app, stage string) error {
	return c.Remove(ctx, passphraseKey(app, stage))
}

func (c *CloudflareHome) Info() (util.KeyValuePairs[string], error) {
	return util.KeyValuePairs[string]{
		{Key: "Provider", Value: "Cloudflare"},
		{Key: "Account", Value: c.provider.identifier.Identifier},
	}, nil
}
