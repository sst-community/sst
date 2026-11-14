package js

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	esbuild "github.com/evanw/esbuild/pkg/api"
)

var ErrTopLevelImport = fmt.Errorf("ErrTopLevelImport")

type EvalOptions struct {
	Dir     string
	Outfile string
	Code    string
	Env     []string
	Globals []Global
	Banner  string
	Inject  []string
	Define  map[string]string
	// The modules the app imports from its platform, like `sst/components`
	// (PlatformManifest), each with its file. A build that runs the app
	// resolves each to its file; one that reads only `app()` leaves them out.
	Platform map[string]string
	// LoadProviders is whether a build that only reads `app()` loads the
	// providers' modules the app's files import, like `@pulumi/aws`, as SST 4
	// did, rather than leaving them out (NotLoaded)
	LoadProviders bool
}

// Marks the resolve that checks whether a package can be found when `app()`
// is read, so it isn't checked again
type notFoundCheck struct{}

var notFound = notFoundCheck{}

// A module that every file of the app, and every package it imports, can use
// by name without importing it, like `sst` and `aws` in `sst.config.ts`.
type Global struct {
	Name   string
	Module string
}

type PackageJson struct {
	Version         string            `json:"version"`
	Dependencies    map[string]string `json:"dependencies"`
	DevDependencies map[string]string `json:"devDependencies"`
	// SST is a platform's manifest, in the platform's own package.json
	SST   *PlatformManifest      `json:"sst,omitempty"`
	Other map[string]interface{} `json:"-"`
}

// PlatformManifest is what a platform says it is, as `sst` in its
// package.json: the program contract its components speak, its types, and
// the modules an app imports from it. The CLI embeds one platform, SST 4's
// or SST 5's, and reads what to do with it from here.
type PlatformManifest struct {
	// Contract is the version of the program contract its components speak:
	// 0 for SST 4's, 1 for SST 5's. Every platform states it: one that
	// doesn't is refused, rather than taken for SST 4's.
	Contract *int `json:"contract"`
	// Types are what an app's types import from the platform's types
	Types PlatformTypes `json:"types"`
	// Modules are the modules an app or a component package imports from the
	// app's own platform, rather than from its node_modules, like
	// `sst/components/aws`, each with its file in the platform's types,
	// without an extension, like `components/aws/index`
	Modules map[string]string `json:"modules,omitempty"`
}

// Speaks is whether the platform states it speaks this version of the
// program contract
func (m *PlatformManifest) Speaks(version int) bool {
	return m != nil && m.Contract != nil && *m.Contract == version
}

// PlatformTypes are what an app's types import from a platform's types: its
// compiled declarations in a released CLI, and its source in a build
// without them
type PlatformTypes struct {
	// Global are the files that declare the globals, like `global.d.ts`
	Global []string `json:"global"`
	// Config is the module of the config's types, like `config.js`
	Config string `json:"config"`
	// Paths are the modules TypeScript finds in the platform's types besides
	// its Modules, like `sst/testing`, each with its file as Modules has it
	Paths map[string]string `json:"paths,omitempty"`
}

type Metafile struct {
	Inputs map[string]struct {
		Bytes   int              `json:"bytes"`
		Imports []MetafileImport `json:"imports"`
	} `json:"inputs"`
	Outputs map[string]struct {
		Bytes  int `json:"bytes"`
		Inputs map[string]struct {
			BytesInOutput int `json:"bytesInOutput"`
		} `json:"inputs"`
		Exports    []string `json:"exports"`
		Entrypoint string   `json:"entrypoint"`
	} `json:"outputs"`
}

type MetafileImport struct {
	Path        string `json:"path"`
	Kind        string `json:"kind"`
	External    bool   `json:"external,omitempty"`
	Original    string `json:"original,omitempty"`
	Namespace   string `json:"namespace,omitempty"`
	SideEffects bool   `json:"sideEffects,omitempty"`
}

