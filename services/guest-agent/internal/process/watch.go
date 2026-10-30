package process

import (
	"path/filepath"
	"sync"

	"github.com/fsnotify/fsnotify"
)

// dirWatcher shares one fsnotify watcher among all attach streams: inotify
// instances are a scarce per-user resource, watches are not. Directories
// are reference counted; every event wakes the command named by the
// directory.
type dirWatcher struct {
	w    *fsnotify.Watcher
	wake func(id string)
	done chan struct{}

	mu   sync.Mutex
	refs map[string]int
}

func newDirWatcher(wake func(id string)) (*dirWatcher, error) {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	d := &dirWatcher{w: w, wake: wake, done: make(chan struct{}), refs: make(map[string]int)}
	go d.run()
	return d, nil
}

func (d *dirWatcher) run() {
	defer close(d.done)
	for {
		select {
		case ev, ok := <-d.w.Events:
			if !ok {
				return
			}
			// A file inside a command directory, or the directory itself.
			d.wake(filepath.Base(filepath.Dir(ev.Name)))
			d.wake(filepath.Base(ev.Name))
		case _, ok := <-d.w.Errors:
			if !ok {
				return
			}
		}
	}
}

// add watches dir; it reports false if dir cannot be watched (yet).
func (d *dirWatcher) add(dir string) bool {
	if d == nil {
		return false
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.refs[dir] == 0 {
		if err := d.w.Add(dir); err != nil {
			return false
		}
	}
	d.refs[dir]++
	return true
}

// remove drops one reference to dir.
func (d *dirWatcher) remove(dir string) {
	if d == nil {
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.refs[dir]--
	if d.refs[dir] <= 0 {
		delete(d.refs, dir)
		_ = d.w.Remove(dir)
	}
}

func (d *dirWatcher) close() {
	_ = d.w.Close()
	<-d.done
}
