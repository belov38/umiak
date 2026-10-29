package store

import (
	"context"
	"encoding/json"
	"time"
)

// Upload is the durable record of a resumable upload (spec 11.2). Commit
// holds the committed result, replayed for repeated commit calls.
type Upload struct {
	ID           string          `json:"id"`
	TempPath     string          `json:"temp_path"`
	Size         int64           `json:"size"`
	CreatedAt    time.Time       `json:"created_at"`
	LastActivity time.Time       `json:"last_activity"`
	Commit       json.RawMessage `json:"commit,omitempty"`
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
