package eject

import (
	"os/exec"
	"strings"
	"testing"
)

// What the eject uses of SST's own code, directly or through what it
// imports: helpers that know nothing of SST's apps, under internal/, and
// pkg/process, which runs a command. It reads a Pulumi project's stacks with
// the developer's pulumi, and never an SST app's home, state, passphrase or
// lock, so it works with SST's CLI gone but for the binary that runs it.
func TestUsesNothingOfSSTsApps(t *testing.T) {
	out, err := exec.Command("go", "list", "-deps", "-f", "{{.ImportPath}}", ".").Output()
	if err != nil {
		t.Fatal(err)
	}
	for _, dep := range strings.Fields(string(out)) {
		rest, ours := strings.CutPrefix(dep, "github.com/sst/sst/v3/")
		if !ours || rest == "pkg/eject" || rest == "pkg/process" || strings.HasPrefix(rest, "internal/") {
			continue
		}
		t.Errorf("the eject depends on %s", dep)
	}
}
