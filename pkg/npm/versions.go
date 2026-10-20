package npm

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/Masterminds/semver/v3"
)

// The newest of the candidates in the same major version as current, so an
// upgrade never crosses into a major with breaking changes. Prereleases count
// only when current is one. ok is false when current isn't a release.
func NewestInMajor(current string, candidates []string) (newest string, ok bool, err error) {
	if !IsRelease(current) {
		return "", false, nil
	}
	v := semver.MustParse(current)
	var found *semver.Version
	for _, candidate := range candidates {
		c, err := semver.NewVersion(candidate)
		if err != nil || c.Major() != v.Major() {
			continue
		}
		if c.Prerelease() != "" && v.Prerelease() == "" {
			continue
		}
		if found == nil || c.GreaterThan(found) {
			found = c
		}
	}
	if found == nil {
		return "", true, fmt.Errorf("there is no version %d.x to upgrade to", v.Major())
	}
	return found.Original(), true, nil
}

// Whether version is a release: not a dev build, and not a snapshot build's
// 0.0.0-<timestamp>. npm has a 0.0.0-placeholder.0, so 0.x isn't empty there.
func IsRelease(version string) bool {
	v, err := semver.NewVersion(version)
	return err == nil && v.Major() != 0
}

// The newest version of a package in the same major version as current. A
// current that isn't a release gets the one tagged latest.
func Newest(registry Registry, name string, current string) (string, error) {
	if IsRelease(current) {
		versions, err := Versions(registry, name)
		if err != nil {
			return "", err
		}
		newest, ok, err := NewestInMajor(current, versions)
		if ok {
			return newest, err
		}
	}
	pkg, err := Get(registry, name, "latest")
	if err != nil {
		return "", err
	}
	return pkg.Version, nil
}

// Every published version of a package
func Versions(registry Registry, name string) ([]string, error) {
	req, err := http.NewRequest("GET", fmt.Sprintf("%s/%s", registry.url, name), nil)
	if err != nil {
		return nil, err
	}
	// The abbreviated document, which has the versions without their readmes
	req.Header.Set("Accept", "application/vnd.npm.install-v1+json")
	if registry.auth.token != "" {
		req.Header.Set("Authorization", registry.auth.scheme+" "+registry.auth.token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("failed to fetch package: %s", resp.Status)
	}
	var data struct {
		Versions map[string]json.RawMessage `json:"versions"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return nil, err
	}
	versions := make([]string, 0, len(data.Versions))
	for version := range data.Versions {
		versions = append(versions, version)
	}
	return versions, nil
}
