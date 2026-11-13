package eject

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakePulumi puts a pulumi on the PATH that answers for two stacks, "dev"
// and "prod", with the fixtures' states, and writes each command it's given
// to a log. An import of a file outside the project fails, as one that timed
// out does.
func fakePulumi(t *testing.T, root string) (log string) {
	t.Helper()
	bin := t.TempDir()
	log = filepath.Join(bin, "log")
	dev := filepath.Join(bin, "dev.json")
	prod := filepath.Join(bin, "prod.json")
	if err := os.WriteFile(dev, readFixture(t), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(prod, prodFixture(t), 0600); err != nil {
		t.Fatal(err)
	}
	script := `#!/bin/sh
echo "$@" >> "` + log + `"
case "$1 $2" in
  "stack ls") echo '[{"name":"dev"},{"name":"prod"}]' ;;
  "stack export")
    case "$*" in
      *"--stack prod"*) cat "` + prod + `" ;;
      *) cat "` + dev + `" ;;
    esac ;;
  "config set") cat > /dev/null ;;
  "stack import")
    case "$4" in
      "` + root + `"/*) ;;
      *) echo "error: timed out" >&2; exit 1 ;;
    esac ;;
esac
`
	if err := os.WriteFile(filepath.Join(bin, "pulumi"), []byte(script), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	return log
}

func TestRunPutsBackAStackWhoseImportFailed(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "Pulumi.yaml"), []byte("name: shop\nruntime: nodejs\n"), 0644); err != nil {
		t.Fatal(err)
	}
	log := fakePulumi(t, root)

	err := Run(context.Background(), filepath.Join(root, "Pulumi.yaml"), "", false, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("got %v", err)
	}
	data, readErr := os.ReadFile(log)
	if readErr != nil {
		t.Fatal(readErr)
	}
	commands := strings.Split(strings.TrimSpace(string(data)), "\n")

	// A plain value is set as one, so Pulumi doesn't refuse one that looks
	// like a secret, and a secret as a secret
	var plain, secret bool
	for _, command := range commands {
		if !strings.HasPrefix(command, "config set ") {
			continue
		}
		isPlain, isSecret := strings.Contains(command, " --plaintext"), strings.Contains(command, " --secret")
		if isPlain == isSecret {
			t.Errorf("set as neither or both: %s", command)
		}
		plain, secret = plain || isPlain, secret || isSecret
	}
	if !plain || !secret {
		t.Errorf("not both a plain value and a secret were set:\n%s", data)
	}

	// The stack whose import failed is put back from its backup, which the
	// import may have landed anyway
	last := commands[len(commands)-1]
	if !strings.HasPrefix(last, "stack import --file "+filepath.Join(root, "sst-eject-dev-")) || !strings.Contains(last, "--stack dev") {
		t.Errorf("the last command is %q, not the backup's import:\n%s", last, data)
	}
	if !strings.Contains(err.Error(), "no stack's state is changed") {
		t.Errorf("the error doesn't say the state is back: %v", err)
	}
	// And what it wrote is taken out
	if _, err := os.Stat(filepath.Join(root, ModuleFile)); !os.IsNotExist(err) {
		t.Errorf("%s is left: %v", ModuleFile, err)
	}
}
