// Package floci manages the isolated local AWS emulator used by sst dev.
package floci

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"slices"
	"strings"
	"time"
)

const Version = "2.3.0"
const Image = "floci/floci@sha256:e0b292df4dc9559b7b1bf4f51bdda4bb8e269276236438cd03cae661260ea8a9"
const DefaultEndpoint = "http://127.0.0.1:4566"
const containerName = "sst-floci"
const volumeName = "sst-floci-data"
const networkName = "sst-floci"
const ownershipLabel = "dev.sst.floci"

var errVersionMismatch = errors.New("Floci version does not match compatibility profile")

type Config struct {
	Endpoint, Region, Instance, StateRoot string
	identityPending                       bool
}

// ValidateEndpoint only accepts loopback addresses, without credentials or URL paths.
func ValidateEndpoint(endpoint string) error {
	u, err := url.Parse(endpoint)
	if err != nil {
		return fmt.Errorf("invalid Floci endpoint: %w", err)
	}
	ip := net.ParseIP(u.Hostname())
	if u.Scheme != "http" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || (u.Hostname() != "localhost" && (ip == nil || !ip.IsLoopback())) {
		return fmt.Errorf("Floci endpoint must be an HTTP loopback URL, for example %s", DefaultEndpoint)
	}
	return nil
}

func endpointConfig() (*Config, error) {
	endpoint := os.Getenv("SST_FLOCI_ENDPOINT")
	if endpoint == "" {
		endpoint = DefaultEndpoint
	}
	endpoint = strings.TrimRight(endpoint, "/")
	if err := ValidateEndpoint(endpoint); err != nil {
		return nil, err
	}
	if override := os.Getenv("SST_FLOCI_VERSION"); override != "" && override != Version {
		return nil, fmt.Errorf("Floci %s is not verified; this compatibility profile requires %s", override, Version)
	}
	return &Config{Endpoint: endpoint, Region: "us-east-1"}, nil
}

// LocalHTTPClient never uses ambient proxies or follows redirects off the endpoint.
func LocalHTTPClient() *http.Client {
	return &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{Proxy: nil}, CheckRedirect: func(*http.Request, []*http.Request) error { return fmt.Errorf("Floci redirects are not allowed") }}
}

