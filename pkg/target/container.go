package target

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Container is what the core runs a target in. Its ports are published on
// 127.0.0.1 only, its volumes are Docker volumes of its own, and nothing of
// this machine's files is given to it but the Docker socket, when it says it
// needs it.
type Container struct {
	Image string `json:"image"`
	// Ports are published on 127.0.0.1, each at the same number.
	Ports []int             `json:"ports"`
	Env   map[string]string `json:"env"`
	// Volumes are the folders in the container that are kept when it's
	// replaced, each as a Docker volume named after the target and the name
	// given here.
	Volumes map[string]string `json:"volumes"`
	// DockerSocket gives the container this machine's Docker socket, so it can
	// start containers of its own. The core says so when it starts it.
	DockerSocket bool `json:"dockerSocket"`
}

var (
	volumePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
	envPattern    = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
)

func (c *Container) check(name string) error {
	if c.Image == "" {
		return fmt.Errorf("the %q target's container needs an image", name)
	}
	if strings.HasPrefix(c.Image, "-") || strings.ContainsAny(c.Image, " \t\n") {
		return fmt.Errorf("the %q target's container has an image name that isn't one: %q", name, c.Image)
	}
	for _, port := range c.Ports {
		if port < 1 || port > 65535 {
			return fmt.Errorf("the %q target's container has a port that isn't one: %d", name, port)
		}
	}
	for folder, volume := range c.Volumes {
		if !path.IsAbs(folder) {
			return fmt.Errorf("the %q target's container keeps %q, which isn't a folder from the container's root", name, folder)
		}
		if !volumePattern.MatchString(volume) {
			return fmt.Errorf("the %q target's container names a volume %q: lowercase letters, numbers and dashes", name, volume)
		}
	}
	for key := range c.Env {
		if !envPattern.MatchString(key) {
			return fmt.Errorf("the %q target's container has an environment variable named %q", name, key)
		}
	}
	return nil
}

// ContainerName is the name of a target's container.
func ContainerName(target string) string {
	return "sst-target-" + target
}

// The label that marks a container the core started, with what it was
// started with
const settingsLabel = "sst.target.settings"

