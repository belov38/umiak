package store

import (
	"context"
	"encoding/json"
	"time"
)

// Upload is the durable record of a resumable upload (spec 11.2). Commit
// holds the committed result, replayed for repeated commit calls.
// CommitPath and CommitTarget record a commit in progress (the request path
// and the file it replaces), written before the file is moved, so a retry
// after a lost result can rebuild it.
type Upload struct {
	ID           string          `json:"id"`
	TempPath     string          `json:"temp_path"`
	Size         int64           `json:"size"`
	CreatedAt    time.Time       `json:"created_at"`
	LastActivity time.Time       `json:"last_activity"`
	Commit       json.RawMessage `json:"commit,omitempty"`
	CommitPath   string          `json:"commit_path,omitempty"`
	CommitTarget string          `json:"commit_target,omitempty"`
	// CommitStage is an adjacent copy retained as an identity anchor until
	// the result is durable. The placed target is a hard link to this file.
	CommitStage string `json:"commit_stage,omitempty"`
}

// GetUpload returns the upload with id.
func (s *Store) GetUpload(id string) (*Upload, bool, error) {
	var u Upload
	ok, err := s.get(bucketUploads, id, &u)
	if !ok || err != nil {
		return nil, ok, err
	}
	return &u, true, nil
}

// PutUpload durably stores u under u.ID.
func (s *Store) PutUpload(ctx context.Context, u *Upload) error {
	return s.putJSON(ctx, bucketUploads, u.ID, u)
}

// DeleteUpload durably removes the upload with id.
func (s *Store) DeleteUpload(ctx context.Context, id string) error {
	return s.deleteKey(ctx, bucketUploads, id)
}

// ListUploads calls fn for every upload in id order until fn returns false.
func (s *Store) ListUploads(fn func(*Upload) bool) error {
	return list(s, bucketUploads, fn)
}
