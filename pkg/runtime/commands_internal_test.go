package runtime

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// Without a folder, the commands run in the handler's, and the handler is the
// rest of it. With one, the handler is as Lambda takes it, which for .NET isn't
// a path.
func TestCommandsLocate(t *testing.T) {
	root := t.TempDir()
	cfg := filepath.Join(root, "sst.config.ts")
	for _, c := range []struct {
		dir, output, handler            string
		wantDir, wantOutput, wantHandle string
	}{
		{"", "", "functions/ruby/app.handler", "functions/ruby", "functions/ruby", "app.handler"},
		{"", "dist", "functions/ruby/app.handler", "functions/ruby", "functions/ruby/dist", "app.handler"},
		{"functions/ruby", ".", "lib/app.handler", "functions/ruby", "functions/ruby", "lib/app.handler"},
		{"functions/api", "bin/publish", "Api::Api.Function::Handler", "functions/api", "functions/api/bin/publish", "Api::Api.Function::Handler"},
		{"functions/api", "/abs/out", "Api::Api.Function::Handler", "functions/api", "/abs/out", "Api::Api.Function::Handler"},
	} {
		settings := &CommandSettings{Dir: c.dir}
		settings.Build.Output = c.output
		dir, output, handler := locate(&BuildInput{CfgPath: cfg, Handler: c.handler, Commands: settings})
		wantOutput := c.wantOutput
		if !filepath.IsAbs(wantOutput) {
			wantOutput = filepath.Join(root, wantOutput)
		}
		if dir != filepath.Join(root, c.wantDir) || output != wantOutput || handler != c.wantHandle {
			t.Errorf("%+v: got %v, %v, %v", c, dir, output, handler)
		}
	}
}

// Only a variable the worker is given is expanded, so one meant for a shell the
// command starts is left for it.
func TestCommandsExpand(t *testing.T) {
	env := []string{"_HANDLER=app.handler", "HOME=/old", "HOME=/home"}
	for word, want := range map[string]string{
		"$_HANDLER":      "app.handler",
		"${_HANDLER}":    "app.handler",
		"--home=$HOME":   "--home=/home",
		"echo $1":        "echo $1",
		"$UNSET":         "$UNSET",
		"${UNSET}":       "${UNSET}",
		"price: $$5":     "price: $5",
		"plain":          "plain",
		"$_HANDLER.rb":   "app.handler.rb",
		"${_HANDLER}.rb": "app.handler.rb",
	} {
		if got := expand(word, env); got != want {
			t.Errorf("%q: got %q, want %q", word, got, want)
		}
	}
}

// What's in the output, when it's a folder of its own, doesn't rebuild the
// function, as the build writes it each time.
func TestCommandsWatchLeavesOutTheOutput(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"fn/app.rb", "fn/dist/app.rb"} {
		os.MkdirAll(filepath.Dir(filepath.Join(root, name)), 0755)
		if err := os.WriteFile(filepath.Join(root, name), nil, 0644); err != nil {
			t.Fatal(err)
		}
	}
	settings := &CommandSettings{Watch: []string{"**/*.rb"}}
	settings.Build.Output = "dist"
	c := NewCommands()
	input := &BuildInput{CfgPath: filepath.Join(root, "sst.config.ts"), FunctionID: "Fn", Handler: "fn/app.handler", Dev: true, Commands: settings}
	os.MkdirAll(input.Out(), 0755)
	if build, err := c.Build(context.Background(), input); err != nil || len(build.Errors) > 0 {
		t.Fatal(err, build)
	}
	if c.ShouldRebuild("Fn", filepath.Join(root, "fn/dist/app.rb")) {
		t.Error("a file in the output rebuilds it")
	}
	if !c.ShouldRebuild("Fn", filepath.Join(root, "fn/app.rb")) {
		t.Error("a file it watches doesn't rebuild it")
	}
}
