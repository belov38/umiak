// Package claim binds the machine to a sandbox (spec section 8): hostname,
// the non-secret env for PAM, secrets in the tmpfs, the SSH user CA keys and
// the claim record in state.db. It also builds the environment of commands
// and watches the docker readiness phase.
//
// Secret values never reach the disk outside the tmpfs: the stored claim
// keeps only secret names, and SecretsDigest is a sha256 of the canonical
// secret set. Values are never logged.
package claim

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/errs"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/events"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/ext"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/fsutil"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/ident"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/paths"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/process"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/readiness"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/store"
)

// DefaultDurableTimeout bounds a state.db write made for an RPC.
const DefaultDurableTimeout = 30 * time.Second

// Options configures a Manager.
type Options struct {
	// Store holds the claim record.
	Store *store.Store
	// Layout locates the env files, the secrets tmpfs and the SSH CA files.
	Layout paths.Layout
	// Ready receives the claim and secrets phases and gates Claim on the
	// identity phase.
	Ready *readiness.Tracker
	// Emit receives claim.applied. Default: discard.
	Emit events.Emitter
	// Hostname sets the hostname from the claim (see HostnameWriter). Nil
	// skips the step.
	Hostname func(string) error
	// DefaultUser owns the secrets group and new link_path parents.
	DefaultUser string
	// Extensions add platform env and run after a claim.
	Extensions []ext.Extension
	// ReloadSSH, if set, runs after the SSH CA file changed. sshd reads
	// TrustedUserCAKeys on each authentication, so it is normally nil.
	ReloadSSH func(ctx context.Context) error
	// MountSecrets mounts the secrets tmpfs at the given directory unless it
	// is mounted already. Default: the platform mount (Linux only); tests
	// pass a function that creates a plain directory.
	MountSecrets func(dir string) error
	// LookupUser resolves DefaultUser. Default process.LookupUser.
	LookupUser func(name string) (*process.User, error)
	// Now is the clock. Default time.Now.
	Now func() time.Time
	// DurableTimeout bounds a state.db write. Default DefaultDurableTimeout.
	DurableTimeout time.Duration
	// Log receives warnings. Default slog.Default().
	Log *slog.Logger
}

// Manager applies the claim and its updates. Its methods are safe for
// concurrent use; mutating calls are serialized.
type Manager struct {
	opts  Options
	l     paths.Layout
	ready *readiness.Tracker
	log   *slog.Logger

	opMu sync.Mutex // serializes Start, Claim, the updates and PrepareStop

	mu        sync.RWMutex
	user      *process.User         // DefaultUser; nil if unknown
	rec       *store.Claim          // stored claim; nil before claim
	req       *agentv1.ClaimRequest // rec.Request decoded: secret values stripped
	secretEnv map[string]string     // applied secret env; nil if not in the tmpfs
}

