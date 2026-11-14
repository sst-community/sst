package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/kballard/go-shellquote"
	"github.com/sst/sst/v3/pkg/process"
	"github.com/sst/sst/v3/pkg/project/path"
)

// CommandSettings is a runtime made of commands, which a package gives as
// settings. Every language with a Lambda runtime interface client, like Ruby's
// or .NET's, can run in sst dev this way: the client asks the Lambda runtime
// API for invocations, as it does in Lambda. Neither command runs in a shell.
type CommandSettings struct {
	// Dir is the folder the function's code is in, from the app's folder,
	// where its commands run. The handler is then as Lambda takes it, from the
	// build's output. Without it, it's the handler's folder, and the handler
	// is the rest of it: functions/ruby/app.handler is app.handler in
	// functions/ruby.
	Dir string `json:"dir,omitempty"`
	// Build builds the function. Its command runs in Dir, with SST_BUILD set
	// to dev or deploy and SST_ARCHITECTURE to x86_64 or arm64, and what's in
	// its output, a folder from Dir, is the function's code: everything in it
	// but .sst and .git folders, with links copied as what they point to. With
	// no command, the output is the code as it is.
	Build struct {
		Command string `json:"command,omitempty"`
		Output  string `json:"output,omitempty"`
	} `json:"build"`
	// Dev runs the function in sst dev, in its code's folder, with
	// AWS_LAMBDA_RUNTIME_API, _HANDLER and LAMBDA_TASK_ROOT set as Lambda sets
	// them, and the CLI's PATH and HOME, which the tools it starts need. A
	// $NAME or ${NAME} in it, for a variable it's given, is that variable's
	// value, so a runtime interface client is given the handler with
	// $_HANDLER, and $$ is a $.
	Dev struct {
		Command string `json:"command"`
	} `json:"dev"`
	// Watch is the files that rebuild the function in sst dev when they
	// change: globs from Dir, where ** is any number of folders. One that
	// starts with ../ can match files outside it. What's in the output, when
	// it's a folder of its own, doesn't rebuild it. A glob shouldn't match
	// anything else the build writes, or each build starts another.
	Watch []string `json:"watch,omitempty"`
}

// Commands runs a function by its CommandSettings. It's the runtime for any
// function whose build input has them, whatever its runtime setting.
type Commands struct {
	mu        sync.Mutex
	functions map[string]commandFunction
	// the builds by folder, as functions in one folder share it
	folders map[string]*folderBuild
}

// what a function was last built with
type commandFunction struct {
	settings *CommandSettings
	// where its commands run, and its build's output
	dir, output string
	folder      *folderBuild
}

// folderBuild is a folder's build. Functions in the folder build one at a time,
// and one that asks while another builds takes that build if it started after
// it asked.
type folderBuild struct {
	mu sync.Mutex
	// when the last build started, and its errors
	started time.Time
	errors  []string
}

var _ Runtime = (*Commands)(nil)

func NewCommands() *Commands {
	return &Commands{functions: map[string]commandFunction{}, folders: map[string]*folderBuild{}}
}

// Match is false: a function is run by its commands when its build input has
// them, not by its runtime setting.
func (c *Commands) Match(runtime string) bool { return false }

// locate is where a function's commands run, its build's output, and its
// handler as Lambda takes it.
func locate(input *BuildInput) (dir, output, handler string) {
	settings := input.Commands
	root := path.ResolveRootDir(input.CfgPath)
	if settings.Dir != "" {
		dir, handler = settings.Dir, input.Handler
	} else {
		dir, handler = filepath.Dir(input.Handler), filepath.Base(input.Handler)
	}
	if !filepath.IsAbs(dir) {
		dir = filepath.Join(root, dir)
	}
	output = settings.Build.Output
	if !filepath.IsAbs(output) {
		output = filepath.Join(dir, output)
	}
	return dir, filepath.Clean(output), handler
}

// remember keeps what a function is run with, and gives the build of its
// folder: the same for the functions built the same way there.
func (c *Commands) remember(input *BuildInput, dir, output string) *folderBuild {
	key := strings.Join([]string{dir, output, input.Commands.Build.Command, fmt.Sprint(input.Dev), string(input.Properties)}, "\x00")
	c.mu.Lock()
	defer c.mu.Unlock()
	folder, ok := c.folders[key]
	if !ok {
		folder = &folderBuild{}
		c.folders[key] = folder
	}
	c.functions[input.FunctionID] = commandFunction{settings: input.Commands, dir: dir, output: output, folder: folder}
	return folder
}

