package project

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"runtime"

	awssdk "github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sts"
	"github.com/sst/sst/v3/pkg/project/provider"
)

func (p *Project) EnvFor(ctx context.Context, complete *CompleteEvent, name string) (map[string]string, error) {
	log := slog.Default().With("service", "project.env").With("resource", name)
	dev := complete.Devs[name]
	env := map[string]string{}
	if dev.Aws != nil && dev.Aws.Role != "" {
		log.Info("loading aws credentials", "role", dev.Aws.Role)
		prov, _ := p.Provider("aws")
		credentials, err := AssumeDevRole(ctx, prov.(*provider.AwsProvider), dev.Aws.Role)
		if err != nil {
			log.Error("failed to load aws credentials", "err", err)
		}
		for key, value := range credentials {
			env[key] = value
		}
	}
	AddDevEnv(env, complete, name, p.app.Name, p.app.Stage)
	return env, nil
}

// AssumeDevRole takes the role a dev command runs as, and gives its
// credentials as the AWS variables of the command's environment.
func AssumeDevRole(ctx context.Context, aws *provider.AwsProvider, role string) (map[string]string, error) {
	sessionName := "sst-dev"
	result, err := sts.NewFromConfig(aws.Config()).AssumeRole(ctx, &sts.AssumeRoleInput{
		RoleArn:         &role,
		RoleSessionName: &sessionName,
		DurationSeconds: awssdk.Int32(3600),
	})
	if err != nil {
		return nil, err
	}
	return map[string]string{
		"AWS_ACCESS_KEY_ID":     *result.Credentials.AccessKeyId,
		"AWS_SECRET_ACCESS_KEY": *result.Credentials.SecretAccessKey,
		"AWS_SESSION_TOKEN":     *result.Credentials.SessionToken,
		"AWS_REGION":            aws.Config().Region,
	}, nil
}

// AddDevEnv adds to a dev command's environment what the deploy gives it: its
// links, the app, its own environment, and Cloudflare's settings. What it
// adds wins over what env has.
func AddDevEnv(env map[string]string, complete *CompleteEvent, name, app, stage string) {
	dev := complete.Devs[name]
	slog.Default().With("service", "project.env").With("resource", name).Info("dev", "links", dev.Links)
	// On Windows, always use a consolidated environment variable because
	// Windows uppercases all environment variable names, breaking
	// case-sensitive resource lookups.
	if runtime.GOOS == "windows" {
		allResources := make(map[string]any)
		for _, resource := range dev.Links {
			allResources[resource] = complete.Links[resource].Properties
		}
		allResources["App"] = map[string]string{
			"name":  app,
			"stage": stage,
		}
		jsonData, _ := json.Marshal(allResources)
		env["SST_RESOURCES_JSON"] = string(jsonData)
	} else {
		for _, resource := range dev.Links {
			value := complete.Links[resource].Properties
			jsonValue, _ := json.Marshal(value)
			env["SST_RESOURCE_"+resource] = string(jsonValue)
		}
		env["SST_RESOURCE_App"] = fmt.Sprintf(`{"name": "%s", "stage": "%s" }`, app, stage)
	}
	for key, value := range dev.Environment {
		env[key] = value
	}
	if dev.Cloudflare != nil && dev.Cloudflare.Path != "" {
		env["SST_WRANGLER_PATH"] = dev.Cloudflare.Path
	}
	// Pass Cloudflare credentials to the child process for remote bindings
	for _, key := range []string{"CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL", "CLOUDFLARE_DEFAULT_ACCOUNT_ID"} {
		if val := os.Getenv(key); val != "" {
			env[key] = val
		}
	}
}
