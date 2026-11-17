package provider

import (
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// AwsTarget is where the AWS provider sends its calls on a target's stage,
// and with what credentials.
type AwsTarget struct {
	Endpoint        string
	Region          string
	AccessKeyID     string
	SecretAccessKey string
}

// InitTarget sets the provider up for a target. It reads no shared AWS
// configuration, and its client reaches only the target's endpoint, so
// nothing the CLI calls itself can reach anything else. args are the app's
// settings for the provider, as the target changed them, and its region
// replaces the app's. The provider is bootstrapped in the target as it would
// be in an account.
func (a *AwsProvider) InitTarget(app, stage string, target AwsTarget, args map[string]interface{}) error {
	cfg := aws.Config{
		Region:           target.Region,
		Credentials:      credentials.NewStaticCredentialsProvider(target.AccessKeyID, target.SecretAccessKey, ""),
		RetryMaxAttempts: 3,
	}
	if err := OnlyEndpoint(&cfg, target.Endpoint); err != nil {
		return err
	}
	a.config = cfg
	args["region"] = target.Region
	tags(app, stage, args)
	_, err := a.Bootstrap(target.Region)
	return err
}

// OnlyEndpoint keeps a setup's calls on a target's endpoint: they go to it
// with no proxy, a call to anywhere else is refused, and a bucket is a path
// on it. The provider the sst binary serves (pkg/provider) uses it too, so
// its calls on a target's stage go where the CLI's do.
func OnlyEndpoint(cfg *aws.Config, target string) error {
	endpoint, err := url.Parse(target)
	if err != nil {
		return err
	}
	cfg.BaseEndpoint = aws.String(target)
	cfg.HTTPClient = &http.Client{
		Timeout:   time.Minute,
		Transport: &onlyHost{scheme: endpoint.Scheme, host: endpoint.Host, next: &http.Transport{Proxy: nil}},
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return fmt.Errorf("a target's endpoint doesn't redirect")
		},
	}
	cfg.ServiceOptions = append(cfg.ServiceOptions, func(_ string, options any) {
		// A bucket is a path on the endpoint, not a host of its own
		if s3Options, ok := options.(*s3.Options); ok {
			s3Options.UsePathStyle = true
		}
	})
	return nil
}

// onlyHost refuses a request to anything but the target's endpoint
type onlyHost struct {
	scheme string
	host   string
	next   http.RoundTripper
}

func (t *onlyHost) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Scheme != t.scheme || r.URL.Host != t.host {
		return nil, fmt.Errorf("refused a call to %s: on a target's stage, calls go only to %s://%s", r.URL.Host, t.scheme, t.host)
	}
	return t.next.RoundTrip(r)
}
