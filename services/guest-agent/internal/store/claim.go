package store

import (
	"context"
	"encoding/json"
	"time"
)

// claimKey is the only key of the claim bucket.
const claimKey = "claim"

// Claim is the applied claim (spec 8.1). Request is the claim request
// without secret values; SecretsDigest identifies the secrets applied with
// it. Response is the encoded ClaimResponse replayed for the same request.
type Claim struct {
	Request       json.RawMessage `json:"request,omitempty"`
	RequestHash   string          `json:"request_hash"`
	SecretsDigest string          `json:"secrets_digest,omitempty"`
	SandboxID     string          `json:"sandbox_id"`
	ClaimedAt     time.Time       `json:"claimed_at"`
	Response      []byte          `json:"response,omitempty"`
}

// GetClaim returns the stored claim.
func (s *Store) GetClaim() (*Claim, bool, error) {
	var c Claim
	ok, err := s.get(bucketClaim, claimKey, &c)
	if !ok || err != nil {
		return nil, ok, err
	}
	return &c, true, nil
}

// PutClaim durably replaces the stored claim.
func (s *Store) PutClaim(ctx context.Context, c *Claim) error {
	return s.putJSON(ctx, bucketClaim, claimKey, c)
}
