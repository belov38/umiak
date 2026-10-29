package output

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/events"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
)

// Retention defaults (spec section 10). A zero Janitor field selects the
// matching default.
const (
	DefaultPerStream       = 128 << 20
	DefaultTotal           = 2 << 30
	DefaultFraction        = 0.10
	DefaultLowFreeBytes    = 1 << 30
	DefaultLowFreeFraction = 0.05
	DefaultLowPerStream    = 16 << 20
	DefaultRecordTTL       = 7 * 24 * time.Hour
	DefaultMaxRecords      = 10000
)

// JanitorCommand is what the janitor needs to know about one command.
type JanitorCommand struct {
	// ID is the command id; its logs live in Layout.CommandDir(ID).
	ID string
	// Exited reports that the command has finished. Only exited commands
	// lose their record.
	Exited bool
	// EndedAt is the exit time of an exited command.
	EndedAt time.Time
	// Streams lists the log file names inside the command directory
	// ("stdout", "stderr", "pty").
	Streams []string
}

// Janitor enforces the output retention policy of spec section 10: a cap per
// stream, a cap on the total, a stricter stream cap while the disk is low,
// and removal of old command records. It never kills commands; only old
// output is lost.
type Janitor struct {
	// Layout locates the command directories and the state filesystem.
	Layout paths.Layout
	// Store evicts old output.
	Store Store

	// PerStream is the most output kept per stream.
	PerStream int64
	// Total and Fraction bound the output of all commands: min(Total,
	// Fraction x filesystem size).
	Total    int64
	Fraction float64

	// LowFreeBytes and LowFreeFraction set the disk-low threshold: free space
	// below max(LowFreeBytes, LowFreeFraction x filesystem size).
	LowFreeBytes    int64
	LowFreeFraction float64
	// LowPerStream replaces PerStream while the disk is low.
	LowPerStream int64

	// Commands lists the known commands, oldest first. Running commands are
	// trimmed in the order given.
	Commands func() []JanitorCommand
	// Statfs reports the size and the free space of the filesystem holding
	// path. Defaults to DefaultStatfs.
	Statfs func(path string) (total, free uint64, err error)
	// Emit receives disk.low and disk.ok.
	Emit events.Emitter
	// Now returns the current time. Defaults to time.Now.
	Now func() time.Time

	// RecordTTL and MaxRecords bound how long and how many exited command
	// records are kept.
	RecordTTL  time.Duration
	MaxRecords int
	// RemoveRecord deletes the record of an exited command. The janitor
	// removes the command's log directory afterwards.
	RemoveRecord func(id string) error

	mu  sync.Mutex
	low bool
}

// stream is the state of one log file during a janitor pass.
type stream struct {
	path string
	size int64
	held int64 // size - available_from
}

type cmdStreams struct {
	cmd     JanitorCommand
	streams []*stream
}

// RunOnce applies the retention policy once. It keeps going after a failure
// on one file and returns the joined errors.
func (j *Janitor) RunOnce(ctx context.Context) error {
	var errs []error
	cmds, rerrs := j.removeRecords(ctx, j.Commands())
	errs = append(errs, rerrs...)

	fsTotal, free, serr := j.statfs()
	perStream := orDefault(j.PerStream, DefaultPerStream)
	if serr != nil {
		if !errors.Is(serr, errors.ErrUnsupported) {
			errs = append(errs, serr)
		}
	} else if j.updateLow(fsTotal, free) {
		perStream = min(perStream, orDefault(j.LowPerStream, DefaultLowPerStream))
	}

	// Per-stream cap; the remaining sizes feed the total check.
	states := make([]cmdStreams, 0, len(cmds))
	var total int64
	for _, c := range cmds {
		if err := ctx.Err(); err != nil {
			return errors.Join(append(errs, err)...)
		}
		cs := cmdStreams{cmd: c}
		for _, name := range c.Streams {
			s, err := j.capStream(filepath.Join(j.Layout.CommandDir(c.ID), name), perStream)
			if err != nil {
				errs = append(errs, err)
			}
			if s != nil {
				total += s.held
				cs.streams = append(cs.streams, s)
			}
		}
		states = append(states, cs)
	}

	limit := orDefault(j.Total, DefaultTotal)
	if serr == nil && fsTotal > 0 {
		frac := j.Fraction
		if frac <= 0 {
			frac = DefaultFraction
		}
		limit = min(limit, int64(frac*float64(fsTotal)))
	}
	if total > limit {
		errs = append(errs, j.enforceTotal(ctx, states, total, limit)...)
	}
	return errors.Join(errs...)
}

// enforceTotal frees output until total <= limit: whole logs of the oldest
// exited commands first, then the front of running commands' logs.
func (j *Janitor) enforceTotal(ctx context.Context, states []cmdStreams, total, limit int64) []error {
	var errs []error
	var exited, running []cmdStreams
	for _, cs := range states {
		if cs.cmd.Exited {
			exited = append(exited, cs)
		} else {
			running = append(running, cs)
		}
	}
	slices.SortStableFunc(exited, func(a, b cmdStreams) int { return a.cmd.EndedAt.Compare(b.cmd.EndedAt) })

	for _, cs := range exited {
		for _, s := range cs.streams {
			if total <= limit || ctx.Err() != nil {
				return errs
			}
			if err := j.punch(s.path, s.size); err != nil {
				errs = append(errs, err)
				continue
			}
			total -= s.held
		}
	}
	for _, cs := range running {
		for _, s := range cs.streams {
			excess := total - limit
			if excess <= 0 || ctx.Err() != nil {
				return errs
			}
			cut := min(excess, s.held)
			if err := j.punch(s.path, s.size-s.held+cut); err != nil {
				errs = append(errs, err)
				continue
			}
			total -= cut
		}
	}
	return errs
}

