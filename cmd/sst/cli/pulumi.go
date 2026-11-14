package cli

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/briandowns/spinner"
	"github.com/sst/sst/v3/internal/util"
	"github.com/sst/sst/v3/pkg/project"
	"github.com/sst/sst/v3/pkg/pulumidev"
	"golang.org/x/term"
)

// What the CLI does for a plain Pulumi program, which only sst pulumi dev
// runs (pkg/pulumidev), in place of an SST app. sst dev runs an SST app
// alone.

// isPulumiDev is whether the command is sst pulumi dev
func (c *Cli) isPulumiDev() bool {
	return len(c.path) >= 2 && c.path[len(c.path)-2].Name == "pulumi" && c.command() == "dev"
}

// DevCommand is the command that runs the dev loop, as its panes run it
// again: dev, or pulumi dev for a Pulumi project
func (c *Cli) DevCommand() []string {
	if c.isPulumiDev() {
		return []string{"pulumi", "dev"}
	}
	return []string{"dev"}
}

// discoverPulumi is the Pulumi.yaml sst pulumi dev runs: the one named with
// --config, or the nearest one up from the working folder, in an SST app's
// folder or not, as it's asked for by name
func (c *Cli) discoverPulumi() (string, error) {
	cfgPath := c.String("config")
	if cfgPath == "" {
		return pulumidev.Discover()
	}
	abs, err := filepath.Abs(cfgPath)
	if err != nil {
		return "", util.NewReadableError(err, "Could not find "+cfgPath)
	}
	if _, err := os.Stat(abs); err != nil {
		return "", util.NewReadableError(err, "Could not find "+abs)
	}
	if !pulumidev.IsProgram(abs) {
		return "", util.NewReadableError(nil, "sst pulumi dev runs a Pulumi project: --config names its Pulumi.yaml.")
	}
	return abs, nil
}

// IsPulumiProgram is whether the command runs in a plain Pulumi program, as
// Discover would find it, without what Discover does to an SST app's folder.
// SST's own pulumi and bun, which only an SST app uses, aren't installed for
// one: it runs the pulumi on the PATH.
func (c *Cli) IsPulumiProgram() bool {
	if c.isPulumiDev() {
		_, err := c.discoverPulumi()
		return err == nil
	}
	if cfgPath := c.String("config"); cfgPath != "" {
		return pulumidev.IsProgram(cfgPath)
	}
	if hasSSTConfig() {
		return false
	}
	_, err := pulumidev.Discover()
	return err == nil
}

// command is the name of the command that runs, like dev
func (c *Cli) command() string {
	return c.path[len(c.path)-1].Name
}

// pulumiStack is the stack named with --stage or SST_STAGE, as it's named,
// which can be with its organization and project, or "" for none
func (c *Cli) pulumiStack() string {
	if stack := c.String("stage"); stack != "" {
		return stack
	}
	return os.Getenv("SST_STAGE")
}

// pulumiStage is a Pulumi project's stage: the stack named, or the one
// selected, by its name alone. No .env file is read for it, as pulumi runs
// with the shell's environment.
func (c *Cli) pulumiStage(cfgPath string) (string, error) {
	stack := c.pulumiStack()
	if stack == "" {
		var err error
		if stack, err = pulumidev.SelectedStack(cfgPath); err != nil {
			return "", err
		}
	}
	return pulumidev.StageOf(stack), nil
}

// initPulumi loads a Pulumi project for sst pulumi dev. pulumi runs with the shell's
// environment, as it would without SST: the .env file the CLI read as it
// started is put back, and the project's isn't read.
func (c *Cli) initPulumi(cfgPath string) (project.Program, error) {
	slog.Info("initializing pulumi program", "version", c.version)
	restoreEnv(c.env)
	program, err := pulumidev.New(cfgPath, c.pulumiStack(), c.version)
	if errors.Is(err, pulumidev.ErrNoDevFile) && term.IsTerminal(int(os.Stdin.Fd())) && term.IsTerminal(int(os.Stdout.Fd())) {
		if offerErr := c.offerDevFile(cfgPath, err); offerErr != nil {
			return nil, offerErr
		}
		program, err = pulumidev.New(cfgPath, c.pulumiStack(), c.version)
	}
	if err != nil {
		return nil, err
	}
	c.loaded(program.Stage(), program.NodeVersion())
	if err := c.logTo(program.PathLog("")); err != nil {
		return nil, err
	}

	// The platform's files have the stub and what the runtimes run a
	// function's code with
	if !project.PlatformCurrent(program.PathPlatformDir(), c.version) {
		spin := spinner.New(spinner.CharSets[14], 100*time.Millisecond, spinner.WithWriterFile(os.Stderr))
		spin.Color("cyan")
		spin.Suffix = "  Upgrading project..."
		spin.Start()
		err := project.CopyPlatformTo(program.PathPlatformDir(), c.version)
		spin.Stop()
		if err != nil {
			return nil, util.NewReadableError(err, "Could not copy platform code to project directory")
		}
	}

	if err := program.Load(); err != nil {
		return nil, err
	}
	slog.Info("loaded pulumi program", "app", program.Name(), "stage", program.Stage())
	return program, nil
}

// offerDevFile offers to write a first DevFile for a program that has none,
// from a preview of its stack, and shows it, to start sst pulumi dev with. missing
// is the error for the file that isn't there.
func (c *Cli) offerDevFile(cfgPath string, missing error) error {
	fmt.Printf("There's no %s next to Pulumi.yaml, which says what sst pulumi dev runs.\n", pulumidev.DevFile)
	if !ask("Write one from a preview of the stack? (Y/n): ") {
		return missing
	}
	spin := spinner.New(spinner.CharSets[14], 100*time.Millisecond, spinner.WithWriterFile(os.Stderr))
	spin.Color("cyan")
	spin.Suffix = "  Previewing the stack..."
	spin.Start()
	written, err := pulumidev.WriteDevFile(c.Context, cfgPath, c.pulumiStack())
	spin.Stop()
	if err != nil {
		return err
	}
	fmt.Println()
	fmt.Println(written.Text)
	path := written.Path
	if cwd, err := os.Getwd(); err == nil {
		if rel, err := filepath.Rel(cwd, path); err == nil {
			path = rel
		}
	}
	summary := fmt.Sprintf("Wrote %s: %d %s to run on this machine", path, written.Here, plural(written.Here, "function", "functions"))
	if len(written.Guessed) > 0 {
		summary += fmt.Sprintf(", %d guessed", len(written.Guessed))
	}
	if written.Cloud > 0 {
		summary += fmt.Sprintf(", and %d left in the cloud", written.Cloud)
	}
	fmt.Println(summary + ".")
	if !ask("Start sst pulumi dev with it? (Y/n): ") {
		return util.NewReadableError(nil, "Run sst pulumi dev again when "+pulumidev.DevFile+" is ready.")
	}
	return nil
}

// ask asks a question to answer yes or no, which is yes unless it's no
func ask(question string) bool {
	fmt.Print(question)
	var response string
	fmt.Scanln(&response)
	response = strings.ToLower(strings.TrimSpace(response))
	return response == "" || response == "y" || response == "yes"
}

func plural(count int, one, many string) string {
	if count == 1 {
		return one
	}
	return many
}

// restoreEnv makes the process's environment env again
func restoreEnv(env []string) {
	os.Clearenv()
	for _, entry := range env {
		if key, value, ok := strings.Cut(entry, "="); ok && key != "" {
			os.Setenv(key, value)
		}
	}
}
