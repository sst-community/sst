package runtime

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"

	"github.com/sst/sst/v3/pkg/project/path"
)

// Runtime builds a function, and in sst dev runs it on this machine. The core
// does the rest, in Collection and sst dev: it picks a function's runtime by
// its runtime setting, gives each function a folder to build into, copies its
// files, encrypts its links into it, and starts again the workers of the
// functions in use after a change. Node.js, Python, Go and Rust are built in,
// Cloudflare's workers are built here and run by Cloudflare in sst dev, and
// Commands is a runtime made of commands. A runtime has to do this much:
//
//   - Build builds the function into input.Out(), which the core sets as
//     BuildOutput.Out. An error in the function's own code, for the developer
//     to fix, is in BuildOutput.Errors; the error it returns is the runtime
//     failing. Different functions are built at once.
//   - In sst dev, a function is built again into the same folder after a
//     change to a file ShouldRebuild says it uses, while its worker may still
//     run from that folder.
//   - Run starts a worker that asks for the function's invocations from the
//     Lambda runtime API at input.Server, with input.Env in its environment,
//     and of the CLI's only what it needs, like PATH, never its AWS_*
//     variables. input.Server is a host and port, as AWS_LAMBDA_RUNTIME_API is
//     in Lambda, followed by the worker's path.
//   - A Worker's Logs is what it prints, and ends when it exits. Stop stops it,
//     and what it started, without waiting for it to exit.
//   - ShouldRebuild says whether a function uses a file, once it's built. It's
//     asked while other functions build.
type Runtime interface {
	// Match is whether it's the runtime for a function's runtime setting.
	Match(runtime string) bool
	Build(ctx context.Context, input *BuildInput) (*BuildOutput, error)
	Run(ctx context.Context, input *RunInput) (Worker, error)
	ShouldRebuild(functionID string, path string) bool
	// ValidateHandler reports whether the handler path resolves, so sst dev can
	// fail at deploy instead of at first invocation. It must be no stricter than
	// Build: it should reject only a handler that Build would also reject.
	ValidateHandler(input *BuildInput) error
}

type Worker interface {
	Stop()
	Logs() io.ReadCloser
}

type BuildInput struct {
	CfgPath string
	// PlatformDir is where SST's platform files are, which a build reads, like
	// a Worker's unenv config, when they aren't in the work folder's platform
	// (Platform): a Pulumi program's build server has them in the sst package
	PlatformDir   string
	Dev           bool                       `json:"dev"`
	FunctionID    string                     `json:"functionID"`
	Handler       string                     `json:"handler"`
	Bundle        string                     `json:"bundle"`
	Runtime       string                     `json:"runtime"`
	Properties    json.RawMessage            `json:"properties"`
	Links         map[string]json.RawMessage `json:"links"`
	EncryptionKey string                     `json:"encryptionKey"`
	CopyFiles     []struct {
		From string `json:"from"`
		To   string `json:"to"`
	} `json:"copyFiles"`
	IsContainer bool `json:"isContainer,omitempty"`
	// Commands, when it's given, builds and runs the function instead of the
	// runtime its runtime setting names
	Commands *CommandSettings `json:"commands,omitempty"`
}

// Platform is the folder of SST's platform files a build reads: the app's
// .sst/platform, which SST's CLI writes, or PlatformDir when it's given
func (input *BuildInput) Platform() string {
	if input.PlatformDir != "" {
		return input.PlatformDir
	}
	return path.ResolvePlatformDir(input.CfgPath)
}

func (input *BuildInput) Out() string {
	suffix := "-src"
	if input.Dev {
		suffix = "-dev"
	}
	return filepath.Join(path.ResolveWorkingDir(input.CfgPath), "artifacts", input.FunctionID+suffix)
}

type BuildOutput struct {
	Out        string   `json:"out"`
	Handler    string   `json:"handler"`
	Errors     []string `json:"errors"`
	Sourcemaps []string `json:"sourcemaps"`
}

