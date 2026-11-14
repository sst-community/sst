package pulumidev

import (
	"context"
	"encoding/json"
	"fmt"
	"net/rpc"
	"os"
	"path/filepath"

	"github.com/sst/sst/v3/cmd/sst/mosaic/aws/bridge"
	"github.com/sst/sst/v3/pkg/bus"
	"github.com/sst/sst/v3/pkg/project"
	"github.com/sst/sst/v3/pkg/project/provider"
	"github.com/sst/sst/v3/pkg/runtime"
)

// RegisterRPC registers the calls sst/pulumi's transform makes, as
// PulumiDev.<method>. The program makes none of SST's own.
func (p *Program) RegisterRPC(ctx context.Context, server *rpc.Server) {
	server.RegisterName("PulumiDev", &devContract{program: p})
}

// devContract answers sst/pulumi's transform about each function and role
// the program makes, from DevFile.
type devContract struct {
	program *Program
}

// FunctionInput is a function the program makes, by its name
type FunctionInput struct {
	Name string `json:"name"`
	// Runtime is the function's own, empty when it isn't known yet
	Runtime string `json:"runtime"`
	// Image is whether its code is a container image
	Image bool `json:"image"`
	// Component is the nearest of SST's components it's made in, which
	// runs it in sst dev, or doesn't, itself
	Component *ComponentInput `json:"component,omitempty"`
}

// ComponentInput is one of SST's components, by its type and name
type ComponentInput struct {
	Type string `json:"type"`
	Name string `json:"name"`
}

// FunctionAnswer says whether sst dev runs the function on this machine, and
// what's deployed in its place
type FunctionAnswer struct {
	Live bool  `json:"live"`
	Stub *Stub `json:"stub,omitempty"`
}

// Stub is what a function sst dev runs is deployed as: the stub, which passes
// its invocations to sst dev. The program needs to know nothing else of it.
type Stub struct {
	// Code is the folder that is the function's code
	Code          string   `json:"code"`
	Handler       string   `json:"handler"`
	Runtime       string   `json:"runtime"`
	Architectures []string `json:"architectures"`
	// Environment is added to the function's own
	Environment map[string]string `json:"environment"`
	// Permissions are added to the function's role
	Permissions []bridge.StubPermission `json:"permissions"`
}

