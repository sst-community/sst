package project

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pulumi/pulumi/pkg/v3/resource/stack"
	"github.com/pulumi/pulumi/pkg/v3/secrets"
	"github.com/pulumi/pulumi/pkg/v3/secrets/passphrase"
	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource/config"
	"github.com/sst/sst/v3/pkg/move"
	"github.com/sst/sst/v3/pkg/project/provider"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestPlanUndo(t *testing.T) {
	done := func(id, command string) provider.Update {
		return provider.Update{ID: id, Command: command, TimeStarted: "then " + id, TimeCompleted: "then"}
	}
	failed := func(id, command string) provider.Update {
		update := done(id, command)
		update.Errors = []provider.SummaryError{{Message: "stopped"}}
		return update
	}
	// IDs sort newest first: "b" is newer than "m"; "a" is this run
	cases := map[string]struct {
		copies   []string
		updates  []provider.Update
		copy     string
		baseline string
		stopped  bool
		refused  string
	}{
		"a move": {
			copies: []string{"m"}, updates: []provider.Update{done("m", "deploy")},
			copy: "m", baseline: "m",
		},
		"deploys since, which the state decides about": {
			copies: []string{"m"}, updates: []provider.Update{done("b", "deploy"), done("c", "deploy"), done("m", "deploy")},
			copy: "m", baseline: "m",
		},
		"a move run again, which an older CLI saved a copy for": {
			copies: []string{"c", "m"}, updates: []provider.Update{done("c", "deploy"), done("m", "deploy")},
			copy: "m", baseline: "m",
		},
		"a move that sst dev finished": {
			copies: []string{"m"}, updates: []provider.Update{done("b", "deploy"), done("c", "deploy"), failed("m", "deploy")},
			copy: "m", baseline: "c",
		},
		"a move that stopped, and nothing since": {
			copies: []string{"m"}, updates: []provider.Update{failed("m", "deploy")},
			copy: "m", baseline: "m",
		},
		"gone back, then moved again": {
			copies: []string{"b", "m"}, updates: []provider.Update{done("b", "deploy"), done("c", "undo"), done("m", "deploy")},
			copy: "b", baseline: "b",
		},
		"a going back that stopped": {
			copies: []string{"m"}, updates: []provider.Update{failed("c", "undo"), done("m", "deploy")},
			copy: "m", baseline: "m", stopped: true,
		},
		"gone back already": {
			copies: []string{"m"}, updates: []provider.Update{done("c", "undo"), done("m", "deploy")},
			refused: "went back to SST 4 already, on then c",
		},
		"no move": {
			refused: "nothing to go back to",
		},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			plan, err := planUndo(c.copies, c.updates, "a")
			if c.refused != "" {
				assert.ErrorContains(t, err, c.refused)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, c.copy, plan.Copy)
			assert.Equal(t, c.copy, plan.Moved.ID)
			assert.Equal(t, c.baseline, plan.Baseline)
			assert.Equal(t, c.stopped, plan.Stopped)
		})
	}
}

func versioned(t *testing.T, checkpoint *apitype.CheckpointV3) []byte {
	raw, err := json.Marshal(checkpoint)
	require.NoError(t, err)
	data, err := json.Marshal(apitype.VersionedCheckpoint{Version: 3, Checkpoint: raw})
	require.NoError(t, err)
	return data
}

const (
	undoApp, undoStage = "app", "dev"
	undoAws            = "urn:pulumi:dev::app::pulumi:providers:aws::default_7_54_0"
	sst4Function       = "urn:pulumi:dev::app::sst:aws:Function$aws:lambda/function:Function::ApiFunction"
	sst5Function       = "urn:pulumi:dev::app::sst:aws:Function$aws:lambda/function:Function::Api"
)

func undoProvider() apitype.ResourceV3 {
	r := resourceAt(undoAws, "pulumi:providers:aws")
	r.Custom, r.ID, r.Inputs = true, "p", map[string]interface{}{"version": "7.54.0"}
	return r
}

