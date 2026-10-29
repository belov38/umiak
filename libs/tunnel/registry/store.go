// Package registry is the Postgres-backed registry of gateway instances,
// tunnel sessions and tunnel credentials (S2 spec sections 5.2, 7 and 8).
//
// The schema lives in db/migrations (range 0100-0199) and is applied by the
// migration runner owned by S6; this package only reads and writes the tables.
// All timestamps come from the database clock (now()).
package registry

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/belov38/boat-dev-clone/libs/tunnel/transport"
)

// Errors returned by the store.
var (
	// ErrUnauthorized means the machine is unknown or the presented secret does not match.
	ErrUnauthorized = errors.New("registry: unauthorized")
	// ErrRetired means the machine was deleted and may not connect any more.
	ErrRetired = errors.New("registry: machine retired")
	// ErrNotFound means the requested row does not exist.
	ErrNotFound = errors.New("registry: not found")
)

// Instance states.
const (
	// InstanceActive is a gateway instance that accepts new connections.
	InstanceActive = "active"
	// InstanceDraining is a gateway instance that is shutting down.
	InstanceDraining = "draining"
)

// Session states.
const (
	// SessionConnected is a session with a live tunnel.
	SessionConnected = "connected"
	// SessionDisconnected is a session whose tunnel is gone.
	SessionDisconnected = "disconnected"
)

// pgInvalidText is the SQLSTATE of a malformed value such as a bad uuid.
const pgInvalidText = "22P02"

// Store reads and writes the tunnel registry tables.
type Store struct {
	pool *pgxpool.Pool
}

// New returns a Store on top of pool.
func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

// Session is a row of tunnel.tunnel_sessions.
type Session struct {
	MachineID       string
	InstanceID      string
	ConnID          string
	AgentInstanceID string
	BootID          string
	Vmgenid         string
	AgentVersion    string
	ProtoVersion    string
	Epoch           uint64
	// Capabilities are the ones reported by the agent in Control/Info. They
	// are unknown (CapabilitiesKnown false, Capabilities nil; NULL in the
	// table) from an admission until Info, unless the same agent process
	// and version reconnected.
	Capabilities      []string
	CapabilitiesKnown bool
	State             string
	ConnectedAt     time.Time
	DisconnectedAt  *time.Time
}

const sessionColumns = `machine_id::text, instance_id, epoch, conn_id, agent_instance_id, boot_id, vmgenid,
	agent_version, proto_version, capabilities, state, connected_at, disconnected_at`

func scanSession(row pgx.Row) (Session, error) {
	var (
		s     Session
		epoch int64
		caps  *[]string
	)
	err := row.Scan(&s.MachineID, &s.InstanceID, &epoch, &s.ConnID, &s.AgentInstanceID, &s.BootID, &s.Vmgenid,
		&s.AgentVersion, &s.ProtoVersion, &caps, &s.State, &s.ConnectedAt, &s.DisconnectedAt)
	s.Epoch = uint64(epoch) //nolint:gosec // epoch starts at 1 and only grows
	if caps != nil {
		s.Capabilities, s.CapabilitiesKnown = *caps, true
		if s.Capabilities == nil {
			s.Capabilities = []string{}
		}
	}
	return s, err
}

func isInvalidText(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == pgInvalidText
}

// AdmitParams describes a connection that asks to be admitted.
type AdmitParams struct {
	MachineID       string
	InstanceID      string
	ConnID          string
	AgentInstanceID string
	BootID          string
	Vmgenid         string
	AgentVersion    string
	ProtoVersion    string
	Scheme          transport.AuthScheme
	// SecretHash is the SHA-256 of the presented secret (BS or MT).
	SecretHash []byte
}

// AdmitResult is the outcome of a successful Admit.
type AdmitResult struct {
	// Epoch is the new connection epoch of the machine.
	Epoch uint64
	// Prev is the session row before this admission, nil on the first connect.
	Prev *Session
	// MTIssuedAt is when the current machine token was issued, nil if none yet.
	MTIssuedAt *time.Time
}

