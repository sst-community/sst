package cli

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/sst/sst/v3/pkg/project"
)

// The package's tests are of SST 5's commands, whichever platform this build
// has; onContract runs one on another
func TestMain(m *testing.M) {
	platformContract = func() int { return project.ContractVersion }
	os.Exit(m.Run())
}

func onContract(t *testing.T, contract int) {
	t.Helper()
	platformContract = func() int { return contract }
	t.Cleanup(func() { platformContract = func() int { return project.ContractVersion } })
}

// SST 4's platform has no plain Pulumi programs: sst dev doesn't find one, and
// a Pulumi.yaml given with --config isn't one
func TestNoPulumiProgramsOnSST4(t *testing.T) {
	onContract(t, 0)
	root, _ := filepath.EvalSymlinks(t.TempDir())
	touch(t, filepath.Join(root, "Pulumi.yaml"))
	t.Chdir(root)
	if _, err := cliFor("dev").Discover(); err == nil {
		t.Fatal("sst dev found a Pulumi program")
	}
	if cliFor("dev").IsPulumiProgram() {
		t.Fatal("it's a Pulumi program")
	}
	config := filepath.Join(root, "Pulumi.yaml")
	if got, err := cliFor("dev", "config", config).Discover(); err != nil || got != config {
		t.Fatalf("got %q, %v", got, err)
	}
	if isPulumiProgram(config) {
		t.Fatal("--config's Pulumi.yaml is a Pulumi program")
	}
}

func TestCommands(t *testing.T) {
	commands := []*Command{
		{Name: "deploy"},
		{Name: "migrate", Contract: 1},
		{Name: "state", Children: []*Command{{Name: "export"}, {Name: "adopt", Contract: 1}}},
	}
	names := func(commands []*Command) []string {
		found := []string{}
		for _, command := range commands {
			found = append(found, command.Name)
			for _, child := range command.Children {
				found = append(found, command.Name+" "+child.Name)
			}
		}
		return found
	}
	if got := names(Commands(commands, 0)); len(got) != 3 || got[0] != "deploy" || got[1] != "state" || got[2] != "state export" {
		t.Fatalf("contract 0 has %v", got)
	}
	if got := names(Commands(commands, 1)); len(got) != 5 {
		t.Fatalf("contract 1 has %v", got)
	}
	// the tree it's given stays as it was
	if len(commands[2].Children) != 2 {
		t.Fatal("the children were changed")
	}
}
