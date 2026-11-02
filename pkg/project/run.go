package project

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"path"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/pulumi/pulumi/sdk/v3/go/auto/events"
	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
	"github.com/sst/sst/v3/internal/util"
	"github.com/sst/sst/v3/pkg/bus"
	"github.com/sst/sst/v3/pkg/flag"
	"github.com/sst/sst/v3/pkg/global"
	"github.com/sst/sst/v3/pkg/id"
	"github.com/sst/sst/v3/pkg/js"
	"github.com/sst/sst/v3/pkg/process"
	"github.com/sst/sst/v3/pkg/project/provider"
	"github.com/sst/sst/v3/pkg/target"
	"github.com/sst/sst/v3/pkg/telemetry"
	"github.com/sst/sst/v3/pkg/types"
	"golang.org/x/exp/slices"
	"golang.org/x/sync/errgroup"
)

func (p *Project) Run(ctx context.Context, input *StackInput) error {
	err := p.run(ctx, input)
	// A program that turned out to have checks stopped before anything
	// changed, as a check's finding has to stop a deploy before then. It's run
	// again with a preview first.
	if errors.Is(err, errChecksNeedPreview) {
		again := *input
		again.previewFirst = true
		return p.run(ctx, &again)
	}
	return err
}

// errChecksNeedPreview is a deploy that ran with no preview, whose program
// has checks
var errChecksNeedPreview = errors.New("the program has checks, and the deploy ran with no preview")

// checksNeedPreview is what the program says when it stops for it, from
// platform/src/components/check.ts
const checksNeedPreview = "has checks, so its deploys run a preview first"

