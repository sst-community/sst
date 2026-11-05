package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/sst/sst/v3/pkg/project"
)

type Echo struct{}

func (Echo) Say(input *string, output *string) error {
	*output = "said " + *input
	return nil
}

// newTestServer starts a server with one RPC method, Echo.Say, and a route
// for one worker.
func newTestServer(t *testing.T) *Server {
	t.Helper()
	s, err := New()
	if err != nil {
		t.Fatal(err)
	}
	s.Rpc.RegisterName("Echo", Echo{})
	s.HandleWorker("GET", "/2018-06-01/runtime/invocation/next", func(w http.ResponseWriter, r *http.Request) {
		body := "next for " + r.PathValue("workerID")
		if run := r.PathValue("run"); run != "" {
			body += " run " + run
		}
		w.Write([]byte(body))
	})
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go s.Serve(ctx)
	return s
}

func get(t *testing.T, address string) (int, string) {
	t.Helper()
	resp, err := http.Get(address)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body)
}

// call makes a JSON-RPC call as the platform's rpc.call does, and as the code
// Pulumi stored with each dynamic resource does: to the path of
// new URL(SST_SERVER + "/rpc"), with nothing else from the URL.
func call(t *testing.T, sstServer string, method string, arg string) (int, string) {
	t.Helper()
	u, err := url.Parse(sstServer + "/rpc")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]interface{}{"jsonrpc": "1.0", "method": method, "params": []string{arg}, "id": 1})
	resp, err := http.Post("http://"+u.Host+u.Path, "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(out)
}

func TestServerListensOnLoopbackOnly(t *testing.T) {
	s := newTestServer(t)
	addr := s.listener.Addr().(*net.TCPAddr)
	if !addr.IP.Equal(net.IPv4(127, 0, 0, 1)) {
		t.Fatalf("listening on %v", addr)
	}
	u, err := url.Parse(s.URL())
	if err != nil {
		t.Fatal(err)
	}
	if u.Hostname() != "127.0.0.1" {
		t.Fatalf("the URL's host is %v", u.Host)
	}
}

// The RPC answers at SST_SERVER + "/rpc", as today's program and the code
// stored with each dynamic resource call it, and nowhere without the token.
func TestServerRpcTakesTheToken(t *testing.T) {
	s := newTestServer(t)
	status, body := call(t, s.URL(), "Echo.Say", "hi")
	if status != http.StatusOK || !strings.Contains(body, `"said hi"`) {
		t.Fatalf("with the token: %v %v", status, body)
	}
	root := "http://" + s.listener.Addr().String()
	for _, server := range []string{
		root,
		root + "/" + strings.Repeat("0", len(s.token)),
		root + "/" + s.token[:len(s.token)-1],
		root + "/" + s.token + "x",
	} {
		status, body := call(t, server, "Echo.Say", "hi")
		if status != http.StatusNotFound || strings.Contains(body, "said") {
			t.Fatalf("%v: %v %v", strings.Replace(server, s.token, "<token>", 1), status, body)
		}
	}
	other := newTestServer(t)
	if other.token == s.token || other.URL() == s.URL() {
		t.Fatal("two servers share a token or a port")
	}
	if status, _ := call(t, other.URL()[:strings.LastIndex(other.URL(), "/")]+"/"+s.token, "Echo.Say", "hi"); status != http.StatusNotFound {
		t.Fatalf("another server's token was taken: %v", status)
	}
}

func TestServerRoutesTakeTheirMethod(t *testing.T) {
	s := newTestServer(t)
	if status, _ := get(t, s.URL()+"/rpc"); status != http.StatusMethodNotAllowed {
		t.Fatalf("GET /rpc: %v", status)
	}
	resp, err := http.Post("http://"+s.WorkerAddress("w1")+"/2018-06-01/runtime/invocation/next", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("POST next: %v", resp.StatusCode)
	}
}

