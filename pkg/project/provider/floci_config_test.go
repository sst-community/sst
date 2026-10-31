package provider

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

func TestFlociConfigIsLocal(t *testing.T) {
	t.Setenv("AWS_PROFILE", "must-not-be-read")
	t.Setenv("AWS_CONFIG_FILE", "/does/not/exist")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/bucket/key" {
			t.Errorf("not path style: %s", r.URL)
		}
		if !strings.Contains(r.Header.Get("Authorization"), "Credential=test/") {
			t.Errorf("unexpected credentials")
		}
		w.WriteHeader(200)
	}))
	defer server.Close()
	p := NewAwsProvider()
	args := map[string]interface{}{}
	if err := p.InitFloci("app", "stage", server.URL, args); err != nil {
		t.Fatal(err)
	}
	creds, err := p.Config().Credentials.Retrieve(context.Background())
	if err != nil || creds.AccessKeyID != "test" {
		t.Fatalf("credentials: %v %v", creds, err)
	}
	_, err = s3.NewFromConfig(p.Config()).PutObject(context.Background(), &s3.PutObjectInput{Bucket: aws.String("bucket"), Key: aws.String("key"), Body: strings.NewReader("test")})
	if err != nil {
		t.Fatal(err)
	}
	r, _ := http.NewRequest("GET", "https://sts.amazonaws.com", nil)
	if _, err := p.Config().HTTPClient.Do(r); err == nil {
		t.Fatal("AWS request escaped")
	}
	if _, err := p.Bootstrap("eu-west-1"); err == nil {
		t.Fatal("accepted different region")
	}
}

func TestFlociRejectsCredentialOverrides(t *testing.T) {
	for _, key := range []string{"profile", "assumeRoles", "accessKey", "secretKey", "token", "endpoints"} {
		t.Run(key, func(t *testing.T) {
			if err := NewAwsProvider().InitFloci("app", "stage", "http://127.0.0.1:4566", map[string]interface{}{key: "override"}); err == nil {
				t.Fatal("accepted override")
			}
		})
	}
}

func TestFlociEnvironment(t *testing.T) {
	env := FlociEnvironment([]string{"PATH=/bin", "AWS_PROFILE=prod", "AWS_ENDPOINT_URL_S3=https://s3.amazonaws.com", "AWS_SESSION_TOKEN=secret", "HTTPS_PROXY=https://external", "SST_AWS_ACCESS_KEY_ID=real"}, "http://127.0.0.1:4566")
	joined := strings.Join(env, "\n")
	for _, bad := range []string{"prod", "amazonaws.com", "secret", "external", "=real"} {
		if strings.Contains(joined, bad) {
			t.Errorf("inherited %s", bad)
		}
	}
	for _, want := range []string{"PATH=/bin", "AWS_ACCESS_KEY_ID=test", "AWS_ENDPOINT_URL=http://127.0.0.1:4566", "AWS_EC2_METADATA_DISABLED=true"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %s", want)
		}
	}
}

func TestProviderCanSwitchFlociAWSFloci(t *testing.T) {
	// Load real SDK shared-profile configuration without contacting AWS. An
	// already-cached bootstrap keeps this credential/target regression offline.
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(key, "AWS_") || strings.HasPrefix(key, "SST_AWS_") {
			t.Setenv(key, "")
		}
	}
	dir := t.TempDir()
	credentials := filepath.Join(dir, "credentials")
	if err := os.WriteFile(credentials, []byte("[switch-test]\naws_access_key_id=cloud-fixture\naws_secret_access_key=fixture-secret\n"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AWS_SHARED_CREDENTIALS_FILE", credentials)
	t.Setenv("AWS_CONFIG_FILE", os.DevNull)
	t.Setenv("AWS_PROFILE", "switch-test")
	t.Setenv("AWS_EC2_METADATA_DISABLED", "true")
	args := func() map[string]interface{} {
		return map[string]interface{}{"region": "us-east-1", "version": "7.48.0"}
	}
	local := NewAwsProvider()
	if err := local.InitFloci("same-app", "same-stage", "http://127.0.0.1:4566", args()); err != nil {
		t.Fatal(err)
	}
	cloud := NewAwsProvider()
	cloud.bootstrapCache["us-east-1"] = &AwsBootstrapData{}
	cloudArgs := args()
	if err := cloud.Init("same-app", "same-stage", cloudArgs); err != nil {
		t.Fatal(err)
	}
	creds, err := cloud.Config().Credentials.Retrieve(context.Background())
	if err != nil || creds.AccessKeyID != "cloud-fixture" {
		t.Fatalf("cloud did not use its shared profile: %v", err)
	}
	if cloud.floci || cloud.Config().BaseEndpoint != nil || cloudArgs["endpoints"] != nil || cloudArgs["accessKey"] != nil {
		t.Fatal("local target settings leaked into AWS")
	}
	returning := NewAwsProvider()
	if err := returning.InitFloci("same-app", "same-stage", "http://127.0.0.1:4566", args()); err != nil {
		t.Fatal(err)
	}
	creds, err = returning.Config().Credentials.Retrieve(context.Background())
	if err != nil || creds.AccessKeyID != "test" || aws.ToString(returning.Config().BaseEndpoint) != "http://127.0.0.1:4566" {
		t.Fatal("returning to Floci did not restore its isolated target")
	}
	if os.Getenv("AWS_PROFILE") != "switch-test" || os.Getenv("AWS_ENDPOINT_URL") != "" {
		t.Fatal("switching targets mutated the parent environment")
	}
}
