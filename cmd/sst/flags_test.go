package main

import (
	"strings"
	"testing"

	"github.com/sst/sst/v3/cmd/sst/cli"
)

// The docs put a command's flag's description in one paragraph, and a blank
// line in it breaks their build. The global flags have a section of their own.
func TestFlagDescriptionsAreOneParagraph(t *testing.T) {
	var walk func(path string, cmd *cli.Command)
	walk = func(path string, cmd *cli.Command) {
		for _, f := range cmd.Flags {
			if cmd == root {
				break
			}
			for _, text := range []string{f.Description.Short, f.Description.Long} {
				if strings.Contains(text, "\n\n") {
					t.Errorf("%s --%s: its description has a blank line", path, f.Name)
				}
			}
		}
		for i := range cmd.Children {
			walk(path+" "+cmd.Children[i].Name, cmd.Children[i])
		}
	}
	walk("sst", root)
}
