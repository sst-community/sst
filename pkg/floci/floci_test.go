package floci

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestValidateEndpoint(t *testing.T) {
	for _, endpoint := range []string{"http://127.0.0.1:4566", "http://localhost:4567", "http://[::1]:4566"} {
		if err := ValidateEndpoint(endpoint); err != nil {
			t.Errorf("%s: %v", endpoint, err)
		}
	}
	for _, endpoint := range []string{"https://aws.amazon.com", "http://169.254.169.254", "http://localhost.evil.test", "http://user@localhost:4566", "http://localhost/path", "http://localhost?x=y", "http://localhost/#x", "http://localhost.floci.io:4566"} {
		if err := ValidateEndpoint(endpoint); err == nil {
			t.Errorf("accepted %s", endpoint)
		}
	}
}
func TestReadiness(t *testing.T) {
	for _, tc := range []struct {
		name, init, version string
		ok                  bool
	}{
		{"ready", `{"completed":{"ready":true}}`, Version, true},
		{"old shape", `{"ready":true}`, Version, false},
		{"starting", `{"completed":{"ready":false}}`, Version, false},
		{"wrong version", `{"completed":{"ready":true}}`, "99.0.0", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/_floci/init" {
					fmt.Fprint(w, tc.init)
				} else {
					fmt.Fprintf(w, `{"version":%q}`, tc.version)
				}
			}))
			defer server.Close()
			err := Ready(context.Background(), &Config{Endpoint: server.URL})
			if (err == nil) != tc.ok {
				t.Fatalf("Ready()=%v", err)
			}
		})
	}
}
func TestReadinessRejectsRedirect(t *testing.T) {
	reached := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached = true }))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, http.StatusFound) }))
	defer server.Close()
	if err := Ready(context.Background(), &Config{Endpoint: server.URL}); err == nil || reached {
		t.Fatalf("redirect escaped: %v, reached=%v", err, reached)
	}
}
func TestStartPreservesManagedContainer(t *testing.T) {
	for _, running := range []bool{true, false} {
		var commands []string
		err := start(context.Background(), func(_ context.Context, args ...string) ([]byte, error) {
			command := strings.Join(args, " ")
			commands = append(commands, command)
			switch command {
			case "container ls -a --filter name=^/sst-floci$ --format {{.Names}}":
				return []byte(containerName), nil
			case "container inspect sst-floci":
				return managedInspect(running || len(commands) > 3, true), nil
			case "start sst-floci":
				return nil, nil
			default:
				return nil, fmt.Errorf("unexpected mutation: %s", command)
			}
		})
		if err != nil {
			t.Fatal(err)
		}
		if running && len(commands) != 2 {
			t.Fatal(commands)
		}
		if !running && len(commands) != 5 {
			t.Fatal(commands)
		}
	}
}
func TestStartRefusesUnownedContainer(t *testing.T) {
	calls := 0
	err := start(context.Background(), func(_ context.Context, args ...string) ([]byte, error) {
		calls++
		if calls == 1 {
			return []byte(containerName), nil
		}
		return []byte(`[{"Config":{"Labels":{}}}]`), nil
	})
	if err == nil || !strings.Contains(err.Error(), "not managed") || calls != 2 {
		t.Fatalf("%v (%d calls)", err, calls)
	}
}
func TestStartPersistentConfiguration(t *testing.T) {
	var runArgs string
	err := start(context.Background(), func(_ context.Context, args ...string) ([]byte, error) {
		command := strings.Join(args, " ")
		if args[0] == "container" {
			if runArgs == "" {
				return nil, nil
			}
			if args[1] == "ls" {
				return []byte(containerName), nil
			}
			return managedInspect(true, true), nil
		}
		if (args[0] == "volume" || args[0] == "network") && len(args) > 2 && args[2] == "--format" {
			return []byte("true"), nil
		}
		if args[0] == "run" {
			runArgs = command
		}
		return nil, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, part := range []string{Image, "127.0.0.1:4566:4566", "FLOCI_STORAGE_MODE=persistent", "FLOCI_BASE_URL=http://localhost.floci.io:4566", "FLOCI_SERVICES_LAMBDA_DOCKER_FLAGS=--add-host host.docker.internal:host-gateway", "FLOCI_SERVICES_LAMBDA_DOCKER_HOST_OVERRIDE=localhost.floci.io", volumeName + ":/app/data", "FLOCI_DOCKER_RESOURCE_NAMESPACE=sst-floci", "FLOCI_SERVICES_ECR_REGISTRY_CONTAINER_NAME=sst-floci-ecr", "FLOCI_SERVICES_ECR_DOCKER_NETWORK=sst-floci", "FLOCI_SERVICES_LAMBDA_CONTAINER_NAME_PREFIX=sst-floci"} {
		if !strings.Contains(runArgs, part) {
			t.Errorf("missing %s in %s", part, runArgs)
		}
	}
}
func TestIdentityAndResetDetection(t *testing.T) {
	oldConfigDir := configDir
	root := t.TempDir()
	configDir = func() string { return root }
	defer func() { configDir = oldConfigDir }()
	id := ""
	writes := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/x-amz-json-1.1")
		switch r.Header.Get("X-Amz-Target") {
		case "AmazonSSM.GetParameter":
			if id == "" {
				w.WriteHeader(400)
				fmt.Fprint(w, `{"__type":"ParameterNotFound","message":"not found"}`)
			} else {
				fmt.Fprintf(w, `{"Parameter":{"Value":%q}}`, id)
			}
		case "AmazonSSM.PutParameter":
			writes++
			var input struct{ Value string }
			json.NewDecoder(r.Body).Decode(&input)
			id = input.Value
			fmt.Fprint(w, `{"Version":1}`)
		default:
			t.Errorf("unexpected target %s", r.Header.Get("X-Amz-Target"))
			w.WriteHeader(400)
		}
	}))
	defer server.Close()
	cfg := &Config{Endpoint: server.URL, Region: "us-east-1"}
	if err := ReadIdentity(context.Background(), cfg, "app", "dev"); err != nil {
		t.Fatal(err)
	}
	if writes != 0 || cfg.Instance == "" {
		t.Fatal("read-only preflight mutated identity")
	}
	reserved := cfg.Instance
	if err := EnsureIdentity(context.Background(), cfg, "app", "dev"); err != nil {
		t.Fatal(err)
	}
	if cfg.Instance != reserved {
		t.Fatal("reserved identity changed")
	}
	if writes != 1 {
		t.Fatal(writes)
	}
	first := cfg.Instance
	if err := EnsureIdentity(context.Background(), cfg, "app", "dev"); err != nil {
		t.Fatal(err)
	}
	if writes != 1 || cfg.Instance != first {
		t.Fatal("identity changed on reuse")
	}
	id = ""
	if err := ReadIdentity(context.Background(), cfg, "app", "dev"); err == nil || !strings.Contains(err.Error(), "reset --stage dev") {
		t.Fatalf("reset not detected: %v", err)
	}
	if writes != 1 {
		t.Fatal("reset detection wrote identity")
	}
	id = uuid.NewString()
	if err := ReadIdentity(context.Background(), cfg, "app", "dev"); err == nil {
		t.Fatal("replacement instance not detected")
	}
	if markerPath(cfg, "app", "dev") == markerPath(&Config{Endpoint: server.URL + "2"}, "app", "dev") {
		t.Fatal("endpoints share a marker")
	}
	if !strings.HasPrefix(cfg.StateRoot, filepath.Join(root, "floci")) {
		t.Fatal(cfg.StateRoot)
	}
	if _, err := os.Stat(markerPath(cfg, "app", "dev")); err != nil {
		t.Fatal(err)
	}
}

