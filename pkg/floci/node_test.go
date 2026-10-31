package floci

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestCheckNodeUsesSelectedExecutable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix executable fixture")
	}
	for _, supported := range []bool{false, true} {
		t.Run(map[bool]string{false: "unsupported", true: "supported"}[supported], func(t *testing.T) {
			dir := t.TempDir()
			script := "#!/bin/sh\n[ \"$1\" = '--use-env-proxy' ] && [ \"$2\" = '--version' ] || exit 2\n"
			if supported {
				script += "echo v24.5.0\n"
			} else {
				script += "echo 'bad option: --use-env-proxy' >&2\nexit 1\n"
			}
			if err := os.WriteFile(filepath.Join(dir, "node"), []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", dir)
			err := CheckNode(context.Background())
			if supported && err != nil {
				t.Fatal(err)
			}
			if !supported && (err == nil || !strings.Contains(err.Error(), "Install Node.js")) {
				t.Fatalf("got %v", err)
			}
		})
	}
}

func TestCheckNodeMissing(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	if err := CheckNode(context.Background()); err == nil || !strings.Contains(err.Error(), "PATH") {
		t.Fatalf("got %v", err)
	}
}
