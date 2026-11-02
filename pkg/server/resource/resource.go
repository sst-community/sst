package resource

import (
	"context"
	"fmt"
	"net/rpc"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/sst/sst/v3/pkg/project"
	"github.com/sst/sst/v3/pkg/project/provider"
)

type ReadInput[T any] struct {
	ID   string `json:"id"`
}

type ReadResult[T any] struct {
	ID   string `json:"id"`
	Outs T      `json:"outs"`
}

type DiffInput[N any, O any] struct {
	ID   string `json:"id"`
	News N      `json:"news"`
	Olds O      `json:"olds"`
}

type DiffResult struct {
	Changes bool `json:"changes"`
}

type CreateResult[T any] struct {
	ID   string `json:"id"`
	Outs T      `json:"outs"`
}

type UpdateInput[N any, O any] struct {
	ID   string `json:"id"`
	News N      `json:"news"`
	Olds O      `json:"olds"`
}

type UpdateResult[T any] struct {
	Outs T `json:"outs"`
}

type DeleteInput[T any] struct {
	ID   string `json:"id"`
	Outs T      `json:"outs"`
}

// AwsResource is what SST's AWS resources share: the context their calls run
// in, and where they get the stage's AWS setup. The RPC reads it from the
// project's provider, and the provider the sst binary serves (pkg/provider)
// from its environment, so both run the same code.
type AwsResource struct {
	context context.Context
	load    func() (aws.Config, error)
}

// NewAwsResource is an AwsResource whose calls run in ctx, with the setup load
// gives. load is called for each operation.
func NewAwsResource(ctx context.Context, load func() (aws.Config, error)) *AwsResource {
	return &AwsResource{ctx, load}
}

func (a *AwsResource) config() (aws.Config, error) {
	return a.load()
}

// projectAws is the setup of the project's AWS provider, as it is when called
func projectAws(p *project.Project) func() (aws.Config, error) {
	return func() (aws.Config, error) {
		result, ok := p.Provider("aws")
		if !ok {
			return aws.Config{}, fmt.Errorf("no aws provider found")
		}
		casted := result.(*provider.AwsProvider)
		return casted.Config(), nil
	}
}

func Register(ctx context.Context, p *project.Project, r *rpc.Server) error {
	awsResource := NewAwsResource(ctx, projectAws(p))
	cloudflareResource := &CloudflareResource{ctx, p}
	vercelResource := &VercelResource{ctx, p}
	
	// AWS Resources
	r.RegisterName("Resource.Aws.BucketFiles", &BucketFiles{awsResource})
	r.RegisterName("Resource.Aws.DistributionDeploymentWaiter", &DistributionDeploymentWaiter{awsResource})
	r.RegisterName("Resource.Aws.DistributionInvalidation", &DistributionInvalidation{awsResource})
	r.RegisterName("Resource.Aws.FunctionEnvironmentUpdate", &FunctionEnvironmentUpdate{awsResource})
	r.RegisterName("Resource.Aws.HostedZoneLookup", &HostedZoneLookup{awsResource})
	r.RegisterName("Resource.Aws.KvKeys", &KvKeys{awsResource})
	r.RegisterName("Resource.Aws.KvRoutesUpdate", &KvRoutesUpdate{awsResource})
	r.RegisterName("Resource.Aws.MicrovmImagePrune", &MicrovmImagePrune{awsResource})
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

	return nil
}
