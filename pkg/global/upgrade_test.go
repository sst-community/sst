package global

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestNewestReleaseReadsEveryPage(t *testing.T) {
	type release struct {
		TagName string `json:"tag_name"`
		Draft   bool   `json:"draft"`
	}
	// The newest 100 are all 5.x, so 4.x is only on the second page
	pages := map[string][]release{"1": {}, "2": {
		{TagName: "v4.22.0", Draft: true},
		{TagName: "v4.21.3"},
		{TagName: "v4.21.2"},
	}}
	for i := 99; i >= 0; i-- {
		pages["1"] = append(pages["1"], release{TagName: fmt.Sprintf("v5.0.%d", i)})
	}
	requested := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/" + ReleaseRepo + "/releases":
			page := r.URL.Query().Get("page")
			requested = append(requested, page)
			json.NewEncoder(w).Encode(pages[page])
		case "/repos/" + ReleaseRepo + "/releases/latest":
			json.NewEncoder(w).Encode(release{TagName: "v5.0.99"})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	original := githubAPI
	githubAPI = server.URL
	defer func() { githubAPI = original }()

	cases := []struct{ installed, want, pages string }{
		{"4.20.0", "v4.21.3", "[1 2]"},
		// Not releases: the latest, without listing them
		{"dev", "v5.0.99", "[]"},
		{"0.0.0-1760000000", "v5.0.99", "[]"},
	}
	for _, c := range cases {
		requested = []string{}
		got, err := newestRelease(c.installed)
		if err != nil {
			t.Fatal(err)
		}
		if got != c.want {
			t.Errorf("from %s got %s, want %s", c.installed, got, c.want)
		}
		if fmt.Sprint(requested) != c.pages {
			t.Errorf("from %s listed pages %v, want %s", c.installed, requested, c.pages)
		}
	}
}

func TestUpgradeNodeWritesAlias(t *testing.T) {
	dir := t.TempDir()
	files := map[string]string{
		"package.json":              `{"dependencies": {"sst": "4.17.1"}}`,
		"packages/app/package.json": `{"devDependencies": {"sst": "npm:@sst-community/sst@4.17.1"}}`,
		"packages/web/package.json": `{"dependencies": {"sst-other": "1.0.0"}}`,
	}
	for name, body := range files {
		path := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0644); err != nil {
			t.Fatal(err)
		}
	}
	t.Chdir(dir)

	updated, err := UpgradeNode("4.17.1", "4.17.2")
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"package.json":              `{"dependencies": {"sst": "npm:@sst-community/sst@4.17.2"}}`,
		"packages/app/package.json": `{"devDependencies": {"sst": "npm:@sst-community/sst@4.17.2"}}`,
		"packages/web/package.json": files["packages/web/package.json"],
	}
	for name, body := range want {
		got, _ := os.ReadFile(filepath.Join(dir, name))
		if string(got) != body {
			t.Errorf("%s = %s, want %s", name, got, body)
		}
	}
	if len(updated) != 2 {
		t.Errorf("updated %v, want package.json and packages/app/package.json", updated)
	}
}
