// Package pulumidev runs a plain Pulumi program in sst dev
// (docs/plans/pulumi-dev/plan.md). Its Pulumi.yaml is the config and its
// stack the stage. sst dev deploys it with the developer's own pulumi, and
// does everything after the deploy as for an SST app, through
// project.Program.
//
// Nothing here touches SST's state: no home, no passphrase, no lock, no
// bootstrap and no move. What sst dev knows of the stack comes from pulumi,
// in the stack's own backend, so it can ship on its own.
package pulumidev

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/bridge"
	"github.com/sst/sst/v3/internal/fs"
	"github.com/sst/sst/v3/internal/pulumicli"
	"github.com/sst/sst/v3/internal/util"
	"github.com/sst/sst/v3/pkg/process"
	"github.com/sst/sst/v3/pkg/project"
	"github.com/sst/sst/v3/pkg/project/provider"
	"github.com/sst/sst/v3/pkg/runtime"
	"github.com/sst/sst/v3/pkg/target"
	"github.com/sst/sst/v3/pkg/transport"
)

// Program is a plain Pulumi program on one of its stacks, which sst dev runs.
type Program struct {
	name   string
	stage  string
	root   string
	config string
	// the CLI's version
	version     string
	nodeVersion string
	runtimes    *runtime.Collection
	// the pulumi CLI
	cli string
	// the stack, as pulumi names it: fully qualified when it's the one
	// selected, so a stack in an organization other than the default is found
	stack string
	// the file the program starts from: a change to it, or to a file it
	// imports, deploys it again. Empty when it can't be found.
	entry string
	// how the stack's config sets up the program's AWS provider, which the
	// CLI's is set up as
	aws stackAws
	// the CLI's AWS provider, which Load sets up
	awsProvider *provider.AwsProvider

	mu sync.Mutex
	// what DevFile says, read as the program starts and on each deploy
	dev *devFile
	// the functions that run on this machine in the deploy running now, by id,
	// and the name of the first to have each id
	live      map[string]project.FunctionReport
	liveNames map[string]string
	// the functions and roles sst/pulumi's transform asked about in the
	// deploy running now, by name
	asked      map[string]bool
	askedRoles map[string]bool
	// the functions a pattern in DevFile matched that run in the cloud, by
	// name, with why
	cloud map[string]string
	// the functions that run on this machine, by name, with their handlers
	here map[string]string
}

var _ project.Program = (*Program)(nil)

// DevKey is the stack config key that lets sst dev deploy a stack: it swaps
// the stack's functions for stubs, so a stack has to ask for it.
const DevKey = "sst:dev"

// ErrCommand is any command but sst dev in a Pulumi project
var ErrCommand = util.NewReadableError(nil, "This is a Pulumi project: sst dev runs it, and pulumi does everything else.")

// IsProgram is whether a config path is a Pulumi project's Pulumi.yaml.
func IsProgram(cfgPath string) bool {
	base := filepath.Base(cfgPath)
	return base == "Pulumi.yaml" || base == "Pulumi.yml"
}

// Discover finds the Pulumi.yaml of the project the current folder is in, the
// nearest one up from it.
func Discover() (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	found := ""
	for _, name := range []string{"Pulumi.yaml", "Pulumi.yml"} {
		match, err := fs.FindUp(cwd, name)
		if err == nil && len(match) > len(found) {
			found = match
		}
	}
	if found == "" {
		return "", errors.New("no Pulumi.yaml")
	}
	return found, nil
}

// pulumiCLI is the developer's pulumi, which runs the program as they would
func pulumiCLI() (string, error) {
	return pulumicli.Find("sst dev deploys a Pulumi project with the Pulumi CLI")
}

// SelectedStack is the stack sst dev runs in a Pulumi project when none is
// named: the one selected in the project, by its fully qualified name.
func SelectedStack(cfgPath string) (string, error) {
	cli, err := pulumiCLI()
	if err != nil {
		return "", err
	}
	out, err := pulumicli.Run(cli, filepath.Dir(cfgPath), nil, "stack", "--show-name", "--fully-qualify-stack-names")
	stack := strings.TrimSpace(string(out))
	// pulumi can't say for another reason, like a backend it can't reach
	if err != nil && !strings.Contains(strings.ToLower(err.Error()), "no stack") {
		return "", util.NewReadableError(err, fmt.Sprintf("Could not read which Pulumi stack is selected: %v", err))
	}
	if err != nil || stack == "" {
		return "", util.NewReadableError(err, "No Pulumi stack is selected. Name one with --stage, or select one with `pulumi stack select`.")
	}
	return stack, nil
}

