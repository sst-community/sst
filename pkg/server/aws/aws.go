package aws

import (
	"context"
	"fmt"
	"net/rpc"
	"sync"

	"github.com/sst/sst/v3/pkg/project"
	"github.com/sst/sst/v3/pkg/project/provider"
)

type aws struct {
	sync.Mutex
	project *project.Project
}

type BootstrapInput struct {
	Region string `json:"region"`
}

func (a *aws) Bootstrap(input *BootstrapInput, output *provider.AwsBootstrapData) error {
	if a.project.FlociPreflight() {
		return fmt.Errorf("Floci bootstrap cannot mutate resources during preflight")
	}
	unknown, ok := a.project.Provider("aws")
	if !ok {
		return fmt.Errorf("aws provider not found")
	}
	existing := unknown.(*provider.AwsProvider)
	data, err := existing.Bootstrap(input.Region)
	if err != nil {
		return err
	}
	*output = *data
	return nil
}

type AppsyncInput struct {
}
type AppsyncOutput struct {
	Http     string `json:"http"`
	Realtime string `json:"realtime"`
	Arn      string `json:"arn"`
	// Shared is whether every app and stage in the account and region uses it
	Shared bool `json:"shared"`
}

func (a *aws) Appsync(input *AppsyncInput, output *AppsyncOutput) error {
	if a.project.Floci() {
		return fmt.Errorf("AppSync is not supported by Floci. No AWS fallback was attempted.")
	}
	unknown, ok := a.project.Provider("aws")
	if !ok {
		return fmt.Errorf("aws provider not found")
	}
	existing := unknown.(*provider.AwsProvider)
	api, err := existing.ResolveAppSync(context.Background(), a.project.AppSyncScope())
	if err != nil {
		return err
	}
	output.Http = api.Http
	output.Realtime = api.Realtime
	output.Arn = api.Arn
	output.Shared = api.Shared
	return nil
}

func Register(ctx context.Context, p *project.Project, r *rpc.Server) error {
	r.RegisterName("Provider.Aws", &aws{
		project: p,
	})
	return nil
}
