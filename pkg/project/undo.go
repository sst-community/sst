package project

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
	smithyhttp "github.com/aws/smithy-go/transport/http"
	"github.com/pulumi/pulumi/pkg/v3/secrets"
	"github.com/pulumi/pulumi/pkg/v3/secrets/passphrase"
	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
	"github.com/sst/sst/v3/internal/util"
	"github.com/sst/sst/v3/pkg/move"
	"github.com/sst/sst/v3/pkg/project/provider"
)

// Undone is what going back to SST 4 did.
type Undone struct {
	*move.Restored
	// Moved is when the move whose copy the stage went back to started
	Moved string
	// Finished is set when this run finished a going back that stopped after
	// it put SST 4's state back, by taking out the tombstone
	Finished bool
}

// Undo puts a stage that moved back on SST 4: the state the move saved, given
// SST 5's view of what the move kept (move.Restore), in place of the stage's
// state, and the lock SST 4 reads without its tombstone, so that SST 4 can
// deploy it. It changes nothing in the cloud. It's refused once SST 5 has
// created, deleted or replaced anything on the stage since the move, as the
// copy no longer matches what's deployed.
func (p *Project) Undo(ctx context.Context) (*Undone, error) {
	app, stage := p.app.Name, p.app.Stage
	update, err := p.Lock("undo")
	if err != nil {
		if errors.Is(err, provider.ErrLockExists) {
			return nil, util.NewReadableError(err, "Another command is running on this stage. Run this again once it's done.")
		}
		return nil, err
	}
	defer p.Unlock()
	// A run that's refused leaves nothing in the history
	refuse := func(err error) (*Undone, error) {
		p.DropUpdate(update)
		return nil, err
	}

	copies, err := provider.ListMoveCopies(p.home, app, stage)
	if err != nil {
		return refuse(err)
	}
	updates, err := provider.ListUpdates(p.home, app, stage)
	if err != nil {
		return refuse(err)
	}
	plan, err := planUndo(copies, updates, update.ID)
	if err != nil {
		return refuse(err)
	}
	data, err := provider.GetMoveCopy(p.home, app, stage, plan.Copy)
	if err != nil {
		return refuse(err)
	}
	saved, err := readCheckpoint(data)
	if err != nil {
		return refuse(fmt.Errorf("reading the state the move saved: %w", err))
	}
	if saved.Latest == nil || markerOf(saved.Latest.Resources) != nil {
		return refuse(util.NewReadableError(nil, fmt.Sprintf("The state the move on %v saved isn't SST 4's, so there's nothing to go back to.", plan.Moved.TimeStarted)))
	}
	current, err := p.readState(ctx)
	if err != nil {
		return refuse(err)
	}
	if current == nil || current.Latest == nil {
		return refuse(util.NewReadableError(nil, "The stage has no state, so there's nothing to put back on SST 4."))
	}
	undone := &Undone{Restored: &move.Restored{}, Moved: plan.Moved.TimeStarted}
	if plan.Stopped && markerOf(current.Latest.Resources) == nil {
		// A going back that stopped after it put SST 4's state back
		undone.Finished = true
		return p.record(update, undone, provider.RemoveTombstone(p.home, app, stage))
	}
	if err := p.unchangedSince(plan, saved, current); err != nil {
		return refuse(err)
	}
	undone.Restored, err = p.restore(ctx, data, saved, current, update)
	return p.record(update, undone, err)
}

// record completes the run's update, with its error if it failed. A record
// that can't be written after the stage went back is only logged: the stage
// is back, and a run again finishes it.
func (p *Project) record(update *provider.Update, undone *Undone, err error) (*Undone, error) {
	update.TimeCompleted = time.Now().UTC().Format(time.RFC3339)
	if err != nil {
		update.Errors = []provider.SummaryError{{Message: err.Error()}}
	}
	if putErr := provider.PutUpdate(p.home, p.app.Name, p.app.Stage, update); putErr != nil {
		slog.Error("recording going back", "err", putErr)
	}
	if err != nil {
		return nil, err
	}
	return undone, nil
}

func (p *Project) readState(ctx context.Context) (*apitype.CheckpointV3, error) {
	data, err := p.home.Get(ctx, provider.Key{Kind: "app", App: p.app.Name, Stage: p.app.Stage})
	if err != nil || len(data) == 0 {
		return nil, err
	}
	current, err := readCheckpoint(data)
	if err != nil {
		return nil, fmt.Errorf("reading the stage's state: %w", err)
	}
	return current, nil
}

