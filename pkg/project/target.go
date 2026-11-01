package project

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/sst/sst/v3/pkg/target"
)

// stopIdleTarget stops the stage's target's container, after a remove, when
// no stage on it has anything deployed or a command running, of any app: nothing uses it, and it
// may hold this machine's Docker socket. Its data is kept, and the next
// command on a stage bound to it starts it again.
func (p *Project) stopIdleTarget() {
	local, ok := p.Target().(*target.Local)
	if !ok {
		return
	}
	deployed, err := target.Deployed(local.Name())
	if err != nil || len(deployed) > 0 {
		return
	}
	// A command running on another stage, like a first deploy, which has
	// nothing in its state yet. This one holds its own lock until it's done.
	locked, err := target.Locked(local.Name())
	if err != nil {
		return
	}
	for _, stage := range locked {
		if stage != p.app.Name+"/"+p.app.Stage {
			return
		}
	}
	stopped, err := local.StopContainer(context.Background())
	if err != nil {
		slog.Warn("stopping the target's container", "err", err)
		return
	}
	if stopped {
		target.Say(fmt.Sprintf("Stopped the %q target's container, as no stage on it has anything deployed. Its data is kept.", local.Name()))
	}
}
