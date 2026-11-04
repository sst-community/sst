// Package target is where a stage's cloud calls go: the real cloud, or a
// target an app names for the stage in its config, like an emulator that
// runs on this machine.
package target

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/sst/sst/v3/internal/util"
	"github.com/sst/sst/v3/pkg/global"
	"github.com/sst/sst/v3/pkg/project/provider"
)

// Target is where a stage's cloud calls go, with what credentials, and where
// its state is kept. The real cloud is the built-in one. Another is settings
// from a package, which the core carries out.
type Target interface {
	// Name is the target's name: "cloud" for the real one.
	Name() string
	// Start finds or starts what the target runs on, and waits until it
	// answers.
	Start(ctx context.Context) error
	// Stop stops what Start started.
	Stop(ctx context.Context) error
	// Providers sets up the app's providers for the stage: where their calls
	// go and with what credentials. It changes their settings in place, as the
	// program's providers get them.
	Providers(ctx context.Context, app, stage string, settings map[string]interface{}) (map[string]provider.Provider, error)
	// Home is where the stage's state, lock, secrets and history are kept.
	// name is the home the app names, which only the real cloud uses.
	Home(name string, providers map[string]provider.Provider, compress bool) (provider.Home, error)
	// Env is the environment of a process the core starts on the stage, made
	// from base, the CLI's own.
	Env(base []string) []string
}

// Cloud is the real cloud: the app's providers with the developer's
// credentials, and the home the app names.
type Cloud struct{}

var _ Target = Cloud{}

func (Cloud) Name() string                    { return "cloud" }
func (Cloud) Start(ctx context.Context) error { return nil }
func (Cloud) Stop(ctx context.Context) error  { return nil }
func (Cloud) Env(base []string) []string      { return base }

func (Cloud) Providers(ctx context.Context, app, stage string, settings map[string]interface{}) (map[string]provider.Provider, error) {
	loaded := map[string]provider.Provider{}
	for key, args := range settings {
		var match provider.Provider
		switch key {
		case "cloudflare":
			match = &provider.CloudflareProvider{}
		case "aws":
			match = provider.NewAwsProvider()
		}
		if match == nil {
			continue
		}
		if err := match.Init(app, stage, args.(map[string]interface{})); err != nil {
			return nil, util.NewReadableError(err, key+": "+err.Error())
		}
		loaded[key] = match
	}
	return loaded, nil
}

func (Cloud) Home(name string, providers map[string]provider.Provider, compress bool) (provider.Home, error) {
	switch name {
	case "local":
		return provider.NewLocalHome(), nil
	case "aws":
		return provider.NewAwsHome(providers["aws"].(*provider.AwsProvider), compress), nil
	case "cloudflare":
		return provider.NewCloudflareHome(providers["cloudflare"].(*provider.CloudflareProvider), compress), nil
	}
	return nil, fmt.Errorf("Home provider %s is invalid", name)
}

// Settings are a target's, as the config gives them: a plain object of the
// type `Target`.
type Settings struct {
	// Name names the target's container and its home.
	Name string `json:"name"`
	// Endpoint is where the providers send their calls, on this machine.
	Endpoint    string `json:"endpoint"`
	Region      string `json:"region"`
	Credentials struct {
		AccessKeyID     string `json:"accessKeyId"`
		SecretAccessKey string `json:"secretAccessKey"`
	} `json:"credentials"`
	// Providers are the settings the target gives each provider it takes the
	// place of, over the app's. AWS's is the only one for now.
	Providers map[string]map[string]interface{} `json:"providers"`
	// Container is what the core runs the target in, if anything.
	Container *Container `json:"container"`
}

var namePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

// Local is a target on this machine, from its settings: the core starts its
// container, if it has one, and its stages' calls go only to it.
type Local struct {
	settings Settings
}

// Parse reads a target's settings and checks them.
func Parse(data []byte) (*Local, error) {
	var settings Settings
	if err := json.Unmarshal(data, &settings); err != nil {
		return nil, fmt.Errorf("a target's settings: %w", err)
	}
	if err := settings.check(); err != nil {
		return nil, err
	}
	return &Local{settings: settings}, nil
}

