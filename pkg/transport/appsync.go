// Package transport has the transports built into the core: how the stubs
// sst dev deploys reach the CLI (see bridge.Transport).
package transport

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/aws/smithy-go"
	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/appsync"
	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/bridge"
	"github.com/sst/sst/v3/pkg/project/provider"
)

// AppSync is the built-in transport: an AppSync Event API, the one every app
// and stage in the account and region shares, or the stage's own when the
// app's "dev.appsync" is "stage".
type AppSync struct {
	provider   *provider.AwsProvider
	scope      provider.AppSyncScope
	app, stage string
}

var _ bridge.Transport = (*AppSync)(nil)

func NewAppSync(aws *provider.AwsProvider, scope provider.AppSyncScope, app, stage string) *AppSync {
	return &AppSync{provider: aws, scope: scope, app: app, stage: stage}
}

// Stub gives the stub the Event API's endpoints, and lets it use any Event
// API while it's the shared one, or only the stage's own. It finds the Event
// API, and creates it if there's none.
func (a *AppSync) Stub(ctx context.Context) (*bridge.StubSettings, error) {
	api, err := a.provider.ResolveAppSync(ctx, a.scope)
	if err != nil {
		return nil, err
	}
	return appsyncStub(api), nil
}

func appsyncStub(api *provider.AppSync) *bridge.StubSettings {
	resources := []string{"*"}
	if !api.Shared {
		resources = []string{api.Arn, api.Arn + "/*"}
	}
	return &bridge.StubSettings{
		Environment: map[string]string{
			"SST_APPSYNC_HTTP":     api.Http,
			"SST_APPSYNC_REALTIME": api.Realtime,
		},
		Permissions: []bridge.StubPermission{{Actions: []string{"appsync:*"}, Resources: resources}},
	}
}

// Connect finds the Event API, creating it if there's none, and connects to
// it once it answers. A new one can take a moment: one that doesn't answer in
// time is ErrNotReady.
func (a *AppSync) Connect(ctx context.Context) (bridge.Conn, error) {
	api, err := a.provider.ResolveAppSync(ctx, a.scope)
	if err != nil {
		return nil, err
	}
	slog.Info("found appsync", "rest", api.Http, "realtime", api.Realtime, "shared", api.Shared)
	conn, err := appsync.DialWhenReady(ctx, a.provider.Config(), api.Http, api.Realtime)
	if err != nil && appsync.Transient(err) {
		return nil, fmt.Errorf("%w: %w", bridge.ErrNotReady, err)
	}
	return conn, err
}

// Remove removes the stage's own Event API, and leaves the shared one. It's
// looked for whatever "dev.appsync" is now, as it may have been "stage" when
// sst dev ran. Credentials that can't reach AppSync's control plane are no
// error: the shared Event API doesn't need them, and a stage that never had
// one of its own has nothing to remove.
func (a *AppSync) Remove(ctx context.Context) error {
	err := a.provider.RemoveAppSync(ctx, a.app, a.stage)
	var apiErr smithy.APIError
	if errors.As(err, &apiErr) && apiErr.ErrorCode() == "AccessDeniedException" {
		slog.Info("can't look for the stage's appsync event api", "err", err)
		return nil
	}
	return err
}