// New returns a Manager. Call Start before any other method.
func New(opts Options) (*Manager, error) {
	switch {
	case opts.Store == nil:
		return nil, errors.New("claim: Options.Store is required")
	case opts.Ready == nil:
		return nil, errors.New("claim: Options.Ready is required")
	}
	if opts.Emit == nil {
		opts.Emit = discard{}
	}
	if opts.MountSecrets == nil {
		opts.MountSecrets = mountSecrets
	}
	if opts.LookupUser == nil {
		opts.LookupUser = process.LookupUser
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.DurableTimeout <= 0 {
		opts.DurableTimeout = DefaultDurableTimeout
	}
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	return &Manager{opts: opts, l: opts.Layout, ready: opts.Ready, log: opts.Log}, nil
}

// Start prepares the run-time files at boot: it mounts the secrets tmpfs,
// creates secrets/ (0750 root:<user group>), files/ and cmd-spec/ (0700),
// creates empty secrets/env and /etc/sbx/env if missing, loads the stored
// claim and sets the claim and secrets phases. The secrets phase is ready
// without a claim, with an empty secret set, or when the tmpfs content
// matches the stored digest; otherwise it is pending until UpdateSecrets.
func (m *Manager) Start(ctx context.Context) error {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := m.opts.MountSecrets(m.l.SecretsMount); err != nil {
		return fmt.Errorf("claim: mount secrets tmpfs: %w", err)
	}
	u, err := m.opts.LookupUser(m.opts.DefaultUser)
	if err != nil {
		m.log.Warn("default user not found, secrets stay root-only", "user", m.opts.DefaultUser, "err", err)
		u = nil
	}
	m.mu.Lock()
	m.user = u
	m.mu.Unlock()
	if err := m.prepareDirs(); err != nil {
		return err
	}
	for _, e := range m.opts.Extensions {
		m.ready.Register(e.Phases()...)
	}

	rec, ok, err := m.opts.Store.GetClaim()
	if err != nil {
		return fmt.Errorf("claim: read claim: %w", err)
	}
	if !ok {
		m.ready.Set(readiness.PhaseSecrets, agentv1.PhaseState_PHASE_STATE_READY, "")
		return nil
	}
	req, err := decodeRequest(rec.Request)
	if err != nil {
		return fmt.Errorf("claim: decode stored claim: %w", err)
	}
	var secretEnv map[string]string
	secretsReady := rec.SecretsDigest == ""
	if !secretsReady {
		if env, files, err := m.loadSecrets(); err == nil && SecretsDigest(env, files) == rec.SecretsDigest {
			secretEnv, secretsReady = env, true
		}
	}
	m.mu.Lock()
	m.rec, m.req, m.secretEnv = rec, req, secretEnv
	m.mu.Unlock()
	m.ready.Set(readiness.PhaseClaim, agentv1.PhaseState_PHASE_STATE_READY, "")
	if secretsReady {
		m.ready.Set(readiness.PhaseSecrets, agentv1.PhaseState_PHASE_STATE_READY, "")
	} else {
		m.ready.Set(readiness.PhaseSecrets, agentv1.PhaseState_PHASE_STATE_PENDING, "")
	}
	return nil
}

// prepareDirs creates the tmpfs directories and the always-present env
// files.
func (m *Manager) prepareDirs() error {
	for _, d := range []struct {
		path  string
		mode  fs.FileMode
		group bool
	}{
		{m.l.SecretsDir, 0o750, true},
		{m.l.SecretFilesDir, 0o750, true},
		{m.l.CmdSpecDir, 0o700, false},
	} {
		if err := os.MkdirAll(d.path, d.mode); err != nil {
			return fmt.Errorf("claim: %w", err)
		}
		if err := os.Chmod(d.path, d.mode); err != nil {
			return fmt.Errorf("claim: %w", err)
		}
		if d.group {
			if err := m.chownGroup(d.path); err != nil {
				return err
			}
		}
	}
	if _, err := os.Lstat(m.l.SecretsEnvFile); errors.Is(err, fs.ErrNotExist) {
		if err := m.writeGroupFile(m.l.SecretsEnvFile, nil, 0o440); err != nil {
			return err
		}
	}
	if err := os.MkdirAll(filepath.Dir(m.l.SbxEnvFile), 0o755); err != nil {
		return fmt.Errorf("claim: %w", err)
	}
	if _, err := os.Lstat(m.l.SbxEnvFile); errors.Is(err, fs.ErrNotExist) {
		if err := fsutil.WriteFileAtomic(m.l.SbxEnvFile, nil, 0o644); err != nil {
			return fmt.Errorf("claim: create sbx env: %w", err)
		}
	}
	return nil
}

// Claim applies a claim once per machine identity (spec 8.1, Decision 3).
// The same request again returns the stored response. A RESUME or RECOVER
// request for the claimed sandbox applies env, secrets and SSH CA keys as
// updates. Any other request after a claim fails with already_claimed.
func (m *Manager) Claim(ctx context.Context, req *agentv1.ClaimRequest) (*agentv1.ClaimResponse, error) {
	if st, _ := m.ready.State(readiness.PhaseIdentity); st != agentv1.PhaseState_PHASE_STATE_READY {
		return nil, errs.New(connect.CodeUnavailable, errs.IdentityNotReady, "machine identity is not ready")
	}
	if err := validateClaim(req); err != nil {
		return nil, err
	}
	hash := requestHash(req)

	m.opMu.Lock()
	defer m.opMu.Unlock()
	m.mu.RLock()
	cur := m.rec
	m.mu.RUnlock()

	if cur != nil {
		reapply := req.GetReason() == agentv1.ClaimReason_CLAIM_REASON_RESUME ||
			req.GetReason() == agentv1.ClaimReason_CLAIM_REASON_RECOVER
		switch {
		case cur.RequestHash == hash:
			return m.storedResponse(cur), nil
		case reapply && req.GetSandboxId() == cur.SandboxID:
			files := normalizeFiles(req.GetSecretFiles())
			err := m.applyLocked(ctx, update{
				env:         req.GetEnv(),
				setEnv:      true,
				secrets:     &secretSet{env: req.GetSecretEnv(), files: files},
				ca:          req.GetSshUserCaKeys(),
				setCA:       true,
				authKeys:    req.GetAuthorizedKeys(),
				setAuthKeys: true,
			})
			if err != nil {
				return nil, err
			}
			m.afterClaim(ctx, false)
			phases, ready := m.ready.Snapshot()
			return &agentv1.ClaimResponse{Readiness: phases, Ready: ready}, nil
		default:
			return nil, errs.Newf(connect.CodeFailedPrecondition, errs.AlreadyClaimed,
				"machine is already claimed by sandbox %q", cur.SandboxID)
		}
	}

	files := normalizeFiles(req.GetSecretFiles())
	if m.opts.Hostname != nil {
		if err := m.opts.Hostname(req.GetHostname()); err != nil {
			return nil, internal("set hostname", err)
		}
	}
	if err := m.writeSbxEnv(req.GetSandboxId(), req.GetPortDomain(), req.GetEnv()); err != nil {
		return nil, err
	}
	stripped := strip(req)
	rec := &store.Claim{
		RequestHash:   hash,
		SecretsDigest: SecretsDigest(req.GetSecretEnv(), files),
		SandboxID:     req.GetSandboxId(),
		ClaimedAt:     m.opts.Now().UTC(),
	}
	if err := m.claimSecretsAndRecord(ctx, req, files, stripped, rec); err != nil {
		// Leave no secrets of a failed first claim behind; the machine is
		// still unclaimed, so its secret set is empty.
		if werr := m.wipeSecrets(); werr != nil {
			m.log.Warn("wipe secrets of a failed claim failed", "err", werr)
		}
		m.resyncSecrets("")
		return nil, err
	}
	m.mu.Lock()
	m.rec, m.req, m.secretEnv = rec, stripped, maps.Clone(req.GetSecretEnv())
	m.mu.Unlock()
	m.ready.Set(readiness.PhaseClaim, agentv1.PhaseState_PHASE_STATE_READY, "")
	m.ready.Set(readiness.PhaseSecrets, agentv1.PhaseState_PHASE_STATE_READY, "")
	m.opts.Emit.Emit(events.TypeClaimApplied, &agentv1.ClaimApplied{SandboxId: req.GetSandboxId()})
	m.log.Info("claim applied", "sandbox_id", req.GetSandboxId())

	phases, ready := m.ready.Snapshot()
	resp := &agentv1.ClaimResponse{Readiness: phases, Ready: ready}
	// Keep the response for replays. The claim itself is durable already; a
	// failure here only makes a replay answer with the current readiness.
	if b, err := proto.Marshal(resp); err == nil {
		withResp := *rec
		withResp.Response = b
		if err := m.putClaim(ctx, &withResp); err != nil {
			m.log.Warn("store claim response failed", "err", err)
		} else {
			m.mu.Lock()
			m.rec = &withResp
			m.mu.Unlock()
		}
	}
	m.afterClaim(ctx, true)
	return resp, nil
}

// claimSecretsAndRecord runs the claim steps from the secrets on: secrets,
// SSH CA keys, then the claim record (rec.Request is filled in here).
func (m *Manager) claimSecretsAndRecord(ctx context.Context, req *agentv1.ClaimRequest, files []*agentv1.SecretFile, stripped *agentv1.ClaimRequest, rec *store.Claim) error {
	if err := m.writeSecrets(req.GetSecretEnv(), files); err != nil {
		return err
	}
	if err := m.writeCA(ctx, req.GetSshUserCaKeys()); err != nil {
		return err
	}
	body, err := encodeRequest(stripped)
	if err != nil {
		return internal("encode claim", err)
	}
	rec.Request = body
	return m.putClaim(ctx, rec)
}

// storedResponse decodes the response kept with the claim, or reports the
// current readiness if there is none.
func (m *Manager) storedResponse(rec *store.Claim) *agentv1.ClaimResponse {
	if len(rec.Response) > 0 {
		var resp agentv1.ClaimResponse
		if err := proto.Unmarshal(rec.Response, &resp); err == nil {
			return &resp
		}
	}
	phases, ready := m.ready.Snapshot()
	return &agentv1.ClaimResponse{Readiness: phases, Ready: ready}
}

// UpdateEnv replaces the claim env (spec 8.1). New commands see it; running
// ones do not.
func (m *Manager) UpdateEnv(ctx context.Context, req *agentv1.UpdateEnvRequest) (*agentv1.UpdateEnvResponse, error) {
	if err := validateEnv("env", req.GetEnv()); err != nil {
		return nil, err
	}
	m.opMu.Lock()
	defer m.opMu.Unlock()
	if err := m.applyLocked(ctx, update{env: req.GetEnv(), setEnv: true}); err != nil {
		return nil, err
	}
	phases, ready := m.ready.Snapshot()
	return &agentv1.UpdateEnvResponse{Readiness: phases, Ready: ready}, nil
}

// UpdateSecrets replaces the secret env and files (spec 8.1). The control
// plane calls it after every boot; afterwards the secrets phase is ready.
func (m *Manager) UpdateSecrets(ctx context.Context, req *agentv1.UpdateSecretsRequest) (*agentv1.UpdateSecretsResponse, error) {
	if err := validateSecrets(req.GetSecretEnv(), req.GetSecretFiles()); err != nil {
		return nil, err
	}
	m.opMu.Lock()
	defer m.opMu.Unlock()
	set := &secretSet{env: req.GetSecretEnv(), files: normalizeFiles(req.GetSecretFiles())}
	if err := m.applyLocked(ctx, update{secrets: set}); err != nil {
		return nil, err
	}
	phases, ready := m.ready.Snapshot()
	return &agentv1.UpdateSecretsResponse{Readiness: phases, Ready: ready}, nil
}

// UpdateSshCa replaces the trusted SSH user CA keys; an empty list restores
// the template keys.
func (m *Manager) UpdateSshCa(ctx context.Context, req *agentv1.UpdateSshCaRequest) (*agentv1.UpdateSshCaResponse, error) { //nolint:revive // named after the System.UpdateSshCa RPC
	if err := validateCAKeys(req.GetKeys()); err != nil {
		return nil, err
	}
	m.opMu.Lock()
	defer m.opMu.Unlock()
	if err := m.applyLocked(ctx, update{ca: req.GetKeys(), setCA: true}); err != nil {
		return nil, err
	}
	return &agentv1.UpdateSshCaResponse{}, nil
}

// PrepareStop wipes the secrets from the tmpfs and flushes state.db before
// the VM stops (Decision 3). The secrets phase becomes pending if the
// applied set was not empty. It is idempotent.
func (m *Manager) PrepareStop(ctx context.Context) error {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	// Secrets go first: wiping them does not depend on the store, which may
	// be frozen or slow.
	wipeErr := m.wipeSecrets()
	m.mu.Lock()
	digest := ""
	if m.rec != nil {
		digest = m.rec.SecretsDigest
	}
	m.secretEnv = nil
	m.mu.Unlock()
	if digest != "" {
		m.ready.Set(readiness.PhaseSecrets, agentv1.PhaseState_PHASE_STATE_PENDING, "")
	}
	dctx, cancel := m.durableCtx(ctx)
	defer cancel()
	flushErr := m.opts.Store.Flush(dctx)
	if wipeErr != nil {
		return wipeErr
	}
	if flushErr != nil {
		return storeError(flushErr)
	}
	return nil
}

// ClaimInfo returns the stored claim without secret values, or nil before
// the claim.
func (m *Manager) ClaimInfo() *agentv1.ClaimInfo {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.req == nil {
		return nil
	}
	r := m.req
	keys := slices.Sorted(maps.Keys(r.GetSecretEnv()))
	names := make([]string, 0, len(r.GetSecretFiles()))
	for _, f := range r.GetSecretFiles() {
		names = append(names, f.GetName())
	}
	slices.Sort(names)
	return &agentv1.ClaimInfo{
		SandboxId:       r.GetSandboxId(),
		Hostname:        r.GetHostname(),
		PortDomain:      r.GetPortDomain(),
		Env:             maps.Clone(r.GetEnv()),
		SecretEnvKeys:   keys,
		SecretFileNames: names,
		SshUserCaKeys:   slices.Clone(r.GetSshUserCaKeys()),
		ClaimedAt:       timestamppb.New(m.rec.ClaimedAt),
	}
}

// SandboxID returns the claimed sandbox id, or "" before the claim.
func (m *Manager) SandboxID() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.rec == nil {
		return ""
	}
	return m.rec.SandboxID
}

