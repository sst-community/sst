package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
	"github.com/sst/sst/v3/cmd/sst/cli"
	"github.com/sst/sst/v3/cmd/sst/mosaic/ui"
	"github.com/sst/sst/v3/internal/util"
	"github.com/sst/sst/v3/pkg/bus"
	"github.com/sst/sst/v3/pkg/move"
	"github.com/sst/sst/v3/pkg/project"
	"github.com/sst/sst/v3/pkg/server"
	"golang.org/x/sync/errgroup"
)

var CmdMigrate = &cli.Command{
	Name: "migrate",
	Description: cli.Description{
		Short: "Move a stage to new components",
		Long: strings.Join([]string{
			"Move a stage deployed with SST 4 to the components in your `sst.config.ts`.",
			"",
			"With `--check`, it previews the move and changes nothing. It shows what the move keeps, what it updates in place, and anything else it would do, and it fails when the move would do something it may not:",
			"",
			"- delete or replace a resource that holds data, like a bucket, a table, a database or a log group;",
			"- create, delete or replace a resource no component's state map lists.",
			"",
			"```bash frame=\"none\"",
			"sst migrate --check --stage dev",
			"```",
			"",
			"Without `--check`, it moves the stage. It checks the move first, and stops there if the check fails. Then it saves a copy of the stage's state in its home, takes out of the state what the components' state maps release, without deleting it, and deploys:",
			"",
			"```bash frame=\"none\"",
			"sst migrate --stage dev",
			"```",
			"",
			"A resource is released when the one that takes its place can't be carried over from it, like a site's files, which SST now uploads with a resource of a new type. The new one writes the same thing again.",
		}, "\n"),
	},
	Flags: []cli.Flag{
		{
			Name: "check",
			Type: "bool",
			Description: cli.Description{
				Short: "Preview the move",
				Long:  "Preview the move and check it, without changing anything.",
			},
		},
		{
			Name: "dev",
			Type: "bool",
			Description: cli.Description{
				Short: "Move the stage as sst dev deploys it",
				Long:  "Check or move the stage as `sst dev` deploys it, with a stub in place of each function.",
			},
		},
		{
			Name: "json",
			Type: "bool",
			Description: cli.Description{
				Short: "Output as JSON",
				Long:  "Output what the move would do as JSON to stdout. Only with `--check`.",
			},
		},
	},
	Examples: []cli.Example{
		{
			Content: "sst migrate --check --stage production",
			Description: cli.Description{
				Short: "Check what moving production would do",
			},
		},
		{
			Content: "sst migrate --stage production",
			Description: cli.Description{
				Short: "Move production",
			},
		},
	},
	Run: func(c *cli.Cli) error {
		moving := !c.Bool("check")
		jsonOutput := c.Bool("json")
		if moving && jsonOutput {
			return util.NewReadableError(nil, "`--json` goes with `--check`: it prints what a move would do.")
		}

		p, err := c.InitProject()
		if err != nil {
			return err
		}
		defer p.Cleanup()

		// One server and one UI for the check and the move: stopping the
		// server cancels the command's context, so it's stopped once, at the
		// end
		var wg errgroup.Group
		uiOptions := []ui.Option{}
		if jsonOutput {
			uiOptions = append(uiOptions, ui.WithSilent)
		}
		u := ui.New(c.Context, uiOptions...)
		defer u.Destroy()
		s, err := server.New()
		if err != nil {
			return err
		}
		wg.Go(func() error {
			defer c.Cancel()
			return s.Start(c.Context, p)
		})
		events := bus.SubscribeAll()
		if !jsonOutput {
			wg.Go(func() error {
				for evt := range events {
					u.Event(evt)
				}
				return nil
			})
		}
		finish := func(err error) error {
			bus.Unsubscribe(events)
			close(events)
			c.Cancel()
			if waitErr := wg.Wait(); waitErr != nil && err == nil {
				return waitErr
			}
			return err
		}

		result, err := checkMove(c, p, s.URL())
		if err != nil {
			return finish(err)
		}
		if jsonOutput {
			encoder := json.NewEncoder(os.Stdout)
			encoder.SetIndent("", "  ")
			if err := encoder.Encode(result); err != nil {
				return finish(err)
			}
		} else {
			renderMove(result, u)
		}
		if !result.OK() {
			unchanged := ""
			if moving {
				unchanged = " Nothing was changed."
			}
			return finish(util.NewReadableError(nil, fmt.Sprintf("The stage can't move as it is: %v.%v", count(len(result.Problems), "change a move may not make", "changes a move may not make"), unchanged)))
		}
		if !moving {
			return finish(nil)
		}

		// The move the check passed. Under the deploy's lock, the state is
		// saved and what the maps release is marked retained, so it leaves the
		// state without its delete, and the components apply their maps.
		released := []project.Released{}
		for _, r := range result.Released {
			released = append(released, project.Released{URN: r.URN, Type: r.Type})
		}
		return finish(p.Run(c.Context, &project.StackInput{
			Command: "deploy",
			Move:    true,
			Release: released,
			Dev:     c.Bool("dev"),
			Server:  s.URL(),
			Verbose: c.Bool("verbose"),
		}))
	},
}

