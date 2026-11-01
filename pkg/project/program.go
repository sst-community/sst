package project

import (
	"encoding/json"
	"fmt"
	"path"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
	"github.com/sst/sst/v3/pkg/global"
	"github.com/sst/sst/v3/pkg/js"
	"github.com/sst/sst/v3/pkg/target"
)

// What the core gives the Pulumi program. The 5.0 program contract replaces
// it; until then, program_test.go pins it item by item, so it changes only on
// purpose.

// programDefine is what the program reads as the globals $app, $cli and
// $dev. versions are the components' versions read from the state. The
// program contract's context() reads them, and $cli says which version of
// the contract the core speaks.
func (p *Project) programDefine(input *StackInput, versions map[string]int) (map[string]string, error) {
	cli := map[string]interface{}{
		"command":  input.Command,
		"contract": ContractVersion,
		"dev":      input.Dev,
		"move":     input.Move,
		"paths": map[string]string{
			"home":     global.ConfigDir(),
			"root":     p.PathRoot(),
			"work":     p.PathWorkingDir(),
			"platform": p.PathPlatformDir(),
		},
		"state": map[string]interface{}{
			"version": versions,
		},
	}
	cliBytes, err := json.Marshal(cli)
	if err != nil {
		return nil, err
	}
	appBytes, err := json.Marshal(p.app)
	if err != nil {
		return nil, err
	}
	return map[string]string{
		"$app": string(appBytes),
		"$cli": string(cliBytes),
		"$dev": fmt.Sprintf("%v", input.Dev),
	}, nil
}

// programEnv is the environment the program runs in: base (the user's), as
// the stage's target gives it, the providers', each secret as
// SST_SECRET_<name> with the stage's over the fallback's, Pulumi's settings,
// and SST_SERVER, the RPC the program calls, with its token. On a target's
// stage, the program can reach nothing but this machine.
func (p *Project) programEnv(base []string, passphrase, backend string, secrets, fallback map[string]string, server string) []string {
	env := p.Target().Env(append([]string{}, base...))
	if !target.IsCloud(p.Target()) {
		// Behind the fence Pulumi can't download a plugin, so it doesn't try:
		// the CLI installs them first (installPlugins)
		env = append(env, target.Fence()...)
		env = append(env, "PULUMI_DISABLE_AUTOMATIC_PLUGIN_ACQUISITION=true")
	}
	for key, value := range p.Env() {
		env = append(env, fmt.Sprintf("%v=%v", key, value))
	}
	for key, value := range fallback {
		env = append(env, fmt.Sprintf("SST_SECRET_%v=%v", key, value))
	}
	for key, value := range secrets {
		env = append(env, fmt.Sprintf("SST_SECRET_%v=%v", key, value))
	}
	nodeOptions := "--enable-source-maps --no-deprecation --no-warnings"
	if existing := lookupEnv(base, "NODE_OPTIONS"); existing != "" {
		nodeOptions = existing + " " + nodeOptions
	}
	env = append(env,
		"PULUMI_CONFIG_PASSPHRASE="+passphrase,
		"PULUMI_SKIP_UPDATE_CHECK=true",
		"PULUMI_BACKEND_URL=file://"+filepath.ToSlash(backend),
		"PULUMI_DEBUG_COMMANDS=true",
		"PULUMI_IGNORE_AMBIENT_PLUGINS=true",
		// "PULUMI_DISABLE_AUTOMATIC_PLUGIN_ACQUISITION=true",
		"NODE_OPTIONS="+nodeOptions,
		"PULUMI_HOME="+global.ConfigDir(),
	)
	if server != "" {
		env = append(env, "SST_SERVER="+server)
	}
	return env
}

// previewFirst is whether a deploy runs Pulumi's preview first, so a check's
// finding stops it before anything changes: on a stage whose program had
// checks when it last ran, which it keeps with the state as `_checks`. A
// program that turns out to have checks on a deploy with no preview stops
// before anything is registered, and the deploy runs again with one.
func previewFirst(workdir *PulumiWorkdir) bool {
	checkpoint, err := workdir.Export()
	if err != nil || checkpoint == nil || checkpoint.Latest == nil {
		return false
	}
	return checksIn(checkpoint.Latest.Resources)
}

// checksIn is whether a state's stack says its program has checks
func checksIn(resources []apitype.ResourceV3) bool {
	for _, resource := range resources {
		if resource.Type != "pulumi:pulumi:Stack" {
			continue
		}
		checks, ok := resource.Outputs["_checks"].([]interface{})
		return ok && len(checks) > 0
	}
	return false
}

// checkFinding is what a check found, from the message of a resource whose
// registration it stopped, or "" when the message isn't one. A check's
// message starts `The "<check>" check found a problem`, from
// platform/src/components/check.ts.
func checkFinding(message string) string {
	start := strings.Index(message, `The "`)
	if start < 0 || !strings.Contains(message[start:], `" check found a problem with `) {
		return ""
	}
	finding := message[start:]
	// Node adds the error's stack, which isn't the finding's
	if end := strings.Index(finding, "\n    at "); end >= 0 {
		finding = finding[:end]
	}
	return strings.TrimSpace(finding)
}

// lookupEnv is the last value of key in env, as a process sees it.
func lookupEnv(env []string, key string) string {
	value := ""
	for _, entry := range env {
		if strings.HasPrefix(entry, key+"=") {
			value = strings.TrimPrefix(entry, key+"=")
		}
	}
	return value
}

// programGlobals is what the program gets as globals: each provider under its
// alias, and `sst` for SST's components. platform maps each of the platform's
// modules (`sst/components/aws` and the rest) to its file.
func (p *Project) programGlobals() ([]js.Global, map[string]string) {
	globals := []js.Global{}
	for _, entry := range p.lock {
		globals = append(globals, js.Global{Name: entry.Alias, Module: entry.Package})
	}
	components := path.Join(filepath.ToSlash(p.PathPlatformDir()), "src/components")
	globals = append(globals, js.Global{Name: "sst", Module: components})
	platform := map[string]string{}
	for module, file := range platformModuleFiles() {
		platform[module] = path.Join(components, file+".ts")
	}
	return globals, platform
}

// providerConfigArgs is the `--config` Pulumi gets for each provider setting
// in the config's app(). Objects and lists go as JSON, and strings, booleans
// and numbers as they are. Booleans and numbers were dropped before; #212
// found it, for a target's settings.
func providerConfigArgs(providers map[string]interface{}) ([]string, error) {
	args := []string{}
	for provider, opts := range providers {
		for key, value := range opts.(map[string]interface{}) {
			// Skip SST-only fields that Pulumi doesn't understand
			if key == "package" {
				continue
			}
			switch v := value.(type) {
			case map[string]interface{}, []interface{}:
				bytes, err := json.Marshal(v)
				if err != nil {
					return nil, err
				}
				args = append(args, "--config", fmt.Sprintf("%v:%v=%v", provider, key, string(bytes)))
			case string, bool:
				args = append(args, "--config", fmt.Sprintf("%v:%v=%v", provider, key, v))
			case float64:
				args = append(args, "--config", fmt.Sprintf("%v:%v=%v", provider, key, strconv.FormatFloat(v, 'f', -1, 64)))
			}
		}
	}
	return args, nil
}