// A worker reaches its own routes, and nothing else: not another worker's,
// not the RPC, not the routes under the token.
func TestServerWorkerRoutes(t *testing.T) {
	s := newTestServer(t)
	next := "/2018-06-01/runtime/invocation/next"
	if status, body := get(t, "http://"+s.WorkerAddress("w1")+next); status != http.StatusOK || body != "next for w1" {
		t.Fatalf("its own route: %v %v", status, body)
	}
	root := "http://" + s.listener.Addr().String()
	w1 := s.WorkerAddress("w1")
	key := w1[strings.LastIndex(w1, ".")+1:]
	for name, address := range map[string]string{
		"no key":           root + "/lambda/w1" + next,
		"another's key":    root + "/lambda/w2." + key + next,
		"the server token": root + "/lambda/w1." + s.token + next,
		"an empty key":     root + "/lambda/w1." + next,
	} {
		if status, body := get(t, address); status != http.StatusNotFound {
			t.Fatalf("%v: %v %v", name, status, body)
		}
	}
	// the worker's key isn't the token
	if status, _ := call(t, root+"/"+key, "Echo.Say", "hi"); status != http.StatusNotFound {
		t.Fatalf("a worker's key reached the RPC: %v", status)
	}
	if status, _ := call(t, "http://"+w1, "Echo.Say", "hi"); status != http.StatusNotFound {
		t.Fatalf("a worker's address reached the RPC: %v", status)
	}
	// a worker id with a dot in it is still its own
	if status, body := get(t, "http://"+s.WorkerAddress("w1.x")+next); status != http.StatusOK || body != "next for w1.x" {
		t.Fatalf("a worker id with a dot: %v %v", status, body)
	}
	if status, _ := get(t, root+"/lambda/w1.x"+next); status != http.StatusNotFound {
		t.Fatalf("w1 with x as its key: %v", status)
	}

	// one start of a worker's process has a key of its own, and its routes see
	// which start it is
	if status, body := get(t, "http://"+s.WorkerRunAddress("w1", "r1")+next); status != http.StatusOK || body != "next for w1 run r1" {
		t.Fatalf("a start's own route: %v %v", status, body)
	}
	r1 := s.WorkerRunAddress("w1", "r1")
	r1Key := r1[strings.LastIndex(r1, ".")+1 : strings.LastIndex(r1, "/")]
	for name, address := range map[string]string{
		"the worker's key for a start":  root + "/lambda/w1." + key + "/r1" + next,
		"a start's key for another":     root + "/lambda/w1." + r1Key + "/r2" + next,
		"a start's key for the worker":  root + "/lambda/w1." + r1Key + next,
		"a start's key for another one": root + "/lambda/w2." + r1Key + "/r1" + next,
		// w1 with r1 as the worker id w1/r1
		"a start's key with a / sent": root + "/lambda/w1%2Fr1." + r1Key + next,
	} {
		if status, body := get(t, address); status != http.StatusNotFound {
			t.Fatalf("%v: %v %v", name, status, body)
		}
	}
}

// The server file holds the token, so only its owner can read it, even when
// an old one, readable by anyone, was left behind.
func TestServerFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "dev.server")
	if err := os.WriteFile(path, []byte("http://0.0.0.0:13557"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := writeServerFile(path, "http://127.0.0.1:1/token"); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
		t.Fatalf("the server file's mode is %v", info.Mode().Perm())
	}
	if got, _ := os.ReadFile(path); string(got) != "http://127.0.0.1:1/token" {
		t.Fatalf("the server file holds %q", got)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("left in the folder: %v", entries)
	}

	// another CLI's file is left alone
	removeServerFile(path, "http://127.0.0.1:2/other")
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("another CLI's server file was removed: %v", err)
	}
	removeServerFile(path, "http://127.0.0.1:1/token")
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("the server file is still there: %v", err)
	}
}