func TestCustomResetClearsOnlySelectedStage(t *testing.T) {
	oldConfigDir := configDir
	root := t.TempDir()
	configDir = func() string { return root }
	defer func() { configDir = oldConfigDir }()
	t.Setenv("SST_FLOCI_ENDPOINT", "http://127.0.0.1:9999")
	cfg := &Config{Endpoint: "http://127.0.0.1:9999"}
	id := uuid.NewString()
	for _, stage := range []string{"dev", "keep"} {
		marker := markerPath(cfg, "app", stage)
		if err := os.MkdirAll(filepath.Dir(marker), 0700); err != nil {
			t.Fatal(err)
		}
		data, _ := json.Marshal(stageMarker{Instance: id, App: "app", Stage: stage})
		if err := os.WriteFile(marker, data, 0600); err != nil {
			t.Fatal(err)
		}
		for _, key := range []string{"app", "secret", "passphrase", "lock", "update", "summary", "eventlog", "snapshot"} {
			path := filepath.Join(root, "floci", id, "state", key, "app", stage+".json")
			if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte("state"), 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
	noDocker := func(context.Context, ...string) ([]byte, error) {
		t.Fatal("custom reset called Docker")
		return nil, nil
	}
	if err := reset(context.Background(), "dev", noDocker); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(markerPath(cfg, "app", "dev")); !os.IsNotExist(err) {
		t.Fatal("dev marker retained")
	}
	if _, err := os.Stat(markerPath(cfg, "app", "keep")); err != nil {
		t.Fatal("other marker removed")
	}
	for _, key := range []string{"app", "secret", "passphrase", "lock", "update", "summary", "eventlog", "snapshot"} {
		if _, err := os.Stat(filepath.Join(root, "floci", id, "state", key, "app", "dev.json")); !os.IsNotExist(err) {
			t.Errorf("%s retained", key)
		}
		if _, err := os.Stat(filepath.Join(root, "floci", id, "state", key, "app", "keep.json")); err != nil {
			t.Errorf("%s other stage removed", key)
		}
	}
	if err := reset(context.Background(), "", noDocker); err == nil {
		t.Fatal("custom full reset allowed")
	}
}

func TestIdentityRaceDoesNotSwitchState(t *testing.T) {
	oldConfigDir := configDir
	root := t.TempDir()
	configDir = func() string { return root }
	defer func() { configDir = oldConfigDir }()
	id := ""
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/x-amz-json-1.1")
		if r.Header.Get("X-Amz-Target") == "AmazonSSM.PutParameter" {
			id = uuid.NewString()
			w.WriteHeader(400)
			fmt.Fprint(w, `{"__type":"ParameterAlreadyExists","message":"race"}`)
			return
		}
		if id == "" {
			w.WriteHeader(400)
			fmt.Fprint(w, `{"__type":"ParameterNotFound"}`)
			return
		}
		fmt.Fprintf(w, `{"Parameter":{"Value":%q}}`, id)
	}))
	defer server.Close()
	cfg := &Config{Endpoint: server.URL, Region: "us-east-1"}
	if err := ReadIdentity(context.Background(), cfg, "app", "dev"); err != nil {
		t.Fatal(err)
	}
	reserved, stateRoot := cfg.Instance, cfg.StateRoot
	if err := ReadIdentity(context.Background(), cfg, "app", "dev"); err != nil {
		t.Fatal(err)
	}
	if cfg.Instance != reserved {
		t.Fatal("repeated preflight changed reservation")
	}
	if err := EnsureIdentity(context.Background(), cfg, "app", "dev"); err == nil {
		t.Fatal("race allowed")
	}
	if cfg.Instance != reserved || cfg.StateRoot != stateRoot {
		t.Fatal("race switched local state")
	}
	if _, err := os.Stat(markerPath(cfg, "app", "dev")); !os.IsNotExist(err) {
		t.Fatal("race persisted stage marker")
	}
}