// StageOf is the stage of a Pulumi stack: its name without its organization
// and project. The CLI, the stubs and the dev commands' panes know the stack
// by it.
func StageOf(stack string) string {
	return stack[strings.LastIndex(stack, "/")+1:]
}

// configValue is one of a stack's config values, as `pulumi config --json`
// prints it. A secret has no value, as it isn't asked for. A structured value
// is in objectValue too.
type configValue struct {
	Value       *string         `json:"value"`
	ObjectValue json.RawMessage `json:"objectValue"`
	Secret      bool            `json:"secret"`
}

func (c configValue) String() string {
	if c.Value == nil {
		return ""
	}
	return *c.Value
}

// stackAws is what of the stack's config sets up the program's AWS provider,
// which sst dev reads to set up its own the same way: the program and the
// CLI then reach the same account. A profile in the config wins over
// AWS_PROFILE, as it does for the program's provider.
type stackAws struct {
	profile string
	region  string
	roles   []provider.AwsRole
}

// readStackAws reads aws:profile, aws:region and the roles to take, from
// aws:assumeRoles or the older aws:assumeRole
func readStackAws(config map[string]configValue) (stackAws, error) {
	// pulumi config --json gives a secret no value, and an object with a
	// secret in it, like a role's external ID, is all secret: read without
	// it, the CLI would reach another account than the program's
	for _, key := range []string{"aws:profile", "aws:region", "aws:assumeRoles", "aws:assumeRole"} {
		if value, ok := config[key]; ok && value.Secret && value.Value == nil && len(value.ObjectValue) == 0 {
			return stackAws{}, fmt.Errorf("sst dev sets up its AWS access as the stack's config sets up the program's, and the stack's %s is a secret, which it doesn't read. A role with an external ID isn't supported yet", key)
		}
	}
	result := stackAws{
		profile: config["aws:profile"].String(),
		region:  config["aws:region"].String(),
	}
	type role struct {
		RoleArn     string `json:"roleArn"`
		SessionName string `json:"sessionName"`
		ExternalID  string `json:"externalId"`
	}
	var roles []role
	if value := config["aws:assumeRoles"].ObjectValue; len(value) > 0 {
		if err := json.Unmarshal(value, &roles); err != nil {
			return result, fmt.Errorf("aws:assumeRoles: %w", err)
		}
	} else if value := config["aws:assumeRole"].ObjectValue; len(value) > 0 {
		var one role
		if err := json.Unmarshal(value, &one); err != nil {
			return result, fmt.Errorf("aws:assumeRole: %w", err)
		}
		roles = []role{one}
	}
	for _, r := range roles {
		if r.ExternalID != "" {
			return result, fmt.Errorf("sst dev can't take a role with an external ID yet, as the stack's aws:assumeRoles asks for %s", r.RoleArn)
		}
		if r.RoleArn != "" {
			result.roles = append(result.roles, provider.AwsRole{RoleArn: r.RoleArn, SessionName: r.SessionName})
		}
	}
	return result, nil
}

