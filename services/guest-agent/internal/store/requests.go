package store

import (
	"bytes"
	"context"
	"slices"
	"time"

	"go.etcd.io/bbolt"
)

// Request is a cached outcome of a mutating call keyed by its request id
// (spec 15). Code is a connect.Code, 0 for success; Response is the encoded
// response message, empty when the outcome is an error or too large.
type Request struct {
	Procedure string    `json:"procedure"`
	Hash      string    `json:"hash"`
	Code      int       `json:"code,omitempty"`
	Detail    string    `json:"detail,omitempty"`
	Message   string    `json:"message,omitempty"`
	Response  []byte    `json:"response,omitempty"`
	ExpiresAt time.Time `json:"expires_at"`
}

// GetRequest returns the cached outcome for request id.
func (s *Store) GetRequest(id string) (*Request, bool, error) {
	var r Request
	ok, err := s.get(bucketRequests, id, &r)
	if !ok || err != nil {
		return nil, ok, err
	}
	return &r, true, nil
}

// PutRequest durably stores the outcome of request id.
func (s *Store) PutRequest(ctx context.Context, id string, r *Request) error {
	return s.putJSON(ctx, bucketRequests, id, r)
}

// PruneRequests durably deletes the entries expired at now and then, while
// more than maxEntries remain, the ones expiring first. It returns the
// number deleted. Selection and deletion run in one write transaction.
func (s *Store) PruneRequests(ctx context.Context, now time.Time, maxEntries int) (int, error) {
	type entry struct {
		id  []byte
		exp time.Time
	}
	var deleted int
	err := s.Update(ctx, func(tx *bbolt.Tx) error {
		b := tx.Bucket(bucketRequests)
		var live []entry
		var drop [][]byte // copied: keys point into the mmap
		err := b.ForEach(func(k, v []byte) error {
			var r Request
			// An undecodable entry is useless to the cache: drop it too.
			if err := decodeJSON(v, &r); err != nil || !r.ExpiresAt.After(now) {
				drop = append(drop, bytes.Clone(k))
				return nil
			}
			live = append(live, entry{bytes.Clone(k), r.ExpiresAt})
			return nil
		})
		if err != nil {
			return err
		}
		if extra := len(live) - max(maxEntries, 0); extra > 0 {
			slices.SortStableFunc(live, func(a, b entry) int { return a.exp.Compare(b.exp) })
			for _, e := range live[:extra] {
				drop = append(drop, e.id)
			}
		}
		for _, k := range drop {
			if err := b.Delete(k); err != nil {
				return err
			}
		}
		deleted = len(drop)
		return nil
	})
	if err != nil {
		return 0, err
	}
	return deleted, nil
}
