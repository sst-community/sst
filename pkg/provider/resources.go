package provider

import (
	"context"
	"encoding/json"
	"reflect"
	"sort"

	"github.com/aws/aws-sdk-go-v2/aws"
	cf "github.com/cloudflare/cloudflare-go"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
	sstresource "github.com/sst/sst/v3/pkg/server/resource"
)

// ResourceTypes are the types of the resources the provider serves, which
// SST's components make (platform/src/components/*/resources) and the eject
// takes out of a state (pkg/eject)
func ResourceTypes() []string {
	var types []string
	for t := range resources(nil, nil, nil) {
		types = append(types, t)
	}
	sort.Strings(types)
	return types
}

// resources are the resources the provider serves, by type, with the AWS
// setup and the Cloudflare credentials load and cloudflare give, and the
// Vercel token vercelToken gives, if any. Each is the code the RPC serves SST
// 4's entries with, or, for what SST 4 wrote in TypeScript, the same calls
// made in Go.
func resources(load func() (aws.Config, error), cloudflare func() (*cf.API, error), vercelToken func() string) map[string]handler {
	onAws := func(ctx context.Context) *sstresource.AwsResource { return sstresource.NewAwsResource(ctx, load) }
	onCloudflare := func(ctx context.Context) *sstresource.CloudflareResource {
		return sstresource.NewCloudflareResource(ctx, cloudflare)
	}
	return map[string]handler{
		"sst:aws:BucketFiles": typed[sstresource.BucketFilesInputs, sstresource.BucketFilesOutputs]{
			open: func(ctx context.Context) implementation[sstresource.BucketFilesInputs, sstresource.BucketFilesOutputs] {
				return &sstresource.BucketFiles{AwsResource: onAws(ctx)}
			},
		},
		"sst:aws:KvKeys": typed[sstresource.KvKeysInputs, sstresource.KvKeysOutputs]{
			open: func(ctx context.Context) implementation[sstresource.KvKeysInputs, sstresource.KvKeysOutputs] {
				return &sstresource.KvKeys{AwsResource: onAws(ctx)}
			},
		},
		"sst:aws:KvRoutesUpdate": typed[sstresource.KvRoutesUpdateInputs, sstresource.KvRoutesUpdateOutputs]{
			open: func(ctx context.Context) implementation[sstresource.KvRoutesUpdateInputs, sstresource.KvRoutesUpdateOutputs] {
				return &sstresource.KvRoutesUpdate{AwsResource: onAws(ctx)}
			},
		},
		"sst:aws:DistributionInvalidation": typed[sstresource.DistributionInvalidationInputs, struct{}]{
			open: func(ctx context.Context) implementation[sstresource.DistributionInvalidationInputs, struct{}] {
				return &sstresource.DistributionInvalidation{AwsResource: onAws(ctx)}
			},
		},
		"sst:aws:DistributionDeploymentWaiter": typed[sstresource.DistributionDeploymentWaiterInputs, sstresource.DistributionDeploymentWaiterOutputs]{
			open: func(ctx context.Context) implementation[sstresource.DistributionDeploymentWaiterInputs, sstresource.DistributionDeploymentWaiterOutputs] {
				return &sstresource.DistributionDeploymentWaiter{AwsResource: onAws(ctx)}
			},
		},
		"sst:aws:FunctionEnvironmentUpdate": typed[sstresource.FunctionEnvironmentUpdateInputs, sstresource.FunctionEnvironmentUpdateOutputs]{
			open: func(ctx context.Context) implementation[sstresource.FunctionEnvironmentUpdateInputs, sstresource.FunctionEnvironmentUpdateOutputs] {
				return &sstresource.FunctionEnvironmentUpdate{AwsResource: onAws(ctx)}
			},
		},
		"sst:aws:MicrovmImagePrune": typed[sstresource.MicrovmImagePruneInputs, sstresource.MicrovmImagePruneOutputs]{
			open: func(ctx context.Context) implementation[sstresource.MicrovmImagePruneInputs, sstresource.MicrovmImagePruneOutputs] {
				return &sstresource.MicrovmImagePrune{AwsResource: onAws(ctx)}
			},
		},
		"sst:aws:OriginAccessControl": typed[sstresource.OriginAccessControlInputs, sstresource.OriginAccessControlOutputs]{
			open: func(ctx context.Context) implementation[sstresource.OriginAccessControlInputs, sstresource.OriginAccessControlOutputs] {
				return &sstresource.OriginAccessControl{AwsResource: onAws(ctx)}
			},
		},
		"sst:aws:RdsRoleLookup": typed[sstresource.RdsRoleLookupInputs, sstresource.RdsRoleLookupOutputs]{
			open: func(ctx context.Context) implementation[sstresource.RdsRoleLookupInputs, sstresource.RdsRoleLookupOutputs] {
				return &sstresource.RdsRoleLookup{AwsResource: onAws(ctx)}
			},
		},
		"sst:cloudflare:DnsRecord": typed[sstresource.CloudflareDnsRecordInputs, sstresource.CloudflareDnsRecordOutputs]{
			open: func(ctx context.Context) implementation[sstresource.CloudflareDnsRecordInputs, sstresource.CloudflareDnsRecordOutputs] {
				return &sstresource.CloudflareDnsRecord{CloudflareResource: onCloudflare(ctx)}
			},
		},
		"sst:cloudflare:WorkerUrl": typed[sstresource.WorkerUrlInputs, sstresource.WorkerUrlOutputs]{
			open: func(ctx context.Context) implementation[sstresource.WorkerUrlInputs, sstresource.WorkerUrlOutputs] {
				return &sstresource.WorkerUrl{CloudflareResource: onCloudflare(ctx)}
			},
		},
		"sst:cloudflare:WorkerPlacement": typed[sstresource.WorkerPlacementInputs, sstresource.WorkerPlacementOutputs]{
			open: func(ctx context.Context) implementation[sstresource.WorkerPlacementInputs, sstresource.WorkerPlacementOutputs] {
				return &sstresource.WorkerPlacement{CloudflareResource: onCloudflare(ctx)}
			},
		},
		"sst:vercel:DnsRecord": typed[sstresource.VercelDnsRecordInputs, sstresource.VercelDnsRecordOutputs]{
			open: func(ctx context.Context) implementation[sstresource.VercelDnsRecordInputs, sstresource.VercelDnsRecordOutputs] {
				return &sstresource.VercelDnsRecord{VercelResource: sstresource.NewVercelResource(ctx, vercelToken)}
			},
		},
	}
}

