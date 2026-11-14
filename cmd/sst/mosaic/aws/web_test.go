package aws

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/bridge"
	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/bridge/web"
	"github.com/sst/sst/v3/pkg/bus"
	"github.com/sst/sst/v3/pkg/project"
)

// sst dev sends a live web function's requests to the local server its last
// deploy named, and only once a deploy named one.
func TestWebFunctionLoop(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "local "+r.URL.Path)
	}))
	defer local.Close()

	prefix := "/sst/app/stage"
	appsync := &fakeAppSync{}
	dev := bridge.NewClient(ctx, appsync, "dev", prefix)
	messages := make(chan bridge.Message, 100)
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case msg := <-dev.Read():
				if msg.Source != "dev" {
					messages <- msg
				}
			}
		}
	}()
	go webFunction(ctx, input{client: dev, prefix: prefix, msg: messages})

	worker := bridge.NewClient(ctx, appsync, "worker1", prefix+"/worker1")
	b := &web.Bridge{Client: worker, Prefix: prefix, WorkerID: "worker1", FunctionID: "Api", TakeTimeout: 2 * time.Second}
	go b.Run(ctx)
	b.Probe(ctx)
	front := httptest.NewServer(b)
	defer front.Close()

	get := func() (int, string) {
		resp, err := http.Get(front.URL + "/hello")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(body)
	}
	// before a deploy says where its local server is
	if status, body := get(); status != 503 || !strings.Contains(body, "isn't live") {
		t.Fatalf("before the deploy: got %d %q", status, body)
	}
	bus.Publish(&project.CompleteEvent{WebFunctions: map[string]project.WebFunction{
		"Api": {Name: "Api", URL: local.URL},
	}})
	deadline := time.Now().Add(2 * time.Second)
	for {
		status, body := get()
		if status == 200 && body == "local /hello" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("after the deploy: got %d %q", status, body)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
