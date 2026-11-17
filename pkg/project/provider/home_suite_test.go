package provider

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"path"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sst/sst/v3/internal/util"
)

// The suite every home passes: what the core needs from a home to keep the
// lock, the state, the secrets and the history the way the CLIs before it
// did. Each case uses an app of its own and purges it when it's done, so the
// suite can run against a real bucket.

func TestLocalHomeSuite(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	runHomeSuite(t, func() Home { return &LocalHome{root: root} })
}

func TestMemoryHomeSuite(t *testing.T) {
	t.Parallel()
	home := newMemoryHome()
	runHomeSuite(t, func() Home { return home })
}

// TestAwsHomeSuite runs the suite against the state bucket and SSM of the
// account and region in the environment. Every app it writes is named
// `sst-home-suite-<random>` and purged when its case ends.
func TestAwsHomeSuite(t *testing.T) {
	if os.Getenv("SST_TEST_AWS_HOME") == "" {
		t.Skip("set SST_TEST_AWS_HOME=1, with AWS credentials and a region, to run against a real state bucket")
	}
	provider := NewAwsProvider()
	if err := provider.Init("sst-home-suite", "test", map[string]interface{}{}); err != nil {
		t.Fatalf("initializing AWS: %v", err)
	}
	for _, compress := range []bool{false, true} {
		home := NewAwsHome(provider, compress)
		t.Run(map[bool]string{false: "plain", true: "compressed"}[compress], func(t *testing.T) {
			runHomeSuite(t, func() Home { return home })
		})
	}
}

func runHomeSuite(t *testing.T, newHome func() Home) {
	cases := []struct {
		name string
		run  func(t *testing.T, home Home, app string)
	}{
		{"one of many lockers wins", testLockRace},
		{"a held lock is reported", testLockHeld},
		{"a lock whose response was lost is still taken", testLockLostResponse},
		{"force unlock records the update", testForceUnlock},
		{"a stage on SST 5's components keeps a tombstone SST 4 takes as held", testTombstone},
		{"a stage that hasn't moved keeps no tombstone", testNoTombstone},
		{"SST 4's lock refuses SST 5, which leaves nothing", testSst4LockRefuses},
		{"a remove that leaves nothing takes the tombstone out", testTombstoneRemoved},
		{"force unlock leaves the tombstone", testForceUnlockKeepsTombstone},
		{"a tombstone SST 4 unlocked is written again", testTombstoneWrittenAgain},
		{"state round trips byte for byte", testStateRoundTrip},
		{"the passphrase stays the same", testPassphraseStays},
		{"secrets round trip", testSecretsRoundTrip},
		{"prune keeps the newest history", testPrune},
		{"cleanup removes event logs and snapshots", testCleanup},
		{"purge removes everything", testPurge},
		{"stages with resources are listed", testListStages},
		{"deploy history is found", testDeployHistory},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			home := newHome()
			app := "sst-home-suite-" + randomHex(t, 4)
			t.Cleanup(func() {
				for _, stage := range []string{"dev", "prod", "_fallback"} {
					if err := Purge(home, app, stage); err != nil {
						t.Errorf("purging %s/%s: %v", app, stage, err)
					}
				}
				for _, kind := range []string{"lock", "lock5", "app"} {
					if versioned, ok := home.(VersionedHome); ok {
						versioned.RemoveVersions(context.Background(), Key{Kind: kind, App: app, Stage: "dev"}, false)
					} else {
						home.Remove(context.Background(), Key{Kind: kind, App: app, Stage: "dev"})
					}
				}
			})
			c.run(t, home, app)
		})
	}
}

