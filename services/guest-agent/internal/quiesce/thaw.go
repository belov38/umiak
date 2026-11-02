package quiesce

import (
	"context"
	"errors"
	"log/slog"
	"slices"
	"sync"
	"syscall"
	"time"

	"github.com/belov38/umiak/services/guest-agent/internal/docker"
	"github.com/belov38/umiak/services/guest-agent/internal/paths"
)

// Docker step limits (spec 14.2).
const (
	dockerBudget   = 5 * time.Second
	dockerParallel = 8
)

// steps are the freeze and thaw actions shared by the agent, the watchdog
// unit and `umiak-agent thaw --force`. A nil freezer or docker skips its part.
type steps struct {
	freezer Freezer
	docker  DockerAPI
	runHook HookRunner
	log     *slog.Logger
}

// pauseAll pauses ids, at most dockerParallel at a time. It returns the ids
// that were paused (in ids order) and the first error.
func (s steps) pauseAll(ctx context.Context, ids []string) ([]string, error) {
	ok := make([]bool, len(ids))
	var (
		mu       sync.Mutex
		firstErr error
		wg       sync.WaitGroup
	)
	sem := make(chan struct{}, dockerParallel)
	for i, id := range ids {
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			err := s.docker.Pause(ctx, id)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				if firstErr == nil {
					firstErr = err
				}
				return
			}
			ok[i] = true
		}()
	}
	wg.Wait()
	var paused []string
	for i, id := range ids {
		if ok[i] {
			paused = append(paused, id)
		}
	}
	return paused, firstErr
}

// unpauseAll unpauses ids, at most dockerParallel at a time, within
// dockerBudget. A container that is not paused or is gone counts as done;
// other failures are logged.
func (s steps) unpauseAll(ctx context.Context, ids []string) {
	if s.docker == nil || len(ids) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, dockerBudget)
	defer cancel()
	var wg sync.WaitGroup
	sem := make(chan struct{}, dockerParallel)
	for _, id := range ids {
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			err := s.docker.Unpause(ctx, id)
			if err != nil && !docker.IsNotPaused(err) && !docker.IsNotFound(err) {
				s.log.Warn("quiesce: unpause failed", "container", id, "err", err)
			}
		}()
	}
	wg.Wait()
}

// thawMounts issues FITHAW on paths in reverse order. A mount that is not
// frozen (EINVAL) is fine; other failures are logged. It returns the paths
// that were frozen and are thawed now.
func (s steps) thawMounts(paths []string) []string {
	if s.freezer == nil {
		return nil
	}
	var thawed []string
	for _, p := range slices.Backward(paths) {
		err := s.freezer.Thaw(p)
		switch {
		case err == nil:
			thawed = append(thawed, p)
		case errors.Is(err, syscall.EINVAL):
		default:
			s.log.Error("quiesce: thaw failed", "mount", p, "err", err)
		}
	}
	return thawed
}

// thawLease undoes l (spec 14.3): FITHAW in reverse order, then afterFS
// (may be nil), the hooks with thaw in reverse order and the unpause of the
// containers.
func (s steps) thawLease(ctx context.Context, l *Lease, afterFS func()) {
	s.thawMounts(l.Frozen)
	if afterFS != nil {
		afterFS()
	}
	for _, h := range slices.Backward(l.Hooks) {
		if err := s.runHook(ctx, h, hookThaw); err != nil {
			s.log.Warn("quiesce: thaw hook failed", "hook", h, "err", err)
		}
	}
	s.unpauseAll(ctx, l.Paused)
}

// thawAllMounts issues FITHAW on every freezable mount plus extra, in
// reverse freeze order, and returns the mounts that were frozen.
func (s steps) thawAllMounts(extra []string) ([]string, error) {
	if s.freezer == nil {
		return nil, nil
	}
	mounts, err := s.freezer.Mounts()
	if err != nil {
		return nil, err
	}
	all := slices.Clone(extra)
	for _, m := range mounts {
		if !slices.Contains(all, m.Path) {
			all = append(all, m.Path)
		}
	}
	return s.thawMounts(all), nil
}

// ForceThaw implements `umiak-agent thaw --force` (spec 14.4, 17.6): FITHAW
// every freezable mount (and every mount named in a lease file, if one is
// left) and unpause every paused container. It works without the agent and
// leaves the lease file and the markers to the agent and the watchdog. f
// and d may be nil (Windows has no freezer).
func ForceThaw(l paths.Layout, f Freezer, d DockerAPI) error {
	log := slog.Default()
	s := steps{freezer: f, docker: d, runHook: execHook, log: log}
	var extra []string
	for _, p := range []string{l.QuiesceFile, claimPath(l)} {
		if lease, err := readLease(p); err != nil {
			log.Warn("quiesce: unreadable lease file", "err", err)
		} else if lease != nil {
			extra = append(extra, lease.Frozen...)
		}
	}
	thawed, ferr := s.thawAllMounts(extra)
	for _, p := range thawed {
		log.Info("quiesce: thawed", "mount", p)
	}
	if d == nil {
		return ferr
	}
	ctx, cancel := context.WithTimeout(context.Background(), dockerBudget)
	defer cancel()
	ids, err := d.Paused(ctx)
	switch {
	case errors.Is(err, docker.ErrNoDaemon):
	case err != nil:
		return errors.Join(ferr, err)
	default:
		s.unpauseAll(context.Background(), ids)
		for _, id := range ids {
			log.Info("quiesce: unpaused", "container", id)
		}
	}
	return ferr
}

// LeaseOnDisk returns the lease recorded in the lease file, or in the
// watchdog's claim of it, and nil when there is none.
func LeaseOnDisk(l paths.Layout) (*Lease, error) {
	lease, err := readLease(l.QuiesceFile)
	if lease != nil || err != nil {
		return lease, err
	}
	return readLease(claimPath(l))
}

// DropLease removes the lease file and the watchdog's claim of it:
// `umiak-agent thaw --force` on Windows when the agent is not running. The
// filesystem was never frozen by the agent there (VSS thaws itself), and a
// wiped secret file comes back with the next UpdateSecrets.
func DropLease(l paths.Layout) error {
	return errors.Join(removeLease(l.QuiesceFile), removeLease(claimPath(l)))
}
