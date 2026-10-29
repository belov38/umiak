package store

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"go.etcd.io/bbolt"
	"google.golang.org/protobuf/proto"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
)

// gapPayload is the Options.GapPayload used by the tests.
func gapPayload(from, to uint64) proto.Message {
	return &agentv1.JournalGap{FromSeq: from, ToSeq: to}
}

// openTest opens a store in a temp dir and closes it at cleanup.
func openTest(t *testing.T, opts Options) (*Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "state.db")
	s := reopen(t, path, opts)
	return s, path
}

// reopen opens the store at path and closes it at cleanup.
func reopen(t *testing.T, path string, opts Options) *Store {
	t.Helper()
	if opts.GapPayload == nil {
		opts.GapPayload = gapPayload
	}
	s, err := Open(path, opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

// waitQueued waits until n durable writes are queued.
func waitQueued(t *testing.T, s *Store, n int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		s.mu.Lock()
		got := len(s.queue)
		s.mu.Unlock()
		if got == n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("queued = %d, want %d", got, n)
		}
		time.Sleep(time.Millisecond)
	}
}

func getKey(t *testing.T, s *Store, bucket []byte, key string) []byte {
	t.Helper()
	var v []byte
	if err := s.View(func(tx *bbolt.Tx) error {
		v = append([]byte(nil), tx.Bucket(bucket).Get([]byte(key))...)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(v) == 0 {
		return nil
	}
	return v
}

func TestOpenCreatesBucketsAndSchema(t *testing.T) {
	s, _ := openTest(t, Options{})
	err := s.View(func(tx *bbolt.Tx) error {
		for _, b := range allBuckets {
			if tx.Bucket(b) == nil {
				t.Errorf("bucket %s missing", b)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if v, ok := s.Meta(MetaSchema); !ok || decodeU64(v) != SchemaVersion {
		t.Errorf("schema = %v %v, want %d", v, ok, SchemaVersion)
	}
}

func TestUpdateWaitsWhileFrozen(t *testing.T) {
	s, _ := openTest(t, Options{})
	s.SetFrozen(true)
	if !s.Frozen() {
		t.Fatal("Frozen() = false")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	err := s.Update(ctx, func(tx *bbolt.Tx) error {
		return tx.Bucket(bucketMeta).Put([]byte("k"), []byte("v"))
	})
	if !errors.Is(err, ErrFrozen) {
		t.Fatalf("Update = %v, want ErrFrozen", err)
	}
	if d := time.Since(start); d < 40*time.Millisecond {
		t.Errorf("Update returned after %v, want to wait for ctx", d)
	}
	s.SetFrozen(false)
	if err := s.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if v := getKey(t, s, bucketMeta, "k"); v != nil {
		t.Errorf("cancelled write committed after thaw: %q", v)
	}
}

func TestUpdateCompletesAfterThaw(t *testing.T) {
	s, _ := openTest(t, Options{})
	s.SetFrozen(true)
	errc := make(chan error, 1)
	go func() {
		errc <- s.Update(context.Background(), func(tx *bbolt.Tx) error {
			return tx.Bucket(bucketMeta).Put([]byte("k"), []byte("v"))
		})
	}()
	waitQueued(t, s, 1)
	select {
	case err := <-errc:
		t.Fatalf("Update returned while frozen: %v", err)
	case <-time.After(30 * time.Millisecond):
	}
	s.SetFrozen(false)
	if err := <-errc; err != nil {
		t.Fatal(err)
	}
	if v := getKey(t, s, bucketMeta, "k"); string(v) != "v" {
		t.Errorf("k = %q", v)
	}
}

func TestBatchFailureIsolated(t *testing.T) {
	s, _ := openTest(t, Options{})
	boom := errors.New("boom")
	// Freeze so both writes land in one batch on thaw.
	s.SetFrozen(true)
	var wg sync.WaitGroup
	var goodErr, badErr error
	wg.Add(2)
	go func() {
		defer wg.Done()
		goodErr = s.Update(context.Background(), func(tx *bbolt.Tx) error {
			return tx.Bucket(bucketMeta).Put([]byte("good"), []byte("1"))
		})
	}()
	waitQueued(t, s, 1)
	go func() {
		defer wg.Done()
		badErr = s.Update(context.Background(), func(tx *bbolt.Tx) error {
			if err := tx.Bucket(bucketMeta).Put([]byte("bad"), []byte("1")); err != nil {
				return err
			}
			return boom
		})
	}()
	waitQueued(t, s, 2)
	s.AppendEvent("x", nil)
	s.SetFrozen(false)
	wg.Wait()
	if goodErr != nil {
		t.Errorf("good Update = %v", goodErr)
	}
	if !errors.Is(badErr, boom) {
		t.Errorf("bad Update = %v, want boom", badErr)
	}
	if v := getKey(t, s, bucketMeta, "good"); string(v) != "1" {
		t.Errorf("good = %q", v)
	}
	if v := getKey(t, s, bucketMeta, "bad"); v != nil {
		t.Errorf("bad = %q, want rolled back", v)
	}
	evs := readAll(t, s, 0)
	if len(evs) != 1 || evs[0].GetSeq() != 1 {
		t.Errorf("events = %v, want one with seq 1", evs)
	}
}

func TestCloseFailsQueuedWhileFrozen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.db")
	s, err := Open(path, Options{})
	if err != nil {
		t.Fatal(err)
	}
	s.SetFrozen(true)
	errc := make(chan error, 1)
	go func() {
		errc <- s.Update(context.Background(), func(*bbolt.Tx) error { return nil })
	}()
	waitQueued(t, s, 1)
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if err := <-errc; !errors.Is(err, ErrClosed) {
		t.Errorf("Update = %v, want ErrClosed", err)
	}
	if err := s.Update(context.Background(), func(*bbolt.Tx) error { return nil }); !errors.Is(err, ErrClosed) {
		t.Errorf("Update after Close = %v, want ErrClosed", err)
	}
}

func TestMetaRoundTrip(t *testing.T) {
	s, path := openTest(t, Options{})
	ctx := context.Background()
	if _, ok := s.Meta("last_boot_id"); ok {
		t.Fatal("unexpected value")
	}
	if err := s.PutMeta(ctx, "last_boot_id", []byte("b1")); err != nil {
		t.Fatal(err)
	}
	if err := s.PutMeta(ctx, MetaLastSeq, []byte("x")); err == nil {
		t.Error("PutMeta on a reserved key succeeded")
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s = reopen(t, path, Options{})
	if v, ok := s.Meta("last_boot_id"); !ok || string(v) != "b1" {
		t.Errorf("Meta = %q %v", v, ok)
	}
}

func TestSetFrozenWaitsForCommit(t *testing.T) {
	s, _ := openTest(t, Options{})
	inFn, release := make(chan struct{}), make(chan struct{})
	errc := make(chan error, 1)
	go func() {
		errc <- s.Update(context.Background(), func(*bbolt.Tx) error {
			close(inFn)
			<-release
			return nil
		})
	}()
	<-inFn
	frozen := make(chan struct{})
	go func() {
		s.SetFrozen(true)
		close(frozen)
	}()
	select {
	case <-frozen:
		t.Fatal("SetFrozen(true) returned during a commit")
	case <-time.After(30 * time.Millisecond):
	}
	close(release)
	<-frozen
	if err := <-errc; err != nil {
		t.Fatal(err)
	}
}

func isClosed(c <-chan struct{}) bool {
	select {
	case <-c:
		return true
	default:
		return false
	}
}

func TestThawedFollowsFreezeGate(t *testing.T) {
	s, _ := openTest(t, Options{})
	if !isClosed(s.Thawed()) {
		t.Fatal("Thawed() of a new store is open")
	}

	s.SetFrozen(true)
	frozenGate := s.Thawed()
	if isClosed(frozenGate) {
		t.Fatal("Thawed() is closed while frozen")
	}
	// A repeated freeze keeps the same gate.
	s.SetFrozen(true)
	if s.Thawed() != frozenGate {
		t.Fatal("repeated SetFrozen(true) replaced the gate")
	}

	s.SetFrozen(false)
	if !isClosed(frozenGate) || !isClosed(s.Thawed()) {
		t.Fatal("Thawed() is open after the thaw")
	}
	// A repeated thaw must not panic on a closed gate.
	s.SetFrozen(false)

	// Re-armed by the next freeze.
	s.SetFrozen(true)
	if isClosed(s.Thawed()) {
		t.Fatal("Thawed() is closed after a second freeze")
	}
	s.SetFrozen(false)
}

func TestCloseReleasesThawedWaiters(t *testing.T) {
	s, _ := openTest(t, Options{})
	s.SetFrozen(true)
	gate := s.Thawed()
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if !isClosed(gate) {
		t.Fatal("Close left a waiter on Thawed() blocked")
	}
	// The cleanup Close and a late thaw are harmless.
	s.SetFrozen(false)
}