// Settings are the target's settings, as the config gave them.
func (l *Local) Settings() Settings { return l.settings }

func (s *Settings) check() error {
	if !namePattern.MatchString(s.Name) {
		return fmt.Errorf("a target's name is lowercase letters, numbers and dashes, not %q", s.Name)
	}
	if err := loopback(s.Endpoint); err != nil {
		return fmt.Errorf("the %q target's endpoint %w", s.Name, err)
	}
	if s.Region == "" {
		return fmt.Errorf("the %q target needs a region", s.Name)
	}
	if s.Credentials.AccessKeyID == "" || s.Credentials.SecretAccessKey == "" {
		return fmt.Errorf("the %q target needs credentials: an access key id and a secret access key", s.Name)
	}
	if _, ok := s.Providers["aws"]; !ok {
		return fmt.Errorf("the %q target needs settings for the aws provider; it's the only one a target takes the place of for now", s.Name)
	}
	for name := range s.Providers {
		if name != "aws" {
			return fmt.Errorf("the %q target has settings for %s; a target takes the place of the aws provider only, for now", s.Name, name)
		}
	}
	if s.Container != nil {
		if err := s.Container.check(s.Name); err != nil {
			return err
		}
	}
	return nil
}

// loopback checks that an endpoint is http or https on this machine
func loopback(endpoint string) error {
	parsed, err := url.Parse(endpoint)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return fmt.Errorf("is an http or https address, not %q", endpoint)
	}
	host := parsed.Hostname()
	if host == "localhost" {
		return nil
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		return nil
	}
	return fmt.Errorf("is on this machine, at 127.0.0.1 or localhost, not %q", host)
}

var _ Target = (*Local)(nil)

func (l *Local) Name() string { return l.settings.Name }

func (l *Local) Start(ctx context.Context) error {
	s := l.settings
	if s.Container == nil {
		return waitReady(ctx, s.Endpoint)
	}
	// First, so a remove doesn't stop the container under this command
	if err := use(usesFile(s.Name)); err != nil {
		return fmt.Errorf("using the %q target: %w", s.Name, err)
	}
	if err := s.Container.start(ctx, s.Name, docker); err != nil {
		return err
	}
	return waitReady(ctx, s.Endpoint)
}

func (l *Local) Stop(ctx context.Context) error {
	_, err := l.StopContainer(ctx)
	return err
}

// StopContainer stops the target's container, if the core started it and
// it's running, and says whether it did. Its volumes are kept, and the next
// command on a stage bound to the target starts it again.
func (l *Local) StopContainer(ctx context.Context) (bool, error) {
	s := l.settings
	if s.Container == nil {
		return false, nil
	}
	return s.Container.stop(ctx, s.Name, docker)
}

// Reset removes the target's container and its volumes, and the state of
// every stage on it, of every app: what was in the target is gone with them.
// The next command on a stage bound to it starts it new.
func (l *Local) Reset(ctx context.Context) error {
	s := l.settings
	if s.Container != nil {
		if err := s.Container.reset(ctx, s.Name, docker); err != nil {
			return err
		}
	}
	return os.RemoveAll(HomeDir(s.Name))
}

// Deployed lists the stages on a target that have resources, as
// "app/stage", from the state in its home.
func Deployed(name string) ([]string, error) {
	return deployedIn(HomeDir(name))
}

func deployedIn(home string) ([]string, error) {
	files, err := filepath.Glob(filepath.Join(home, "state", "app", "*", "*.json"))
	if err != nil {
		return nil, err
	}
	stages := []string{}
	for _, file := range files {
		data, err := os.ReadFile(file)
		if err != nil {
			return nil, err
		}
		// A home can keep its state gzipped
		if len(data) > 2 && data[0] == 0x1f && data[1] == 0x8b {
			reader, err := gzip.NewReader(bytes.NewReader(data))
			if err != nil {
				return nil, err
			}
			if data, err = io.ReadAll(reader); err != nil {
				return nil, err
			}
		}
		var state struct {
			Checkpoint struct {
				Latest struct {
					Resources []struct {
						Type string `json:"type"`
					} `json:"resources"`
				} `json:"latest"`
			} `json:"checkpoint"`
		}
		if err := json.Unmarshal(data, &state); err != nil {
			return nil, fmt.Errorf("reading %s: %w", file, err)
		}
		for _, resource := range state.Checkpoint.Latest.Resources {
			// What Pulumi keeps for any stack, with nothing deployed
			if resource.Type == "pulumi:pulumi:Stack" || strings.HasPrefix(resource.Type, "pulumi:providers:") {
				continue
			}
			app := filepath.Base(filepath.Dir(file))
			stages = append(stages, app+"/"+strings.TrimSuffix(filepath.Base(file), ".json"))
			break
		}
	}
	return stages, nil
}