// unchangedSince refuses when what's in the cloud on the stage isn't what it
// was right after the move: SST 5 created, deleted or replaced something
// since. What a later run updated in place, like each `sst dev` start, is
// carried over as the move's own changes are.
func (p *Project) unchangedSince(plan *undoPlan, saved, current *apitype.CheckpointV3) error {
	data, err := provider.GetSnapshot(p.home, p.app.Name, p.app.Stage, plan.Baseline)
	if err != nil {
		return err
	}
	// A move that stopped before Pulumi ran left no snapshot, and changed
	// nothing
	baseline := saved
	if len(data) > 0 {
		if baseline, err = readCheckpoint(data); err != nil {
			return fmt.Errorf("reading the state the move left: %w", err)
		}
	}
	created, gone := move.Changed(baseline, current)
	if len(created) == 0 && len(gone) == 0 {
		return nil
	}
	names := []string{}
	for _, urn := range append(created, gone...) {
		if len(names) == 5 {
			names = append(names, "and more")
			break
		}
		names = append(names, urn.Name())
	}
	return util.NewReadableError(nil, fmt.Sprintf("Since the move, SST 5 has created %v and deleted or replaced %v on the stage (%v), so the state the move saved doesn't match what's deployed. Fix it forward with SST 5.", len(created), len(gone), strings.Join(names, ", ")))
}

func (p *Project) restore(ctx context.Context, data []byte, saved, current *apitype.CheckpointV3, update *provider.Update) (*move.Restored, error) {
	app, stage := p.app.Name, p.app.Stage
	recrypt, err := p.recrypter(ctx, saved, current)
	if err != nil {
		return nil, err
	}
	result, err := move.Restore(saved, current, p.codeGone(ctx), recrypt)
	if err != nil {
		return nil, err
	}
	restored := data
	if result.Refreshed > 0 || len(result.Dropped) > 0 {
		raw, err := json.MarshalIndent(result.State, "", "  ")
		if err != nil {
			return nil, err
		}
		if restored, err = json.MarshalIndent(apitype.VersionedCheckpoint{Version: 3, Checkpoint: raw}, "", "  "); err != nil {
			return nil, err
		}
	}
	// The state first, then the tombstone: SST 4 never finds the stage
	// unlocked with SST 5's state
	if err := provider.PushPartialState(p.home, update.ID, app, stage, restored); err != nil {
		return nil, err
	}
	finish := func(err error) error {
		return util.NewReadableError(err, "SST 4's state is back on the stage, but going back stopped before SST 4 could deploy it: "+err.Error()+". Run `sst migrate --undo` again to finish.")
	}
	if err := provider.PushSnapshot(p.home, update.ID, app, stage, restored); err != nil {
		return nil, finish(err)
	}
	if err := provider.RemoveTombstone(p.home, app, stage); err != nil {
		return nil, finish(err)
	}
	return result, nil
}

// undoPlan is which move a going back undoes, from the stage's history
type undoPlan struct {
	// Copy is the update of the move whose saved state the stage goes back to
	Copy string
	// Moved is that update, as far as the history has it
	Moved provider.Update
	// Baseline is the update whose snapshot is the stage right after the move
	Baseline string
	// Stopped is set when a going back since the move didn't finish
	Stopped bool
}

// planUndo picks the move to undo: the first since the stage was last on SST
// 4, by going back or by SST 4 running on it, as after a move that stopped
// before the stage moved. A move run again on a stage that moved partway
// saves the state it found, a move's that stopped, so the first copy since
// then is SST 4's.
// The stage right after the move is the move's snapshot, or, for a move that
// stopped partway, like one with `--dev` that a deploy-time invocation
// stopped, the snapshot of the deploy that finished it. updates and copies
// are newest first, as their IDs sort; self is this run's.
func planUndo(copies []string, updates []provider.Update, self string) (*undoPlan, error) {
	// The last time the stage was on SST 4: newest first, so the first found
	var onSST4 *provider.Update
	for i := range updates {
		update := updates[i]
		if update.ID == self {
			continue
		}
		if (update.Command == "undo" && done(update)) || sst4Version(update.Version) {
			onSST4 = &updates[i]
			break
		}
	}
	first := ""
	for _, id := range copies {
		if onSST4 != nil && id > onSST4.ID {
			break
		}
		first = id
	}
	if first == "" {
		switch {
		case onSST4 != nil && onSST4.Command == "undo":
			return nil, util.NewReadableError(nil, fmt.Sprintf("The stage went back to SST 4 already, on %v. Move it again with `sst migrate` before going back.", onSST4.TimeStarted))
		case onSST4 != nil:
			return nil, util.NewReadableError(nil, fmt.Sprintf("SST %v ran `sst %v` on the stage on %v, after the last move, so it's on SST 4 already.", onSST4.Version, onSST4.Command, onSST4.TimeStarted))
		}
		return nil, util.NewReadableError(nil, "No move saved a state for this stage, so there's nothing to go back to.")
	}
	plan := &undoPlan{Copy: first, Moved: provider.Update{ID: first}, Baseline: first}
	after := []provider.Update{}
	for _, update := range updates {
		switch {
		case update.ID == first:
			plan.Moved = update
		case update.ID < first && update.ID != self:
			// Newer, oldest first
			after = append([]provider.Update{update}, after...)
		}
	}
	if !done(plan.Moved) {
		for _, update := range after {
			if update.Command == "deploy" && done(update) {
				plan.Baseline = update.ID
				break
			}
		}
	}
	for _, update := range after {
		if update.Command == "undo" {
			plan.Stopped = true
		}
	}
	return plan, nil
}

