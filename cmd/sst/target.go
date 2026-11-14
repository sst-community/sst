package main

import (
	"context"
	"fmt"
	"strings"

	"github.com/fatih/color"
	"github.com/sst/sst/v3/cmd/sst/cli"
	"github.com/sst/sst/v3/internal/util"
	"github.com/sst/sst/v3/pkg/project"
	"github.com/sst/sst/v3/pkg/target"
)

var CmdTarget = &cli.Command{
	// SST 5's alone
	Contract: 1,
	Name:     "target",
	Description: cli.Description{
		Short: "Manage a stage's target",
		Long: strings.Join([]string{
			"Manage the target a stage is bound to in your `sst.config.ts`, like an emulator on this machine.",
			"",
			"The CLI starts a target's container when a command needs the stage, and stops it when `sst remove` leaves nothing deployed on it and no other command is running on it.",
			"",
			"```bash frame=\"none\"",
			"sst target stop --stage local",
			"```",
		}, "\n"),
	},
	Children: []*cli.Command{
		{
			Name: "stop",
			Description: cli.Description{
				Short: "Stop the target's container",
				Long: strings.Join([]string{
					"Stop the container of the stage's target. Its data is kept, and the next command on a stage bound to it starts it again. It's left running while another command is running on a stage bound to it.",
				}, "\n"),
			},
			Run: CmdTargetStop,
		},
		{
			Name: "reset",
			Description: cli.Description{
				Short: "Start the target over",
				Long: strings.Join([]string{
					"Remove the container of the stage's target and its data, and the state of every stage on it, of every app. The next command on a stage bound to it starts it new.",
					"",
					"Everything deployed on the target is gone. It asks first, and says which stages have something deployed. It's not reset while another command is running on a stage bound to it.",
					"",
					"```bash frame=\"none\"",
					"sst target reset --stage local",
					"```",
				}, "\n"),
			},
			Flags: []cli.Flag{
				{
					Name: "yes",
					Type: "bool",
					Description: cli.Description{
						Short: "Don't ask first",
						Long:  "Reset the target without asking first.",
					},
				},
			},
			Run: CmdTargetReset,
		},
	},
}

// stageTarget is the target the stage is bound to, read from the config
// without starting it
func stageTarget(c *cli.Cli) (*project.Project, *target.Local, error) {
	p, err := c.InitProjectWithoutHome()
	if err != nil {
		return nil, nil, err
	}
	local, ok := p.Target().(*target.Local)
	if !ok {
		p.Cleanup()
		return nil, nil, util.NewReadableError(nil, fmt.Sprintf("The %q stage isn't bound to a target, so its cloud calls go to the real cloud. A stage is bound to one in app(), under `targets`.", p.App().Stage))
	}
	return p, local, nil
}

func CmdTargetStop(c *cli.Cli) error {
	p, local, err := stageTarget(c)
	if err != nil {
		return err
	}
	defer p.Cleanup()
	stopped := false
	alone, err := local.Alone(func() (err error) {
		stopped, err = local.StopContainer(context.Background())
		return err
	})
	if err != nil {
		return util.NewReadableError(err, err.Error())
	}
	if !alone {
		return util.NewReadableError(nil, fmt.Sprintf("Another command is running on a stage bound to the %q target, so its container is left running. Stop it once that command is done.", local.Name()))
	}
	if !stopped {
		fmt.Printf("The %q target's container isn't running.\n", local.Name())
		return nil
	}
	color.New(color.FgGreen, color.Bold).Print("✓ ")
	color.New(color.FgWhite).Printf(" Stopped the %q target's container. Its data is kept.\n", local.Name())
	return nil
}

func CmdTargetReset(c *cli.Cli) error {
	p, local, err := stageTarget(c)
	if err != nil {
		return err
	}
	defer p.Cleanup()
	// A state that can't be read is no reason not to start over
	deployed, err := target.Deployed(local.Name())
	fmt.Printf("This removes the %q target's container and its data, and the state of every stage on it.\n", local.Name())
	if err != nil {
		fmt.Println("Some of its stages' state can't be read: " + err.Error())
	} else if len(deployed) == 0 {
		fmt.Println("No stage has anything deployed on it.")
	} else {
		fmt.Println("Everything deployed on it is gone, for these stages:")
		for _, stage := range deployed {
			fmt.Println("- " + stage)
		}
	}
	if !c.Bool("yes") {
		fmt.Print("Reset it? (y/N): ")
		var response string
		fmt.Scanln(&response)
		if strings.ToLower(strings.TrimSpace(response)) != "y" {
			fmt.Println("Not reset. To reset without being asked, pass --yes.")
			return nil
		}
	}
	alone, err := local.Alone(func() error { return local.Reset(context.Background()) })
	if err != nil {
		return util.NewReadableError(err, err.Error())
	}
	if !alone {
		return util.NewReadableError(nil, fmt.Sprintf("Another command is running on a stage bound to the %q target, so it's not reset. Reset it once that command is done.", local.Name()))
	}
	color.New(color.FgGreen, color.Bold).Print("✓ ")
	color.New(color.FgWhite).Printf(" Reset the %q target. The next command on a stage bound to it starts it new.\n", local.Name())
	return nil
}
