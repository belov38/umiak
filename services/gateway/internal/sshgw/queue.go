package sshgw

import (
	"context"
	"sync"
)

// jobQueue runs jobs one at a time, in order, on a worker goroutine. A job
// pushed with the key of a job that is still waiting is dropped: the
// waiting one does the same work later. It keeps notification handlers
// (LISTEN, registry hooks) from blocking on the work they trigger.
type jobQueue struct {
	mu      sync.Mutex
	pending map[string]bool
	jobs    []queuedJob
	wake    chan struct{}
}

type queuedJob struct {
	key string
	fn  func(ctx context.Context)
}

func newJobQueue() *jobQueue {
	return &jobQueue{pending: map[string]bool{}, wake: make(chan struct{}, 1)}
}

// push adds a job unless one with the same key is waiting.
func (q *jobQueue) push(key string, fn func(ctx context.Context)) {
	q.mu.Lock()
	if q.pending[key] {
		q.mu.Unlock()
		return
	}
	q.pending[key] = true
	q.jobs = append(q.jobs, queuedJob{key: key, fn: fn})
	q.mu.Unlock()
	select {
	case q.wake <- struct{}{}:
	default:
	}
}

// run executes the jobs until ctx is done; the jobs get ctx.
func (q *jobQueue) run(ctx context.Context) {
	for {
		q.mu.Lock()
		if len(q.jobs) == 0 {
			q.mu.Unlock()
			select {
			case <-ctx.Done():
				return
			case <-q.wake:
			}
			continue
		}
		j := q.jobs[0]
		q.jobs[0] = queuedJob{}
		q.jobs = q.jobs[1:]
		delete(q.pending, j.key)
		q.mu.Unlock()
		if ctx.Err() != nil {
			return
		}
		j.fn(ctx)
	}
}
