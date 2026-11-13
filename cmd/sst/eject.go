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
	Name: "eject",
	Description: cli.Description{
		Short: "Write a Pulumi program's SST components as Pulumi's own resources",
		Long: strings.Join([]string{
			"In a Pulumi program that uses SST's components, writes them as Pulumi's own resources, from the stack's state, so the program needs nothing of SST's.",
			"",
			"```bash frame=\"none\"",
			"sst eject --stage dev",
			"```",
			"",
			"It writes `sst-ejected.ts` beside `Pulumi.yaml`. Each of SST's components is a Pulumi component there, of the same type and name, and each of its parts is the same resource as before, with the inputs it was last deployed with, so every resource keeps its URN and nothing changes in the cloud. A secret input is put in the stack's config, under `sst-ejected`, and read from there.",
			"",
			"Then it takes SST's own resources out of the state, without deleting what they made: a site's files and its key-value entries stay as last deployed. A function keeps the code SST last built, in the asset bucket. For a function on Node.js, it writes `sst-ejected-build.ts`, a build with esbuild a function can be switched to.",
			"",
			"It saves the stack's state from before in a file beside `Pulumi.yaml` first, and says what to change in the program. It doesn't change the program itself.",
			"",
			"With `--dry-run`, it prints what it would write and take out of the state, and changes nothing.",
			"",
			"It ejects one stack, and refuses a stack it can't eject without a change in the cloud, like one last deployed by `sst dev`.",
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
