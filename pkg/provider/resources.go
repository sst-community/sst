package provider

import (
	"context"
	"encoding/json"
	"reflect"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
	sstresource "github.com/sst/sst/v3/pkg/server/resource"
)

// resources are the resources the provider serves, by type, with the AWS
// setup load gives. Each is the code the RPC serves the old entries with.
func resources(load func() (aws.Config, error)) map[string]handler {
	return map[string]handler{
		"sst:aws:BucketFiles": typed[sstresource.BucketFilesInputs, sstresource.BucketFilesOutputs]{
			open: func(ctx context.Context) implementation[sstresource.BucketFilesInputs, sstresource.BucketFilesOutputs] {
				return &sstresource.BucketFiles{AwsResource: sstresource.NewAwsResource(ctx, load)}
			},
		},
		"sst:aws:KvKeys": typed[sstresource.KvKeysInputs, sstresource.KvKeysOutputs]{
			open: func(ctx context.Context) implementation[sstresource.KvKeysInputs, sstresource.KvKeysOutputs] {
				return &sstresource.KvKeys{AwsResource: sstresource.NewAwsResource(ctx, load)}
			},
		},
	}
}

// handler is a resource's operations on Pulumi's properties
type handler interface {
	// diff is the top-level properties that differ between the old inputs and
	// the new
	diff(olds, news resource.PropertyMap) ([]string, error)
	create(ctx context.Context, inputs resource.PropertyMap) (string, resource.PropertyMap, error)
	update(ctx context.Context, id string, olds, news resource.PropertyMap) (resource.PropertyMap, error)
	delete(ctx context.Context, id string, outs resource.PropertyMap) error
}

// implementation is a resource as the RPC serves it, with typed inputs I and
// outputs O (pkg/server/resource)
type implementation[I any, O any] interface {
	Create(input *I, output *sstresource.CreateResult[O]) error
	Update(input *sstresource.UpdateInput[I, O], output *sstresource.UpdateResult[O]) error
	Delete(input *sstresource.DeleteInput[O], output *int) error
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
	var result sstresource.UpdateResult[O]
	if err := t.open(ctx).Update(&input, &result); err != nil {
		return nil, err
	}
	return encode(result.Outs)
}

func (t typed[I, O]) delete(ctx context.Context, id string, props resource.PropertyMap) error {
	input := sstresource.DeleteInput[O]{ID: id}
	if err := decode(props, &input.Outs); err != nil {
		return err
	}
	var result int
	return t.open(ctx).Delete(&input, &result)
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
