package provider

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/sst/sst/v3/internal/util"
	"github.com/sst/sst/v3/pkg/global"
)

// LocalHome keeps state in files under the user's config folder, at
// `state/<kind>/<app>/<stage>.json`, and each stage's passphrase as the file
// `state/passphrase/<app>/<stage>.json`.
type LocalHome struct {
	root string
}

var _ Home = (*LocalHome)(nil)

func NewLocalHome() *LocalHome {
	return &LocalHome{}
}

// NewLocalHomeAt keeps state in files under root, as NewLocalHome does under
// the user's config folder.
func NewLocalHomeAt(root string) *LocalHome {
	return &LocalHome{root: root}
}

func (l *LocalHome) configDir() string {
	if l.root != "" {
		return l.root
	}
	return global.ConfigDir()
}

func (l *LocalHome) Bootstrap() error {
	return nil
}

func (l *LocalHome) pathForData(key Key) string {
	return filepath.Join(l.configDir(), "state", key.Kind, key.App, fmt.Sprintf("%v.json", key.Stage))
}

func (l *LocalHome) Get(ctx context.Context, key Key) ([]byte, error) {
	data, err := os.ReadFile(l.pathForData(key))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	return data, err
}

func (l *LocalHome) Put(ctx context.Context, key Key, data []byte, opts PutOptions) error {
	p := l.pathForData(key)
	if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
		return err
	}
	if !opts.IfAbsent {
		return os.WriteFile(p, data, 0644)
	}
	// O_EXCL makes the file system refuse it if the file is there.
	file, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if errors.Is(err, os.ErrExist) {
		return ErrExists
	}
	if err != nil {
		return err
	}
	_, err = file.Write(data)
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	return err
}

func (l *LocalHome) Remove(ctx context.Context, keys ...Key) error {
	for _, key := range keys {
		err := os.Remove(l.pathForData(key))
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

func (l *LocalHome) List(ctx context.Context, prefix Key) ([]Key, error) {
	dir := filepath.Join(l.configDir(), "state", prefix.Kind, prefix.App, prefix.Stage)
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var keys []Key
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		keys = append(keys, Key{
			Kind:  prefix.Kind,
			App:   prefix.App,
			Stage: path.Join(prefix.Stage, strings.TrimSuffix(entry.Name(), ".json")),
		})
	}
	return keys, nil
}

func (l *LocalHome) Passphrase(ctx context.Context, app, stage string) (string, error) {
	data, err := l.Get(ctx, passphraseKey(app, stage))
	return string(data), err
}

func (l *LocalHome) CreatePassphrase(ctx context.Context, app, stage, passphrase string) error {
	return l.Put(ctx, passphraseKey(app, stage), []byte(passphrase), PutOptions{IfAbsent: true})
}

func (l *LocalHome) RemovePassphrase(ctx context.Context, app, stage string) error {
	return l.Remove(ctx, passphraseKey(app, stage))
}

func (l *LocalHome) Info() (util.KeyValuePairs[string], error) {
	return util.KeyValuePairs[string]{
		{Key: "Provider", Value: "Local"},
		{Key: "Path", Value: l.configDir()},
	}, nil
}
