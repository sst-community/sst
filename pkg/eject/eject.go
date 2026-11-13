package eject

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
	"github.com/sst/sst/v3/internal/util"
	"github.com/sst/sst/v3/pkg/process"
	"gopkg.in/yaml.v3"
)

// Run ejects the stacks of the Pulumi project whose Pulumi.yaml is at
// cfgPath, and says what it did on out. One module is written for every
// stack with SST's components in it. With dryRun, it prints the module and
// what it would put in each stack's config and take out of its state, and
// changes nothing.
//
// It reads each stack's state and works out the module from them, and
// refuses before it writes anything when it can't. Then, in this order: it
// saves each stack's state to a file beside Pulumi.yaml, writes the module
// and puts what each stack has of its own in the stack's config, and takes
// SST's own resources out of each stack's state with one `pulumi stack
// import` for each. Nothing changes in the cloud. If it stops before the
// last import, it takes out what it wrote, and puts back the state of a
// stack it had imported, but leaves the saved states.
func Run(ctx context.Context, cfgPath, stack string, dryRun bool, out io.Writer) error {
	root := filepath.Dir(cfgPath)
	project, err := readProject(cfgPath)
	if err != nil {
		return err
	}
	if stack != "" {
		return util.NewReadableError(nil, "sst eject writes one program for every stack of the project, so it ejects them together. Run it without --stage.")
	}
	cli, err := exec.LookPath("pulumi")
	if err != nil {
		return util.NewReadableError(err, "sst eject runs the Pulumi CLI, and there's no pulumi on the PATH. Install it: https://www.pulumi.com/docs/iac/download-install/")
	}
	for _, file := range []string{ModuleFile, BuildFile} {
		if _, err := os.Stat(filepath.Join(root, file)); err == nil && !dryRun {
			return util.NewReadableError(nil, fmt.Sprintf("There's a %s beside Pulumi.yaml already. sst eject writes it, so it doesn't eject again over it: move it away first.", file))
		}
	}

	stacks, err := listStacks(cli, root)
	if err != nil {
		return util.NewReadableError(err, fmt.Sprintf("Could not list the project's stacks: %v", err))
	}
	if len(stacks) == 0 {
		return util.NewReadableError(nil, "The project has no stacks, so there's nothing to eject.")
	}
	plains := map[string][]byte{}
	var states []StackState
	for _, name := range stacks {
		plain, err := pulumi(cli, root, nil, "stack", "export", "--stack", name)
		if err != nil {
			return util.NewReadableError(err, fmt.Sprintf("Could not read the state of the %q stack: %v", name, err))
		}
		shown, err := pulumi(cli, root, nil, "stack", "export", "--show-secrets", "--stack", name)
		if err != nil {
			return util.NewReadableError(err, fmt.Sprintf("Could not read the state of the %q stack: %v", name, err))
		}
		plains[name] = plain
		states = append(states, StackState{Stack: name, Shown: shown})
	}
	now := time.Now()
	plan, err := Build(states, Options{Project: project, Date: now.Format("2006-01-02")})
	if err != nil {
		return util.NewReadableError(err, err.Error())
	}
	edited := map[string][]byte{}
	for _, sp := range plan.Stacks {
		remove := map[resource.URN]bool{}
		for _, urn := range sp.Remove {
			remove[urn] = true
		}
		if edited[sp.Stack], err = withoutResources(plains[sp.Stack], remove); err != nil {
			return util.NewReadableError(err, fmt.Sprintf("Could not take SST's own resources out of the %q stack's state: %v", sp.Name, err))
		}
	}
	if dryRun {
		preview(out, plan)
		return nil
	}

	backups := map[string]string{}
	for _, sp := range plan.Stacks {
		backups[sp.Stack] = filepath.Join(root, fmt.Sprintf("sst-eject-%s-%s.json", sp.Name, now.Format("20060102-150405")))
		if err := os.WriteFile(backups[sp.Stack], plains[sp.Stack], 0600); err != nil {
			return err
		}
	}

	// What's written is taken out again if it stops before the last import,
	// and a stack imported before is put back
	var written []string
	type key struct{ stack, key string }
	var set []key
	var imported []string
	undo := func(cause error) error {
		for _, file := range written {
			os.Remove(file)
		}
		for _, s := range set {
			pulumi(cli, root, nil, "config", "rm", s.key, "--stack", s.stack)
		}
		restored := ""
		for _, stack := range imported {
			if _, err := pulumi(cli, root, nil, "stack", "import", "--file", backups[stack], "--stack", stack); err != nil {
				restored += fmt.Sprintf("\nCould not put back the state of the %q stack: run `pulumi stack import --file %s --stack %s`.", stack, backups[stack], stack)
			}
		}
		return util.NewReadableError(cause, fmt.Sprintf("%v\n\nsst eject stopped, and took out what it wrote: no stack's state is changed.%s", cause, restored))
	}
	files := map[string]string{ModuleFile: plan.Module}
	if plan.Build != "" {
		files[BuildFile] = plan.Build
	}
	for _, name := range []string{ModuleFile, BuildFile} {
		text, ok := files[name]
		if !ok {
			continue
		}
		path := filepath.Join(root, name)
		if err := os.WriteFile(path, []byte(text), 0644); err != nil {
			return undo(err)
		}
		written = append(written, path)
	}
	for _, sp := range plan.Stacks {
		for _, setting := range sp.Config {
			args := []string{"config", "set", setting.Key, "--stack", sp.Stack}
			if setting.Secret {
				args = append(args, "--secret")
			}
			if _, err := pulumi(cli, root, strings.NewReader(setting.Value), args...); err != nil {
				return undo(fmt.Errorf("Could not put %s in the %q stack's config: %w", setting.Key, sp.Name, err))
			}
			set = append(set, key{sp.Stack, setting.Key})
		}
	}

	for _, sp := range plan.Stacks {
		// A deploy since the state was read isn't undone
		again, err := pulumi(cli, root, nil, "stack", "export", "--stack", sp.Stack)
		if err != nil {
			return undo(fmt.Errorf("Could not read the state of the %q stack again: %w", sp.Name, err))
		}
		if same, err := sameResources(plains[sp.Stack], again); err != nil || !same {
			return undo(fmt.Errorf("The %q stack's state changed while sst eject ran.", sp.Name))
		}
		file, err := os.CreateTemp("", "sst-eject-*.json")
		if err != nil {
			return undo(err)
		}
		_, writeErr := file.Write(edited[sp.Stack])
		file.Close()
		if writeErr != nil {
			os.Remove(file.Name())
			return undo(writeErr)
		}
		_, err = pulumi(cli, root, nil, "stack", "import", "--file", file.Name(), "--stack", sp.Stack)
		os.Remove(file.Name())
		if err != nil {
			return undo(fmt.Errorf("Could not take SST's own resources out of the %q stack's state: %w", sp.Name, err))
		}
		imported = append(imported, sp.Stack)
	}

	report(out, plan, project, root, backups)
	return nil
}