// Function says whether a function runs on this machine: it does when
// DevFile names it, and then it's built when it's first invoked.
func (d *devContract) Function(input *FunctionInput, output *FunctionAnswer) error {
	p := d.program
	p.mu.Lock()
	file := p.dev
	p.asked[input.Name] = true
	p.mu.Unlock()
	function, pattern, ok := file.Functions.find(input.Name)
	// SST's component decides: a pattern doesn't take its function, and a
	// name the file gives it exactly is a mistake
	if component := input.Component; component != nil {
		if ok && pattern == "" {
			return fmt.Errorf("%s names the %q function, which SST's %s %q makes. SST's components run their functions in sst dev themselves: take it out of %s", DevFile, input.Name, component.Type, component.Name, DevFile)
		}
		*output = FunctionAnswer{}
		return nil
	}
	if !ok {
		*output = FunctionAnswer{}
		return nil
	}
	runtimeName := function.Runtime
	if runtimeName == "" {
		runtimeName = input.Runtime
	}
	_, knownRuntime := p.runtimes.Runtime(runtimeName)
	// A function a pattern matches stays in the cloud when it can't run here,
	// and says why after the deploy: a pattern like * can't fail a deploy
	if pattern != "" {
		reason := ""
		switch {
		case input.Image:
			reason = "a container image"
		case runtimeName == "":
			reason = "its runtime isn't known yet"
		case !knownRuntime:
			reason = fmt.Sprintf("sst dev doesn't run %s", runtimeName)
		case !hasSource(p.root, function.Handler, runtimeName):
			reason = "no " + function.Handler
		}
		if reason != "" {
			p.mu.Lock()
			p.cloud[input.Name] = reason
			p.mu.Unlock()
			*output = FunctionAnswer{}
			return nil
		}
	}
	if input.Image {
		return fmt.Errorf("%s names the %q function, whose code is a container image, which sst dev can't run locally: take it out", DevFile, input.Name)
	}
	if runtimeName == "" {
		return fmt.Errorf("sst dev needs a runtime to run the %q function with: give it one in %s", input.Name, DevFile)
	}
	if !knownRuntime {
		return fmt.Errorf("sst dev can't run the %q function locally: it doesn't know the runtime %q. Name the one to run it with in %s: nodejs22.x, python3.12 or go", input.Name, runtimeName, DevFile)
	}
	// the file's read found a source for either runtime, and this is the
	// function's own
	if !hasSource(p.root, function.Handler, runtimeName) {
		return fmt.Errorf("%s: %w", DevFile, noSource(p.root, input.Name, function.Handler, runtimeName))
	}
	// It names the function's folder of built code, so it's kept to what a
	// path can safely have
	functionID := liveID(input.Name)
	if other, ok := p.AddLive(input.Name, functionID, project.FunctionReport{Handler: function.Handler, Dev: true}); !ok {
		// one a pattern matches stays in the cloud, as a pattern can't fail
		// a deploy
		if pattern != "" {
			p.mu.Lock()
			p.cloud[input.Name] = fmt.Sprintf("its id in sst dev, %s, is %s's", functionID, other)
			p.mu.Unlock()
			*output = FunctionAnswer{}
			return nil
		}
		return fmt.Errorf("the %q and %q functions would share the id %q in sst dev, with other handlers: rename one", other, input.Name, functionID)
	}

	transport, ok := p.Transport()
	if !ok {
		return p.NoTransport()
	}
	settings, err := transport.Stub(context.Background())
	if err != nil {
		return err
	}
	environment := map[string]string{}
	for key, value := range settings.Environment {
		environment[key] = value
	}
	environment["SST_FUNCTION_ID"] = functionID
	environment["SST_APP"] = p.name
	environment["SST_STAGE"] = p.stage
	if aws, ok := p.Provider("aws"); ok {
		if aws, ok := aws.(*provider.AwsProvider); ok {
			environment["SST_REGION"] = aws.Config().Region
		}
	}
	if timeout := os.Getenv("SST_FUNCTION_TIMEOUT"); timeout != "" {
		environment["SST_FUNCTION_TIMEOUT"] = timeout
	}
	if function.Streaming {
		environment["SST_FUNCTION_STREAMING"] = "true"
	}
	permissions := settings.Permissions
	if permissions == nil {
		permissions = []bridge.StubPermission{}
	}
	// The function is built when it's first invoked, as SST's are
	bus.Publish(&runtime.BuildInput{
		CfgPath:    p.config,
		Dev:        true,
		FunctionID: functionID,
		Handler:    buildHandler(p.root, function.Handler, runtimeName),
		Runtime:    runtimeName,
		Properties: json.RawMessage("{}"),
		Links:      map[string]json.RawMessage{},
	})
	p.mu.Lock()
	p.here[input.Name] = function.Handler
	p.mu.Unlock()
	*output = FunctionAnswer{
		Live: true,
		Stub: &Stub{
			Code:          filepath.Join(p.PathPlatformDir(), "dist", "bridge"),
			Handler:       "bootstrap",
			Runtime:       "provided.al2023",
			Architectures: []string{"x86_64"},
			Environment:   environment,
			Permissions:   permissions,
		},
	}
	return nil
}

// RoleInput is a role the program makes, by its name
type RoleInput struct {
	Name string `json:"name"`
}

// RoleAnswer says whether the developer's account may take the role in sst
// dev
type RoleAnswer struct {
	Trust bool `json:"trust"`
}

// Role says whether a role lets the developer's account take it: it does
// when a dev command in DevFile runs as it.
func (d *devContract) Role(input *RoleInput, output *RoleAnswer) error {
	p := d.program
	p.mu.Lock()
	file := p.dev
	p.askedRoles[input.Name] = true
	p.mu.Unlock()
	trust := false
	for _, command := range file.Commands {
		if command.roleName() == input.Name {
			trust = true
		}
	}
	*output = RoleAnswer{Trust: trust}
	return nil
}

// buildHandler is a handler as its runtime builds it: Node.js's and Python's
// find it from the project's folder, and Go's from the folder sst dev runs in,
// so it's given Go's in full, for sst dev --config infra/Pulumi.yaml
func buildHandler(root, handler, runtimeName string) string {
	if runtimeName == "go" && !filepath.IsAbs(handler) {
		return filepath.Join(root, handler)
	}
	return handler
}
