package pulumidev

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	esbuild "github.com/evanw/esbuild/pkg/api"
	"github.com/pulumi/pulumi/sdk/v3/go/auto/events"
	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource/sig"
	"github.com/sst/sst/v3/internal/util"
	"github.com/sst/sst/v3/pkg/bus"
	"github.com/sst/sst/v3/pkg/id"
	"github.com/sst/sst/v3/pkg/process"
	"github.com/sst/sst/v3/pkg/project"
	"github.com/sst/sst/v3/pkg/project/common"
)

// Run deploys the program to its stack for sst dev, with pulumi up, tells the
// program it's in dev and where sst dev is, and reads what it left from the
// stack's state.
func (p *Program) Run(ctx context.Context, input *project.StackInput) error {
	if input.Command != "deploy" || !input.Dev {
		return ErrCommand
	}
	log := slog.Default().With("service", "pulumidev")
	bus.Publish(&project.StackCommandEvent{
		App:     p.name,
		Stage:   p.stage,
		Config:  p.config,
		Command: input.Command,
		Version: p.version,
	})
	// What the program is made of, and DevFile, deploy it again when they
	// change
	files := append(p.programFiles(), p.linked(filepath.Join(p.root, DevFile))...)
	bus.Publish(&project.BuildSuccessEvent{Files: files})
	dev, err := readDevFile(p.root)
	if err != nil {
		bus.Publish(&project.BuildFailedEvent{Error: err.Error()})
		return project.ErrStackRunFailed
	}
	p.mu.Lock()
	p.dev = dev
	p.live = map[string]project.FunctionReport{}
	p.liveNames = map[string]string{}
	p.asked = map[string]bool{}
	p.askedRoles = map[string]bool{}
	p.cloud = map[string]string{}
	p.here = map[string]string{}
	p.mu.Unlock()

	// one for each stack, as sst dev can run on two stacks of a project at once
	eventlogPath := filepath.Join(p.pathWorkingDir(), "pulumi."+url.PathEscape(p.stack)+".events.json")
	eventlog, err := os.OpenFile(eventlogPath, os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0644)
	if err != nil {
		return err
	}
	defer eventlog.Close()
	if err := os.MkdirAll(p.PathLog(""), 0755); err != nil {
		return err
	}
	stdout, err := os.Create(p.PathLog("pulumi"))
	if err != nil {
		return err
	}
	defer stdout.Close()
	stderr, err := os.Create(p.PathLog("pulumi.err"))
	if err != nil {
		return err
	}
	defer stderr.Close()

	args := []string{"up", "--yes", "--skip-preview", "--non-interactive", "--stack", p.stack, "--event-log", eventlogPath}
	if input.PolicyPath != "" {
		policyPath, err := p.ResolvePolicyPackPath(input.PolicyPath)
		if err != nil {
			return util.NewReadableError(nil, err.Error())
		}
		args = append(args, "--policy-pack", policyPath)
	}
	cmd := process.Command(p.cli, args...)
	process.Detach(cmd)
	cmd.Dir = p.root
	cmd.Env = append(os.Environ(),
		"SST_DEV=true",
		"SST_SERVER="+input.Server,
		"PULUMI_SKIP_UPDATE_CHECK=true",
		// what makes --event-log a flag pulumi takes
		"PULUMI_DEBUG_COMMANDS=true",
	)
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	log.Info("starting pulumi", "args", cmd.Args)
	if err := cmd.Start(); err != nil {
		return err
	}
	exited := make(chan struct{})
	go func() {
		err := cmd.Wait()
		log.Info("pulumi exited", "err", err)
		close(exited)
	}()
	go func() {
		select {
		case <-exited:
		case <-ctx.Done():
			log.Info("sending interrupt")
			cmd.Process.Signal(syscall.SIGINT)
			bus.Publish(&project.CancelledEvent{})
		}
	}()

	found := newDeployErrors()
	finished := false
	tailEvents(eventlog, exited, func(event *events.EngineEvent) {
		found.add(event)
		project.PublishEngineEvent(*event)
		if event.SummaryEvent != nil {
			finished = true
		}
	})
	// pulumi stopped before it ran the program, as for a backend it can't
	// reach: what it said is the error
	if !finished && len(found.errors) == 0 {
		if data, err := os.ReadFile(stderr.Name()); err == nil {
			if message := strings.TrimPrefix(firstLine(string(data)), "error: "); message != "" {
				found.errors = append(found.errors, project.Error{Message: message})
			}
		}
	}

	complete, err := p.GetCompleted(ctx)
	if err != nil {
		return err
	}
	complete.UpdateID = id.Descending()
	complete.Finished = finished
	p.mu.Lock()
	for functionID, report := range p.live {
		complete.Functions[functionID] = report
	}
	if hint := listFunctions(p.here); hint != "" {
		complete.Hints[hereHint] = hint
	}
	if hint := listFunctions(p.cloud); hint != "" {
		complete.Hints[cloudHint] = hint
	}
	// What DevFile names that the program never made, or made before the
	// transform was registered, can't run, which a deploy that went through
	// would otherwise hide
	if finished && len(found.errors) == 0 {
		found.errors = append(found.errors, unasked(dev, complete.Devs, p.asked, p.askedRoles)...)
	}
	p.mu.Unlock()
	complete.Errors = append(found.errors, complete.Errors...)
	bus.Publish(complete)

	if cmd.ProcessState.ExitCode() != 0 {
		return project.ErrStackRunFailed
	}
	return nil
}

