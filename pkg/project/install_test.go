package project

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Masterminds/semver/v3"
	"github.com/sst/sst/v3/platform"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestProviderLine(t *testing.T) {
	for _, tt := range []struct {
		version string
		built   string
		line    string
		ok      bool
	}{
		{"7.48.0", "7.48.0", "7.x", true},
		{"7.50.0", "7.48.0", "7.x", true},
		{"8.0.0", "7.48.0", "7.x", false},
		{"6.80.0", "7.48.0", "7.x", false},
		{"0.0.30", "0.0.22", "0.0.x", true},
		{"0.1.0", "0.0.22", "0.0.x", false},
		{"1.0.0", "0.0.22", "0.0.x", false},
	} {
		line, ok := providerLine(semver.MustParse(tt.version), semver.MustParse(tt.built))
		assert.Equal(t, tt.line, line, tt.version)
		assert.Equal(t, tt.ok, ok, tt.version)
	}
}

func TestNewestInLine(t *testing.T) {
	versions := []string{"4.4.0", "4.6.0", "4.6.1", "4.7.0-alpha.1", "5.3.1", "5.4.1"}
	assert.Equal(t, "4.6.1", newestInLine("4.6.0", versions))
	assert.Equal(t, "4.8.0", newestInLine("4.8.0", versions), "nothing newer than SST's")
	assert.Equal(t, "0.0.30", newestInLine("0.0.22", []string{"0.0.22", "0.0.30", "0.1.0"}))
}

// A registry with the vercel provider at the version SST comes with, one newer
// in the same major version, and a new major version, tagged latest. The aws
// provider at SST's version, and an older one tagged latest. And a provider
// SST's components don't use, at a version 9.
func fakeRegistry(t *testing.T) (built *semver.Version, newer string, major string) {
	t.Helper()
	pkg, err := platform.PackageJson()
	require.NoError(t, err)
	built = semver.MustParse(pkg.Dependencies["@pulumiverse/vercel"])
	newer = built.IncPatch().String()
	major = fmt.Sprintf("%d.0.0", built.Major()+1)
	aws := semver.MustParse(pkg.Dependencies["@pulumi/aws"])
	older := semver.MustParse(fmt.Sprintf("%d.0.0", aws.Major()))
	require.True(t, older.LessThan(aws), "the test expects SST's aws provider after %s", older)
	versions := map[string]string{
		"@pulumiverse/vercel": built.String() + " " + newer + " " + major,
		"@pulumi/gcp":         "9.0.0",
		"@pulumi/aws":         aws.String() + " " + older.String(),
	}
	alias := map[string]string{"@pulumiverse/vercel": "vercel", "@pulumi/gcp": "gcp", "@pulumi/aws": "aws"}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for name, list := range versions {
			all := strings.Fields(list)
			if r.URL.Path == "/"+name {
				data := map[string]map[string]any{"versions": {}}
				for _, version := range all {
					data["versions"][version] = map[string]any{}
				}
				json.NewEncoder(w).Encode(data)
				return
			}
			version, ok := strings.CutPrefix(r.URL.Path, "/"+name+"/")
			if !ok {
				continue
			}
			if version == "latest" {
				version = all[len(all)-1]
			}
			for _, published := range all {
				if published == version {
					json.NewEncoder(w).Encode(map[string]any{
						"name":    name,
						"version": version,
						"pulumi":  map[string]any{"name": alias[name]},
					})
					return
				}
			}
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(server.Close)
	t.Setenv("NPM_REGISTRY", server.URL)
	return built, newer, major
}

func TestGenerateProviderLock(t *testing.T) {
	built, newer, major := fakeRegistry(t)
	lock := func(name string, version string) error {
		p := sst5(&Project{app: &App{Providers: map[string]any{
			name: map[string]any{"version": version},
		}}})
		return p.generateProviderLock()
	}

	require.NoError(t, lock("vercel", built.String()))
	require.NoError(t, lock("vercel", newer))
	require.NoError(t, lock("gcp", "9.0.0"), "a provider SST's components don't use isn't checked")

	err := lock("vercel", major)
	var refused *ErrProviderMajorVersion
	require.True(t, errors.As(err, &refused), "%v", err)
	assert.Equal(t, ErrProviderMajorVersion{
		Name:    "vercel",
		Version: major,
		Needed:  built.String(),
		Line:    fmt.Sprintf("%d.x", built.Major()),
	}, *refused)
}

func TestFindProviderToAdd(t *testing.T) {
	_, newer, _ := fakeRegistry(t)
	pkg, err := platform.PackageJson()
	require.NoError(t, err)
	built := semver.MustParse(pkg.Dependencies["@pulumi/aws"])

	entry, err := FindProviderToAdd("vercel")
	require.NoError(t, err)
	assert.Equal(t, "@pulumiverse/vercel", entry.Package)
	assert.Equal(t, newer, entry.Version, "not the new major version tagged latest")

	entry, err = FindProviderToAdd("gcp")
	require.NoError(t, err)
	assert.Equal(t, "9.0.0", entry.Version)

	entry, err = FindProviderToAdd("aws")
	require.NoError(t, err)
	assert.Equal(t, built.String(), entry.Version, "not the older version tagged latest")
}
