package provider

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	_ "unsafe"

	cloudflare "github.com/cloudflare/cloudflare-go"
	"github.com/sst/sst/v3/internal/util"
)

type CloudflareProvider struct {
	api              *cloudflare.API
	identifier       *cloudflare.ResourceContainer
	defaultAccountId string
}

var ErrCloudflareMissingAccount = fmt.Errorf("missing account")

func (c *CloudflareProvider) Env() (map[string]string, error) {
	env := map[string]string{
		"CLOUDFLARE_DEFAULT_ACCOUNT_ID": c.defaultAccountId,
	}
	// The credentials the CLI resolved, for SST's components to call
	// Cloudflare's API with, as SST_AWS_* are for AWS: given here rather than
	// in a resource's inputs or a dynamic provider's code, which are saved to
	// the state.
	if c.api == nil {
		return env, nil
	}
	if c.api.APIToken != "" {
		env["SST_CLOUDFLARE_API_TOKEN"] = c.api.APIToken
	} else {
		env["SST_CLOUDFLARE_API_KEY"] = c.api.APIKey
		env["SST_CLOUDFLARE_EMAIL"] = c.api.APIEmail
	}
	return env, nil
}

func (c *CloudflareProvider) Init(app, stage string, args map[string]interface{}) error {
	api, err := NewCloudflareAPI(args)
	if err != nil {
		return err
	}
	c.api = api
	accountID := os.Getenv("CLOUDFLARE_DEFAULT_ACCOUNT_ID")
	if accountID == "" {
		accounts, _, err := c.api.Accounts(context.Background(), cloudflare.AccountsListParams{})
		if err != nil {
			return err
		}
		if len(accounts) == 0 {
			return ErrCloudflareMissingAccount
		}
		accountID = accounts[0].ID
	}
	c.defaultAccountId = accountID
	c.identifier = cloudflare.AccountIdentifier(accountID)
	slog.Info("cloudflare account selected", "account", accountID)
	return nil
}

// NewCloudflareAPI is a client for Cloudflare's API with the credentials in
// the cloudflare provider's args in the config, or else in the environment.
func NewCloudflareAPI(args map[string]interface{}) (*cloudflare.API, error) {
	apiToken := os.Getenv("CLOUDFLARE_API_TOKEN")
	apiKey := os.Getenv("CLOUDFLARE_API_KEY")
	email := os.Getenv("CLOUDFLARE_EMAIL")
	if args["apiToken"] != nil {
		apiToken = args["apiToken"].(string)
	}
	if args["apiKey"] != nil {
		apiKey = args["apiKey"].(string)
	}
	if args["email"] != nil {
		email = args["email"].(string)
	}
	var api *cloudflare.API
	if apiToken != "" {
		api, _ = cloudflare.NewWithAPIToken(apiToken)
	}
	if apiKey != "" && email != "" {
		api, _ = cloudflare.New(apiKey, email)
	}
	if api == nil {
		return nil, util.NewReadableError(nil, "Cloudflare API not initialized. Please provide CLOUDFLARE_API_TOKEN or CLOUDFLARE_API_KEY and CLOUDFLARE_EMAIL environment variables or in the provider section of the project configuration file.")
	}
	return api, nil
}

// AuthorizeCloudflare sets a client's credentials on a request to
// Cloudflare's API that the client doesn't make itself.
func AuthorizeCloudflare(api *cloudflare.API, req *http.Request) {
	if api.APIToken != "" {
		req.Header.Set("Authorization", "Bearer "+api.APIToken)
		return
	}
	req.Header.Set("X-Auth-Key", api.APIKey)
	req.Header.Set("X-Auth-Email", api.APIEmail)
}

func (c CloudflareProvider) Api() *cloudflare.API {
	return c.api
}