type RunInput struct {
	CfgPath    string
	Runtime    string
	Server     string
	FunctionID string
	WorkerID   string
	Build      *BuildOutput
	Env        []string
}

type Collection struct {
	runtimes []Runtime
	commands *Commands
	cfgPath  string
	targets  map[string]*BuildInput
	// the runtime each function was last built with, which runs it
	mu    sync.Mutex
	built map[string]Runtime
}

func NewCollection(platform string, runtimes ...Runtime) *Collection {
	return &Collection{
		runtimes: runtimes,
		commands: NewCommands(),
		cfgPath:  platform,
		targets:  map[string]*BuildInput{},
		built:    map[string]Runtime{},
	}
}

func (c *Collection) Runtime(input string) (Runtime, bool) {
	for _, runtime := range c.runtimes {
		if runtime.Match(input) {
			return runtime, true
		}
	}
	return nil, false
}

// forBuild is the runtime that builds a function: its commands, if it has
// them, or the one its runtime setting names.
func (c *Collection) forBuild(input *BuildInput) (Runtime, bool) {
	if input.Commands != nil {
		return c.commands, true
	}
	return c.Runtime(input.Runtime)
}

// forFunction is the runtime a function was built with, or the one its runtime
// setting names, before it's built.
func (c *Collection) forFunction(runtime, functionID string) (Runtime, bool) {
	c.mu.Lock()
	r, ok := c.built[functionID]
	c.mu.Unlock()
	if ok {
		return r, true
	}
	return c.Runtime(runtime)
}

