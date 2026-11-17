//go:build darwin

package watcher

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/fsnotify/fsnotify"
)

// On macOS fsnotify uses kqueue, which can only report a write to a file
// through a descriptor opened on that file, so watching a project costs one
// descriptor per file and directory in it. FSEvents watches each tree with a
// single stream and holds no descriptors per file, so it is the default here.
// It is loaded with purego, which keeps the CLI buildable with CGO_ENABLED=0.
// If it can't be loaded, the watcher falls back to fsnotify.
func newBackend(trees []string, headFile string, log *slog.Logger) (backend, error) {
	if os.Getenv("SST_WATCHER") != "kqueue" {
		b, err := newFSEventsBackend(trees, headFile)
		if err == nil {
			return b, nil
		}
		log.Warn("fsevents unavailable, falling back to kqueue", "err", err)
	}
	return newFsnotifyBackend()
}

const (
	cfStringEncodingUTF8 = 0x08000100

	fsEventStreamEventIDSinceNow = ^uint64(0)

	fsEventStreamCreateFlagNoDefer    = 0x00000002
	fsEventStreamCreateFlagFileEvents = 0x00000010

	fsEventFlagMustScanSubDirs = 0x00000001
	fsEventFlagUserDropped     = 0x00000002
	fsEventFlagKernelDropped   = 0x00000004
	fsEventFlagItemCreated     = 0x00000100
	fsEventFlagItemRemoved     = 0x00000200
	fsEventFlagItemRenamed     = 0x00000800
	fsEventFlagItemModified    = 0x00001000
	fsEventFlagItemIsDir       = 0x00020000

	// Coalesce events that arrive within this many seconds into one callback.
	// With NoDefer the first event of a quiet period is delivered at once.
	fsEventsLatency = 0.05
)

type fsEventStreamContext struct {
	version         int
	info            uintptr
	retain          uintptr
	release         uintptr
	copyDescription uintptr
}

var fsevents struct {
	once sync.Once
	err  error

	cfStringCreateWithCString func(alloc uintptr, cstr *byte, encoding uint32) uintptr
	cfArrayCreate             func(alloc uintptr, values *uintptr, count int, callbacks uintptr) uintptr
	cfRelease                 func(ref uintptr)
	typeArrayCallBacks        uintptr

	streamCreate           func(alloc uintptr, callback uintptr, ctx *fsEventStreamContext, paths uintptr, since uint64, latency float64, flags uint32) uintptr
	streamSetDispatchQueue func(stream uintptr, queue uintptr)
	streamStart            func(stream uintptr) bool
	streamStop             func(stream uintptr)
	streamInvalidate       func(stream uintptr)
	streamRelease          func(stream uintptr)

	dispatchQueueCreate func(label *byte, attr uintptr) uintptr
	dispatchRelease     func(obj uintptr)

	// purego callbacks are never freed, so there is one for the process and
	// it finds the stream's backend through the context's info value.
	callback uintptr
	mu       sync.Mutex
	nextID   uintptr
	streams  map[uintptr]*fseventsBackend
}

func loadFSEvents() error {
	fsevents.once.Do(func() {
		fsevents.err = func() error {
			cf, err := purego.Dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", purego.RTLD_NOW|purego.RTLD_GLOBAL)
			if err != nil {
				return err
			}
			cs, err := purego.Dlopen("/System/Library/Frameworks/CoreServices.framework/CoreServices", purego.RTLD_NOW|purego.RTLD_GLOBAL)
			if err != nil {
				return err
			}
			sys, err := purego.Dlopen("/usr/lib/libSystem.B.dylib", purego.RTLD_NOW|purego.RTLD_GLOBAL)
			if err != nil {
				return err
			}

			purego.RegisterLibFunc(&fsevents.cfStringCreateWithCString, cf, "CFStringCreateWithCString")
			purego.RegisterLibFunc(&fsevents.cfArrayCreate, cf, "CFArrayCreate")
			purego.RegisterLibFunc(&fsevents.cfRelease, cf, "CFRelease")
			fsevents.typeArrayCallBacks, err = purego.Dlsym(cf, "kCFTypeArrayCallBacks")
			if err != nil {
				return err
			}

			purego.RegisterLibFunc(&fsevents.streamCreate, cs, "FSEventStreamCreate")
			purego.RegisterLibFunc(&fsevents.streamSetDispatchQueue, cs, "FSEventStreamSetDispatchQueue")
			purego.RegisterLibFunc(&fsevents.streamStart, cs, "FSEventStreamStart")
			purego.RegisterLibFunc(&fsevents.streamStop, cs, "FSEventStreamStop")
			purego.RegisterLibFunc(&fsevents.streamInvalidate, cs, "FSEventStreamInvalidate")
			purego.RegisterLibFunc(&fsevents.streamRelease, cs, "FSEventStreamRelease")

			purego.RegisterLibFunc(&fsevents.dispatchQueueCreate, sys, "dispatch_queue_create")
			purego.RegisterLibFunc(&fsevents.dispatchRelease, sys, "dispatch_release")

			fsevents.streams = map[uintptr]*fseventsBackend{}
			fsevents.callback = purego.NewCallback(fseventsCallback)
			return nil
		}()
	})
	return fsevents.err
}

