package main

import (
	"os"
	"strings"

	"github.com/sst/sst/v3/cmd/sst/cli"
	"github.com/sst/sst/v3/internal/util"
	"github.com/sst/sst/v3/pkg/eject"
	"github.com/sst/sst/v3/pkg/pulumidev"
)

var CmdEject = &cli.Command{
	// SST 5's alone
	Contract: 1,
	Name:     "eject",
	Description: cli.Description{
		Short: "Write a Pulumi program's SST components as Pulumi's own resources",
		Long: strings.Join([]string{
			"In a Pulumi program that uses SST's components, writes them as Pulumi's own resources, from the state of the project's stacks, so the program needs nothing of SST's.",
			"",
			"```bash frame=\"none\"",
			"sst eject",
			"```",
			"",
			"It writes `sst-ejected.ts` beside `Pulumi.yaml`, one program for every stack with SST's components in it. Each of SST's components is a Pulumi component there, of the same type and name, and each of its parts is the same resource as before, with the inputs it was last deployed with, so every resource keeps its URN and nothing changes in the cloud. A secret input, and a value that isn't the same in every stack, like a resource's name, is put in each stack's config, under `sst-ejected`, and read from there. A value with a reference in it that isn't the same is picked by stack, and what only some stacks have is made only on those.",
			"",
			"Then it takes SST's own resources out of each stack's state, without deleting what they made: a site's files and a router's routes stay as last deployed. What `addEnvironment` added to a function goes in its environment, which the first `pulumi up` updates in place to what it already is. A function keeps the code SST last built, in the asset bucket. For a function on Node.js, it writes `sst-ejected-build.ts`, a build with esbuild a function can be switched to.",
			"",
			"It saves each stack's state from before in a file beside `Pulumi.yaml` first, and says what to change in the program. It doesn't change the program itself.",
			"",
			"With `--dry-run`, it prints what it would write and take out of the state, and changes nothing.",
			"",
			"It ejects every stack of the project together, and refuses if it can't eject one without a change in the cloud, like a stack last deployed by `sst dev`.",
		}, "\n"),
	},
	Flags: []cli.Flag{
		{
			Name: "dry-run",
			Type: "bool",
			Description: cli.Description{
				Short: "Print what it would do, and change nothing",
				Long:  "Print the module it would write and what it would take out of the state, and change nothing.",
			},
		},
	},
	Run: func(c *cli.Cli) error {
		if !c.IsPulumiProgram() {
			return util.NewReadableError(nil, "sst eject is for a Pulumi program that uses SST's components, run in its folder, and there's no Pulumi.yaml here or above.")
		}
		cfgPath := c.String("config")
		if cfgPath == "" {
			var err error
			if cfgPath, err = pulumidev.Discover(); err != nil {
				return err
			}
		}
		return eject.Run(c.Context, cfgPath, c.String("stage"), c.Bool("dry-run"), os.Stdout)
	},
}
