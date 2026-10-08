package project

import (
	"strconv"
	"strings"
)

// MinNodeMajor is the oldest Node.js major version SST supports. Pulumi's
// Node.js SDK, which runs the config, needs Node.js 22 from 3.249.
const MinNodeMajor = 22

// NodeTooOld reports whether a Node.js version, as in process.versions.node,
// is older than MinNodeMajor. It returns false when the version can't be read.
func NodeTooOld(version string) bool {
	major, _, _ := strings.Cut(strings.TrimPrefix(version, "v"), ".")
	n, err := strconv.Atoi(major)
	return err == nil && n < MinNodeMajor
}