func Build(input EvalOptions) (esbuild.BuildResult, error) {
	outfile := input.Outfile
	if outfile == "" {
		outfile = filepath.Join(input.Dir, ".sst", "platform", fmt.Sprintf("sst.config.%v.mjs", time.Now().UnixMilli()))
	}
	slog.Info("esbuild building", "out", outfile)
	// A build with globals runs the app. The one without only reads `app()`,
	// and runs before the platform and the providers are installed.
	runsApp := len(input.Globals) > 0
	// Each global is imported under a name of its own at the top of every
	// file, and `define` points the global's name at it. `define` only
	// replaces a name the file doesn't declare, so a file that imports
	// `@pulumi/aws` as `aws` itself keeps its own.
	imports := []string{}
	define := map[string]string{}
	for key, value := range input.Define {
		define[key] = value
	}
	for _, global := range input.Globals {
		local := "__sst_global_" + global.Name
		imports = append(imports, fmt.Sprintf("import * as %s from %q;", local, global.Module))
		define[global.Name] = local
	}
	globals := strings.Join(imports, "\n")
	// esbuild reports the real path of a file, so the project's .sst directory is
	// also compared by its real path, for a project opened through a symlink.
	sstDirs := []string{filepath.Join(input.Dir, ".sst")}
	if realDir, err := filepath.EvalSymlinks(input.Dir); err == nil {
		if realSST := filepath.Join(realDir, ".sst"); realSST != sstDirs[0] {
			sstDirs = append(sstDirs, realSST)
		}
	}
	var err error
	result := esbuild.Build(esbuild.BuildOptions{
		Banner: map[string]string{
			"js": `
import { createRequire as topLevelCreateRequire } from 'module';
const require = topLevelCreateRequire(import.meta.url);
import { fileURLToPath as topLevelFileUrlToPath, URL as topLevelURL } from "url"
const __filename = topLevelFileUrlToPath(import.meta.url)
const __dirname = topLevelFileUrlToPath(new topLevelURL(".", import.meta.url))
` + input.Banner,
		},
		MainFields: []string{"module", "main"},
		Format:     esbuild.FormatESModule,
		Platform:   esbuild.PlatformNode,
		Sourcemap:  esbuild.SourceMapLinked,
		Stdin: &esbuild.StdinOptions{
			Contents:   input.Code,
			ResolveDir: input.Dir,
			Sourcefile: "eval.ts",
			Loader:     esbuild.LoaderTS,
		},
		NodePaths: []string{
			filepath.Join(input.Dir, ".sst", "platform", "node_modules"),
		},
		Plugins: []esbuild.Plugin{
			{
				Name: "DisallowImports",
				Setup: func(build esbuild.PluginBuild) {
					build.OnResolve(esbuild.OnResolveOptions{Filter: ".*"}, func(args esbuild.OnResolveArgs) (esbuild.OnResolveResult, error) {
						if !runsApp && filepath.Base(args.Importer) == "sst.config.ts" && args.Kind == esbuild.ResolveJSImportStatement {
							err = ErrTopLevelImport
							return esbuild.OnResolveResult{}, ErrTopLevelImport
						}
						return esbuild.OnResolveResult{}, nil
					})
				},
			},
			{
				// `sst/components` and its groups, like `sst/components/aws`,
				// are the files the `sst` global is made of, so a package that
				// imports them shares the app's components.
				Name: "PlatformModules",
				Setup: func(build esbuild.PluginBuild) {
					if len(input.Platform) == 0 {
						return
					}
					modules := []string{}
					for module := range input.Platform {
						modules = append(modules, regexp.QuoteMeta(module))
					}
					filter := "^(" + strings.Join(modules, "|") + ")$"
					build.OnResolve(esbuild.OnResolveOptions{Filter: filter}, func(args esbuild.OnResolveArgs) (esbuild.OnResolveResult, error) {
						if path, ok := input.Platform[args.Path]; ok && runsApp {
							// Resolved as any import is, symlinks included, so the
							// platform's own imports of the same file match it
							resolved := build.Resolve(path, esbuild.ResolveOptions{
								Kind:       args.Kind,
								ResolveDir: filepath.Dir(path),
							})
							if len(resolved.Errors) > 0 {
								return esbuild.OnResolveResult{Errors: resolved.Errors}, nil
							}
							return esbuild.OnResolveResult{Path: resolved.Path}, nil
						}
						return esbuild.OnResolveResult{Path: args.Path, Namespace: "not-loaded"}, nil
					})
				},
			},
			{
				// When only `app()` is read, the code `run()` imports is
				// bundled but not run. esbuild moves its imports of external
				// modules to the top of the bundle, where they'd be loaded
				// before the platform and the providers are installed. So the
				// platform's and the providers' modules are left out, but for
				// a platform that loads the providers (LoadProviders).
				Name: "NotLoaded",
				Setup: func(build esbuild.PluginBuild) {
					build.OnResolve(esbuild.OnResolveOptions{Filter: `^(@pulumi|@pulumiverse|@sst-provider)/`}, func(args esbuild.OnResolveArgs) (esbuild.OnResolveResult, error) {
						if runsApp || input.LoadProviders || filepath.Base(args.Importer) == "sst.config.ts" {
							return esbuild.OnResolveResult{}, nil
						}
						return esbuild.OnResolveResult{Path: args.Path, Namespace: "not-loaded"}, nil
					})
					build.OnLoad(esbuild.OnLoadOptions{Filter: ".*", Namespace: "not-loaded"}, func(args esbuild.OnLoadArgs) (esbuild.OnLoadResult, error) {
						contents := leftOut(args.Path + " is only loaded in run()")
						return esbuild.OnLoadResult{Contents: &contents, Loader: esbuild.LoaderJS}, nil
					})
					// A package `sst install` installs, like one the config
					// lists under `packages`, isn't there before the first
					// install. So when `app()` is read, a package that can't
					// be found is left out too. A build that runs the app
					// still fails on it.
					build.OnResolve(esbuild.OnResolveOptions{Filter: `^[^./]`}, func(args esbuild.OnResolveArgs) (esbuild.OnResolveResult, error) {
						if runsApp || args.PluginData == notFound {
							return esbuild.OnResolveResult{}, nil
						}
						resolved := build.Resolve(args.Path, esbuild.ResolveOptions{
							Importer:   args.Importer,
							Namespace:  args.Namespace,
							ResolveDir: args.ResolveDir,
							Kind:       args.Kind,
							PluginData: notFound,
						})
						if len(resolved.Errors) == 0 {
							return esbuild.OnResolveResult{}, nil
						}
						return esbuild.OnResolveResult{Path: args.Path, Namespace: "not-found"}, nil
					})
					build.OnLoad(esbuild.OnLoadOptions{Filter: ".*", Namespace: "not-found"}, func(args esbuild.OnLoadArgs) (esbuild.OnLoadResult, error) {
						contents := leftOut(args.Path + " isn't installed yet. A package that `sst install` installs, like one under `packages`, is only loaded in run()")
						return esbuild.OnLoadResult{Contents: &contents, Loader: esbuild.LoaderJS}, nil
					})
				},
			},
			{
				Name: "InjectGlobals",
				Setup: func(build esbuild.PluginBuild) {
					// .cjs and .cts files are left out: adding imports makes a
					// file an ES module, and they may use syntax only CommonJS
					// allows, like a top-level return
					build.OnLoad(esbuild.OnLoadOptions{Filter: `\.(m?[jt]s|[jt]sx)$`},
						func(args esbuild.OnLoadArgs) (esbuild.OnLoadResult, error) {
							for _, dir := range sstDirs {
								if isWithinDir(args.Path, dir) {
									return esbuild.OnLoadResult{}, nil
								}
							}
							contents, err := os.ReadFile(args.Path)
							if err != nil {
								return esbuild.OnLoadResult{}, err
							}
							// At the end, so the file's own lines keep their numbers
							// in an error. Imports run before the rest of a file
							// wherever they are.
							newContents := string(contents) + "\n" + globals
							return esbuild.OnLoadResult{
								Contents: &newContents,
								Loader:   esbuild.LoaderDefault,
							}, nil
						})
				},
			},
		},
		External: []string{
			"@pulumi/*",
			"undici",
			"@pulumiverse/*",
			"@sst-provider/*",
			"@aws-sdk/*",
			"esbuild",
			"archiver",
			"glob",
			"vite", // The remix component uses vite to resolve the user's vite config file. We don't want to bundle it.
		},
		Define:   define,
		Inject:   input.Inject,
		Outfile:  outfile,
		Write:    true,
		Bundle:   true,
		Metafile: true,
	})
	if err != nil {
		return esbuild.BuildResult{}, err
	}
	if len(result.Errors) > 0 {
		for _, err := range result.Errors {
			slog.Error("esbuild error", "text", err.Text)
		}
		return result, fmt.Errorf("%s", FormatError(result.Errors))
	}
	slog.Info("esbuild built", "outfile", outfile)

	analysis := esbuild.AnalyzeMetafile(result.Metafile, esbuild.AnalyzeMetafileOptions{
		Verbose: true,
	})
	os.WriteFile(filepath.Join(input.Dir, ".sst", "esbuild.json"), []byte(analysis), 0644)

	return result, nil
}