// New reads a Pulumi project for sst dev: its Pulumi.yaml, and the stack's
// config, which has to opt in. The stack is the one named, or the one
// selected when it's empty.
func New(cfgPath, stack, version string) (*Program, error) {
	parsed, err := pulumicli.ReadProject(cfgPath)
	if err != nil {
		return nil, util.NewReadableError(err, "Could not read "+cfgPath+": "+err.Error())
	}
	if parsed.Name == "" {
		return nil, util.NewReadableError(nil, cfgPath+" has no name.")
	}
	if runtime := parsed.Runtime; runtime != "nodejs" {
		return nil, util.NewReadableError(nil, fmt.Sprintf("sst dev runs Pulumi programs in TypeScript or JavaScript, and this one's runtime is %q.", runtime))
	}
	// The app and the stage name the channels the stubs and sst dev talk on,
	// so they take the same characters as an SST app's
	if project.InvalidAppRegex.MatchString(parsed.Name) {
		return nil, util.NewReadableError(nil, fmt.Sprintf("sst dev needs the Pulumi project's name to start with a letter and have only letters, numbers and hyphens, and it's %q.", parsed.Name))
	}

	cli, err := pulumiCLI()
	if err != nil {
		return nil, err
	}
	root := filepath.Dir(cfgPath)
	if stack == "" {
		if stack, err = SelectedStack(cfgPath); err != nil {
			return nil, err
		}
	}
	stage := StageOf(stack)
	if stage == "" || project.InvalidStageRegex.MatchString(stage) {
		return nil, util.NewReadableError(nil, fmt.Sprintf("sst dev needs the stack's name to have only letters, numbers and hyphens, and it's %q.", stage))
	}

	out, err := pulumicli.Run(cli, root, nil, "config", "--json", "--stack", stack)
	if err != nil {
		return nil, util.NewReadableError(err, fmt.Sprintf("Could not read the config of the %q stack: %v", stack, err))
	}
	config := map[string]configValue{}
	if err := json.Unmarshal(out, &config); err != nil {
		return nil, err
	}
	if config[DevKey].String() != "true" {
		return nil, util.NewReadableError(nil, fmt.Sprintf("sst dev swaps a stack's functions for stubs, so a stack has to opt in, and %q hasn't. If it's a stack for development, run:\n\n  pulumi config set %s true --stack %s", stack, DevKey, stack))
	}

	// The CLI's own AWS provider, for the stubs' transport and the dev
	// commands' roles, is set up as the program's is
	aws, err := readStackAws(config)
	if err != nil {
		return nil, util.NewReadableError(err, err.Error())
	}

	entry := programEntry(root, parsed.Main)
	dev, err := readDevFileFor(root, scanProgram(root, entry).components)
	if err != nil {
		return nil, err
	}

	p := &Program{
		name:       parsed.Name,
		stage:      stage,
		root:       root,
		config:     cfgPath,
		version:    version,
		runtimes:   project.NewRuntimes(cfgPath, version),
		cli:        cli,
		stack:      stack,
		entry:      entry,
		aws:        aws,
		dev:        dev,
		live:       map[string]project.FunctionReport{},
		asked:      map[string]bool{},
		askedRoles: map[string]bool{},
		cloud:      map[string]string{},
		here:       map[string]string{},
	}
	if version, err := process.Command("node", "--version").Output(); err == nil {
		p.nodeVersion = strings.TrimPrefix(strings.TrimSpace(string(version)), "v")
	}
	if err := os.MkdirAll(p.pathWorkingDir(), 0755); err != nil {
		return nil, err
	}
	return p, nil
}

// programEntry is the file a Node.js Pulumi program starts from, found as
// Pulumi's Node.js host finds it: `main` in Pulumi.yaml, then the package.json
// `main` of that folder, then its index file. It's empty when there's none.
func programEntry(root, main string) string {
	dir := root
	if main != "" {
		dir = filepath.Join(root, main)
	}
	if info, err := os.Stat(dir); err == nil && !info.IsDir() {
		return dir
	}
	if data, err := os.ReadFile(filepath.Join(dir, "package.json")); err == nil {
		var pkg struct {
			Main string `json:"main"`
		}
		if json.Unmarshal(data, &pkg) == nil && pkg.Main != "" {
			if entry := filepath.Join(dir, pkg.Main); isFile(entry) {
				return entry
			}
		}
	}
	for _, name := range []string{"index.ts", "index.mts", "index.cts", "index.js", "index.mjs", "index.cjs"} {
		if entry := filepath.Join(dir, name); isFile(entry) {
			return entry
		}
	}
	return ""
}

func isFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

// Load sets up the CLI's AWS provider as the stack's config sets up the
// program's: its profile, region and roles, then the environment. There's no
// home and nothing of SST's is bootstrapped: the state is the stack's, in its
// own backend.
func (p *Program) Load() error {
	aws := provider.NewAwsProvider()
	if err := aws.LoadFrom(p.aws.profile, p.aws.region, p.aws.roles); err != nil {
		return util.NewReadableError(err, "aws: "+err.Error())
	}
	p.awsProvider = aws
	return nil
}

func (p *Program) Name() string {
	return p.name
}

func (p *Program) Stage() string {
	return p.stage
}

// Home is none of SST's: the state is the stack's
func (p *Program) Home() string {
	return ""
}

// Providers is the one whose dev loop sst dev runs: aws
func (p *Program) Providers() map[string]interface{} {
	settings := map[string]interface{}{}
	if p.aws.region != "" {
		settings["region"] = p.aws.region
	}
	return map[string]interface{}{"aws": settings}
}