// tailEvents reads Pulumi's event log as Pulumi writes it, and gives handle
// each event, until Pulumi has exited and the log is read to its end
func tailEvents(file *os.File, exited <-chan struct{}, handle func(*events.EngineEvent)) {
	reader := bufio.NewReader(file)
	// the start of a line Pulumi hasn't finished writing
	var pending []byte
	done := false
	for {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			pending = append(pending, line...)
			if done {
				return
			}
			select {
			case <-exited:
				// once more to the end, for what it wrote before it exited
				done = true
			case <-time.After(100 * time.Millisecond):
			}
			continue
		}
		if len(pending) > 0 {
			line = append(pending, line...)
			pending = nil
		}
		var event events.EngineEvent
		if err := json.Unmarshal(line, &event); err != nil {
			slog.Error("failed to read a pulumi event", "err", err)
			continue
		}
		handle(&event)
	}
}

// deployErrors are the errors of a deploy, from its events: one for each
// resource, and none for Pulumi's summaries of them
type deployErrors struct {
	errors []project.Error
	urns   map[string]bool
}

func newDeployErrors() *deployErrors {
	return &deployErrors{errors: []project.Error{}, urns: map[string]bool{}}
}

func (e *deployErrors) add(event *events.EngineEvent) {
	if policy := event.PolicyEvent; policy != nil && policy.EnforcementLevel == "mandatory" {
		e.errors = append(e.errors, project.Error{
			Message: fmt.Sprintf("Policy: %s\n%s", policy.PolicyName, strings.TrimSpace(policy.Message)),
			URN:     policy.ResourceURN,
		})
		return
	}
	diagnostic := event.DiagnosticEvent
	if diagnostic == nil || diagnostic.Severity != "error" {
		return
	}
	message := strings.TrimSpace(diagnostic.Message)
	if strings.HasPrefix(message, "update failed") || strings.HasPrefix(message, "update cancelled") || strings.Contains(message, "failed to register new resource") {
		return
	}
	if diagnostic.URN != "" {
		if e.urns[diagnostic.URN] {
			return
		}
		e.urns[diagnostic.URN] = true
	}
	e.errors = append(e.errors, project.Error{Message: message, URN: diagnostic.URN})
}

// unasked are the errors for what DevFile names that sst/pulumi's transform
// never asked about in a deploy that went through
func unasked(dev *devFile, devs project.Devs, asked, askedRoles map[string]bool) []project.Error {
	problems := []project.Error{}
	// a pattern can match no function, as when the program has none yet
	for _, name := range sortedKeys(dev.Functions.byName) {
		if asked[name] {
			continue
		}
		// a name like one the program made is likely misspelt, or changed in
		// the program
		if suggestion := didYouMean(name, sortedKeys(asked)); suggestion != "" {
			problems = append(problems, project.Error{Message: fmt.Sprintf("%s names the %q function, which the program didn't make: %s", DevFile, name, suggestion)})
			continue
		}
		problems = append(problems, project.Error{Message: fmt.Sprintf("%s names the %q function, which the program didn't make, or made before it imported sst/pulumi: import it first. %s", DevFile, name, functionsMade(asked))})
	}
	for _, name := range sortedKeys(dev.Commands) {
		role := dev.Commands[name].roleName()
		// a command left out already says why
		if _, ok := devs[name]; ok && role != "" && !askedRoles[role] {
			problems = append(problems, project.Error{Message: fmt.Sprintf("The %q dev command in %s runs as %q, which the program made before it imported sst/pulumi, so it doesn't let your account take it: import sst/pulumi first.", name, DevFile, role)})
		}
	}
	return problems
}

// hereHint is what the functions that run on this machine are listed as,
// after each deploy, with their handlers, so what a pattern ran is plain to
// see
const hereHint = "On this machine"

