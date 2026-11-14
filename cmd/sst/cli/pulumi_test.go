package cli

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/sst/sst/v3/pkg/pulumidev"
)

func cliFor(command string, flags ...string) *Cli {
	parsed := map[string]interface{}{}
	for i := 0; i+1 < len(flags); i += 2 {
		value := flags[i+1]
		parsed[flags[i]] = &value
	}
	return &Cli{flags: parsed, path: CommandPath{{Name: "sst"}, {Name: command}}}
}

// pulumiDev is sst pulumi dev, with flags
func pulumiDev(flags ...string) *Cli {
	c := cliFor("dev", flags...)
	c.path = CommandPath{{Name: "sst"}, {Name: "pulumi"}, {Name: "dev"}}
	return c
}

func touch(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, nil, 0644); err != nil {
		t.Fatal(err)
	}
}

func TestDiscoverPulumiProject(t *testing.T) {
	root, _ := filepath.EvalSymlinks(t.TempDir())
	touch(t, filepath.Join(root, "Pulumi.yaml"))
	t.Chdir(filepath.Join(root))

	// sst pulumi dev runs it
	got, err := pulumiDev().Discover()
	if err != nil || got != filepath.Join(root, "Pulumi.yaml") {
		t.Fatalf("got %q, %v", got, err)
	}
	// every other command, sst dev too, says to use it, and pulumi
	for _, command := range []string{"dev", "deploy"} {
		if _, err := cliFor(command).Discover(); !errors.Is(err, pulumidev.ErrCommand) {
			t.Fatalf("%s: got %v", command, err)
		}
	}
}

func TestDiscoverSSTAppFirst(t *testing.T) {
	// a Pulumi project inside an SST app's folder is the SST app's, as it
	// always was
	root, _ := filepath.EvalSymlinks(t.TempDir())
	touch(t, filepath.Join(root, "sst.config.ts"))
	touch(t, filepath.Join(root, "infra", "Pulumi.yaml"))
	t.Chdir(filepath.Join(root, "infra"))
	for _, command := range []string{"dev", "deploy"} {
		got, err := cliFor(command).Discover()
		if err != nil || got != filepath.Join(root, "sst.config.ts") {
			t.Fatalf("%s: got %q, %v", command, got, err)
		}
	}
	// sst pulumi dev, asked for by name, runs the Pulumi project
	got, err := pulumiDev().Discover()
	if err != nil || got != filepath.Join(root, "infra", "Pulumi.yaml") {
		t.Fatalf("sst pulumi dev: got %q, %v", got, err)
	}
	if !pulumiDev().IsPulumiProgram() {
		t.Fatal("sst pulumi dev in a Pulumi project isn't a Pulumi program")
	}
}

func TestIsPulumiProgram(t *testing.T) {
	root, _ := filepath.EvalSymlinks(t.TempDir())
	touch(t, filepath.Join(root, "shop", "Pulumi.yaml"))
	touch(t, filepath.Join(root, "app", "sst.config.ts"))
	touch(t, filepath.Join(root, "app", "infra", "Pulumi.yaml"))
	touch(t, filepath.Join(root, "none", "x"))
	for dir, want := range map[string]bool{
		"shop":      true,
		"app":       false,
		"app/infra": false,
		"none":      false,
	} {
		t.Chdir(filepath.Join(root, dir))
		if got := cliFor("dev").IsPulumiProgram(); got != want {
			t.Errorf("in %s: got %v", dir, got)
		}
	}
	// named with --config, as in an SST app's folder
	t.Chdir(filepath.Join(root, "app"))
	if !cliFor("dev", "config", filepath.Join(root, "app", "infra", "Pulumi.yaml")).IsPulumiProgram() {
		t.Error("a Pulumi.yaml named with --config is a Pulumi program")
	}
	// finding it does nothing to an SST app's folder
	if _, err := os.Stat(filepath.Join(root, "app", ".sst")); err == nil {
		t.Error("it made the SST app's .sst")
	}
}

