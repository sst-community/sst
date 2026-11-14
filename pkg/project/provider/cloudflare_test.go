package provider

import (
	"net/http"
	"testing"
)

func cloudflareEnv(t *testing.T, token, key, email string) {
	t.Setenv("CLOUDFLARE_API_TOKEN", token)
	t.Setenv("CLOUDFLARE_API_KEY", key)
	t.Setenv("CLOUDFLARE_EMAIL", email)
}

func TestNewCloudflareAPI(t *testing.T) {
	t.Run("the config's token over the environment's", func(t *testing.T) {
		cloudflareEnv(t, "env-token", "", "")
		api, err := NewCloudflareAPI(map[string]interface{}{"apiToken": "config-token"})
		if err != nil {
			t.Fatal(err)
		}
		if api.APIToken != "config-token" {
			t.Fatalf("token = %q", api.APIToken)
		}
	})

	t.Run("the environment's without a provider", func(t *testing.T) {
		cloudflareEnv(t, "env-token", "", "")
		api, err := NewCloudflareAPI(nil)
		if err != nil {
			t.Fatal(err)
		}
		if api.APIToken != "env-token" {
			t.Fatalf("token = %q", api.APIToken)
		}
	})

	// As the CLI has always resolved them, for the state in R2 too
	t.Run("a key and an email over a token", func(t *testing.T) {
		cloudflareEnv(t, "", "env-key", "me@example.com")
		api, err := NewCloudflareAPI(map[string]interface{}{"apiToken": "config-token"})
		if err != nil {
			t.Fatal(err)
		}
		if api.APIToken != "" || api.APIKey != "env-key" {
			t.Fatalf("token = %q, key = %q", api.APIToken, api.APIKey)
		}
	})

	t.Run("none", func(t *testing.T) {
		cloudflareEnv(t, "", "", "")
		if _, err := NewCloudflareAPI(nil); err == nil {
			t.Fatal("no error without credentials")
		}
	})
}

// What SST's components call Cloudflare's API with: the credentials the CLI
// resolved, passed on in the environment rather than kept in the state.
func TestCloudflareCredentials(t *testing.T) {
	t.Run("a token", func(t *testing.T) {
		cloudflareEnv(t, "", "", "")
		api, err := NewCloudflareAPI(map[string]interface{}{"apiToken": "config-token"})
		if err != nil {
			t.Fatal(err)
		}
		c := &CloudflareProvider{api: api, defaultAccountId: "acct"}
		env, _ := c.Env()
		if env["SST_CLOUDFLARE_API_TOKEN"] != "config-token" || env["CLOUDFLARE_DEFAULT_ACCOUNT_ID"] != "acct" {
			t.Fatalf("env = %v", env)
		}
		if _, ok := env["SST_CLOUDFLARE_API_KEY"]; ok {
			t.Fatalf("env = %v", env)
		}
		req, _ := http.NewRequest("GET", "https://api.cloudflare.com/client/v4/zones", nil)
		AuthorizeCloudflare(api, req)
		if req.Header.Get("Authorization") != "Bearer config-token" || req.Header.Get("X-Auth-Key") != "" {
			t.Fatalf("headers = %v", req.Header)
		}
	})

	t.Run("a key and an email", func(t *testing.T) {
		cloudflareEnv(t, "", "env-key", "me@example.com")
		api, err := NewCloudflareAPI(nil)
		if err != nil {
			t.Fatal(err)
		}
		c := &CloudflareProvider{api: api}
		env, _ := c.Env()
		if env["SST_CLOUDFLARE_API_KEY"] != "env-key" || env["SST_CLOUDFLARE_EMAIL"] != "me@example.com" {
			t.Fatalf("env = %v", env)
		}
		if _, ok := env["SST_CLOUDFLARE_API_TOKEN"]; ok {
			t.Fatalf("env = %v", env)
		}
		req, _ := http.NewRequest("GET", "https://api.cloudflare.com/client/v4/zones", nil)
		AuthorizeCloudflare(api, req)
		if req.Header.Get("X-Auth-Key") != "env-key" || req.Header.Get("X-Auth-Email") != "me@example.com" || req.Header.Get("Authorization") != "" {
			t.Fatalf("headers = %v", req.Header)
		}
	})
}
