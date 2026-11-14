package project

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/Masterminds/semver/v3"
	"github.com/sst/sst/v3/pkg/flag"
	"github.com/sst/sst/v3/pkg/global"
	"github.com/sst/sst/v3/pkg/npm"
	"github.com/sst/sst/v3/pkg/process"
	"github.com/sst/sst/v3/pkg/project/path"
	"github.com/sst/sst/v3/platform"
	"golang.org/x/sync/errgroup"
)

type ErrProviderVersionTooLow struct {
	Name    string
	Version string
	Needed  string
}

func (err *ErrProviderVersionTooLow) Error() string {
	return "provider version too low"
}

// A version of a provider SST's components use, in another major version than
// the one they're built for. A new major version can remove or rename what
// they use.
type ErrProviderMajorVersion struct {
	Name    string
	Version string
	Needed  string
	Line    string
}

func (err *ErrProviderMajorVersion) Error() string {
	return "provider major version not supported"
}

// The versions of a provider SST's components are built for, given the one
// SST comes with: its major version, or before 1.0 its minor version, where a
// new minor version is the new major one. Returns them like "7.x", and whether
// version is one of them.
func providerLine(version *semver.Version, built *semver.Version) (string, bool) {
	if built.Major() == 0 {
		return fmt.Sprintf("0.%d.x", built.Minor()), version.Major() == 0 && version.Minor() == built.Minor()
	}
	return fmt.Sprintf("%d.x", built.Major()), version.Major() == built.Major()
}

func (p *Project) NeedsInstall() bool {
	if _, err := os.Stat(filepath.Join(p.PathPlatformDir(), "node_modules")); err != nil {
		return true
	}
	if len(p.app.Providers) != len(p.lock) {
		return true
	}
	if p.packagesNeedInstall() {
		return true
	}
	for _, entry := range p.lock {
		match, ok := p.app.Providers[entry.Name]
		if !ok {
			return false
		}
		config := match.(map[string]interface{})
		pkg := config["package"]
		if pkg != nil && pkg != "" && pkg != entry.Package {
			return true
		}
		version := config["version"]
		if version == nil || version == "" {
			continue
		}
		slog.Info("checking provider", "name", entry.Name, "version", version, "compare", entry.Version)
		if version != entry.Version {
			return true
		}
	}
	return false
}

func (p *Project) Install() error {
	slog.Info("installing deps")

	err := p.generateProviderLock()
	if err != nil {
		return err
	}

	err = p.writePackageJson()
	if err != nil {
		return err
	}

	err = p.fetchDeps()
	if err != nil {
		return err
	}

	err = p.writeInstalledPackages()
	if err != nil {
		return err
	}

	err = p.writeTypes()
	if err != nil {
		return err
	}

	err = p.writeTsconfig()
	if err != nil {
		return err
	}

	err = p.writeProviderLock()
	if err != nil {
		return err
	}

	return nil
}

func (p *Project) writePackageJson() error {
	slog.Info("writing package.json")
	packageJsonPath := filepath.Join(p.PathPlatformDir(), "package.json")
	packageJson, err := os.OpenFile(packageJsonPath, os.O_RDWR|os.O_CREATE, 0644)
	if err != nil {
		return err
	}
	defer packageJson.Close()

	var data []byte
	data, err = io.ReadAll(packageJson)
	if err != nil {
		return err
	}

	var result map[string]interface{}
	if err := json.Unmarshal(data, &result); err != nil {
		return err
	}

	dependencies := result["dependencies"].(map[string]interface{})
	for _, entry := range p.lock {
		slog.Info("adding dependency", "name", entry.Name)
		dependencies[entry.Package] = entry.Version
	}
	dependencies["@pulumi/pulumi"] = global.PULUMI_VERSION
	// A package the config no longer lists is removed. Its folder too, which
	// bun leaves, so the bundle can't still find it there.
	for name := range p.installedPackages() {
		if _, ok := p.app.Packages[name]; !ok {
			delete(dependencies, name)
			os.RemoveAll(filepath.Join(p.PathPlatformDir(), "node_modules", name))
		}
	}
	for name, version := range p.app.Packages {
		slog.Info("adding package", "name", name, "version", version)
		dependencies[name] = version
	}

	dataToWrite, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		return err
	}

	if err := packageJson.Truncate(0); err != nil {
		return err
	}

	if _, err := packageJson.Seek(0, 0); err != nil {
		return err
	}

	if _, err := packageJson.Write(dataToWrite); err != nil {
		return err
	}
	return nil
}

