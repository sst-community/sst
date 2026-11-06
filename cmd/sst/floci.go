package main

import (
	"fmt"
	"os"
	"strings"

	"github.com/sst/sst/v3/cmd/sst/cli"
	"github.com/sst/sst/v3/pkg/floci"
)

var CmdFloci = &cli.Command{
	Name:        "floci",
	Description: cli.Description{Short: "Manage the local Floci AWS emulator"},
	Run:         func(c *cli.Cli) error { return startFloci(c) },
	Children: []*cli.Command{
		{Name: "install", Description: cli.Description{Short: "Pull the pinned Floci Docker image"}, Run: func(c *cli.Cli) error { return floci.Install(c.Context) }},
		{Name: "start", Description: cli.Description{Short: "Start Floci with persistent local storage"}, Run: startFloci},
		{Name: "stop", Description: cli.Description{Short: "Stop Floci and retain its data"}, Run: func(c *cli.Cli) error { return floci.Stop(c.Context) }},
		{Name: "status", Description: cli.Description{Short: "Check Floci readiness and version"}, Run: func(c *cli.Cli) error {
			if err := floci.Status(c.Context); err != nil {
				return err
			}
			fmt.Println("Floci", floci.Version, "is ready")
			return nil
		}},
		{Name: "reset", Description: cli.Description{Short: "Delete all managed Floci data and local stage state"}, Run: func(c *cli.Cli) error {
			if os.Getenv("SST_FLOCI_ENDPOINT") != "" {
				if c.String("stage") == "" {
					return fmt.Errorf("custom endpoints require reset --stage <stage> for local state recovery")
				}
				fmt.Printf("Delete local Floci state for stage %s? The custom emulator is unchanged. Type reset to continue: ", c.String("stage"))
			} else {
				fmt.Print("Delete ALL managed Floci resources? Other stages will need recovery. Type reset to continue: ")
			}
			var response string
			if _, err := fmt.Scanln(&response); err != nil {
				return fmt.Errorf("reset cancelled: %w", err)
			}
			if strings.TrimSpace(response) != "reset" {
				return fmt.Errorf("reset cancelled")
			}
			return floci.Reset(c.Context, c.String("stage"))
		}},
	},
}

func startFloci(c *cli.Cli) error {
	cfg, err := floci.Ensure(c.Context)
	if err != nil {
		return err
	}
	fmt.Printf("Floci %s ready at %s\nProfile image: %s\n", floci.Version, cfg.Endpoint, floci.Image)
	return nil
}
