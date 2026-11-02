package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"

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
		profile, region := os.Getenv("AWS_PROFILE"), os.Getenv("SST_AWS_REGION")
		key := os.Getenv("SST_AWS_ACCESS_KEY_ID")
		if key == "" {
			return provider.LoadAwsConfig(ctx, profile, region, roles)
		}
		// The credentials the CLI resolved, until they expire: the provider
		// asks for nothing the CLI already asked for, like a code from an
		// MFA device. Only then are they made as the CLI made its own.
		resolved := aws.Credentials{
			AccessKeyID:     key,
			SecretAccessKey: os.Getenv("SST_AWS_SECRET_ACCESS_KEY"),
			SessionToken:    os.Getenv("SST_AWS_SESSION_TOKEN"),
			Source:          "sst",
		}
		if value := os.Getenv(provider.EnvAwsExpires); value != "" {
			expires, err := time.Parse(time.RFC3339, value)
			if err != nil {
				return aws.Config{}, fmt.Errorf("reading %v: %w", provider.EnvAwsExpires, err)
			}
			resolved.CanExpire, resolved.Expires = true, expires
		}
		made := sync.OnceValues(func() (aws.Config, error) {
			return provider.LoadAwsConfig(ctx, profile, region, roles)
		})
		then := aws.CredentialsProviderFunc(func(ctx context.Context) (aws.Credentials, error) {
			cfg, err := made()
			if err != nil {
				return aws.Credentials{}, err
			}
			return cfg.Credentials.Retrieve(ctx)
		})
		// Made directly, so nothing reads the developer's AWS files until
		// the credentials are made again: the provider runs in another
		// folder, where a relative path in AWS_CONFIG_FILE reads another file
		cfg := aws.Config{
			Region:           region,
			RetryMaxAttempts: 10,
			Credentials: aws.NewCredentialsCache(&resolvedFirst{resolved: resolved, then: then}, func(options *aws.CredentialsCacheOptions) {
				options.ExpiryWindow = time.Minute
			}),
		}
		if cfg.Region == "" {
			cfg.Region = "us-east-1"
		}
		return cfg, nil
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

// resolvedFirst gives the credentials the CLI resolved while they last, and
// then makes new ones as the CLI made its own
type resolvedFirst struct {
	mu       sync.Mutex
	resolved aws.Credentials
	used     bool
	then     aws.CredentialsProvider
}

func (r *resolvedFirst) Retrieve(ctx context.Context) (aws.Credentials, error) {
	r.mu.Lock()
	first := !r.used
	r.used = true
	r.mu.Unlock()
	if first && (!r.resolved.CanExpire || time.Now().Add(time.Minute).Before(r.resolved.Expires)) {
		return r.resolved, nil
	}
	return r.then.Retrieve(ctx)
}
