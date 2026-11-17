package transport

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/appsync"
	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/bridge"
	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/bridge/transporttest"
	"github.com/sst/sst/v3/pkg/project/provider"
)

// The stub reaches any Event API while it's the shared one, as the 4.x
// components let it, or only the stage's own. The JSON is what the program
// gets from Dev.Stub.
func TestAppSyncStub(t *testing.T) {
	for name, c := range map[string]struct {
		api  provider.AppSync
		want string
	}{
		"shared": {
			api:  provider.AppSync{Http: "h.example.com", Realtime: "r.example.com", Arn: "arn:aws:appsync:us-east-1:1:apis/sst", Shared: true},
			want: `{"environment":{"SST_APPSYNC_HTTP":"h.example.com","SST_APPSYNC_REALTIME":"r.example.com"},"permissions":[{"actions":["appsync:*"],"resources":["*"]}]}`,
		},
		"the stage's own": {
			api:  provider.AppSync{Http: "h.example.com", Realtime: "r.example.com", Arn: "arn:aws:appsync:us-east-1:1:apis/app-dev"},
			want: `{"environment":{"SST_APPSYNC_HTTP":"h.example.com","SST_APPSYNC_REALTIME":"r.example.com"},"permissions":[{"actions":["appsync:*"],"resources":["arn:aws:appsync:us-east-1:1:apis/app-dev","arn:aws:appsync:us-east-1:1:apis/app-dev/*"]}]}`,
		},
	} {
		got, _ := json.Marshal(appsyncStub(&c.api))
		if string(got) != c.want {
			t.Fatalf("%v: %s", name, got)
		}
	}
}

// The transport suite, against the account's shared Event API, which sst dev
// uses by default. Its events go on channels of the test's own.
func TestAppSyncSuite(t *testing.T) {
	if os.Getenv("SST_TEST_AWS_APPSYNC") == "" {
		t.Skip("set SST_TEST_AWS_APPSYNC=1, with AWS credentials and a region, to run against a real Event API")
	}
	aws := provider.NewAwsProvider()
	if err := aws.Init("sst-transport-suite", "test", map[string]interface{}{}); err != nil {
		t.Fatalf("initializing AWS: %v", err)
	}
	transport := NewAppSync(aws, provider.AppSyncScope{}, "sst-transport-suite", "test")
	transporttest.Run(t, transporttest.Options{
		// each test's connections close when it ends
		Connect: func(t *testing.T) bridge.Conn {
			conn, err := transport.Connect(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			return conn
		},
		Reconnect: func(t *testing.T, conn bridge.Conn) {
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			conn.(*appsync.Connection).Reconnect(ctx)
		},
	})
}
