package global

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

const MKCERT_VERSION = "1.4.4"

// mkcertSHA256 is the SHA-256 of each of mkcert MKCERT_VERSION's release
// binaries, checked before one is run. GitHub publishes no digests for the
// release; the Windows ones match what Scoop and winget recorded for it.
var mkcertSHA256 = map[string]string{
	"darwin-amd64":  "a32dfab51f1845d51e810db8e47dcf0e6b51ae3422426514bf5a2b8302e97d4e",
	"darwin-arm64":  "c8af0df44bce04359794dad8ea28d750437411d632748049d08644ffb66a60c6",
	"linux-amd64":   "6d31c65b03972c6dc4a14ab429f2928300518b26503f58723e532d1b0a3bbb52",
	"linux-arm64":   "b98f2cc69fd9147fe4d405d859c57504571adec0d3611c3eefd04107c7ac00d0",
	"windows-amd64": "d2660b50a9ed59eada480750561c96abc2ed4c9a38c6a24d93e30e0977631398",
	"windows-arm64": "793747256c562622d40127c8080df26add2fb44c50906ce9db63b42a5280582e",
}

// MkcertPath is where EnsureMkcert puts mkcert.
func MkcertPath() string {
	if runtime.GOOS == "windows" {
		return filepath.Join(BinPath(), "mkcert.exe")
	}
	return filepath.Join(BinPath(), "mkcert")
}

// EnsureMkcert puts mkcert MKCERT_VERSION at MkcertPath, unless the binary
// there already is that release's.
func EnsureMkcert() error {
	build := runtime.GOOS + "-" + runtime.GOARCH
	sum, ok := mkcertSHA256[build]
	if !ok {
		return fmt.Errorf("mkcert %s has no build for %s", MKCERT_VERSION, build)
	}
	path := MkcertPath()
	if fileSHA256(path) == sum {
		return nil
	}
	extension := ""
	if runtime.GOOS == "windows" {
		extension = ".exe"
	}
	url := fmt.Sprintf("https://github.com/FiloSottile/mkcert/releases/download/v%v/mkcert-v%v-%s%s", MKCERT_VERSION, MKCERT_VERSION, build, extension)
	return downloadChecked(url, path, sum)
}

func fileSHA256(path string) string {
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return ""
	}
	return hex.EncodeToString(hash.Sum(nil))
}

// downloadChecked puts what url serves at path, as an executable, only if its
// SHA-256 is sum, so a download that stopped short or was changed is never
// run.
func downloadChecked(url, path, sum string) error {
	slog.Info("mkcert downloading", "url", url)
	client := &http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Get(url)
	if err != nil {
		return fmt.Errorf("failed to download mkcert: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("failed to download mkcert: HTTP status %d", resp.StatusCode)
	}
	file, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".download-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	hash := sha256.New()
	_, err = io.Copy(io.MultiWriter(file, hash), io.LimitReader(resp.Body, 64<<20))
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return fmt.Errorf("failed to download mkcert: %w", err)
	}
	if got := hex.EncodeToString(hash.Sum(nil)); got != sum {
		return fmt.Errorf("the file at %s isn't mkcert %s: its SHA-256 is %s, not %s", url, MKCERT_VERSION, got, sum)
	}
	if err := os.Chmod(file.Name(), 0755); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}