// What each resource does besides create, checked when the binary is built:
// the provider finds an optional method by its signature, so one that drifted
// from it would be skipped without a word, and a delete would leave what the
// resource made behind
var (
	_ updater[sstresource.BucketFilesInputs, sstresource.BucketFilesOutputs]                                   = (*sstresource.BucketFiles)(nil)
	_ deleter[sstresource.BucketFilesOutputs]                                                                  = (*sstresource.BucketFiles)(nil)
	_ updater[sstresource.KvKeysInputs, sstresource.KvKeysOutputs]                                             = (*sstresource.KvKeys)(nil)
	_ deleter[sstresource.KvKeysOutputs]                                                                       = (*sstresource.KvKeys)(nil)
	_ updater[sstresource.KvRoutesUpdateInputs, sstresource.KvRoutesUpdateOutputs]                             = (*sstresource.KvRoutesUpdate)(nil)
	_ deleter[sstresource.KvRoutesUpdateOutputs]                                                               = (*sstresource.KvRoutesUpdate)(nil)
	_ updater[sstresource.DistributionInvalidationInputs, struct{}]                                            = (*sstresource.DistributionInvalidation)(nil)
	_ updater[sstresource.DistributionDeploymentWaiterInputs, sstresource.DistributionDeploymentWaiterOutputs] = (*sstresource.DistributionDeploymentWaiter)(nil)
	_ updater[sstresource.FunctionEnvironmentUpdateInputs, sstresource.FunctionEnvironmentUpdateOutputs]       = (*sstresource.FunctionEnvironmentUpdate)(nil)
	_ updater[sstresource.MicrovmImagePruneInputs, sstresource.MicrovmImagePruneOutputs]                       = (*sstresource.MicrovmImagePrune)(nil)
	_ deleter[sstresource.OriginAccessControlOutputs]                                                          = (*sstresource.OriginAccessControl)(nil)
	_ adopter[sstresource.OriginAccessControlInputs, sstresource.OriginAccessControlOutputs]                   = (*sstresource.OriginAccessControl)(nil)
	_ updater[sstresource.RdsRoleLookupInputs, sstresource.RdsRoleLookupOutputs]                               = (*sstresource.RdsRoleLookup)(nil)
	_ updater[sstresource.CloudflareDnsRecordInputs, sstresource.CloudflareDnsRecordOutputs]                   = (*sstresource.CloudflareDnsRecord)(nil)
	_ updater[sstresource.WorkerUrlInputs, sstresource.WorkerUrlOutputs]                                       = (*sstresource.WorkerUrl)(nil)
	_ updater[sstresource.WorkerPlacementInputs, sstresource.WorkerPlacementOutputs]                           = (*sstresource.WorkerPlacement)(nil)
	_ deleter[sstresource.WorkerPlacementOutputs]                                                              = (*sstresource.WorkerPlacement)(nil)
	_ updater[sstresource.VercelDnsRecordInputs, sstresource.VercelDnsRecordOutputs]                           = (*sstresource.VercelDnsRecord)(nil)
)

// handler is a resource's operations on Pulumi's properties
type handler interface {
	// diff is the top-level properties that differ between the old inputs and
	// the new
	diff(olds, news resource.PropertyMap) ([]string, error)
	create(ctx context.Context, inputs resource.PropertyMap) (string, resource.PropertyMap, error)
	update(ctx context.Context, id string, olds, news resource.PropertyMap) (resource.PropertyMap, error)
	delete(ctx context.Context, id string, outs resource.PropertyMap) error
	// imported is the resource with an id, read from the cloud, for a move
	// that adopts what SST 4 created. ok is false for a resource that can't
	// be adopted.
	imported(ctx context.Context, id string) (inputs, outs resource.PropertyMap, ok bool, err error)
}