// Build runs the build command, once for the functions in a folder that ask at
// once, and puts the output in the function's folder, input.Out(): a copy for
// a deploy, and in sst dev a link to each thing in it, so a build is seen at
// once.
func (c *Commands) Build(ctx context.Context, input *BuildInput) (*BuildOutput, error) {
	if input.Commands == nil {
		return nil, fmt.Errorf("%v has no commands to build it with", input.FunctionID)
	}
	asked := time.Now()
	dir, output, handler := locate(input)
	folder := c.remember(input, dir, output)
	folder.mu.Lock()
	defer folder.mu.Unlock()
	if folder.started.Before(asked) {
		folder.started = time.Now()
		folder.errors = c.build(ctx, input, dir, output)
	}
	if len(folder.errors) > 0 {
		return &BuildOutput{Errors: folder.errors}, nil
	}
	put := copyFolder
	if input.Dev {
		put = linkFolder
	}
	if err := put(output, input.Out()); err != nil {
		return nil, err
	}
	return &BuildOutput{Handler: handler, Errors: []string{}, Sourcemaps: []string{}}, nil
}

// build runs the build command, and is what the developer has to fix, if
// anything.
func (c *Commands) build(ctx context.Context, input *BuildInput, dir, output string) []string {
	settings := input.Commands
	if command := settings.Build.Command; command != "" {
		words, err := shellquote.Split(command)
		if err != nil || len(words) == 0 {
			return []string{fmt.Sprintf("The build command %q can't be read: %v", command, err)}
		}
		var properties struct {
			Architecture string `json:"architecture"`
		}
		json.Unmarshal(input.Properties, &properties)
		if properties.Architecture == "" {
			properties.Architecture = "x86_64"
		}
		mode := "deploy"
		if input.Dev {
			mode = "dev"
		}
		cmd := process.CommandContext(ctx, words[0], words[1:]...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "SST_BUILD="+mode, "SST_ARCHITECTURE="+properties.Architecture)
		slog.Info("running the build command", "functionID", input.FunctionID, "command", cmd.Args)
		if out, err := cmd.CombinedOutput(); err != nil {
			message := strings.TrimSpace(string(out))
			if message == "" {
				message = fmt.Sprintf("The build command %q failed: %v", command, err)
			}
			return []string{message}
		}
	}
	if info, err := os.Stat(output); err != nil || !info.IsDir() {
		return []string{fmt.Sprintf("The build's output, %v, isn't a folder", output)}
	}
	return nil
}

// Run runs the dev command in the function's folder.
func (c *Commands) Run(ctx context.Context, input *RunInput) (Worker, error) {
	c.mu.Lock()
	function, ok := c.functions[input.FunctionID]
	c.mu.Unlock()
	if !ok {
		return nil, fmt.Errorf("%v hasn't been built", input.FunctionID)
	}
	env := slices.Clone(input.Env)
	for _, name := range []string{"PATH", "HOME"} {
		if value, ok := os.LookupEnv(name); ok && !slices.ContainsFunc(env, func(e string) bool { return strings.HasPrefix(e, name+"=") }) {
			env = append(env, name+"="+value)
		}
	}
	env = append(env,
		"AWS_LAMBDA_RUNTIME_API="+input.Server,
		"_HANDLER="+input.Build.Handler,
		"LAMBDA_TASK_ROOT="+input.Build.Out,
	)
	// the links, which Collection writes into the function's folder
	key := filepath.Join(input.Build.Out, "resource.enc")
	if shared := filepath.Join(input.Build.Out, ".sst", input.FunctionID, "resource.enc"); exists(shared) {
		key = shared
	}
	if exists(key) {
		env = append(env, "SST_KEY_FILE="+key)
	}
	words, err := shellquote.Split(function.settings.Dev.Command)
	if err != nil || len(words) == 0 {
		return nil, fmt.Errorf("the dev command %q can't be read: %v", function.settings.Dev.Command, err)
	}
	for i, word := range words {
		words[i] = expand(word, env)
	}
	cmd := process.Command(words[0], words[1:]...)
	cmd.Dir = input.Build.Out
	cmd.Env = env
	slog.Info("running the dev command", "workerID", input.WorkerID, "command", cmd.Args)
	return process.StartWorker(cmd)
}

// expand replaces each $NAME or ${NAME} that env has with its value, the last
// one if it's set twice, as a process sees it. Any other is left as it is, and
// $$ is a $.
func expand(word string, env []string) string {
	return os.Expand(word, func(name string) string {
		if name == "$" {
			return "$"
		}
		for _, entry := range slices.Backward(env) {
			if value, ok := strings.CutPrefix(entry, name+"="); ok {
				return value
			}
		}
		if strings.Contains(word, "${"+name+"}") {
			return "${" + name + "}"
		}
		return "$" + name
	})
}

// ValidateHandler checks nothing: the package's own build command is what
// says what a handler is, so only it can reject one
func (c *Commands) ValidateHandler(input *BuildInput) error { return nil }

