package global

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestDownloadChecked(t *testing.T) {
	binary := []byte("#!/bin/sh\necho mkcert\n")
	digest := sha256.Sum256(binary)
	sum := hex.EncodeToString(digest[:])
	served := binary
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(served)
	}))
	defer server.Close()

	t.Run("puts a binary with the expected hash in place, as an executable", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "mkcert")
		if err := downloadChecked(server.URL, path, sum); err != nil {
			t.Fatal(err)
		}
		got, err := os.ReadFile(path)
		if err != nil || string(got) != string(binary) {
			t.Fatalf("read %q, %v", got, err)
		}
		if info, _ := os.Stat(path); runtime.GOOS != "windows" && info.Mode().Perm()&0111 == 0 {
			t.Fatalf("mode %v isn't executable", info.Mode())
		}
		if fileSHA256(path) != sum {
			t.Fatal("the binary in place doesn't have the hash")
		}
	})

	t.Run("leaves nothing for a binary with another hash", func(t *testing.T) {
		served = []byte("something else")
		defer func() { served = binary }()
		dir := t.TempDir()
		path := filepath.Join(dir, "mkcert")
		if err := downloadChecked(server.URL, path, sum); err == nil {
			t.Fatal("a binary with another hash was taken")
		}
		if entries, _ := os.ReadDir(dir); len(entries) != 0 {
			t.Fatalf("left %v", entries)
		}
	})

	t.Run("keeps the binary in place when a download fails", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "mkcert")
		if err := os.WriteFile(path, []byte("old"), 0755); err != nil {
			t.Fatal(err)
		}
		if err := downloadChecked(server.URL+"/missing", path, "0"); err == nil {
			t.Fatal("a bad download was taken")
		}
		if got, _ := os.ReadFile(path); string(got) != "old" {
			t.Fatalf("the binary in place became %q", got)
		}
	})
}

// Each build mkcert has for the systems SST's CLI is built for has a hash.
func TestMkcertHashes(t *testing.T) {
	for _, build := range []string{"darwin-amd64", "darwin-arm64", "linux-amd64", "linux-arm64", "windows-amd64", "windows-arm64"} {
		if len(mkcertSHA256[build]) != 64 {
			t.Errorf("no SHA-256 for %s", build)
		}
	}
}