func testLockRace(t *testing.T, home Home, app string) {
	if _, ok := home.(*CloudflareHome); ok {
		t.Skip("the Cloudflare home's lock is a read, then a write")
	}
	const lockers = 10
	var wg sync.WaitGroup
	results := make([]error, lockers)
	start := make(chan struct{})
	for i := 0; i < lockers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			_, results[i] = Lock(home, "test", "deploy", app, "dev")
		}(i)
	}
	close(start)
	wg.Wait()
	won := 0
	for _, err := range results {
		switch {
		case err == nil:
			won++
		case errors.Is(err, ErrLockExists):
		default:
			t.Fatalf("unexpected error: %v", err)
		}
	}
	if won != 1 {
		t.Fatalf("expected one locker to win, %d did", won)
	}
}

func testLockHeld(t *testing.T, home Home, app string) {
	update, err := Lock(home, "test", "deploy", app, "dev")
	if err != nil {
		t.Fatalf("first lock: %v", err)
	}
	if _, err := Lock(home, "test", "deploy", app, "dev"); !errors.Is(err, ErrLockExists) {
		t.Fatalf("expected ErrLockExists, got %v", err)
	}
	if err := Unlock(home, app, "dev", update, StageAfter{}); err != nil {
		t.Fatalf("unlock: %v", err)
	}
	update, err = Lock(home, "test", "deploy", app, "dev")
	if err != nil {
		t.Fatalf("lock after unlock: %v", err)
	}
	if err := Unlock(home, app, "dev", update, StageAfter{}); err != nil {
		t.Fatalf("unlock: %v", err)
	}
}

// A write that succeeded but whose response was lost is retried by the SDK,
// and the retry finds the lock that write took.
func testLockLostResponse(t *testing.T, home Home, app string) {
	lost := &lostResponseHome{Home: home}
	update, err := Lock(lost, "test", "deploy", app, "dev")
	if err != nil {
		t.Fatalf("expected the lock to be taken, got %v", err)
	}
	if _, err := Lock(home, "test", "deploy", app, "dev"); !errors.Is(err, ErrLockExists) {
		t.Fatalf("expected another CLI to be refused, got %v", err)
	}
	Unlock(home, app, "dev", update, StageAfter{})
}

// lostResponseHome writes a lock, then answers as if it were already there.
type lostResponseHome struct{ Home }

func (l *lostResponseHome) Put(ctx context.Context, key Key, data []byte, opts PutOptions) error {
	if err := l.Home.Put(ctx, key, data, opts); err != nil || (key.Kind != "lock" && key.Kind != "lock5") {
		return err
	}
	return ErrExists
}

func testForceUnlock(t *testing.T, home Home, app string) {
	update, err := Lock(home, "test", "deploy", app, "dev")
	if err != nil {
		t.Fatalf("lock: %v", err)
	}
	tombstone, err := ForceUnlock(home, "test", app, "dev")
	if err != nil {
		t.Fatalf("force unlock: %v", err)
	}
	if tombstone {
		t.Fatalf("expected no tombstone on a stage that hasn't moved")
	}
	// Recorded once, though the run held both locks
	var recorded Update
	if err := getJSON(home, historyKey("update", app, "dev", update.ID), false, &recorded); err != nil {
		t.Fatalf("reading the update: %v", err)
	}
	if recorded.TimeCompleted == "" || len(recorded.Errors) != 1 {
		t.Fatalf("expected the update to be completed with one error, got %+v", recorded)
	}
	update, err = Lock(home, "test", "deploy", app, "dev")
	if err != nil {
		t.Fatalf("lock after force unlock: %v", err)
	}
	Unlock(home, app, "dev", update, StageAfter{})
}

// sst4Lock is what every SST 4 CLI does to take the lock, from v4.23.2's
// pkg/project/provider/provider.go: a lock whose time is set is held.
func sst4Lock(home Home, app, stage string) error {
	var held lockData
	if err := getJSON(home, sst4LockKey(app, stage), false, &held); err != nil {
		return err
	}
	if !held.Created.IsZero() {
		return ErrLockExists
	}
	return putJSON(home, sst4LockKey(app, stage), false, lockData{Created: time.Now(), UpdateID: "sst4", Command: "deploy", Ignore: true})
}