// checkMove runs Pulumi's preview of the move and sorts its steps. It reads
// the steps and the reported parts from a subscription of its own: the UI's
// drops events when it falls behind, and a step lost would be a change the
// check didn't see.
func checkMove(c *cli.Cli, p *project.Project, server string) (*move.Result, error) {
	steps := []apitype.StepEventMetadata{}
	parts := []move.Part{}
	var summary *apitype.SummaryEvent
	collected := bus.Subscribe(&apitype.ResOutputsEvent{}, &move.Part{}, &apitype.SummaryEvent{})
	collect := func(evt interface{}) {
		switch evt := evt.(type) {
		case *apitype.ResOutputsEvent:
			steps = append(steps, evt.Metadata)
		case *move.Part:
			parts = append(parts, *evt)
		case *apitype.SummaryEvent:
			summary = evt
		}
	}
	stop := make(chan struct{})
	collecting := make(chan struct{})
	go func() {
		defer close(collecting)
		for {
			select {
			case evt := <-collected:
				collect(evt)
			case <-stop:
				// What's left once nothing more is published
				for {
					select {
					case evt := <-collected:
						collect(evt)
					default:
						return
					}
				}
			}
		}
	}()
	err := p.Run(c.Context, &project.StackInput{
		Command: "diff",
		Move:    true,
		Server:  server,
		Dev:     c.Bool("dev"),
		Verbose: c.Bool("verbose"),
	})
	lost := droppedFrom(collectedLabel)
	bus.Unsubscribe(collected)
	close(stop)
	<-collecting
	if err != nil {
		return nil, err
	}
	if lost > 0 {
		return nil, util.NewReadableError(nil, "Some of the preview's events were lost, so the move can't be checked. Run it again.")
	}
	if err := move.Seen(steps, summary); err != nil {
		return nil, util.NewReadableError(err, "The move can't be checked: "+err.Error()+". Run it again.")
	}
	return move.Check(steps, parts), nil
}

func renderMove(result *move.Result, u *ui.UI) {
	moved, updated := 0, 0
	for _, kept := range result.Kept {
		if kept.From != "" {
			moved++
		}
		if len(kept.Fields) > 0 {
			updated++
		}
	}
	line := func(number int, what string) {
		fmt.Println(ui.TEXT_NORMAL_BOLD.Render(fmt.Sprintf("%6d", number)) + "  " + what)
	}
	fmt.Println(ui.TEXT_HIGHLIGHT_BOLD.Render("➜") + "  " + ui.TEXT_NORMAL_BOLD.Render("The move"))
	fmt.Println()
	line(len(result.Kept), fmt.Sprintf("kept, %v at a new address and %v updated in place", moved, updated))
	line(len(result.Left), "taken out of the state, with nothing in the cloud behind them")
	line(len(result.Released), "released: taken out of the state without being deleted")
	line(len(result.Created), "created")
	line(len(result.Replaced), "replaced")
	fmt.Println()

	for _, kept := range result.Kept {
		if len(kept.Fields) == 0 {
			continue
		}
		fmt.Println(ui.TEXT_WARNING_BOLD.Render("*") + "  " + ui.TEXT_NORMAL_BOLD.Render(u.FormatURN(kept.URN)))
		fmt.Println("   " + ui.TEXT_DIM.Render("Updated in place: "+strings.Join(kept.Fields, ", ")))
	}
	changes := func(icon string, list []move.Change) {
		for _, change := range list {
			fmt.Println(icon + "  " + ui.TEXT_NORMAL_BOLD.Render(u.FormatURN(change.URN)))
			fmt.Println("   " + ui.TEXT_DIM.Render(change.Why))
		}
	}
	changes(ui.TEXT_DIM_BOLD.Render("-"), result.Released)
	changes(ui.TEXT_SUCCESS_BOLD.Render("+"), result.Created)
	changes(ui.TEXT_WARNING_BOLD.Render("±"), result.Replaced)
	for _, problem := range result.Problems {
		fmt.Println(ui.TEXT_DANGER_BOLD.Render("✕") + "  " + ui.TEXT_NORMAL_BOLD.Render(u.FormatURN(problem.URN)) + ui.TEXT_DANGER.Render(" would be "+done(problem.Does)))
		fmt.Println("   " + problem.Why)
	}
	if result.OK() {
		fmt.Println()
		fmt.Println(ui.TEXT_SUCCESS_BOLD.Render("✓") + "  " + ui.TEXT_NORMAL_BOLD.Render("The stage can move."))
	}
	fmt.Println()
}

func done(does string) string {
	switch does {
	case "create":
		return "created"
	case "delete":
		return "deleted"
	case "replace":
		return "replaced"
	case "update":
		return "updated"
	}
	return does
}

func count(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return fmt.Sprintf("%v %v", n, many)
}

// The label of the check's own subscription on the bus
const collectedLabel = "*apitype.ResOutputsEvent,*move.Part,*apitype.SummaryEvent"

// How many events a subscription on the bus has lost
func droppedFrom(label string) uint64 {
	for _, stat := range bus.Stats() {
		if stat.Label == label {
			return stat.Dropped
		}
	}
	return 0
}