// leftOut is a module left out of a build, which throws message when anything
// is read from it. esbuild's interop copies a CommonJS module's own properties
// onto an object of its own for a named or namespace import, and makes that
// object with the module's prototype. So the reads are caught on the
// prototype: a module with no properties would read as empty. What esbuild
// and a promise ask of any module, `__esModule` and `then`, reads as
// undefined.
func leftOut(message string) string {
	return fmt.Sprintf(
		"module.exports = Object.create(new Proxy({}, { get(_, key) { if (key === \"__esModule\" || key === \"then\" || typeof key === \"symbol\") return undefined; throw new Error(%q); } }));",
		message,
	)
}

func isWithinDir(path, dir string) bool {
	rel, err := filepath.Rel(dir, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func FormatError(input []esbuild.Message) string {
	lines := []string{}
	for _, err := range input {
		if err.Location == nil {
			lines = append(lines, fmt.Sprintf("%v", err.Text))
			continue
		}
		lines = append(lines, fmt.Sprintf("%v:%v:%v: %v", err.Location.File, err.Location.Line, err.Location.Column, err.Text))
	}
	return strings.Join(lines, "\n")
}

func Cleanup(result esbuild.BuildResult) {
	for _, file := range result.OutputFiles {
		os.Remove(file.Path)
	}
}