// Admit checks the credentials and records the new session with epoch+1 in
// one transaction. The credentials row is locked, which serializes admissions
// of the same machine. Subscribers are notified through the table trigger at
// commit.
func (s *Store) Admit(ctx context.Context, p AdmitParams) (AdmitResult, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AdmitResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		bsHash, mtHash, mtNext []byte
		mtIssued, retired      *time.Time
	)
	err = tx.QueryRow(ctx, `SELECT bs_hash, mt_hash, mt_next_hash, mt_issued_at, retired_at
		FROM tunnel.tunnel_credentials WHERE machine_id = $1 FOR UPDATE`, p.MachineID).
		Scan(&bsHash, &mtHash, &mtNext, &mtIssued, &retired)
	switch {
	case errors.Is(err, pgx.ErrNoRows), isInvalidText(err):
		return AdmitResult{}, ErrUnauthorized
	case err != nil:
		return AdmitResult{}, err
	}
	if retired != nil {
		return AdmitResult{}, ErrRetired
	}

	switch p.Scheme {
	case transport.AuthBootstrap:
		if !equalHash(p.SecretHash, bsHash) {
			return AdmitResult{}, ErrUnauthorized
		}
	case transport.AuthToken:
		// Evaluate both comparisons before branching to keep the timing flat.
		matchCurrent := equalHash(p.SecretHash, mtHash)
		matchNext := equalHash(p.SecretHash, mtNext)
		switch {
		case matchNext:
			// Connecting with the next token completes the rotation.
			err = tx.QueryRow(ctx, `UPDATE tunnel.tunnel_credentials
				SET mt_hash = mt_next_hash, mt_next_hash = NULL, mt_issued_at = now()
				WHERE machine_id = $1 RETURNING mt_issued_at`, p.MachineID).Scan(&mtIssued)
			if err != nil {
				return AdmitResult{}, err
			}
		case matchCurrent:
		default:
			return AdmitResult{}, ErrUnauthorized
		}
	default:
		return AdmitResult{}, fmt.Errorf("registry: unknown auth scheme %d", p.Scheme)
	}

	var prev *Session
	ps, err := scanSession(tx.QueryRow(ctx,
		`SELECT `+sessionColumns+` FROM tunnel.tunnel_sessions WHERE machine_id = $1 FOR UPDATE`, p.MachineID))
	switch {
	case err == nil:
		prev = &ps
	case errors.Is(err, pgx.ErrNoRows):
	default:
		return AdmitResult{}, err
	}
	var epoch uint64 = 1
	if prev != nil {
		epoch = prev.Epoch + 1
	}

	_, err = tx.Exec(ctx, `INSERT INTO tunnel.tunnel_sessions
		(machine_id, instance_id, epoch, conn_id, agent_instance_id, boot_id, vmgenid,
		 agent_version, proto_version, capabilities, state, connected_at, disconnected_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, 'connected', now(), NULL)
		ON CONFLICT (machine_id) DO UPDATE SET
		 instance_id = EXCLUDED.instance_id, epoch = EXCLUDED.epoch, conn_id = EXCLUDED.conn_id,
		 agent_instance_id = EXCLUDED.agent_instance_id, boot_id = EXCLUDED.boot_id,
		 vmgenid = EXCLUDED.vmgenid, agent_version = EXCLUDED.agent_version,
		 proto_version = EXCLUDED.proto_version,
		 capabilities = CASE WHEN tunnel_sessions.agent_instance_id = EXCLUDED.agent_instance_id
		   AND tunnel_sessions.agent_version = EXCLUDED.agent_version
		   THEN tunnel_sessions.capabilities END,
		 state = 'connected', connected_at = now(), disconnected_at = NULL`,
		p.MachineID, p.InstanceID, int64(epoch), p.ConnID, p.AgentInstanceID, p.BootID, p.Vmgenid, //nolint:gosec // bounded by int64 epoch column
		p.AgentVersion, p.ProtoVersion)
	if err != nil {
		return AdmitResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AdmitResult{}, err
	}
	return AdmitResult{Epoch: epoch, Prev: prev, MTIssuedAt: mtIssued}, nil
}

// equalHash compares two hashes in constant time. A missing hash never matches.
func equalHash(a, b []byte) bool {
	if len(a) == 0 || len(b) == 0 {
		return false
	}
	return subtle.ConstantTimeCompare(a, b) == 1
}

