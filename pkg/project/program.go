package project

import (
	"encoding/json"
	"fmt"
	"path"
	"path/filepath"
	"strings"

	"github.com/sst/sst/v3/pkg/global"
	"github.com/sst/sst/v3/pkg/js"
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

// programEnv is the environment the program runs in: base (the user's), the
// providers', each secret as SST_SECRET_<name> with the stage's over the
// fallback's, Pulumi's settings, and SST_SERVER, the RPC the program calls,
// with its token.
func (p *Project) programEnv(base []string, passphrase, backend string, secrets, fallback map[string]string, server string) []string {
	env := append([]string{}, base...)
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
// in the config's app(). Objects and lists go as JSON, strings as they are.
// Booleans and numbers are dropped, which is a bug: the program contract in
// step 3 fixes it, with #212's fix.
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
			case string:
				args = append(args, "--config", fmt.Sprintf("%v:%v=%v", provider, key, v))
			}
		}
	}
	return args, nil
}