// sst4Unlock is SST 4's `sst unlock`: it removes the lock, whatever it is
func sst4Unlock(home Home, app, stage string) {
	home.Remove(context.Background(), sst4LockKey(app, stage))
}

func tombstoneOf(t *testing.T, home Home, app, stage string) bool {
	t.Helper()
	var held lockData
	if err := getJSON(home, sst4LockKey(app, stage), false, &held); err != nil {
		t.Fatalf("reading the lock SST 4 reads: %v", err)
	}
	return held.Tombstone
}

// moveStage is a run that leaves the stage on SST 5's components: a move, or
// a new stage's first deploy
func moveStage(t *testing.T, home Home, app, stage string) {
	t.Helper()
	update, err := Lock(home, "test", "deploy", app, stage)
	if err != nil {
		t.Fatalf("lock: %v", err)
	}
	if err := sst4Lock(home, app, stage); !errors.Is(err, ErrLockExists) {
		t.Fatalf("expected SST 4 to be refused during the run, got %v", err)
	}
	if err := Unlock(home, app, stage, update, StageAfter{Moved: true}); err != nil {
		t.Fatalf("unlock: %v", err)
	}
}

func testTombstone(t *testing.T, home Home, app string) {
	moveStage(t, home, app, "dev")
	if !tombstoneOf(t, home, app, "dev") {
		t.Fatalf("expected a tombstone after the stage moved")
	}
	if err := sst4Lock(home, app, "dev"); !errors.Is(err, ErrLockExists) {
		t.Fatalf("expected SST 4 to be refused, got %v", err)
	}
	// SST 5 runs on it, under its own lock alone
	update, err := Lock(home, "test", "deploy", app, "dev")
	if err != nil {
		t.Fatalf("SST 5's lock on a stage with a tombstone: %v", err)
	}
	if _, err := Lock(home, "test", "deploy", app, "dev"); !errors.Is(err, ErrLockExists) {
		t.Fatalf("expected a second SST 5 run to be refused, got %v", err)
	}
	if err := Unlock(home, app, "dev", update, StageAfter{Moved: true}); err != nil {
		t.Fatalf("unlock: %v", err)
	}
	if !tombstoneOf(t, home, app, "dev") {
		t.Fatalf("expected the tombstone to stay")
	}
	if err := sst4Lock(home, app, "dev"); !errors.Is(err, ErrLockExists) {
		t.Fatalf("expected SST 4 to be refused after another run, got %v", err)
	}
}

func testNoTombstone(t *testing.T, home Home, app string) {
	update, err := Lock(home, "test", "refresh", app, "dev")
	if err != nil {
		t.Fatalf("lock: %v", err)
	}
	if err := Unlock(home, app, "dev", update, StageAfter{}); err != nil {
		t.Fatalf("unlock: %v", err)
	}
	if err := sst4Lock(home, app, "dev"); err != nil {
		t.Fatalf("expected SST 4 to take the lock of a stage that hasn't moved, got %v", err)
	}
	sst4Unlock(home, app, "dev")
}

func testSst4LockRefuses(t *testing.T, home Home, app string) {
	if err := sst4Lock(home, app, "dev"); err != nil {
		t.Fatalf("SST 4's lock: %v", err)
	}
	if _, err := Lock(home, "test", "deploy", app, "dev"); !errors.Is(err, ErrLockExists) {
		t.Fatalf("expected SST 5 to be refused, got %v", err)
	}
	if data, err := home.Get(context.Background(), lockKey(app, "dev")); err != nil || data != nil {
		t.Fatalf("expected SST 5 to let go of its own lock, got %q, %v", data, err)
	}
	sst4Unlock(home, app, "dev")
}