// cloudHint is what the functions a pattern matched that run in the cloud are
// listed as, after each deploy, with why
const cloudHint = "In the cloud"

// listFunctions lists functions by name, each with what's said of it, or is ""
// when there are none
func listFunctions(functions map[string]string) string {
	names := sortedKeys(functions)
	listed := make([]string, 0, len(names))
	for _, name := range names {
		if len(listed) == maxListed {
			listed = append(listed, fmt.Sprintf("and %d more", len(names)-maxListed))
			break
		}
		listed = append(listed, fmt.Sprintf("%s (%s)", name, functions[name]))
	}
	return strings.Join(listed, ", ")
}

// maxListed is how many functions a list shows before it counts the rest
const maxListed = 20

// functionsMade says what functions the program made, by the names the file
// takes, so a name that's misspelt or changed in the program is plain to see
func functionsMade(asked map[string]bool) string {
	names := sortedKeys(asked)
	switch {
	case len(names) == 0:
		return "The program made no function."
	case len(names) > maxListed:
		return fmt.Sprintf("The program made %d functions, among them %s.", len(names), strings.Join(names[:maxListed], ", "))
	}
	return "The program made " + strings.Join(names, ", ") + "."
}

// GetCompleted reads what sst dev needs of the stack's state: its outputs,
// which the dev commands' environment takes, and its roles' ARNs, for the
// roles they run as. The state is read with its secrets encrypted; only a
// secret output a dev command's environment names is read in the clear.
func (p *Program) GetCompleted(ctx context.Context) (*project.CompleteEvent, error) {
	out, err := runPulumiCLI(p.cli, p.root, "stack", "export", "--stack", p.stack)
	if err != nil {
		return nil, util.NewReadableError(err, fmt.Sprintf("Could not read the state of the %q stack: %v", p.stack, err))
	}
	p.mu.Lock()
	dev := p.dev
	p.mu.Unlock()
	return completedFromExport(out, dev, p.revealOutput)
}

// revealOutput is a secret output of the stack in the clear, which pulumi
// decrypts with the stack's own secrets provider
func (p *Program) revealOutput(name string) (interface{}, error) {
	out, err := runPulumiCLI(p.cli, p.root, "stack", "output", name, "--json", "--show-secrets", "--stack", p.stack)
	if err != nil {
		return nil, err
	}
	var value interface{}
	if err := json.Unmarshal(out, &value); err != nil {
		return nil, fmt.Errorf("reading the output %q: %w", name, err)
	}
	return value, nil
}

// completedFromExport reads what `pulumi stack export` printed: the stack's
// outputs, with its secrets hidden as pulumi shows them, and the dev commands
// DevFile names, with what they take of the state. reveal reads a secret
// output in the clear, for a dev command's environment.
func completedFromExport(data []byte, dev *devFile, reveal func(name string) (interface{}, error)) (*project.CompleteEvent, error) {
	var untyped apitype.UntypedDeployment
	if err := json.Unmarshal(data, &untyped); err != nil {
		return nil, fmt.Errorf("reading the stack's state: %w", err)
	}
	if untyped.Version > apitype.DeploymentSchemaVersionCurrent {
		return nil, fmt.Errorf("the stack's state is in version %d of Pulumi's format, newer than this CLI reads: upgrade SST", untyped.Version)
	}
	var deployment apitype.DeploymentV3
	if len(untyped.Deployment) > 0 {
		if err := json.Unmarshal(untyped.Deployment, &deployment); err != nil {
			return nil, fmt.Errorf("reading the stack's state: %w", err)
		}
	}
	complete := &project.CompleteEvent{
		Links:       common.Links{},
		ImportDiffs: map[string][]project.ImportDiff{},
		Devs:        project.Devs{},
		Functions:   map[string]project.FunctionReport{},
		Tunnels:     map[string]project.Tunnel{},
		Hints:       map[string]string{},
		Outputs:     map[string]interface{}{},
		Tasks:       map[string]project.Task{},
		Errors:      []project.Error{},
		Resources:   []apitype.ResourceV3{},
	}
	// the outputs as the state has them, with their secrets encrypted
	outputs := map[string]interface{}{}
	roles := map[string][]string{}
	for _, resource := range deployment.Resources {
		switch resource.Type {
		case "pulumi:pulumi:Stack":
			for key, value := range resource.Outputs {
				outputs[key] = value
				if !strings.HasPrefix(key, "_") {
					complete.Outputs[key] = hideSecrets(value)
				}
			}
		case "aws:iam/role:Role":
			if arn, ok := resource.Outputs["arn"].(string); ok {
				name := resource.URN.Name()
				roles[name] = append(roles[name], arn)
			}
		}
	}
	if dev != nil {
		complete.Devs, complete.Errors = dev.devs(outputs, roles, reveal)
	}
	return complete, nil
}

