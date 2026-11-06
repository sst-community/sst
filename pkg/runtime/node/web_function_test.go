package node

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/sst/sst/v3/pkg/runtime"
)

// Web Functions run the bundle itself; no exported event handler or wrapper is needed.
// Exercise the real builder and Node process, rather than mocking Runtime.Build.
func TestWebFunctionHTTPEntrypoint(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node.js is needed to run the built HTTP server")
	}
	for _, format := range []string{"esm", "cjs"} {
		t.Run(format, func(t *testing.T) {
			const startupTimeout = 15 * time.Second
			const requestTimeout = 5 * time.Second
			dir := t.TempDir()
			entry := filepath.Join(dir, "server.ts")
			const source = `import { createServer } from "node:http";
const endpoint = new URL("http://" + process.env.AWS_LAMBDA_HTTP_ENDPOINT);
const server = createServer((_request, response) => response.end(process.env.GREETING));
server.listen(Number(endpoint.port), endpoint.hostname, () => {
  console.log(JSON.stringify(server.address()));
});
`
			if err := os.WriteFile(entry, []byte(source), 0644); err != nil {
				t.Fatal(err)
			}
			input := &runtime.BuildInput{
				CfgPath:    filepath.Join(dir, "sst.config.ts"),
				FunctionID: "HttpServer",
				Handler:    strings.TrimSuffix(entry, ".ts") + ".main",
				Runtime:    "nodejs24.x",
				Properties: json.RawMessage(fmt.Sprintf(`{"format":%q,"architecture":"arm64"}`, format)),
			}
			result, err := runtime.NewCollection("", New("dev")).Build(context.Background(), input)
			if err != nil {
				t.Fatal(err)
			}
			if len(result.Errors) != 0 {
				t.Fatal(result.Errors)
			}
			if result.Handler != "bundle.main" {
				t.Fatalf("handler = %q, want bundle.main", result.Handler)
			}
			extension := ".mjs"
			if format == "cjs" {
				extension = ".cjs"
			}
			if _, err := os.Stat(filepath.Join(result.Out, "resource.enc")); !os.IsNotExist(err) {
				t.Fatal("HTTP bundle should not need an encrypted handler resource file")
			}
			ctx, cancel := context.WithTimeout(context.Background(), startupTimeout)
			defer cancel()
			command := exec.CommandContext(ctx, node, filepath.Join(result.Out, "bundle"+extension))
			command.Env = append(os.Environ(), "AWS_LAMBDA_HTTP_ENDPOINT=127.0.0.1:0", "GREETING=web-function")
			var stderr strings.Builder
			command.Stderr = &stderr
			stdout, err := command.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			if err := command.Start(); err != nil {
				t.Fatal(err)
			}
			defer func() { cancel(); _ = command.Wait() }()
			scanner := bufio.NewScanner(stdout)
			if !scanner.Scan() {
				t.Fatalf("HTTP server did not listen: %s", stderr.String())
			}
			var address struct{ Port int }
			if err := json.Unmarshal(scanner.Bytes(), &address); err != nil {
				t.Fatal(err)
			}
			client := &http.Client{Timeout: requestTimeout}
			response, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/", address.Port))
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			body, err := io.ReadAll(response.Body)
			if err != nil || response.StatusCode != http.StatusOK || string(body) != "web-function" {
				t.Fatalf("response: status=%d body=%q error=%v", response.StatusCode, body, err)
			}
		})
	}
}
