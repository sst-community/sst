package sst4

import (
	"context"
	"fmt"
	"net/rpc"
	"os"

	"github.com/sst/sst/v3/pkg/project"
	"github.com/sst/sst/v3/pkg/project/provider"
	"github.com/sst/sst/v3/pkg/server/resource"
)

// SST_BUILD_CONCURRENCY_SITE is how many sites SST 4's components build at
// once (Resource.Run)
var SST_BUILD_CONCURRENCY_SITE = os.Getenv("SST_BUILD_CONCURRENCY_SITE")

// registerRPC serves what SST 4's components call the CLI for, as SST
// 4.25.0's CLI served them: their provider resources, as
// Resource.<Cloud>.<Name>, and Provider.Aws. The resources both lines have
// byte for byte are SST 5's own types, given the stage's AWS setup as SST 4
// gave it; the others are SST 4's, in this package.
func registerRPC(ctx context.Context, p *project.Project, r *rpc.Server) {
	awsResource := &AwsResource{ctx, p}
	shared := resource.NewAwsResource(ctx, awsResource.config)
	cloudflareResource := &CloudflareResource{ctx, p}
	vercelResource := &VercelResource{ctx, p}
	r.RegisterName("Resource.Run", NewRun())

	// AWS Resources
	r.RegisterName("Resource.Aws.BucketFiles", &resource.BucketFiles{AwsResource: shared})
	r.RegisterName("Resource.Aws.DistributionDeploymentWaiter", &resource.DistributionDeploymentWaiter{AwsResource: shared})
	r.RegisterName("Resource.Aws.DistributionInvalidation", &resource.DistributionInvalidation{AwsResource: shared})
	r.RegisterName("Resource.Aws.FunctionCodeUpdater", &FunctionCodeUpdater{awsResource})
	r.RegisterName("Resource.Aws.FunctionEnvironmentUpdate", &FunctionEnvironmentUpdate{awsResource})
	r.RegisterName("Resource.Aws.HostedZoneLookup", &HostedZoneLookup{awsResource})
	r.RegisterName("Resource.Aws.KvKeys", &resource.KvKeys{AwsResource: shared})
	r.RegisterName("Resource.Aws.KvRoutesUpdate", &resource.KvRoutesUpdate{AwsResource: shared})
	r.RegisterName("Resource.Aws.MicrovmImagePrune", &resource.MicrovmImagePrune{AwsResource: shared})
	r.RegisterName("Resource.Aws.OriginAccessIdentity", &OriginAccessIdentity{awsResource})
	r.RegisterName("Resource.Aws.OriginAccessControl", &OriginAccessControl{awsResource})
	r.RegisterName("Resource.Aws.RdsRoleLookup", &RdsRoleLookup{awsResource})
	r.RegisterName("Resource.Aws.VectorTable", &VectorTable{awsResource})

	// Cloudflare Resources
	r.RegisterName("Resource.Cloudflare.DnsRecord", &CloudflareDnsRecord{cloudflareResource})
	r.RegisterName("Resource.Cloudflare.WorkerAssets", &WorkerAssets{cloudflareResource})
	r.RegisterName("Resource.Cloudflare.WorkerScript", &WorkerScript{cloudflareResource})

	// Vercel Resources
	r.RegisterName("Resource.Vercel.DnsRecord", &VercelDnsRecord{vercelResource})

	r.RegisterName("Provider.Aws", &awsProvider{project: p})
}

// awsProvider is Provider.Aws as SST 4's components call it: SST's bootstrap
// in a region, and the AppSync Event API sst dev uses
type awsProvider struct {
	project *project.Project
}

type BootstrapInput struct {
	Region string `json:"region"`
}

func (a *awsProvider) aws() (*provider.AwsProvider, error) {
	unknown, ok := a.project.Provider("aws")
	if !ok {
		return nil, fmt.Errorf("aws provider not found")
	}
	return unknown.(*provider.AwsProvider), nil
}

func (a *awsProvider) Bootstrap(input *BootstrapInput, output *provider.AwsBootstrapData) error {
	existing, err := a.aws()
	if err != nil {
		return err
	}
	data, err := existing.Bootstrap(input.Region)
	if err != nil {
		return err
	}
	*output = *data
	return nil
}

type AppsyncInput struct{}

type AppsyncOutput struct {
	Http     string `json:"http"`
	Realtime string `json:"realtime"`
	Arn      string `json:"arn"`
	// Shared is whether every app and stage in the account and region uses it
	Shared bool `json:"shared"`
}

func (a *awsProvider) Appsync(input *AppsyncInput, output *AppsyncOutput) error {
	existing, err := a.aws()
	if err != nil {
		return err
	}
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
