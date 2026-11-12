package main

import (
	"fmt"

	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
	"github.com/sst/sst/v3/cmd/sst/cli"
	"github.com/sst/sst/v3/cmd/sst/mosaic/ui"
)

// runUndo puts a stage that moved back on SST 4 (project.Undo), and says
// what to do next
func runUndo(c *cli.Cli) error {
	p, err := c.InitProject()
	if err != nil {
		return err
	}
	defer p.Cleanup()
	undone, err := p.Undo(c.Context)
	if err != nil {
		return err
	}

	line := func(text string) { fmt.Println("   " + ui.TEXT_DIM.Render(text)) }
	list := func(urns []resource.URN) {
		for i, urn := range urns {
			if i == 10 {
				line(fmt.Sprintf("  and %v more", len(urns)-10))
				break
			}
			line(fmt.Sprintf("  %v (%v)", urn.Name(), urn.Type()))
		}
	}
	fmt.Println(ui.TEXT_HIGHLIGHT_BOLD.Render("➜") + "  " + ui.TEXT_NORMAL_BOLD.Render("Going back"))
	fmt.Println()
	deploy := "Check out your config from before the codemod, install, and deploy it with SST 4's `sst deploy`, or its `sst dev` on a stage you use with it."
	if undone.Finished {
		line(fmt.Sprintf("The state the move on %v saved was back already, from a going back that stopped. SST 4 can deploy the stage now.", undone.Moved))
		fmt.Println()
		ui.Success("The stage is on SST 4 again. " + deploy)
		return nil
	}
	line(fmt.Sprintf("The stage's state is the one the move on %v saved.", undone.Moved))
	if undone.Refreshed > 0 {
		n := undone.Refreshed
		line(fmt.Sprintf("%v of what the move kept %v brought up to date from SST 5's state, so SST 4's deploy puts back what the move changed in %v.", count(n, "resource", "resources"), pick(n, "was", "were"), pick(n, "it", "them")))
	}
	if len(undone.Dropped) > 0 {
		n := len(undone.Dropped)
		line(fmt.Sprintf("%v the move deleted %v taken out of it. SST 4's deploy uploads %v again:", count(n, "code object", "code objects"), pick(n, "was", "were"), pick(n, "it", "them")))
		list(undone.Dropped)
	}
	if len(undone.Replaced) > 0 {
		n := len(undone.Replaced)
		line(fmt.Sprintf("%v in SST 4's state %v replaced by the move, so %v may be gone:", count(n, "resource", "resources"), pick(n, "was", "were"), pick(n, "it", "they")))
		list(undone.Replaced)
	}
	if len(undone.Stale) > 0 {
		n := len(undone.Stale)
		line(fmt.Sprintf("%v of what the move kept couldn't be brought up to date: SST 4's provider for %v isn't SST 5's, or %v on one the move replaced:", count(n, "resource", "resources"), pick(n, "it", "them"), pick(n, "it depends", "they depend")))
		list(undone.Stale)
	}
	if len(undone.Unknown) > 0 {
		n := len(undone.Unknown)
		line(fmt.Sprintf("%v SST 5 created %v in SST 4's state, and %v in your account as %v:", count(n, "resource", "resources"), pick(n, "isn't", "aren't"), pick(n, "stays", "stay"), pick(n, "it is", "they are")))
		list(undone.Unknown)
	}
	fmt.Println()
	if len(undone.Replaced) > 0 || len(undone.Stale) > 0 {
		deploy += " Then run SST 4's `sst refresh`, and deploy again, for what couldn't be brought up to date. A function among them keeps the code SST 5 deployed until its code changes."
	}
	ui.Success("The stage is on SST 4 again. " + deploy)
	return nil
}

func pick(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}
