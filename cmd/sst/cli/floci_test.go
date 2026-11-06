package cli

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestFlociChecksNodeBeforeDocker(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix executable fixtures")
	}
	for _, command := range []string{"dev", "unlock"} {
		t.Run(command, func(t *testing.T) {
			dir := t.TempDir()
			write := func(name, content string) {
				t.Helper()
				if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0700); err != nil {
					t.Fatal(err)
				}
			}
			config := filepath.Join(dir, "sst.config.ts")
			write("sst.config.ts", "export default {}")
			marker := filepath.Join(dir, "docker-called")
			t.Setenv("FLOCI_TEST_DOCKER_MARKER", marker)
			t.Setenv("PATH", dir)
			t.Setenv("SST_FLOCI_ENDPOINT", "")
			if command == "unlock" {
				t.Setenv("SST_FLOCI_ENDPOINT", "http://127.0.0.1:4567")
			}
			write("node", "#!/bin/sh\necho 'node: bad option: --use-env-proxy' >&2\nexit 1\n")
			write("docker", "#!/bin/sh\nprintf called > \"$FLOCI_TEST_DOCKER_MARKER\"\nexit 1\n")
			stage, enabled := "test", command == "dev"
			c := &Cli{Context: context.Background(), flags: map[string]interface{}{"config": &config, "stage": &stage, "floci": &enabled}, path: CommandPath{{Name: "sst"}, {Name: command}}}
			_, err := c.InitProject()
			if err == nil || !strings.Contains(err.Error(), "Node.js") || !strings.Contains(err.Error(), "--use-env-proxy") {
				t.Fatalf("missing actionable Node error: %v", err)
			}
			if _, err := os.Stat(marker); !os.IsNotExist(err) {
				t.Fatal("Docker ran before Node compatibility was checked")
			}
		})
	}
}

func TestFlociCommandGuard(t *testing.T) {
	for _, command := range []string{"deploy", "diff", "refresh", "secret", "state"} {
		if err := flociCommandAllowed(command, false, true); err == nil {
			t.Errorf("allowed %s against Floci", command)
		}
		if err := flociCommandAllowed(command, true, false); err == nil {
			t.Errorf("allowed --floci for %s", command)
		}
		if err := flociCommandAllowed(command, false, false); err != nil {
			t.Errorf("cloud %s: %v", command, err)
		}
	}
	for _, command := range []string{"dev", "shell", "remove", "unlock", "floci", "ui"} {
		if err := flociCommandAllowed(command, false, true); err != nil {
			t.Errorf("blocked local %s: %v", command, err)
		}
	}
}

func TestFlociInheritedHelpAndVersion(t *testing.T) {
	t.Setenv("SST_FLOCI", "1")
	for _, name := range []string{"sst", "deploy", "version"} {
		t.Run(name, func(t *testing.T) {
			help := name == "deploy"
			called := false
			command := Command{Name: name}
			if name != "sst" {
				command.Run = func(*Cli) error { called = true; return nil }
			}
			c := &Cli{flags: map[string]interface{}{"help": &help}, path: CommandPath{command}}
			wantErr := error(nil)
			if name != "version" {
				wantErr = ErrHelp
			}
			if err := c.Run(); err != wantErr {
				t.Fatalf("got %v, want %v", err, wantErr)
			}
			if called != (name == "version") {
				t.Fatalf("unexpected command execution: %v", called)
			}
		})
	}
}
