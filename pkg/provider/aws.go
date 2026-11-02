package provider

import (
	"context"
	"encoding/json"
	"fmt"
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
// from the CLI (Env in pkg/project/provider/aws.go).
//
// In the cloud, it's made as the CLI made its own: the profile, the region
// and the roles it assumed. Its credentials refresh themselves, so a deploy
// that outlasts them, or a long sst dev, doesn't fail halfway.
//
// On a target's stage, it's the target's credentials, region and endpoint
// (pkg/target/env.go), and calls go only to the endpoint.
func awsConfig(ctx context.Context) (aws.Config, error) {
	endpoint := os.Getenv("AWS_ENDPOINT_URL")
	if endpoint == "" {
		roles := []provider.AwsRole{}
		if value := os.Getenv(provider.EnvAwsAssumeRoles); value != "" {
			if err := json.Unmarshal([]byte(value), &roles); err != nil {
				return aws.Config{}, fmt.Errorf("reading %v: %w", provider.EnvAwsAssumeRoles, err)
			}
		}
		return provider.LoadAwsConfig(ctx, os.Getenv("AWS_PROFILE"), os.Getenv("SST_AWS_REGION"), roles)
	}

	options := []func(*config.LoadOptions) error{
		// As many tries as the CLI's own calls on a target get
		config.WithRetryMaxAttempts(3),
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
	if err := provider.OnlyEndpoint(&cfg, endpoint); err != nil {
		return aws.Config{}, err
	}
	return cfg, nil
}
