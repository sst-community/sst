package project

import (
	"context"
	"encoding/json"
	"runtime"
	"testing"

	"github.com/sst/sst/v3/pkg/project/common"
)

func TestEnvForIncludesWranglerPath(t *testing.T) {
	project := sst5(&Project{
		app: &App{
			Name:  "my-app",
			Stage: "test",
		},
	})

	complete := &CompleteEvent{
		Devs: Devs{
			"MyWeb": {
				Name:        "MyWeb",
				Environment: map[string]string{"FOO": "bar"},
				Links:       []string{"MyKv"},
				Cloudflare: &DevCloudflare{
					Path: "/tmp/MyWeb.jsonc",
				},
			},
		},
		Links: common.Links{
			"MyKv": {
				Properties: map[string]interface{}{
					"namespaceId": "1234",
				},
			},
		},
	}

	env, err := project.EnvFor(context.Background(), complete, "MyWeb")
	if err != nil {
		t.Fatal(err)
	}

	if got := env["SST_WRANGLER_PATH"]; got != "/tmp/MyWeb.jsonc" {
		t.Fatalf("expected SST_WRANGLER_PATH to be set, got %q", got)
	}
	if got := env["FOO"]; got != "bar" {
		t.Fatalf("expected FOO to be preserved, got %q", got)
	}

	var resource map[string]interface{}
	if err := json.Unmarshal([]byte(env["SST_RESOURCE_MyKv"]), &resource); err != nil {
		t.Fatal(err)
	}
	if got := resource["namespaceId"]; got != "1234" {
		t.Fatalf("expected linked resource data, got %#v", resource)
	}
}

func TestEnvForOmitsWranglerPathWhenMissing(t *testing.T) {
	project := sst5(&Project{
		app: &App{
			Name:  "my-app",
			Stage: "test",
		},
	})

	complete := &CompleteEvent{
		Devs: Devs{
			"MyWeb": {
				Name: "MyWeb",
			},
		},
	}

	env, err := project.EnvFor(context.Background(), complete, "MyWeb")
	if err != nil {
		t.Fatal(err)
	}

	if _, ok := env["SST_WRANGLER_PATH"]; ok {
		t.Fatalf("expected SST_WRANGLER_PATH to be omitted")
	}
}

func TestAddDevEnvEnvironment(t *testing.T) {
	for _, key := range []string{"CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL", "CLOUDFLARE_DEFAULT_ACCOUNT_ID"} {
		t.Setenv(key, "")
	}

	t.Run("its environment wins over what env has", func(t *testing.T) {
		env := map[string]string{"FOO": "old", "KEEP": "k"}
		complete := &CompleteEvent{Devs: Devs{"MyWeb": {Environment: map[string]string{"FOO": "new", "BAR": "b"}}}}
		AddDevEnv(env, complete, "MyWeb", "my-app", "test")
		if env["FOO"] != "new" || env["BAR"] != "b" || env["KEEP"] != "k" {
			t.Fatalf("got %v", env)
		}
	})

	t.Run("its environment wins over the app it adds", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("Windows puts the app in SST_RESOURCES_JSON")
		}
		env := map[string]string{}
		complete := &CompleteEvent{Devs: Devs{"MyWeb": {Environment: map[string]string{"SST_RESOURCE_App": "mine"}}}}
		AddDevEnv(env, complete, "MyWeb", "my-app", "test")
		if env["SST_RESOURCE_App"] != "mine" {
			t.Fatalf("SST_RESOURCE_App = %q, want mine", env["SST_RESOURCE_App"])
		}
	})

	t.Run("no environment leaves env as it was", func(t *testing.T) {
		env := map[string]string{"KEEP": "k"}
		complete := &CompleteEvent{Devs: Devs{"MyWeb": {}}}
		AddDevEnv(env, complete, "MyWeb", "my-app", "test")
		if env["KEEP"] != "k" {
			t.Fatalf("got %v", env)
		}
		delete(env, "KEEP")
		delete(env, "SST_RESOURCE_App")
		delete(env, "SST_RESOURCES_JSON")
		if len(env) != 0 {
			t.Fatalf("unexpected keys %v", env)
		}
	})
}