// The code Pulumi stored with each of SST 4's dynamic resources, here as
// v4.23.1 stored it in a recorded state, reaches the RPC: it calls
// SST_SERVER + "/rpc", so it carries the token. Pulumi runs that code, not the
// program's, to read or delete one. The RPC serves none of their methods, and
// the code takes a missing one as done: a read keeps what the state has, so
// `sst refresh` runs on a stage that hasn't moved, and a delete deletes
// nothing, so `sst remove` refuses one (pkg/project, refuseUnmoved).
func TestServerTakesStoredProviderCode(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node isn't installed")
	}
	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "states", "v4.23.1", "serverless-dev.json"))
	if err != nil {
		t.Fatal(err)
	}
	var state struct {
		Checkpoint struct {
			Latest struct {
				Resources []struct {
					Type    string                 `json:"type"`
					Outputs map[string]interface{} `json:"outputs"`
				} `json:"resources"`
			} `json:"latest"`
		} `json:"checkpoint"`
	}
	if err := json.Unmarshal(data, &state); err != nil {
		t.Fatal(err)
	}
	stored := ""
	for _, resource := range state.Checkpoint.Latest.Resources {
		if code, ok := resource.Outputs["__provider"].(string); ok && strings.Contains(code, `"Aws.HostedZoneLookup"`) {
			stored = code
			break
		}
	}
	if stored == "" {
		t.Fatal("no HostedZoneLookup in the recorded state")
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "provider.js"), []byte(stored), 0644); err != nil {
		t.Fatal(err)
	}
	driver := `const provider = require(process.argv[1]).handler();
	provider.read("zone", { zoneId: "Z1" })
		.then((read) => provider.delete("zone", {}).then(() => console.log("read " + read.props.zoneId + ", deleted")))
		.catch((err) => console.log("failed: " + err.message))`

	s, err := New()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go s.Start(ctx, &project.Project{})
	run := func(sstServer string) string {
		cmd := exec.Command(node, "-e", driver, filepath.Join(dir, "provider.js"))
		cmd.Env = append(os.Environ(), "SST_SERVER="+sstServer)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("%v: %s", err, out)
		}
		return strings.TrimSpace(string(out))
	}

	if out := run(s.URL()); out != "read Z1, deleted" {
		t.Fatalf("with the token: %v", out)
	}
	if out := run("http://" + s.listener.Addr().String()); !strings.HasPrefix(out, "failed: Failed to call RPC: 404") {
		t.Fatalf("without the token: %v", out)
	}
}

// Discover finds `sst dev` through the file it writes, with its token, and
// not once it has exited.
func TestServerDiscoveryFile(t *testing.T) {
	t.Setenv("SST_SERVER", "")
	cfgPath := filepath.Join(t.TempDir(), "sst.config.ts")
	if err := os.Mkdir(filepath.Join(filepath.Dir(cfgPath), ".sst"), 0755); err != nil {
		t.Fatal(err)
	}
	if _, err := Discover(cfgPath, "dev"); err != ErrServerNotFound {
		t.Fatalf("found a server before one started: %v", err)
	}
	s := newTestServer(t)
	remove, err := s.WriteDiscoveryFile(cfgPath, "dev")
	if err != nil {
		t.Fatal(err)
	}
	found, err := Discover(cfgPath, "dev")
	if err != nil || found != s.URL() {
		t.Fatalf("found %q, %v", strings.Replace(found, s.token, "<token>", 1), err)
	}
	if status, body := call(t, found, "Echo.Say", "hi"); status != http.StatusOK || !strings.Contains(body, "said hi") {
		t.Fatalf("calling what was found: %v %v", status, body)
	}
	if _, err := Discover(cfgPath, "other"); err != ErrServerNotFound {
		t.Fatalf("found a server for another stage: %v", err)
	}
	remove()
	if _, err := Discover(cfgPath, "dev"); err != ErrServerNotFound {
		t.Fatalf("found a server after it exited: %v", err)
	}
}
