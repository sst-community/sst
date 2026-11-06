package errors

import (
	"errors"
	"testing"

	"github.com/sst/sst/v3/internal/util"
	"github.com/sst/sst/v3/pkg/project"
	"github.com/sst/sst/v3/pkg/project/provider"
)

func TestTransformPreservesActionableRecovery(t *testing.T) {
	for _, cause := range []error{provider.ErrLockExists, project.ErrStackRunFailed} {
		const message = "Stop the dev process, then SST_FLOCI_ENDPOINT=http://127.0.0.1:4566 sst unlock --stage local"
		got := Transform(&project.FlociUpdateError{ReadableError: util.NewReadableError(cause, message)})
		if got.Error() != message || !errors.Is(got, cause) {
			t.Fatalf("recovery guidance lost: %v", got)
		}
		if _, ok := got.(*util.ReadableError); !ok {
			t.Fatal("deployer cannot display recovery error")
		}
		if got := Transform(util.NewReadableError(cause, "cloud wrapper")); got.Error() != "" {
			t.Fatalf("changed existing cloud event behavior: %v", got)
		}
	}
}
