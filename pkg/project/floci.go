package project

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"

	"github.com/sst/sst/v3/internal/util"
	"github.com/sst/sst/v3/pkg/floci"
	"github.com/sst/sst/v3/pkg/global"
	"github.com/sst/sst/v3/pkg/project/provider"
)

func (p *Project) Floci() bool          { return p.floci != nil }
func (p *Project) FlociPreflight() bool { return p.flociChecking.Load() }

// ListenFlociBridge reserves the advertised callback until dev shuts down.
func (p *Project) ListenFlociBridge() (net.Listener, error) {
	if !p.Floci() {
		return nil, nil
	}
	listener, err := net.Listen("tcp", "0.0.0.0:0")
	if err != nil {
		return nil, err
	}
	p.env["SST_FLOCI_BRIDGE"] = fmt.Sprintf("http://host.docker.internal:%d", listener.Addr().(*net.TCPAddr).Port)
	return listener, nil
}

func (p *Project) commandEnv() []string {
	var env []string
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if key != "SST_FLOCI" && !strings.HasPrefix(key, "SST_FLOCI_") {
			env = append(env, entry)
		}
	}
	if p.Floci() {
		return provider.FlociEnvironment(env, p.floci.Endpoint)
	}
	return env
}

func (p *Project) loadFlociHome() error {
	for name := range p.app.Providers {
		if name != "aws" {
			return fmt.Errorf("Floci does not support provider %s. No AWS fallback was attempted.", name)
		}
	}
	args, ok := p.app.Providers["aws"].(map[string]interface{})
	if !ok {
		return fmt.Errorf("Floci requires the AWS provider")
	}
	for _, entry := range p.lock {
		if entry.Name == "aws" && entry.Version != "7.48.0" {
			return fmt.Errorf("Floci profile floci-2.3.0-v1 requires @pulumi/aws 7.48.0; found %s. No AWS fallback was attempted.", entry.Version)
		}
	}
	a := provider.NewAwsProvider()
	if err := a.InitFloci(p.app.Name, p.app.Stage, p.floci.Endpoint, args); err != nil {
		return err
	}
	if err := floci.ReadIdentity(context.Background(), p.floci, p.app.Name, p.app.Stage); err != nil {
		return err
	}
	p.loadedProviders = map[string]provider.Provider{"aws": a}
	p.env["SST_FLOCI"] = "1"

	p.env["SST_FLOCI_ENDPOINT"] = p.floci.Endpoint
	for _, entry := range provider.FlociEnvironment(nil, p.floci.Endpoint) {
		k, v, _ := strings.Cut(entry, "=")
		p.env[k] = v
	}
	token := make([]byte, 32)
	if _, err := rand.Read(token); err != nil {
		return err
	}
	p.env["SST_FLOCI_TOKEN"] = hex.EncodeToString(token)
	p.env["SST_FLOCI_REPORT"] = filepath.Join(p.PathWorkingDir(), "floci-preflight-"+hex.EncodeToString(token[:8])+".json")
	root := p.floci.StateRoot
	if root == "" {
		root = filepath.Join(global.ConfigDir(), "floci-preflight")
	}
	p.home = provider.NewLocalHomeAt(root)
	fmt.Fprintf(os.Stderr, "Floci target: %s | version %s | profile image %s | profile floci-2.3.0-v1 | state %s | stage %s\n", p.floci.Endpoint, floci.Version, floci.Image, root, p.app.Stage)
	return nil
}

func (p *Project) Run(ctx context.Context, input *StackInput) error {
	if !p.Floci() {
		return p.runStack(ctx, input)
	}
	if input.Command == "remove" {
		if p.app.Protect {
			return ErrProtectedStage
		}
		return provider.Purge(p.home, p.app.Name, p.app.Stage)
	}
	if input.Command != "deploy" || !input.Dev {
		return fmt.Errorf("Floci is only for sst dev")
	}
	if len(input.Target) > 0 || len(input.Exclude) > 0 {
		return fmt.Errorf("Floci requires a whole-app preview; targets and exclusions are not supported")
	}
	report := p.env["SST_FLOCI_REPORT"]
	if err := os.Remove(report); err != nil && !os.IsNotExist(err) {
		return err
	}

	p.flociChecking.Store(true)
	preview := *input
	preview.Command = "diff"
	err := p.runStack(ctx, &preview)
	p.flociChecking.Store(false)

	if data, readErr := os.ReadFile(report); readErr == nil {
		var result struct {
			Violations []struct{ Path, Operation, Reason, Fix string }
		}
		if decodeErr := json.Unmarshal(data, &result); decodeErr != nil {
			return decodeErr
		}
		if len(result.Violations) > 0 {
			messages := []string{"Floci compatibility check failed:"}
			for _, v := range result.Violations {
				messages = append(messages, fmt.Sprintf("%s -> %s: %s\n%s", v.Path, v.Operation, v.Reason, v.Fix))
			}
			return util.NewReadableError(nil, strings.Join(messages, "\n")+"\nNo AWS fallback was attempted.")
		}
	} else {
		return fmt.Errorf("Floci compatibility report missing; refusing to update: %w", readErr)
	}
	if err != nil {
		return err
	}
	identity := *p.floci
	if err := floci.EnsureIdentity(ctx, &identity, p.app.Name, p.app.Stage); err != nil {
		return err
	}

	a := p.loadedProviders["aws"].(*provider.AwsProvider)
	if _, err := a.Bootstrap(p.floci.Region); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "Floci state: %s (instance %s)\n", p.floci.StateRoot, p.floci.Instance)
	err = p.runStack(ctx, input)
	if err != nil {
		return p.flociUpdateError(err)
	}
	return nil
}

// FlociUpdateError carries local recovery guidance through CLI error presentation.
type FlociUpdateError struct {
	*util.ReadableError
}

func (p *Project) flociUpdateError(err error) error {
	recovery := "Fix the error and rerun sst dev --floci. Existing local resources are retained."
	if errors.Is(err, provider.ErrLockExists) {
		recovery = fmt.Sprintf("Stop all dev/update processes for this app and stage first. Then run SST_FLOCI_ENDPOINT=%s sst unlock --stage %s and retry sst dev --floci. Unlocking retains resources; never unlock an active update.", p.floci.Endpoint, p.app.Stage)
	}
	return &FlociUpdateError{util.NewReadableError(err, fmt.Sprintf("Floci update stopped. Local state: %s. %s No AWS fallback was attempted.", p.floci.StateRoot, recovery))}
}
