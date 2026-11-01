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
			"Moving the stage itself, without `--check`, isn't built yet.",
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
				Short: "Check the stage as sst dev deploys it",
				Long:  "Check the move of the stage as `sst dev` deploys it, with a stub in place of each function.",
			},
		},
		{
			Name: "json",
			Type: "bool",
			Description: cli.Description{
				Short: "Output as JSON",
				Long:  "Output what the move would do as JSON to stdout.",
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
	},
	Run: func(c *cli.Cli) error {
		if !c.Bool("check") {
			return util.NewReadableError(nil, "Moving a stage isn't built yet. Run `sst migrate --check` to see what a move would do.")
		}
		jsonOutput := c.Bool("json")

		p, err := c.InitProject()
		if err != nil {
			return err
		}
		defer p.Cleanup()

		var wg errgroup.Group
		steps := []apitype.StepEventMetadata{}
		parts := []move.Part{}
		var summary *apitype.SummaryEvent
		uiOptions := []ui.Option{}
		if jsonOutput {
			uiOptions = append(uiOptions, ui.WithSilent)
		}
		u := ui.New(c.Context, uiOptions...)
		s, err := server.New()
		if err != nil {
			return err
		}
		wg.Go(func() error {
			defer c.Cancel()
			return s.Start(c.Context, p)
		})

		// The check reads the preview's steps and the reported parts from a
		// subscription of its own: the UI's drops events when it falls behind,
		// and a step lost would be a change the check didn't see.
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
		events := bus.SubscribeAll()
		if !jsonOutput {
			wg.Go(func() error {
				for evt := range events {
					u.Event(evt)
				}
				return nil
			})
		}
		defer u.Destroy()
		err = p.Run(c.Context, &project.StackInput{
			Command: "diff",
			Move:    true,
			Server:  s.URL(),
			Dev:     c.Bool("dev"),
			Verbose: c.Bool("verbose"),
		})
		lost := droppedFrom(collectedLabel)
		bus.Unsubscribe(collected)
		close(stop)
		<-collecting
		bus.Unsubscribe(events)
		close(events)
		c.Cancel()
		if waitErr := wg.Wait(); waitErr != nil && err == nil {
			err = waitErr
		}
		if err != nil {
			return err
		}
		if lost > 0 {
			return util.NewReadableError(nil, "Some of the preview's events were lost, so the move can't be checked. Run it again.")
		}
		if err := move.Seen(steps, summary); err != nil {
			return util.NewReadableError(err, "The move can't be checked: "+err.Error()+". Run it again.")
		}

		result := move.Check(steps, parts)
		if jsonOutput {
			encoder := json.NewEncoder(os.Stdout)
			encoder.SetIndent("", "  ")
			if err := encoder.Encode(result); err != nil {
				return err
			}
		} else {
			renderMove(result, u)
		}
		if !result.OK() {
			return util.NewReadableError(nil, fmt.Sprintf("The stage can't move as it is: %v.", count(len(result.Problems), "change a move may not make", "changes a move may not make")))
		}
		return nil
	},
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
