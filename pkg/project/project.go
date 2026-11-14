package project

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/Masterminds/semver/v3"
	"github.com/evanw/esbuild/pkg/api"
	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/bridge"
	"github.com/sst/sst/v3/internal/fs"
	"github.com/sst/sst/v3/internal/util"
	"github.com/sst/sst/v3/pkg/flag"
	"github.com/sst/sst/v3/pkg/js"
	"github.com/sst/sst/v3/pkg/process"
	"github.com/sst/sst/v3/pkg/project/provider"
	"github.com/sst/sst/v3/pkg/runtime"
	"github.com/sst/sst/v3/pkg/runtime/golang"
	"github.com/sst/sst/v3/pkg/runtime/node"
	"github.com/sst/sst/v3/pkg/runtime/python"
	"github.com/sst/sst/v3/pkg/runtime/rust"
	"github.com/sst/sst/v3/pkg/runtime/worker"
	"github.com/sst/sst/v3/pkg/target"
	"github.com/sst/sst/v3/pkg/transport"
)

type App struct {
	Name      string                 `json:"name"`
	Stage     string                 `json:"stage"`
	Removal   string                 `json:"removal"`
	Providers map[string]interface{} `json:"providers"`
	Packages  map[string]string      `json:"packages"` // installed in the platform, for an app without a package.json
	Home      string                 `json:"home"`
	// Targets are where a stage's cloud calls go, by stage, when it isn't the
	// real cloud: each a target's settings, a plain object of the type Target
	Targets map[string]json.RawMessage `json:"targets,omitempty"`
	Version string                     `json:"version"`
	Protect bool                       `json:"protect"`
	Watch   Watch                      `json:"watch"`
	State   *State                     `json:"state"`
	Dev     *AppDev                    `json:"dev"`
	Types   struct {
		Ignore []string `json:"ignore"`
	} `json:"types"`
	// Deprecated: Backend is now Home
	Backend string `json:"backend"`
	// Deprecated: RemovalPolicy is now Removal
	RemovalPolicy string `json:"removalPolicy"`
}

type State struct {
	Purge     bool `json:"purge"`
	Compress  bool `json:"compress"`
	Retention *int `json:"retention"`
}

func validateState(state *State) error {
	if state != nil && state.Retention != nil && *state.Retention < 1 {
		return util.NewReadableError(nil, `The "state.retention" property must be a positive integer.`)
	}
	return nil
}

type AppDev struct {
	// AppSync is which Event API sst dev uses on AWS: "shared", the default,
	// or "stage", the stage's own
	AppSync string `json:"appsync"`
}

func validateDev(dev *AppDev) error {
	if dev == nil {
		return nil
	}
	switch dev.AppSync {
	case "", "shared", "stage":
		return nil
	}
	return util.NewReadableError(nil, fmt.Sprintf(`The "dev.appsync" property must be "shared" or "stage", not %q.`, dev.AppSync))
}

// Transport is how the stage's stubs in sst dev reach the CLI: AppSync, when
// the app has the aws provider and the stage is in the real cloud, and HTTP on
// this machine on a target's stage, whose functions run in containers here.
// HTTP keeps its port and token in the working folder, so each run gives the
// stubs the same ones.
func (p *Project) Transport() (bridge.Transport, bool) {
	if !target.IsCloud(p.Target()) {
		return transport.NewHTTP(filepath.Join(p.PathWorkingDir(), p.app.Stage+".transport.json")), true
	}
	unknown, ok := p.Provider("aws")
	if !ok {
		return nil, false
	}
	aws, ok := unknown.(*provider.AwsProvider)
	if !ok {
		return nil, false
	}
	return transport.NewAppSync(aws, p.AppSyncScope(), p.app.Name, p.app.Stage), true
}

// NoTransport says why the stage has no transport for sst dev's functions.
func (p *Project) NoTransport() error {
	return util.NewReadableError(nil, "sst dev needs the aws provider to reach its functions")
}

// AppSyncScope is which Event API sst dev and its stubs use: the shared one, or
// the stage's own when "dev.appsync" is "stage".
func (p *Project) AppSyncScope() provider.AppSyncScope {
	if p.app.Dev != nil && p.app.Dev.AppSync == "stage" {
		return provider.AppSyncScope{App: p.app.Name, Stage: p.app.Stage}
	}
	return provider.AppSyncScope{}
}

type Watch struct {
	Paths       []string `json:"paths"`
	Ignore      []string `json:"ignore"`
	legacyArray bool
}

func (w Watch) UsesLegacyArray() bool {
	return w.legacyArray
}

