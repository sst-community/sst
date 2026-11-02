package provider

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"sort"
	"sync"
	"time"

	"github.com/pulumi/pulumi/pkg/v3/resource/stack"
	"github.com/pulumi/pulumi/sdk/v3/go/common/encoding"
	"github.com/sst/sst/v3/internal/util"
	"github.com/sst/sst/v3/pkg/flag"
	"github.com/sst/sst/v3/pkg/id"
)

// What's kept for a stage, on top of a Home. Every home stores the same
// objects under the same keys, so the CLIs that came before read what this
// writes, and the other way round.

var ErrLockExists = fmt.Errorf("Concurrent update detected, run `sst unlock --stage=<stage>` to delete lock file and retry.")
var ErrLockNotFound = fmt.Errorf("Lock not found")
var ErrStateNotFound = fmt.Errorf("state not found")

// ErrStateMissing is returned when a stage has been deployed, by its history,
// but the home finds no state for it. Deploying would create every resource
// again, then write over the real state wherever it is.
var ErrStateMissing = fmt.Errorf("This stage has been deployed before, but its state isn't in this home. Deploying would create every resource again. Check that the home, the account and the region are the ones the stage was deployed to. If the state was removed on purpose, set SST_ALLOW_MISSING_STATE=true to deploy anyway.")

// passphraseCache holds each stage's passphrase once read, by home.
var passphraseCache = map[Home]map[string]string{}
var passphraseCacheLock sync.Mutex

func cachedPassphrase(backend Home, app, stage string) (string, bool) {
	passphraseCacheLock.Lock()
	defer passphraseCacheLock.Unlock()
	passphrase, ok := passphraseCache[backend][app+"/"+stage]
	return passphrase, ok
}

func cachePassphrase(backend Home, app, stage, passphrase string) {
	passphraseCacheLock.Lock()
	defer passphraseCacheLock.Unlock()
	cache, ok := passphraseCache[backend]
	if !ok {
		cache = map[string]string{}
		passphraseCache[backend] = cache
	}
	if passphrase == "" {
		delete(cache, app+"/"+stage)
		return
	}
	cache[app+"/"+stage] = passphrase
}

func GetPassphrase(backend Home, app, stage string) (string, error) {
	slog.Info("getting passphrase", "app", app, "stage", stage)
	if passphrase, ok := cachedPassphrase(backend, app, stage); ok {
		return passphrase, nil
	}
	passphrase, err := backend.Passphrase(context.TODO(), app, stage)
	if err != nil {
		return "", err
	}
	if passphrase != "" {
		cachePassphrase(backend, app, stage, passphrase)
	}
	return passphrase, nil
}

func GetOrCreatePassphrase(backend Home, app, stage string) (string, error) {
	passphrase, err := GetPassphrase(backend, app, stage)
	if err != nil {
		return "", err
	}
	if passphrase != "" {
		return passphrase, nil
	}

	slog.Info("passphrase not found, setting passphrase", "app", app, "stage", stage)
	passphrase = flag.SST_PASSPHRASE
	if passphrase == "" {
		passphrase, err = NewPassphrase()
		if err != nil {
			return "", err
		}
	}
	err = backend.CreatePassphrase(context.TODO(), app, stage, passphrase)
	if errors.Is(err, ErrExists) {
		// Another CLI created it first. Use that one.
		passphrase, err = readCreatedPassphrase(backend, app, stage)
	}
	if err != nil {
		return "", err
	}

	cachePassphrase(backend, app, stage, passphrase)
	return passphrase, nil
}

// readCreatedPassphrase reads a passphrase another CLI has just created. A
// store like SSM may not return what was just written, so it's read a few
// times.
func readCreatedPassphrase(backend Home, app, stage string) (string, error) {
	for attempt := 0; attempt < 10; attempt++ {
		if attempt > 0 {
			time.Sleep(500 * time.Millisecond)
		}
		passphrase, err := backend.Passphrase(context.TODO(), app, stage)
		if err != nil || passphrase != "" {
			return passphrase, err
		}
	}
	return "", fmt.Errorf("the passphrase for %s/%s exists but couldn't be read", app, stage)
}

// NewPassphrase makes a passphrase the way GetOrCreatePassphrase does, without
// storing it.
func NewPassphrase() (string, error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(bytes), nil
}

type SummaryError struct {
	URN     string `json:"urn"`
	Message string `json:"message"`
}

type Update struct {
	ID            string         `json:"id"`
	RunID         string         `json:"runID,omitempty"`
	Version       string         `json:"version"`
	Command       string         `json:"command"`
	Errors        []SummaryError `json:"errors"`
	TimeStarted   string         `json:"timeStarted"`
	TimeCompleted string         `json:"timeCompleted,omitempty"`
}

