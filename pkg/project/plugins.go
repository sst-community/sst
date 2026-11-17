package project

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/sst/sst/v3/pkg/global"
	"github.com/sst/sst/v3/pkg/process"
)

// plugin is a provider's Pulumi plugin, as its package names it
type plugin struct {
	Name    string
	Version string
	Server  string
}

// pluginsIn lists the plugins of the providers installed in a node_modules
// folder: each package whose package.json marks it as a Pulumi resource
// provider, as Pulumi's Node.js host finds them.
func pluginsIn(nodeModules string) []plugin {
	dirs := []string{}
	entries, _ := os.ReadDir(nodeModules)
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		if !strings.HasPrefix(entry.Name(), "@") {
			dirs = append(dirs, filepath.Join(nodeModules, entry.Name()))
			continue
		}
		scoped, _ := os.ReadDir(filepath.Join(nodeModules, entry.Name()))
		for _, s := range scoped {
			if s.IsDir() {
				dirs = append(dirs, filepath.Join(nodeModules, entry.Name(), s.Name()))
			}
		}
	}
	result := []plugin{}
	for _, dir := range dirs {
		data, err := os.ReadFile(filepath.Join(dir, "package.json"))
		if err != nil {
			continue
		}
		var pkg struct {
			Name    string `json:"name"`
			Version string `json:"version"`
			Pulumi  struct {
				Resource bool   `json:"resource"`
				Name     string `json:"name"`
				Version  string `json:"version"`
				Server   string `json:"server"`
			} `json:"pulumi"`
		}
		if json.Unmarshal(data, &pkg) != nil || !pkg.Pulumi.Resource {
			continue
		}
		p := plugin{Name: pkg.Pulumi.Name, Version: pkg.Pulumi.Version, Server: pkg.Pulumi.Server}
		if p.Name == "" {
			p.Name = strings.TrimPrefix(pkg.Name, "@pulumi/")
		}
		if p.Version == "" {
			p.Version = pkg.Version
		}
		result = append(result, p)
	}
	return result
}

// installed is whether Pulumi has a plugin already, in its home. One whose
// install was stopped partway still has its `.partial` marker.
func (p plugin) installed(home string) bool {
	dir := filepath.Join(home, "plugins", "resource-"+p.Name+"-v"+strings.TrimPrefix(p.Version, "v"))
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		return false
	}
	_, err = os.Stat(dir + ".partial")
	return errors.Is(err, os.ErrNotExist)
}

// installPlugins installs the plugins of the platform's providers that Pulumi
// doesn't have yet, with the CLI's own environment. On a target's stage the
// program and Pulumi's engine reach nothing but this machine, so the engine
// doesn't download one as it runs (programEnv). A plugin that can't be
// installed, offline say, is left: the program may not use it, and if it
// does, Pulumi says which one is missing and how to install it.
func (p *Project) installPlugins(ctx context.Context, pulumiPath string) {
	home := global.ConfigDir()
	for _, plugin := range pluginsIn(filepath.Join(p.PathPlatformDir(), "node_modules")) {
		if plugin.installed(home) {
			continue
		}
		slog.Info("installing plugin", "name", plugin.Name, "version", plugin.Version)
		args := []string{"plugin", "install", "resource", plugin.Name, plugin.Version}
		if plugin.Server != "" {
			args = append(args, "--server", plugin.Server)
		}
		cmd := process.CommandContext(ctx, pulumiPath, args...)
		cmd.Env = append(os.Environ(), "PULUMI_HOME="+home, "PULUMI_SKIP_UPDATE_CHECK=true")
		if out, err := cmd.CombinedOutput(); err != nil {
			slog.Warn("plugin install failed", "name", plugin.Name, "version", plugin.Version, "err", err, "output", strings.TrimSpace(string(out)))
		}
	}
}