func (p *Project) run(ctx context.Context, input *StackInput) error {
	log := slog.Default().With("service", "project.run")
	log.Info("running stack command", "cmd", input.Command)

	if p.app.Protect && input.Command == "remove" {
		return ErrProtectedStage
	}

	// A run again with a preview first goes on from the first, which was shown
	// as the command's start (Run)
	if !input.previewFirst {
		bus.Publish(&StackCommandEvent{
			App:     p.app.Name,
			Stage:   p.app.Stage,
			Config:  p.PathConfig(),
			Command: input.Command,
			Version: p.Version(),
		})
	}

	update := &provider.Update{
		ID: id.Descending(),
	}
	var err error
	if input.Locked != nil {
		update = input.Locked
		log = log.With("updateID", update.ID)
	} else if input.Command != "diff" {
		update, err = p.Lock(input.Command)
		if err != nil {
			if err == provider.ErrLockExists {
				bus.Publish(&ConcurrentUpdateEvent{})
			}
			return err
		}
		log = log.With("updateID", update.ID)
		defer p.Unlock()
	}

	workdir, err := p.NewWorkdir(update.ID)
	if err != nil {
		return err
	}
	defer workdir.Cleanup()

	var passphrase string
	switch {
	case input.Command == "diff":
		// A diff writes nothing to the home. A stage with no passphrase has no
		// state or secrets to decrypt, so one made for this run will do.
		passphrase, err = provider.GetPassphrase(p.home, p.app.Name, p.app.Stage)
		if err == nil && passphrase == "" {
			passphrase, err = provider.NewPassphrase()
		}
	case input.Command == "deploy" || input.Dev:
		passphrase, err = provider.GetOrCreatePassphrase(p.home, p.app.Name, p.app.Stage)
	default:
		passphrase, err = provider.GetPassphrase(p.home, p.app.Name, p.app.Stage)
	}
	if err != nil {
		return err
	}

	outfile := filepath.Join(p.PathPlatformDir(), fmt.Sprintf("sst.config.%v.mjs", time.Now().UnixMilli()))
	// Pulumi runs this binary as the provider of SST's own resources. The
	// folder has to be there before Pulumi reads the Pulumi.yaml naming it.
	// It's in this run's work folder, so another CLI running on the app at the
	// same time can't swap it for itself.
	plugins := filepath.Join(workdir.path, "plugins", "sst")
	if err := linkSstPlugin(plugins); err != nil {
		return fmt.Errorf("linking the sst provider: %w", err)
	}
	if err := writePulumiYaml(filepath.Join(workdir.path, "Pulumi.yaml"), p.app.Name, outfile, plugins); err != nil {
		return err
	}
	pulumiStdout, err := os.Create(p.PathLog("pulumi"))
	if err != nil {
		return err
	}
	defer pulumiStdout.Close()
	pulumiStderr, err := os.Create(p.PathLog("pulumi.err"))
	if err != nil {
		return err
	}
	defer pulumiStderr.Close()
	_, err = workdir.Pull()
	if err != nil {
		if errors.Is(err, provider.ErrStateNotFound) {
			if input.Command != "deploy" && input.Command != "diff" {
				return ErrStageNotFound
			}
			// A stage that was deployed has its state in the home. If the home
			// doesn't, it's reading the wrong place, and a deploy would create
			// every resource again.
			if !flag.SST_ALLOW_MISSING_STATE {
				deployed, err := provider.HasDeployHistory(p.home, p.app.Name, p.app.Stage)
				if err != nil {
					return err
				}
				if deployed {
					return provider.ErrStateMissing
				}
			}
			cmd := process.Command(global.PulumiPath(), "stack", "init", "organization/"+p.app.Name+"/"+p.app.Stage)
			cmd.Stdout = pulumiStdout
			cmd.Stderr = pulumiStderr
			cmd.Dir = workdir.path
			cmd.Env = os.Environ()
			cmd.Env = append(cmd.Env,
				"PULUMI_BACKEND_URL="+filepath.ToSlash("file://"+workdir.Backend()),
				"PULUMI_CONFIG_PASSPHRASE="+passphrase,
				"PULUMI_HOME="+global.ConfigDir(),
			)
			err := cmd.Run()
			if err != nil {
				return err
			}

		} else {
			return err
		}
	}

	// A move saves the state as it was, and releases what the components'
	// maps say it does: marked retained in the state this deploy runs from,
	// under its lock
	if input.Command == "deploy" && input.Move {
		if err := p.beginMove(workdir, update.ID, input.Release); err != nil {
			return util.NewReadableError(err, "The move can't start: "+err.Error()+".")
		}
	}

	completed, err := getCompletedEvent(ctx, passphrase, workdir)
	if err != nil {
		bus.Publish(&BuildFailedEvent{
			Error: err.Error(),
		})
		log.Info("state file might be corrupted", "err", err)
		return err
	}
	completed.Finished = true
	completed.Old = true
	bus.Publish(completed)
	log.Info("got previous deployment")

	state := stageState(completed)
	if err := p.refuseUnmoved(input, state); err != nil {
		// Locking the stage put this run in its history
		if input.Locked == nil {
			p.DropUpdate(update)
		}
		return err
	}
	// What a remove that doesn't finish puts back
	marker := markerOf(completed.Resources)

	define, err := p.programDefine(input, state)
	if err != nil {
		return err
	}

	globals, platform := p.programGlobals()

	buildResult, err := js.Build(js.EvalOptions{
		Dir:      p.PathRoot(),
		Outfile:  outfile,
		Define:   define,
		Inject:   []string{filepath.ToSlash(filepath.Join(p.PathWorkingDir(), "platform/src/shim/run.js"))},
		Globals:  globals,
		Platform: platform,
		Code: fmt.Sprintf(`
      import { run } from "%v";
			import mod from '%s';
      const result = await run(mod.run);
      export default result;
    `,
			filepath.ToSlash(path.Join(p.PathWorkingDir(), "platform/src/auto/run.ts")),
			filepath.ToSlash(p.PathConfig()),
		),
	})
	if err != nil {
		bus.Publish(&BuildFailedEvent{
			Error: err.Error(),
		})
		log.Error("failed to build sst.config.ts", "err", err)
		return err
	}
	log.Info("built sst.config.ts", "to", outfile)
	if !flag.SST_NO_CLEANUP {
		defer js.Cleanup(buildResult)
	}

	// disable for now until we hash env too
	if input.SkipHash != "" && buildResult.OutputFiles[0].Hash == input.SkipHash && false {
		bus.Publish(&SkipEvent{})
		return nil
	}

	var meta = js.Metafile{}
	err = json.Unmarshal([]byte(buildResult.Metafile), &meta)
	if err != nil {
		return err
	}
	files := []string{}

	for key := range meta.Inputs {
		absPath, err := filepath.Abs(key)
		if err != nil {
			continue
		}
		files = append(files, absPath)
	}
	bus.Publish(&BuildSuccessEvent{
		Files: files,
		Hash:  buildResult.OutputFiles[0].Hash,
	})
	log.Info("tracked files")

	if err := checkPackages(meta, p.version, p.lock); err != nil {
		return util.NewReadableError(nil, err.Error())
	}

	secrets := map[string]string{}
	fallback := map[string]string{}

	wg := errgroup.Group{}

	wg.Go(func() error {
		var err error
		secrets, err = provider.GetSecrets(p.home, p.app.Name, p.app.Stage)
		if err != nil {
			return ErrPassphraseInvalid
		}
		return nil
	})

	wg.Go(func() error {
		var err error
		fallback, err = provider.GetSecrets(p.home, p.app.Name, "")
		if err != nil {
			return ErrPassphraseInvalid
		}
		return nil
	})

	if err := wg.Wait(); err != nil {
		return err
	}

	env := p.programEnv(os.Environ(), passphrase, workdir.Backend(), secrets, fallback, input.Server)
	pulumiPath := global.PulumiPath()
	if flag.SST_PULUMI_PATH != "" {
		pulumiPath = flag.SST_PULUMI_PATH
	}
	// On a target's stage, Pulumi's engine can't download a plugin as it runs
	if !target.IsCloud(p.Target()) {
		p.installPlugins(ctx, pulumiPath)
	}

	eventlogPath := workdir.EventLogPath()
	eventlog, err := os.OpenFile(eventlogPath, os.O_RDWR|os.O_CREATE, 0644)
	if err != nil {
		return err
	}
	defer eventlog.Close()

	args := []string{
		"--stack", fmt.Sprintf("organization/%v/%v", p.app.Name, p.app.Stage),
		"--non-interactive",
		"--event-log", eventlogPath,
	}

	if input.Command == "deploy" {
		upgradeMsgs := p.checkProviderUpgrade(completed.Resources)
		if len(upgradeMsgs) > 0 {
			return util.NewReadableError(nil, strings.Join(upgradeMsgs, "\n\n"))
		}
	}

	if input.Command == "deploy" || input.Command == "diff" || input.Command == "refresh" {
		config, err := providerConfigArgs(p.app.Providers)
		if err != nil {
			return err
		}
		args = append(args, config...)
	}

	// Whether a deploy runs Pulumi's preview first
	withPreview := false
	switch input.Command {
	case "diff":
		args = append([]string{"preview"}, args...)
	case "refresh":
		args = append([]string{"refresh", "--yes", "--run-program"}, args...)
	case "deploy":
		// A move, too: its state is saved and marked before it runs, and
		// it isn't run again from the marked one
		if input.PolicyPath != "" || input.previewFirst || input.Move || previewFirst(workdir) {
			withPreview = true
			// Preview first, so a mandatory policy or a check stops the
			// deploy before anything is changed
			args = append([]string{"up", "--yes"}, args...)
		} else {
			args = append([]string{"up", "--yes", "-f"}, args...)
		}
	case "remove":
		args = append([]string{"destroy", "--yes", "-f"}, args...)
	}

	if (input.Command == "diff" || input.Command == "deploy") && input.PolicyPath != "" {
		policyPath, err := p.ResolvePolicyPackPath(input.PolicyPath)
		if err != nil {
			return util.NewReadableError(nil, err.Error())
		}
		args = append(args, "--policy-pack", policyPath)
	}

	if input.Target != nil {
		for _, item := range input.Target {
			index := slices.IndexFunc(completed.Resources, func(res apitype.ResourceV3) bool {
				return res.URN.Name() == item
			})
			if index == -1 {
				return util.NewReadableError(nil, fmt.Sprintf("Target not found: %v", item))
			}
			args = append(args, "--target", string(completed.Resources[index].URN))
		}
		if len(input.Target) > 0 {
			args = append(args, "--target-dependents")
		}
	}

	if input.Exclude != nil {
		for _, item := range input.Exclude {
			index := slices.IndexFunc(completed.Resources, func(res apitype.ResourceV3) bool {
				return res.URN.Name() == item
			})
			if index == -1 {
				return util.NewReadableError(nil, fmt.Sprintf("Exclude target not found: %v", item))
			}
			args = append(args, "--exclude", string(completed.Resources[index].URN))
		}
		if len(input.Exclude) > 0 {
			args = append(args, "--exclude-dependents")
		}
	}

	cmd := process.Command(pulumiPath, args...)
	process.Detach(cmd)
	cmd.Env = env
	if withPreview {
		// The program's checks know the deploy has a preview first
		cmd.Env = append(cmd.Env, "SST_PREVIEW_FIRST=1")
	}
	cmd.Stdout = pulumiStdout
	cmd.Stderr = pulumiStderr
	cmd.Dir = workdir.Backend()
	log.Info("starting pulumi", "args", cmd.Args)

	errors := []Error{}
	finished := false
	importDiffs := map[string][]ImportDiff{}
	hasPolicyFlag := input.PolicyPath != ""
	hasPolicyEvents := false
	hasPolicyViolations := false
	// A deploy with a policy pack runs Pulumi's preview before the update. The
	// preview's events aren't passed on, as they'd show each resource as
	// changed before anything is. Pulumi starts the event log again for the
	// update, and can do so before the preview's last events are read. It
	// opens the same file again with O_TRUNC (startEventLogger in its
	// backend/display), which this relies on: check a deploy with --policy
	// when Pulumi is updated.
	previewing := input.Command == "deploy" && withPreview
	// A deploy with no preview whose program turns out to have checks stops
	// before anything changes, to run again with a preview first (Run). From
	// where it says so, nothing of the run is shown, and none of it is kept.
	mayStopForPreview := input.Command == "deploy" && !withPreview
	stoppedForPreview := false
	// the preview's log up to its first planned step, which the update's
	// log doesn't have
	var previewStart []byte
	planned := false
	var read int64
	// what the program logged in the preview, shown only if the update
	// doesn't run, as the update logs it again
	var previewDiagnostics []*apitype.DiagnosticEvent
	// The preview and the update each report an advisory policy
	advisories := map[string]bool{}

	partial := make(chan int, 1000)
	partialContext, partialCancel := context.WithCancel(ctx)
	defer partialCancel()
	partialDone := make(chan error)
	go func() {
		if input.Command == "diff" {
			return
		}
		for {
			select {
			case <-partialContext.Done():
				partialDone <- nil
				return
			case <-partial:
				workdir.PushPartial(update.ID)
			case <-time.After(time.Second * 5):
				workdir.PushPartial(update.ID)
				continue
			}
		}
	}()

	err = cmd.Start()
	if err != nil {
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
			return
		case <-ctx.Done():
			if cmd.Process != nil {
				log.Info("sending interrupt")
				err := cmd.Process.Signal(syscall.SIGINT)
				if err != nil {
					log.Error("failed to send interrupt", "err", err)
				}
				bus.Publish(&CancelledEvent{})
				interruptChannel := make(chan os.Signal, 1)
				signal.Notify(interruptChannel, syscall.SIGINT, syscall.SIGTERM)

				for {
					select {
					case <-exited:
						return
					case <-interruptChannel:
						if cmd.Process != nil {
							log.Info("sending force interrupt")
							err := cmd.Process.Signal(syscall.SIGINT)
							if err != nil {
								log.Error("failed to send interrupt", "err", err)
							}
						}
					}
				}
			}
		}
	}()

	reader := bufio.NewReader(eventlog)
	// The start of a line Pulumi hasn't finished writing. The rest of it comes
	// with a later read.
	var pending []byte
	// Reads the update's event log from its start. What was taken from it as
	// the preview's is dropped: a preview that passed leaves no errors.
	readUpdate := func() error {
		log.Info("reading the update's event log")
		if _, err := eventlog.Seek(0, io.SeekStart); err != nil {
			return err
		}
		reader.Reset(eventlog)
		pending = nil
		read = 0
		previewing = false
		previewDiagnostics = nil
		errors = []Error{}
		importDiffs = map[string][]ImportDiff{}
		hasPolicyViolations = false
		return nil
	}

	eofs := 0