func (w *Watch) UnmarshalJSON(data []byte) error {
	var paths []string
	if err := json.Unmarshal(data, &paths); err == nil {
		w.Paths = paths
		w.Ignore = nil
		w.legacyArray = true
		return nil
	}

	type value struct {
		Paths  []string `json:"paths"`
		Ignore []string `json:"ignore"`
	}

	var decoded value
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}

	for _, path := range decoded.Paths {
		if strings.ContainsAny(path, "*?[") {
			return util.NewReadableError(nil, fmt.Sprintf("Watch path globs are only supported in the legacy array form: %q\nUse explicit directories or ignore patterns instead: https://sst-community.github.io/sst/docs/reference/config/#watch", path))
		}
	}

	w.Paths = decoded.Paths
	w.Ignore = decoded.Ignore
	w.legacyArray = false
	return nil
}

type Project struct {
	version         string
	lock            ProviderLock
	root            string
	config          string
	app             *App
	home            provider.Home
	target          target.Target
	env             map[string]string
	loadedProviders map[string]provider.Provider
	nodeVersion     string
	Runtime         *runtime.Collection
	// The stage's lock this CLI holds, and what the run under it left the
	// stage as, which its unlock keeps in the lock SST 4 reads
	locked     *provider.Update
	stageAfter provider.StageAfter
	// What the platform says it is, and the contract its components speak,
	// from the platform this CLI has (New)
	manifest *js.PlatformManifest
	contract Contract
}

func Discover() (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	cfgPath, err := fs.FindUp(cwd, "sst.config.ts")
	if err != nil {
		return "", err
	}
	err = os.MkdirAll(ResolveWorkingDir(cfgPath), 0755)
	if err != nil {
		return "", err
	}
	return cfgPath, nil
}

func ResolveWorkingDir(cfgPath string) string {
	return filepath.Join(filepath.Dir(cfgPath), ".sst")
}

func ResolvePlatformDir(cfgPath string) string {
	return filepath.Join(ResolveWorkingDir(cfgPath), "platform")
}

func ResolveLogDir(cfgPath string) string {
	return filepath.Join(ResolveWorkingDir(cfgPath), "log")
}

type ProjectConfig struct {
	Version string
	Stage   string
	Config  string
}

var ErrInvalidStageName = fmt.Errorf("ErrInvalidStageName")
var ErrInvalidAppName = fmt.Errorf("ErrInvalidAppName")
var ErrAppNameChanged = fmt.Errorf("ErrAppNameChanged")
var ErrV2Config = fmt.Errorf("ErrV2Config")
var ErrVersionInvalid = fmt.Errorf("ErrVersionInvalid")

type ErrVersionMismatch struct {
	Needed   string
	Received string
}

func (err *ErrVersionMismatch) Error() string {
	return "ErrorVersionMismatch"
}

// Whether the app's `version` rule allows the CLI's version. A pre-release is
// also checked as the release it leads to, since semver ranges leave
// pre-releases out: 5.0.0-alpha.1 meets ">= 4" and "5.x", and not "4.x".
func versionAllowed(rule string, cli string) (bool, error) {
	constraint, err := semver.NewConstraint(rule)
	if err != nil {
		return false, ErrVersionInvalid
	}
	version, err := semver.NewVersion(cli)
	if err != nil {
		return false, ErrVersionInvalid
	}
	if constraint.Check(version) {
		return true, nil
	}
	if version.Prerelease() == "" {
		return false, nil
	}
	release, err := version.SetPrerelease("")
	if err != nil {
		return false, ErrVersionInvalid
	}
	return constraint.Check(&release), nil
}

type ErrBuildFailed struct {
	msg    string
	Errors []api.Message
}

func (err *ErrBuildFailed) Error() string {
	return err.msg
}

var InvalidStageRegex = regexp.MustCompile(`[^a-zA-Z0-9-]`)
var InvalidAppRegex = regexp.MustCompile(`^[^a-zA-Z]|[^a-zA-Z0-9-]`)