// listStacks is the project's stacks, as Pulumi names them
func listStacks(cli, root string) ([]string, error) {
	data, err := pulumi(cli, root, nil, "stack", "ls", "--json")
	if err != nil {
		return nil, err
	}
	var listed []struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(data, &listed); err != nil {
		return nil, err
	}
	var names []string
	for _, stack := range listed {
		names = append(names, stack.Name)
	}
	return names, nil
}

// readProject is the project's name, from its Pulumi.yaml, for a program in
// TypeScript or JavaScript
func readProject(cfgPath string) (string, error) {
	data, err := os.ReadFile(cfgPath)
	if err != nil {
		return "", err
	}
	var parsed struct {
		Name    string    `yaml:"name"`
		Runtime yaml.Node `yaml:"runtime"`
	}
	if err := yaml.Unmarshal(data, &parsed); err != nil {
		return "", util.NewReadableError(err, "Could not read "+cfgPath+": "+err.Error())
	}
	runtime := parsed.Runtime.Value
	if parsed.Runtime.Kind == yaml.MappingNode {
		var named struct {
			Name string `yaml:"name"`
		}
		_ = parsed.Runtime.Decode(&named)
		runtime = named.Name
	}
	if runtime != "nodejs" {
		return "", util.NewReadableError(nil, fmt.Sprintf("sst eject writes TypeScript, for a Pulumi program in TypeScript, and this one's runtime is %q.", runtime))
	}
	return parsed.Name, nil
}