// capStream evicts the front of the stream so that at most limit bytes
// remain (plus up to one block of alignment slack). It returns nil for a
// missing file.
func (j *Janitor) capStream(path string, limit int64) (*stream, error) {
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	fi, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, err
	}
	size := fi.Size()
	avail, err := j.Store.AvailableFrom(f, size)
	_ = f.Close()
	if err != nil {
		return nil, fmt.Errorf("output: available_from %s: %w", path, err)
	}
	s := &stream{path: path, size: size, held: size - avail}
	if s.held > limit {
		if err := j.punch(path, size-limit); err != nil {
			return s, err
		}
		if f, err := os.Open(path); err == nil {
			if a, err := j.Store.AvailableFrom(f, size); err == nil {
				s.held = size - a
			}
			_ = f.Close()
		}
	}
	return s, nil
}

// punch evicts the file at path up to upTo.
func (j *Janitor) punch(path string, upTo int64) error {
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	defer func() { _ = f.Close() }()
	if err := j.Store.PunchFront(f, upTo); err != nil {
		return fmt.Errorf("output: punch %s: %w", path, err)
	}
	return nil
}

// removeRecords drops exited commands older than RecordTTL, then the oldest
// exited ones while more than MaxRecords exist. It returns the commands that
// remain.
func (j *Janitor) removeRecords(ctx context.Context, cmds []JanitorCommand) ([]JanitorCommand, []error) {
	if j.RemoveRecord == nil {
		return cmds, nil
	}
	now := time.Now()
	if j.Now != nil {
		now = j.Now()
	}
	ttl := orDefault(j.RecordTTL, DefaultRecordTTL)
	maxRecords := int(orDefault(int64(j.MaxRecords), int64(DefaultMaxRecords)))

	doomed := map[string]bool{}
	for _, c := range cmds {
		if c.Exited && !c.EndedAt.IsZero() && now.Sub(c.EndedAt) > ttl {
			doomed[c.ID] = true
		}
	}
	if excess := len(cmds) - len(doomed) - maxRecords; excess > 0 {
		var exited []JanitorCommand
		for _, c := range cmds {
			if c.Exited && !doomed[c.ID] {
				exited = append(exited, c)
			}
		}
		slices.SortStableFunc(exited, func(a, b JanitorCommand) int { return a.EndedAt.Compare(b.EndedAt) })
		for _, c := range exited[:min(excess, len(exited))] {
			doomed[c.ID] = true
		}
	}

	var errs []error
	kept := make([]JanitorCommand, 0, len(cmds))
	for _, c := range cmds {
		if !doomed[c.ID] {
			kept = append(kept, c)
			continue
		}
		if ctx.Err() != nil {
			kept = append(kept, c)
			continue
		}
		if !validCommandID(c.ID) {
			errs = append(errs, fmt.Errorf("output: refusing to remove record with invalid id %q", c.ID))
			kept = append(kept, c)
			continue
		}
		if err := j.RemoveRecord(c.ID); err != nil {
			errs = append(errs, fmt.Errorf("output: remove record %s: %w", c.ID, err))
			kept = append(kept, c)
			continue
		}
		if err := os.RemoveAll(j.Layout.CommandDir(c.ID)); err != nil {
			errs = append(errs, err)
		}
	}
	return kept, errs
}

func (j *Janitor) statfs() (total, free uint64, err error) {
	fn := j.Statfs
	if fn == nil {
		fn = DefaultStatfs
	}
	return fn(j.Layout.StateDir)
}

// updateLow reports whether the disk is low and emits disk.low / disk.ok on
// transitions only.
func (j *Janitor) updateLow(total, free uint64) bool {
	threshold := uint64(orDefault(j.LowFreeBytes, DefaultLowFreeBytes))
	frac := j.LowFreeFraction
	if frac <= 0 {
		frac = DefaultLowFreeFraction
	}
	threshold = max(threshold, uint64(frac*float64(total)))
	low := free < threshold

	j.mu.Lock()
	changed := low != j.low
	j.low = low
	j.mu.Unlock()

	if changed && j.Emit != nil {
		typ := events.TypeDiskOK
		if low {
			typ = events.TypeDiskLow
		}
		j.Emit.Emit(typ, &agentv1.DiskThreshold{Mount: j.Layout.StateDir, FreeBytes: free})
	}
	return low
}

// Run calls RunOnce every interval until ctx is done. Errors are logged.
func (j *Janitor) Run(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		if err := j.RunOnce(ctx); err != nil && ctx.Err() == nil {
			slog.Warn("output janitor", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func orDefault[T int64 | time.Duration](v, def T) T {
	if v <= 0 {
		return def
	}
	return v
}

// validCommandID reports whether id is a plain directory name, so that
// CommandDir(id) can never be the commands directory itself or leave it.
func validCommandID(id string) bool {
	return id != "" && id != "." && id != ".." && !strings.ContainsAny(id, `/\`) && !strings.ContainsRune(id, 0)
}
