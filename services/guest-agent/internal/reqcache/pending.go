package reqcache

import (
	"sync"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/store"
)

// pendingSet is the bounded in-memory buffer of outcomes that could not be
// written because the store is frozen. It keeps insertion order to drop the
// oldest entry on overflow.
type pendingSet struct {
	mu      sync.Mutex
	max     int
	m       map[string]*store.Request
	order   []string // ids of m, oldest first
	running bool     // a flusher goroutine owns the buffer
}

func newPendingSet(limit int) *pendingSet {
	return &pendingSet{max: limit, m: make(map[string]*store.Request)}
}

// get returns the buffered outcome of id.
func (p *pendingSet) get(id string) (*store.Request, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	rec, ok := p.m[id]
	return rec, ok
}

// add buffers rec. It returns the id dropped to make room, if any, and
// whether the caller must start the flusher.
func (p *pendingSet) add(id string, rec *store.Request) (dropped string, start bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if _, ok := p.m[id]; !ok {
		if len(p.order) >= p.max {
			dropped = p.order[0]
			p.order = p.order[1:]
			delete(p.m, dropped)
		}
		p.order = append(p.order, id)
	}
	p.m[id] = rec
	if !p.running {
		p.running = true
		start = true
	}
	return dropped, start
}

type pendingEntry struct {
	id  string
	rec *store.Request
}

// snapshot returns the buffered outcomes, oldest first.
func (p *pendingSet) snapshot() []pendingEntry {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]pendingEntry, 0, len(p.order))
	for _, id := range p.order {
		out = append(out, pendingEntry{id, p.m[id]})
	}
	return out
}

// remove drops id if it still holds rec (a newer outcome stays).
func (p *pendingSet) remove(id string, rec *store.Request) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.m[id] != rec {
		return
	}
	delete(p.m, id)
	for i, o := range p.order {
		if o == id {
			p.order = append(p.order[:i], p.order[i+1:]...)
			break
		}
	}
}

// clear drops everything.
func (p *pendingSet) clear() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.m = make(map[string]*store.Request)
	p.order = nil
}

// finish ends the flusher if the buffer is empty and reports whether it did;
// otherwise the flusher must go on.
func (p *pendingSet) finish() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.m) > 0 {
		return false
	}
	p.running = false
	return true
}
