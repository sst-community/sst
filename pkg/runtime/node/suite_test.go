package node

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/sst/sst/v3/pkg/runtime"
	"github.com/sst/sst/v3/pkg/runtime/runtimetest"
)

func TestSuite(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node isn't installed")
	}
	dist, err := filepath.Abs("../../../platform/dist/nodejs-runtime")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dist, "index.js")); err != nil {
		t.Skip("build the platform first, with bun run build:platform: " + err.Error())
	}
	runtimetest.Run(t, runtimetest.Options{
		Runtimes: func() []runtime.Runtime { return []runtime.Runtime{New("dev")} },
		Files: map[string]string{
			"src/fixture.ts": `import { greet } from "./greet";
export async function handler(event: { name: string }) {
  console.log(process.env.` + runtimetest.Print + `);
  return greet(event.name);
}
`,
			"src/greet.ts": "export const greet = (name: string) => ({ hello: name });\n",
			"src/other.ts": "export const other = 1;\n",
		},
		Changed:  map[string]string{"src/greet.ts": "export const greet = (name: string) => ({ hello: name, again: true });\n"},
		Input:    runtime.BuildInput{Handler: "src/fixture.handler", Runtime: "nodejs22.x"},
		Uses:     "src/greet.ts",
		Unused:   "src/other.ts",
		Broken:   map[string]string{"src/greet.ts": "export const greet = (\n"},
		Platform: map[string]string{"dist/nodejs-runtime": dist},
	})
}