// clouds are the providers of other clouds SST calls, with credentials a
// target can't stand in for. The CLI calls some of their APIs for the program.
var clouds = []string{"cloudflare", "vercel"}

// CheckProviders turns down an app's providers on a target's stage that would
// reach another cloud.
func CheckProviders(t Target, providers map[string]interface{}) error {
	for _, cloud := range clouds {
		if _, ok := providers[cloud]; ok {
			return fmt.Errorf("The %q target's stage can't use the %s provider: it would reach %s's real API. Leave it out of the stage's providers in app().", t.Name(), cloud, cloud)
		}
	}
	return nil
}

// appSettings are the AWS provider's settings that pick credentials, or where
// its calls go. On a target's stage the app's are left out, and the target's
// are used.
var appSettings = []string{
	"profile",
	"accessKey",
	"secretKey",
	"token",
	"assumeRole",
	"assumeRoles",
	"assumeRoleWithWebIdentity",
	"sharedConfigFiles",
	"sharedCredentialsFiles",
	"endpoints",
	"httpProxy",
	"httpsProxy",
	"noProxy",
	"customCaBundle",
	"stsRegion",
}

// awsSettings are the aws provider's settings for the stage: the app's, less
// those that pick credentials or where calls go, and the target's over them.
func (l *Local) awsSettings(settings map[string]interface{}) map[string]interface{} {
	args, ok := settings["aws"].(map[string]interface{})
	if !ok {
		args = map[string]interface{}{}
		settings["aws"] = args
	}
	for _, key := range appSettings {
		delete(args, key)
	}
	for key, value := range l.settings.Providers["aws"] {
		args[key] = value
	}
	return args
}

// Providers sets up the aws provider for the target. A provider the target
// doesn't take the place of isn't set up in the CLI, as it would use the
// developer's credentials. The program can't reach one either: its calls are
// fenced in to this machine.
func (l *Local) Providers(ctx context.Context, app, stage string, settings map[string]interface{}) (map[string]provider.Provider, error) {
	s := l.settings
	args := l.awsSettings(settings)
	aws := provider.NewAwsProvider()
	err := aws.InitTarget(app, stage, provider.AwsTarget{
		Endpoint:        s.Endpoint,
		Region:          s.Region,
		AccessKeyID:     s.Credentials.AccessKeyID,
		SecretAccessKey: s.Credentials.SecretAccessKey,
	}, args)
	if err != nil {
		return nil, util.NewReadableError(err, fmt.Sprintf("The %q target: %v", s.Name, err))
	}
	return map[string]provider.Provider{"aws": aws}, nil
}

// Home is the target's own, a folder under the user's config folder. The
// home the app names is the real cloud's, and a target's stage never uses
// it.
func (l *Local) Home(name string, providers map[string]provider.Provider, compress bool) (provider.Home, error) {
	return provider.NewLocalHomeAt(HomeDir(l.settings.Name)), nil
}

// HomeDir is where a target's stages keep their state.
func HomeDir(name string) string {
	return filepath.Join(global.ConfigDir(), "target", name)
}

func (l *Local) Env(base []string) []string {
	s := l.settings
	return Strip(base, s.Endpoint, s.Region, s.Credentials.AccessKeyID, s.Credentials.SecretAccessKey)
}

// IsCloud is whether a target is the real cloud.
func IsCloud(t Target) bool {
	_, ok := t.(Cloud)
	return ok
}
