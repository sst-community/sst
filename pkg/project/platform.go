package project

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/sst/sst/v3/pkg/js"
	"github.com/sst/sst/v3/platform"
)

func (p *Project) CheckPlatform(version string) bool {
	return PlatformCurrent(p.PathPlatformDir(), version)
}

func (p *Project) CopyPlatform(version string) error {
	if err := CopyPlatformTo(p.PathPlatformDir(), version); err != nil {
		return err
	}
	p.lock = ProviderLock{}
	return nil
}

// PlatformCurrent is whether the platform's files in dir are this CLI's
func PlatformCurrent(dir, version string) bool {
	slog.Info("checking platform")
	contents, err := os.ReadFile(filepath.Join(dir, "version"))
	if err != nil {
		slog.Error(err.Error())
		return false
	}
	return string(contents) == platformVersion(version)
}

// CopyPlatformTo puts this CLI's platform files in dir, in place of what's there
func CopyPlatformTo(dir, version string) error {
	slog.Info("installing platform")
	os.RemoveAll(dir)
	if err := platform.CopyTo(".", dir); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "version"), []byte(platformVersion(version)), 0644)
}

// platformVersion is what the platform's files are marked with: the CLI's
// version, or for a build of its own, when the binary was built
func platformVersion(version string) string {
	if version == "dev" {
		currentExecutable, _ := os.Executable()
		info, _ := os.Stat(currentExecutable)
		return fmt.Sprint(info.ModTime().UnixMilli())
	}
	return version
}

func getPackageJson(proj *Project, pkg string) (*js.PackageJson, error) {
	data, err := os.ReadFile(
		filepath.Join(
			proj.PathWorkingDir(),
			"node_modules",
			pkg,
			"package.json",
		),
	)

	if err != nil {
		return nil, err
	}

	var parsed js.PackageJson
	err = json.Unmarshal(data, &parsed)
	if err != nil {
		return nil, err
	}
	return &parsed, nil
}
