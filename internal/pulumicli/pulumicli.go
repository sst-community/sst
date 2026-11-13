// Package pulumicli runs the developer's own Pulumi CLI in a Pulumi project,
// for what SST's CLI does in one: sst dev (pkg/pulumidev) and sst eject
// (pkg/eject). It knows nothing of SST's apps.
package pulumicli

import (
	"bytes"
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"

	"github.com/sst/sst/v3/internal/util"
	"github.com/sst/sst/v3/pkg/process"
	"gopkg.in/yaml.v3"
)

// Find is the pulumi on the PATH, or an error that says it isn't there, after
// what it's needed for, like "sst dev deploys a Pulumi project with the
// Pulumi CLI"
func Find(neededFor string) (string, error) {
	path, err := exec.LookPath("pulumi")
	if err != nil {
		return "", util.NewReadableError(err, neededFor+", and there's no pulumi on the PATH. Install it: https://www.pulumi.com/docs/iac/download-install/")
	}
	return path, nil
}

// Run runs pulumi in a folder, with what to read on its input, and returns
// what it printed, or an error with the first line of what it said went
// wrong, after the command: "pulumi stack export: ..."
func Run(cli, dir string, stdin io.Reader, args ...string) ([]byte, error) {
	cmd := process.Command(cli, append(args, "--non-interactive")...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "PULUMI_SKIP_UPDATE_CHECK=true")
	cmd.Stdin = stdin
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		message := strings.TrimPrefix(FirstLine(stderr.String()), "error: ")
		if message == "" {
			message = err.Error()
		}
		return nil, errors.New(command(args) + ": " + message)
	}
	return out, nil
}

// command is the pulumi command args run, without its flags and values:
// "pulumi stack export"
func command(args []string) string {
	words := []string{"pulumi"}
	for i, arg := range args {
		if i == 2 || strings.HasPrefix(arg, "-") {
			break
		}
		words = append(words, arg)
	}
	return strings.Join(words, " ")
}

// FirstLine is the first line of what a command printed that isn't empty,
// trimmed
func FirstLine(text string) string {
	for _, line := range strings.Split(text, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			return line
		}
	}
	return ""
}

// Project is what SST's CLI reads of a Pulumi project's Pulumi.yaml
type Project struct {
	Name string
	// Runtime is the language the program is in: the runtime's name, given
	// alone or with its options
	Runtime string
	// Main is the program's entry, from the project's folder, or "" for the
	// runtime's own
	Main string
}

// ReadProject reads a Pulumi project's Pulumi.yaml
func ReadProject(cfgPath string) (Project, error) {
	data, err := os.ReadFile(cfgPath)
	if err != nil {
		return Project{}, err
	}
	return ParseProject(data)
}

// ParseProject reads a Pulumi.yaml's text
func ParseProject(data []byte) (Project, error) {
	var parsed struct {
		Name    string    `yaml:"name"`
		Runtime yaml.Node `yaml:"runtime"`
		Main    string    `yaml:"main"`
	}
	if err := yaml.Unmarshal(data, &parsed); err != nil {
		return Project{}, err
	}
	project := Project{Name: parsed.Name, Main: parsed.Main}
	switch parsed.Runtime.Kind {
	case yaml.ScalarNode:
		project.Runtime = parsed.Runtime.Value
	case yaml.MappingNode:
		var named struct {
			Name string `yaml:"name"`
		}
		_ = parsed.Runtime.Decode(&named)
		project.Runtime = named.Name
	}
	return project, nil
}
