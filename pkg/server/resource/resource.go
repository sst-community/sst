package resource

import (
	"context"

	"github.com/aws/aws-sdk-go-v2/aws"
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
// in, and where they get the stage's AWS setup, which the provider the sst
// binary serves (pkg/provider) reads from its environment.
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