func (p *Program) Provider(name string) (provider.Provider, bool) {
	if name != "aws" || p.awsProvider == nil {
		return nil, false
	}
	return p.awsProvider, true
}

// Target is the real cloud: a stack's config sets up where its providers go
func (p *Program) Target() target.Target {
	return target.Cloud{}
}

// Transport is the shared AppSync Event API in the account and region
func (p *Program) Transport() (bridge.Transport, bool) {
	if p.awsProvider == nil {
		return nil, false
	}
	return transport.NewAppSync(p.awsProvider, provider.AppSyncScope{}, p.name, p.stage), true
}

func (p *Program) NoTransport() error {
	return util.NewReadableError(nil, "sst dev needs the aws provider to reach its functions")
}

func (p *Program) Runtimes() *runtime.Collection {
	return p.runtimes
}

// NodeVersion is the version of the Node.js on the PATH, which runs the
// functions' local code
func (p *Program) NodeVersion() string {
	return p.nodeVersion
}

func (p *Program) PathRoot() string {
	return p.root
}

func (p *Program) PathConfig() string {
	return p.config
}

func (p *Program) pathWorkingDir() string {
	return filepath.Join(p.root, ".sst")
}

func (p *Program) PathPlatformDir() string {
	return filepath.Join(p.pathWorkingDir(), "platform")
}

func (p *Program) PathLog(name string) string {
	if name == "" {
		return filepath.Join(p.pathWorkingDir(), "log")
	}
	return filepath.Join(p.pathWorkingDir(), "log", name+".log")
}

// PathWatch is the program's repository, so a function's source or a
// workspace package the program imports from outside the project's folder is
// watched too. Outside a repository it's the project's folder.
func (p *Program) PathWatch() string {
	for dir := p.root; ; dir = filepath.Dir(dir) {
		if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			return dir
		}
		if filepath.Dir(dir) == dir {
			return p.root
		}
	}
}

// Watch is everything under PathWatch
func (p *Program) Watch() project.Watch {
	return project.Watch{}
}

func (p *Program) ResolvePolicyPackPath(policyPath string) (string, error) {
	return project.ResolvePolicyPack(p.root, policyPath)
}

// AddLive records a function the program asked to run on this machine, by
// its name in the program, for the deploy running now. Two functions can
// share an id only with the same handler: the stubs and sst dev tell
// functions apart by it, so both then run the same code, each with its own
// environment and role. When they can't, other is the function that has it.
func (p *Program) AddLive(name, functionID string, report project.FunctionReport) (other string, ok bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if existing, taken := p.live[functionID]; taken && existing.Handler != report.Handler {
		return p.liveNames[functionID], false
	}
	if p.liveNames == nil {
		p.liveNames = map[string]string{}
	}
	if _, taken := p.liveNames[functionID]; !taken {
		p.liveNames[functionID] = name
	}
	p.live[functionID] = report
	return "", true
}

// How many times sst dev tries to take a dev command's role, and how long it
// waits between: the same deploy can make the role's trust, which IAM takes a
// few seconds to honor
const roleAttempts = 10
const roleWait = 3 * time.Second

// EnvFor is a dev command's environment. A dev command with a role runs as it
// or not at all, rather than with the developer's own credentials.
func (p *Program) EnvFor(ctx context.Context, complete *project.CompleteEvent, name string) (map[string]string, error) {
	dev := complete.Devs[name]
	env := map[string]string{}
	if dev.Aws != nil && dev.Aws.Role != "" {
		credentials, err := p.assumeRole(ctx, dev.Aws.Role)
		if err != nil {
			return nil, fmt.Errorf("The %q dev command runs as %s, which sst dev couldn't take: %w. A role of the program named in %s's role is let your account take it in sst dev; a role given by its ARN has to let your account take it already.", name, dev.Aws.Role, err, DevFile)
		}
		for key, value := range credentials {
			env[key] = value
		}
	}
	project.AddDevEnv(env, complete, name, p.name, p.stage)
	return env, nil
}

func (p *Program) assumeRole(ctx context.Context, role string) (map[string]string, error) {
	if p.awsProvider == nil {
		return nil, errors.New("the aws provider isn't loaded")
	}
	for attempt := 1; ; attempt++ {
		credentials, err := project.AssumeDevRole(ctx, p.awsProvider, role)
		if err == nil || attempt >= roleAttempts {
			return credentials, err
		}
		select {
		case <-ctx.Done():
			return nil, err
		case <-time.After(roleWait):
		}
	}
}
