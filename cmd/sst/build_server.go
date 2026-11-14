package main

import (
	"os"

	"github.com/sst/sst/v3/cmd/sst/cli"
	"github.com/sst/sst/v3/internal/util"
	"github.com/sst/sst/v3/pkg/pulumidev"
	"github.com/sst/sst/v3/pkg/server"
)

// CmdBuildServer is run by a Pulumi program that uses SST's components
// without SST's CLI, from the project's folder, to build its functions
// (pkg/server ServeBuilds). The program gives it the sst package's platform
// folder in SST_PLATFORM_DIR. It's hidden: nobody runs it by hand.
var CmdBuildServer = &cli.Command{
	// SST 5's alone
	Contract: 1,
	Name:     "build-server",
	Hidden:   true,
	Run: func(c *cli.Cli) error {
		cfgPath, err := pulumidev.Discover()
		if err != nil {
			return util.NewReadableError(err, "sst build-server runs in the folder of a Pulumi project, and there's no Pulumi.yaml here or above.")
		}
		return server.ServeBuilds(c.Context, cfgPath, os.Getenv("SST_PLATFORM_DIR"), version, os.Stdin, os.Stdout)
	},
}
