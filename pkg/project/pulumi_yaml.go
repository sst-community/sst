package project

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"

	"github.com/pulumi/pulumi/sdk/v3/go/common/workspace"
	"gopkg.in/yaml.v3"
)

// sstPlugin is the name Pulumi runs the provider of the package `sst` by,
// SST's own resources. The sst binary serves it when it's run by this name
// (pkg/provider).
const sstPlugin = "pulumi-resource-sst"

// pulumiYaml is the work folder's Pulumi.yaml
type pulumiYaml struct {
	Name    string      `yaml:"name"`
	Runtime string      `yaml:"runtime"`
	Main    string      `yaml:"main"`
	Plugins pulumiPlugs `yaml:"plugins"`
}

type pulumiPlugs struct {
	Providers []workspace.PluginOptions `yaml:"providers"`
}

// writePulumiYaml writes the Pulumi.yaml Pulumi runs the program main with.
// It finds the provider of SST's own resources in plugins, with no version,
// so whatever version a resource asks for is the CLI's own.
func writePulumiYaml(path, name, main, plugins string) error {
	data, err := yaml.Marshal(pulumiYaml{
		Name:    name,
		Runtime: "nodejs",
		Main:    main,
		Plugins: pulumiPlugs{Providers: []workspace.PluginOptions{{Name: "sst", Path: plugins}}},
	})
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

// linkSstPlugin makes dir hold the provider of SST's own resources: the sst
// binary that's running, under the plugin's name, so the provider is always
// the CLI's version.
func linkSstPlugin(dir string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return err
	}
	return linkPlugin(dir, exe)
}

// linkPlugin makes dir hold exe under the plugin's name: a symlink to it, or
// where one can't be made, a hard link, then a copy. One that's already exe is
// left alone.
func linkPlugin(dir, exe string) error {
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	name := sstPlugin
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	path := filepath.Join(dir, name)
	if pluginIs(path, exe) {
		return nil
	}
	// Made beside it and moved into place, so a run starting Pulumi at the
	// same time never finds it missing or half written
	temp := filepath.Join(dir, fmt.Sprintf(".%s.%d", name, os.Getpid()))
	os.Remove(temp)
	if err := os.Symlink(exe, temp); err != nil {
		if err := os.Link(exe, temp); err != nil {
			if err := copyExecutable(exe, temp); err != nil {
				os.Remove(temp)
				return err
			}
		}
	}
	if err := os.Rename(temp, path); err != nil {
		os.Remove(temp)
		return err
	}
	return nil
}

// pluginIs is whether the plugin at path is exe already
func pluginIs(path, exe string) bool {
	if target, err := os.Readlink(path); err == nil {
		return target == exe
	}
	plugin, err := os.Stat(path)
	if err != nil {
		return false
	}
	binary, err := os.Stat(exe)
	if err != nil {
		return false
	}
	if os.SameFile(plugin, binary) {
		return true
	}
	// A copy, which copyExecutable gives the binary's time
	return plugin.Mode().IsRegular() && plugin.Size() == binary.Size() && plugin.ModTime().Equal(binary.ModTime())
}

// copyExecutable copies exe to path, with exe's modification time, so the
// next run sees it's the same binary without reading it
func copyExecutable(exe, path string) error {
	source, err := os.Open(exe)
	if err != nil {
		return err
	}
	defer source.Close()
	info, err := source.Stat()
	if err != nil {
		return err
	}
	target, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(target, source); err != nil {
		target.Close()
		return err
	}
	if err := target.Close(); err != nil {
		return err
	}
	return os.Chtimes(path, info.ModTime(), info.ModTime())
}
