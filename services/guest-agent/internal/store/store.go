// Package store is the agent's durable state: a bbolt database (state.db)
// written by a single batching writer behind a freeze gate, typed JSON
// records and the event journal (spec sections 14.4 and 15).
//
// All durable writes go through one goroutine that groups the queued writes
// and journal appends into one bbolt transaction, so one fsync covers a
// batch. While the agent's own filesystem freeze is active (SetFrozen) the
// writer opens no transactions: Update callers wait for the thaw or their
// context (ErrFrozen), journal events wait in memory without a seq. Reads
// (View and the typed getters) never wait on the writer.
package store

import (
	"encoding/binary"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"go.etcd.io/bbolt"
	"google.golang.org/protobuf/proto"

	tunnelv1 "github.com/belov38/umiak/libs/proto/umiak/tunnel/v1"
)

// SchemaVersion is the state.db schema written by this agent version.
const SchemaVersion = 1

// Bucket names.
var (
	bucketMeta     = []byte("meta")
	bucketCommands = []byte("commands")
	bucketRequests = []byte("requests")
	bucketEvents   = []byte("events")
	bucketUploads  = []byte("uploads")
	bucketClaim    = []byte("claim")

	allBuckets = [][]byte{bucketMeta, bucketCommands, bucketRequests, bucketEvents, bucketUploads, bucketClaim}
)

// Reserved meta keys, owned by the store. PutMeta refuses them.
const (
	// MetaSchema holds the schema version (8-byte big-endian).
	MetaSchema = "schema"
	// MetaLastSeq holds the last assigned journal seq (8-byte big-endian).
	MetaLastSeq = "last_seq"
	// MetaAckedSeq holds the highest acknowledged journal seq (8-byte
	// big-endian).
	MetaAckedSeq = "acked_seq"
)

// Defaults of Options.
const (
	DefaultJournalMaxEvents = 100000
	DefaultJournalMaxBytes  = 64 << 20
	DefaultFrozenMaxRecords = 10000
	DefaultFrozenMaxBytes   = 64 << 20
)

var (
	// ErrFrozen is returned by durable writes whose context ended while the
	// store was frozen. Callers map it to unavailable/quiesced.
	ErrFrozen = errors.New("store: frozen")
	// ErrClosed is returned after Close.
	ErrClosed = errors.New("store: closed")
)

// Options configures a Store. Zero values select the defaults.
type Options struct {
	// JournalMaxEvents is the most events kept in the journal.
	JournalMaxEvents int
	// JournalMaxBytes bounds the summed size of stored event envelopes.
	JournalMaxBytes int64
	// FrozenMaxRecords is the most journal events kept in memory while
	// they wait for the writer (in practice: while frozen).
	FrozenMaxRecords int
	// FrozenMaxBytes bounds the summed size of those events.
	FrozenMaxBytes int64
	// Now is the event clock. Default time.Now.
	Now func() time.Time
	// GapPayload builds the payload of a journal.gap event; nil writes the
	// event without payload.
	GapPayload func(from, to uint64) proto.Message
	// Log receives writer failures. Default slog.Default().
	Log *slog.Logger
}

