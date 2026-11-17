package resource

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/lambda"
	"github.com/aws/aws-sdk-go-v2/service/lambda/types"
)

type FunctionEnvironmentUpdate struct {
	*AwsResource
}

type FunctionEnvironmentUpdateInputs struct {
	FunctionName         string            `json:"functionName"`
	Environment          map[string]string `json:"environment"`
	Region               string            `json:"region"`
	FunctionLastModified string            `json:"functionLastModified"`
}

type FunctionEnvironmentUpdateOutputs struct{}

func (r *FunctionEnvironmentUpdate) Create(input *FunctionEnvironmentUpdateInputs, output *CreateResult[FunctionEnvironmentUpdateOutputs]) error {
	if err := r.updateEnvironment(input); err != nil {
		return err
	}

	*output = CreateResult[FunctionEnvironmentUpdateOutputs]{
		ID: input.FunctionName,
	}
	return nil
}

func (r *FunctionEnvironmentUpdate) Update(input *UpdateInput[FunctionEnvironmentUpdateInputs, FunctionEnvironmentUpdateOutputs], output *UpdateResult[FunctionEnvironmentUpdateOutputs]) error {
	if err := r.updateEnvironment(&input.News); err != nil {
		return err
	}

	*output = UpdateResult[FunctionEnvironmentUpdateOutputs]{}
	return nil
}

func (r *FunctionEnvironmentUpdate) Read(input *ReadInput[FunctionEnvironmentUpdateInputs], output *ReadResult[FunctionEnvironmentUpdateOutputs]) error {
	*output = ReadResult[FunctionEnvironmentUpdateOutputs]{
		ID: input.ID,
	}
	return nil
}

func (r *FunctionEnvironmentUpdate) updateEnvironment(input *FunctionEnvironmentUpdateInputs) error {
	cfg, err := r.config()
	if err != nil {
		return err
	}

	// Use the specified region if provided
	if input.Region != "" {
		cfg.Region = input.Region
	}

	return addEnvironment(r.context, lambda.NewFromConfig(cfg), input.FunctionName, input.Environment)
}

// functionConfigs is what adding to a function's environment calls
type functionConfigs interface {
	GetFunctionConfiguration(context.Context, *lambda.GetFunctionConfigurationInput, ...func(*lambda.Options)) (*lambda.GetFunctionConfigurationOutput, error)
	UpdateFunctionConfiguration(context.Context, *lambda.UpdateFunctionConfigurationInput, ...func(*lambda.Options)) (*lambda.UpdateFunctionConfigurationOutput, error)
}

// How long to wait for Lambda to finish creating or updating a function, and
// how often to look. Tests make them short.
var (
	functionSettleTimeout = 5 * time.Minute
	functionSettlePoll    = 2 * time.Second
)

// addEnvironment adds variables to a function's environment, keeping the
// ones it has. Lambda refuses an update while the function is still being
// created or updated, as it is right after its own deploy, so it waits for
// that first, and for its own update to be applied.
func addEnvironment(ctx context.Context, client functionConfigs, name string, environment map[string]string) error {
	for attempt := 0; ; attempt++ {
		config, err := settledFunction(ctx, client, name)
		if err != nil {
			return err
		}
		variables := map[string]string{}
		if config.Environment != nil {
			for k, v := range config.Environment.Variables {
				variables[k] = v
			}
		}
		for k, v := range environment {
			variables[k] = v
		}
		_, err = client.UpdateFunctionConfiguration(ctx, &lambda.UpdateFunctionConfigurationInput{
			FunctionName: aws.String(name),
			Environment:  &types.Environment{Variables: variables},
		})
		// Something else updated it in between: wait for that, and add to
		// the environment it left
		var conflict *types.ResourceConflictException
		if errors.As(err, &conflict) && attempt < 3 {
			continue
		}
		if err != nil {
			return err
		}
		_, err = settledFunction(ctx, client, name)
		return err
	}
}

// settledFunction waits until Lambda has finished creating or updating a
// function, and gives its configuration then
func settledFunction(ctx context.Context, client functionConfigs, name string) (*lambda.GetFunctionConfigurationOutput, error) {
	deadline := time.Now().Add(functionSettleTimeout)
	for {
		config, err := client.GetFunctionConfiguration(ctx, &lambda.GetFunctionConfigurationInput{
			FunctionName: aws.String(name),
		})
		if err != nil {
			return nil, err
		}
		if config.State != types.StatePending && config.LastUpdateStatus != types.LastUpdateStatusInProgress {
			return config, nil
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("the function %q is still being created or updated after %s", name, functionSettleTimeout)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(functionSettlePoll):
		}
	}
}
