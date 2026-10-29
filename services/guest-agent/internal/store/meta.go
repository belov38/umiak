package store

import (
	"context"
	"encoding/json"
	"fmt"

	"go.etcd.io/bbolt"
)

// Meta returns a copy of the meta value under key.
func (s *Store) Meta(key string) ([]byte, bool) {
	var v []byte
	var ok bool
	_ = s.db.View(func(tx *bbolt.Tx) error {
		if data := tx.Bucket(bucketMeta).Get([]byte(key)); data != nil {
			v, ok = append([]byte(nil), data...), true
		}
		return nil
	})
	return v, ok
}

// PutMeta durably stores a meta value. The store's own keys (MetaSchema,
// MetaLastSeq, MetaAckedSeq) are refused.
func (s *Store) PutMeta(ctx context.Context, key string, v []byte) error {
	switch key {
	case MetaSchema, MetaLastSeq, MetaAckedSeq:
		return fmt.Errorf("store: meta key %q is reserved", key)
	}
	return s.Update(ctx, func(tx *bbolt.Tx) error {
		return tx.Bucket(bucketMeta).Put([]byte(key), v)
	})
}

// putJSON durably stores v as JSON under key in bucket.
func (s *Store) putJSON(ctx context.Context, bucket []byte, key string, v any) error {
	if key == "" {
		return fmt.Errorf("store: empty key in %s", bucket)
	}
	data, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("store: encode %s/%s: %w", bucket, key, err)
	}
	return s.Update(ctx, func(tx *bbolt.Tx) error {
		return tx.Bucket(bucket).Put([]byte(key), data)
	})
}

// deleteKey durably removes key from bucket; a missing key is not an error.
func (s *Store) deleteKey(ctx context.Context, bucket []byte, key string) error {
	return s.Update(ctx, func(tx *bbolt.Tx) error {
		return tx.Bucket(bucket).Delete([]byte(key))
	})
}

// decodeJSON decodes a stored record. Unknown fields are ignored, so an older
// agent reads records written by a newer one (spec 17.5).
func decodeJSON(data []byte, v any) error {
	if err := json.Unmarshal(data, v); err != nil {
		return fmt.Errorf("store: decode record: %w", err)
	}
	return nil
}

// list decodes every record of bucket in key order into a fresh T and passes
// it to fn until fn returns false.
func list[T any](s *Store, bucket []byte, fn func(*T) bool) error {
	return s.db.View(func(tx *bbolt.Tx) error {
		c := tx.Bucket(bucket).Cursor()
		for k, v := c.First(); k != nil; k, v = c.Next() {
			rec := new(T)
			if err := decodeJSON(v, rec); err != nil {
				return fmt.Errorf("%s/%s: %w", bucket, k, err)
			}
			if !fn(rec) {
				return nil
			}
		}
		return nil
	})
}