func undoFunction(urn, id, env string) apitype.ResourceV3 {
	r := resourceAt(urn, "aws:lambda/function:Function")
	r.Custom, r.ID, r.Provider = true, resource.ID(id), undoAws+"::p"
	r.Outputs = map[string]interface{}{"environment": env}
	return r
}

var sst5Marker = resourceAt("urn:pulumi:dev::app::sst:sst:Moved::Moved", "sst:sst:Moved")

// moved leaves a home as `sst migrate` does: SST 4's state saved, SST 5's in
// its place and in the move's snapshot, the tombstone, and the move in the
// history
func moved(t *testing.T, home provider.Home, sst4, sst5 []byte) *provider.Update {
	require.NoError(t, provider.PushPartialState(home, "first", undoApp, undoStage, sst4))
	move, err := provider.Lock(home, "5.0.0", "deploy", undoApp, undoStage)
	require.NoError(t, err)
	require.NoError(t, provider.PushMoveCopy(home, move.ID, undoApp, undoStage, sst4))
	require.NoError(t, provider.PushPartialState(home, move.ID, undoApp, undoStage, sst5))
	require.NoError(t, provider.PushSnapshot(home, move.ID, undoApp, undoStage, sst5))
	move.TimeCompleted = time.Now().UTC().Format(time.RFC3339)
	require.NoError(t, provider.PutUpdate(home, undoApp, undoStage, move))
	require.NoError(t, provider.Unlock(home, undoApp, undoStage, move, provider.StageAfter{Moved: true}))
	return move
}

// deployedSince runs a deploy of SST 5's on the stage that leaves the state given
func deployedSince(t *testing.T, home provider.Home, state []byte) {
	deploy, err := provider.Lock(home, "5.0.0", "deploy", undoApp, undoStage)
	require.NoError(t, err)
	require.NoError(t, provider.PushPartialState(home, deploy.ID, undoApp, undoStage, state))
	require.NoError(t, provider.PushSnapshot(home, deploy.ID, undoApp, undoStage, state))
	deploy.TimeCompleted = "later"
	require.NoError(t, provider.PutUpdate(home, undoApp, undoStage, deploy))
	require.NoError(t, provider.Unlock(home, undoApp, undoStage, deploy, provider.StageAfter{Moved: true}))
}

func undoProject(home provider.Home) *Project {
	return &Project{app: &App{Name: undoApp, Stage: undoStage}, home: home, version: "5.0.0"}
}

func stateIn(t *testing.T, home provider.Home) *apitype.CheckpointV3 {
	data, err := home.Get(context.Background(), provider.Key{Kind: "app", App: undoApp, Stage: undoStage})
	require.NoError(t, err)
	state, err := readCheckpoint(data)
	require.NoError(t, err)
	return state
}

func lockIn(t *testing.T, home provider.Home, kind string) []byte {
	lock, err := home.Get(context.Background(), provider.Key{Kind: kind, App: undoApp, Stage: undoStage})
	require.NoError(t, err)
	return lock
}

// A stage that moved goes back to the state the move saved, with SST 5's view
// of what the move kept, and SST 4 can take its lock again. A second time is
// refused.
func TestUndo(t *testing.T) {
	ctx := context.Background()
	home := provider.NewLocalHomeAt(t.TempDir())
	sst4 := versioned(t, stateWith(undoProvider(), undoFunction(sst4Function, "app-dev-Api", "SST 4's")))
	sst5 := versioned(t, stateWith(undoProvider(), undoFunction(sst5Function, "app-dev-Api", "SST 5's"), sst5Marker))
	move := moved(t, home, sst4, sst5)
	require.Contains(t, string(lockIn(t, home, "lock")), "tombstone")

	undone, err := undoProject(home).Undo(ctx)
	require.NoError(t, err)
	assert.Equal(t, 1, undone.Refreshed)
	assert.Equal(t, move.TimeStarted, undone.Moved)
	assert.False(t, undone.Finished)

	restored := stateIn(t, home)
	assert.Equal(t, sst4Function, string(restored.Latest.Resources[1].URN))
	assert.Equal(t, "SST 5's", restored.Latest.Resources[1].Outputs["environment"])
	assert.Nil(t, markerOf(restored.Latest.Resources))
	// No lock left, so SST 4 can take its own
	assert.Nil(t, lockIn(t, home, "lock"))
	assert.Nil(t, lockIn(t, home, "lock5"))
	updates, err := provider.ListUpdates(home, undoApp, undoStage)
	require.NoError(t, err)
	require.Len(t, updates, 2)
	assert.Equal(t, "undo", updates[0].Command)
	assert.NotEmpty(t, updates[0].TimeCompleted)
	assert.Empty(t, updates[0].Errors)

	_, err = undoProject(home).Undo(ctx)
	assert.ErrorContains(t, err, "went back to SST 4 already")
	// A refused run leaves nothing in the history
	updates, err = provider.ListUpdates(home, undoApp, undoStage)
	require.NoError(t, err)
	assert.Len(t, updates, 2)
}

