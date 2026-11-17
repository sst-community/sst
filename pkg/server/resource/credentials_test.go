package resource

import (
	"context"
	"net/http"
	"testing"
)

// SST's Vercel resources call the API with the credentials the provider has,
// not ones in their inputs, which are saved to the state. Where the provider
// finds them is pkg/provider's (TestCloudflareCredentials, TestVercelToken).
func TestCredentials(t *testing.T) {
	t.Run("Vercel's", func(t *testing.T) {
		req, _ := http.NewRequest("POST", "https://api.vercel.com/v4/domains/example.com/records", nil)
		token := func() string { return "vercel-token" }
		if err := NewVercelResource(context.Background(), token).authorize(req); err != nil {
			t.Fatal(err)
		}
		if req.Header.Get("Authorization") != "Bearer vercel-token" {
			t.Fatalf("headers = %v", req.Header)
		}
	})

	t.Run("Vercel's missing", func(t *testing.T) {
		req, _ := http.NewRequest("POST", "https://api.vercel.com/v4/domains/example.com/records", nil)
		none := func() string { return "" }
		if err := NewVercelResource(context.Background(), none).authorize(req); err == nil {
			t.Fatal("no error without a token")
		}
	})
}
