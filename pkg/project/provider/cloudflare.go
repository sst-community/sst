package provider

import (
	"context"
	"fmt"
	"log/slog"
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
	return map[string]string{
		"CLOUDFLARE_DEFAULT_ACCOUNT_ID": c.defaultAccountId,
	}, nil
}

func (c *CloudflareProvider) Init(app, stage string, args map[string]interface{}) error {
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
		return util.NewReadableError(nil, "Cloudflare API not initialized. Please provide CLOUDFLARE_API_TOKEN or CLOUDFLARE_API_KEY and CLOUDFLARE_EMAIL environment variables or in the provider section of the project configuration file.")
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

func (c CloudflareProvider) Api() *cloudflare.API {
	return c.api
}