// secretSet is a full replacement of the secrets.
type secretSet struct {
	env   map[string]string
	files []*agentv1.SecretFile // normalized
}

// update is a set of replacements applied to a claimed machine.
type update struct {
	env     map[string]string
	setEnv  bool
	secrets *secretSet
	ca      []string
	setCA   bool
	// authKeys replaces the stored authorized_keys (RESUME/RECOVER).
	authKeys    []string
	setAuthKeys bool
}

// applyLocked applies u to the claimed machine: files first, then one
// state.db write, then memory and phases. The caller holds opMu. If a
// secrets update fails, the secrets phase and the env cache are recomputed
// from what the tmpfs holds now.
func (m *Manager) applyLocked(ctx context.Context, u update) error {
	m.mu.RLock()
	cur, curReq := m.rec, m.req
	m.mu.RUnlock()
	if cur == nil {
		return errs.New(connect.CodeFailedPrecondition, errs.NotClaimed, "machine is not claimed")
	}
	next := proto.CloneOf(curReq)
	rec := *cur
	if err := m.applyFiles(ctx, u, next, &rec); err != nil {
		if u.secrets != nil {
			m.resyncSecrets(cur.SecretsDigest)
		}
		return err
	}
	m.mu.Lock()
	m.rec, m.req = &rec, next
	if u.secrets != nil {
		m.secretEnv = maps.Clone(u.secrets.env)
	}
	m.mu.Unlock()
	if u.secrets != nil {
		m.ready.Set(readiness.PhaseSecrets, agentv1.PhaseState_PHASE_STATE_READY, "")
	}
	return nil
}

