package transport

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/bridge"
	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/bridge/transporttest"
	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/httpbus"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The HTTP transport passes the suite every transport does: sst dev's side
// from Connect, and each other connection the way a stub makes its own.
func TestHTTPTransportSuite(t *testing.T) {
	h := NewHTTP(filepath.Join(t.TempDir(), "dev.transport.json"))
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	dev, err := h.Connect(ctx)
	require.NoError(t, err)
	settings, err := h.settings()
	require.NoError(t, err)
	first := true
	var mu sync.Mutex
	transporttest.Run(t, transporttest.Options{
		Connect: func(t *testing.T) bridge.Conn {
			mu.Lock()
			defer mu.Unlock()
			if first {
				first = false
				return dev
			}
			conn, err := httpbus.Dial(fmt.Sprintf("http://127.0.0.1:%d", settings.Port), settings.Token)
			require.NoError(t, err)
			return conn
		},
		Reconnect: func(t *testing.T, conn bridge.Conn) {
			conn.(*httpbus.Connection).Reconnect(context.Background())
		},
	})
}

func TestHTTPTransport(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dev.transport.json")
	ctx := context.Background()

	t.Run("gives the stub the same address and token each run", func(t *testing.T) {
		first, err := NewHTTP(path).Stub(ctx)
		require.NoError(t, err)
		second, err := NewHTTP(path).Stub(ctx)
		require.NoError(t, err)
		assert.Equal(t, first, second)
		assert.Regexp(t, `^http://host\.docker\.internal:\d+$`, first.Environment[EnvHTTPAddress])
		assert.Len(t, first.Environment[EnvHTTPToken], 64)
		assert.Empty(t, first.Permissions)
		info, err := os.Stat(path)
		require.NoError(t, err)
		assert.Equal(t, os.FileMode(0600), info.Mode().Perm(), "only the developer reads the token")
	})

	t.Run("two processes at once make one", func(t *testing.T) {
		other := filepath.Join(t.TempDir(), "dev.transport.json")
		results := make([]map[string]string, 8)
		var wg sync.WaitGroup
		for i := range results {
			wg.Add(1)
			go func() {
				defer wg.Done()
				stub, err := NewHTTP(other).Stub(ctx)
				assert.NoError(t, err)
				results[i] = stub.Environment
			}()
		}
		wg.Wait()
		for _, result := range results[1:] {
			assert.Equal(t, results[0], result)
		}
	})

	t.Run("turns down a request without the token", func(t *testing.T) {
		h := NewHTTP(path)
		ctx, cancel := context.WithCancel(ctx)
		defer cancel()
		_, err := h.Connect(ctx)
		require.NoError(t, err)
		settings, err := h.settings()
		require.NoError(t, err)
		for _, token := range []string{"", "Bearer wrong"} {
			req, _ := http.NewRequest("POST", fmt.Sprintf("http://127.0.0.1:%d/publish?channel=/sst/app/stage/in", settings.Port), nil)
			if token != "" {
				req.Header.Set("Authorization", token)
			}
			resp, err := http.DefaultClient.Do(req)
			require.NoError(t, err)
			resp.Body.Close()
			assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
		}
	})

	t.Run("says when its port is taken", func(t *testing.T) {
		h := NewHTTP(path)
		ctx, cancel := context.WithCancel(ctx)
		defer cancel()
		_, err := h.Connect(ctx)
		require.NoError(t, err)
		_, err = NewHTTP(path).Connect(ctx)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "in use")
	})

	t.Run("forgets them on remove", func(t *testing.T) {
		require.NoError(t, NewHTTP(path).Remove(ctx))
		_, err := os.Stat(path)
		assert.True(t, os.IsNotExist(err))
		assert.NoError(t, NewHTTP(path).Remove(ctx), "nothing to remove is no error")
	})
}