func PutUpdate(backend Home, app, stage string, update *Update) error {
	slog.Info("putting update", "app", app, "stage", stage)
	update.RunID = flag.SST_RUN_ID
	return putJSON(backend, historyKey("update", app, stage, update.ID), false, update)
}

// RemoveUpdate takes an update out of a stage's history: one that stopped
// before it changed anything, to run again.
func RemoveUpdate(backend Home, app, stage, id string) error {
	return backend.Remove(context.TODO(), historyKey("update", app, stage, id))
}

// Cleanup removes a stage's event logs and snapshots, and the states moves
// started from, after a remove that left nothing. Its update history stays.
func Cleanup(backend Home, app, stage string) error {
	ctx := context.TODO()
	for _, kind := range []string{"eventlog", "snapshot", "migrate"} {
		keys, err := backend.List(ctx, Key{Kind: kind, App: app, Stage: stage})
		if err != nil {
			return err
		}
		if err := backend.Remove(ctx, keys...); err != nil {
			return err
		}
	}
	return nil
}

// historyKinds are the kinds kept for each update. "summary" was written by
// older CLIs and is still removed with the rest. "migrate" is the state a move
// started from.
var historyKinds = []string{"snapshot", "eventlog", "update", "summary", "migrate"}

// Prune keeps the history of the last `retention` updates and removes the
// rest. In a home that keeps versions, it also removes the old versions of the
// state and the lock, which the snapshots make redundant.
func Prune(backend Home, app, stage string, retention int) error {
	slog.Info("pruning state history", "app", app, "stage", stage, "retention", retention)
	ctx := context.TODO()
	snapshots, err := backend.List(ctx, Key{Kind: "snapshot", App: app, Stage: stage})
	if err != nil {
		return err
	}
	names := make([]string, len(snapshots))
	for i, key := range snapshots {
		names[i] = key.Stage
	}
	for _, updateID := range staleUpdateIDs(names, retention) {
		for _, kind := range historyKinds {
			if err := removeEverything(ctx, backend, historyKey(kind, app, stage, updateID), false); err != nil {
				return err
			}
		}
	}
	versioned, ok := backend.(VersionedHome)
	if !ok {
		return nil
	}
	if err := versioned.PruneVersions(ctx, Key{Kind: "app", App: app, Stage: stage}); err != nil {
		return err
	}
	// The current lock, if there is one, stays.
	return versioned.PruneVersions(ctx, Key{Kind: "lock", App: app, Stage: stage})
}

// Purge removes everything kept for a stage: its history, state, secrets and
// passphrase. The history goes first: if a purge stops partway, a stage left
// with history and no state would be refused by the guard for a missing state.
func Purge(backend Home, app, stage string) error {
	slog.Info("purging stage", "app", app, "stage", stage)
	ctx := context.TODO()
	for _, kind := range historyKinds {
		if err := removeEverything(ctx, backend, Key{Kind: kind, App: app, Stage: stage}, true); err != nil {
			return err
		}
	}
	for _, kind := range []string{"app", "secret"} {
		if err := removeEverything(ctx, backend, Key{Kind: kind, App: app, Stage: stage}, false); err != nil {
			return err
		}
	}
	if err := backend.RemovePassphrase(ctx, app, stage); err != nil {
		return err
	}
	cachePassphrase(backend, app, stage, "")
	return nil
}

// removeEverything removes a key, or with folder everything under it, and in a
// home that keeps versions, every version of it.
func removeEverything(ctx context.Context, backend Home, key Key, folder bool) error {
	if versioned, ok := backend.(VersionedHome); ok {
		return versioned.RemoveVersions(ctx, key, folder)
	}
	if !folder {
		return backend.Remove(ctx, key)
	}
	keys, err := backend.List(ctx, key)
	if err != nil {
		return err
	}
	return backend.Remove(ctx, keys...)
}

func GetSecrets(backend Home, app, stage string) (map[string]string, error) {
	if stage == "" {
		stage = "_fallback"
	}
	data := map[string]string{}
	err := getJSON(backend, Key{Kind: "secret", App: app, Stage: stage}, true, &data)
	if err != nil {
		return nil, err
	}
	return data, err
}

func PutSecrets(backend Home, app, stage string, data map[string]string) error {
	if stage == "" {
		stage = "_fallback"
	}
	slog.Info("putting secrets", "app", app, "stage", stage)
	if data == nil {
		return nil
	}
	return putJSON(backend, Key{Kind: "secret", App: app, Stage: stage}, true, data)
}

