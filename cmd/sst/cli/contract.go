package cli

import (
	"sync"

	"github.com/sst/sst/v3/pkg/project"
	"github.com/sst/sst/v3/pkg/pulumidev"
)

// The components the CLI's platform has decide which of the CLI's commands it
// has (Command.Contract): moving a stage to SST 5's components, ejecting
// them and targets are SST 5's, and a CLI built with SST 4's platform runs
// SST 4's commands. sst pulumi dev runs none of either's components, so both
// lines have it.

// platformContract is the version of the program contract the CLI's platform
// speaks, as its manifest says. A manifest that can't be read, or doesn't
// state its contract, counts as the oldest's, so none of SST 5's commands are
// offered: loading a project says what's wrong with it.
var platformContract = sync.OnceValue(func() int {
	manifest, err := project.EmbeddedManifest()
	if err != nil || manifest == nil || manifest.Contract == nil {
		return 0
	}
	return *manifest.Contract
})

// PlatformContract is the version of the program contract the CLI's platform
// speaks
func PlatformContract() int {
	return platformContract()
}

// Commands are the commands a platform that speaks contract has, with their
// children
func Commands(commands []*Command, contract int) []*Command {
	kept := []*Command{}
	for _, command := range commands {
		if command.Contract > contract {
			continue
		}
		if len(command.Children) > 0 {
			copied := *command
			copied.Children = Commands(command.Children, contract)
			command = &copied
		}
		kept = append(kept, command)
	}
	return kept
}

// isPulumiProgram is whether cfgPath is a plain Pulumi program's Pulumi.yaml,
// which sst pulumi dev runs
func isPulumiProgram(cfgPath string) bool {
	return pulumidev.IsProgram(cfgPath)
}
