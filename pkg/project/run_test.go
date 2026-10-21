package project

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
