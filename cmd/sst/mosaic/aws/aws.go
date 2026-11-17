package aws

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/bridge"
	"github.com/sst/sst/v3/pkg/project"
	"github.com/sst/sst/v3/pkg/project/provider"
	"github.com/sst/sst/v3/pkg/server"
)

var ErrIoTDelay = fmt.Errorf("iot not available")
var ErrAppsyncNotReady = fmt.Errorf("appsync not ready")

func Start(
	ctx context.Context,
	p project.Program,
	s *server.Server,
	args map[string]interface{},
) error {
	uncasted, _ := p.Provider("aws")
	prov := uncasted.(*provider.AwsProvider)
	config := prov.Config()
	go warnLowConcurrency(ctx, config.Region, accountSettings(config))
	slog.Info("getting endpoint")
	prefix := fmt.Sprintf("/sst/%s/%s", p.Name(), p.Stage())

	transport, ok := p.Transport()
	if !ok {
		return p.NoTransport()
	}
	conn, err := transport.Connect(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return nil
		}
		if !errors.Is(err, bridge.ErrNotReady) {
			return err
		}
		slog.Error("appsync not ready", "err", err)
		return ErrAppsyncNotReady
	}
	client := bridge.NewClient(ctx, conn, "dev", prefix)

	functionsChan := make(chan bridge.Message, 1000)
	tasksChan := make(chan bridge.Message, 1000)
	webChan := make(chan bridge.Message, 1000)

	in := input{
		config:      config,
		server:      s,
		client:      client,
		project:     p,
		prefix:      prefix,
		startAtOnce: startAtOnce,
	}

	in.msg = functionsChan
	go fileLogger(p)
	go function(ctx, in)

	in.msg = tasksChan
	go task(ctx, in)

	in.msg = webChan
	go webFunction(ctx, in)

	for {
		select {
		case <-ctx.Done():
			return nil
		case msg := <-client.Read():
			if msg.Source == "dev" {
				continue
			}
			// a web function's request goes only to its loop, as nothing
			// else reads it
			if msg.Type == bridge.MessageHttpRequest {
				webChan <- msg
				continue
			}
			functionsChan <- msg
			tasksChan <- msg
		}
	}
}
