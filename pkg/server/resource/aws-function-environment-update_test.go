package resource

import (
	"context"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/lambda"
	"github.com/aws/aws-sdk-go-v2/service/lambda/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeFunction is a Lambda function that's busy for its first few looks, and
// whose first updates conflict with another
type fakeFunction struct {
	busy      int
	conflicts int
	variables map[string]string
	looks     int
	updates   []map[string]string
}

func (f *fakeFunction) GetFunctionConfiguration(_ context.Context, _ *lambda.GetFunctionConfigurationInput, _ ...func(*lambda.Options)) (*lambda.GetFunctionConfigurationOutput, error) {
	f.looks++
	out := &lambda.GetFunctionConfigurationOutput{
		State:            types.StateActive,
		LastUpdateStatus: types.LastUpdateStatusSuccessful,
		Environment:      &types.EnvironmentResponse{Variables: f.variables},
	}
	if f.busy > 0 {
		f.busy--
		out.State = types.StatePending
		out.LastUpdateStatus = types.LastUpdateStatusInProgress
	}
	return out, nil
}

func (f *fakeFunction) UpdateFunctionConfiguration(_ context.Context, in *lambda.UpdateFunctionConfigurationInput, _ ...func(*lambda.Options)) (*lambda.UpdateFunctionConfigurationOutput, error) {
	if f.conflicts > 0 {
		f.conflicts--
		// What the other update set
		f.variables = map[string]string{"SST_KEY": "rotated"}
		return nil, &types.ResourceConflictException{Message: aws.String("The function could not be updated due to a concurrent update operation.")}
	}
	f.updates = append(f.updates, in.Environment.Variables)
	f.variables = in.Environment.Variables
	return &lambda.UpdateFunctionConfigurationOutput{}, nil
}

func quickSettle(t *testing.T) {
	timeout, poll := functionSettleTimeout, functionSettlePoll
	functionSettleTimeout, functionSettlePoll = time.Second, 0
	t.Cleanup(func() { functionSettleTimeout, functionSettlePoll = timeout, poll })
}

func TestAddEnvironment(t *testing.T) {
	quickSettle(t)

	t.Run("waits for the function's own deploy", func(t *testing.T) {
		fn := &fakeFunction{busy: 2, variables: map[string]string{"SST_KEY": "k"}}
		require.NoError(t, addEnvironment(context.Background(), fn, "app-dev-echo", map[string]string{"SELF_URL": "https://echo"}))
		assert.Equal(t, []map[string]string{{"SST_KEY": "k", "SELF_URL": "https://echo"}}, fn.updates)
		// Two busy, one settled, and one after its own update
		assert.Equal(t, 4, fn.looks)
	})

	t.Run("adds to what another update left, when one conflicts", func(t *testing.T) {
		fn := &fakeFunction{conflicts: 1, variables: map[string]string{"SST_KEY": "k"}}
		require.NoError(t, addEnvironment(context.Background(), fn, "app-dev-echo", map[string]string{"SELF_URL": "https://echo"}))
		assert.Equal(t, []map[string]string{{"SST_KEY": "rotated", "SELF_URL": "https://echo"}}, fn.updates)
	})

	t.Run("gives up on a function that stays busy", func(t *testing.T) {
		functionSettleTimeout = 0
		fn := &fakeFunction{busy: 1000}
		err := addEnvironment(context.Background(), fn, "app-dev-echo", map[string]string{"SELF_URL": "https://echo"})
		assert.ErrorContains(t, err, `the function "app-dev-echo" is still being created or updated`)
		assert.Empty(t, fn.updates)
	})

	t.Run("gives up after conflicts that keep coming", func(t *testing.T) {
		fn := &fakeFunction{conflicts: 10}
		err := addEnvironment(context.Background(), fn, "app-dev-echo", map[string]string{"SELF_URL": "https://echo"})
		var conflict *types.ResourceConflictException
		assert.ErrorAs(t, err, &conflict)
	})
}