// sameResources is whether two exports of a state have the same resources
func sameResources(a, b []byte) (bool, error) {
	read := func(data []byte) (json.RawMessage, error) {
		var parsed struct {
			Deployment struct {
				Resources json.RawMessage `json:"resources"`
			} `json:"deployment"`
		}
		err := json.Unmarshal(data, &parsed)
		return parsed.Deployment.Resources, err
	}
	first, err := read(a)
	if err != nil {
		return false, err
	}
	second, err := read(b)
	if err != nil {
		return false, err
	}
	return bytes.Equal(first, second), nil
}

// pulumi runs the Pulumi CLI in the project's folder, with what to read on
// its input, and returns what it printed, or an error with the first line
// of what it said went wrong
func pulumi(cli, dir string, stdin io.Reader, args ...string) ([]byte, error) {
	cmd := process.Command(cli, append(args, "--non-interactive")...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "PULUMI_SKIP_UPDATE_CHECK=true")
	cmd.Stdin = stdin
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	output, err := cmd.Output()
	if err != nil {
		message, _, _ := strings.Cut(strings.TrimSpace(stderr.String()), "\n")
		message = strings.TrimPrefix(strings.TrimSpace(message), "error: ")
		if message == "" {
			message = err.Error()
		}
		return nil, errors.New("pulumi " + args[0] + " " + args[1] + ": " + message)
	}
	return output, nil
}

// report says what the eject did and what's left to do
func report(out io.Writer, plan *Plan, project, root string, backups map[string]string) {
	rel := func(path string) string {
		if cwd, err := os.Getwd(); err == nil {
			if r, err := filepath.Rel(cwd, path); err == nil && !strings.HasPrefix(r, "..") {
				return r
			}
		}
		return path
	}
	var names []string
	for _, sp := range plan.Stacks {
		names = append(names, sp.Name)
	}
	fmt.Fprintf(out, "Ejected the %s of %s.\n\n", stacksPhrase(names), project)
	fmt.Fprintf(out, "Wrote %s, with SST's components as Pulumi's own resources:\n", rel(filepath.Join(root, ModuleFile)))
	var rows [][]string
	for _, c := range plan.Components {
		rows = append(rows, []string{c.Name, c.Type, c.MadeAt})
	}
	table(out, rows)
	if plan.Build != "" {
		fmt.Fprintf(out, "Wrote %s, a build of a Node.js function with esbuild, to switch a function to.\n", rel(filepath.Join(root, BuildFile)))
	}
	stackChanges(out, plan, "Put", "Took", "and nothing out of the cloud")
	var saved []string
	for _, sp := range plan.Stacks {
		saved = append(saved, rel(backups[sp.Stack]))
	}
	fmt.Fprintf(out, "Saved the state from before in %s.\n", strings.Join(saved, ", "))
	for _, name := range plan.Skipped {
		fmt.Fprintf(out, "Left out the %q stack, which has none of SST's components.\n", name)
	}
	fmt.Fprintln(out)

	updates := false
	for _, sp := range plan.Stacks {
		if len(sp.Updates) > 0 {
			updates = true
		}
	}
	fmt.Fprintln(out, "Next:")
	fmt.Fprintf(out, "  1. In the program, call ejected() from ./%s in place of SST's components,\n", strings.TrimSuffix(ModuleFile, ".ts"))
	fmt.Fprintln(out, "     and use the parts it returns where you used their outputs.")
	if len(plan.Takes) > 0 {
		fmt.Fprintln(out, "     Give it the program's own resources it takes, made before it's called:")
		for _, take := range plan.Takes {
			fmt.Fprintln(out, "       "+take)
		}
	}
	for _, use := range plan.Uses {
		fmt.Fprintln(out, "     "+use+".")
	}
	fmt.Fprintln(out, "  2. Take sst out of package.json, and run npm install.")
	if updates {
		fmt.Fprintln(out, "  3. Run pulumi preview on each stack: it updates what's listed above, and")
		fmt.Fprintln(out, "     changes nothing else in the cloud.")
	} else {
		fmt.Fprintln(out, "  3. Run pulumi preview on each stack: it changes nothing in the cloud.")
	}
	fmt.Fprintln(out)
	fmt.Fprintln(out, "To go back before you deploy, delete what sst eject wrote, and for each stack")
	fmt.Fprintf(out, "remove its %s config and put back its state:\n", ConfigNamespace)
	for _, sp := range plan.Stacks {
		fmt.Fprintf(out, "  pulumi stack import --file %s --stack %s\n", rel(backups[sp.Stack]), sp.Stack)
	}
}

