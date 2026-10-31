package provider

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// This opt-in spike exercises the real bootstrap without loading AWS config.
// Start scripts/floci/compose.yaml first. Data is retained for inspection.
func TestFlociBootstrap(t *testing.T) {
	if os.Getenv("SST_FLOCI_SPIKE") != "1" {
		t.Skip("set SST_FLOCI_SPIKE=1 with the spike container running")
	}
	const endpoint = "http://127.0.0.1:4566"
	transport := &http.Transport{Proxy: nil}
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Timeout:   10 * time.Second,
		Transport: flociSpikeTransport{transport},
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return fmt.Errorf("Floci spike refuses redirects")
		},
	}
	cfg := aws.Config{
		Region:           "us-east-1",
		Credentials:      credentials.NewStaticCredentialsProvider("test", "test", ""),
		BaseEndpoint:     aws.String(endpoint),
		HTTPClient:       client,
		RetryMaxAttempts: 1,
	}
	p := NewAwsProvider()
	p.config = cfg
	first, err := p.Bootstrap(cfg.Region)
	if err != nil {
		t.Fatal(err)
	}
	if first.Asset == "" || first.State == "" || first.AssetEcrUrl == "" || first.Version != len(steps) {
		t.Fatalf("incomplete bootstrap: %+v", first)
	}
	// A fresh provider must load the persisted SSM record, not recreate buckets.
	p = NewAwsProvider()
	p.config = cfg
	second, err := p.Bootstrap(cfg.Region)
	if err != nil {
		t.Fatal(err)
	}
	if *first != *second {
		t.Fatalf("bootstrap changed on second run: %+v -> %+v", first, second)
	}
	_, err = s3.NewFromConfig(cfg, func(o *s3.Options) { o.UsePathStyle = true }).PutObject(
		context.Background(), &s3.PutObjectInput{
			Bucket: aws.String(first.Asset), Key: aws.String("floci-spike.txt"),
			Body: strings.NewReader("bootstrap HTTP policy probe"),
		})
	if err != nil {
		t.Fatalf("HTTP asset upload after SecureTransport policy: %v", err)
	}
	t.Logf("bootstrap persisted; HTTP upload accepted with SecureTransport deny: %+v", first)
}

type flociSpikeTransport struct{ local http.RoundTripper }

func (transport flociSpikeTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Scheme != "http" || r.URL.Host != "127.0.0.1:4566" {
		return nil, fmt.Errorf("Floci spike blocked outbound request to %s", r.URL.Host)
	}
	// No proxy, shared config, DNS lookup, or credential discovery.
	return transport.local.RoundTrip(r)
}

func TestFlociSpikeBlocksNonlocalRequests(t *testing.T) {
	for _, endpoint := range []string{"https://sts.us-east-1.amazonaws.com", "http://169.254.169.254/latest/meta-data", "https://127.0.0.1:4566", "http://127.0.0.1:4567", "http://127.0.0.1.evil.test:4566"} {
		t.Run(endpoint, func(t *testing.T) {
			u, err := url.Parse(endpoint)
			if err != nil {
				t.Fatal(err)
			}
			// A nil underlying transport would panic if the guard let this through.
			if _, err := (flociSpikeTransport{}).RoundTrip(&http.Request{URL: u}); err == nil {
				t.Fatal("outbound request was not rejected")
			}
		})
	}
}