func TestUndoWithoutAMove(t *testing.T) {
	_, err := undoProject(provider.NewLocalHomeAt(t.TempDir())).Undo(context.Background())
	assert.ErrorContains(t, err, "nothing to go back to")
}

// A deploy since the move that only updated in place, as each start of `sst
// dev` does, doesn't stop it: its view is the one carried over
func TestUndoAfterADeployThatChangedNothingElse(t *testing.T) {
	home := provider.NewLocalHomeAt(t.TempDir())
	sst4 := versioned(t, stateWith(undoProvider(), undoFunction(sst4Function, "app-dev-Api", "SST 4's")))
	moved(t, home, sst4, versioned(t, stateWith(undoProvider(), undoFunction(sst5Function, "app-dev-Api", "SST 5's"), sst5Marker)))
	deployedSince(t, home, versioned(t, stateWith(undoProvider(), undoFunction(sst5Function, "app-dev-Api", "sst dev's"), sst5Marker)))

	undone, err := undoProject(home).Undo(context.Background())
	require.NoError(t, err)
	assert.Equal(t, 1, undone.Refreshed)
	assert.Equal(t, "sst dev's", stateIn(t, home).Latest.Resources[1].Outputs["environment"])
}

// Refused once SST 5 created, deleted or replaced something since the move:
// nothing changes, and the tombstone stays
func TestUndoRefusedAfterAChange(t *testing.T) {
	home := provider.NewLocalHomeAt(t.TempDir())
	sst4 := versioned(t, stateWith(undoProvider(), undoFunction(sst4Function, "app-dev-Api", "SST 4's")))
	moved(t, home, sst4, versioned(t, stateWith(undoProvider(), undoFunction(sst5Function, "app-dev-Api", "SST 5's"), sst5Marker)))
	changed := versioned(t, stateWith(undoProvider(), undoFunction(sst5Function, "app-dev-Api", "SST 5's"), undoFunction(sst5Function+"New", "app-dev-New", "new"), sst5Marker))
	deployedSince(t, home, changed)

	_, err := undoProject(home).Undo(context.Background())
	assert.ErrorContains(t, err, "SST 5 has created 1 and deleted or replaced 0 on the stage (ApiNew)")
	data, err := home.Get(context.Background(), provider.Key{Kind: "app", App: undoApp, Stage: undoStage})
	require.NoError(t, err)
	assert.Equal(t, changed, data)
	assert.Contains(t, string(lockIn(t, home, "lock")), "tombstone")
	updates, err := provider.ListUpdates(home, undoApp, undoStage)
	require.NoError(t, err)
	assert.Len(t, updates, 2)
}