// stackChanges is what the eject puts in each stack's config and takes out
// of its state. A stack that has the same taken out as the one before says
// so.
func stackChanges(out io.Writer, plan *Plan, put, took, after string) {
	var before []Removed
	for _, sp := range plan.Stacks {
		in := ""
		if len(plan.Stacks) > 1 {
			in = fmt.Sprintf(" of the %q stack", sp.Name)
		}
		secrets := 0
		for _, setting := range sp.Config {
			if setting.Secret {
				secrets++
			}
		}
		if n := len(sp.Config); n > 0 {
			kind := plural(n, "value", "values")
			if secrets == n {
				kind = "secret " + plural(n, "input", "inputs")
			} else if secrets > 0 {
				kind += fmt.Sprintf(" (%d of them secret)", secrets)
			}
			fmt.Fprintf(out, "%s %d %s in the config%s, under %s.\n", put, n, kind, in, ConfigNamespace)
		}
		same := len(before) == len(sp.Removed)
		for i := range sp.Removed {
			if same && (before[i].Name != sp.Removed[i].Name || before[i].Type != sp.Removed[i].Type) {
				same = false
			}
		}
		if same && len(before) > 0 {
			fmt.Fprintf(out, "%s the same %d resources out of the state%s.\n", took, len(sp.Removed), in)
		} else {
			fmt.Fprintf(out, "%s %d %s out of the state%s, %s:\n", took, len(sp.Removed), plural(len(sp.Removed), "resource", "resources"), in, after)
			var rows [][]string
			for _, r := range sp.Removed {
				rows = append(rows, []string{r.Name, r.Type, r.Why})
			}
			table(out, rows)
		}
		before = sp.Removed
		if len(sp.Updates) > 0 {
			fmt.Fprintf(out, "Wrote what the state%s doesn't have, so the first `pulumi up` updates it in place, to what it already is in AWS:\n", in)
			for _, update := range sp.Updates {
				fmt.Fprintln(out, "  "+update)
			}
		}
	}
}

func table(out io.Writer, rows [][]string) {
	w := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
	for _, row := range rows {
		fmt.Fprintln(w, "  "+strings.Join(row, "\t"))
	}
	w.Flush()
}

// preview is what an eject would write, put in each stack's config and take
// out of its state
func preview(out io.Writer, plan *Plan) {
	fmt.Fprintf(out, "// %s\n%s", ModuleFile, plan.Module)
	if plan.Build != "" {
		fmt.Fprintf(out, "\n// %s\n%s", BuildFile, plan.Build)
	}
	fmt.Fprintln(out)
	for _, sp := range plan.Stacks {
		for _, setting := range sp.Config {
			kind := "a value"
			if setting.Secret {
				kind = "a secret"
			}
			fmt.Fprintf(out, "Would put %s in the %q stack's config, as %s.\n", setting.Key, sp.Name, kind)
		}
	}
	stackChanges(out, plan, "Would put", "Would take", "and nothing out of the cloud")
	for _, name := range plan.Skipped {
		fmt.Fprintf(out, "Would leave out the %q stack, which has none of SST's components.\n", name)
	}
	for _, take := range plan.Takes {
		fmt.Fprintln(out, "ejected() would take "+take+".")
	}
	for _, use := range plan.Uses {
		fmt.Fprintln(out, use+".")
	}
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}