// ShouldRebuild is whether the file is one the function's settings watch, and
// not in its output.
func (c *Commands) ShouldRebuild(functionID string, file string) bool {
	c.mu.Lock()
	function, ok := c.functions[functionID]
	c.mu.Unlock()
	if !ok {
		return false
	}
	rel, err := filepath.Rel(function.dir, file)
	if err != nil {
		return false
	}
	if !MatchWatch(function.settings, rel) {
		return false
	}
	// what's in the output, when it's a folder of its own, which the build
	// writes each time
	return function.output == function.dir || !isWithin(function.output, file)
}

func isWithin(folder, file string) bool {
	rel, err := filepath.Rel(folder, file)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// MatchWatch is whether a file, by its path from the function's folder, is one
// the settings watch. A file outside the folder only matches a glob that
// starts with ../.
func MatchWatch(settings *CommandSettings, name string) bool {
	name = filepath.ToSlash(name)
	outside := name == ".." || strings.HasPrefix(name, "../")
	for _, glob := range settings.Watch {
		glob = strings.TrimPrefix(filepath.ToSlash(filepath.Clean(glob)), "./")
		if outside != strings.HasPrefix(glob, "../") {
			continue
		}
		if matchGlob(glob, name) {
			return true
		}
	}
	return false
}

// matchGlob matches a path against a glob, where ** is any number of folders,
// and each other part is matched as filepath.Match does.
func matchGlob(glob, name string) bool {
	return matchParts(strings.Split(glob, "/"), strings.Split(name, "/"))
}

func matchParts(glob, name []string) bool {
	for len(glob) > 0 {
		if glob[0] == "**" {
			for i := range len(name) + 1 {
				if matchParts(glob[1:], name[i:]) {
					return true
				}
			}
			return false
		}
		if len(name) == 0 {
			return false
		}
		if ok, _ := filepath.Match(glob[0], name[0]); !ok {
			return false
		}
		glob, name = glob[1:], name[1:]
	}
	return len(name) == 0
}

func exists(file string) bool {
	_, err := os.Stat(file)
	return err == nil
}

// skipped is what's left out of a function's code.
func skipped(name string) bool { return name == ".sst" || name == ".git" }

// copyFolder copies from into to, links as what they point to, leaving out
// what SST and git keep there.
func copyFolder(from, to string) error {
	return copyInto(from, to, map[string]bool{})
}

func copyInto(from, to string, seen map[string]bool) error {
	real, err := filepath.EvalSymlinks(from)
	if err != nil {
		return err
	}
	// a link to a folder it's in would copy for ever
	if seen[real] {
		return nil
	}
	seen[real] = true
	defer delete(seen, real)
	entries, err := os.ReadDir(from)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(to, 0755); err != nil {
		return err
	}
	for _, entry := range entries {
		if skipped(entry.Name()) {
			continue
		}
		source, dest := filepath.Join(from, entry.Name()), filepath.Join(to, entry.Name())
		info, err := os.Stat(source)
		if err != nil {
			// a link to nothing
			if entry.Type()&fs.ModeSymlink != 0 {
				continue
			}
			return err
		}
		switch {
		case info.IsDir():
			err = copyInto(source, dest, seen)
		case info.Mode().IsRegular():
			err = copyFile(source, dest, info.Mode().Perm())
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func copyFile(from, to string, perm fs.FileMode) error {
	source, err := os.Open(from)
	if err != nil {
		return err
	}
	defer source.Close()
	target, err := os.OpenFile(to, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, perm)
	if err != nil {
		return err
	}
	if _, err := io.Copy(target, source); err != nil {
		target.Close()
		return err
	}
	return target.Close()
}

// linkFolder links each thing in from into to, and takes out the links into
// from to what's no longer there. What else is in to, like the links the core
// writes and the files it copies in, stays.
func linkFolder(from, to string) error {
	if err := os.MkdirAll(to, 0755); err != nil {
		return err
	}
	entries, err := os.ReadDir(from)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if skipped(entry.Name()) {
			continue
		}
		source, dest := filepath.Join(from, entry.Name()), filepath.Join(to, entry.Name())
		if target, err := os.Readlink(dest); err == nil {
			if target == source {
				continue
			}
			os.Remove(dest)
		}
		if err := os.Symlink(source, dest); err != nil && !os.IsExist(err) {
			return err
		}
	}
	existing, err := os.ReadDir(to)
	if err != nil {
		return err
	}
	for _, entry := range existing {
		dest := filepath.Join(to, entry.Name())
		if target, err := os.Readlink(dest); err == nil && filepath.Dir(target) == from && !exists(target) {
			os.Remove(dest)
		}
	}
	return nil
}