func testTombstoneRemoved(t *testing.T, home Home, app string) {
	moveStage(t, home, app, "dev")
	update, err := Lock(home, "test", "remove", app, "dev")
	if err != nil {
		t.Fatalf("lock: %v", err)
	}
	if err := Unlock(home, app, "dev", update, StageAfter{Removed: true}); err != nil {
		t.Fatalf("unlock: %v", err)
	}
	for _, key := range []Key{lockKey(app, "dev"), sst4LockKey(app, "dev")} {
		if data, err := home.Get(context.Background(), key); err != nil || data != nil {
			t.Fatalf("expected nothing at %v, got %q, %v", key, data, err)
		}
	}
}

func testForceUnlockKeepsTombstone(t *testing.T, home Home, app string) {
	moveStage(t, home, app, "dev")
	update, err := Lock(home, "test", "deploy", app, "dev")
	if err != nil {
		t.Fatalf("lock: %v", err)
	}
	tombstone, err := ForceUnlock(home, "test", app, "dev")
	if err != nil {
		t.Fatalf("force unlock: %v", err)
	}
	if !tombstone || !tombstoneOf(t, home, app, "dev") {
		t.Fatalf("expected force unlock to leave the tombstone, and say so")
	}
	var recorded Update
	if err := getJSON(home, historyKey("update", app, "dev", update.ID), false, &recorded); err != nil || len(recorded.Errors) != 1 {
		t.Fatalf("expected the update to be recorded as not finished, got %+v, %v", recorded, err)
	}
	if err := sst4Lock(home, app, "dev"); !errors.Is(err, ErrLockExists) {
		t.Fatalf("expected SST 4 to be refused after a force unlock, got %v", err)
	}
	update, err = Lock(home, "test", "deploy", app, "dev")
	if err != nil {
		t.Fatalf("SST 5's lock after a force unlock: %v", err)
	}
	Unlock(home, app, "dev", update, StageAfter{Moved: true})
}

// SST 4's `sst unlock` removes the tombstone, which the guide says not to do.
// The next run of SST 5 on the stage writes it again, and so does one that
// held its own lock alone when it was removed.
func testTombstoneWrittenAgain(t *testing.T, home Home, app string) {
	moveStage(t, home, app, "dev")
	sst4Unlock(home, app, "dev")
	moveStage(t, home, app, "dev")
	if !tombstoneOf(t, home, app, "dev") {
		t.Fatalf("expected the tombstone to be written again")
	}

	update, err := Lock(home, "test", "deploy", app, "dev")
	if err != nil {
		t.Fatalf("lock: %v", err)
	}
	sst4Unlock(home, app, "dev")
	if err := Unlock(home, app, "dev", update, StageAfter{Moved: true}); err != nil {
		t.Fatalf("unlock: %v", err)
	}
	if !tombstoneOf(t, home, app, "dev") {
		t.Fatalf("expected the run's unlock to write the tombstone again")
	}

	// One SST 4 took in between is left to it
	update, err = Lock(home, "test", "deploy", app, "dev")
	if err != nil {
		t.Fatalf("lock: %v", err)
	}
	sst4Unlock(home, app, "dev")
	if err := sst4Lock(home, app, "dev"); err != nil {
		t.Fatalf("SST 4's lock: %v", err)
	}
	if err := Unlock(home, app, "dev", update, StageAfter{Moved: true}); err != nil {
		t.Fatalf("unlock: %v", err)
	}
	if tombstoneOf(t, home, app, "dev") {
		t.Fatalf("expected SST 4's lock to be left as it was")
	}
	sst4Unlock(home, app, "dev")
}

func testStateRoundTrip(t *testing.T, home Home, app string) {
	state := checkpoint(app, "dev", 3)
	if err := PushPartialState(home, "id", app, "dev", state); err != nil {
		t.Fatalf("push: %v", err)
	}
	out := filepath.Join(t.TempDir(), "state.json")
	if err := PullState(home, app, "dev", out); err != nil {
		t.Fatalf("pull: %v", err)
	}
	got, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(state) {
		t.Fatalf("state changed in the round trip")
	}
	if err := PullState(home, app, "prod", out); !errors.Is(err, ErrStateNotFound) {
		t.Fatalf("expected ErrStateNotFound for a stage with no state, got %v", err)
	}
	if err := PushPartialState(home, "id", app, "dev", []byte("{")); err == nil {
		t.Fatalf("expected a corrupt state to be refused")
	}
}