// UpdateSessionInfo stores the capabilities reported by the agent (nil is
// stored as a known empty list). It reports
// false when the session is no longer the connected one with this epoch.
func (s *Store) UpdateSessionInfo(ctx context.Context, machineID string, epoch uint64, capabilities []string) (bool, error) {
	if capabilities == nil {
		capabilities = []string{}
	}
	tag, err := s.pool.Exec(ctx, `UPDATE tunnel.tunnel_sessions SET capabilities = $3
		WHERE machine_id = $1 AND epoch = $2 AND state = 'connected'`,
		machineID, int64(epoch), capabilities) //nolint:gosec // bounded by int64 epoch column
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// Disconnect marks the session disconnected if it still belongs to instanceID
// at epoch (fencing). It reports whether a row was changed.
func (s *Store) Disconnect(ctx context.Context, machineID, instanceID string, epoch uint64) (bool, error) {
	tag, err := s.pool.Exec(ctx, `UPDATE tunnel.tunnel_sessions
		SET state = 'disconnected', disconnected_at = now()
		WHERE machine_id = $1 AND instance_id = $2 AND epoch = $3 AND state = 'connected'`,
		machineID, instanceID, int64(epoch)) //nolint:gosec // bounded by int64 epoch column
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// Session returns the session row of a machine, or ErrNotFound.
func (s *Store) Session(ctx context.Context, machineID string) (Session, error) {
	sess, err := scanSession(s.pool.QueryRow(ctx,
		`SELECT `+sessionColumns+` FROM tunnel.tunnel_sessions WHERE machine_id = $1`, machineID))
	if errors.Is(err, pgx.ErrNoRows) || isInvalidText(err) {
		return Session{}, ErrNotFound
	}
	return sess, err
}

// Owner is the gateway instance that holds the live tunnel of a machine.
type Owner struct {
	InstanceID  string
	InternalURL string
	Epoch       uint64
}

// Owner returns the instance owning the connected session of a machine. An
// instance whose heartbeat is older than staleAfter is not an owner.
func (s *Store) Owner(ctx context.Context, machineID string, staleAfter time.Duration) (Owner, bool, error) {
	var (
		o     Owner
		epoch int64
	)
	err := s.pool.QueryRow(ctx, `SELECT s.instance_id, i.internal_url, s.epoch
		FROM tunnel.tunnel_sessions s JOIN tunnel.gateway_instances i ON i.id = s.instance_id
		WHERE s.machine_id = $1 AND s.state = 'connected'
		  AND i.heartbeat_at > now() - $2::float8 * interval '1 second'`,
		machineID, staleAfter.Seconds()).Scan(&o.InstanceID, &o.InternalURL, &epoch)
	if errors.Is(err, pgx.ErrNoRows) || isInvalidText(err) {
		return Owner{}, false, nil
	}
	if err != nil {
		return Owner{}, false, err
	}
	o.Epoch = uint64(epoch) //nolint:gosec // epoch starts at 1 and only grows
	return o, true, nil
}

// Retired reports whether the machine was retired. An unknown machine is not retired.
func (s *Store) Retired(ctx context.Context, machineID string) (bool, error) {
	var retired bool
	err := s.pool.QueryRow(ctx,
		`SELECT retired_at IS NOT NULL FROM tunnel.tunnel_credentials WHERE machine_id = $1`, machineID).Scan(&retired)
	if errors.Is(err, pgx.ErrNoRows) || isInvalidText(err) {
		return false, nil
	}
	return retired, err
}

// BeginRotation stores the hash of the next machine token. Both the current
// and the next token are accepted until the rotation completes.
func (s *Store) BeginRotation(ctx context.Context, machineID string, nextHash []byte) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE tunnel.tunnel_credentials SET mt_next_hash = $2 WHERE machine_id = $1`, machineID, nextHash)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// CompleteRotation makes nextHash the current token hash. It reports false
// when nextHash is not pending any more, for example because the agent
// already connected with it and Admit promoted it.
func (s *Store) CompleteRotation(ctx context.Context, machineID string, nextHash []byte) (bool, error) {
	tag, err := s.pool.Exec(ctx, `UPDATE tunnel.tunnel_credentials
		SET mt_hash = mt_next_hash, mt_next_hash = NULL, mt_issued_at = now()
		WHERE machine_id = $1 AND mt_next_hash = $2`, machineID, nextHash)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// RegisterInstance inserts a gateway instance as active, or revives an
// existing row with the same id (for example after a sweep).
func (s *Store) RegisterInstance(ctx context.Context, id, internalURL string) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO tunnel.gateway_instances
		(id, internal_url, state, started_at, heartbeat_at, drain_started_at)
		VALUES ($1, $2, 'active', now(), now(), NULL)
		ON CONFLICT (id) DO UPDATE SET internal_url = EXCLUDED.internal_url, state = 'active',
		 started_at = now(), heartbeat_at = now(), drain_started_at = NULL`, id, internalURL)
	return err
}

