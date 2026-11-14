package provider

import "os"

// vercelSettings is the token a program Pulumi runs on its own gives SST's
// provider in its config (platform/src/components/plugin.ts): that of the
// Vercel provider its component uses. Under SST's CLI the provider has no
// config, and this is empty.
type vercelSettings struct {
	Token string
}

// envVercel is the token for Vercel's API: the one a program Pulumi runs on
// its own gives SST's provider in its config, or else VERCEL_API_TOKEN, as
// under SST's CLI. It's "" when there's neither.
func envVercel(configured func() string) func() string {
	return func() string {
		if token := configured(); token != "" {
			return token
		}
		return os.Getenv("VERCEL_API_TOKEN")
	}
}
