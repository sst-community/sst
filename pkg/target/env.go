package target

import (
	"os"
	"strings"
)

// credential is whether a variable is one of the developer's cloud settings:
// AWS's credentials, a profile, a role to assume, files to read them from, or
// an endpoint, SST's copies of them, and the other clouds SST calls,
// Cloudflare and Vercel. What Lambda sets for a function, `AWS_LAMBDA_*`,
// isn't one.
func credential(key string) bool {
	upper := strings.ToUpper(key)
	if strings.HasPrefix(upper, "AWS_LAMBDA_") {
		return false
	}
	for _, prefix := range []string{"AWS_", "SST_AWS_", "CLOUDFLARE_", "VERCEL_"} {
		if strings.HasPrefix(upper, prefix) {
			return true
		}
	}
	return false
}

// proxy is whether a variable sends calls through a proxy
func proxy(key string) bool {
	switch strings.ToUpper(key) {
	case "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "NODE_USE_ENV_PROXY":
		return true
	}
	return false
}

// targetVars point AWS's SDKs at a target: its credentials, its region and
// its endpoint, with no files to read credentials or settings from and no
// instance metadata to ask.
func targetVars(endpoint, region, accessKeyID, secretAccessKey string) []string {
	return []string{
		"AWS_ACCESS_KEY_ID=" + accessKeyID,
		"AWS_SECRET_ACCESS_KEY=" + secretAccessKey,
		"AWS_REGION=" + region,
		"AWS_DEFAULT_REGION=" + region,
		"AWS_ENDPOINT_URL=" + endpoint,
		"AWS_CONFIG_FILE=" + os.DevNull,
		"AWS_SHARED_CREDENTIALS_FILE=" + os.DevNull,
		"AWS_EC2_METADATA_DISABLED=true",
		"SST_AWS_ACCESS_KEY_ID=" + accessKeyID,
		"SST_AWS_SECRET_ACCESS_KEY=" + secretAccessKey,
		"SST_AWS_REGION=" + region,
	}
}

// Strip takes the developer's AWS settings and proxies out of an environment,
// and gives it the target's.
func Strip(base []string, endpoint, region, accessKeyID, secretAccessKey string) []string {
	env := make([]string, 0, len(base)+16)
	for _, entry := range base {
		key, _, _ := strings.Cut(entry, "=")
		if !credential(key) && !proxy(key) {
			env = append(env, entry)
		}
	}
	return append(env, targetVars(endpoint, region, accessKeyID, secretAccessKey)...)
}

// Apply sets the CLI's own environment for the target's stage: the
// developer's AWS settings go, and the target's take their place, so whatever
// the CLI starts on the stage gets them. Its proxies stay, for what it
// downloads. The program, the workers and `sst shell` are given Env, which
// takes them out too.
func (l *Local) Apply() {
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if credential(key) {
			os.Unsetenv(key)
		}
	}
	s := l.settings
	for _, entry := range targetVars(s.Endpoint, s.Region, s.Credentials.AccessKeyID, s.Credentials.SecretAccessKey) {
		key, value, _ := strings.Cut(entry, "=")
		os.Setenv(key, value)
	}
}

// Fence is what the program gets on a target's stage on top of the rest: a
// proxy that answers nothing, for every host but this machine. A call that
// isn't the target's fails, and doesn't reach anything else.
func Fence() []string {
	return []string{
		"HTTP_PROXY=http://127.0.0.1:1",
		"HTTPS_PROXY=http://127.0.0.1:1",
		"ALL_PROXY=http://127.0.0.1:1",
		"NO_PROXY=127.0.0.1,localhost,::1",
		// Node reads the proxy variables only when asked to
		"NODE_USE_ENV_PROXY=1",
	}
}
