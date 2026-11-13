package pulumicli

import "testing"

func TestParseProjectRuntime(t *testing.T) {
	for text, want := range map[string]string{
		"name: shop\nruntime: nodejs\n":                                            "nodejs",
		"name: shop\nruntime:\n  name: nodejs\n  options:\n    typescript: true\n": "nodejs",
		"name: shop\nruntime: python\n":                                            "python",
		"name: shop\n":                                                             "",
	} {
		project, err := ParseProject([]byte(text))
		if err != nil {
			t.Fatal(err)
		}
		if project.Runtime != want || project.Name != "shop" {
			t.Errorf("%q is %+v, want the runtime %q", text, project, want)
		}
	}
}

func TestParseProjectMain(t *testing.T) {
	project, err := ParseProject([]byte("name: shop\nruntime: nodejs\nmain: src/index.ts\n"))
	if err != nil || project.Main != "src/index.ts" {
		t.Errorf("got %+v, %v", project, err)
	}
}

func TestCommand(t *testing.T) {
	for want, args := range map[string][]string{
		"pulumi stack export": {"stack", "export", "--stack", "dev"},
		"pulumi stack":        {"stack", "--show-name"},
		"pulumi config":       {"config", "--json", "--stack", "dev"},
		"pulumi config set":   {"config", "set", "sst-ejected:A", "--secret"},
	} {
		if got := command(args); got != want {
			t.Errorf("command(%v) = %q, want %q", args, got, want)
		}
	}
}

func TestFirstLine(t *testing.T) {
	if got := FirstLine("\n  error: no stack named dev  \nmore\n"); got != "error: no stack named dev" {
		t.Errorf("got %q", got)
	}
}
