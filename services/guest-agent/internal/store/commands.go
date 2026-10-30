package store

import (
	"context"
	"encoding/json"
	"time"
)

// Command is the durable record of a command (spec 9). Spec holds the
// command spec without env values; EnvKeys lists the env names.
type Command struct {
	ID            string            `json:"id"`
	SpecHash      string            `json:"spec_hash,omitempty"`
	Spec          json.RawMessage   `json:"spec,omitempty"`
	EnvKeys       []string          `json:"env_keys,omitempty"`
	State         string            `json:"state,omitempty"`
	Pid           int               `json:"pid,omitempty"`
	BootID        string            `json:"boot_id,omitempty"`
	CreatedAt     time.Time         `json:"created_at"`
	StartedAt     time.Time         `json:"started_at"`
	EndedAt       time.Time         `json:"ended_at"`
	Exit          *ExitRecord       `json:"exit,omitempty"`
	Tags          map[string]string `json:"tags,omitempty"`
	PTY           bool              `json:"pty,omitempty"`
	AgentVersion  string            `json:"agent_version,omitempty"`
	PTYDetachedAt *time.Time        `json:"pty_detached_at,omitempty"`
	// Ends maps a stream name to its final byte offset.
	Ends map[string]uint64 `json:"ends,omitempty"`
	// OutputTruncated is "disk_full" once the shim reported output dropped
	// on a full disk; Dropped holds the dropped bytes per stream name.
	OutputTruncated string            `json:"output_truncated,omitempty"`
	Dropped         map[string]uint64 `json:"dropped,omitempty"`
}

// ExitRecord is how a command ended. Signal is a signal name ("SIGKILL").
type ExitRecord struct {
	Status string `json:"status"`
	Reason string `json:"reason,omitempty"`
	Signal string `json:"signal,omitempty"`
	Code   int32  `json:"code"`
}

// GetCommand returns the command with id.
func (s *Store) GetCommand(id string) (*Command, bool, error) {
	var c Command
	ok, err := s.get(bucketCommands, id, &c)
	if !ok || err != nil {
		return nil, ok, err
	}
	return &c, true, nil
}

// PutCommand durably stores c under c.ID.
func (s *Store) PutCommand(ctx context.Context, c *Command) error {
	return s.putJSON(ctx, bucketCommands, c.ID, c)
}

// DeleteCommand durably removes the command with id.
func (s *Store) DeleteCommand(ctx context.Context, id string) error {
	return s.deleteKey(ctx, bucketCommands, id)
}

// ListCommands calls fn for every command in id order until fn returns false.
func (s *Store) ListCommands(fn func(*Command) bool) error {
	return list(s, bucketCommands, fn)
}
