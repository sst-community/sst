package provider

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
	pulumirpc "github.com/pulumi/pulumi/sdk/v3/proto/go"
	sstresource "github.com/sst/sst/v3/pkg/server/resource"
)

// function is one of the provider's functions: a lookup the program makes
// while it runs, a preview's run too, so what it finds is known before
// anything is created. SST 4 made these resources, which a new stage's
// preview couldn't run (docs/plans/v5-rewrite/reference.md, SST's provider
// resources).
type function func(ctx context.Context, args resource.PropertyMap) (resource.PropertyMap, error)

// functions are the provider's functions, by token, with the AWS setup load
// gives.
func functions(load func() (aws.Config, error)) map[string]function {
	return map[string]function{
		// The id of the Route 53 hosted zone a domain is in: the one whose name
		// is the longest that the domain ends with
		"sst:aws:getHostedZone": func(ctx context.Context, args resource.PropertyMap) (resource.PropertyMap, error) {
			var input sstresource.HostedZoneLookupInputs
			if err := decode(args, &input); err != nil {
				return nil, err
			}
			if input.Domain == "" {
				return nil, fmt.Errorf("sst:aws:getHostedZone needs a domain")
			}
			lookup := &sstresource.HostedZoneLookup{AwsResource: sstresource.NewAwsResource(ctx, load)}
			var found sstresource.CreateResult[sstresource.HostedZoneLookupOutputs]
			if err := lookup.Create(&input, &found); err != nil {
				return nil, err
			}
			return encode(found.Outs)
		},
	}
}

// Invoke runs one of the provider's functions
func (s *server) Invoke(ctx context.Context, req *pulumirpc.InvokeRequest) (*pulumirpc.InvokeResponse, error) {
	fn, ok := s.functions[req.GetTok()]
	if !ok {
		return nil, fmt.Errorf("the sst provider has no function %q", req.GetTok())
	}
	args, err := unmarshal(req.GetArgs())
	if err != nil {
		return nil, err
	}
	// The program waits for its arguments before it calls, so none is unknown
	if args.ContainsUnknowns() {
		return nil, fmt.Errorf("%s was called with a value that isn't known yet", req.GetTok())
	}
	result, err := fn(ctx, args)
	if err != nil {
		return nil, err
	}
	properties, err := marshal(result)
	if err != nil {
		return nil, err
	}
	return &pulumirpc.InvokeResponse{Return: properties}, nil
}
