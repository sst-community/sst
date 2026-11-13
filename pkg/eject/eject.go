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
	"github.com/sst/sst/v3/pkg/pulumidev"
	"gopkg.in/yaml.v3"
)

// Run ejects a stack of the Pulumi project whose Pulumi.yaml is at cfgPath,
// the selected one when stack is "", and says what it did on out. With
// dryRun, it prints the module and what it would take out of the state, and
// changes nothing.
//
// It reads the stack's state and works out the module from it, and refuses
// before it writes anything when it can't. Then, in this order: it saves the
// state to a file beside Pulumi.yaml, writes the module and puts the secret
// inputs in the stack's config, and takes SST's own resources out of the
// state with one `pulumi stack import`. Nothing changes in the cloud. If it
// stops before the import, it takes out what it wrote but the saved state.
func Run(ctx context.Context, cfgPath, stack string, dryRun bool, out io.Writer) error {
	root := filepath.Dir(cfgPath)
	project, err := readProject(cfgPath)
	if err != nil {
		return err
	}
	cli, err := exec.LookPath("pulumi")
	if err != nil {
		return util.NewReadableError(err, "sst eject runs the Pulumi CLI, and there's no pulumi on the PATH. Install it: https://www.pulumi.com/docs/iac/download-install/")
	}
	if stack == "" {
		if stack, err = pulumidev.SelectedStack(cfgPath); err != nil {
			return err
		}
	}
	stage := pulumidev.StageOf(stack)
	for _, file := range []string{ModuleFile, BuildFile} {
		if _, err := os.Stat(filepath.Join(root, file)); err == nil && !dryRun {
			return util.NewReadableError(nil, fmt.Sprintf("There's a %s beside Pulumi.yaml already. sst eject writes it, so it doesn't eject again over it: move it away first.", file))
		}
	}

	plain, err := pulumi(cli, root, nil, "stack", "export", "--stack", stack)
	if err != nil {
		return util.NewReadableError(err, fmt.Sprintf("Could not read the state of the %q stack: %v", stack, err))
	}
	shown, err := pulumi(cli, root, nil, "stack", "export", "--show-secrets", "--stack", stack)
	if err != nil {
		return util.NewReadableError(err, fmt.Sprintf("Could not read the state of the %q stack: %v", stack, err))
	}
	now := time.Now()
	plan, err := Build(shown, Options{Project: project, Stack: stage, Date: now.Format("2006-01-02")})
	if err != nil {
		return util.NewReadableError(err, err.Error())
	}
	remove := map[resource.URN]bool{}
	for _, urn := range plan.Remove {
		remove[urn] = true
	}
	edited, err := withoutResources(plain, remove)
	if err != nil {
		return util.NewReadableError(err, "Could not take SST's own resources out of the state: "+err.Error())
	}

	if dryRun {
		preview(out, plan, stage)
		return nil
	}

	backup := filepath.Join(root, fmt.Sprintf("sst-eject-%s-%s.json", stage, now.Format("20060102-150405")))
	if err := os.WriteFile(backup, plain, 0600); err != nil {
		return err
	}

	// What's written is taken out again if it stops before the state changes
	var written []string
	var set []string
	undo := func(cause error) error {
		for _, file := range written {
			os.Remove(file)
		}
		for _, key := range set {
			pulumi(cli, root, nil, "config", "rm", key, "--stack", stack)
		}
		return util.NewReadableError(cause, fmt.Sprintf("%v\n\nsst eject stopped before it changed the state, and took out what it wrote.", cause))
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
	for _, secret := range plan.Secrets {
		if _, err := pulumi(cli, root, strings.NewReader(secret.Value), "config", "set", "--secret", secret.Key, "--stack", stack); err != nil {
			return undo(fmt.Errorf("Could not put %s in the stack's config: %w", secret.Key, err))
		}
		set = append(set, secret.Key)
	}

	// A deploy since the state was read isn't undone
	again, err := pulumi(cli, root, nil, "stack", "export", "--stack", stack)
	if err != nil {
		return undo(fmt.Errorf("Could not read the state of the %q stack again: %w", stack, err))
	}
	if same, err := sameResources(plain, again); err != nil || !same {
		return undo(fmt.Errorf("The %q stack's state changed while sst eject ran.", stack))
	}
	file, err := os.CreateTemp("", "sst-eject-*.json")
	if err != nil {
		return undo(err)
	}
	defer os.Remove(file.Name())
	if _, err := file.Write(edited); err != nil {
		file.Close()
		return undo(err)
	}
	file.Close()
	if _, err := pulumi(cli, root, nil, "stack", "import", "--file", file.Name(), "--stack", stack); err != nil {
		return undo(fmt.Errorf("Could not take SST's own resources out of the state: %w", err))
	}

	report(out, plan, project, stage, root, backup)
	return nil
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
func report(out io.Writer, plan *Plan, project, stage, root, backup string) {
	rel := func(path string) string {
		if cwd, err := os.Getwd(); err == nil {
			if r, err := filepath.Rel(cwd, path); err == nil && !strings.HasPrefix(r, "..") {
				return r
			}
		}
		return path
	}
	table := func(rows [][]string) {
		w := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
		for _, row := range rows {
			fmt.Fprintln(w, "  "+strings.Join(row, "\t"))
		}
		w.Flush()
	}
	module := rel(filepath.Join(root, ModuleFile))
	fmt.Fprintf(out, "Ejected the %q stack of %s.\n\n", stage, project)
	fmt.Fprintf(out, "Wrote %s, with SST's components as Pulumi's own resources:\n", module)
	var rows [][]string
	for _, c := range plan.Components {
		rows = append(rows, []string{c.Name, c.Type, c.MadeAt})
	}
	table(rows)
	if plan.Build != "" {
		fmt.Fprintf(out, "Wrote %s, a build of a Node.js function with esbuild, to switch a function to.\n", rel(filepath.Join(root, BuildFile)))
	}
	if n := len(plan.Secrets); n > 0 {
		fmt.Fprintf(out, "Put %d secret %s in the stack's config, under %s.\n", n, plural(n, "input", "inputs"), ConfigNamespace)
	}
	fmt.Fprintf(out, "Took %d %s out of the state, and nothing out of the cloud:\n", len(plan.Removed), plural(len(plan.Removed), "resource", "resources"))
	rows = nil
	for _, r := range plan.Removed {
		rows = append(rows, []string{r.Name, r.Type, r.Why})
	}
	table(rows)
	if len(plan.Updates) > 0 {
		fmt.Fprintln(out, "Wrote what the state doesn't have, so the first `pulumi up` updates it in place, to what it already is in AWS:")
		for _, update := range plan.Updates {
			fmt.Fprintln(out, "  "+update)
		}
	}
	fmt.Fprintf(out, "Saved the state from before in %s.\n\n", rel(backup))

	fmt.Fprintln(out, "Next:")
	fmt.Fprintf(out, "  1. In the program, call ejected() from ./%s in place of SST's components,\n", strings.TrimSuffix(ModuleFile, ".ts"))
	fmt.Fprintln(out, "     and use the parts it returns where you used their outputs.")
	for _, use := range plan.Uses {
		fmt.Fprintln(out, "     "+use+".")
	}
	fmt.Fprintln(out, "  2. Take sst out of package.json, and run npm install.")
	if len(plan.Updates) > 0 {
		fmt.Fprintln(out, "  3. Run pulumi preview: it updates what's listed above, and changes nothing")
		fmt.Fprintln(out, "     else in the cloud.")
	} else {
		fmt.Fprintln(out, "  3. Run pulumi preview: it changes nothing in the cloud.")
	}
	fmt.Fprintln(out)
	fmt.Fprintf(out, "To go back before you deploy, run `pulumi stack import --file %s`,\n", rel(backup))
	fmt.Fprintf(out, "delete what sst eject wrote, and remove the stack's %s config.\n", ConfigNamespace)
}

// preview is what an eject would write and take out of the state
func preview(out io.Writer, plan *Plan, stage string) {
	fmt.Fprintf(out, "// %s\n%s", ModuleFile, plan.Module)
	if plan.Build != "" {
		fmt.Fprintf(out, "\n// %s\n%s", BuildFile, plan.Build)
	}
	fmt.Fprintln(out)
	for _, secret := range plan.Secrets {
		fmt.Fprintf(out, "Would put %s in the stack's config, as a secret.\n", secret.Key)
	}
	fmt.Fprintf(out, "Would take %d %s out of the %q stack's state:\n", len(plan.Removed), plural(len(plan.Removed), "resource", "resources"), stage)
	w := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
	for _, r := range plan.Removed {
		fmt.Fprintf(w, "  %s\t%s\t%s\n", r.Name, r.Type, r.Why)
	}
	w.Flush()
	for _, update := range plan.Updates {
		fmt.Fprintf(out, "Would update in place, to what it already is in AWS: %s.\n", update)
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
