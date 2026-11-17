package project

import (
	"fmt"
	"os"

	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
	"github.com/sst/sst/v3/pkg/project/provider"
)

// Released is a resource a move takes out of the state without deleting it,
// because a part of the new components takes its place (pkg/move).
type Released struct {
	URN  string
	Type string
}

// beginMove saves the state a move starts from in the home, unless the stage
// has moved already, then marks what the move releases as retained in the
// state the deploy runs from. Pulumi then takes each one out of the state
// without calling its delete, which would remove what it wrote, like a
// site's files. It's the one edit a move makes to the state; aliases carry
// everything that moves.
func (p *Project) beginMove(workdir *PulumiWorkdir, updateID string, released []Released) error {
	data, err := os.ReadFile(workdir.state())
	if err != nil {
		return err
	}
	checkpoint, err := workdir.Export()
	if err != nil {
		return err
	}
	if err := retain(checkpoint, released); err != nil {
		return err
	}
	// A move run again on a stage that has moved finds SST 5's state, which
	// isn't one to go back to (`sst migrate --undo`)
	if checkpoint.Latest == nil || markerOf(checkpoint.Latest.Resources) == nil {
		if err := provider.PushMoveCopy(p.home, updateID, p.app.Name, p.app.Stage, data); err != nil {
			return fmt.Errorf("saving a copy of the state: %w", err)
		}
	}
	if len(released) == 0 {
		return nil
	}
	return workdir.Import(checkpoint)
}

// retain marks each released resource as retained. Each has to be in the
// state with the type its map names: one that isn't means the stage changed
// since the move was checked, and nothing is marked.
func retain(checkpoint *apitype.CheckpointV3, released []Released) error {
	if len(released) == 0 {
		return nil
	}
	if checkpoint.Latest == nil {
		return fmt.Errorf("the stage has no state to release anything from")
	}
	index := map[string]int{}
	for i, resource := range checkpoint.Latest.Resources {
		index[string(resource.URN)] = i
	}
	for _, r := range released {
		i, ok := index[r.URN]
		if !ok {
			return fmt.Errorf("%v isn't in the stage's state any more, so the stage changed since the move was checked. Run it again", r.URN)
		}
		if found := string(checkpoint.Latest.Resources[i].Type); found != r.Type {
			return fmt.Errorf("%v is a %v, not the %v the move releases, so the stage changed since the move was checked. Run it again", r.URN, found, r.Type)
		}
	}
	for _, r := range released {
		checkpoint.Latest.Resources[index[r.URN]].RetainOnDelete = true
	}
	return nil
}
