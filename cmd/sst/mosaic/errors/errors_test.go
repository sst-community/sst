package errors

import (
	"testing"

	"github.com/sst/sst/v3/pkg/project"
	"github.com/stretchr/testify/assert"
)

func TestProviderMajorVersion(t *testing.T) {
	err := Transform(&project.ErrProviderMajorVersion{
		Name:    "vercel",
		Version: "5.4.1",
		Needed:  "4.6.0",
		Line:    "4.x",
	})
	assert.Equal(t, `You specified version 5.4.1 of the "vercel" provider. SST's components are built for 4.x, and a new major version can remove what they use. Use a 4.x version, 4.6.0 or higher.`, err.Error())
}
