package watcher

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const testWindow = 100 * time.Millisecond

type published struct {
	mu    sync.Mutex
	paths []string
}

func (p *published) add(path string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.paths = append(p.paths, path)
}

func (p *published) count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.paths)
}

func newTestLimiter(t *testing.T) (*changeLimiter, *published, string) {
	t.Helper()
	p := &published{}
	path := filepath.Join(t.TempDir(), "handler.ts")
	require.NoError(t, os.WriteFile(path, []byte("v1"), 0644))
	return newChangeLimiter(testWindow, p.add), p, path
}

// Write content of a new length, so the size changes even when the
// modification time's resolution is coarse.
func rewrite(t *testing.T, path string, n int) {
	t.Helper()
	require.NoError(t, os.WriteFile(path, make([]byte, n), 0644))
}

func TestChangeLimiterPublishesFirstChangeAtOnce(t *testing.T) {
	l, p, path := newTestLimiter(t)
	l.change(path, false)
	assert.Equal(t, 1, p.count())
}

// A save right after another isn't lost: it's published when the window
// ends, once, however many changes came in it.
func TestChangeLimiterPublishesChangesInTheWindowOnceAtTheEnd(t *testing.T) {
	l, p, path := newTestLimiter(t)
	l.change(path, false)
	for i := range 3 {
		rewrite(t, path, 10+i)
		l.change(path, false)
	}
	assert.Equal(t, 1, p.count(), "nothing more until the window ends")
	assert.Eventually(t, func() bool { return p.count() == 2 }, time.Second, 5*time.Millisecond)
	time.Sleep(2 * testWindow)
	assert.Equal(t, 2, p.count(), "one publish for the whole window")
}

// FSEvents can report one write as a create and then a modify. When the
// file is as it was at the last publish, the second report is dropped.
func TestChangeLimiterSkipsTheWindowWhenTheFileIsUnchanged(t *testing.T) {
	l, p, path := newTestLimiter(t)
	l.change(path, false)
	l.change(path, false)
	time.Sleep(3 * testWindow)
	assert.Equal(t, 1, p.count())
}

func TestChangeLimiterDropsDiscoveryInTheWindow(t *testing.T) {
	l, p, path := newTestLimiter(t)
	l.change(path, false)
	rewrite(t, path, 20)
	l.change(path, true)
	time.Sleep(3 * testWindow)
	assert.Equal(t, 1, p.count())
}

// The walk can report a new file before its content is written, and the
// write that follows is then a change: it's published when the window ends.
func TestChangeLimiterPublishesAWriteAfterDiscovery(t *testing.T) {
	l, p, path := newTestLimiter(t)
	l.change(path, true)
	rewrite(t, path, 30)
	l.change(path, false)
	assert.Eventually(t, func() bool { return p.count() == 2 }, time.Second, 5*time.Millisecond)
}

func TestChangeLimiterPublishesAtOnceAfterTheWindow(t *testing.T) {
	l, p, path := newTestLimiter(t)
	l.change(path, false)
	time.Sleep(testWindow + 20*time.Millisecond)
	rewrite(t, path, 40)
	l.change(path, false)
	assert.Equal(t, 2, p.count())
}

func TestChangeLimiterPublishesNothingAfterClose(t *testing.T) {
	l, p, path := newTestLimiter(t)
	l.change(path, false)
	rewrite(t, path, 50)
	l.change(path, false) // waits for the window
	l.close()
	time.Sleep(3 * testWindow)
	l.change(path, false)
	assert.Equal(t, 1, p.count(), "neither the waiting window nor a new change publishes")
}
