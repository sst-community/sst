package runtime_test

import (
	"os/exec"
	"testing"

	"github.com/sst/sst/v3/pkg/runtime"
	"github.com/sst/sst/v3/pkg/runtime/runtimetest"
)

// A runtime interface client as small as one can be, for the fixture's dev
// command: it's given the handler to run as its argument, as a language's own
// is, and finds it in LAMBDA_TASK_ROOT.
const client = `const api = "http://" + process.env.AWS_LAMBDA_RUNTIME_API + "/2018-06-01/runtime/invocation/";
const [file, name] = process.argv[2].split(".");
const handler = (await import(process.env.LAMBDA_TASK_ROOT + "/" + file + ".mjs"))[name];
for (;;) {
  const next = await fetch(api + "next");
  const answer = await handler(await next.json());
  await fetch(api + next.headers.get("lambda-runtime-aws-request-id") + "/response", {
    method: "POST",
    body: JSON.stringify(answer),
  });
}
`

// The build copies the code into dist, as a package's build command would
// install it. It takes a lock for a moment, as Bundler or .NET does, so two
// builds in the folder at once would fail.
const build = `import { cpSync, openSync, closeSync, unlinkSync } from "node:fs";
closeSync(openSync(".lock", "wx"));
await new Promise((resolve) => setTimeout(resolve, 200));
cpSync("src", "dist", { recursive: true });
unlinkSync(".lock");
`

func TestCommandsSuite(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node isn't installed")
	}
	settings := &runtime.CommandSettings{Watch: []string{"src/**/*.mjs"}}
	settings.Build.Command = "node build.mjs"
	settings.Build.Output = "dist"
	settings.Dev.Command = "node client.mjs $_HANDLER"
	runtimetest.Run(t, runtimetest.Options{
		Files: map[string]string{
			"functions/fixture/build.mjs":      build,
			"functions/fixture/src/client.mjs": client,
			"functions/fixture/src/app.mjs": `import { greet } from "./lib/greet.mjs";
export async function handler(event) {
  console.log(process.env.` + runtimetest.Print + `);
  return greet(event.name);
}
`,
			"functions/fixture/src/lib/greet.mjs": "export const greet = (name) => ({ hello: name });\n",
			"functions/fixture/README.md":         "not watched\n",
		},
		Changed: map[string]string{"functions/fixture/src/lib/greet.mjs": "export const greet = (name) => ({ hello: name, again: true });\n"},
		Input: runtime.BuildInput{
			Handler:  "functions/fixture/app.handler",
			Runtime:  "provided.al2023",
			Commands: settings,
		},
		Uses:   "functions/fixture/src/lib/greet.mjs",
		Unused: "functions/fixture/README.md",
		Broken: map[string]string{"functions/fixture/build.mjs": "console.error(\"the build failed\");\nprocess.exit(1);\n"},
	})
}

func TestCommandsWatchGlobs(t *testing.T) {
	for _, c := range []struct {
		glob, name string
		want       bool
	}{
		{"**/*.rb", "app.rb", true},
		{"**/*.rb", "lib/deep/app.rb", true},
		{"**/*.rb", "Gemfile", false},
		{"Gemfile.lock", "Gemfile.lock", true},
		{"lib/*.rb", "lib/app.rb", true},
		{"lib/*.rb", "lib/deep/app.rb", false},
		{"lib/**", "lib/deep/app.rb", true},
		{"src/**/*.mjs", "src/app.mjs", true},
		{"./src/**", "src/app.mjs", true},
		{"**/*.rb", "../shared/app.rb", false},
		{"../shared/**/*.rb", "../shared/app.rb", true},
		{"../shared/**/*.rb", "shared/app.rb", false},
	} {
		settings := &runtime.CommandSettings{Watch: []string{c.glob}}
		if got := runtime.MatchWatch(settings, c.name); got != c.want {
			t.Errorf("%v matching %v: got %v, want %v", c.glob, c.name, got, c.want)
		}
	}
}
