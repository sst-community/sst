package aws

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/lambda"
	"github.com/aws/aws-sdk-go-v2/service/lambda/types"
	"github.com/sst/sst/v3/pkg/bus"
	"github.com/sst/sst/v3/pkg/project"
	"github.com/sst/sst/v3/pkg/runtime"
)

// ConcurrencyWarningEvent says the account can run few Lambda functions at once
// for sst dev.
type ConcurrencyWarningEvent struct {
	Message string
}

// Below this many unreserved concurrent executions, sst dev warns. An account
// gets 1,000 by default, and some new ones only 10.
const lowConcurrency = 100

// concurrencyWarning says why the account's Lambda concurrency in a region is
// low for sst dev, or nothing when it isn't.
func concurrencyWarning(region string, limit *types.AccountLimit) string {
	if limit == nil {
		return ""
	}
	unreserved := limit.ConcurrentExecutions
	if limit.UnreservedConcurrentExecutions != nil {
		unreserved = *limit.UnreservedConcurrentExecutions
	}
	if unreserved >= lowConcurrency {
		return ""
	}
	return fmt.Sprintf("Lambda runs only %d invocations at once in this AWS account in %s, besides reserved concurrency. "+
		"In sst dev, an invocation holds one for as long as it runs on your machine, "+
		"so more requests than that at once fail with a 500 or a 429. "+
		"To raise it, request a higher \"Concurrent executions\" quota for Lambda in Service Quotas.", unreserved, region)
}

// warnLowConcurrency warns, once a deploy of sst dev is done, when the
// account's Lambda concurrency in the region is low and the app runs a
// function Live. The warning waits for a deploy that worked, as the terminal
// that shows it isn't connected before then, and a function is Live only once
// it's deployed. When the settings can't be read, as without the
// lambda:GetAccountSettings permission, it says nothing.
func warnLowConcurrency(ctx context.Context, region string, settings func(context.Context) (*lambda.GetAccountSettingsOutput, error)) {
	// a function that runs Live is added as a target while it deploys
	evts := bus.Subscribe(&project.CompleteEvent{}, &runtime.BuildInput{})
	defer bus.Unsubscribe(evts)
	out, err := settings(ctx)
	if err != nil {
		slog.Info("could not read the lambda account settings", "err", err)
		return
	}
	message := concurrencyWarning(region, out.AccountLimit)
	if message == "" {
		return
	}
	live := false
	for {
		select {
		case <-ctx.Done():
			return
		case evt := <-evts:
			switch evt := evt.(type) {
			case *runtime.BuildInput:
				live = true
			case *project.CompleteEvent:
				if live && !evt.Old && len(evt.Errors) == 0 {
					bus.Publish(&ConcurrencyWarningEvent{Message: message})
					return
				}
			}
		}
	}
}

func accountSettings(cfg aws.Config) func(context.Context) (*lambda.GetAccountSettingsOutput, error) {
	client := lambda.NewFromConfig(cfg)
	return func(ctx context.Context) (*lambda.GetAccountSettingsOutput, error) {
		return client.GetAccountSettings(ctx, &lambda.GetAccountSettingsInput{})
	}
}