func testPassphraseStays(t *testing.T, home Home, app string) {
	ctx := context.Background()
	if p, err := home.Passphrase(ctx, app, "dev"); err != nil || p != "" {
		t.Fatalf("expected no passphrase, got %q, %v", p, err)
	}
	first, err := GetOrCreatePassphrase(home, app, "dev")
	if err != nil || first == "" {
		t.Fatalf("create: %q, %v", first, err)
	}
	if err := home.CreatePassphrase(ctx, app, "dev", "other"); !errors.Is(err, ErrExists) {
		t.Fatalf("expected ErrExists when creating a second passphrase, got %v", err)
	}
	if p, err := readCreatedPassphrase(home, app, "dev"); err != nil || p != first {
		t.Fatalf("expected the first passphrase to stay, got %q, %v", p, err)
	}

	// Another CLI creates the passphrase between this one's read and its
	// write: this one uses that passphrase rather than failing or replacing it.
	if err := home.CreatePassphrase(ctx, app, "prod", "created-elsewhere"); err != nil {
		t.Fatalf("create: %v", err)
	}
	late := &lateHome{Home: home}
	got, err := GetOrCreatePassphrase(late, app, "prod")
	if err != nil || got != "created-elsewhere" {
		t.Fatalf("expected the passphrase created elsewhere, got %q, %v", got, err)
	}
}

// lateHome misses the passphrase on its first read, as a CLI does when
// another creates it just after.
type lateHome struct {
	Home
	read bool
}

func (l *lateHome) Passphrase(ctx context.Context, app, stage string) (string, error) {
	if !l.read {
		l.read = true
		return "", nil
	}
	return l.Home.Passphrase(ctx, app, stage)
}

