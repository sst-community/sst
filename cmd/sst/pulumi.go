package main

import (
	"strings"

	"github.com/sst/sst/v3/cmd/sst/cli"
)

// CmdPulumi is what SST does for a plain Pulumi project: its dev loop, under
// a name of its own, so `sst dev` means an SST app's alone
var CmdPulumi = &cli.Command{
	// SST 5's alone
	Contract: 1,
	Name:     "pulumi",
	Description: cli.Description{
		Short: "Run a plain Pulumi project with SST's dev loop",
		Long: strings.Join([]string{
			"SST's dev loop for a plain Pulumi project, which [Use with Pulumi](/docs/use-with-pulumi) covers. SST runs the local dev loop, and Pulumi does everything else.",
		}, "\n"),
	},
	Children: []*cli.Command{
		{
			Name: "dev",
			Description: cli.Description{
				Short: "Run a Pulumi project in dev mode",
				Long: strings.Join([]string{
					"Runs the Pulumi project the working folder is in, the one with the nearest `Pulumi.yaml`, in dev mode.",
					"",
					"```bash frame=\"none\"",
					"sst pulumi dev",
					"```",
					"",
					"- It deploys a dev stack with your own `pulumi up`, and deploys again when a file of the program changes. The stack is the one named with `--stage`, or else the one selected in the project, and it has to opt in with `pulumi config set sst:dev true`.",
					"- The functions `sst.dev.yaml` names run on your machine, from their source.",
					"- Its dev commands run beside it, each in a pane of its own, with the stack's outputs in their environment.",
					"",
					"The program imports `sst/pulumi` first, which does nothing outside `sst pulumi dev`.",
					"",
					"Name a `Pulumi.yaml` elsewhere with `--config`, as from an SST app's folder.",
					"",
					"```bash frame=\"none\"",
					"sst pulumi dev --config infra/Pulumi.yaml",
					"```",
					"",
					"`--mode` runs it as `sst dev`'s does, and `--policy` gives each `pulumi up` a policy pack.",
				}, "\n"),
			},
			Flags: []cli.Flag{
				{
					Name: "mode",
					Type: "string",
					Description: cli.Description{
						Short: "mode=mono to turn off multiplexer. mode=basic to not spawn any child processes",
						Long:  "Defaults to using `multi` mode. Use `mono` to get a single stream of all child process logs or `basic` to not spawn any child processes.",
					},
				},
				{
					Name: "policy",
					Type: "string",
					Description: cli.Description{
						Short: "Path to policy pack",
						Long:  "Run policy pack validation against the preview changes.",
					},
				},
			},
			Args: []cli.Argument{
				{
					Name: "command",
					Description: cli.Description{
						Short: "The command to run",
					},
				},
			},
			Examples: []cli.Example{
				{
					Content: "sst pulumi dev",
					Description: cli.Description{
						Short: "Runs the Pulumi project in dev mode",
					},
				},
				{
					Content: "sst pulumi dev --stage dev-alice",
					Description: cli.Description{
						Short: "Runs it on a stack of your own",
					},
				},
			},
			Run: CmdMosaic,
		},
	},
}
