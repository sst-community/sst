package project

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"

	"github.com/Masterminds/semver/v3"
	"github.com/sst/sst/v3/internal/util"
	"github.com/sst/sst/v3/pkg/js"
	"github.com/sst/sst/v3/platform"
)

// A component package says in its package.json, as peer dependencies, which
// versions of SST it works with and which providers it uses. Each package in
// the build that imports `sst/components` is checked against the CLI and the
// app's providers before the app runs. Otherwise a missing provider is still
// found, as the platform depends on some providers itself, and its resources
// are created with a provider the app hasn't configured. modules are the
// platform's (platformModules).
func checkPackages(meta js.Metafile, version string, lock ProviderLock, modules map[string]string) error {
	problems := []string{}
	for _, dir := range componentPackages(meta, modules) {
		data, err := os.ReadFile(filepath.Join(dir, "package.json"))
		if err != nil {
			continue
		}
		var pkg struct {
			Name             string            `json:"name"`
			PeerDependencies map[string]string `json:"peerDependencies"`
		}
		if err := json.Unmarshal(data, &pkg); err != nil {
			continue
		}
		for _, dependency := range sortedKeys(pkg.PeerDependencies) {
			needed := pkg.PeerDependencies[dependency]
			if dependency == "sst" {
				if !satisfies(version, needed) {
					problems = append(problems, fmt.Sprintf(`"%s" needs sst %s, and this is %s.`, pkg.Name, needed, version))
				}
				continue
			}
			if !isProviderPackage(dependency) {
				continue
			}
			index := slices.IndexFunc(lock, func(entry *ProviderLockEntry) bool { return entry.Package == dependency })
			if index == -1 {
				name := dependency[strings.LastIndex(dependency, "/")+1:]
				problems = append(problems, fmt.Sprintf(`"%s" needs the %s provider. Add it with "sst add %s".`, pkg.Name, name, name))
				continue
			}
			if !satisfies(lock[index].Version, needed) {
				problems = append(problems, fmt.Sprintf(`"%s" needs %s %s, and the app has %s.`, pkg.Name, dependency, needed, lock[index].Version))
			}
		}
	}
	if len(problems) > 0 {
		return fmt.Errorf("%s", strings.Join(problems, "\n"))
	}
	return nil
}

// The directories of the packages in the build that import the platform's
// modules, like `sst/components`
func componentPackages(meta js.Metafile, modules map[string]string) []string {
	found := map[string]bool{}
	for file, input := range meta.Inputs {
		imports := slices.ContainsFunc(input.Imports, func(i js.MetafileImport) bool {
			_, ok := modules[i.Original]
			return ok
		})
		if !imports {
			continue
		}
		if dir := packageDir(file); dir != "" {
			found[dir] = true
		}
	}
	return sortedKeys(found)
}

// The directory of the package in node_modules that a file is in
func packageDir(file string) string {
	file = filepath.ToSlash(file)
	index := strings.LastIndex(file, "node_modules/")
	if index == -1 {
		return ""
	}
	rest := strings.Split(file[index+len("node_modules/"):], "/")
	name := rest[0]
	if strings.HasPrefix(name, "@") && len(rest) > 1 {
		name += "/" + rest[1]
	}
	dir, err := filepath.Abs(filepath.FromSlash(file[:index] + "node_modules/" + name))
	if err != nil {
		return ""
	}
	return dir
}

// The packages the config lists under `packages`, for an app without a
// package.json. `sst install` puts them in the platform, next to the
// providers, so each one has to be a package nothing else installs there.
func (p *Project) checkConfigPackages() error {
	if len(p.app.Packages) == 0 {
		return nil
	}
	platformPkg, err := platform.PackageJson()
	if err != nil {
		return err
	}
	var app js.PackageJson
	if data, err := os.ReadFile(filepath.Join(p.PathRoot(), "package.json")); err == nil {
		json.Unmarshal(data, &app)
	}
	for _, name := range sortedKeys(p.app.Packages) {
		_, inPlatform := platformPkg.Dependencies[name]
		_, inApp := app.Dependencies[name]
		_, inAppDev := app.DevDependencies[name]
		switch {
		case p.app.Packages[name] == "":
			return util.NewReadableError(nil, fmt.Sprintf(`The package "%s" is missing a version.`, name))
		case name == "@pulumi/pulumi":
			return util.NewReadableError(nil, `SST installs "@pulumi/pulumi" itself. Remove it from packages.`)
		case isProviderPackage(name):
			return util.NewReadableError(nil, fmt.Sprintf(`"%s" is a provider. Add it to providers instead, with "sst add".`, name))
		case inPlatform:
			return util.NewReadableError(nil, fmt.Sprintf(`SST installs "%s" itself. Remove it from packages.`, name))
		case inApp || inAppDev:
			return util.NewReadableError(nil, fmt.Sprintf(`"%s" is in both package.json and the packages in sst.config.ts. Keep it in one of them.`, name))
		}
	}
	return nil
}

// The packages the config listed at the last install that succeeded, as the
// provider lock records the providers. The platform's package.json can't say:
// it's written before the install, which can fail.
func (p *Project) installedPackages() map[string]string {
	installed := map[string]string{}
	data, err := os.ReadFile(filepath.Join(p.PathPlatformDir(), "installed-packages.json"))
	if err == nil {
		json.Unmarshal(data, &installed)
	}
	return installed
}

func (p *Project) writeInstalledPackages() error {
	packages := p.app.Packages
	if packages == nil {
		packages = map[string]string{}
	}
	data, err := json.MarshalIndent(packages, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(p.PathPlatformDir(), "installed-packages.json"), data, 0644)
}

// Whether the packages the config lists aren't the ones installed: one was
// added, removed, or given another version, or isn't in the platform
func (p *Project) packagesNeedInstall() bool {
	installed := p.installedPackages()
	if len(installed) != len(p.app.Packages) {
		return true
	}
	for name, version := range p.app.Packages {
		if installed[name] != version {
			return true
		}
		if _, err := os.Stat(filepath.Join(p.PathPlatformDir(), "node_modules", name, "package.json")); err != nil {
			return true
		}
	}
	return false
}

func isProviderPackage(name string) bool {
	if name == "@pulumi/pulumi" {
		return false
	}
	for _, scope := range []string{"@pulumi/", "@pulumiverse/", "@sst-provider/"} {
		if strings.HasPrefix(name, scope) {
			return true
		}
	}
	return false
}

// Whether a version is in a range. A dev build, or a range that isn't one,
// isn't checked.
func satisfies(version string, needed string) bool {
	if version == "" || version == "dev" {
		return true
	}
	constraint, err := semver.NewConstraint(needed)
	if err != nil {
		return true
	}
	v, err := semver.NewVersion(version)
	if err != nil {
		return true
	}
	return constraint.Check(v)
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