func testSecretsRoundTrip(t *testing.T, home Home, app string) {
	empty, err := GetSecrets(home, app, "dev")
	if err != nil || len(empty) != 0 {
		t.Fatalf("expected no secrets, got %v, %v", empty, err)
	}
	secrets := map[string]string{"Token": "abc", "Other": "x y z"}
	if err := PutSecrets(home, app, "dev", secrets); err != nil {
		t.Fatalf("put: %v", err)
	}
	got, err := GetSecrets(home, app, "dev")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !reflect.DeepEqual(got, secrets) {
		t.Fatalf("expected %v, got %v", secrets, got)
	}
	raw, err := home.Get(context.Background(), Key{Kind: "secret", App: app, Stage: "dev"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "abc") {
		t.Fatalf("secrets are stored in the clear")
	}
	if err := PutSecrets(home, app, "", map[string]string{"Fallback": "1"}); err != nil {
		t.Fatalf("put fallback: %v", err)
	}
	fallback, err := GetSecrets(home, app, "")
	if err != nil || fallback["Fallback"] != "1" {
		t.Fatalf("fallback: %v, %v", fallback, err)
	}
}

// deployN runs n updates the way a deploy does: lock, state, snapshot, event
// log, update, unlock. It returns their IDs, newest first.
func deployN(t *testing.T, home Home, app, stage string, n int) []string {
	var ids []string
	for i := 0; i < n; i++ {
		update, err := Lock(home, "test", "deploy", app, stage)
		if err != nil {
			t.Fatalf("lock: %v", err)
		}
		state := checkpoint(app, stage, 1)
		if err := PushPartialState(home, update.ID, app, stage, state); err != nil {
			t.Fatal(err)
		}
		if err := PushSnapshot(home, update.ID, app, stage, state); err != nil {
			t.Fatal(err)
		}
		if err := PushEventLog(home, update.ID, app, stage, strings.NewReader("{}\n")); err != nil {
			t.Fatal(err)
		}
		update.TimeCompleted = time.Now().Format(time.RFC3339)
		if err := PutUpdate(home, app, stage, update); err != nil {
			t.Fatal(err)
		}
		if err := Unlock(home, app, stage, update, StageAfter{}); err != nil {
			t.Fatal(err)
		}
		ids = append([]string{update.ID}, ids...)
		// IDs are made from the time; keep them apart.
		time.Sleep(5 * time.Millisecond)
	}
	return ids
}

func listed(t *testing.T, home Home, kind, app, stage string) []string {
	keys, err := home.List(context.Background(), Key{Kind: kind, App: app, Stage: stage})
	if err != nil {
		t.Fatalf("list %s: %v", kind, err)
	}
	ids := make([]string, len(keys))
	for i, key := range keys {
		if key.Kind != kind || key.App != app || !strings.HasPrefix(key.Stage, stage+"/") {
			t.Fatalf("list %s returned %+v", kind, key)
		}
		ids[i] = path.Base(key.Stage)
	}
	sort.Strings(ids)
	return ids
}

func testPrune(t *testing.T, home Home, app string) {
	ids := deployN(t, home, app, "dev", 5)
	if err := Prune(home, app, "dev", 3); err != nil {
		t.Fatalf("prune: %v", err)
	}
	kept := append([]string{}, ids[:3]...)
	sort.Strings(kept)
	for _, kind := range []string{"snapshot", "eventlog", "update"} {
		if got := listed(t, home, kind, app, "dev"); !reflect.DeepEqual(got, kept) {
			t.Fatalf("%s: expected %v, got %v", kind, kept, got)
		}
	}
	if !hasResources(home, app, "dev") {
		t.Fatalf("expected the current state to stay")
	}
}

func testCleanup(t *testing.T, home Home, app string) {
	ids := deployN(t, home, app, "dev", 2)
	// The state a move started from
	if err := PushMoveCopy(home, ids[0], app, "dev", checkpoint(app, "dev", 1)); err != nil {
		t.Fatal(err)
	}
	if err := Cleanup(home, app, "dev"); err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	for _, kind := range []string{"snapshot", "eventlog", "migrate"} {
		if got := listed(t, home, kind, app, "dev"); len(got) != 0 {
			t.Fatalf("%s: expected none, got %v", kind, got)
		}
	}
	if got := listed(t, home, "update", app, "dev"); len(got) != len(ids) {
		t.Fatalf("expected the updates to stay, got %v", got)
	}
}

func testPurge(t *testing.T, home Home, app string) {
	deployN(t, home, app, "dev", 2)
	if err := PutSecrets(home, app, "dev", map[string]string{"A": "b"}); err != nil {
		t.Fatal(err)
	}
	if err := Purge(home, app, "dev"); err != nil {
		t.Fatalf("purge: %v", err)
	}
	ctx := context.Background()
	for _, kind := range []string{"app", "secret"} {
		data, err := home.Get(ctx, Key{Kind: kind, App: app, Stage: "dev"})
		if err != nil || data != nil {
			t.Fatalf("%s: expected nothing, got %d bytes, %v", kind, len(data), err)
		}
	}
	for _, kind := range historyKinds {
		if got := listed(t, home, kind, app, "dev"); len(got) != 0 {
			t.Fatalf("%s: expected none, got %v", kind, got)
		}
	}
	if p, err := home.Passphrase(ctx, app, "dev"); err != nil || p != "" {
		t.Fatalf("expected the passphrase to be removed, got %q, %v", p, err)
	}
	// Purge runs while the remove still holds the lock, so the locks' versions
	// stay, as SST 4's did in 4.x. Nothing else may.
	if memory, ok := home.(*memoryHome); ok && memory.versionsUnder(app) != 0 {
		t.Fatalf("expected no versions left but the lock's, %d are", memory.versionsUnder(app))
	}
}

func testListStages(t *testing.T, home Home, app string) {
	ctx := context.Background()
	if err := PushPartialState(home, "id", app, "dev", checkpoint(app, "dev", 2)); err != nil {
		t.Fatal(err)
	}
	if err := PushPartialState(home, "id", app, "prod", checkpoint(app, "prod", 0)); err != nil {
		t.Fatal(err)
	}
	// An app whose name starts with this one's isn't listed with it.
	other := app + "x"
	if err := PushPartialState(home, "id", other, "dev", checkpoint(other, "dev", 1)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { Purge(home, other, "dev") })
	stages, err := ListStages(home, app)
	if err != nil {
		t.Fatalf("list stages: %v", err)
	}
	if !reflect.DeepEqual(stages, []string{"dev"}) {
		t.Fatalf("expected [dev], got %v", stages)
	}
	none, err := ListStages(home, "sst-home-suite-none-"+randomHex(t, 4))
	if err != nil || len(none) != 0 {
		t.Fatalf("expected no stages for an app with none, got %v, %v", none, err)
	}
	home.Remove(ctx, Key{Kind: "app", App: app, Stage: "prod"})
}

func testDeployHistory(t *testing.T, home Home, app string) {
	check := func(want bool, when string) {
		t.Helper()
		got, err := HasDeployHistory(home, app, "dev")
		if err != nil {
			t.Fatalf("%s: %v", when, err)
		}
		if got != want {
			t.Fatalf("%s: expected %v, got %v", when, want, got)
		}
	}
	check(false, "a new stage")

	if _, err := GetOrCreatePassphrase(home, app, "dev"); err != nil {
		t.Fatal(err)
	}
	if err := PutSecrets(home, app, "dev", map[string]string{"A": "b"}); err != nil {
		t.Fatal(err)
	}
	check(false, "a stage with only a passphrase and secrets")

	failed, err := Lock(home, "test", "deploy", app, "dev")
	if err != nil {
		t.Fatal(err)
	}
	failed.TimeCompleted = time.Now().Format(time.RFC3339)
	failed.Errors = []SummaryError{{Message: "config failed to build"}}
	if err := PutUpdate(home, app, "dev", failed); err != nil {
		t.Fatal(err)
	}
	Unlock(home, app, "dev", failed, StageAfter{})
	check(false, "a stage whose first deploy failed")

	deployN(t, home, app, "dev", 1)
	check(true, "a deployed stage")

	// The state goes, but the history stays: what a home reading the wrong
	// place would see.
	if err := home.Remove(context.Background(), Key{Kind: "app", App: app, Stage: "dev"}); err != nil {
		t.Fatal(err)
	}
	check(true, "a deployed stage whose state is gone")

	// An update that can't be read is skipped, not an error.
	if err := home.Put(context.Background(), historyKey("update", app, "dev", "000000000000000000000000"), []byte("{"), PutOptions{}); err != nil {
		t.Fatal(err)
	}
	check(true, "a deployed stage with an update that can't be read")

	// After a remove that finished, the stage holds nothing, so a state that's
	// gone isn't a sign of the wrong place.
	removed, err := Lock(home, "test", "remove", app, "dev")
	if err != nil {
		t.Fatal(err)
	}
	removed.TimeCompleted = time.Now().Format(time.RFC3339)
	if err := PutUpdate(home, app, "dev", removed); err != nil {
		t.Fatal(err)
	}
	Unlock(home, app, "dev", removed, StageAfter{Removed: true})
	check(false, "a removed stage")
}

// checkpoint is a Pulumi checkpoint with the stack and n other resources.
func checkpoint(app, stage string, n int) []byte {
	resources := []string{}
	if n > 0 {
		resources = append(resources, `{"urn":"urn:pulumi:`+stage+`::`+app+`::pulumi:pulumi:Stack::`+app+`-`+stage+`","custom":false,"type":"pulumi:pulumi:Stack"}`)
		for i := 1; i < n; i++ {
			resources = append(resources, `{"urn":"urn:pulumi:`+stage+`::`+app+`::aws:s3/bucketV2:BucketV2::B`+string(rune('0'+i))+`","custom":true,"id":"b`+string(rune('0'+i))+`","type":"aws:s3/bucketV2:BucketV2"}`)
		}
	}
	return []byte(`{"version":3,"checkpoint":{"stack":"organization/` + app + `/` + stage + `","latest":{"manifest":{"time":"2026-10-31T00:00:00Z","magic":"","version":""},"resources":[` + strings.Join(resources, ",") + `]}}}`)
}

func randomHex(t *testing.T, n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(b)
}

// memoryHome is a home in memory that keeps versions, like a versioned
// bucket: a write or a delete adds a version, and a delete's version is a
// marker (nil).
type memoryHome struct {
	mu          sync.Mutex
	objects     map[string][][]byte
	passphrases map[string]string
}

var _ VersionedHome = (*memoryHome)(nil)

func newMemoryHome() *memoryHome {
	return &memoryHome{objects: map[string][][]byte{}, passphrases: map[string]string{}}
}

func (m *memoryHome) Bootstrap() error { return nil }

func (m *memoryHome) current(key string) []byte {
	versions := m.objects[key]
	if len(versions) == 0 {
		return nil
	}
	return versions[len(versions)-1]
}

func (m *memoryHome) Get(ctx context.Context, key Key) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	data := m.current(key.String())
	if data == nil {
		return nil, nil
	}
	return append([]byte{}, data...), nil
}