func PushPartialState(backend Home, updateID, app, stage string, data []byte) error {
	slog.Info("pushing partial state", "updateID", updateID)
	err := json.Unmarshal(data, &map[string]interface{}{})
	if err != nil || len(data) == 0 {
		return fmt.Errorf("something has corrupted the state file - refusing to upload: %w", err)
	}
	return backend.Put(context.TODO(), Key{Kind: "app", App: app, Stage: stage}, data, PutOptions{})
}

func PushSnapshot(backend Home, updateID, app, stage string, data []byte) error {
	slog.Info("pushing snapshot", "updateID", updateID)
	err := json.Unmarshal(data, &map[string]interface{}{})
	if err != nil {
		return fmt.Errorf("something has corrupted the state file - refusing to upload: %w", err)
	}
	return backend.Put(context.TODO(), historyKey("snapshot", app, stage, updateID), data, PutOptions{})
}

// PushMoveCopy saves the state a move starts from, before the move changes
// anything, so the stage can be put back as it was. Each attempt keeps its
// own, under its update, so one run again doesn't write over the first.
func PushMoveCopy(backend Home, updateID, app, stage string, data []byte) error {
	return backend.Put(context.TODO(), historyKey("migrate", app, stage, updateID), data, PutOptions{})
}

func PushEventLog(backend Home, updateID, app, stage string, reader io.Reader) error {
	slog.Info("pushing eventlog", "updateID", updateID)
	data, err := io.ReadAll(reader)
	if err != nil {
		return err
	}
	return backend.Put(context.TODO(), historyKey("eventlog", app, stage, updateID), data, PutOptions{})
}

func PullState(backend Home, app, stage string, out string) error {
	slog.Info("pulling state", "app", app, "stage", stage, "out", out)
	data, err := backend.Get(context.TODO(), Key{Kind: "app", App: app, Stage: stage})
	if err != nil {
		return err
	}
	if data == nil {
		return ErrStateNotFound
	}
	return os.WriteFile(out, data, 0644)
}

// HasDeployHistory reports whether the home's history says the stage is
// deployed. The newest update that finished without errors decides: a deploy
// says it is, a remove says it isn't. With no such update, a snapshot, which
// is only written with the state, says it is.
//
// A passphrase alone says nothing, since `sst diff` in 4.x and `sst secret
// set` create it before a first deploy. Neither does an update that failed:
// a first deploy can fail before it writes any state.
func HasDeployHistory(backend Home, app, stage string) (bool, error) {
	ctx := context.TODO()
	updates, err := backend.List(ctx, Key{Kind: "update", App: app, Stage: stage})
	if err != nil {
		return false, err
	}
	// Update IDs sort newest first.
	sort.Slice(updates, func(i, j int) bool { return updates[i].Stage < updates[j].Stage })
	for _, key := range updates {
		var update Update
		if err := getJSON(backend, key, false, &update); err != nil {
			// One unreadable update shouldn't block a deploy.
			slog.Warn("skipping an update that can't be read", "key", key.String(), "err", err)
			continue
		}
		if update.TimeCompleted == "" || len(update.Errors) > 0 {
			continue
		}
		switch update.Command {
		case "deploy":
			return true, nil
		case "remove":
			return false, nil
		}
	}
	snapshots, err := backend.List(ctx, Key{Kind: "snapshot", App: app, Stage: stage})
	if err != nil {
		return false, err
	}
	return len(snapshots) > 0, nil
}

type lockData struct {
	Created  time.Time `json:"created"`
	UpdateID string    `json:"updateID"`
	RunID    string    `json:"runID"`
	Command  string    `json:"command"`
	Ignore   bool      `json:"ignore"`
}

// Lock takes the stage's lock, and records the update it starts. The lock is
// written only if there's none, in one step where the home can, so two CLIs
// that start together can't both take it.
func Lock(backend Home, version, command, app, stage string) (*Update, error) {
	updateID := id.Descending()
	slog.Info("locking", "app", app, "stage", stage)
	data, err := json.Marshal(lockData{
		RunID:    os.Getenv("SST_RUN_ID"),
		Created:  time.Now(),
		UpdateID: updateID,
		Command:  command,
		Ignore:   true,
	})
	if err != nil {
		return nil, err
	}
	key := Key{Kind: "lock", App: app, Stage: stage}
	err = backend.Put(context.TODO(), key, data, PutOptions{IfAbsent: true})
	if errors.Is(err, ErrExists) {
		// A write that succeeded but lost its response is retried, and the
		// retry finds the lock. If it's this one, it's taken.
		var existing lockData
		if getJSON(backend, key, false, &existing) != nil || existing.UpdateID != updateID {
			return nil, ErrLockExists
		}
		err = nil
	}
	if err != nil {
		return nil, err
	}

	update := &Update{
		ID:          updateID,
		Version:     version,
		Command:     command,
		Errors:      nil,
		TimeStarted: time.Now().UTC().Format(time.RFC3339),
	}
	err = PutUpdate(backend, app, stage, update)
	if err != nil {
		return nil, err
	}

	return update, nil
}

