package provider

import (
	"os"
	"sync"

	"github.com/cloudflare/cloudflare-go"
	"github.com/sst/sst/v3/pkg/project/provider"
)

// envCloudflare is the credentials for Cloudflare's API, read the first time
// a resource needs them, which is after the engine configured the provider:
// the ones a program Pulumi runs on its own gives it in its config, those the
// CLI resolved, which Pulumi passes on from it (Env in
// pkg/project/provider/cloudflare.go), or else the environment's own, as an
// app without the cloudflare provider in its config has them.
func envCloudflare(settings func() cloudflareSettings) func() (*cloudflare.API, error) {
	return sync.OnceValues(func() (*cloudflare.API, error) {
		if s := settings(); s.Token != "" {
			return cloudflare.NewWithAPIToken(s.Token)
		} else if s.Key != "" && s.Email != "" {
			return cloudflare.New(s.Key, s.Email)
		}
		if token := os.Getenv("SST_CLOUDFLARE_API_TOKEN"); token != "" {
			return cloudflare.NewWithAPIToken(token)
		}
		key, email := os.Getenv("SST_CLOUDFLARE_API_KEY"), os.Getenv("SST_CLOUDFLARE_EMAIL")
		if key != "" && email != "" {
			return cloudflare.New(key, email)
		}
		return provider.NewCloudflareAPI(nil)
	})
}

// cloudflareSettings is the credentials a program Pulumi runs on its own gives
// SST's provider in its config (platform/src/components/plugin.ts): those of
// the Cloudflare provider its component uses. Under SST's CLI the provider has
// no config, and this is empty.
type cloudflareSettings struct {
	Token string
	Key   string
	Email string
}

// readCloudflareSettings reads cloudflareApiToken, or cloudflareApiKey and
// cloudflareEmail, from the provider's config
func readCloudflareSettings(config map[string]string) cloudflareSettings {
	return cloudflareSettings{
		Token: config["cloudflareApiToken"],
		Key:   config["cloudflareApiKey"],
		Email: config["cloudflareEmail"],
	}
}