func (m *memoryHome) Put(ctx context.Context, key Key, data []byte, opts PutOptions) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	k := key.String()
	if opts.IfAbsent && m.current(k) != nil {
		return ErrExists
	}
	m.objects[k] = append(m.objects[k], append([]byte{}, data...))
	return nil
}

func (m *memoryHome) Remove(ctx context.Context, keys ...Key) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, key := range keys {
		k := key.String()
		m.objects[k] = append(m.objects[k], nil)
	}
	return nil
}

func (m *memoryHome) List(ctx context.Context, prefix Key) ([]Key, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	folder := prefix.String() + "/"
	var keys []Key
	for k := range m.objects {
		if !strings.HasPrefix(k, folder) || m.current(k) == nil {
			continue
		}
		keys = append(keys, Key{Kind: prefix.Kind, App: prefix.App, Stage: path.Join(prefix.Stage, strings.TrimPrefix(k, folder))})
	}
	return keys, nil
}

func (m *memoryHome) RemoveVersions(ctx context.Context, key Key, folder bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	k := key.String()
	for existing := range m.objects {
		if existing == k || (folder && strings.HasPrefix(existing, k+"/")) {
			delete(m.objects, existing)
		}
	}
	return nil
}

func (m *memoryHome) PruneVersions(ctx context.Context, key Key) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	k := key.String()
	if versions := m.objects[k]; len(versions) > 1 {
		m.objects[k] = versions[len(versions)-1:]
	}
	return nil
}

func (m *memoryHome) versionsUnder(app string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for k, versions := range m.objects {
		parts := strings.Split(k, "/")
		if parts[0] != "lock" && parts[0] != "lock5" && parts[1] == app {
			n += len(versions)
		}
	}
	return n
}

func (m *memoryHome) Passphrase(ctx context.Context, app, stage string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.passphrases[app+"/"+stage], nil
}

func (m *memoryHome) CreatePassphrase(ctx context.Context, app, stage, value string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.passphrases[app+"/"+stage]; ok {
		return ErrExists
	}
	m.passphrases[app+"/"+stage] = value
	return nil
}

func (m *memoryHome) RemovePassphrase(ctx context.Context, app, stage string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.passphrases, app+"/"+stage)
	return nil
}

func (m *memoryHome) Info() (util.KeyValuePairs[string], error) { return nil, nil }
