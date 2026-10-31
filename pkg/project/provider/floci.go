package provider

import (
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/sst/sst/v3/pkg/floci"
)

// InitFloci never loads shared AWS configuration and never bootstraps implicitly.
func (a *AwsProvider) InitFloci(app, stage, endpoint string, args map[string]interface{}) error {
	if err := floci.ValidateEndpoint(endpoint); err != nil {
		return err
	}
	for key := range args {
		switch key {
		case "package", "version", "region", "defaultTags":
		default:
			return fmt.Errorf("Floci profile 2.3.0 does not support providers.aws.%s. Remove this setting. No AWS fallback was attempted.", key)
		}
	}
	if region, ok := args["region"]; ok && region != "us-east-1" {
		return fmt.Errorf("Floci supports only us-east-1")
	}
	endpointURL, _ := url.Parse(endpoint)
	a.floci = true
	a.config = aws.Config{
		Region:           "us-east-1",
		Credentials:      credentials.NewStaticCredentialsProvider("test", "test", ""),
		BaseEndpoint:     aws.String(endpoint),
		RetryMaxAttempts: 2,
		HTTPClient: &http.Client{
			Timeout:   30 * time.Second,
			Transport: &flociTransport{host: endpointURL.Host, transport: &http.Transport{Proxy: nil}},
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return fmt.Errorf("Floci refuses redirects")
			},
		},
		ServiceOptions: []func(string, any){func(_ string, options any) {
			if s, ok := options.(*s3.Options); ok {
				s.UsePathStyle = true
			}
		}},
	}
	args["region"] = "us-east-1"
	args["accessKey"] = "test"
	args["secretKey"] = "test"
	args["skipCredentialsValidation"] = true
	args["skipMetadataApiCheck"] = true
	args["skipRequestingAccountId"] = true
	args["s3UsePathStyle"] = true
	endpoints := map[string]interface{}{}
	for _, service := range []string{"s3", "dynamodb", "sqs", "lambda", "iam", "sts", "ssm", "ecr", "kms", "cloudwatch", "cloudwatchlogs"} {
		endpoints[service] = endpoint
	}
	args["endpoints"] = []interface{}{endpoints}
	return nil
}

type flociTransport struct {
	host      string
	transport http.RoundTripper
}

func (t *flociTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Scheme != "http" || r.URL.Host != t.host {
		return nil, fmt.Errorf("Floci blocked request to %s. No AWS fallback was attempted.", r.URL.Host)
	}
	return t.transport.RoundTrip(r)
}

// FlociEnvironment also strips per-service endpoint overrides and credential processes.
func FlociEnvironment(base []string, endpoint string) []string {
	result := make([]string, 0, len(base)+16)
	for _, entry := range base {
		key, _, _ := strings.Cut(entry, "=")
		upper := strings.ToUpper(key)
		if upper == "SST_FLOCI" || upper == "SST_FLOCI_ENDPOINT" || strings.HasPrefix(upper, "AWS_") || strings.HasPrefix(upper, "SST_AWS_") || upper == "HTTP_PROXY" || upper == "HTTPS_PROXY" || upper == "ALL_PROXY" || upper == "NO_PROXY" || upper == "NODE_USE_ENV_PROXY" {
			continue
		}
		result = append(result, entry)
	}
	return append(result,
		"SST_FLOCI=1",
		"SST_FLOCI_ENDPOINT="+endpoint,
		"AWS_ACCESS_KEY_ID=test",
		"AWS_SECRET_ACCESS_KEY=test",
		"AWS_SESSION_TOKEN=",
		"AWS_REGION=us-east-1",
		"AWS_DEFAULT_REGION=us-east-1",
		"AWS_ENDPOINT_URL="+endpoint,
		"AWS_EC2_METADATA_DISABLED=true",
		"AWS_CONFIG_FILE="+os.DevNull,
		"AWS_SHARED_CREDENTIALS_FILE="+os.DevNull,
		"AWS_S3_USE_PATH_STYLE_ENDPOINT=true",
		"SST_AWS_ACCESS_KEY_ID=test",
		"SST_AWS_SECRET_ACCESS_KEY=test",
		"SST_AWS_SESSION_TOKEN=",
		"SST_AWS_REGION=us-east-1",
		"HTTP_PROXY=http://127.0.0.1:1",
		"HTTPS_PROXY=http://127.0.0.1:1",
		"NO_PROXY=127.0.0.1,localhost,::1,.localhost.floci.io",
		"NODE_USE_ENV_PROXY=1")
}
