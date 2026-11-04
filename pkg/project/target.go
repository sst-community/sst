package project

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/sst/sst/v3/pkg/target"
)

// stopIdleTarget stops the stage's target's container, after a remove, when
// no stage on it has anything deployed, of any app, and no other command is
// running on it: nothing uses it, and it may hold this machine's Docker
// socket. Its data is kept, and the next command on a stage bound to it
// starts it again.
func (p *Project) stopIdleTarget() {
	local, ok := p.Target().(*target.Local)
	if !ok {
		return
	}
	stopped, err := local.StopIfIdle(context.Background())
	if err != nil {
		slog.Warn("stopping the target's container", "err", err)
		return
	}
	if stopped {
		target.Say(fmt.Sprintf("Stopped the %q target's container, as no stage on it has anything deployed. Its data is kept.", local.Name()))
	}
}
