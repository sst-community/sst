package provider

import (
	"io/fs"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// Each home's keys are the ones 4.x wrote. A change here loses every stage's
// state, so these are spelled out rather than built.

func TestAwsHomeKeys(t *testing.T) {
	t.Parallel()
	home := &AwsHome{}
	for key, want := range map[Key]string{
		{Kind: "app", App: "my-app", Stage: "dev"}:                          "app/my-app/dev.json",
		{Kind: "lock", App: "my-app", Stage: "dev"}:                         "lock/my-app/dev.json",
		{Kind: "secret", App: "my-app", Stage: "_fallback"}:                 "secret/my-app/_fallback.json",
		historyKey("update", "my-app", "dev", "fffffe987654000000000001"):   "update/my-app/dev/fffffe987654000000000001.json",
		historyKey("snapshot", "my-app", "dev", "fffffe987654000000000001"): "snapshot/my-app/dev/fffffe987654000000000001.json",
		historyKey("eventlog", "my-app", "dev", "fffffe987654000000000001"): "eventlog/my-app/dev/fffffe987654000000000001.json",
	} {
		if got := home.objectKey(key); got != want {
			t.Errorf("%v: expected %s, got %s", key, want, got)
		}
	}
	if got := home.folder(Key{Kind: "update", App: "my-app", Stage: "dev"}); got != "update/my-app/dev/" {
		t.Errorf("history folder: got %s", got)
	}
	if got := home.folder(Key{Kind: "app", App: "my-app"}); got != "app/my-app/" {
		t.Errorf("stages folder: got %s", got)
	}
	if got := home.pathForPassphrase("my-app", "dev"); got != "/sst/passphrase/my-app/dev" {
		t.Errorf("passphrase: got %s", got)
	}
}

func TestLocalHomeFiles(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	home := &LocalHome{root: root}
	update, err := Lock(home, "test", "deploy", "my-app", "dev")
	if err != nil {
		t.Fatal(err)
	}
	if err := PushPartialState(home, update.ID, "my-app", "dev", checkpoint("my-app", "dev", 1)); err != nil {
		t.Fatal(err)
	}
	if err := PushSnapshot(home, update.ID, "my-app", "dev", checkpoint("my-app", "dev", 1)); err != nil {
		t.Fatal(err)
	}
	if err := PutSecrets(home, "my-app", "dev", map[string]string{"A": "b"}); err != nil {
		t.Fatal(err)
	}
	var files []string
	filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			rel, _ := filepath.Rel(root, path)
			files = append(files, filepath.ToSlash(rel))
		}
		return nil
	})
	sort.Strings(files)
	want := []string{
		"state/app/my-app/dev.json",
		"state/lock/my-app/dev.json",
		// SST 5's own lock, beside SST 4's
		"state/lock5/my-app/dev.json",
		"state/passphrase/my-app/dev.json",
		"state/secret/my-app/dev.json",
		"state/snapshot/my-app/dev/" + update.ID + ".json",
		"state/update/my-app/dev/" + update.ID + ".json",
	}
	if strings.Join(files, ",") != strings.Join(want, ",") {
		t.Fatalf("expected\n%v\ngot\n%v", want, files)
	}
}