// fseventsCallback runs on the stream's dispatch queue, not a Go thread.
func fseventsCallback(stream, info, count uintptr, paths, flags, ids unsafe.Pointer) {
	fsevents.mu.Lock()
	b := fsevents.streams[info]
	fsevents.mu.Unlock()
	if b == nil || count == 0 {
		return
	}

	pathList := unsafe.Slice((**byte)(paths), count)
	flagList := unsafe.Slice((*uint32)(flags), count)
	for i := range pathList {
		b.handle(goString(pathList[i]), flagList[i])
	}
}

func goString(p *byte) string {
	if p == nil {
		return ""
	}
	n := 0
	for *(*byte)(unsafe.Add(unsafe.Pointer(p), n)) != 0 {
		n++
	}
	return string(unsafe.Slice(p, n))
}

// treeMapping maps the path FSEvents reports, which has symlinks resolved
// (/var is /private/var on macOS), back to the path the watcher was given.
type treeMapping struct {
	real string
	tree string
}

type fseventsBackend struct {
	id       uintptr
	stream   uintptr
	queue    uintptr
	trees    []treeMapping
	headFile string

	events chan fsnotify.Event
	errors chan error
	done   chan struct{}
	close  sync.Once

	// The inode of each directory already reported as created. FSEvents can
	// repeat an item's flags in later batches, and a repeated Create on a
	// directory would make the watcher walk it and report every file in it
	// again. A directory removed and made again has a new inode, so it is
	// reported, even when both happen within one batch.
	created map[string]uint64
}

func newFSEventsBackend(trees []string, headFile string) (*fseventsBackend, error) {
	if err := loadFSEvents(); err != nil {
		return nil, err
	}

	b := &fseventsBackend{
		headFile: filepath.Clean(headFile),
		events:   make(chan fsnotify.Event, 1024),
		errors:   make(chan error, 16),
		done:     make(chan struct{}),
		created:  map[string]uint64{},
	}

	var strings_ []uintptr
	defer func() {
		for _, s := range strings_ {
			fsevents.cfRelease(s)
		}
	}()
	for _, tree := range trees {
		tree = filepath.Clean(tree)
		real, err := filepath.EvalSymlinks(tree)
		if err != nil {
			return nil, err
		}
		b.trees = append(b.trees, treeMapping{real: real, tree: tree})

		cstr := append([]byte(real), 0)
		s := fsevents.cfStringCreateWithCString(0, &cstr[0], cfStringEncodingUTF8)
		if s == 0 {
			return nil, fmt.Errorf("fsevents: can't create a string for %s", real)
		}
		strings_ = append(strings_, s)
	}
	if len(strings_) == 0 {
		return nil, errors.New("fsevents: nothing to watch")
	}

	paths := fsevents.cfArrayCreate(0, &strings_[0], len(strings_), fsevents.typeArrayCallBacks)
	if paths == 0 {
		return nil, errors.New("fsevents: can't create the path list")
	}
	defer fsevents.cfRelease(paths)

	fsevents.mu.Lock()
	fsevents.nextID++
	b.id = fsevents.nextID
	fsevents.streams[b.id] = b
	fsevents.mu.Unlock()

	ctx := fsEventStreamContext{info: b.id}
	b.stream = fsevents.streamCreate(
		0,
		fsevents.callback,
		&ctx,
		paths,
		fsEventStreamEventIDSinceNow,
		fsEventsLatency,
		fsEventStreamCreateFlagNoDefer|fsEventStreamCreateFlagFileEvents,
	)
	if b.stream == 0 {
		b.unregister()
		return nil, errors.New("fsevents: can't create the stream")
	}

	label := []byte("sst.watcher\x00")
	b.queue = fsevents.dispatchQueueCreate(&label[0], 0)
	fsevents.streamSetDispatchQueue(b.stream, b.queue)
	if !fsevents.streamStart(b.stream) {
		fsevents.streamInvalidate(b.stream)
		fsevents.streamRelease(b.stream)
		fsevents.dispatchRelease(b.queue)
		b.unregister()
		return nil, errors.New("fsevents: can't start the stream")
	}

	return b, nil
}

