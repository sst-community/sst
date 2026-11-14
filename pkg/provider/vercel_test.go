package provider

import "testing"

// Vercel's token: the one the provider's config has, as a program Pulumi
// runs on its own gives it, or VERCEL_API_TOKEN, as under SST's CLI
func TestVercelToken(t *testing.T) {
	t.Setenv("VERCEL_API_TOKEN", "from-the-environment")
	if got := envVercel(func() string { return "configured" })(); got != "configured" {
		t.Errorf("with a configured token: %q", got)
	}
	if got := envVercel(func() string { return "" })(); got != "from-the-environment" {
		t.Errorf("without one: %q", got)
	}
	t.Setenv("VERCEL_API_TOKEN", "")
	if got := envVercel(func() string { return "" })(); got != "" {
		t.Errorf("with neither: %q", got)
	}
}
