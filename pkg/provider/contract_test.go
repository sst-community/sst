package provider

import (
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"testing"

	"github.com/sst/sst/v3/pkg/global"
	"github.com/sst/sst/v3/platform"
)

// What SST's components (platform/src/components) and the provider agree on
// without sharing code: the types of SST's own resources, the config a
// program Pulumi runs on its own gives SST's provider, and where Pulumi
// downloads it from. A change on one side fails here until the other has it.

const components = "../../platform/src/components"

// onSST5Components skips a test that reads SST 5's components when this
// build's platform has another line's, as its manifest says
func onSST5Components(t *testing.T) {
	t.Helper()
	pkg, err := platform.PackageJson()
	if err != nil {
		t.Fatal(err)
	}
	if pkg.SST == nil || pkg.SST.Contract != 1 {
		t.Skip("this build's platform doesn't have SST 5's components")
	}
}

// read is a file of the components
func read(t *testing.T, path string) string {
	t.Helper()
	onSST5Components(t)
	data, err := os.ReadFile(filepath.Join(components, path))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// matches are the distinct first groups of a pattern's matches, sorted
func matches(pattern *regexp.Regexp, text string) []string {
	var found []string
	for _, match := range pattern.FindAllStringSubmatch(text, -1) {
		if !slices.Contains(found, match[1]) {
			found = append(found, match[1])
		}
	}
	sort.Strings(found)
	return found
}

func TestServesWhatTheComponentsMake(t *testing.T) {
	onSST5Components(t)
	files, err := filepath.Glob(filepath.Join(components, "*", "resources", "*.ts"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no resources in %s: %v", components, err)
	}
	var text strings.Builder
	for _, file := range files {
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		text.Write(data)
	}
	made := matches(regexp.MustCompile(`"(sst:[a-z]+:[A-Za-z]+)"`), text.String())
	served := ResourceTypes()
	for token := range functions(nil) {
		served = append(served, token)
	}
	sort.Strings(served)
	if !slices.Equal(made, served) {
		t.Errorf("the components make %v\nand the provider serves %v", made, served)
	}
}

// The keys are read as they're written, a literal key in plugin.ts's objects
// and config["..."] here: one read through a constant or a helper on either
// side isn't seen, so keep them literal.
func TestReadsTheConfigTheComponentsWrite(t *testing.T) {
	// The keys plugin.ts sets in SST's provider's config
	written := matches(regexp.MustCompile(`\b((?:aws|cloudflare|vercel)[A-Z][A-Za-z]*):`), read(t, "plugin.ts"))
	// and the ones the provider reads in Configure
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	var text strings.Builder
	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") {
			continue
		}
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		text.Write(data)
	}
	readKeys := matches(regexp.MustCompile(`config\["((?:aws|cloudflare|vercel)[A-Z][A-Za-z]*)"\]`), text.String())
	if len(written) == 0 || !slices.Equal(written, readKeys) {
		t.Errorf("plugin.ts writes %v\nand the provider reads %v", written, readKeys)
	}
}

func TestIsDownloadedFromWhereItsReleased(t *testing.T) {
	want := `pluginDownloadURL = "github://api.github.com/` + global.ReleaseRepo + `"`
	if !strings.Contains(read(t, "plugin.ts"), want) {
		t.Errorf("plugin.ts doesn't have %s", want)
	}
}