func (o *Options) setDefaults() {
	if o.JournalMaxEvents <= 0 {
		o.JournalMaxEvents = DefaultJournalMaxEvents
	}
	if o.JournalMaxBytes <= 0 {
		o.JournalMaxBytes = DefaultJournalMaxBytes
	}
	if o.FrozenMaxRecords <= 0 {
		o.FrozenMaxRecords = DefaultFrozenMaxRecords
	}
	if o.FrozenMaxBytes <= 0 {
		o.FrozenMaxBytes = DefaultFrozenMaxBytes
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Log == nil {
		o.Log = slog.Default()
	}
}

// Store is the agent's state.db. Its methods are safe for concurrent use.
type Store struct {
	db   *bbolt.DB
	opts Options

	// commitMu is held by the writer for the duration of a transaction;
	// SetFrozen(true) takes it to wait out an in-flight commit.
	commitMu sync.Mutex

	mu           sync.Mutex
	queue        []*op           // durable writes waiting for the writer
	pending      []pendingEvent  // journal events without seq, in append order
	pendingBytes int64           // summed size of pending
	dropped      uint64          // pending events dropped on overflow, not yet journaled as a gap
	frozen       bool            // own freeze active: no transactions
	thawed       chan struct{}   // closed while not frozen and after Close; replaced by a new open channel on freeze
	thawedOpen   bool            // thawed is open (a freeze is waiting for its thaw)
	closed       bool            // Close called
	bootID       string          // BootId of new events
	acked        uint64          // highest acked seq (persisted or about to be)
	notify       chan struct{}   // closed and replaced on every commit that added events
	journal      journalCounters // committed journal state

	kick    chan struct{} // wakes the writer; buffered 1
	closing chan struct{} // closed by Close
	done    chan struct{} // closed when the writer exits
}

// journalCounters is the committed state of the events bucket. The writer
// computes new values inside a transaction and publishes them under mu
// after the commit. count and bytes are rebuilt by scanning the bucket on
// Open; bytes is the sum of the stored envelope sizes (proto.Size).
type journalCounters struct {
	lastSeq    uint64
	ackedSaved uint64 // acked seq persisted in meta
	count      int
	bytes      int64
}

// Open opens or creates the database at path, creates the buckets and the
// schema version, and starts the writer.
func Open(path string, opts Options) (*Store, error) {
	opts.setDefaults()
	db, err := bbolt.Open(path, 0o600, &bbolt.Options{Timeout: time.Second})
	if err != nil {
		return nil, fmt.Errorf("store: open %s: %w", path, err)
	}
	thawed := make(chan struct{})
	close(thawed)
	s := &Store{
		db:      db,
		opts:    opts,
		thawed:  thawed,
		notify:  make(chan struct{}),
		kick:    make(chan struct{}, 1),
		closing: make(chan struct{}),
		done:    make(chan struct{}),
	}
	if err := s.init(); err != nil {
		_ = db.Close()
		return nil, err
	}
	go s.run()
	return s, nil
}

// init creates the buckets and the schema key and loads the journal state.
func (s *Store) init() error {
	err := s.db.Update(func(tx *bbolt.Tx) error {
		for _, b := range allBuckets {
			if _, err := tx.CreateBucketIfNotExists(b); err != nil {
				return err
			}
		}
		meta := tx.Bucket(bucketMeta)
		// A newer schema is kept as is: records are forward compatible
		// (spec 17.5) and a rollback must not downgrade the marker.
		if meta.Get([]byte(MetaSchema)) == nil {
			return meta.Put([]byte(MetaSchema), encodeU64(SchemaVersion))
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("store: init: %w", err)
	}
	return s.db.View(func(tx *bbolt.Tx) error {
		meta := tx.Bucket(bucketMeta)
		j := journalCounters{
			lastSeq:    decodeU64(meta.Get([]byte(MetaLastSeq))),
			ackedSaved: decodeU64(meta.Get([]byte(MetaAckedSeq))),
		}
		err := tx.Bucket(bucketEvents).ForEach(func(_, v []byte) error {
			j.count++
			j.bytes += int64(len(v))
			return nil
		})
		s.journal = j
		s.acked = j.ackedSaved
		return err
	})
}

// Close stops the writer and closes the database. Queued writes are
// committed first unless the store is frozen; then they fail with ErrClosed
// and pending journal events are lost (their seq was never assigned).
func (s *Store) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		<-s.done
		return nil
	}
	s.closed = true
	close(s.closing)
	s.releaseThawedLocked()
	s.mu.Unlock()
	<-s.done
	return s.db.Close()
}

// View runs fn in a read-only transaction. It never waits on the writer.
func (s *Store) View(fn func(tx *bbolt.Tx) error) error {
	return s.db.View(fn)
}

// get reads key from bucket and decodes the JSON value into v.
func (s *Store) get(bucket []byte, key string, v any) (bool, error) {
	var found bool
	err := s.db.View(func(tx *bbolt.Tx) error {
		data := tx.Bucket(bucket).Get([]byte(key))
		if data == nil {
			return nil
		}
		found = true
		return decodeJSON(data, v)
	})
	return found, err
}

// encodeU64 returns v as 8 bytes big-endian.
func encodeU64(v uint64) []byte {
	return binary.BigEndian.AppendUint64(nil, v)
}

// decodeU64 decodes an 8-byte big-endian value; anything else is 0.
func decodeU64(b []byte) uint64 {
	if len(b) != 8 {
		return 0
	}
	return binary.BigEndian.Uint64(b)
}

// marshalEvent encodes a journal envelope as stored in the events bucket.
func marshalEvent(ev *tunnelv1.Event) ([]byte, error) {
	return proto.Marshal(ev)
}
