package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/bridge"
	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/local"
)

func TestLocalBridgeProcess(t *testing.T) {
	if os.Getenv("SST_BRIDGE_TEST_PROCESS") != "1" {
		return
	}
	if err := run(); err != nil {
		t.Fatal(err)
	}
}

// Run the actual Lambda bootstrap loop in a separate process, with the local
// transport and a Runtime API, so environment selection and request framing
// are exercised together without AWS credentials or Docker.
func TestLocalBridgeRuntimeInvocation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	const token = "01234567890123456789012345678901"
	handler, _ := local.NewServer(token)
	transport := httptest.NewServer(handler)
	defer transport.Close()
	conn, _ := local.Dial(transport.URL, token)
	cli := bridge.NewClient(ctx, conn, "dev", "/sst/test/local")
	response := make(chan string, 1)
	runtimeAPI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/2018-06-01/runtime/invocation/next":
			w.Header().Set("Lambda-Runtime-Aws-Request-Id", "request-1")
			io.WriteString(w, `{"hello":"local"}`)
		case "/2018-06-01/runtime/invocation/request-1/response":
			body, _ := io.ReadAll(r.Body)
			select {
			case response <- string(body):
			default:
			}
			w.WriteHeader(202)
		default:
			http.Error(w, "unexpected runtime request", 500)
		}
	}))
	defer runtimeAPI.Close()
	command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestLocalBridgeProcess$")
	command.Env = []string{
		"SST_BRIDGE_TEST_PROCESS=1", "SST_APP=test", "SST_STAGE=local", "SST_FUNCTION_ID=handler",
		"SST_FLOCI_BRIDGE=" + transport.URL, "SST_FLOCI_TOKEN=" + token,
		"AWS_LAMBDA_RUNTIME_API=" + strings.TrimPrefix(runtimeAPI.URL, "http://"),
		"AWS_EC2_METADATA_DISABLED=true", "AWS_CONFIG_FILE=" + os.DevNull, "AWS_SHARED_CREDENTIALS_FILE=" + os.DevNull,
	}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { cancel(); command.Wait() }()
	sawInit := false
	for {
		select {
		case message := <-cli.Read():
			switch message.Type {
			case bridge.MessageInit:
				var init bridge.InitBody
				if err := json.NewDecoder(message.Body).Decode(&init); err != nil {
					t.Fatal(err)
				}
				if init.FunctionID != "handler" {
					t.Fatalf("function: %s", init.FunctionID)
				}
				for _, entry := range init.Environment {
					if strings.HasPrefix(entry, "SST_FLOCI_TOKEN=") {
						t.Fatal("token leaked to worker")
					}
				}
				sawInit = true
			case bridge.MessageNext:
				body, err := io.ReadAll(message.Body)
				if err != nil {
					t.Fatal(err)
				}
				if !strings.Contains(string(body), `{"hello":"local"}`) {
					t.Fatalf("invocation: %s", body)
				}
				writer := cli.NewWriter(bridge.MessageResponse, "/sst/test/local/"+message.Source+"/in")
				writer.SetID("request-1")
				io.WriteString(writer, `{"ok":true}`)
				if err := writer.Close(); err != nil {
					t.Fatal(err)
				}
			}
		case body := <-response:
			if !sawInit {
				t.Fatal("missing worker init")
			}
			if body != `{"ok":true}` {
				t.Fatalf("runtime response: %s", body)
			}
			return
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}
