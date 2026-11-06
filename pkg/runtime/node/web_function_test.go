package node

import (
	"bufio"
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
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
// Exercise the real builder, encrypted links, SDK, and Node process together.
func TestWebFunctionHTTPEntrypoint(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node.js is needed to run the built HTTP server")
	}
	sdkPath, err := filepath.Abs("../../../sdk/js/src/resource/node.ts")
	if err != nil {
		t.Fatal(err)
	}
	sdkImport, err := json.Marshal(sdkPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, format := range []string{"esm", "cjs"} {
		for _, packaging := range []string{"source", "prebuilt"} {
			t.Run(format+"/"+packaging, func(t *testing.T) {
				const startupTimeout = 15 * time.Second
				const requestTimeout = 5 * time.Second
				const linkedValue = "encrypted-web-function-link"
				key := bytes.Repeat([]byte{42}, 32)
				encryptionKey := base64.StdEncoding.EncodeToString(key)
				links := map[string]json.RawMessage{
					"ApiToken": json.RawMessage(fmt.Sprintf(`{"value":%q}`, linkedValue)),
				}
				dir := t.TempDir()
				entry := filepath.Join(dir, "server.ts")
				source := fmt.Sprintf(`import { createServer } from "node:http";
import { Resource } from %s;
const endpoint = new URL("http://" + process.env.AWS_LAMBDA_HTTP_ENDPOINT);
const server = createServer((_request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({
    value: Resource.ApiToken.value,
    linkedEnvironment: Object.keys(process.env).some((key) =>
      key.startsWith("SST_RESOURCE_") && key !== "SST_RESOURCE_App"
    ) || process.env.SST_RESOURCES_JSON !== undefined,
  }));
});
server.listen(Number(endpoint.port), endpoint.hostname, () => {
  console.log(JSON.stringify(server.address()));
});
`, sdkImport)
				if err := os.WriteFile(entry, []byte(source), 0644); err != nil {
					t.Fatal(err)
				}
				input := &runtime.BuildInput{
					CfgPath:       filepath.Join(dir, "sst.config.ts"),
					FunctionID:    "HttpServer",
					Handler:       strings.TrimSuffix(entry, ".ts") + ".main",
					Runtime:       "nodejs24.x",
					Properties:    json.RawMessage(fmt.Sprintf(`{"format":%q,"architecture":"arm64"}`, format)),
					EncryptionKey: encryptionKey,
					Links:         links,
				}
				if packaging == "prebuilt" {
					input.EncryptionKey = ""
				}
				collection := runtime.NewCollection("", New("dev"))
				result, err := collection.Build(context.Background(), input)
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
				keyFile := "resource.enc"
				if packaging == "prebuilt" {
					result, err = collection.Build(context.Background(), &runtime.BuildInput{
						CfgPath:       input.CfgPath,
						FunctionID:    input.FunctionID,
						Bundle:        result.Out,
						Handler:       "bundle" + extension,
						Runtime:       input.Runtime,
						EncryptionKey: encryptionKey,
						Links:         links,
					})
					if err != nil {
						t.Fatal(err)
					}
					keyFile = filepath.Join(".sst", input.FunctionID, "resource.enc")
					if _, err := os.Stat(filepath.Join(result.Out, "resource.enc")); !os.IsNotExist(err) {
						t.Fatal("prebuilt links must use the per-function resource file")
					}
				}
				encrypted, err := os.ReadFile(filepath.Join(result.Out, keyFile))
				if err != nil {
					t.Fatal(err)
				}
				if bytes.Contains(encrypted, []byte(linkedValue)) {
					t.Fatal("encrypted resource file contains the linked value in plaintext")
				}
				block, err := aes.NewCipher(key)
				if err != nil {
					t.Fatal(err)
				}
				gcm, err := cipher.NewGCM(block)
				if err != nil {
					t.Fatal(err)
				}
				// The Node SDK uses AES-256-GCM, a zero nonce, and the trailing authentication tag.
				decrypted, err := gcm.Open(nil, make([]byte, gcm.NonceSize()), encrypted, nil)
				if err != nil {
					t.Fatal(err)
				}
				wantLinks, err := json.Marshal(links)
				if err != nil {
					t.Fatal(err)
				}
				if !bytes.Equal(decrypted, wantLinks) {
					t.Fatalf("decrypted links = %s, want %s", decrypted, wantLinks)
				}
				bundle, err := os.ReadFile(filepath.Join(result.Out, "bundle"+extension))
				if err != nil {
					t.Fatal(err)
				}
				if bytes.Contains(bundle, []byte(linkedValue)) || bytes.Contains(bundle, []byte(encryptionKey)) {
					t.Fatal("HTTP bundle contains a plaintext linked value or encryption key")
				}
				ctx, cancel := context.WithTimeout(context.Background(), startupTimeout)
				defer cancel()
				command := exec.CommandContext(ctx, node, filepath.Join(result.Out, "bundle"+extension))
				command.Dir = result.Out
				for _, item := range os.Environ() {
					if !strings.HasPrefix(item, "SST_RESOURCE_") && !strings.HasPrefix(item, "SST_KEY=") &&
						!strings.HasPrefix(item, "SST_KEY_FILE=") && !strings.HasPrefix(item, "SST_RESOURCES_JSON=") {
						command.Env = append(command.Env, item)
					}
				}
				command.Env = append(command.Env,
					"AWS_LAMBDA_HTTP_ENDPOINT=127.0.0.1:0",
					"SST_KEY="+encryptionKey,
					"SST_KEY_FILE="+keyFile,
					`SST_RESOURCE_App={"name":"test","stage":"test"}`,
				)
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
				if err != nil {
					t.Fatal(err)
				}
				var actual struct {
					Value             string
					LinkedEnvironment bool
				}
				if err := json.Unmarshal(body, &actual); err != nil {
					t.Fatalf("response: status=%d body=%q error=%v", response.StatusCode, body, err)
				}
				if response.StatusCode != http.StatusOK || actual.Value != linkedValue || actual.LinkedEnvironment {
					t.Fatalf("response: status=%d body=%q", response.StatusCode, body)
				}
			})
		}
	}
}