func (c *Collection) Build(ctx context.Context, input *BuildInput) (*BuildOutput, error) {
	slog.Info("building function", "runtime", input.Runtime, "functionID", input.FunctionID)
	defer slog.Info("function built", "runtime", input.Runtime, "functionID", input.FunctionID)
	out := input.Out()
	var result *BuildOutput

	if input.Bundle != "" {
		out = input.Bundle
		if !filepath.IsAbs(out) {
			out = filepath.Join(path.ResolveRootDir(input.CfgPath), out)
		}
		// Only runtimes we build know how to resolve a handler. Custom-bundle
		// functions on a runtime with no implementation (e.g. provided.al2,
		// provided.al2023 for Swift or Dart) have nothing to validate against,
		// so skip the check rather than failing the deploy.
		if runtime, ok := c.Runtime(input.Runtime); ok {
			if err := runtime.ValidateHandler(input); err != nil {
				return nil, err
			}
		}
		result = &BuildOutput{
			Handler: input.Handler,
			Errors:  []string{},
		}
		// it's run by its commands, if it has them, or by its runtime setting
		c.mu.Lock()
		delete(c.built, input.FunctionID)
		if input.Commands != nil {
			dir, output, _ := locate(input)
			c.commands.remember(input, dir, output)
			c.built[input.FunctionID] = c.commands
		}
		c.mu.Unlock()
	}

	if input.Bundle == "" {
		// skip removing in dev mode so running workers don't lose their bundle files
		if !input.Dev {
			err := os.RemoveAll(out)
			if err != nil {
				return nil, err
			}
		}
		err := os.MkdirAll(out, 0755)
		if err != nil {
			return nil, err
		}
		runtime, ok := c.forBuild(input)
		if !ok {
			return nil, fmt.Errorf("runtime not found: %v", input.Runtime)
		}
		result, err = runtime.Build(ctx, input)
		if err != nil {
			return nil, err
		}
		c.mu.Lock()
		c.built[input.FunctionID] = runtime
		c.mu.Unlock()
	}

	result.Out = out
	if result.Sourcemaps == nil {
		result.Sourcemaps = []string{}
	}

	if len(input.CopyFiles) > 0 {
		for _, item := range input.CopyFiles {
			from, err := filepath.Abs(item.From)
			if err != nil {
				return nil, err
			}
			var dest string
			if item.To != "" {
				dest = filepath.Join(out, item.To)
			} else {
				dest = filepath.Join(out, item.From)
			}
			if err := os.MkdirAll(filepath.Dir(dest), 0755); err != nil {
				return nil, err
			}
			if input.Dev {
				// a dev rebuild keeps the folder, so replace a link that points somewhere else
				if target, err := os.Readlink(dest); err == nil && target != from {
					if err := os.Remove(dest); err != nil {
						slog.Warn("could not replace the copyFiles link", "path", dest, "error", err)
					}
				}
				if err := os.Symlink(from, dest); err != nil {
					if !os.IsExist(err) {
						return nil, err
					}
				}
			}
			// copying files still happens in node
			if !input.Dev && false {
				sourceFile, err := os.Open(from)
				if err != nil {
					return nil, err
				}
				defer sourceFile.Close()
				destFile, err := os.Create(dest)
				if err != nil {
					return nil, err
				}
				defer destFile.Close()
				_, err = io.Copy(destFile, sourceFile)
				if err != nil {
					return nil, err
				}
			}
		}
	}

	if input.EncryptionKey != "" {
		key, err := base64.StdEncoding.DecodeString(input.EncryptionKey)
		if err != nil {
			return nil, err
		}
		json, err := json.Marshal(input.Links)
		if err != nil {
			return nil, err
		}
		block, err := aes.NewCipher(key)
		if err != nil {
			return nil, err
		}
		gcm, err := cipher.NewGCM(block)
		if err != nil {
			return nil, err
		}
		ciphertext := gcm.Seal(nil, make([]byte, 12), json, nil)
		// When a shared bundle is used, multiple functions share the same output
		// directory (result.Out == input.Bundle). Writing "resource.enc" from
		// concurrent Runtime.Build calls races: partial writes can leave a
		// truncated or mixed ciphertext that fails AES-GCM authentication on
		// the Lambda's first cold start (observed as `Decipheriv` errors at
		// runtime initialization).
		//
		// Namespace the file under a per-function subdirectory so each function
		// writes to its own path (eliminating the race) AND each function's
		// uploaded zip can exclude every sibling's subtree (the .sst/ prefix
		// gives a single, stable glob target for the zipper to filter on). The
		// Lambda reads its own file via SST_KEY_FILE, which the platform
		// component points at the matching path.
		resourcePath := filepath.Join(result.Out, "resource.enc")
		if input.Bundle != "" {
			resourcePath = filepath.Join(result.Out, ".sst", input.FunctionID, "resource.enc")
			if err := os.MkdirAll(filepath.Dir(resourcePath), 0755); err != nil {
				return nil, err
			}
		}
		err = os.WriteFile(resourcePath, ciphertext, 0644)
		if err != nil {
			return nil, err
		}
	}

	return result, nil
}

func (c *Collection) Run(ctx context.Context, input *RunInput) (Worker, error) {
	slog.Info("running function", "runtime", input.Runtime, "functionID", input.FunctionID)
	runtime, ok := c.forFunction(input.Runtime, input.FunctionID)
	input.Env = append(input.Env, "SST_LIVE=true")
	input.Env = append(input.Env, "SST_DEV=true")
	if !ok {
		return nil, fmt.Errorf("runtime not found")
	}
	return runtime.Run(ctx, input)
}

func (c *Collection) ShouldRebuild(runtime string, functionID string, file string) bool {
	slog.Info("checking if function should be rebuilt", "runtime", runtime, "functionID", functionID, "file", file, "runtime", runtime)
	r, ok := c.forFunction(runtime, functionID)
	if !ok {
		return false
	}
	result := r.ShouldRebuild(functionID, file)
	slog.Info("should rebuild", "result", result, "functionID", functionID)
	return result
}

func (c *Collection) AddTarget(input *BuildInput) {
	input.CfgPath = c.cfgPath
	c.targets[input.FunctionID] = input
}