// runArgs are what `docker run` is given for the container, and a digest of
// them, which the container is labelled with.
func (c *Container) runArgs(target string) ([]string, string) {
	args := []string{
		"--detach",
		"--name", ContainerName(target),
		// The functions it runs can reach sst dev on this machine
		"--add-host", "host.docker.internal:host-gateway",
	}
	ports := append([]int{}, c.Ports...)
	sort.Ints(ports)
	for _, port := range ports {
		args = append(args, "--publish", fmt.Sprintf("127.0.0.1:%d:%d", port, port))
	}
	for _, key := range sortedKeys(c.Env) {
		args = append(args, "--env", key+"="+c.Env[key])
	}
	for _, folder := range sortedKeys(c.Volumes) {
		args = append(args, "--volume", fmt.Sprintf("%s-%s:%s", ContainerName(target), c.Volumes[folder], folder))
	}
	if c.DockerSocket {
		args = append(args, "--volume", "/var/run/docker.sock:/var/run/docker.sock")
	}
	sum := sha256.Sum256([]byte(strings.Join(append(append([]string{}, args...), c.Image), "\x00")))
	digest := hex.EncodeToString(sum[:8])
	args = append(args, "--label", settingsLabel+"="+digest, c.Image)
	return args, digest
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// runner runs the docker CLI. Tests give one of their own.
type runner func(ctx context.Context, args ...string) ([]byte, error)

func docker(ctx context.Context, args ...string) ([]byte, error) {
	out, err := exec.CommandContext(ctx, "docker", args...).CombinedOutput()
	if err != nil {
		return out, fmt.Errorf("docker %s: %w: %s", args[0], err, strings.TrimSpace(string(out)))
	}
	return out, nil
}

// Say is where the core says what a target's container is given. The CLI
// writes it to stderr.
var Say = func(message string) { fmt.Fprintln(os.Stderr, message) }

// start runs the target's container, or starts it again. One with other
// settings is replaced, and its volumes are kept. A container of that name
// the core didn't start is left alone, and the target doesn't start.
func (c *Container) start(ctx context.Context, target string, run runner) error {
	name := ContainerName(target)
	args, digest := c.runArgs(target)
	out, err := run(ctx, "container", "inspect", "--format", "{{json .}}", name)
	if err == nil {
		var found struct {
			State struct {
				Running bool
			}
			Config struct {
				Labels map[string]string
			}
		}
		if err := json.Unmarshal(out, &found); err != nil {
			return fmt.Errorf("reading the %q target's container: %w", target, err)
		}
		label, ours := found.Config.Labels[settingsLabel]
		if !ours {
			return fmt.Errorf("a container named %s is there, and SST didn't start it. Remove it or rename it, and the %q target starts its own", name, target)
		}
		if label == digest {
			if found.State.Running {
				return nil
			}
			c.say(target)
			_, err := run(ctx, "start", name)
			return err
		}
		if _, err := run(ctx, "rm", "--force", name); err != nil {
			return err
		}
	} else if _, err := run(ctx, "version", "--format", "{{.Server.Version}}"); err != nil {
		return fmt.Errorf("the %q target runs in Docker, which isn't running: %w", target, err)
	}
	c.say(target)
	if _, err := run(ctx, append([]string{"run"}, args...)...); err != nil {
		return fmt.Errorf("starting the %q target's container: %w", target, err)
	}
	return nil
}

func (c *Container) say(target string) {
	message := fmt.Sprintf("Starting the %q target: %s, on 127.0.0.1", target, c.Image)
	if c.DockerSocket {
		message += ". It's given this machine's Docker socket, so it can start containers of its own"
	}
	Say(message + ".")
}

// ours finds the target's container: whether it's there, whether the core
// started it, and whether it's running
func ours(ctx context.Context, target string, run runner) (there, started, running bool, err error) {
	out, err := run(ctx, "container", "inspect", "--format", "{{json .}}", ContainerName(target))
	if err != nil {
		if _, err := run(ctx, "version", "--format", "{{.Server.Version}}"); err != nil {
			return false, false, false, fmt.Errorf("the %q target runs in Docker, which isn't running: %w", target, err)
		}
		// none there
		return false, false, false, nil
	}
	var found struct {
		State  struct{ Running bool }
		Config struct{ Labels map[string]string }
	}
	if err := json.Unmarshal(out, &found); err != nil {
		return true, false, false, fmt.Errorf("reading the %q target's container: %w", target, err)
	}
	_, started = found.Config.Labels[settingsLabel]
	return true, started, found.State.Running, nil
}

// stop stops the target's container, and keeps it and its volumes. It says
// whether one was running. A container of that name the core didn't start
// is left alone.
func (c *Container) stop(ctx context.Context, target string, run runner) (bool, error) {
	_, started, running, err := ours(ctx, target, run)
	if err != nil || !started || !running {
		return false, err
	}
	if _, err := run(ctx, "stop", ContainerName(target)); err != nil {
		return false, err
	}
	return true, nil
}

// reset removes the target's container and its volumes, and with them what
// the target kept. A container of that name the core didn't start is refused.
func (c *Container) reset(ctx context.Context, target string, run runner) error {
	there, started, _, err := ours(ctx, target, run)
	if err != nil {
		return err
	}
	if there && !started {
		return fmt.Errorf("a container named %s is there, and SST didn't start it, so it's left alone", ContainerName(target))
	}
	if there {
		if _, err := run(ctx, "rm", "--force", ContainerName(target)); err != nil {
			return err
		}
	}
	for _, folder := range sortedKeys(c.Volumes) {
		volume := ContainerName(target) + "-" + c.Volumes[folder]
		if _, err := run(ctx, "volume", "rm", "--force", volume); err != nil {
			return err
		}
	}
	return nil
}

// waitReady waits until something answers at the endpoint, whatever it says
func waitReady(ctx context.Context, endpoint string) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	client := &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{Proxy: nil}}
	for {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if err != nil {
			return err
		}
		resp, err := client.Do(req)
		if err == nil {
			resp.Body.Close()
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("nothing answers at %s: %w", endpoint, err)
		case <-time.After(250 * time.Millisecond):
		}
	}
}
