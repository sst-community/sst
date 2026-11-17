package global

import (
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func stubUpdateCheck(t *testing.T, newest func(string) (string, error)) *int {
	t.Helper()
	t.Setenv("CI", "")
	dir := t.TempDir()
	calls := 0
	originalDir, originalFind := updateCheckDir, findNewest
	updateCheckDir = func() string { return dir }
	findNewest = func(current string) (string, error) {
		calls++
		return newest(current)
	}
	t.Cleanup(func() { updateCheckDir, findNewest = originalDir, originalFind })
	return &calls
}

func TestUpdateCheck(t *testing.T) {
	t.Run("a newer release is told from the next run", func(t *testing.T) {
		calls := stubUpdateCheck(t, func(string) (string, error) { return "v5.0.0-alpha.2", nil })

		_, ok := NewerVersion("5.0.0-alpha.1")
		assert.False(t, ok, "nothing is known before the first check")

		CheckForUpdate("5.0.0-alpha.1")
		newest, ok := NewerVersion("5.0.0-alpha.1")
		assert.True(t, ok)
		assert.Equal(t, "5.0.0-alpha.2", newest)

		// Not looked for again the same day
		CheckForUpdate("5.0.0-alpha.1")
		assert.Equal(t, 1, *calls)
	})

	t.Run("after an upgrade, it's looked for again", func(t *testing.T) {
		calls := stubUpdateCheck(t, func(string) (string, error) { return "v5.0.0-alpha.2", nil })
		CheckForUpdate("5.0.0-alpha.1")

		_, ok := NewerVersion("5.0.0-alpha.2")
		assert.False(t, ok, "the running version is the newest")
		CheckForUpdate("5.0.0-alpha.2")
		assert.Equal(t, 2, *calls)
		_, ok = NewerVersion("5.0.0-alpha.2")
		assert.False(t, ok)
	})

	t.Run("a day later, it's looked for again", func(t *testing.T) {
		calls := stubUpdateCheck(t, func(string) (string, error) { return "v4.22.0", nil })
		assert.NoError(t, writeUpdateCheck(updateCheck{
			Current:   "4.21.1",
			Newest:    "4.21.1",
			CheckedAt: time.Now().Add(-updateCheckEvery - time.Minute),
		}))

		CheckForUpdate("4.21.1")
		assert.Equal(t, 1, *calls)
		newest, ok := NewerVersion("4.21.1")
		assert.True(t, ok)
		assert.Equal(t, "4.22.0", newest)
	})

	t.Run("a failed look keeps what was found, and waits a day", func(t *testing.T) {
		calls := stubUpdateCheck(t, func(string) (string, error) { return "", errors.New("rate limited") })
		assert.NoError(t, writeUpdateCheck(updateCheck{
			Current:   "4.21.1",
			Newest:    "4.22.0",
			CheckedAt: time.Now().Add(-updateCheckEvery - time.Minute),
		}))

		CheckForUpdate("4.21.1")
		CheckForUpdate("4.21.1")
		assert.Equal(t, 1, *calls)
		newest, ok := NewerVersion("4.21.1")
		assert.True(t, ok)
		assert.Equal(t, "4.22.0", newest)
	})

	t.Run("not for a dev build, or in CI", func(t *testing.T) {
		calls := stubUpdateCheck(t, func(string) (string, error) { return "v5.0.0", nil })
		CheckForUpdate("dev")
		assert.Equal(t, 0, *calls)

		CheckForUpdate("5.0.0-alpha.1")
		t.Setenv("CI", "true")
		_, ok := NewerVersion("5.0.0-alpha.1")
		assert.False(t, ok, "CI isn't told")
		assert.NoError(t, writeUpdateCheck(updateCheck{Current: "4.21.1"}))
		CheckForUpdate("4.21.1")
		assert.Equal(t, 1, *calls, "CI doesn't look")
	})
}