func New(input *ProjectConfig) (*Project, error) {
	if InvalidStageRegex.MatchString(input.Stage) {
		return nil, ErrInvalidStageName
	}

	rootPath := filepath.Dir(input.Config)
	tmp := filepath.Join(rootPath, ".sst")

	manifest, err := EmbeddedManifest()
	if err != nil {
		return nil, err
	}
	contract, err := ContractFor(manifest)
	if err != nil {
		return nil, err
	}

	proj := &Project{
		version:  input.Version,
		root:     rootPath,
		config:   input.Config,
		env:      map[string]string{},
		target:   target.Cloud{},
		manifest: manifest,
		contract: contract,
	}

	proj.Runtime = NewRuntimes(input.Config, input.Version)

	_, err = os.Stat(tmp)
	if err != nil {
		if !os.IsNotExist(err) {
			return nil, err
		}
		err := os.Mkdir(tmp, 0755)
		if err != nil {
			return nil, err
		}
	}

	inputBytes, err := json.Marshal(map[string]string{
		"stage": input.Stage,
	})
	buildResult, err := js.Build(
		js.EvalOptions{
			Dir:    proj.PathRoot(),
			Banner: `function $config(input) { return input }`,
			Define: map[string]string{
				"$input": string(inputBytes),
			},
			// Its imports of the platform's modules are left out
			Platform: proj.platformModules(),
			Code: fmt.Sprintf(`
import mod from '%s';
console.log("~n" + process.versions.node)
if (mod.stacks || mod.config) {
  console.log("~v2")
  process.exit(0)
}
console.log("~j" + JSON.stringify(await mod.app({
  stage: $input.stage || undefined,
})))`,
				filepath.ToSlash(input.Config)),
		},
	)
	if err != nil {
		if buildResult.Errors != nil {
			return nil, &ErrBuildFailed{msg: err.Error(), Errors: buildResult.Errors}
		}
		return nil, err
	}
	defer js.Cleanup(buildResult)

	slog.Info("evaluating config")
	node := process.Command("node", "--no-warnings", string(buildResult.OutputFiles[1].Path))
	output, err := node.CombinedOutput()
	slog.Info("config evaluated")
	if err != nil {
		return nil, fmt.Errorf("Error evaluating config: %w\n%s", err, output)
	}
	scanner := bufio.NewScanner(bytes.NewReader(output))
	for scanner.Scan() {
		line := scanner.Text()
		if line == "~v2" {
			return nil, ErrV2Config
		}
		if strings.HasPrefix(line, "~n") {
			proj.nodeVersion = line[2:]
			continue
		}
		if strings.HasPrefix(line, "~j") {
			var parsed App
			err = json.Unmarshal([]byte(line[2:]), &parsed)
			if err != nil {
				return nil, err
			}
			proj.app = &parsed
			proj.app.Stage = input.Stage

			if proj.app.Providers == nil {
				proj.app.Providers = map[string]interface{}{}
			}

			for name, args := range proj.app.Providers {
				if _, ok := args.(bool); ok {
					return nil, util.NewReadableError(nil,
						fmt.Sprintf(`Setting providers.%s to true is deprecated. Specify the version explicitly instead.`, name),
					)
				}

				if argsString, ok := args.(string); ok {
					proj.app.Providers[name] = map[string]interface{}{
						"version": argsString,
					}
				}

				if argsMap, ok := args.(map[string]interface{}); ok {
					if _, hasVersion := argsMap["version"]; !hasVersion && name != "aws" && name != "cloudflare" {
						return nil, util.NewReadableError(nil,
							fmt.Sprintf(`Provider %s is missing a version. Specify the version explicitly instead.`, name),
						)
					}
				}
			}

			if proj.app.Name == "" {
				return nil, fmt.Errorf("Project name is required")
			}

			if InvalidAppRegex.MatchString(proj.app.Name) {
				return nil, ErrInvalidAppName
			}

			// Check if app name has changed by comparing the folder name inside ".pulumi/stacks"
			// and the app name in the config file.
			stacksDir := filepath.Join(proj.PathWorkingDir(), ".pulumi", "stacks")
			files, err := os.ReadDir(stacksDir)
			if err != nil {
				if !os.IsNotExist(err) {
					return nil, err
				}
				files = []os.DirEntry{}
			}
			if len(files) > 0 {
				appName := files[0].Name()
				if appName != proj.app.Name {
					return nil, ErrAppNameChanged
				}
			}

			if proj.app.Home == "" {
				return nil, util.NewReadableError(nil, `You must specify a "home" provider in the project configuration file.`)
			}

			// The stage's target is in the config, so a command on the stage
			// can't reach the real cloud by leaving out a flag. Its home is the
			// target's, so the home's provider isn't added.
			local, err := proj.stageTarget(input.Stage)
			if err != nil {
				return nil, err
			}
			if local != nil {
				proj.target = local
			} else if _, ok := proj.app.Providers[proj.app.Home]; !ok && proj.app.Home != "local" {
				proj.app.Providers[proj.app.Home] = map[string]interface{}{}
			}

			if proj.app.RemovalPolicy != "" {
				return nil, util.NewReadableError(nil, `The "removalPolicy" has been renamed to "removal"`)
			}

			if proj.app.Removal == "" {
				proj.app.Removal = "retain"
			}

			if err := validateState(proj.app.State); err != nil {
				return nil, err
			}

			if err := validateDev(proj.app.Dev); err != nil {
				return nil, err
			}

			if err := proj.checkConfigPackages(); err != nil {
				return nil, err
			}

			if proj.app.Version != "" && input.Version != "dev" {
				allowed, err := versionAllowed(proj.app.Version, input.Version)
				if err != nil {
					return nil, err
				}
				if !allowed {
					return nil, &ErrVersionMismatch{Needed: input.Version, Received: proj.app.Version}
				}
			}

			if proj.app.Removal != "remove" && proj.app.Removal != "retain" && proj.app.Removal != "retain-all" {
				return nil, fmt.Errorf("Removal must be one of: remove, retain, retain-all")
			}
			continue
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}

	err = proj.loadProviderLock()
	if err != nil {
		return nil, err
	}

	return proj, nil
}

// NewRuntimes are the runtimes that build a program's functions and run them
// in sst dev
func NewRuntimes(cfgPath, version string) *runtime.Collection {
	return runtime.NewCollection(
		cfgPath,
		node.New(version),
		worker.New(),
		python.New(),
		golang.New(),
		rust.New(),
	)
}

func (proj *Project) LoadHome() error {
	slog.Info("loading home", "target", proj.target.Name())
	ctx := context.Background()
	if err := proj.target.Start(ctx); err != nil {
		return util.NewReadableError(err, err.Error())
	}
	loadedProviders, err := proj.target.Providers(ctx, proj.app.Name, proj.app.Stage, proj.app.Providers)
	if err != nil {
		return err
	}
	for _, loaded := range loadedProviders {
		env, err := loaded.Env()
		if err != nil {
			return err
		}
		for key, value := range env {
			proj.env[key] = value
		}
	}
	// What the CLI starts on the stage gets the target's credentials, and
	// none of the developer's
	if local, ok := proj.target.(*target.Local); ok {
		local.Apply()
	}

	compress := proj.app.State != nil && proj.app.State.Compress
	home, err := proj.target.Home(proj.app.Home, loadedProviders, compress)
	if err != nil {
		return err
	}
	err = home.Bootstrap()
	if err != nil {
		return fmt.Errorf("Error initializing %s:\n   %w", proj.app.Home, err)
	}
	proj.home = home
	proj.loadedProviders = loadedProviders
	return nil
}

// Target is where the stage's cloud calls go: the real cloud, or the target
// the config names for the stage.
func (p *Project) Target() target.Target {
	if p.target == nil {
		return target.Cloud{}
	}
	return p.target
}

// stageTarget is the target the app gives the stage in app(), or nil. A
// contract whose components don't run on one refuses it.
func (p *Project) stageTarget(stage string) (*target.Local, error) {
	settings, ok := p.app.Targets[stage]
	if !ok {
		return nil, nil
	}
	if err := p.speaks().RefuseTarget(stage); err != nil {
		return nil, err
	}
	local, err := target.Parse(settings)
	if err != nil {
		return nil, util.NewReadableError(err, fmt.Sprintf("The target for the %q stage: %v", stage, err))
	}
	if err := target.CheckProviders(local, p.app.Providers); err != nil {
		return nil, util.NewReadableError(err, err.Error())
	}
	return local, nil
}

func (p Project) getPath(path ...string) string {
	paths := append([]string{p.PathWorkingDir()}, path...)
	return filepath.Join(paths...)
}

func (p Project) PathWorkingDir() string {
	return filepath.Join(p.root, ".sst")
}

func (p Project) PathPlatformDir() string {
	return filepath.Join(p.PathWorkingDir(), "platform")
}

func (p Project) PathRoot() string {
	return p.root
}

func (p Project) PathConfig() string {
	return p.config
}

func (p Project) Version() string {
	return p.version
}

func (p Project) App() *App {
	return p.app
}

// NodeVersion is the version of the Node.js that evaluated the config.
func (p Project) NodeVersion() string {
	return p.nodeVersion
}

func (p Project) Backend() provider.Home {
	return p.home
}

func (p Project) Env() map[string]string {
	return p.env
}

func (p *Project) Provider(name string) (provider.Provider, bool) {
	result, ok := p.loadedProviders[name]
	return result, ok
}

func (p *Project) Cleanup() error {
	if flag.SST_NO_CLEANUP {
		return nil
	}
	return nil
}

func (p *Project) PathLog(name string) string {
	if name == "" {
		return filepath.Join(p.PathWorkingDir(), "log")
	}
	return filepath.Join(p.PathWorkingDir(), "log", name+".log")
}