func TestDiscoverBrokenSSTApp(t *testing.T) {
	// an SST app that can't be used says why, rather than run a Pulumi
	// project up from it
	root, _ := filepath.EvalSymlinks(t.TempDir())
	touch(t, filepath.Join(root, "Pulumi.yaml"))
	touch(t, filepath.Join(root, "app", "sst.config.ts"))
	// its .sst can't be made: there's a file in its place
	touch(t, filepath.Join(root, "app", ".sst"))
	t.Chdir(filepath.Join(root, "app"))
	got, err := cliFor("dev").Discover()
	if err == nil || got != "" {
		t.Fatalf("got %q, %v", got, err)
	}
	if strings.Contains(err.Error(), "Pulumi") {
		t.Fatalf("the error is the Pulumi project's: %v", err)
	}
}

func TestDiscoverPulumiConfig(t *testing.T) {
	// a Pulumi.yaml named with --config, as in an SST app's folder
	root, _ := filepath.EvalSymlinks(t.TempDir())
	touch(t, filepath.Join(root, "sst.config.ts"))
	touch(t, filepath.Join(root, "infra", "Pulumi.yaml"))
	t.Chdir(root)
	config := filepath.Join(root, "infra", "Pulumi.yaml")
	got, err := pulumiDev("config", config).Discover()
	if err != nil || got != config {
		t.Fatalf("got %q, %v", got, err)
	}
	if _, err := cliFor("dev", "config", config).Discover(); !errors.Is(err, pulumidev.ErrCommand) {
		t.Fatalf("sst dev: got %v", err)
	}
	// sst pulumi dev takes a Pulumi.yaml alone
	_, err = pulumiDev("config", filepath.Join(root, "sst.config.ts")).Discover()
	if err == nil || !strings.Contains(err.Error(), "names its Pulumi.yaml") {
		t.Fatalf("an SST app's config: got %v", err)
	}
	if _, err := cliFor("deploy", "config", config).Discover(); !errors.Is(err, pulumidev.ErrCommand) {
		t.Fatalf("got %v", err)
	}
}

// The dev loop's panes run its command again
func TestDevCommand(t *testing.T) {
	if got := cliFor("dev").DevCommand(); !reflect.DeepEqual(got, []string{"dev"}) {
		t.Errorf("sst dev: %v", got)
	}
	if got := pulumiDev().DevCommand(); !reflect.DeepEqual(got, []string{"pulumi", "dev"}) {
		t.Errorf("sst pulumi dev: %v", got)
	}
}

func TestPulumiStage(t *testing.T) {
	cfg := filepath.Join(t.TempDir(), "Pulumi.yaml")
	t.Setenv("SST_STAGE", "")
	// a stack named with its organization is known by its name alone, as sst
	// dev in another terminal finds the server by it
	for _, stack := range []string{"dev", "acme/shop/dev"} {
		if got, err := cliFor("dev", "stage", stack).Stage(cfg); err != nil || got != "dev" {
			t.Fatalf("--stage %s: got %q, %v", stack, got, err)
		}
	}
	t.Setenv("SST_STAGE", "acme/shop/alice")
	if got, err := cliFor("dev").Stage(cfg); err != nil || got != "alice" {
		t.Fatalf("SST_STAGE: got %q, %v", got, err)
	}
}

func TestDiscoverNothing(t *testing.T) {
	t.Chdir(t.TempDir())
	if _, err := cliFor("dev").Discover(); err == nil || errors.Is(err, pulumidev.ErrCommand) {
		t.Fatalf("got %v", err)
	}
}

func TestRestoreEnv(t *testing.T) {
	t.Setenv("SST_TEST_KEPT", "1")
	start := os.Environ()
	t.Setenv("SST_TEST_FROM_DOTENV", "x")
	restoreEnv(start)
	if os.Getenv("SST_TEST_FROM_DOTENV") != "" || os.Getenv("SST_TEST_KEPT") != "1" {
		t.Fatal("the environment isn't the one the CLI started with")
	}
}
