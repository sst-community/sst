package provider

import (
	"context"
	"os"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/sst/sst/v3/pkg/project/provider"
)

// envAws is the stage's AWS setup, read from the environment the first time
// a resource needs it. It's the same for every call: Pulumi starts the
// provider once for a run.
func envAws() func() (aws.Config, error) {
	return sync.OnceValues(func() (aws.Config, error) {
		return awsConfig(context.Background())
	})
}

// awsConfig is the stage's AWS setup from the environment Pulumi passes on
// from the CLI: the credentials and region the CLI resolved, as SST_AWS_*
// (Env in pkg/project/provider/aws.go). On a target's stage they're the
// target's, and AWS_ENDPOINT_URL is its endpoint (pkg/target/env.go). With
// none of them, it's what the AWS SDK finds on its own.
func awsConfig(ctx context.Context) (aws.Config, error) {
	endpoint := os.Getenv("AWS_ENDPOINT_URL")
	// As many tries as the CLI's own calls get, in the cloud and on a target
	retries := 10
	if endpoint != "" {
		retries = 3
	}
	options := []func(*config.LoadOptions) error{
		config.WithRetryMaxAttempts(retries),
	}
	if region := os.Getenv("SST_AWS_REGION"); region != "" {
		options = append(options, config.WithRegion(region))
	}
	if key := os.Getenv("SST_AWS_ACCESS_KEY_ID"); key != "" {
		options = append(options, config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(
			key,
			os.Getenv("SST_AWS_SECRET_ACCESS_KEY"),
			os.Getenv("SST_AWS_SESSION_TOKEN"),
		)))
	}
	// The SDK reads AWS_ENDPOINT_URL itself
	cfg, err := config.LoadDefaultConfig(ctx, options...)
	if err != nil {
		return aws.Config{}, err
	}
	if cfg.Region == "" {
		cfg.Region = "us-east-1"
	}
	// On a target, calls stay on its endpoint, as the CLI's do
	if endpoint != "" {
		if err := provider.OnlyEndpoint(&cfg, endpoint); err != nil {
			return aws.Config{}, err
		}
	}
	return cfg, nil
}
