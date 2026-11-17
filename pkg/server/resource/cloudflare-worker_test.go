package resource

import (
	"context"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cloudflare/cloudflare-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// call is a request Cloudflare's API was sent
type call struct {
	method, path, auth, contentType, body string
}

// fakeCloudflare serves Cloudflare's API with answer, and keeps each request
func fakeCloudflare(t *testing.T, answer func(call) (int, string)) (*CloudflareResource, *[]call) {
	t.Helper()
	var mu sync.Mutex
	calls := []call{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		c := call{r.Method, r.URL.Path, r.Header.Get("Authorization"), r.Header.Get("Content-Type"), string(body)}
		mu.Lock()
		calls = append(calls, c)
		mu.Unlock()
		status, response := answer(c)
		w.WriteHeader(status)
		io.WriteString(w, response)
	}))
	t.Cleanup(server.Close)
	was, settle, retries := cloudflareAPI, workerUrlSettle, cloudflareRetries
	cloudflareAPI, workerUrlSettle, cloudflareRetries = server.URL, 0, []time.Duration{0, 0, 0}
	t.Cleanup(func() { cloudflareAPI, workerUrlSettle, cloudflareRetries = was, settle, retries })
	api, err := cloudflare.NewWithAPIToken("cli-token")
	require.NoError(t, err)
	return NewCloudflareResource(context.Background(), func() (*cloudflare.API, error) { return api, nil }), &calls
}

const ok = `{"success":true,"errors":[],"result":{}}`

func TestWorkerUrl(t *testing.T) {
	t.Run("turned on", func(t *testing.T) {
		cf, calls := fakeCloudflare(t, func(c call) (int, string) {
			if c.method == "GET" {
				return 200, `{"success":true,"result":{"subdomain":"lab"}}`
			}
			return 200, ok
		})
		var out CreateResult[WorkerUrlOutputs]
		require.NoError(t, (&WorkerUrl{cf}).Create(&WorkerUrlInputs{AccountId: "acct", ScriptName: "app-dev-api", Enabled: true}, &out))
		assert.Equal(t, "app-dev-api", out.ID)
		assert.Equal(t, "app-dev-api.lab.workers.dev", out.Outs.Url)
		require.Len(t, *calls, 2)
		assert.Equal(t, call{"POST", "/accounts/acct/workers/scripts/app-dev-api/subdomain", "Bearer cli-token", "application/json", `{"enabled":true}`}, (*calls)[0])
		assert.Equal(t, "/accounts/acct/workers/subdomain", (*calls)[1].path)
	})

	t.Run("turned off", func(t *testing.T) {
		cf, calls := fakeCloudflare(t, func(call) (int, string) { return 200, ok })
		var out UpdateResult[WorkerUrlOutputs]
		require.NoError(t, (&WorkerUrl{cf}).Update(&UpdateInput[WorkerUrlInputs, WorkerUrlOutputs]{
			ID:   "app-dev-api",
			News: WorkerUrlInputs{AccountId: "acct", ScriptName: "app-dev-api", Enabled: false},
		}, &out))
		assert.Equal(t, "", out.Outs.Url)
		require.Len(t, *calls, 1)
		assert.Equal(t, `{"enabled":false}`, (*calls)[0].body)
	})

	t.Run("a failure, tried again", func(t *testing.T) {
		tries := 0
		cf, calls := fakeCloudflare(t, func(c call) (int, string) {
			if c.method == "POST" {
				tries++
				if tries < 3 {
					return 500, `{"success":false,"errors":[{"code":10013,"message":"try again"}]}`
				}
			}
			if c.method == "GET" {
				return 200, `{"success":true,"result":{"subdomain":"lab"}}`
			}
			return 200, ok
		})
		var out CreateResult[WorkerUrlOutputs]
		require.NoError(t, (&WorkerUrl{cf}).Create(&WorkerUrlInputs{AccountId: "acct", ScriptName: "s", Enabled: true}, &out))
		assert.Len(t, *calls, 4)
	})

	t.Run("a failure that lasts", func(t *testing.T) {
		cf, calls := fakeCloudflare(t, func(call) (int, string) {
			return 403, `{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}`
		})
		var out CreateResult[WorkerUrlOutputs]
		err := (&WorkerUrl{cf}).Create(&WorkerUrlInputs{AccountId: "acct", ScriptName: "s", Enabled: true}, &out)
		assert.ErrorContains(t, err, "Authentication error")
		assert.Len(t, *calls, 4)
	})
}

// settingsOf is the settings a request to a script's settings sent
func settingsOf(t *testing.T, c call) map[string]any {
	t.Helper()
	media, params, err := mime.ParseMediaType(c.contentType)
	require.NoError(t, err)
	require.Equal(t, "multipart/form-data", media)
	part, err := multipart.NewReader(strings.NewReader(c.body), params["boundary"]).NextPart()
	require.NoError(t, err)
	assert.Equal(t, "settings", part.FormName())
	assert.Equal(t, "application/json", part.Header.Get("Content-Type"))
	var settings map[string]any
	require.NoError(t, json.NewDecoder(part).Decode(&settings))
	return settings
}

func TestWorkerPlacement(t *testing.T) {
	cf, calls := fakeCloudflare(t, func(call) (int, string) { return 200, ok })
	placement := &WorkerPlacement{cf}

	var created CreateResult[WorkerPlacementOutputs]
	require.NoError(t, placement.Create(&WorkerPlacementInputs{AccountId: "acct", ScriptName: "app-dev-api", Mode: "smart"}, &created))
	assert.Equal(t, "app-dev-api", created.ID)
	assert.Equal(t, WorkerPlacementOutputs{AccountId: "acct", ScriptName: "app-dev-api"}, created.Outs)

	var updated UpdateResult[WorkerPlacementOutputs]
	require.NoError(t, placement.Update(&UpdateInput[WorkerPlacementInputs, WorkerPlacementOutputs]{
		ID:   "app-dev-api",
		News: WorkerPlacementInputs{AccountId: "acct", ScriptName: "app-dev-api", Region: "aws:us-east-1"},
	}, &updated))

	var deleted int
	require.NoError(t, placement.Delete(&DeleteInput[WorkerPlacementOutputs]{ID: "app-dev-api", Outs: created.Outs}, &deleted))

	require.Len(t, *calls, 3)
	for _, c := range *calls {
		assert.Equal(t, "PATCH", c.method)
		assert.Equal(t, "/accounts/acct/workers/scripts/app-dev-api/settings", c.path)
		assert.Equal(t, "Bearer cli-token", c.auth)
	}
	assert.Equal(t, map[string]any{"placement": map[string]any{"mode": "smart"}}, settingsOf(t, (*calls)[0]))
	assert.Equal(t, map[string]any{"placement": map[string]any{"region": "aws:us-east-1"}}, settingsOf(t, (*calls)[1]))
	// Back to Cloudflare's default
	assert.Equal(t, map[string]any{"placement": map[string]any{}}, settingsOf(t, (*calls)[2]))
}
