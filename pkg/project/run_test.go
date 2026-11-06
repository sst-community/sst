package project

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestProviderConfigArgs(t *testing.T) {
	// Provider args arrive through JSON from sst.config.ts (numbers are float64).
	var providers map[string]interface{}
	if err := json.Unmarshal([]byte(`{"aws":{
		"package":"@pulumi/aws@7.48.0",
		"region":"us-east-1",
		"skipCredentialsValidation":true,
		"skipMetadataApiCheck":false,
		"maxRetries":0,
		"testFraction":1.5,
		"testLargeNumber":1000000,
		"defaultTags":{"tags":{"owner":"a=b c"}},
		"endpoints":[{"s3":"http://127.0.0.1:4566"}],
		"unset":null
	},"other":{"enabled":true}}`), &providers); err != nil {
		t.Fatal(err)
	}
	args, err := providerConfigArgs(providers)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{
		"aws:testLargeNumber=1000000":                    true,
		"aws:region=us-east-1":                           true,
		"aws:skipCredentialsValidation=true":             true,
		"aws:skipMetadataApiCheck=false":                 true,
		"aws:maxRetries=0":                               true,
		"aws:testFraction=1.5":                           true,
		`aws:defaultTags={"tags":{"owner":"a=b c"}}`:     true,
		`aws:endpoints=[{"s3":"http://127.0.0.1:4566"}]`: true,
		"other:enabled=true":                             true,
	}
	for i := 0; i < len(args); i += 2 {
		if i+1 == len(args) || args[i] != "--config" {
			t.Fatalf("invalid config arguments: %v", args)
		}
		if !want[args[i+1]] {
			t.Errorf("unexpected or duplicate config: %s", args[i+1])
		}
		delete(want, args[i+1])
	}
	for missing := range want {
		t.Errorf("missing config: %s", missing)
	}
}

func TestEventLogRestarted(t *testing.T) {
	path := filepath.Join(t.TempDir(), "eventlog.json")
	// Pulumi's timestamps are in seconds, so a preview and an update can start
	// with the same line
	first := "{\"sequence\":0,\"timestamp\":1,\"policyLoadEvent\":{}}\n"
	planned := "{\"sequence\":1,\"timestamp\":1,\"resourcePreEvent\":{\"metadata\":{\"op\":\"create\"},\"planning\":true}}\n"
	done := "{\"sequence\":2,\"timestamp\":1,\"summaryEvent\":{\"isPreview\":true}}\n"
	preview := first + planned + done
	if err := os.WriteFile(path, []byte(preview), 0644); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	read := int64(len(preview))
	previewStart := []byte(first + planned)

	update := first + "{\"sequence\":1,\"timestamp\":1,\"resourcePreEvent\":{\"metadata\":{\"op\":\"create\"}}}\n"
	cases := []struct {
		name, log string
		want      bool
	}{
		{"the preview's log", preview, false},
		{"emptied for the update", "", true},
		{"shorter than what was read", first, true},
		{"from another second", strings.Replace(preview, "\"timestamp\":1", "\"timestamp\":2", 1), true},
		{"longer, from the same second", update + strings.Repeat(update[len(first):], 3), true},
	}
	for _, c := range cases {
		if err := os.WriteFile(path, []byte(c.log), 0644); err != nil {
			t.Fatal(err)
		}
		if got := eventLogRestarted(file, read, previewStart); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}

	// Read before the preview's first planned step, it's told apart only
	// while it's shorter. Longer, the loop tells by the update's first step.
	read = int64(len(first))
	for _, c := range []struct {
		name, log string
		want      bool
	}{
		{"emptied, before the planned step was read", "", true},
		{"longer, before the planned step was read", update, false},
	} {
		if err := os.WriteFile(path, []byte(c.log), 0644); err != nil {
			t.Fatal(err)
		}
		if got := eventLogRestarted(file, read, []byte(first)); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}
