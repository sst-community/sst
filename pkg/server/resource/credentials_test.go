package resource

import (
	"context"
	"net/http"
	"testing"
)

// SST's Vercel resources call the API with the credentials the provider has,
// not ones in their inputs, which are saved to the state. Cloudflare's are
// pkg/provider's (TestCloudflareCredentials).
func TestCredentials(t *testing.T) {
	t.Run("Vercel's", func(t *testing.T) {
		t.Setenv("VERCEL_API_TOKEN", "vercel-token")
		req, _ := http.NewRequest("POST", "https://api.vercel.com/v4/domains/example.com/records", nil)
		if err := NewVercelResource(context.Background()).authorize(req); err != nil {
			t.Fatal(err)
		}
		if req.Header.Get("Authorization") != "Bearer vercel-token" {
			t.Fatalf("headers = %v", req.Header)
		}
	})

	t.Run("Vercel's missing", func(t *testing.T) {
		t.Setenv("VERCEL_API_TOKEN", "")
		req, _ := http.NewRequest("POST", "https://api.vercel.com/v4/domains/example.com/records", nil)
		if err := NewVercelResource(context.Background()).authorize(req); err == nil {
			t.Fatal("no error without a token")
		}
	})
}
