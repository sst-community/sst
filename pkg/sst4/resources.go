// The types SST 4's provider resources share, as SST 4.25.0 had them
// (pkg/server/resource on main). The resources both lines have byte for byte
// are SST 5's own (pkg/server/resource), registered in rpc.go; these files
// are the ones whose behaviour differs, or that only SST 4 has.

package sst4

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/sst/sst/v3/pkg/project"
	"github.com/sst/sst/v3/pkg/project/provider"
)

type ReadInput[T any] struct {
	ID string `json:"id"`
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

type AwsResource struct {
	context context.Context
	project *project.Project
}

func (a *AwsResource) config() (aws.Config, error) {
	result, ok := a.project.Provider("aws")
	if !ok {
		return aws.Config{}, fmt.Errorf("no aws provider found")
	}
	casted := result.(*provider.AwsProvider)
	return casted.Config(), nil
}
