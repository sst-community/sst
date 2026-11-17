package sst4

import (
	"context"
	"net/http"
	"testing"

	"github.com/sst/sst/v3/pkg/project"
)

// SST's Cloudflare and Vercel resources call the API with the credentials the
// CLI has, not ones in their inputs, which are saved to the state.
func TestCredentials(t *testing.T) {
	// An app without a cloudflare provider in its config
	app := &project.Project{}

	t.Run("Cloudflare's from the environment", func(t *testing.T) {
		t.Setenv("CLOUDFLARE_API_TOKEN", "env-token")
		t.Setenv("CLOUDFLARE_API_KEY", "")
		t.Setenv("CLOUDFLARE_EMAIL", "")
		req, _ := http.NewRequest("POST", "https://api.cloudflare.com/client/v4/zones/z/dns_records", nil)
		if err := (&CloudflareResource{context.Background(), app}).authorize(req); err != nil {
			t.Fatal(err)
		}
		if req.Header.Get("Authorization") != "Bearer env-token" {
			t.Fatalf("headers = %v", req.Header)
		}
	})

	t.Run("Cloudflare's missing", func(t *testing.T) {
		t.Setenv("CLOUDFLARE_API_TOKEN", "")
		t.Setenv("CLOUDFLARE_API_KEY", "")
		t.Setenv("CLOUDFLARE_EMAIL", "")
		req, _ := http.NewRequest("POST", "https://api.cloudflare.com/client/v4/zones/z/dns_records", nil)
		if err := (&CloudflareResource{context.Background(), app}).authorize(req); err == nil {
			t.Fatal("no error without credentials")
		}
	})

	t.Run("Vercel's", func(t *testing.T) {
		t.Setenv("VERCEL_API_TOKEN", "vercel-token")
		req, _ := http.NewRequest("POST", "https://api.vercel.com/v4/domains/example.com/records", nil)
		if err := (&VercelResource{context.Background(), app}).authorize(req); err != nil {
			t.Fatal(err)
		}
		if req.Header.Get("Authorization") != "Bearer vercel-token" {
			t.Fatalf("headers = %v", req.Header)
		}
	})

	t.Run("Vercel's missing", func(t *testing.T) {
		t.Setenv("VERCEL_API_TOKEN", "")
		req, _ := http.NewRequest("POST", "https://api.vercel.com/v4/domains/example.com/records", nil)
		if err := (&VercelResource{context.Background(), app}).authorize(req); err == nil {
			t.Fatal("no error without a token")
		}
	})
}