// hiddenSecret is what a secret is shown as, as pulumi shows it
const hiddenSecret = "[secret]"

// isSecret is whether a value `pulumi stack export` printed is a secret: a
// map with Pulumi's secret signature, and its ciphertext
func isSecret(value map[string]interface{}) bool {
	return value[sig.Key] == sig.Secret
}

// hasSecret is whether a value `pulumi stack export` printed is or holds a
// secret
func hasSecret(value interface{}) bool {
	switch cast := value.(type) {
	case map[string]interface{}:
		if isSecret(cast) {
			return true
		}
		for _, item := range cast {
			if hasSecret(item) {
				return true
			}
		}
	case []interface{}:
		for _, item := range cast {
			if hasSecret(item) {
				return true
			}
		}
	}
	return false
}

// hideSecrets is a value `pulumi stack export` printed, with hiddenSecret in
// place of each secret
func hideSecrets(value interface{}) interface{} {
	switch cast := value.(type) {
	case map[string]interface{}:
		if isSecret(cast) {
			return hiddenSecret
		}
		result := map[string]interface{}{}
		for key, item := range cast {
			result[key] = hideSecrets(item)
		}
		return result
	case []interface{}:
		result := make([]interface{}, len(cast))
		for i, item := range cast {
			result[i] = hideSecrets(item)
		}
		return result
	}
	return value
}

// programFiles are the files the program is made of, whose changes deploy it
// again: its entry and what it imports, but for the packages in node_modules.
// A workspace package is followed, as it resolves outside node_modules.
func (p *Program) programFiles() []string {
	if p.entry == "" {
		return nil
	}
	const resolving = "sst:resolving"
	result := esbuild.Build(esbuild.BuildOptions{
		EntryPoints:   []string{p.entry},
		AbsWorkingDir: p.root,
		Outdir:        filepath.Join(p.pathWorkingDir(), "pulumi-program"),
		Bundle:        true,
		Write:         false,
		Metafile:      true,
		Platform:      esbuild.PlatformNode,
		Format:        esbuild.FormatESModule,
		LogLevel:      esbuild.LogLevelSilent,
		Plugins: []esbuild.Plugin{{
			Name: "packages",
			Setup: func(build esbuild.PluginBuild) {
				build.OnResolve(esbuild.OnResolveOptions{Filter: `^[^./]`}, func(args esbuild.OnResolveArgs) (esbuild.OnResolveResult, error) {
					if args.PluginData == resolving {
						return esbuild.OnResolveResult{}, nil
					}
					resolved := build.Resolve(args.Path, esbuild.ResolveOptions{
						Importer:   args.Importer,
						ResolveDir: args.ResolveDir,
						Kind:       args.Kind,
						PluginData: resolving,
					})
					separator := string(filepath.Separator)
					if len(resolved.Errors) > 0 || resolved.External || resolved.Path == "" || strings.Contains(resolved.Path, separator+"node_modules"+separator) {
						return esbuild.OnResolveResult{Path: args.Path, External: true}, nil
					}
					return esbuild.OnResolveResult{Path: resolved.Path}, nil
				})
			},
		}},
	})
	if len(result.Errors) > 0 {
		slog.Warn("could not read the program's files, so a change to them won't deploy it again", "error", result.Errors[0].Text)
		return nil
	}
	var meta struct {
		Inputs map[string]interface{} `json:"inputs"`
	}
	if err := json.Unmarshal([]byte(result.Metafile), &meta); err != nil {
		return nil
	}
	files := []string{}
	for input := range meta.Inputs {
		if strings.Contains(input, ":") && !filepath.IsAbs(input) {
			// a namespace of esbuild's, not a file
			continue
		}
		path := input
		if !filepath.IsAbs(path) {
			path = filepath.Join(p.root, input)
		}
		files = append(files, p.linked(path)...)
	}
	return files
}

// linked is a file's path, and its path through each link to the project's
// folder or the folder sst dev watches: esbuild gives a file's real path, and
// the watcher gives it as it's under the folder it watches
func (p *Program) linked(path string) []string {
	paths := []string{path}
	for _, dir := range []string{p.root, p.PathWatch()} {
		real, err := filepath.EvalSymlinks(dir)
		if err != nil || real == dir {
			continue
		}
		if rel, err := filepath.Rel(real, path); err == nil && !strings.HasPrefix(rel, "..") {
			paths = append(paths, filepath.Join(dir, rel))
		}
	}
	return paths
}
