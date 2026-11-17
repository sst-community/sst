package target

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAlone(t *testing.T) {
	path := filepath.Join(t.TempDir(), "emulator.lock")
	require.NoError(t, use(path))
	t.Cleanup(func() {
		usesMu.Lock()
		defer usesMu.Unlock()
		uses[path].Close()
		delete(uses, path)
	})
	// Another command on the target, as another process would hold it: a lock
	// of its own on the file
	other := func(t *testing.T, exclusive, wait bool) (*os.File, bool) {
		file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
		require.NoError(t, err)
		t.Cleanup(func() { file.Close() })
		ok, err := lock(file, exclusive, wait)
		require.NoError(t, err)
		return file, ok
	}

	t.Run("not while another command uses the target", func(t *testing.T) {
		file, ok := other(t, false, false)
		require.True(t, ok)
		ran := false
		did, err := alone(path, func() error { ran = true; return nil })
		require.NoError(t, err)
		assert.False(t, did)
		assert.False(t, ran)
		file.Close()

		did, err = alone(path, func() error { ran = true; return nil })
		require.NoError(t, err)
		assert.True(t, did, "once it's gone")
		assert.True(t, ran)
	})

	t.Run("a command that starts meanwhile waits", func(t *testing.T) {
		started := make(chan struct{})
		did, err := alone(path, func() error {
			go func() {
				other(t, false, true)
				close(started)
			}()
			select {
			case <-started:
				t.Error("it started while the container was being stopped")
			case <-time.After(200 * time.Millisecond):
			}
			return nil
		})
		require.NoError(t, err)
		assert.True(t, did)
		select {
		case <-started:
		case <-time.After(5 * time.Second):
			t.Fatal("it didn't start after")
		}
	})

	t.Run("this process uses the target again after", func(t *testing.T) {
		_, err := alone(path, func() error { return nil })
		require.NoError(t, err)
		_, ok := other(t, true, false)
		assert.False(t, ok, "another remove can't stop it under this command")
	})
}
