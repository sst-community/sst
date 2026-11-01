package project

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/sst/sst/v3/pkg/js"
)

// Where the platform's types are, relative to the platform: compiled
// declarations in a released CLI, and the source in a build without them.
func platformTypes(platformDir string) string {
	if _, err := os.Stat(filepath.Join(platformDir, "dist", "types", "global.d.ts")); err == nil {
		return "dist/types"
	}
	return "src"
}

// Where each module a package imports from the app's platform is
// (js.PlatformModules), in the platform's components folder and without an
// extension: `sst/components` is what SST's components share, and each group,
// like `sst/components/aws`, is the components of a provider.
func platformModuleFiles() map[string]string {
	files := map[string]string{}
	for _, module := range js.PlatformModules {
		if group, ok := strings.CutPrefix(module, "sst/components/"); ok {
			files[module] = group + "/index"
			continue
		}
		files[module] = "core"
	}
	return files
}

// Writes .sst/tsconfig.json, for an app, or the repo of a component package,
// to extend. It tells TypeScript where `sst/components` and its groups,
// `sst/testing` and the providers are: they're installed in .sst/platform,
// where TypeScript doesn't look for them. Each is a file, with its extension:
// under `moduleResolution: "NodeNext"`, TypeScript doesn't add one to a path
// or look in a folder, as it does under `bundler`.
func (p *Project) writeTsconfig() error {
	platformDir := p.PathPlatformDir()
	dir := platformTypes(platformDir)
	types := "./platform/" + dir
	ext := ".d.ts"
	if dir == "src" {
		ext = ".ts"
	}
	paths := map[string][]string{
		"sst/testing": {types + "/testing/index" + ext},
	}
	for module, file := range platformModuleFiles() {
		paths[module] = []string{types + "/components/" + file + ext}
	}
	installed := func(name string) {
		dir := "./platform/node_modules/" + name
		paths[name] = []string{dir}
		if file := packageTypes(filepath.Join(platformDir, "node_modules", name)); file != "" {
			paths[name] = []string{dir + "/" + file}
		}
		paths[name+"/*"] = []string{dir + "/*"}
	}
	// The packages the config lists, which are installed with the providers
	if p.app != nil {
		for name := range p.app.Packages {
			installed(name)
		}
	}
	for _, scope := range []string{"@pulumi", "@pulumiverse", "@sst-provider"} {
		entries, err := os.ReadDir(filepath.Join(platformDir, "node_modules", scope))
		if err != nil {
			continue
		}
		for _, entry := range entries {
			installed(scope + "/" + entry.Name())
		}
	}
	data, err := json.MarshalIndent(map[string]any{
		"compilerOptions": map[string]any{"paths": paths},
	}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(p.PathWorkingDir(), "tsconfig.json"), append(data, '\n'), 0644)
}

// The file a package's types are in, from its package.json: its main export's
// `types`, its own `types` or `typings`, the declaration beside its `main`, or
// `index.d.ts`, the first that's there. Empty when there's none, and then
// TypeScript is pointed at its folder.
func packageTypes(dir string) string {
	data, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		return ""
	}
	var pkg struct {
		Types   string          `json:"types"`
		Typings string          `json:"typings"`
		Main    string          `json:"main"`
		Exports json.RawMessage `json:"exports"`
	}
	if json.Unmarshal(data, &pkg) != nil {
		return ""
	}
	candidates := []string{}
	var exports map[string]json.RawMessage
	if json.Unmarshal(pkg.Exports, &exports) == nil {
		// Its types, or those of a condition under it, like `import`
		var main map[string]json.RawMessage
		if json.Unmarshal(exports["."], &main) == nil {
			for _, key := range []string{"types", "import", "node", "default", "require"} {
				var file string
				var nested struct {
					Types string `json:"types"`
				}
				if json.Unmarshal(main[key], &file) == nil && key == "types" {
					candidates = append(candidates, file)
				} else if json.Unmarshal(main[key], &nested) == nil && nested.Types != "" {
					candidates = append(candidates, nested.Types)
				}
			}
		}
	}
	candidates = append(candidates, pkg.Types, pkg.Typings)
	if pkg.Main != "" {
		main := strings.TrimSuffix(strings.TrimSuffix(strings.TrimSuffix(pkg.Main, ".js"), ".cjs"), ".mjs")
		candidates = append(candidates, main+".d.ts")
	}
	candidates = append(candidates, "index.d.ts")
	for _, file := range candidates {
		if file == "" {
			continue
		}
		file = strings.TrimPrefix(file, "./")
		for _, name := range []string{file, file + ".d.ts", filepath.ToSlash(filepath.Join(file, "index.d.ts"))} {
			if info, err := os.Stat(filepath.Join(dir, name)); err == nil && !info.IsDir() {
				return name
			}
		}
	}
	return ""
}