loop:
	for {
		bytes, err := reader.ReadBytes('\n')
		read += int64(len(bytes))
		// every byte read, a part of a line too, so it's the file's start
		if previewing && !planned {
			previewStart = append(previewStart, bytes...)
		}
		if err != nil {
			if err == io.EOF {
				pending = append(pending, bytes...)
				if previewing && len(previewStart) > 0 && eventLogRestarted(eventlog, read, previewStart) {
					if err := readUpdate(); err != nil {
						return err
					}
					continue
				}
				select {
				case <-exited:
					log.Info("eof and exited", "eofs", eofs)
					eofs++
					if eofs < 2 {
						continue
					}
					log.Info("breaking out of tail loop")
					break loop
				case <-time.After(time.Millisecond * 100):
					continue
				}
			}
			continue
		}
		if len(pending) > 0 {
			bytes = append(pending, bytes...)
			pending = nil
		}

		var event events.EngineEvent
		err = json.Unmarshal(bytes, &event)
		if err != nil {
			log.Error("failed to unmarshal event", "err", err)
			continue
		}

		if mayStopForPreview && event.DiagnosticEvent != nil && strings.Contains(event.DiagnosticEvent.Message, checksNeedPreview) {
			stoppedForPreview = true
		}
		if stoppedForPreview {
			continue
		}

		if previewing {
			pre, outputs := event.ResourcePreEvent, event.ResOutputsEvent
			// A step the update took, read from where the preview's log
			// ended, before the log was seen to start again
			if (pre != nil && !pre.Planning) || (outputs != nil && !outputs.Planning) {
				if err := readUpdate(); err != nil {
					return err
				}
				continue
			}
			if pre != nil && pre.Planning {
				planned = true
			}
		}

		if event.PolicyEvent != nil {
			hasPolicyEvents = true
			message := fmt.Sprintf("Policy: %s\n%s",
				event.PolicyEvent.PolicyName,
				strings.TrimSpace(event.PolicyEvent.Message))

			if event.PolicyEvent.EnforcementLevel == "mandatory" {
				log.Info("policy violation",
					"policy", event.PolicyEvent.PolicyName,
					"urn", event.PolicyEvent.ResourceURN)

				errors = append(errors, Error{
					Message: message,
					URN:     event.PolicyEvent.ResourceURN,
				})
				hasPolicyViolations = true
			} else if event.PolicyEvent.EnforcementLevel == "advisory" {
				log.Info("policy advisory",
					"policy", event.PolicyEvent.PolicyName,
					"urn", event.PolicyEvent.ResourceURN)

				message := strings.TrimSpace(event.PolicyEvent.Message)
				key := event.PolicyEvent.PolicyName + "\x00" + event.PolicyEvent.ResourceURN + "\x00" + message
				if !advisories[key] {
					advisories[key] = true
					bus.Publish(&PolicyAdvisoryEvent{
						Policy:  event.PolicyEvent.PolicyName,
						Message: message,
						URN:     event.PolicyEvent.ResourceURN,
					})
				}
			}
		}

		if event.DiagnosticEvent != nil && event.DiagnosticEvent.Severity == "error" {
			// A check's finding stops a resource's registration, and comes
			// wrapped in Pulumi's message about it
			if finding := checkFinding(event.DiagnosticEvent.Message); finding != "" {
				event.DiagnosticEvent.Message = finding
			}
			if strings.HasPrefix(event.DiagnosticEvent.Message, "update failed") || (input.Command == "deploy" && (strings.TrimSpace(event.DiagnosticEvent.Message) == "preview failed" || strings.TrimSpace(event.DiagnosticEvent.Message) == "preview canceled")) || strings.HasPrefix(event.DiagnosticEvent.Message, "update cancelled") || strings.Contains(event.DiagnosticEvent.Message, "failed to register new resource") {
				continue
			}

			exists := false
			if event.DiagnosticEvent.URN != "" {
				for _, item := range errors {
					if item.URN == event.DiagnosticEvent.URN {
						exists = true
						break
					}
				}
			}

			if exists {
				continue
			}

			if !exists {
				errors = append(errors, Error{
					Message: strings.TrimSpace(event.DiagnosticEvent.Message),
					URN:     event.DiagnosticEvent.URN,
				})
				// A check's finding is the app's, and can quote its values
				if checkFinding(event.DiagnosticEvent.Message) == "" {
					log.Info("telemetry tracking error")
					telemetry.Track("cli.resource.error", map[string]interface{}{
						"error": event.DiagnosticEvent.Message,
						"urn":   event.DiagnosticEvent.URN,
					})
				}
			}
		}

		if event.ResOpFailedEvent != nil {
			if event.ResOpFailedEvent.Metadata.Op == apitype.OpImport {
				for _, name := range event.ResOpFailedEvent.Metadata.Diffs {
					old := event.ResOpFailedEvent.Metadata.Old.Inputs[name]
					next := event.ResOpFailedEvent.Metadata.New.Inputs[name]
					diffs, ok := importDiffs[event.ResOpFailedEvent.Metadata.URN]
					if !ok {
						diffs = []ImportDiff{}
					}
					importDiffs[event.ResOpFailedEvent.Metadata.URN] = append(diffs, ImportDiff{
						URN:   event.ResOpFailedEvent.Metadata.URN,
						Input: name,
						Old:   old,
						New:   next,
					})
				}
			}
		}

		if previewing {
			if event.DiagnosticEvent != nil && event.DiagnosticEvent.Severity != "debug" {
				previewDiagnostics = append(previewDiagnostics, event.DiagnosticEvent)
			}
			continue
		}

		if input.Command != "diff" && (event.ResOutputsEvent != nil || event.CancelEvent != nil || event.SummaryEvent != nil) {
			partial <- 1
		}

		for _, field := range getNotNilFields(event) {
			bus.Publish(field)
		}

		if event.SummaryEvent != nil {
			finished = true
		}
	}

	if stoppedForPreview {
		log.Info("the program has checks; running again with a preview first")
		partialCancel()
		<-partialDone
		// Locking the stage put this run in its history
		if err := provider.RemoveUpdate(p.home, p.app.Name, p.app.Stage, update.ID); err != nil {
			log.Warn("removing the stopped run from the history", "err", err)
		}
		return errChecksNeedPreview
	}

	// The update didn't run, so what the preview logged is shown
	for _, diagnostic := range previewDiagnostics {
		bus.Publish(diagnostic)
	}

	// fallback: re-read the event log if the tailing loop missed SummaryEvent
	if !finished {
		if data, err := os.ReadFile(eventlogPath); err == nil {
			for _, line := range strings.Split(string(data), "\n") {
				if line == "" {
					continue
				}
				var ev events.EngineEvent
				if json.Unmarshal([]byte(line), &ev) != nil || ev.SummaryEvent == nil {
					continue
				}
				// a deploy's preview finishing isn't the deploy finishing
				if input.Command == "deploy" && ev.SummaryEvent.IsPreview {
					continue
				}
				finished = true
				break
			}
		}
	}

	// if pulumi exited without completing and no resource errors were captured,
	// check stderr for the actual error (e.g. snapshot integrity failures)
	if !finished && len(errors) == 0 {
		if data, err := os.ReadFile(pulumiStderr.Name()); err == nil {
			stderr := strings.TrimSpace(string(data))
			if stderr != "" {
				if strings.Contains(stderr, "snapshot integrity") {
					errors = append(errors, Error{
						Message: "Your app state is corrupted.",
						Help: []string{
							"Run `sst state repair` to fix state integrity issues",
							"Learn more: https://sst-community.github.io/sst/docs/reference/cli/#state-repair",
						},
					})
				} else {
					msg := strings.SplitN(stderr, "\n", 2)[0]
					msg = strings.TrimPrefix(msg, "error: ")
					errors = append(errors, Error{
						Message: msg,
					})
				}
			}
		}
	}

	log.Info("parsing state")
	complete, err := getCompletedEvent(context.Background(), passphrase, workdir)
	if err != nil {
		return err
	}
	complete.UpdateID = update.ID
	complete.Finished = finished
	complete.Errors = errors
	complete.ImportDiffs = importDiffs
	// A remove after which no links remain would rewrite the types empty, and
	// blank out the types the developer still needs to work against. A remove
	// after which some links remain, such as one with a --target or one that failed
	// partway, regenerates them from what remains.
	if generatesTypes(input, complete) {
		types.Generate(p.PathConfig(), complete.Links, p.App().Types.Ignore)
	}
	defer bus.Publish(complete)

	if input.Command != "diff" {
		log.Info("canceling partial")
		partialCancel()
		log.Info("waiting for partial to exit")
		<-partialDone

		// A remove that didn't finish keeps the marker of a stage on SST 5's
		// components
		if input.Command == "remove" && marker != nil {
			checkpoint, err := workdir.Export()
			if err != nil {
				return err
			}
			if keepMarker(checkpoint, marker) {
				if err := workdir.Import(checkpoint); err != nil {
					return err
				}
			}
		}

		err = workdir.Push(update.ID)
		if err != nil {
			return err
		}
	}

	outputsFilePath := filepath.Join(p.PathWorkingDir(), "outputs.json")
	outputsFile, _ := os.Create(outputsFilePath)
	defer outputsFile.Close()
	json.NewEncoder(outputsFile).Encode(complete.Outputs)

	if input.Command != "diff" {
		update.TimeCompleted = time.Now().Format(time.RFC3339)
		for _, err := range errors {
			update.Errors = append(update.Errors, provider.SummaryError{
				URN:     err.URN,
				Message: err.Message,
			})
		}
		err = provider.PutUpdate(p.home, p.app.Name, p.app.Stage, update)
		if err != nil {
			return err
		}
	}

	if input.Command != "diff" && p.app.State != nil && p.app.State.Retention != nil {
		if err := provider.Prune(p.home, p.app.Name, p.app.Stage, *p.app.State.Retention); err != nil {
			log.Warn("failed to prune state history", "err", err)
		}
	}

	if input.Command == "remove" && len(complete.Resources) == 0 {
		defer p.stopIdleTarget()
		p.removeTransport()
		if p.app.State != nil && p.app.State.Purge {
			if err := provider.Purge(p.home, p.app.Name, p.app.Stage); err != nil {
				return err
			}
		} else {
			if err := provider.Cleanup(p.home, p.app.Name, p.app.Stage); err != nil {
				return err
			}
		}
	}

	log.Info("done running stack command", "resources", len(complete.Resources))

	if cmd.ProcessState.ExitCode() > 0 {
		if input.Command == "deploy" && !withPreview {
			for _, e := range errors {
				if strings.Contains(e.Message, checksNeedPreview) {
					return errChecksNeedPreview
				}
			}
		}
		if hasPolicyViolations {
			return ErrPolicyViolation
		}
		if hasPolicyFlag && !hasPolicyEvents && len(errors) == 0 {
			return ErrPolicyConfigError
		}
		return ErrStackRunFailed
	}
	return nil
}