// A move run again saved SST 5's state, as a CLI before the fix did: the
// first copy is the one to go back to
func TestUndoTakesTheFirstCopy(t *testing.T) {
	home := provider.NewLocalHomeAt(t.TempDir())
	sst4 := versioned(t, stateWith(undoProvider(), undoFunction(sst4Function, "app-dev-Api", "SST 4's")))
	sst5 := versioned(t, stateWith(undoProvider(), undoFunction(sst5Function, "app-dev-Api", "SST 5's"), sst5Marker))
	moved(t, home, sst4, sst5)
	again, err := provider.Lock(home, "5.0.0", "deploy", undoApp, undoStage)
	require.NoError(t, err)
	require.NoError(t, provider.PushMoveCopy(home, again.ID, undoApp, undoStage, sst5))
	require.NoError(t, provider.PushSnapshot(home, again.ID, undoApp, undoStage, sst5))
	again.TimeCompleted = "later"
	require.NoError(t, provider.PutUpdate(home, undoApp, undoStage, again))
	require.NoError(t, provider.Unlock(home, undoApp, undoStage, again, provider.StageAfter{Moved: true}))

	_, err = undoProject(home).Undo(context.Background())
	require.NoError(t, err)
	restored := stateIn(t, home)
	assert.Nil(t, markerOf(restored.Latest.Resources))
	assert.Equal(t, sst4Function, string(restored.Latest.Resources[1].URN))
}

// A copy of SST 5's state isn't one to go back to
func TestUndoRefusesSST5sState(t *testing.T) {
	home := provider.NewLocalHomeAt(t.TempDir())
	sst5 := versioned(t, stateWith(undoProvider(), undoFunction(sst5Function, "app-dev-Api", "SST 5's"), sst5Marker))
	moved(t, home, sst5, sst5)
	_, err := undoProject(home).Undo(context.Background())
	assert.ErrorContains(t, err, "isn't SST 4's")
	assert.Contains(t, string(lockIn(t, home, "lock")), "tombstone")
}

// A going back that put SST 4's state back and stopped before the tombstone
// is finished by a run again
func TestUndoFinishesAStoppedRun(t *testing.T) {
	home := provider.NewLocalHomeAt(t.TempDir())
	sst4 := versioned(t, stateWith(undoProvider(), undoFunction(sst4Function, "app-dev-Api", "SST 4's")))
	moved(t, home, sst4, versioned(t, stateWith(undoProvider(), undoFunction(sst5Function, "app-dev-Api", "SST 5's"), sst5Marker)))
	stopped, err := provider.Lock(home, "5.0.0", "undo", undoApp, undoStage)
	require.NoError(t, err)
	require.NoError(t, provider.PushPartialState(home, stopped.ID, undoApp, undoStage, sst4))
	stopped.TimeCompleted = "then"
	stopped.Errors = []provider.SummaryError{{Message: "the tombstone couldn't be taken out"}}
	require.NoError(t, provider.PutUpdate(home, undoApp, undoStage, stopped))
	require.NoError(t, provider.Unlock(home, undoApp, undoStage, stopped, provider.StageAfter{}))
	require.Contains(t, string(lockIn(t, home, "lock")), "tombstone")

	undone, err := undoProject(home).Undo(context.Background())
	require.NoError(t, err)
	assert.True(t, undone.Finished)
	assert.Nil(t, lockIn(t, home, "lock"))
	assert.Equal(t, sst4Function, string(stateIn(t, home).Latest.Resources[1].URN))
}

