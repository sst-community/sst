package modules

import (
	"io/fs"
	"regexp"
	"testing"

	"github.com/sst/sst/v3/cmd/sst/mosaic/console"
)

// Every module has a name that --console takes, and the page's part it says.
func TestModules(t *testing.T) {
	name := regexp.MustCompile(`^[a-z]+$`)
	seen := map[string]bool{}
	for _, m := range All {
		if !name.MatchString(m.Name()) || m.Name() == console.All || m.Name() == "core" {
			t.Errorf("module name %q", m.Name())
		}
		if seen[m.Name()] {
			t.Errorf("two modules are %q", m.Name())
		}
		seen[m.Name()] = true
		if m.Web() == nil {
			continue
		}
		if _, err := fs.Stat(m.Web(), m.Name()+".js"); err != nil {
			t.Errorf("%s has no %s.js: %v", m.Name(), m.Name(), err)
		}
	}
	for _, m := range All {
		if r, ok := m.(console.Requirer); ok {
			for _, dep := range r.Requires() {
				if !seen[dep] {
					t.Errorf("%s needs %s, which isn't a module", m.Name(), dep)
				}
			}
		}
	}
	// each one starts, and they all start together
	if _, err := console.NewHarness(All...); err != nil {
		t.Fatal(err)
	}
}