// applyFiles writes the files of u, updates next and rec to match and
// stores rec.
func (m *Manager) applyFiles(ctx context.Context, u update, next *agentv1.ClaimRequest, rec *store.Claim) error {
	if u.setEnv {
		if err := m.writeSbxEnv(next.GetSandboxId(), next.GetPortDomain(), u.env); err != nil {
			return err
		}
		next.Env = maps.Clone(u.env)
	}
	if u.secrets != nil {
		if err := m.writeSecrets(u.secrets.env, u.secrets.files); err != nil {
			return err
		}
		s := strip(&agentv1.ClaimRequest{SecretEnv: u.secrets.env, SecretFiles: u.secrets.files})
		next.SecretEnv, next.SecretFiles = s.GetSecretEnv(), s.GetSecretFiles()
		rec.SecretsDigest = SecretsDigest(u.secrets.env, u.secrets.files)
	}
	if u.setCA {
		if err := m.writeCA(ctx, u.ca); err != nil {
			return err
		}
		next.SshUserCaKeys = slices.Clone(u.ca)
	}
	if u.setAuthKeys {
		next.AuthorizedKeys = slices.Clone(u.authKeys)
	}
	body, err := encodeRequest(next)
	if err != nil {
		return internal("encode claim", err)
	}
	rec.Request = body
	return m.putClaim(ctx, rec)
}

