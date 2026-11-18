package aws

import (
	"context"
	"log/slog"
	"sync"

	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/bridge"
	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/bridge/web"
	"github.com/sst/sst/v3/pkg/bus"
	"github.com/sst/sst/v3/pkg/project"
)

// webFunction sends the requests of the web functions live in sst dev, which
// their bridges send, to their local servers. Each request is handled on its
// own, so an environment's requests run at once, as they do in AWS.
func webFunction(ctx context.Context, input input) {
	log := slog.Default().With("service", "aws.web")
	log.Info("starting")
	defer log.Info("done")
	events := bus.Subscribe(&project.CompleteEvent{})
	defer bus.Unsubscribe(events)

	var mu sync.Mutex
	targets := map[string]string{}
	forwarder := &web.Forwarder{
		Client: input.client,
		Prefix: input.prefix,
		Target: func(functionID string) (string, bool) {
			mu.Lock()
			defer mu.Unlock()
			url, ok := targets[functionID]
			return url, ok
		},
		HTTP: web.NewHTTPClient(),
	}
	for {
		select {
		case <-ctx.Done():
			return
		case unknown := <-events:
			if evt, ok := unknown.(*project.CompleteEvent); ok {
				next := map[string]string{}
				for name, fn := range evt.WebFunctions {
					next[name] = fn.URL
				}
				mu.Lock()
				targets = next
				mu.Unlock()
			}
		case msg := <-input.msg:
			if msg.Type != bridge.MessageHttpRequest {
				continue
			}
			go forwarder.Handle(ctx, msg)
		}
	}
}
