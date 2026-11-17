package server

import (
	"context"
	"fmt"
	"io"

	"github.com/sst/sst/v3/pkg/project"
	"github.com/sst/sst/v3/pkg/runtime"
	serverRuntime "github.com/sst/sst/v3/pkg/server/runtime"
)

// ServeBuilds serves the builds of a Pulumi program that uses SST's components
// without SST's CLI, which Pulumi runs on its own. The program starts it
// (platform/src/components/rpc/binary.ts) for the first function it builds.
//
// It serves the Runtime calls alone, under the token, as the CLI's server
// does. It writes its address to out, as one line, once it's ready, and
// serves until in closes, as it does when the program exits, however it
// exits. It touches no home, state or cloud: what the program builds is
// written under the project's .sst folder, as SST's CLI writes a Pulumi
// program's builds in sst dev.
//
// platform is where SST's platform files are, which a build reads, like a
// Worker's unenv config: the sst package's platform folder, which the program
// gives it. Empty, they're in the project's .sst/platform.
func ServeBuilds(ctx context.Context, cfgPath, platform, version string, in io.Reader, out io.Writer) error {
	s, err := New()
	if err != nil {
		return err
	}
	serverRuntime.Register(ctx, builds{cfgPath: cfgPath, platform: platform, runtimes: project.NewRuntimes(cfgPath, version)}, s.Rpc)

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		io.Copy(io.Discard, in)
		cancel()
	}()
	done := make(chan error, 1)
	go func() { done <- s.Serve(ctx) }()
	select {
	case <-s.Ready:
	case err := <-done:
		return err
	}
	if _, err := fmt.Fprintln(out, s.URL()); err != nil {
		return err
	}
	return <-done
}

// builds is what the Runtime calls need of the program
type builds struct {
	cfgPath  string
	platform string
	runtimes *runtime.Collection
}

func (b builds) PathConfig() string { return b.cfgPath }

func (b builds) PathPlatformDir() string { return b.platform }

func (b builds) Runtimes() *runtime.Collection { return b.runtimes }