// Whether Pulumi has started the event log again, as it does for the update
// after a preview: it's shorter than what was read of it, or it doesn't start
// with the preview's start. Through its first planned step, which the update
// doesn't log, the preview's start is unlike any update's.
func eventLogRestarted(file *os.File, read int64, previewStart []byte) bool {
	info, err := file.Stat()
	if err != nil {
		return false
	}
	if info.Size() < read {
		return true
	}
	start := make([]byte, len(previewStart))
	// it's at least as long as what was read, so a failed read isn't one
	if _, err := file.ReadAt(start, 0); err != nil {
		return false
	}
	return !bytes.Equal(start, previewStart)
}

// how long sst remove gives the transport to remove what it made for the
// stage, like AppSync listing the Event APIs and removing the stage's, so one
// that doesn't answer can't hold the remove up
var removeTransportTimeout = 10 * time.Second

// removeTransport removes what the stage's transport made outside the state
// for sst dev, like the stage's own Event API, which "dev.appsync" set to
// "stage" has sst dev create. The remove doesn't fail without it.
func (p *Project) removeTransport() {
	t, ok := p.Transport()
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), removeTransportTimeout)
	defer cancel()
	if err := t.Remove(ctx); err != nil {
		slog.Warn("failed to remove what the transport made for the stage", "err", err)
	}
}

// generatesTypes says whether a stack command regenerates the type files. Every
// command does, except a remove that left no links in the stage: the files would
// be rewritten empty, and the developer still needs the types they had.
func generatesTypes(input *StackInput, complete *CompleteEvent) bool {
	return !(input.Command == "remove" && len(complete.Links) == 0)
}