func (p *Project) writeTypes() error {
	slog.Info("writing types")
	typesPath := filepath.Join(p.PathPlatformDir(), "config.d.ts")
	file, err := os.OpenFile(typesPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
	if err != nil {
		return err
	}
	defer file.Close()

	// The globals' and the config's types, from where the platform has them
	types := "./" + platformTypes(p.PathPlatformDir())
	for _, global := range p.manifest.Types.Global {
		file.WriteString(`import "` + types + `/` + global + `"` + "\n")
	}
	file.WriteString(`import "../types.generated"` + "\n")
	file.WriteString(`import { AppInput, App, Config } from "` + types + `/` + p.manifest.Types.Config + `"` + "\n")

	for _, entry := range p.lock {
		file.WriteString(`import * as _` + entry.Alias + ` from "` + entry.Package + `";` + "\n")
	}

	file.WriteString("\n\n")

	file.WriteString(`declare global {` + "\n")
	for _, entry := range p.lock {
		file.WriteString(`  // @ts-expect-error` + "\n")
		file.WriteString(`  export import ` + entry.Alias + ` = _` + entry.Alias + "\n")
	}
	file.WriteString(`  interface Providers {` + "\n")
	file.WriteString(`    providers?: {` + "\n")
	for _, entry := range p.lock {
		versionField := "version: string"
		if entry.Name == "aws" || entry.Name == "cloudflare" {
			versionField = "version?: string"
		}
		file.WriteString(`      "` + entry.Name + `"?:  (_` + entry.Alias + `.ProviderArgs & { package?: string, ` + versionField + ` }) | string;` + "\n")
	}
	file.WriteString(`    }` + "\n")
	file.WriteString(`  }` + "\n")
	file.WriteString(`  export const $config: (` + "\n")
	file.WriteString(`    input: Omit<Config, "app"> & {` + "\n")
	file.WriteString(`      app(input: AppInput): Promise<Omit<App, "providers"> & Providers> | (Omit<App, "providers"> & Providers);` + "\n")
	file.WriteString(`    },` + "\n")
	file.WriteString(`  ) => Config;` + "\n")
	file.WriteString(`}` + "\n")

	return nil
}

func (p *Project) fetchDeps() error {
	slog.Info("fetching deps")
	manager := global.BunPath()
	if flag.SST_NO_BUN {
		manager = "npm"
	}
	cmd := process.Command(manager, "install")
	cmd.Dir = p.PathPlatformDir()
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to run %s install: %w\n%s", manager, err, output)
	}
	return nil
}

type ProviderLockEntry struct {
	Name    string `json:"name"`
	Package string `json:"package"`
	Version string `json:"version"`
	Alias   string `json:"alias"`
}

type ProviderLock = []*ProviderLockEntry

func (p *Project) loadProviderLock() error {
	lockPath := path.ResolveProviderLock(p.PathConfig())
	data, err := os.ReadFile(lockPath)
	if err != nil {
		p.lock = ProviderLock{}
		return nil
	}
	err = json.Unmarshal(data, &p.lock)
	if err != nil {
		return err
	}
	return nil
}

