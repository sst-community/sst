package main

import (
	"crypto/sha1"
	"crypto/sha256"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/sst/sst/v3/cmd/sst/cli"
	"github.com/sst/sst/v3/pkg/global"
	"github.com/sst/sst/v3/pkg/process"
)

var CmdCert = &cli.Command{
	Name: "cert",
	Description: cli.Description{
		Short: "Generate certificate for the Console",
		Long: strings.Join([]string{
			"Generate a locally-trusted certificate to connect to the Console.",
			"",
			"The Console can show you local logs from `sst dev` by connecting to your CLI. Certain browsers like Safari and Brave require the local connection to be running on HTTPS.",
			"",
			"This command uses [mkcert](https://github.com/FiloSottile/mkcert) internally to generate a locally-trusted certificate for `localhost`, `127.0.0.1` and `::1`. It installs a root certificate that your machine trusts, makes the certificate with it, and then deletes the root's private key, so the root can't be used to make any other certificate.",
			"",
			"The certificate lasts a little over two years; `sst dev` warns before it expires. Running this command again replaces both the root certificate and the certificate. With `--remove`, it takes the root certificate out of your machine's trust stores and deletes the certificate.",
		}, "\n"),
	},
	Flags: []cli.Flag{
		{
			Name: "remove",
			Type: "bool",
			Description: cli.Description{
				Short: "Remove the certificate and its root certificate",
				Long:  "Take the root certificate out of your machine's trust stores and delete the certificate, without making new ones.",
			},
		},
	},
	Run: func(c *cli.Cli) error {
		dir := global.CertPath()
		mkcert := func(args ...string) error {
			if err := global.EnsureMkcert(); err != nil {
				return err
			}
			cmd := process.Command(global.MkcertPath(), args...)
			cmd.Env = append(os.Environ(), "CAROOT="+dir)
			cmd.Stdout = os.Stdout
			cmd.Stderr = os.Stderr
			cmd.Stdin = os.Stdin
			return cmd.Run()
		}
		if c.Bool("remove") {
			return removeConsoleCert(dir, mkcert)
		}
		return makeConsoleCert(dir, mkcert)
	},
}

// makeConsoleCert makes the certificate sst dev serves the Console's local
// connection over TLS with, in dir, running mkcert with dir as its CAROOT.
func makeConsoleCert(dir string, mkcert func(args ...string) error) (err error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	if err := removeConsoleCert(dir, mkcert); err != nil {
		return err
	}
	rootKey := filepath.Join(dir, "rootCA-key.pem")
	// From here mkcert writes the root's key. It goes whatever happens, so
	// the root the machine trusts, even partly, can't sign anything.
	defer func() {
		if keyErr := removeFile(rootKey); err == nil {
			err = keyErr
		}
	}()
	if err := mkcert("-install"); err != nil {
		return err
	}
	return mkcert(
		"-key-file", filepath.Join(dir, "key.pem"),
		"-cert-file", filepath.Join(dir, "cert.pem"),
		"localhost", "127.0.0.1", "::1",
	)
}

// removeConsoleCert takes a root made before, by this command or by SST's,
// which kept its key, out of the machine's trust stores, and deletes it with
// its key and the certificate. When mkcert can't take the root out, as when
// it never made it in, the root is left to the developer, by its name and
// fingerprints: its key is deleted, so it can't sign anything.
func removeConsoleCert(dir string, mkcert func(args ...string) error) error {
	root := filepath.Join(dir, "rootCA.pem")
	if _, err := os.Stat(root); err == nil {
		if err := mkcert("-uninstall"); err != nil {
			fmt.Fprintf(os.Stderr, "mkcert couldn't take the root certificate it made before out of your machine's trust stores (%v). If it's there, remove it by hand: %s.\n", err, describeRoot(root))
		}
	}
	for _, file := range []string{filepath.Join(dir, "rootCA-key.pem"), root, filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")} {
		if err := removeFile(file); err != nil {
			return err
		}
	}
	return nil
}

// removeFile removes a file mkcert wrote, which can be read-only.
func removeFile(path string) error {
	os.Chmod(path, 0600)
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// describeRoot names a PEM root certificate as trust stores show it: by its
// name, its SHA-256 fingerprint, and its SHA-1 one, which Windows shows.
func describeRoot(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return "it can't be read: " + err.Error()
	}
	block, _ := pem.Decode(data)
	if block == nil {
		return "it can't be read"
	}
	name := "an unknown name"
	if certificate, err := x509.ParseCertificate(block.Bytes); err == nil {
		name = fmt.Sprintf("%q", certificate.Subject.CommonName)
	}
	sha256Sum, sha1Sum := sha256.Sum256(block.Bytes), sha1.Sum(block.Bytes)
	return fmt.Sprintf("it's named %s, with the SHA-256 fingerprint %s and the SHA-1 one %s", name, hexColons(sha256Sum[:]), hexColons(sha1Sum[:]))
}

func hexColons(sum []byte) string {
	parts := []string{}
	for _, b := range sum {
		parts = append(parts, fmt.Sprintf("%02X", b))
	}
	return strings.Join(parts, ":")
}
