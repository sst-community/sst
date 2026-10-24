package project

import (
	"encoding/json"
	"testing"

	"github.com/sst/sst/v3/pkg/project/provider"
)

func TestValidateDevAppSync(t *testing.T) {
	t.Parallel()

	for _, value := range []string{"", "shared", "stage"} {
		if err := validateDev(&AppDev{AppSync: value}); err != nil {
			t.Fatalf("dev.appsync %q: %v", value, err)
		}
	}
	if err := validateDev(nil); err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{"app", "Stage", "true"} {
		if err := validateDev(&AppDev{AppSync: value}); err == nil {
			t.Fatalf("dev.appsync %q: want an error", value)
		}
	}
}

func TestAppSyncScope(t *testing.T) {
	t.Parallel()

	cases := []struct {
		config string
		want   provider.AppSyncScope
	}{
		{`{"name":"my-app","stage":"alice"}`, provider.AppSyncScope{}},
		{`{"name":"my-app","stage":"alice","dev":{}}`, provider.AppSyncScope{}},
		{`{"name":"my-app","stage":"alice","dev":{"appsync":"shared"}}`, provider.AppSyncScope{}},
		{`{"name":"my-app","stage":"alice","dev":{"appsync":"stage"}}`, provider.AppSyncScope{App: "my-app", Stage: "alice"}},
	}
	for _, c := range cases {
		var app App
		if err := json.Unmarshal([]byte(c.config), &app); err != nil {
			t.Fatal(err)
		}
		p := &Project{app: &app}
		if got := p.AppSyncScope(); got != c.want {
			t.Fatalf("%s: got %+v, want %+v", c.config, got, c.want)
		}
	}
}