func (p *Project) generateProviderLock() error {
	var wg errgroup.Group
	out := ProviderLock{}
	results := make(chan ProviderLockEntry, 1000)
	pkg, err := platform.PackageJson()
	if err != nil {
		return err
	}
	for name, config := range p.app.Providers {
		n := name
		// Use the explicit package name if set, otherwise default to the provider name
		pkgName := config.(map[string]interface{})["package"]
		if pkgName == nil || pkgName == "" {
			pkgName = n
		}
		version := config.(map[string]interface{})["version"]
		if version == nil || version == "" {
			version = "latest"
		}
		wg.Go(func() error {
			result, err := FindProvider(n, version.(string), pkgName.(string))
			if err != nil {
				return err
			}
			if match, ok := pkg.Dependencies[result.Package]; ok {
				if version == "latest" {
					result.Version = match
				}
				if semver.MustParse(result.Version).Compare(semver.MustParse(match)) < 0 {
					results <- *result
					return &ErrProviderVersionTooLow{
						Name:    result.Name,
						Version: result.Version,
						Needed:  match,
					}
				}
				if line, ok := providerLine(semver.MustParse(result.Version), semver.MustParse(match)); !ok && p.speaks().HoldsProviderMajors() {
					results <- *result
					return &ErrProviderMajorVersion{
						Name:    result.Name,
						Version: result.Version,
						Needed:  match,
						Line:    line,
					}
				}
			}
			results <- *result
			return nil
		})
	}
	err = wg.Wait()
	if err != nil {
		return err
	}
	for range p.app.Providers {
		r := <-results
		out = append(out, &r)
	}
	close(results)
	p.lock = out
	return nil
}

func FindProvider(provider string, version string, pkg string) (*ProviderLockEntry, error) {
	registry := npm.LoadRegistry()
	for _, prefix := range []string{"@sst-provider/", "@pulumi/", "@pulumiverse/", "pulumi-", "@", ""} {
		npmPkg, err := npm.Get(registry, prefix+pkg, version)
		if err != nil {
			continue
		}
		if npmPkg.Pulumi == nil {
			continue
		}
		alias := npmPkg.Pulumi.Name
		if alias == "" || alias == "terraform-provider" {
			if npmPkg.Pulumi.Parameterization != nil && npmPkg.Pulumi.Parameterization.Name != "" {
				alias = npmPkg.Pulumi.Parameterization.Name
			} else {
				alias = npmPkg.Name
				alias = strings.ReplaceAll(alias, "@sst-provider", "")
				alias = strings.ReplaceAll(alias, "/", "")
				alias = strings.ReplaceAll(alias, "@", "")
				alias = strings.ReplaceAll(alias, "pulumi", "")
			}
		}
		alias = strings.ReplaceAll(alias, "-", "")
		return &ProviderLockEntry{
			Name:    provider,
			Package: npmPkg.Name,
			Version: npmPkg.Version,
			Alias:   alias,
		}, nil
	}
	return nil, fmt.Errorf("provider %s not found", provider)
}

// The provider `sst add` adds, at its latest version, or for a provider SST's
// components use, the latest of the versions they're built for
func FindProviderToAdd(provider string) (*ProviderLockEntry, error) {
	entry, err := FindProvider(provider, "latest", provider)
	if err != nil {
		return nil, err
	}
	pkg, err := platform.PackageJson()
	if err != nil {
		return nil, err
	}
	match, ok := pkg.Dependencies[entry.Package]
	if !ok {
		return entry, nil
	}
	latest, built := semver.MustParse(entry.Version), semver.MustParse(match)
	if _, ok := providerLine(latest, built); ok && !latest.LessThan(built) {
		return entry, nil
	}
	versions, err := npm.Versions(npm.LoadRegistry(), entry.Package)
	if err != nil {
		return nil, err
	}
	entry.Version = newestInLine(match, versions)
	return entry, nil
}

// The newest of the versions in the line SST's components are built for, and
// not older than the one SST comes with. Prereleases aren't taken.
func newestInLine(built string, versions []string) string {
	want := semver.MustParse(built)
	newest := want
	for _, version := range versions {
		candidate, err := semver.NewVersion(version)
		if err != nil || candidate.Prerelease() != "" || !candidate.GreaterThan(newest) {
			continue
		}
		if _, ok := providerLine(candidate, want); ok {
			newest = candidate
		}
	}
	return newest.Original()
}

func (p *Project) writeProviderLock() error {
	lockPath := path.ResolveProviderLock(p.PathConfig())
	data, err := json.MarshalIndent(p.lock, "", "  ")
	if err != nil {
		return err
	}
	err = os.WriteFile(lockPath, data, 0644)
	if err != nil {
		return err
	}
	return nil
}