func managedInspect(running, bound bool) []byte {
	ports := []map[string]string{}
	if bound {
		ports = append(ports, map[string]string{"HostIp": "127.0.0.1", "HostPort": "4566"})
	}
	data, _ := json.Marshal([]any{map[string]any{
		"State":           map[string]any{"Running": running},
		"Config":          map[string]any{"Image": Image, "Labels": map[string]string{ownershipLabel: "true"}, "Env": managedEnvironment()},
		"NetworkSettings": map[string]any{"Ports": map[string]any{"4566/tcp": ports}, "Networks": map[string]any{networkName: map[string]any{}}},
		"Mounts":          []map[string]any{{"Type": "volume", "Name": volumeName, "Destination": "/app/data", "RW": true}, {"Type": "bind", "Source": "/var/run/docker.sock", "Destination": "/var/run/docker.sock", "RW": true}},
	}})
	return data
}
func TestStartRejectsMissingPublishedPort(t *testing.T) {
	for _, running := range []bool{true, false} {
		started := false
		err := start(context.Background(), func(_ context.Context, args ...string) ([]byte, error) {
			switch args[0] + " " + args[1] {
			case "container ls":
				return []byte(containerName), nil
			case "container inspect":
				return managedInspect(running || started, false), nil
			case "start sst-floci":
				started = true
				return nil, nil
			default:
				t.Fatalf("unexpected command %v", args)
				return nil, nil
			}
		})
		if err == nil || !strings.Contains(err.Error(), "port conflict") {
			t.Fatalf("running=%v: %v", running, err)
		}
	}
}
func TestStartRejectsOutdatedConfiguration(t *testing.T) {
	err := start(context.Background(), func(_ context.Context, args ...string) ([]byte, error) {
		if args[1] == "ls" {
			return []byte(containerName), nil
		}
		var data []map[string]any
		json.Unmarshal(managedInspect(true, true), &data)
		data[0]["Config"].(map[string]any)["Env"] = []string{}
		out, _ := json.Marshal(data)
		return out, nil
	})
	if err == nil || !strings.Contains(err.Error(), "configuration is outdated") {
		t.Fatal(err)
	}
}
func TestRegistryOwnership(t *testing.T) {
	for _, owned := range []bool{true, false} {
		found, err := managedRegistry(context.Background(), func(_ context.Context, args ...string) ([]byte, error) {
			if args[1] == "ls" {
				return []byte(registryName), nil
			}
			owner := "4566"
			if owned {
				owner = "sst-floci/4566"
			}
			return []byte(fmt.Sprintf(`[{"Config":{"Labels":{"io.floci.owner":%q,"io.floci.service":"ecr"}},"NetworkSettings":{"Networks":{"sst-floci":{}}}}]`, owner)), nil
		})
		if owned && (err != nil || !found) {
			t.Fatal(err)
		}
		if !owned && err == nil {
			t.Fatal("unowned registry accepted")
		}
	}
}

