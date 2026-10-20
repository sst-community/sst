package npm

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewestInMajor(t *testing.T) {
	published := []string{"4.17.2", "4.17.3", "4.18.0", "4.19.0-beta.1", "5.0.0-alpha.1", "5.0.0-alpha.2", "not-a-version"}

	cases := []struct{ current, want string }{
		// Not 4.19.0-beta.1, as it isn't a prerelease
		{"4.17.2", "4.18.0"},
		{"5.0.0-alpha.1", "5.0.0-alpha.2"},
	}
	for _, c := range cases {
		newest, ok, err := NewestInMajor(c.current, published)
		require.NoError(t, err)
		assert.True(t, ok)
		assert.Equal(t, c.want, newest, "from %s", c.current)
	}

	// Once 5.0.0 is out, a prerelease moves on to it
	newest, _, err := NewestInMajor("5.0.0-alpha.2", append(published, "5.0.0"))
	require.NoError(t, err)
	assert.Equal(t, "5.0.0", newest)

	// A dev build isn't a version
	_, ok, err := NewestInMajor("dev", published)
	assert.False(t, ok)
	assert.NoError(t, err)

	// Nor is a snapshot build, though 0.x has a placeholder
	_, ok, err = NewestInMajor("0.0.0-1760000000", append(published, "0.0.0-placeholder.0"))
	assert.False(t, ok)
	assert.NoError(t, err)

	// Nothing in its major
	_, ok, err = NewestInMajor("6.0.0", published)
	assert.True(t, ok)
	assert.Error(t, err)

	// Only prereleases in its major, which a release doesn't move to
	_, ok, err = NewestInMajor("5.0.0", published)
	assert.True(t, ok)
	assert.Error(t, err)
}

func TestNewest(t *testing.T) {
	listed := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/@acme/cli":
			listed++
			w.Write([]byte(`{"versions":{"4.17.3":{},"4.18.0":{},"5.0.0-alpha.1":{}}}`))
		case "/@acme/cli/latest":
			w.Write([]byte(`{"name":"@acme/cli","version":"4.18.0"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	registry := Registry{url: server.URL}

	newest, err := Newest(registry, "@acme/cli", "5.0.0-alpha.1")
	require.NoError(t, err)
	assert.Equal(t, "5.0.0-alpha.1", newest)

	newest, err = Newest(registry, "@acme/cli", "4.17.3")
	require.NoError(t, err)
	assert.Equal(t, "4.18.0", newest)

	// A dev or snapshot build doesn't list the versions it won't pick from
	for _, current := range []string{"dev", "0.0.0-1760000000"} {
		listed = 0
		newest, err = Newest(registry, "@acme/cli", current)
		require.NoError(t, err)
		assert.Equal(t, "4.18.0", newest, "from %s", current)
		assert.Equal(t, 0, listed, "from %s", current)
	}
}
