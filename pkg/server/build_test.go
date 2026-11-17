package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A program Pulumi runs on its own starts the build server, reads its address,
// builds through it, and stops it by exiting, which closes its input.
func TestServeBuilds(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "Pulumi.yaml")
	write(t, cfgPath, "name: app\nruntime: nodejs\n")
	write(t, filepath.Join(dir, "src", "api.ts"), "export const handler = async () => ({ statusCode: 200 });\n")

	in, closeIn := io.Pipe()
	outRead, out := io.Pipe()
	served := make(chan error, 1)
	go func() { served <- ServeBuilds(context.Background(), cfgPath, "", "dev", in, out) }()

	line, err := bufio.NewReader(outRead).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	address := strings.TrimSpace(line)
	if !strings.HasPrefix(address, "http://127.0.0.1:") {
		t.Fatalf("address: %q", address)
	}

	// Without the token, nothing is served
	if status := post(t, strings.Join(strings.Split(address, "/")[:3], "/")+"/rpc", "Runtime.Build", nil).status; status != http.StatusNotFound {
		t.Fatalf("without the token: %d", status)
	}

	result := post(t, address+"/rpc", "Runtime.Build", map[string]any{
		"functionID": "Api",
		"handler":    "src/api.handler",
		"runtime":    "nodejs22.x",
		"properties": map[string]any{},
	})
	if result.Error != nil {
		t.Fatalf("build: %v", result.Error)
	}
	var built struct {
		Out     string   `json:"out"`
		Handler string   `json:"handler"`
		Errors  []string `json:"errors"`
	}
	if err := json.Unmarshal(result.Result, &built); err != nil {
		t.Fatal(err)
	}
	if len(built.Errors) > 0 {
		t.Fatalf("build errors: %v", built.Errors)
	}
	// The project's .sst folder, as sst dev builds a Pulumi program's
	if want := filepath.Join(dir, ".sst", "artifacts", "Api-src"); built.Out != want {
		t.Fatalf("out: %q, want %q", built.Out, want)
	}
	if _, err := os.Stat(filepath.Join(built.Out, strings.TrimSuffix(built.Handler, filepath.Ext(built.Handler))+".mjs")); err != nil {
		t.Fatalf("no bundle for handler %q: %v", built.Handler, err)
	}

	// Only the builds: none of SST's own calls
	if result := post(t, address+"/rpc", "Provider.Aws.Bootstrap", map[string]any{"region": "us-east-1"}); result.Error == nil {
		t.Fatal("Provider.Aws.Bootstrap was served")
	}

	closeIn.Close()
	select {
	case err := <-served:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("still serving after its input closed")
	}
}

type rpcResult struct {
	status int
	Result json.RawMessage `json:"result"`
	Error  any             `json:"error"`
}

func post(t *testing.T, address, method string, params any) rpcResult {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"jsonrpc": "1.0", "id": 1, "method": method, "params": []any{params}})
	resp, err := http.Post(address, "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	result := rpcResult{status: resp.StatusCode}
	if resp.StatusCode == http.StatusOK {
		if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
			t.Fatal(err)
		}
	}
	return result
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}
