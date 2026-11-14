package cli

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/sst/sst/v3/pkg/project"
	"github.com/sst/sst/v3/pkg/pulumidev"
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

// SST 4's line runs a plain Pulumi program with sst pulumi dev, as SST 5's
// does: it runs none of either line's components
func TestPulumiProgramsOnSST4(t *testing.T) {
	onContract(t, 0)
	root, _ := filepath.EvalSymlinks(t.TempDir())
	touch(t, filepath.Join(root, "Pulumi.yaml"))
	t.Chdir(root)
	config := filepath.Join(root, "Pulumi.yaml")
	if got, err := pulumiDev().Discover(); err != nil || got != config {
		t.Fatalf("sst pulumi dev: got %q, %v", got, err)
	}
	if !pulumiDev().IsPulumiProgram() {
		t.Fatal("sst pulumi dev's project isn't a Pulumi program")
	}
	if _, err := cliFor("dev").Discover(); !errors.Is(err, pulumidev.ErrCommand) {
		t.Fatalf("sst dev: got %v", err)
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