// resyncSecrets makes the secrets phase and the env cache match the tmpfs
// after a failed write: ready with the env loaded if the tmpfs holds the
// set with digest want, pending without env otherwise.
func (m *Manager) resyncSecrets(want string) {
	var env map[string]string
	ok := false
	if _, err := os.Lstat(m.l.SecretsStateFile); errors.Is(err, fs.ErrNotExist) {
		ok = want == ""
	} else if e, files, err := m.loadSecrets(); err == nil && SecretsDigest(e, files) == want {
		env, ok = e, true
	}
	m.mu.Lock()
	m.secretEnv = env
	m.mu.Unlock()
	if ok {
		m.ready.Set(readiness.PhaseSecrets, agentv1.PhaseState_PHASE_STATE_READY, "")
	} else {
		m.ready.Set(readiness.PhaseSecrets, agentv1.PhaseState_PHASE_STATE_PENDING, "")
	}
}

// afterClaim runs the extensions' post-claim work; failures are logged.
func (m *Manager) afterClaim(ctx context.Context, first bool) {
	for _, e := range m.opts.Extensions {
		if err := e.AfterClaim(ctx, first); err != nil {
			m.log.Warn("extension after-claim failed", "extension", e.Name(), "err", err)
		}
	}
}

// writeCA writes the effective SSH user CA keys: the given keys, or the
// template keys for an empty list.
func (m *Manager) writeCA(ctx context.Context, keys []string) error {
	var data []byte
	if len(keys) == 0 {
		b, err := os.ReadFile(m.l.TemplateSSHCA)
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return internal("read template ssh ca", err)
		}
		data = b
	} else {
		var sb strings.Builder
		for _, k := range keys {
			sb.WriteString(strings.TrimSpace(k))
			sb.WriteByte('\n')
		}
		data = []byte(sb.String())
	}
	if err := os.MkdirAll(filepath.Dir(m.l.SSHUserCA), 0o755); err != nil {
		return internal("write ssh ca", err)
	}
	if err := fsutil.WriteFileAtomic(m.l.SSHUserCA, data, 0o644); err != nil {
		return internal("write ssh ca", err)
	}
	if m.opts.ReloadSSH != nil {
		if err := m.opts.ReloadSSH(ctx); err != nil {
			m.log.Warn("reload ssh after CA change failed", "err", err)
		}
	}
	return nil
}

