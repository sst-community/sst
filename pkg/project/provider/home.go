package provider

import (
	"context"
	"errors"
	"path"

	"github.com/sst/sst/v3/internal/util"
)

// Key names one object in a home: its kind ("app", "lock", "secret",
// "update", "snapshot", "eventlog"), the app and the stage. A history object
// puts its update's ID after the stage, as "<stage>/<updateID>".
type Key struct {
	Kind  string
	App   string
	Stage string
}

func (k Key) String() string {
	return path.Join(k.Kind, k.App, k.Stage)
}

// passphraseKey is where a home that keeps the passphrase with the rest, like
// the local and Cloudflare homes, keeps it.
func passphraseKey(app, stage string) Key {
	return Key{Kind: "passphrase", App: app, Stage: stage}
}

// historyKey is the key of one update's object of the given kind.
func historyKey(kind, app, stage, updateID string) Key {
	return Key{Kind: kind, App: app, Stage: stage + "/" + updateID}
}

type PutOptions struct {
	// IfAbsent writes only when nothing is at the key, and returns ErrExists
	// otherwise. A home does it in one step where its store can, so two
	// writers can't both succeed.
	IfAbsent bool
}

// ErrExists is returned by a write that would replace something it was told
// not to.
var ErrExists = errors.New("already exists")

// Home stores a stage's state, lock, secrets and history, and keeps its
// passphrase. It stores bytes and doesn't know what they are: the lock, the
// secrets' encryption and the history are this package's, so every home keeps
// the same layout.
type Home interface {
	// Bootstrap finds or creates what the home needs, like a state bucket.
	Bootstrap() error
	// Get returns what's at the key, or nil when nothing is.
	Get(ctx context.Context, key Key) ([]byte, error)
	Put(ctx context.Context, key Key, data []byte, opts PutOptions) error
	// Remove removes each key. A key with nothing at it is not an error. A
	// store that keeps versions keeps the older ones (see VersionedHome).
	Remove(ctx context.Context, keys ...Key) error
	// List returns the keys under a folder: kind/app/ when the prefix has no
	// stage, kind/app/stage/ when it has one.
	List(ctx context.Context, prefix Key) ([]Key, error)
	// Passphrase returns the stage's passphrase, or "" when it has none.
	Passphrase(ctx context.Context, app, stage string) (string, error)
	// CreatePassphrase stores the stage's passphrase. It never replaces one,
	// and returns ErrExists instead.
	CreatePassphrase(ctx context.Context, app, stage, value string) error
	RemovePassphrase(ctx context.Context, app, stage string) error
	// Info describes the home for `sst state` and the like.
	Info() (util.KeyValuePairs[string], error)
}

// VersionedHome is a home whose store keeps the old versions of what it
// writes, like the AWS home's versioned bucket. Pruning and purging remove
// every version, so nothing of what they remove is left behind.
type VersionedHome interface {
	Home
	// RemoveVersions removes every version of the key, and with folder, every
	// version of everything under it.
	RemoveVersions(ctx context.Context, key Key, folder bool) error
	// PruneVersions removes every version of the key but the current one.
	PruneVersions(ctx context.Context, key Key) error
}
