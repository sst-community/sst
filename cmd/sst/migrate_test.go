package main

import (
	"testing"

	"github.com/sst/sst/v3/pkg/move"
	"github.com/stretchr/testify/assert"
)

func TestMergedLine(t *testing.T) {
	assert.Equal(t,
		"Your transform sets \"loggingConfig\" as an object, which SST 5 merges into the component's settings, keeping logFormat, logGroup. SST 4 put an object in place of them. To replace them, set it in a function.",
		mergedLine(move.MergedField{Field: "loggingConfig", Kept: []string{"logFormat", "logGroup"}}),
	)
	assert.Contains(t,
		mergedLine(move.MergedField{Field: "environment", Kept: []string{"a", "b", "c", "d", "e", "f"}}),
		"keeping a, b, c, d and 2 more.",
	)
}
