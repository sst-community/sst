package main

import (
	"reflect"
	"testing"

	"github.com/sst/sst/v3/cmd/sst/cli"
	"github.com/sst/sst/v3/pkg/project"
)

// The CLI speaks the contract of the platform it embeds, SST 4's or SST 5's,
// so a project loads
func TestSpeaksItsPlatformsContract(t *testing.T) {
	manifest, err := project.EmbeddedManifest()
	if err != nil {
		t.Fatal(err)
	}
	contract, err := project.ContractFor(manifest)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("the platform speaks contract %d", contract.Version())
}

// Each line's commands. SST 4's are 4.25.0's, but `cert`, which the 5.0
// rewrite took out with the Console's local connection
// (docs/plans/shared-core/plan.md).
func TestCommandsForEachContract(t *testing.T) {
	names := func(contract int) []string {
		found := []string{}
		for _, command := range cli.Commands(root.Children, contract) {
			found = append(found, command.Name)
		}
		return found
	}
	sst4 := []string{"init", "ui", "dev", "deploy", "diff", "add", "install", "secret", "shell", "remove", "unlock", "version", "upgrade", "telemetry", "introspect", "print-and-not-quit", "refresh", "state", "tunnel", "diagnostic"}
	if got := names(0); !reflect.DeepEqual(got, sst4) {
		t.Errorf("SST 4's line has\n%v\nnot\n%v", got, sst4)
	}
	sst5 := []string{"init", "ui", "dev", "deploy", "diff", "migrate", "add", "install", "secret", "shell", "remove", "unlock", "version", "target", "upgrade", "telemetry", "introspect", "build-server", "eject", "pulumi", "print-and-not-quit", "refresh", "state", "tunnel", "diagnostic"}
	if got := names(1); !reflect.DeepEqual(got, sst5) {
		t.Errorf("SST 5's line has\n%v\nnot\n%v", got, sst5)
	}
}