func readJSON(ctx context.Context, endpoint string, target any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	res, err := LocalHTTPClient().Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("%s returned HTTP %d", endpoint, res.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(target)
}

func Ready(ctx context.Context, cfg *Config) error {
	if err := ValidateEndpoint(cfg.Endpoint); err != nil {
		return err
	}
	var init struct {
		Completed struct {
			Ready bool `json:"ready"`
		} `json:"completed"`
	}
	if err := readJSON(ctx, cfg.Endpoint+"/_floci/init", &init); err != nil {
		return fmt.Errorf("Floci is unreachable: %w", err)
	}
	if !init.Completed.Ready {
		return fmt.Errorf("Floci is not ready (completed.ready is false)")
	}
	var health struct {
		Version string `json:"version"`
	}
	if err := readJSON(ctx, cfg.Endpoint+"/_floci/health", &health); err != nil {
		return fmt.Errorf("cannot verify Floci version: %w", err)
	}
	if health.Version != Version {
		return fmt.Errorf("%w: got %q, require %s", errVersionMismatch, health.Version, Version)
	}
	return nil
}

type dockerRunner func(context.Context, ...string) ([]byte, error)

func docker(ctx context.Context, args ...string) ([]byte, error) {
	out, err := exec.CommandContext(ctx, "docker", args...).CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("docker %s: %w\n%s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return out, nil
}
func Install(ctx context.Context) error { _, err := docker(ctx, "pull", Image); return err }

type containerInfo struct {
	Mounts []struct {
		Type, Name, Source, Destination string
		RW                              bool
	}
	State  struct{ Running bool }
	Config struct {
		Image  string
		Labels map[string]string
		Env    []string
	}
	NetworkSettings struct {
		Ports map[string][]struct {
			HostIP   string `json:"HostIp"`
			HostPort string
		}
		Networks map[string]json.RawMessage
	}
}

func inspect(ctx context.Context, run dockerRunner) (*containerInfo, error) {
	// A list distinguishes an absent container from a failed daemon connection.
	out, err := run(ctx, "container", "ls", "-a", "--filter", "name=^/"+containerName+"$", "--format", "{{.Names}}")
	if err != nil {
		return nil, fmt.Errorf("Docker is unavailable; install Docker and start its daemon: %w", err)
	}
	if strings.TrimSpace(string(out)) == "" {
		return nil, nil
	}
	out, err = run(ctx, "container", "inspect", containerName)
	if err != nil {
		return nil, err
	}
	var items []containerInfo
	if err := json.Unmarshal(out, &items); err != nil {
		return nil, err
	}
	if len(items) != 1 {
		return nil, fmt.Errorf("unexpected Docker inspect response")
	}
	if items[0].Config.Labels[ownershipLabel] != "true" {
		return nil, fmt.Errorf("container %s is not managed by SST; refusing to modify it", containerName)
	}
	return &items[0], nil
}
func start(ctx context.Context, run dockerRunner) error {
	info, err := inspect(ctx, run)
	if err != nil {
		return err
	}
	if info != nil {
		if info.Config.Image != Image {
			return fmt.Errorf("managed Floci image differs from %s; stop and remove only the container with docker stop sst-floci && docker rm sst-floci, retaining the sst-floci-data volume, then run sst floci start", Image)
		}
		if info.State.Running {
			if err := checkPublishedPort(info); err != nil {
				return err
			}
		}
		if err := checkManagedEnvironment(info); err != nil {
			return err
		}
		if info.State.Running {
			return nil
		}
		fmt.Fprintln(os.Stderr, "Starting managed Floci container...")
		_, err = run(ctx, "start", containerName)
		if err != nil {
			return err
		}
		return checkStarted(ctx, run)
	}
	if _, err = run(ctx, "image", "inspect", Image); err != nil {
		fmt.Fprintln(os.Stderr, "Pulling pinned Floci image...")
		if _, err = run(ctx, "pull", Image); err != nil {
			return err
		}
	}
	if _, err = run(ctx, "network", "inspect", networkName); err != nil {
		if _, err = run(ctx, "network", "create", "--label", ownershipLabel+"=true", networkName); err != nil {
			return err
		}
	}
	labels, err := run(ctx, "network", "inspect", "--format", `{{index .Labels "dev.sst.floci"}}`, networkName)
	if err != nil {
		return err
	}
	if strings.TrimSpace(string(labels)) != "true" {
		return fmt.Errorf("network %s is not managed by SST; refusing to reuse it", networkName)
	}
	if _, err = run(ctx, "volume", "inspect", volumeName); err != nil {
		if _, err = run(ctx, "volume", "create", "--label", ownershipLabel+"=true", volumeName); err != nil {
			return err
		}
	}
	if err := checkVolume(ctx, run); err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "Creating managed Floci container with persistent storage...")
	args := []string{"run", "-d", "--name", containerName, "--label", ownershipLabel + "=true",
		"--publish", "127.0.0.1:4566:4566", "--network", networkName, "--network-alias", "localhost.floci.io",
		"--add-host", "host.docker.internal:host-gateway",
		"--volume", volumeName + ":/app/data", "--volume", "/var/run/docker.sock:/var/run/docker.sock"}
	for _, env := range managedEnvironment() {
		args = append(args, "--env", env)
	}
	args = append(args, Image)
	_, err = run(ctx, args...)
	if err != nil {
		return fmt.Errorf("could not start Floci; check port 4566 and Docker socket access: %w", err)
	}
	return checkStarted(ctx, run)
}

func managedEnvironment() []string {
	return []string{
		"FLOCI_STORAGE_MODE=persistent", "FLOCI_BASE_URL=http://localhost.floci.io:4566",
		"FLOCI_SERVICES_DOCKER_NETWORK=" + networkName,
		"FLOCI_DOCKER_RESOURCE_NAMESPACE=" + containerName,
		"FLOCI_SERVICES_ECR_REGISTRY_CONTAINER_NAME=sst-floci-ecr",
		"FLOCI_SERVICES_ECR_DOCKER_NETWORK=" + networkName,
		"FLOCI_SERVICES_LAMBDA_CONTAINER_NAME_PREFIX=" + containerName,
		"FLOCI_SERVICES_LAMBDA_DOCKER_FLAGS=--add-host host.docker.internal:host-gateway",
		"FLOCI_SERVICES_LAMBDA_DOCKER_HOST_OVERRIDE=localhost.floci.io",
	}
}
func checkManagedEnvironment(info *containerInfo) error {
	if len(info.NetworkSettings.Networks) != 1 {
		return fmt.Errorf("managed Floci must use only the sst-floci network")
	}
	if _, ok := info.NetworkSettings.Networks[networkName]; !ok {
		return fmt.Errorf("managed Floci is not attached to the sst-floci network")
	}
	data, socket := false, false
	for _, mount := range info.Mounts {
		if mount.Destination == "/app/data" {
			data = mount.Type == "volume" && mount.Name == volumeName && mount.RW
		}
		if mount.Destination == "/var/run/docker.sock" {
			socket = mount.Type == "bind" && (mount.Source == "/var/run/docker.sock" || mount.Source == "/run/host-services/docker.proxy.sock") && mount.RW
		}
	}
	if !data || !socket {
		return fmt.Errorf("managed Floci mounts differ from the expected sst-floci-data volume and Docker socket; recreate only the container, retaining the data volume")
	}

	for _, env := range managedEnvironment() {
		if !slices.Contains(info.Config.Env, env) {
			return fmt.Errorf("managed Floci configuration is outdated (%s); stop and remove only the container with docker stop sst-floci && docker rm sst-floci, retaining the sst-floci-data volume, then run sst floci start", strings.SplitN(env, "=", 2)[0])
		}
	}
	return nil
}
func checkPublishedPort(info *containerInfo) error {
	ports := info.NetworkSettings.Ports["4566/tcp"]
	if !info.State.Running || len(ports) != 1 || ports[0].HostIP != "127.0.0.1" || ports[0].HostPort != "4566" {
		return fmt.Errorf("managed Floci has no exclusive published binding at 127.0.0.1:4566; check for a port conflict, then recreate only the sst-floci container retaining its data volume")
	}
	return nil
}
func checkStarted(ctx context.Context, run dockerRunner) error {
	info, err := inspect(ctx, run)
	if err != nil {
		return err
	}
	if info == nil {
		return fmt.Errorf("managed Floci container disappeared after start")
	}
	return checkPublishedPort(info)
}

// Ensure starts only SST's managed container. Custom endpoints are checked, never managed.
// It does not create any AWS resources or instance identity.
func Ensure(ctx context.Context) (*Config, error) {
	cfg, err := endpointConfig()
	if err != nil {
		return nil, err
	}
	if os.Getenv("SST_FLOCI_ENDPOINT") != "" {
		return cfg, Ready(ctx, cfg)
	}
	if err := start(ctx, docker); err != nil {
		return nil, err
	}
	timeout, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	var last error
	for {
		last = Ready(timeout, cfg)
		if last == nil {
			return cfg, nil
		}
		if errors.Is(last, errVersionMismatch) {
			return nil, last
		}
		select {
		case <-timeout.Done():
			return nil, fmt.Errorf("Floci failed readiness: %w", last)
		case <-time.After(time.Second):
		}
	}
}
func Stop(ctx context.Context) error {
	if os.Getenv("SST_FLOCI_ENDPOINT") != "" {
		return fmt.Errorf("stop only manages SST's container; unset SST_FLOCI_ENDPOINT")
	}
	info, err := inspect(ctx, docker)
	if err != nil {
		return err
	}
	if info == nil || !info.State.Running {
		return nil
	}
	_, err = docker(ctx, "stop", containerName)
	return err
}
func Status(ctx context.Context) error { return status(ctx, docker) }

func status(ctx context.Context, run dockerRunner) error {
	cfg, err := endpointConfig()
	if err != nil {
		return err
	}
	if os.Getenv("SST_FLOCI_ENDPOINT") == "" {
		info, err := inspect(ctx, run)
		if err != nil {
			return err
		}
		if info == nil {
			return fmt.Errorf("managed Floci is not installed; run sst floci start")
		}
		if !info.State.Running {
			return fmt.Errorf("managed Floci is stopped; run sst floci start")
		}
		if err = checkPublishedPort(info); err != nil {
			return err
		}
		if info.Config.Image != Image {
			return fmt.Errorf("managed Floci image does not match the verified profile")
		}
		if err = checkManagedEnvironment(info); err != nil {
			return err
		}
	}
	return Ready(ctx, cfg)
}

func checkVolume(ctx context.Context, run dockerRunner) error {
	out, err := run(ctx, "volume", "inspect", "--format", `{{index .Labels "dev.sst.floci"}}`, volumeName)
	if err != nil {
		return err
	}
	if strings.TrimSpace(string(out)) != "true" {
		return fmt.Errorf("volume %s is not managed by SST; refusing to modify it", volumeName)
	}
	return nil
}

// Floci 2.3.0 prefixes the configured registry container name with "floci-aws-".
const registryName = "floci-aws-sst-floci-ecr"

// Floci labels and network membership establish ownership of its ECR child.
func managedRegistry(ctx context.Context, run dockerRunner) (bool, error) {
	out, err := run(ctx, "container", "ls", "-a", "--filter", "name=^/"+registryName+"$", "--format", "{{.Names}}")
	if err != nil {
		return false, err
	}
	if strings.TrimSpace(string(out)) == "" {
		return false, nil
	}
	out, err = run(ctx, "container", "inspect", registryName)
	if err != nil {
		return false, err
	}
	var items []containerInfo
	if err = json.Unmarshal(out, &items); err != nil {
		return false, err
	}
	if len(items) != 1 {
		return false, fmt.Errorf("unexpected ECR container inspect response")
	}
	info := items[0]
	_, network := info.NetworkSettings.Networks[networkName]
	if !network || info.Config.Labels["io.floci.owner"] != "sst-floci/4566" || info.Config.Labels["io.floci.service"] != "ecr" {
		return false, fmt.Errorf("ECR sidecar %s is not owned by SST's Floci instance; refusing to remove it", registryName)
	}
	return true, nil
}

const registryVolumeName = "floci-aws-sst-floci-ecr-registry-data"

func managedRegistryVolume(ctx context.Context, run dockerRunner) (bool, error) {
	out, err := run(ctx, "volume", "ls", "--filter", "name=^"+registryVolumeName+"$", "--format", "{{.Name}}")
	if err != nil {
		return false, err
	}
	if strings.TrimSpace(string(out)) == "" {
		return false, nil
	}
	out, err = run(ctx, "volume", "inspect", "--format", `{{index .Labels "io.floci.owner"}}`, registryVolumeName)
	if err != nil {
		return false, err
	}
	if strings.TrimSpace(string(out)) != "sst-floci/4566" {
		return false, fmt.Errorf("ECR volume %s is not owned by SST's Floci instance; refusing to remove it", registryVolumeName)
	}
	return true, nil
}