func Unlock(backend Home, version, app, stage string) error {
	slog.Info("unlocking", "app", app, "stage", stage)
	return backend.Remove(context.TODO(), Key{Kind: "lock", App: app, Stage: stage})
}

func ForceUnlock(backend Home, version, app, stage string) error {
	slog.Info("force unlocking", "app", app, "stage", stage)
	var lockData lockData
	err := getJSON(backend, Key{Kind: "lock", App: app, Stage: stage}, false, &lockData)
	if err != nil {
		return err
	}
	if lockData.UpdateID != "" {
		err = PutUpdate(backend, app, stage, &Update{
			ID:            lockData.UpdateID,
			Command:       lockData.Command,
			RunID:         lockData.RunID,
			Version:       version,
			TimeCompleted: time.Now().Format(time.RFC3339),
			Errors: []SummaryError{
				{
					Message: "Update did not complete and was force unlocked with the `sst unlock` command",
				},
			},
		})
		if err != nil {
			return err
		}
	}
	return backend.Remove(context.TODO(), Key{Kind: "lock", App: app, Stage: stage})
}

// ListStages returns the app's stages that have resources.
func ListStages(backend Home, app string) ([]string, error) {
	slog.Info("listing stages", "app", app)
	keys, err := backend.List(context.TODO(), Key{Kind: "app", App: app})
	if err != nil {
		return nil, err
	}
	stages := []string{}
	for _, key := range keys {
		if hasResources(backend, app, key.Stage) {
			stages = append(stages, key.Stage)
		}
	}
	return stages, nil
}

func Info(backend Home) (util.KeyValuePairs[string], error) {
	slog.Info("fetching backend configuration info")
	return backend.Info()
}

func hasResources(backend Home, app, stage string) bool {
	data, err := backend.Get(context.TODO(), Key{Kind: "app", App: app, Stage: stage})
	if err != nil || data == nil {
		return false
	}
	checkpoint, _, _, err := stack.UnmarshalVersionedCheckpointToLatestCheckpoint(encoding.JSON, data)
	if err != nil {
		return false
	}
	return checkpoint != nil && checkpoint.Latest != nil && len(checkpoint.Latest.Resources) > 0
}

func putJSON(backend Home, key Key, encrypt bool, data interface{}) error {
	jsonBytes, err := json.Marshal(data)
	if err != nil {
		return err
	}
	if encrypt {
		gcm, err := stageCipher(backend, key.App, key.Stage, true)
		if err != nil {
			return err
		}
		nonce := make([]byte, gcm.NonceSize())
		if _, err = rand.Read(nonce); err != nil {
			return err
		}
		jsonBytes = gcm.Seal(nonce, nonce, jsonBytes, nil)
	}
	return backend.Put(context.TODO(), key, jsonBytes, PutOptions{})
}

func getJSON(backend Home, key Key, encrypted bool, out interface{}) error {
	slog.Info("getting data", "key", key.Kind, "app", key.App, "stage", key.Stage)
	data, err := backend.Get(context.TODO(), key)
	if err != nil {
		return err
	}
	if data == nil {
		return nil
	}
	if encrypted {
		gcm, err := stageCipher(backend, key.App, key.Stage, false)
		if err != nil {
			return err
		}
		if len(data) < gcm.NonceSize() {
			return fmt.Errorf("the %s for %s/%s is too short to decrypt", key.Kind, key.App, key.Stage)
		}
		nonce, ciphertext := data[:gcm.NonceSize()], data[gcm.NonceSize():]
		data, err = gcm.Open(nil, nonce, ciphertext, nil)
		if err != nil {
			return err
		}
	}
	return json.Unmarshal(data, out)
}

// stageCipher is AES-256-GCM keyed by the stage's passphrase, which is how
// secrets have always been encrypted.
func stageCipher(backend Home, app, stage string, create bool) (cipher.AEAD, error) {
	var passphrase string
	var err error
	if create {
		passphrase, err = GetOrCreatePassphrase(backend, app, stage)
	} else {
		passphrase, err = GetPassphrase(backend, app, stage)
	}
	if err != nil {
		return nil, err
	}
	key, err := base64.StdEncoding.DecodeString(passphrase)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