// A state SST 4 wrote for a real app comes back whole: given itself as SST
// 5's, it's refreshed from identical outputs, nothing is dropped or unknown,
// and what's written is what was read, field for field. With a code object
// gone from SST 5's state and the cloud, it's dropped, and Pulumi still reads
// the state and finds it whole.
func TestUndoRecordedStates(t *testing.T) {
	files, err := filepath.Glob(filepath.Join("..", "..", "testdata", "states", "*", "*.json"))
	require.NoError(t, err)
	require.NotEmpty(t, files)
	for _, file := range files {
		t.Run(filepath.Base(filepath.Dir(file))+"/"+filepath.Base(file), func(t *testing.T) {
			data, err := os.ReadFile(file)
			require.NoError(t, err)
			saved, err := readCheckpoint(data)
			require.NoError(t, err)
			current, err := readCheckpoint(data)
			require.NoError(t, err)
			restored, err := move.Restore(saved, current, func(apitype.ResourceV3) (bool, error) { return false, nil }, nil)
			require.NoError(t, err)
			assert.Greater(t, restored.Refreshed, 0)
			assert.Empty(t, restored.Dropped)
			assert.Empty(t, restored.Unknown)
			assert.Empty(t, restored.Replaced)

			raw, err := json.Marshal(restored.State)
			require.NoError(t, err)
			var before, after interface{}
			var versioned apitype.VersionedCheckpoint
			require.NoError(t, json.Unmarshal(data, &versioned))
			require.NoError(t, json.Unmarshal(versioned.Checkpoint, &before))
			require.NoError(t, json.Unmarshal(raw, &after))
			assert.Equal(t, before, after)

			// A code object the move deleted
			saved, err = readCheckpoint(data)
			require.NoError(t, err)
			current, err = readCheckpoint(data)
			require.NoError(t, err)
			var code resource.URN
			for i, r := range current.Latest.Resources {
				if r.Type == "aws:s3/bucketObjectv2:BucketObjectv2" && !r.Delete {
					code = r.URN
					current.Latest.Resources = append(current.Latest.Resources[:i], current.Latest.Resources[i+1:]...)
					break
				}
			}
			if code == "" {
				return
			}
			restored, err = move.Restore(saved, current, func(r apitype.ResourceV3) (bool, error) { return r.URN == code, nil }, nil)
			require.NoError(t, err)
			assert.Equal(t, []resource.URN{code}, restored.Dropped)
			snapshot, err := stack.DeserializeCheckpoint(context.Background(), blinded{}, restored.State)
			require.NoError(t, err)
			require.NoError(t, snapshot.VerifyIntegrity())
		})
	}
}

// blinded reads each of a state's secrets as the string "[secret]", as the
// recorded states' passphrases are gone
type blinded struct{}

func (blinded) OfType(context.Context, string, json.RawMessage) (secrets.Manager, error) {
	return blinded{}, nil
}

func (blinded) Type() string                { return "passphrase" }
func (blinded) State() json.RawMessage      { return nil }
func (blinded) Encrypter() config.Encrypter { return config.NewPanicCrypter() }
func (blinded) Decrypter() config.Decrypter { return blinded{} }

func (blinded) DecryptValue(context.Context, string) (string, error) { return `"[secret]"`, nil }

func (blinded) BatchDecrypt(_ context.Context, ciphertexts []string) ([]string, error) {
	out := make([]string, len(ciphertexts))
	for i := range out {
		out[i] = `"[secret]"`
	}
	return out, nil
}

// With the stage's passphrase, a secret encrypted for one salt is encrypted
// again for another, and reads back the same
func TestRecrypter(t *testing.T) {
	ctx := context.Background()
	phrase := "the stage's passphrase"
	state := func() *apitype.SecretsProvidersV1 {
		salt, _, err := passphrase.NewPassphraseSecretsManager(phrase)
		require.NoError(t, err)
		raw, err := json.Marshal(map[string]string{"salt": salt})
		require.NoError(t, err)
		return &apitype.SecretsProvidersV1{Type: "passphrase", State: raw}
	}
	sst5, sst4 := state(), state()
	require.NotEqual(t, sst5.State, sst4.State)
	from, err := passphrase.GetPassphraseSecretsManager(phrase, salt(t, sst5))
	require.NoError(t, err)
	ciphertext, err := from.Encrypter().EncryptValue(ctx, `"SST_KEY"`)
	require.NoError(t, err)

	recrypt, err := newRecrypter(ctx, phrase, sst5, sst4)
	require.NoError(t, err)
	again, err := recrypt(ciphertext)
	require.NoError(t, err)
	to, err := passphrase.GetPassphraseSecretsManager(phrase, salt(t, sst4))
	require.NoError(t, err)
	plaintext, err := to.Decrypter().DecryptValue(ctx, again)
	require.NoError(t, err)
	assert.Equal(t, `"SST_KEY"`, plaintext)
	assert.NotEqual(t, ciphertext, again)
	// Pulumi keeps each salt's secrets manager for the process, so a wrong
	// passphrase can't be tried here: it would be given the one made above
}

func salt(t *testing.T, sp *apitype.SecretsProvidersV1) string {
	var state struct {
		Salt string `json:"salt"`
	}
	require.NoError(t, json.Unmarshal(sp.State, &state))
	return state.Salt
}