// sst4Version says whether an update was SST 4's (or SST 3's), by the version
// of the CLI that ran it. A build without a release's version can't be told
// apart, and isn't taken as one.
func sst4Version(version string) bool {
	major, _, ok := strings.Cut(version, ".")
	return ok && (major == "3" || major == "4")
}

// done is an update that finished without errors
func done(update provider.Update) bool {
	return update.TimeCompleted != "" && len(update.Errors) == 0
}

func readCheckpoint(data []byte) (*apitype.CheckpointV3, error) {
	var versioned apitype.VersionedCheckpoint
	if err := json.Unmarshal(data, &versioned); err != nil {
		return nil, err
	}
	var checkpoint apitype.CheckpointV3
	if err := json.Unmarshal(versioned.Checkpoint, &checkpoint); err != nil {
		return nil, err
	}
	return &checkpoint, nil
}

// recrypter decrypts a secret of SST 5's state and encrypts it for the copy
// the move saved, with the stage's passphrase and each state's salt. It's nil
// when either state's secrets provider isn't a passphrase.
func (p *Project) recrypter(ctx context.Context, saved, current *apitype.CheckpointV3) (func(string) (string, error), error) {
	if current == nil || current.Latest == nil || saved.Latest == nil {
		return nil, nil
	}
	from, to := current.Latest.SecretsProviders, saved.Latest.SecretsProviders
	if from == nil || to == nil || from.Type != "passphrase" || to.Type != "passphrase" {
		return nil, nil
	}
	phrase, err := provider.GetPassphrase(p.home, p.app.Name, p.app.Stage)
	if err != nil {
		return nil, err
	}
	return newRecrypter(ctx, phrase, from, to)
}

func newRecrypter(ctx context.Context, phrase string, from, to *apitype.SecretsProvidersV1) (func(string) (string, error), error) {
	manager := func(sp *apitype.SecretsProvidersV1) (secrets.Manager, error) {
		var state struct {
			Salt string `json:"salt"`
		}
		if err := json.Unmarshal(sp.State, &state); err != nil {
			return nil, err
		}
		return passphrase.GetPassphraseSecretsManager(phrase, state.Salt)
	}
	fromManager, err := manager(from)
	if err != nil {
		return nil, fmt.Errorf("reading the secrets of SST 5's state: %w", err)
	}
	toManager, err := manager(to)
	if err != nil {
		return nil, fmt.Errorf("reading the secrets of the state the move saved: %w", err)
	}
	decrypter, encrypter := fromManager.Decrypter(), toManager.Encrypter()
	return func(ciphertext string) (string, error) {
		plaintext, err := decrypter.DecryptValue(ctx, ciphertext)
		if err != nil {
			return "", err
		}
		return encrypter.EncryptValue(ctx, plaintext)
	}, nil
}

// codeGone says whether a code object SST 4 uploaded is gone from its
// bucket. SST 4 uploads a function's code to the asset bucket of its region,
// which may not be the app's, so a bucket elsewhere is asked in its own
// region.
func (p *Project) codeGone(ctx context.Context) func(apitype.ResourceV3) (bool, error) {
	var config *aws.Config
	if unknown, ok := p.Provider("aws"); ok {
		if awsProvider, ok := unknown.(*provider.AwsProvider); ok {
			cfg := awsProvider.Config()
			config = &cfg
		}
	}
	clients := map[string]*s3.Client{}
	client := func(region string) *s3.Client {
		if clients[region] == nil {
			clients[region] = s3.NewFromConfig(*config, func(o *s3.Options) {
				if region != "" {
					o.Region = region
				}
			})
		}
		return clients[region]
	}
	regions := map[string]string{}
	return func(r apitype.ResourceV3) (bool, error) {
		bucket, _ := r.Outputs["bucket"].(string)
		key, _ := r.Outputs["key"].(string)
		if config == nil || bucket == "" || key == "" {
			return false, nil
		}
		head := func() error {
			_, err := client(regions[bucket]).HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(bucket), Key: aws.String(key)})
			return err
		}
		err := head()
		var response *smithyhttp.ResponseError
		if err != nil && errors.As(err, &response) && response.HTTPStatusCode() == 301 && regions[bucket] == "" {
			location, locErr := client("").GetBucketLocation(ctx, &s3.GetBucketLocationInput{Bucket: aws.String(bucket)})
			if locErr == nil {
				regions[bucket] = string(location.LocationConstraint)
				if regions[bucket] == "" {
					regions[bucket] = "us-east-1"
				}
				err = head()
			}
		}
		if err == nil {
			return false, nil
		}
		var notFound *s3types.NotFound
		var apiErr smithy.APIError
		if errors.As(err, &notFound) || (errors.As(err, &apiErr) && (apiErr.ErrorCode() == "NotFound" || apiErr.ErrorCode() == "NoSuchKey")) {
			return true, nil
		}
		return false, fmt.Errorf("checking whether s3://%v/%v is still there: %w", bucket, key, err)
	}
}
