package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeMkcert writes what mkcert writes in dir, and fails the step named in
// fail.
func fakeMkcert(t *testing.T, dir string, fail string, ran *[]string) func(args ...string) error {
	return func(args ...string) error {
		step := args[0]
		*ran = append(*ran, step)
		switch step {
		case "-install":
			// mkcert makes the root, with its key, before it installs it
			os.WriteFile(filepath.Join(dir, "rootCA.pem"), []byte("root"), 0444)
			os.WriteFile(filepath.Join(dir, "rootCA-key.pem"), []byte("root key"), 0400)
		case "-key-file":
			if step == fail {
				return errors.New("failed")
			}
			os.WriteFile(filepath.Join(dir, "key.pem"), []byte("key"), 0600)
			os.WriteFile(filepath.Join(dir, "cert.pem"), []byte("cert"), 0644)
		}
		if step == fail {
			return errors.New("failed")
		}
		return nil
	}
}

func exists(dir, name string) bool {
	_, err := os.Stat(filepath.Join(dir, name))
	return err == nil
}

func TestMakeConsoleCert(t *testing.T) {
	t.Run("makes the certificate, and deletes the root's key", func(t *testing.T) {
		dir := t.TempDir()
		var ran []string
		if err := makeConsoleCert(dir, fakeMkcert(t, dir, "", &ran)); err != nil {
			t.Fatal(err)
		}
		if !exists(dir, "cert.pem") || !exists(dir, "key.pem") || !exists(dir, "rootCA.pem") || exists(dir, "rootCA-key.pem") {
			t.Fatalf("left %v", ls(dir))
		}
		if len(ran) != 2 {
			t.Fatalf("ran %v", ran)
		}
	})

	for _, fail := range []string{"-install", "-key-file"} {
		t.Run("deletes the root's key when "+fail+" fails", func(t *testing.T) {
			dir := t.TempDir()
			var ran []string
			if err := makeConsoleCert(dir, fakeMkcert(t, dir, fail, &ran)); err == nil {
				t.Fatal("no error")
			}
			if exists(dir, "rootCA-key.pem") || exists(dir, "cert.pem") {
				t.Fatalf("left %v", ls(dir))
			}
		})
	}

	t.Run("replaces an earlier root, the old SST's with its key, and its certificate", func(t *testing.T) {
		dir := t.TempDir()
		for _, name := range []string{"rootCA.pem", "rootCA-key.pem", "cert.pem", "key.pem"} {
			os.WriteFile(filepath.Join(dir, name), []byte("old"), 0400)
		}
		var ran []string
		if err := makeConsoleCert(dir, fakeMkcert(t, dir, "", &ran)); err != nil {
			t.Fatal(err)
		}
		if len(ran) != 3 || ran[0] != "-uninstall" {
			t.Fatalf("ran %v", ran)
		}
		if exists(dir, "rootCA-key.pem") {
			t.Fatal("the key was kept")
		}
		if got, _ := os.ReadFile(filepath.Join(dir, "cert.pem")); string(got) != "cert" {
			t.Fatalf("cert.pem is %q", got)
		}
	})

	t.Run("goes on when the earlier root can't be uninstalled, without its certificate", func(t *testing.T) {
		dir := t.TempDir()
		for _, name := range []string{"rootCA.pem", "rootCA-key.pem", "cert.pem", "key.pem"} {
			os.WriteFile(filepath.Join(dir, name), []byte("old"), 0400)
		}
		var ran []string
		// the uninstall fails, and so does the new certificate: nothing of
		// the old one is left to serve
		err := makeConsoleCert(dir, func(args ...string) error {
			if args[0] == "-uninstall" {
				ran = append(ran, args[0])
				return errors.New("no certs found")
			}
			return fakeMkcert(t, dir, "-key-file", &ran)(args...)
		})
		if err == nil {
			t.Fatal("no error")
		}
		if len(ran) != 3 {
			t.Fatalf("ran %v", ran)
		}
		if exists(dir, "rootCA-key.pem") || exists(dir, "cert.pem") || exists(dir, "key.pem") {
			t.Fatalf("left %v", ls(dir))
		}
	})
}

func ls(dir string) []string {
	entries, _ := os.ReadDir(dir)
	names := []string{}
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names
}

func TestRemoveConsoleCert(t *testing.T) {
	t.Run("takes the root out, and deletes it with its key and the certificate", func(t *testing.T) {
		dir := t.TempDir()
		for _, name := range []string{"rootCA.pem", "rootCA-key.pem", "cert.pem", "key.pem"} {
			os.WriteFile(filepath.Join(dir, name), []byte("old"), 0400)
		}
		var ran []string
		if err := removeConsoleCert(dir, fakeMkcert(t, dir, "", &ran)); err != nil {
			t.Fatal(err)
		}
		if len(ran) != 1 || ran[0] != "-uninstall" {
			t.Fatalf("ran %v", ran)
		}
		if names := ls(dir); len(names) != 0 {
			t.Fatalf("left %v", names)
		}
	})

	t.Run("runs nothing when there's no root", func(t *testing.T) {
		dir := t.TempDir()
		err := removeConsoleCert(dir, func(args ...string) error {
			t.Fatalf("ran mkcert %v", args)
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	})
}

func TestDescribeRoot(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rootCA.pem")
	if got := describeRoot(path); !strings.Contains(got, "can't be read") {
		t.Fatalf("a missing file: %s", got)
	}
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "mkcert dev@machine"}, NotBefore: time.Now(), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true}
	der, _ := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0644)
	got := describeRoot(path)
	sum := sha256.Sum256(der)
	if !strings.Contains(got, `"mkcert dev@machine"`) || !strings.Contains(got, fmt.Sprintf("%02X:%02X", sum[0], sum[1])) {
		t.Fatalf("got %s", got)
	}
}
