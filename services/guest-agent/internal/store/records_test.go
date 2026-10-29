package store

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"go.etcd.io/bbolt"
)

func TestCommandRoundTripIgnoresUnknownFields(t *testing.T) {
	s, _ := openTest(t, Options{})
	ctx := context.Background()
	raw := `{"id":"c1","state":"RUNNING","pid":42,"from_the_future":{"x":1},"tags":{"a":"b"}}`
	if err := s.Update(ctx, func(tx *bbolt.Tx) error {
		return tx.Bucket(bucketCommands).Put([]byte("c1"), []byte(raw))
	}); err != nil {
		t.Fatal(err)
	}
	c, ok, err := s.GetCommand("c1")
	if err != nil || !ok {
		t.Fatalf("GetCommand = %v, %v", ok, err)
	}
	if c.ID != "c1" || c.State != "RUNNING" || c.Pid != 42 || c.Tags["a"] != "b" {
		t.Errorf("command = %+v", c)
	}
}

func TestCommandCRUD(t *testing.T) {
	s, _ := openTest(t, Options{})
	ctx := context.Background()
	now := time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)
	detached := now.Add(time.Minute)
	want := &Command{
		ID: "b", SpecHash: "h", Spec: json.RawMessage(`{"argv":["ls"]}`), EnvKeys: []string{"A"},
		State: "EXITED", Pid: 7, BootID: "boot", CreatedAt: now, StartedAt: now, EndedAt: now,
		Exit: &ExitRecord{Status: "KILLED", Reason: "TIMEOUT", Signal: "SIGKILL", Code: -1},
		Tags: map[string]string{"k": "v"}, PTY: true, AgentVersion: "1.0.0", PTYDetachedAt: &detached,
		Ends: map[string]uint64{"stdout": 10},
	}
	if err := s.PutCommand(ctx, want); err != nil {
		t.Fatal(err)
	}
	if err := s.PutCommand(ctx, &Command{ID: "a"}); err != nil {
		t.Fatal(err)
	}
	got, ok, err := s.GetCommand("b")
	if err != nil || !ok {
		t.Fatalf("GetCommand = %v, %v", ok, err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("GetCommand = %+v, want %+v", got, want)
	}
	var ids []string
	if err := s.ListCommands(func(c *Command) bool { ids = append(ids, c.ID); return true }); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(ids, []string{"a", "b"}) {
		t.Errorf("ListCommands = %v", ids)
	}
	ids = nil
	_ = s.ListCommands(func(c *Command) bool { ids = append(ids, c.ID); return false })
	if len(ids) != 1 {
		t.Errorf("ListCommands did not stop: %v", ids)
	}
	if err := s.DeleteCommand(ctx, "b"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := s.GetCommand("b"); ok {
		t.Error("command b still present")
	}
}

func TestUploadCRUD(t *testing.T) {
	s, _ := openTest(t, Options{})
	ctx := context.Background()
	now := time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)
	want := &Upload{ID: "u1", TempPath: "/tmp/x", Size: 5, CreatedAt: now, LastActivity: now, Commit: json.RawMessage(`{"ok":true}`)}
	if err := s.PutUpload(ctx, want); err != nil {
		t.Fatal(err)
	}
	got, ok, err := s.GetUpload("u1")
	if err != nil || !ok || !reflect.DeepEqual(got, want) {
		t.Fatalf("GetUpload = %+v, %v, %v", got, ok, err)
	}
	var n int
	if err := s.ListUploads(func(*Upload) bool { n++; return true }); err != nil || n != 1 {
		t.Errorf("ListUploads = %d, %v", n, err)
	}
	if err := s.DeleteUpload(ctx, "u1"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := s.GetUpload("u1"); ok {
		t.Error("upload still present")
	}
}

func TestClaimRoundTrip(t *testing.T) {
	s, path := openTest(t, Options{})
	if _, ok, err := s.GetClaim(); ok || err != nil {
		t.Fatalf("GetClaim on empty store = %v, %v", ok, err)
	}
	want := &Claim{
		Request: json.RawMessage(`{"sandbox_id":"s1"}`), RequestHash: "rh", SecretsDigest: "sd", SandboxID: "s1",
		ClaimedAt: time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC), Response: []byte{1, 2, 3},
	}
	if err := s.PutClaim(context.Background(), want); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s = reopen(t, path, Options{})
	got, ok, err := s.GetClaim()
	if err != nil || !ok || !reflect.DeepEqual(got, want) {
		t.Errorf("GetClaim = %+v, %v, %v", got, ok, err)
	}
}

func TestRequestsPrune(t *testing.T) {
	s, _ := openTest(t, Options{})
	ctx := context.Background()
	now := time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)
	put := func(id string, exp time.Duration) {
		t.Helper()
		if err := s.PutRequest(ctx, id, &Request{Procedure: "/p", Hash: id, ExpiresAt: now.Add(exp)}); err != nil {
			t.Fatal(err)
		}
	}
	put("expired1", -time.Hour)
	put("expired2", 0) // expires exactly now
	put("r3", 3*time.Hour)
	put("r1", 1*time.Hour)
	put("r2", 2*time.Hour)
	put("r4", 4*time.Hour)

	n, err := s.PruneRequests(ctx, now, 2)
	if err != nil {
		t.Fatal(err)
	}
	if n != 4 {
		t.Errorf("pruned = %d, want 4", n)
	}
	for _, id := range []string{"expired1", "expired2", "r1", "r2"} {
		if _, ok, _ := s.GetRequest(id); ok {
			t.Errorf("%s not pruned", id)
		}
	}
	for _, id := range []string{"r3", "r4"} {
		r, ok, err := s.GetRequest(id)
		if err != nil || !ok || r.Hash != id || r.Procedure != "/p" {
			t.Errorf("%s = %+v, %v, %v", id, r, ok, err)
		}
	}
	if n, err := s.PruneRequests(ctx, now, 10); err != nil || n != 0 {
		t.Errorf("second prune = %d, %v", n, err)
	}
}
