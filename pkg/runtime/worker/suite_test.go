package worker

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/sst/sst/v3/pkg/runtime"
	"github.com/sst/sst/v3/pkg/runtime/runtimetest"
)

// sst dev runs a Cloudflare worker through Cloudflare, not on the runtime API,
// so the suite only builds one.
func TestSuite(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node isn't installed")
	}
	repo, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	// the workspace keeps the platform's packages at the top
	modules := filepath.Join(repo, "node_modules")
	if _, err := os.Stat(filepath.Join(modules, "unenv")); err != nil {
		t.Skip("install the packages first, with bun install: " + err.Error())
	}
	runtimetest.Run(t, runtimetest.Options{
		Runtimes: func() []runtime.Runtime { return []runtime.Runtime{New()} },
		Files: map[string]string{
			"src/worker.ts": `import { greet } from "./greet";
export default {
  async fetch() {
    return Response.json(greet("suite"));
  },
};
`,
			"src/greet.ts": "export const greet = (name: string) => ({ hello: name });\n",
			"src/other.ts": "export const other = 1;\n",
		},
		Changed: map[string]string{"src/greet.ts": "export const greet = (name: string) => ({ hello: name, again: true });\n"},
		Input: runtime.BuildInput{
			Handler:    "src/worker.ts",
			Runtime:    "worker",
			Properties: json.RawMessage(`{"build":{},"compatibility":{"date":"2025-01-01","flags":["nodejs_compat"]}}`),
		},
		Uses:   "src/greet.ts",
		Unused: "src/other.ts",
		Broken: map[string]string{"src/greet.ts": "export const greet = (\n"},
		Platform: map[string]string{
			"node_modules":                 modules,
			"src/runtime/worker/unenv.mjs": filepath.Join(repo, "platform/src/runtime/worker/unenv.mjs"),
		},
		NoRun: true,
	})
}
