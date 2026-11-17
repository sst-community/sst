package python

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/sst/sst/v3/pkg/runtime"
	"github.com/sst/sst/v3/pkg/runtime/runtimetest"
)

// Python has no build step in sst dev, and any Python file rebuilds every
// function, so the fixture has no broken files, and what it doesn't use isn't
// Python.
func TestSuite(t *testing.T) {
	if _, err := exec.LookPath("uv"); err != nil {
		t.Skip("uv isn't installed")
	}
	dist, err := filepath.Abs("../../../platform/dist/python-runtime")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dist, "index.py")); err != nil {
		t.Skip("build the platform first, with bun run build:platform: " + err.Error())
	}
	runtimetest.Run(t, runtimetest.Options{
		Runtimes: func() []runtime.Runtime { return []runtime.Runtime{New()} },
		Files: map[string]string{
			"pyproject.toml": `[project]
name = "fixture"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = []
`,
			"functions/__init__.py": "",
			"functions/fixture.py": `import os

from functions.greet import greet


def handler(event, context):
    print(os.environ["` + runtimetest.Print + `"])
    return greet(event["name"])
`,
			"functions/greet.py": "def greet(name):\n    return {\"hello\": name}\n",
			"notes.txt":          "not code\n",
		},
		Changed:  map[string]string{"functions/greet.py": "def greet(name):\n    return {\"hello\": name, \"again\": True}\n"},
		Input:    runtime.BuildInput{Handler: "functions/fixture.handler", Runtime: "python3.12"},
		Uses:     "functions/greet.py",
		Unused:   "notes.txt",
		Platform: map[string]string{"dist/python-runtime": dist},
		// uv may set up a Python first
		Wait: time.Minute,
	})
}