func TestRegistryVolumeOwnership(t *testing.T) {
	for _, owner := range []string{"sst-floci/4566", "4566", ""} {
		found, err := managedRegistryVolume(context.Background(), func(_ context.Context, args ...string) ([]byte, error) {
			if args[1] == "ls" {
				return []byte(registryVolumeName), nil
			}
			return []byte(owner), nil
		})
		if owner == "sst-floci/4566" && (err != nil || !found) {
			t.Fatal(err)
		}
		if owner != "sst-floci/4566" && err == nil {
			t.Fatalf("accepted foreign volume owner %q", owner)
		}
	}
}

func TestImageMismatchPreservesData(t *testing.T) {
	calls := 0
	err := start(context.Background(), func(_ context.Context, args ...string) ([]byte, error) {
		calls++
		if calls == 1 {
			return []byte(containerName), nil
		}
		if calls == 2 {
			return []byte(strings.ReplaceAll(string(managedInspect(true, true)), Image, "floci/floci:old")), nil
		}
		t.Fatalf("unexpected mutation: %v", args)
		return nil, nil
	})
	if err == nil || strings.Contains(err.Error(), "reset") || !strings.Contains(err.Error(), "retaining the sst-floci-data volume") {
		t.Fatalf("unsafe image recovery: %v", err)
	}
}

func TestStatusStoppedContainer(t *testing.T) {
	t.Setenv("SST_FLOCI_ENDPOINT", "")
	calls := 0
	err := status(context.Background(), func(_ context.Context, args ...string) ([]byte, error) {
		calls++
		if calls == 1 {
			return []byte(containerName), nil
		}
		return managedInspect(false, true), nil
	})
	if err == nil || !strings.Contains(err.Error(), "is stopped") || !strings.Contains(err.Error(), "sst floci start") {
		t.Fatal(err)
	}
}

func TestStartRejectsUnownedNetwork(t *testing.T) {
	err := start(context.Background(), func(_ context.Context, args ...string) ([]byte, error) {
		switch args[0] {
		case "container":
			return nil, nil
		case "image":
			return nil, nil
		case "network":
			return []byte("<no value>"), nil
		default:
			t.Fatalf("unexpected mutation: %v", args)
			return nil, nil
		}
	})
	if err == nil || !strings.Contains(err.Error(), "network sst-floci is not managed") {
		t.Fatal(err)
	}
}

func TestResetRejectsInvalidStageBeforeDocker(t *testing.T) {
	for _, stage := range []string{".", "..", "../other", "a/b"} {
		err := reset(context.Background(), stage, func(context.Context, ...string) ([]byte, error) {
			t.Fatal("Docker called for invalid stage")
			return nil, nil
		})
		if err == nil || !strings.Contains(err.Error(), "invalid Floci stage") {
			t.Fatalf("stage %q: %v", stage, err)
		}
	}
}

func TestManagedContainerRejectsWrongMountsAndNetworks(t *testing.T) {
	for _, kind := range []string{"volume", "socket", "network", "extra-network"} {
		t.Run(kind, func(t *testing.T) {
			var infos []containerInfo
			if err := json.Unmarshal(managedInspect(true, true), &infos); err != nil {
				t.Fatal(err)
			}
			info := &infos[0]
			switch kind {
			case "volume":
				info.Mounts[0].Name = "foreign-data"
			case "socket":
				info.Mounts[1].Source = "/other/socket"
			case "network":
				delete(info.NetworkSettings.Networks, networkName)
			case "extra-network":
				info.NetworkSettings.Networks["foreign"] = json.RawMessage(`{}`)
			}
			if err := checkManagedEnvironment(info); err == nil {
				t.Fatal("accepted unexpected container configuration")
			}
		})
	}
}

func TestManagedContainerAcceptsDockerDesktopSocket(t *testing.T) {
	var infos []containerInfo
	if err := json.Unmarshal(managedInspect(true, true), &infos); err != nil {
		t.Fatal(err)
	}
	infos[0].Mounts[1].Source = "/run/host-services/docker.proxy.sock"
	if err := checkManagedEnvironment(&infos[0]); err != nil {
		t.Fatal(err)
	}
}