func (b *fseventsBackend) unregister() {
	fsevents.mu.Lock()
	delete(fsevents.streams, b.id)
	fsevents.mu.Unlock()
}

func (b *fseventsBackend) Name() string                  { return "fsevents" }
func (b *fseventsBackend) Recursive() bool               { return true }
func (b *fseventsBackend) Add(path string) error         { return nil }
func (b *fseventsBackend) Events() <-chan fsnotify.Event { return b.events }
func (b *fseventsBackend) Errors() <-chan error          { return b.errors }

func (b *fseventsBackend) Close() error {
	b.close.Do(func() {
		close(b.done)
		fsevents.streamStop(b.stream)
		fsevents.streamInvalidate(b.stream)
		fsevents.streamRelease(b.stream)
		fsevents.dispatchRelease(b.queue)
		b.unregister()
	})
	return nil
}

// handle turns one FSEvents item into the Create and Write events the
// fsnotify loop understands. FSEvents watches the whole tree, so it also
// drops events from the directories the per-directory walk never enters:
// hidden directories and node_modules.
func (b *fseventsBackend) handle(path string, flags uint32) {
	if flags&(fsEventFlagMustScanSubDirs|fsEventFlagUserDropped|fsEventFlagKernelDropped) != 0 {
		b.sendError(fmt.Errorf("fsevents dropped events under %s", path))
		return
	}

	path, tree, ok := b.mapPath(path)
	if !ok {
		return
	}
	if path != b.headFile && inSkippedDir(tree, path) {
		return
	}

	info, err := os.Lstat(path)
	exists := err == nil

	if flags&fsEventFlagItemIsDir != 0 {
		if !exists {
			delete(b.created, path)
			return
		}
		if flags&(fsEventFlagItemCreated|fsEventFlagItemRenamed) == 0 {
			return
		}
		ino := inode(info)
		if seen, ok := b.created[path]; ok && seen == ino {
			return
		}
		b.created[path] = ino
		b.send(fsnotify.Event{Name: path, Op: fsnotify.Create})
		return
	}

	if !exists {
		return
	}
	if flags&(fsEventFlagItemCreated|fsEventFlagItemRenamed|fsEventFlagItemModified|fsEventFlagItemRemoved) == 0 {
		// Only metadata changed, like a touch or chmod. kqueue reports that
		// as Chmod, which the loop ignores.
		return
	}
	b.send(fsnotify.Event{Name: path, Op: fsnotify.Write})
}

func inode(info os.FileInfo) uint64 {
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		return st.Ino
	}
	return 0
}

func (b *fseventsBackend) mapPath(path string) (string, string, bool) {
	path = filepath.Clean(path)
	best := -1
	for i, t := range b.trees {
		if (path == t.real || strings.HasPrefix(path, t.real+"/")) && (best < 0 || len(t.real) > len(b.trees[best].real)) {
			best = i
		}
	}
	if best < 0 {
		return "", "", false
	}
	t := b.trees[best]
	return t.tree + strings.TrimPrefix(path, t.real), t.tree, true
}

func (b *fseventsBackend) send(event fsnotify.Event) {
	select {
	case b.events <- event:
	case <-b.done:
	}
}

func (b *fseventsBackend) sendError(err error) {
	select {
	case b.errors <- err:
	case <-b.done:
	default:
	}
}
