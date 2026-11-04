package provider

import (
	"os"
	"sync"

	"github.com/cloudflare/cloudflare-go"
	"github.com/sst/sst/v3/pkg/project/provider"
)

// envCloudflare is the credentials for Cloudflare's API, read from the
// environment the first time a resource needs them: the ones the CLI resolved,
// which Pulumi passes on from it (Env in pkg/project/provider/cloudflare.go),
// or else the environment's own, as an app without the cloudflare provider in
// its config has them.
func envCloudflare() func() (*cloudflare.API, error) {
	return sync.OnceValues(func() (*cloudflare.API, error) {
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
