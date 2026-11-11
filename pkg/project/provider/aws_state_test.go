package provider

import (
	"bytes"
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/aws/retry"
	"github.com/aws/aws-sdk-go-v2/credentials"
)

// A state write S3 asks to retry is sent again whole, gzipped or not
func TestAwsHomeRetriesWholeWrites(t *testing.T) {
	for _, compress := range []bool{false, true} {
		t.Run(fmt.Sprintf("compressed %v", compress), func(t *testing.T) {
			var puts int
			var stored []byte
			var encoding string
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPut || r.URL.Path != "/app/my-app/dev.json" {
					http.NotFound(w, r)
					return
				}
				body, _ := io.ReadAll(r.Body)
				puts++
				if puts == 1 {
					w.WriteHeader(http.StatusInternalServerError)
					w.Write([]byte(`<Error><Code>InternalError</Code><Message>try again</Message></Error>`))
					return
				}
				stored = body
				encoding = r.Header.Get("Content-Encoding")
			}))
			defer server.Close()
			// Every host the client asks for is the test server
			transport := &http.Transport{
				DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
					return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
				},
				TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
			}
			home := NewAwsHome(&AwsProvider{
				config: aws.Config{
					Region:       "us-east-1",
					Credentials:  credentials.NewStaticCredentialsProvider("id", "secret", ""),
					HTTPClient:   &http.Client{Transport: transport},
					BaseEndpoint: aws.String("https://s3.test"),
					Retryer: func() aws.Retryer {
						return retry.NewStandard(func(o *retry.StandardOptions) {
							o.Backoff = retry.BackoffDelayerFunc(func(int, error) (time.Duration, error) { return 0, nil })
						})
					},
				},
				bootstrapCache: map[string]*AwsBootstrapData{"us-east-1": {State: "sst-state"}},
			}, compress)

			state := []byte(`{"version":3,"checkpoint":{"stack":"dev"}}`)
			if err := PushPartialState(home, "update", "my-app", "dev", state); err != nil {
				t.Fatal(err)
			}
			if puts != 2 {
				t.Fatalf("expected the write to be sent twice, got %d", puts)
			}
			if compress != (encoding == "gzip") {
				t.Fatalf("compressed %v, but the write's Content-Encoding is %q", compress, encoding)
			}
			decoded, err := gzipDecode(bytes.NewReader(stored))
			if err != nil {
				t.Fatal(err)
			}
			got, _ := io.ReadAll(decoded)
			if !bytes.Equal(got, state) {
				t.Fatalf("expected %s to be stored, got %q", state, got)
			}
		})
	}
}