// Heartbeat refreshes heartbeat_at. It returns ErrNotFound when the instance
// row is gone (swept), so the caller can register again.
func (s *Store) Heartbeat(ctx context.Context, id string) error {
	tag, err := s.pool.Exec(ctx, `UPDATE tunnel.gateway_instances SET heartbeat_at = now() WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// SetInstanceState sets the instance state to InstanceActive or
// InstanceDraining. Draining also sets drain_started_at, once.
func (s *Store) SetInstanceState(ctx context.Context, id, state string) error {
	if state != InstanceActive && state != InstanceDraining {
		return fmt.Errorf("registry: invalid instance state %q", state)
	}
	tag, err := s.pool.Exec(ctx, `UPDATE tunnel.gateway_instances
		SET state = $2::text,
		    drain_started_at = CASE WHEN $2::text = 'draining' THEN coalesce(drain_started_at, now()) ELSE drain_started_at END
		WHERE id = $1`, id, state)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// Instance is a row of tunnel.gateway_instances.
type Instance struct {
	ID             string
	InternalURL    string
	State          string
	StartedAt      time.Time
	HeartbeatAt    time.Time
	DrainStartedAt *time.Time
}

// Instance returns a gateway instance, or ErrNotFound.
func (s *Store) Instance(ctx context.Context, id string) (Instance, error) {
	var i Instance
	err := s.pool.QueryRow(ctx, `SELECT id, internal_url, state, started_at, heartbeat_at, drain_started_at
		FROM tunnel.gateway_instances WHERE id = $1`, id).
		Scan(&i.ID, &i.InternalURL, &i.State, &i.StartedAt, &i.HeartbeatAt, &i.DrainStartedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Instance{}, ErrNotFound
	}
	return i, err
}

// DeleteInstance removes a gateway instance row. Deleting a missing row is not an error.
func (s *Store) DeleteInstance(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM tunnel.gateway_instances WHERE id = $1`, id)
	return err
}

// Swept describes a session moved to disconnected by SweepStale.
type Swept struct {
	MachineID string
	// InstanceID is the dead gateway instance.
	InstanceID      string
	AgentInstanceID string
	Epoch           uint64
	// DisconnectedAt is the last heartbeat of the dead instance.
	DisconnectedAt time.Time
}

// SweepStale finds instances (other than self) whose heartbeat is older than
// staleAfter, marks their connected sessions disconnected at the instance's
// last heartbeat and deletes the instances. Concurrent sweepers take disjoint
// instances (FOR UPDATE SKIP LOCKED).
func (s *Store) SweepStale(ctx context.Context, self string, staleAfter time.Duration) ([]Swept, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	type stale struct {
		id        string
		heartbeat time.Time
	}
	rows, err := tx.Query(ctx, `SELECT id, heartbeat_at FROM tunnel.gateway_instances
		WHERE id <> $1 AND heartbeat_at < now() - $2::float8 * interval '1 second'
		ORDER BY id FOR UPDATE SKIP LOCKED`, self, staleAfter.Seconds())
	if err != nil {
		return nil, err
	}
	instances, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (stale, error) {
		var st stale
		return st, r.Scan(&st.id, &st.heartbeat)
	})
	if err != nil {
		return nil, err
	}

	var swept []Swept
	for _, inst := range instances {
		rows, err := tx.Query(ctx, `UPDATE tunnel.tunnel_sessions
			SET state = 'disconnected', disconnected_at = $2
			WHERE instance_id = $1 AND state = 'connected'
			RETURNING machine_id::text, epoch, agent_instance_id`, inst.id, inst.heartbeat)
		if err != nil {
			return nil, err
		}
		part, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (Swept, error) {
			var (
				sw    = Swept{InstanceID: inst.id, DisconnectedAt: inst.heartbeat}
				epoch int64
			)
			err := r.Scan(&sw.MachineID, &epoch, &sw.AgentInstanceID)
			sw.Epoch = uint64(epoch) //nolint:gosec // epoch starts at 1 and only grows
			return sw, err
		})
		if err != nil {
			return nil, err
		}
		swept = append(swept, part...)
		if _, err := tx.Exec(ctx, `DELETE FROM tunnel.gateway_instances WHERE id = $1`, inst.id); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return swept, nil
}

// PutCredentials stores the bootstrap secret hash of a machine. The worker
// (S6) owns this write; it is exported for tests and as an SQL reference.
func (s *Store) PutCredentials(ctx context.Context, machineID string, bsHash []byte) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO tunnel.tunnel_credentials (machine_id, bs_hash) VALUES ($1, $2)
		ON CONFLICT (machine_id) DO UPDATE SET bs_hash = EXCLUDED.bs_hash`, machineID, bsHash)
	return err
}

// Retire marks the machine's credentials retired. The worker (S6) owns this
// write; it is exported for tests and as an SQL reference.
func (s *Store) Retire(ctx context.Context, machineID string) error {
	tag, err := s.pool.Exec(ctx, `UPDATE tunnel.tunnel_credentials
		SET retired_at = coalesce(retired_at, now()) WHERE machine_id = $1`, machineID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