// putClaim durably writes the claim record.
func (m *Manager) putClaim(ctx context.Context, rec *store.Claim) error {
	dctx, cancel := m.durableCtx(ctx)
	defer cancel()
	if err := m.opts.Store.PutClaim(dctx, rec); err != nil {
		return storeError(err)
	}
	return nil
}

// durableCtx bounds a durable write by DurableTimeout and leaves part of
// the caller's deadline for the response.
func (m *Manager) durableCtx(ctx context.Context) (context.Context, context.CancelFunc) {
	timeout := m.opts.DurableTimeout
	if dl, ok := ctx.Deadline(); ok {
		budget := time.Until(dl)
		timeout = min(timeout, budget-min(budget/10, time.Second))
	}
	return context.WithTimeout(ctx, timeout)
}

// HostnameWriter returns the Options.Hostname function of the agent: it
// calls set (the kernel hostname, for example LinuxResetter.SetHostname),
// then writes /etc/hostname and the managed 127.0.1.1 block of /etc/hosts.
func HostnameWriter(l paths.Layout, set func(string) error) func(string) error {
	return func(name string) error {
		if err := set(name); err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(l.HostnameFile), 0o755); err != nil {
			return err
		}
		if err := fsutil.WriteFileAtomic(l.HostnameFile, []byte(name+"\n"), 0o644); err != nil {
			return fmt.Errorf("claim: write hostname: %w", err)
		}
		if err := ident.SetHostsBlock(l.HostsFile, name); err != nil {
			return fmt.Errorf("claim: write hosts: %w", err)
		}
		return nil
	}
}

// requestHash identifies the full request content, secrets included, for
// replay detection. Only the hash is stored.
func requestHash(req *agentv1.ClaimRequest) string {
	b, _ := proto.MarshalOptions{Deterministic: true}.Marshal(req)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// strip returns a copy of req without secret values: secret env keys keep
// an empty value, secret files keep name, mode and link_path.
func strip(req *agentv1.ClaimRequest) *agentv1.ClaimRequest {
	out := proto.CloneOf(req)
	env := make(map[string]string, len(out.GetSecretEnv()))
	for k := range out.GetSecretEnv() {
		env[k] = ""
	}
	out.SecretEnv = env
	for _, f := range out.GetSecretFiles() {
		f.Content = nil
	}
	return out
}

func encodeRequest(req *agentv1.ClaimRequest) ([]byte, error) {
	return protojson.Marshal(req)
}

func decodeRequest(b []byte) (*agentv1.ClaimRequest, error) {
	var req agentv1.ClaimRequest
	if len(b) == 0 {
		return &req, nil
	}
	if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(b, &req); err != nil {
		return nil, err
	}
	return &req, nil
}

// storeError maps a failed durable write of an RPC.
func storeError(err error) error {
	switch {
	case errors.Is(err, store.ErrFrozen):
		return errs.New(connect.CodeUnavailable, errs.Quiesced, "the filesystem is quiesced")
	case errors.Is(err, context.DeadlineExceeded):
		return connect.NewError(connect.CodeDeadlineExceeded, err)
	case errors.Is(err, context.Canceled):
		return connect.NewError(connect.CodeCanceled, err)
	default:
		return errs.New(connect.CodeInternal, errs.Internal, err.Error())
	}
}

// internal wraps a local failure; err carries paths, never values.
func internal(what string, err error) error {
	return errs.Newf(connect.CodeInternal, errs.Internal, "%s: %v", what, err)
}

type discard struct{}

func (discard) Emit(string, proto.Message) {}