// implementation is a resource as the RPC serves it, with typed inputs I and
// outputs O (pkg/server/resource). It may also update (updater), delete
// (deleter), and be adopted (adopter). One that doesn't update keeps its
// outputs, and one that doesn't delete leaves what it made, as the RPC does
// for a method a resource doesn't have.
type implementation[I any, O any] interface {
	Create(input *I, output *sstresource.CreateResult[O]) error
}

type updater[I any, O any] interface {
	Update(input *sstresource.UpdateInput[I, O], output *sstresource.UpdateResult[O]) error
}

type deleter[O any] interface {
	Delete(input *sstresource.DeleteInput[O], output *int) error
}

// adopter reads a resource with an id from the cloud, as its inputs and
// outputs would have it
type adopter[I any, O any] interface {
	Adopt(id string) (*I, *O, error)
}

// typed adapts an implementation to Pulumi's properties: they go through JSON
// into its types, and its outputs come back the same way. open gives it for
// one call, with the call's context.
type typed[I any, O any] struct {
	open func(ctx context.Context) implementation[I, O]
}

func (t typed[I, O]) diff(olds, news resource.PropertyMap) ([]string, error) {
	changed := map[string]bool{}
	// Not known yet, in a preview: it may change
	known := resource.PropertyMap{}
	for key, value := range news {
		if value.ContainsUnknowns() {
			changed[string(key)] = true
			continue
		}
		known[key] = value
	}
	// Each side as the resource reads it, so a field one side leaves out and
	// the other has empty, `purge: false` say, isn't a change
	before, err := normalize[I](olds)
	if err != nil {
		return nil, err
	}
	after, err := normalize[I](known)
	if err != nil {
		return nil, err
	}
	for key, value := range after {
		if !changed[key] && !reflect.DeepEqual(before[key], value) {
			changed[key] = true
		}
	}
	// A field the new side leaves out as empty, which the old side had
	for key := range before {
		if _, ok := after[key]; !ok {
			changed[key] = true
		}
	}
	keys := make([]string, 0, len(changed))
	for key := range changed {
		keys = append(keys, key)
	}
	return keys, nil
}

func (t typed[I, O]) create(ctx context.Context, props resource.PropertyMap) (string, resource.PropertyMap, error) {
	var inputs I
	if err := decode(props, &inputs); err != nil {
		return "", nil, err
	}
	var result sstresource.CreateResult[O]
	if err := t.open(ctx).Create(&inputs, &result); err != nil {
		return "", nil, err
	}
	outs, err := encode(result.Outs)
	return result.ID, outs, err
}

func (t typed[I, O]) update(ctx context.Context, id string, olds, news resource.PropertyMap) (resource.PropertyMap, error) {
	input := sstresource.UpdateInput[I, O]{ID: id}
	if err := decode(olds, &input.Olds); err != nil {
		return nil, err
	}
	if err := decode(news, &input.News); err != nil {
		return nil, err
	}
	impl, ok := t.open(ctx).(updater[I, O])
	if !ok {
		return olds, nil
	}
	var result sstresource.UpdateResult[O]
	if err := impl.Update(&input, &result); err != nil {
		return nil, err
	}
	return encode(result.Outs)
}

func (t typed[I, O]) delete(ctx context.Context, id string, props resource.PropertyMap) error {
	input := sstresource.DeleteInput[O]{ID: id}
	if err := decode(props, &input.Outs); err != nil {
		return err
	}
	impl, ok := t.open(ctx).(deleter[O])
	if !ok {
		return nil
	}
	var result int
	return impl.Delete(&input, &result)
}

func (t typed[I, O]) imported(ctx context.Context, id string) (resource.PropertyMap, resource.PropertyMap, bool, error) {
	impl, ok := t.open(ctx).(adopter[I, O])
	if !ok {
		return nil, nil, false, nil
	}
	inputs, outs, err := impl.Adopt(id)
	if err != nil || inputs == nil {
		return nil, nil, true, err
	}
	in, err := encode(inputs)
	if err != nil {
		return nil, nil, true, err
	}
	out, err := encode(outs)
	return in, out, true, err
}

// decode is Pulumi's properties as a resource's type
func decode(props resource.PropertyMap, into any) error {
	data, err := json.Marshal(props.Mappable())
	if err != nil {
		return err
	}
	return json.Unmarshal(data, into)
}

// encode is a resource's value as Pulumi's properties
func encode(value any) (resource.PropertyMap, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var plain map[string]any
	if err := json.Unmarshal(data, &plain); err != nil {
		return nil, err
	}
	return resource.NewPropertyMapFromMap(plain), nil
}

// normalize is properties as the resource's inputs read them, as plain values
func normalize[I any](props resource.PropertyMap) (map[string]any, error) {
	var inputs I
	if err := decode(props, &inputs); err != nil {
		return nil, err
	}
	data, err := json.Marshal(inputs)
	if err != nil {
		return nil, err
	}
	var plain map[string]any
	err = json.Unmarshal(data, &plain)
	return plain, err
}
