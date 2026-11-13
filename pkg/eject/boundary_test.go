package eject

import (
	"go/parser"
	"go/token"
	"path/filepath"
	"strings"
	"testing"
)

// What the eject uses of SST's own code: helpers that know nothing of SST's
// apps, under internal/. It reads a Pulumi project's stacks with the
// developer's pulumi, and never an SST app's home, state, passphrase or lock,
// so it works with SST's CLI gone but for the binary that runs it.
func TestUsesNothingOfSSTsApps(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") {
			continue
		}
		parsed, err := parser.ParseFile(fset, file, nil, parser.ImportsOnly)
		if err != nil {
			t.Fatal(err)
		}
		for _, spec := range parsed.Imports {
			path := strings.Trim(spec.Path.Value, `"`)
			if strings.HasPrefix(path, "github.com/sst/sst/v3/") && !strings.HasPrefix(path, "github.com/sst/sst/v3/internal/") {
				t.Errorf("%s imports %s", file, path)
			}
		}
	}
}
