package aws

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"time"

	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/appsync"
	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/bridge"
	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/local"
	"github.com/sst/sst/v3/pkg/project"
	"github.com/sst/sst/v3/pkg/project/provider"
	"github.com/sst/sst/v3/pkg/server"
)

var ErrIoTDelay = fmt.Errorf("iot not available")
var ErrAppsyncNotReady = fmt.Errorf("appsync not ready")

func Start(
	ctx context.Context,
	p *project.Project,
	s *server.Server,
	args map[string]interface{},
	flociListener net.Listener,
) error {
	uncasted, _ := p.Provider("aws")
	prov := uncasted.(*provider.AwsProvider)
	config := prov.Config()
	if !p.Floci() {
		go warnLowConcurrency(ctx, config.Region, accountSettings(config))
	}
	slog.Info("getting endpoint")
	prefix := fmt.Sprintf("/sst/%s/%s", p.App().Name, p.App().Stage)

	var conn bridge.Conn
	var err error
	if p.Floci() {
		endpoint, parseErr := url.Parse(p.Env()["SST_FLOCI_BRIDGE"])
		if parseErr != nil || endpoint.Port() == "" {
			return fmt.Errorf("invalid Floci bridge URL")
		}
		handler, handlerErr := local.NewServer(p.Env()["SST_FLOCI_TOKEN"])
		if handlerErr != nil {
			return handlerErr
		}
		if flociListener == nil {
			return fmt.Errorf("Floci bridge listener was not reserved")
		}
		srv := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second}
		defer srv.Close()
		go srv.Serve(flociListener)
		conn, err = local.Dial("http://127.0.0.1:"+endpoint.Port(), p.Env()["SST_FLOCI_TOKEN"])
		if err != nil {
			return err
		}
	} else {
		api, err := prov.ResolveAppSync(ctx, p.AppSyncScope())
		if err != nil {
			return err
		}
		rest, realtime := api.Http, api.Realtime
		slog.Info("found appsync", "rest", rest, "realtime", realtime, "shared", api.Shared)

		conn, err = appsync.DialWhenReady(ctx, config, rest, realtime)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			if !appsync.Transient(err) {
				return err
			}
			slog.Error("appsync not ready", "err", err)
			return ErrAppsyncNotReady
		}
	}
	client := bridge.NewClient(ctx, conn, "dev", prefix)

	functionsChan := make(chan bridge.Message, 1000)
	tasksChan := make(chan bridge.Message, 1000)

	in := input{
		config:  config,
		server:  s,
		client:  client,
		project: p,
		prefix:  prefix,
	}

	in.msg = functionsChan
	go fileLogger(p)
	go function(ctx, in)

	in.msg = tasksChan
	go task(ctx, in)

	for {
		select {
		case <-ctx.Done():
			return nil
		case msg := <-client.Read():
			if msg.Source == "dev" {
				continue
			}
			functionsChan <- msg
			tasksChan <- msg
		}
	}
}
