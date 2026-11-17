package global

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Masterminds/semver/v3"
	"github.com/sst/sst/v3/pkg/flag"
)

// A newer SST is looked for in the background, at most once a day, and the UI
// reads what the last look found. So a run never waits on GitHub, and the
// notice can come from the run after the one that found the release.
const updateCheckEvery = 24 * time.Hour

type updateCheck struct {
	// The version that was running. After an upgrade it's looked for again.
	Current   string    `json:"current"`
	Newest    string    `json:"newest"`
	CheckedAt time.Time `json:"checkedAt"`
}

// Where the checks are kept, and how the newest release is found. Tests
// change both.
var (
	updateCheckDir = ConfigDir
	findNewest     = newestRelease
)

// checksForUpdates says whether to look for a newer SST at all: not in CI,
// and not when SST_SKIP_UPDATE_CHECK is set.
func checksForUpdates() bool {
	if flag.SST_SKIP_UPDATE_CHECK {
		return false
	}
	switch strings.ToLower(os.Getenv("CI")) {
	case "", "0", "false":
		return true
	}
	return false
}

// NewerVersion gives the newer SST in current's major version that the last
// check found, if there is one.
func NewerVersion(current string) (string, bool) {
	if !checksForUpdates() {
		return "", false
	}
	check, ok := readUpdateCheck()
	if !ok || check.Current != current {
		return "", false
	}
	if !isNewer(check.Newest, current) {
		return "", false
	}
	return check.Newest, true
}

// CheckForUpdate looks for a newer SST in current's major version, unless the
// last look for this version is less than a day old. It waits on GitHub, so
// run it in the background.
func CheckForUpdate(current string) {
	if !checksForUpdates() {
		return
	}
	// A dev build has nothing to upgrade to
	if _, err := semver.NewVersion(current); err != nil {
		return
	}
	last, found := readUpdateCheck()
	if found && last.Current == current && time.Since(last.CheckedAt) < updateCheckEvery {
		return
	}
	check := updateCheck{Current: current, CheckedAt: time.Now()}
	newest, err := findNewest(current)
	if err != nil {
		// Not again until tomorrow, and what was found before still counts
		slog.Info("could not look for a newer SST", "err", err)
		if found && last.Current == current {
			check.Newest = last.Newest
		}
	} else {
		check.Newest = strings.TrimPrefix(newest, "v")
	}
	if err := writeUpdateCheck(check); err != nil {
		slog.Info("could not keep the update check", "err", err)
	}
}

// isNewer says whether candidate is a later version than current.
func isNewer(candidate string, current string) bool {
	c, err := semver.NewVersion(candidate)
	if err != nil {
		return false
	}
	v, err := semver.NewVersion(current)
	if err != nil {
		return false
	}
	return c.GreaterThan(v)
}

func updateCheckPath() string {
	return filepath.Join(updateCheckDir(), "update-check.json")
}

func readUpdateCheck() (updateCheck, bool) {
	var check updateCheck
	data, err := os.ReadFile(updateCheckPath())
	if err != nil {
		return check, false
	}
	if err := json.Unmarshal(data, &check); err != nil {
		return check, false
	}
	return check, true
}

func writeUpdateCheck(check updateCheck) error {
	data, err := json.Marshal(check)
	if err != nil {
		return err
	}
	return writeFileAtomic(updateCheckPath(), data)
}

// writeFileAtomic writes a file through a temporary one next to it, so two
// runs writing it at once leave one whole file.
func writeFileAtomic(path string, data []byte) error {
	file, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err := file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}
