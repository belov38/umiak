package agent

import (
	"context"
	"crypto/ed25519"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"

	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/claim"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/events"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/files"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/ident"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/ports"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/process"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/quiesce"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/readiness"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/reqcache"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/store"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/system"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/update"
)

// Reasons of agent.started.
const (
	reasonBoot     = "boot"
	reasonUpdate   = "update"
	reasonRollback = "rollback"
	reasonRestart  = "restart"
)

// metaLastBootID is the meta key holding the boot id of the previous run.
const metaLastBootID = "last_boot_id"

// startupWrite bounds a durable write made during startup.
const startupWrite = 30 * time.Second

// Phase states as reported in status.json.
var (
	phaseReady  = agentv1.PhaseState_PHASE_STATE_READY
	phaseFailed = agentv1.PhaseState_PHASE_STATE_FAILED
)

// startup brings the agent up (spec section 6, S5 17.3). The order:
//
//  1. quiesce Startup: thaw a lease left by the previous process or a
//     foreign freeze, before anything is written to disk;
//  2. identity: read smbios and, on a mismatch with identity.json, apply the
//     new identity (sbx-identity.service did not run). This runs before the
//     store opens because the reset deletes state.db;
//  3. open state.db, set the boot id, report identity.reset as the first
//     event of a new journal, hand the store to quiesce;
//  4. claim Start (mounts the secrets tmpfs, loads the stored claim);
//  5. process Recover, update CheckPending;
//  6. agent.started, the readiness phases, READY=1 — before the tunnel;
//  7. the tunnel client (identity ready only) and the background loops.
func (a *agent) startup(ctx context.Context) error {
	bootID, err := a.d.BootID()
	if err != nil {
		return fmt.Errorf("agent: read boot id: %w", err)
	}
	a.bootID = bootID
	a.instanceID = uuid.NewString()
	a.monoRef = newMonoRef()
	a.tunnel = newTunnelState(a.d.Now)
	a.identity = &identityState{cfgURL: a.cfg.TunnelURL}

	// 1. Quiesce. Docker and Supervisor stay untyped nil when absent.
	qopts := quiesce.Options{
		Layout:     a.l,
		Freezer:    a.d.Freezer,
		Supervisor: a.d.Supervisor,
		Now:        a.d.Now,
		Log:        a.log,
	}
	if a.cfg.DockerEnabled && a.d.Docker != nil {
		qopts.Docker = a.d.Docker
	}
	a.quiesce = quiesce.New(qopts)
	a.quiesce.Startup(ctx)

	for _, dir := range []string{a.l.StateDir, a.l.RunDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("agent: create %s: %w", dir, err)
		}
	}

	// 2. Identity.
	a.applyIdentity(ctx)

	// 3. Store.
	st, err := store.Open(a.l.StateDB, store.Options{
		Now: a.d.Now,
		GapPayload: func(from, to uint64) proto.Message {
			return &agentv1.JournalGap{FromSeq: from, ToSeq: to}
		},
		Log: a.log,
	})
	if err != nil {
		return fmt.Errorf("agent: open state.db: %w", err)
	}
	a.st = st
	st.SetBootID(a.bootID)
	a.emit = events.StoreEmitter(st)
	a.reportIdentityReset(ctx)
	a.quiesce.SetStore(st, a.emit)

	// Readiness events wait until agent.started is journaled, so a run's
	// phase changes follow its agent.started.
	held := &holdEmitter{next: a.emit}
	a.tracker = readiness.New(a.cfg.ReadinessRequired, held, a.d.Now)

	// 4. Claim.
	a.claim, err = claim.New(claim.Options{
		Store:        st,
		Layout:       a.l,
		Ready:        a.tracker,
		Emit:         a.emit,
		Hostname:     claim.HostnameWriter(a.l, a.d.Resetter.SetHostname),
		DefaultUser:  a.cfg.DefaultUser,
		MountSecrets: a.d.MountSecrets,
		LookupUser:   a.d.LookupUser,
		Now:          a.d.Now,
		Log:          a.log,
	})
	if err != nil {
		return err
	}
	if err := a.claim.Start(ctx); err != nil {
		return err
	}
	a.setIdentityPhase()

	// 5. Services, process recovery, pending update.
	if err := a.buildServices(); err != nil {
		return err
	}
	if err := a.proc.Recover(ctx); err != nil {
		return fmt.Errorf("agent: recover commands: %w", err)
	}
	reason := a.startReason()
	if err := a.updater.CheckPending(ctx); err != nil {
		a.log.Warn("agent: check pending update", "err", err)
	}
	if ctx.Err() != nil {
		// CheckPending reverted an expired update and asked to exit.
		return nil
	}

	// 6. agent.started, readiness, READY=1.
	prev, _ := update.LinkVersion(a.l.PreviousLink)
	a.emit.Emit(events.TypeAgentStarted, &agentv1.AgentStarted{
		Version:         a.version,
		PreviousVersion: prev,
		BootId:          a.bootID,
		Reason:          reason,
	})
	wctx, cancel := context.WithTimeout(ctx, startupWrite)
	if err := st.PutMeta(wctx, metaLastBootID, []byte(a.bootID)); err != nil {
		a.log.Warn("agent: record boot id", "err", err)
	}
	cancel()
	held.release()
	a.tracker.Set(readiness.PhaseAgent, phaseReady, "")
	a.log.Info("agent: started", "version", a.version, "reason", reason, "boot_id", a.bootID)

	if a.d.DebugListen != "" {
		if err := a.startDebug(ctx); err != nil {
			return err
		}
	}
	a.writeStatus()
	if err := a.d.SdNotify("READY=1"); err != nil {
		a.log.Warn("agent: sd_notify READY=1", "err", err)
	}

	// 7. Tunnel and background loops.
	if a.identity.ready() {
		a.startTunnel(ctx)
	} else {
		a.goBG(func() { a.retryIdentity(ctx) })
	}
	a.startLoops(ctx)
	return nil
}

// buildServices creates the managers and Connect services that serve the
// tunnel. The request cache interceptors are created once and shared.
func (a *agent) buildServices() error {
	interceptors := reqcache.Interceptors(a.st)
	var err error
	a.proc, err = process.New(process.Options{
		Store:          a.st,
		Supervisor:     a.d.Supervisor,
		Layout:         a.l,
		Config:         a.cfg,
		Emit:           a.emit,
		Env:            a.claim.EnvBuilder(),
		ShimPath:       a.d.ShimPath,
		AgentVersion:   a.version,
		BootID:         a.bootID,
		Now:            a.d.Now,
		HandlerOptions: interceptors,
		Log:            a.log,
	})
	if err != nil {
		return err
	}
	a.files, err = files.New(files.Options{
		Store:          a.st,
		Layout:         a.l,
		DefaultUser:    a.cfg.DefaultUser,
		Now:            a.d.Now,
		HandlerOptions: interceptors,
		Log:            a.log,
	})
	if err != nil {
		return err
	}
	a.tcp = &ports.Counter{}
	a.ports = ports.NewScanner(ports.Options{
		ProcDir: a.d.ProcDir,
		Exclude: a.cfg.PortsExclude,
		Emit:    a.emit,
		Log:     a.log,
	})
	a.updater, err = update.New(update.Options{
		Layout:  a.l,
		Keys:    a.updateKeys,
		Uploads: a.files.UploadPath,
		Exit:    a.exit,
		Emit:    a.emit,
		Now:     a.d.Now,
		Version: a.version,
		ShimProtos: func() []int {
			_, protos := update.ShimVersions(a.l, a.proc.UnitAlive)
			return protos
		},
		Schema: store.SchemaVersion,
	})
	if err != nil {
		return err
	}
	a.confirm = &confirmer{debugConfirm: a.d.DebugConfirm, confirm: a.updater.Confirm}

	a.idle = &system.IdleLoop{
		Counts: a.proc,
		TCP:    a.tcp,
		Sample: a.d.IdleSample,
		Window: a.cfg.IdleWindow,
		Emit:   a.emit,
		Now:    a.d.Now,
	}
	metrics := a.d.Metrics
	if metrics == nil {
		a.gopsutil = &system.GopsutilMetrics{Log: a.log}
		metrics = a.gopsutil
	}
	a.system, err = system.New(system.Options{
		Info:           staticInfo{a: a},
		Ready:          a.tracker,
		Claim:          a.claim,
		Ports:          a.ports,
		TCP:            a.tcp,
		Proc:           a.proc,
		Quiesce:        a.quiesce,
		Update:         a.updater,
		Metrics:        metrics,
		Idle:           a.idle,
		Hostname:       a.d.Hostname,
		HandlerOptions: interceptors,
	})
	if err != nil {
		return err
	}
	a.mux = a.newMux()
	return nil
}

// applyIdentity reads the smbios identity and applies it if identity.json
// names another machine (the agent's fallback for sbx-identity.service,
// spec 7.2). A failure leaves the identity phase failed.
func (a *agent) applyIdentity(ctx context.Context) {
	id, err := a.readIdentity(ctx)
	if err == nil {
		var changed bool
		changed, err = ident.Apply(ctx, a.l, id, a.d.Resetter, true)
		if changed {
			a.log.Warn("agent: the machine identity changed and sbx-identity.service did not apply it; the agent reset the identity",
				"machine_id", id.MachineID)
		}
	}
	if err != nil {
		a.log.Error("agent: no machine identity, running without the tunnel", "err", err)
		a.identity.fail(err)
		return
	}
	a.identity.set(id)
}

// readIdentity reads and parses the smbios identity.
func (a *agent) readIdentity(ctx context.Context) (ident.Identity, error) {
	raw, err := a.d.IdentSource.Read(ctx)
	if err != nil {
		return ident.Identity{}, err
	}
	id, err := ident.Parse(raw)
	if err != nil {
		return ident.Identity{}, err
	}
	for _, w := range id.Warnings {
		a.log.Warn("agent: identity: " + w)
	}
	return id, nil
}

// reportIdentityReset journals identity.reset as the first event of the
// journal of a new identity and clears the flag in identity.json. The flag
// is cleared only after the event is durable, so a crash reports it again.
func (a *agent) reportIdentityReset(ctx context.Context) {
	f, err := ident.LoadFile(a.l.IdentityFile)
	if err != nil || !f.ResetPending {
		return
	}
	a.st.AppendEvent(events.TypeIdentityReset, &agentv1.IdentityReset{MachineId: f.MachineID})
	wctx, cancel := context.WithTimeout(ctx, startupWrite)
	defer cancel()
	if err := a.st.Flush(wctx); err != nil {
		a.log.Warn("agent: flush identity.reset", "err", err)
		return
	}
	f.ResetPending = false
	if err := f.Save(a.l.IdentityFile); err != nil {
		a.log.Warn("agent: clear resetPending in identity.json", "err", err)
	}
}

// setIdentityPhase reports the identity phase.
func (a *agent) setIdentityPhase() {
	if a.identity.ready() {
		a.tracker.Set(readiness.PhaseIdentity, phaseReady, "")
		return
	}
	a.tracker.Set(readiness.PhaseIdentity, phaseFailed, a.identity.errText())
}

// retryIdentity re-reads the identity every IdentityRetry while it is
// failed (spec 7.1). A valid identity of the machine in identity.json makes
// the phase ready and starts the tunnel. Another machine (or no
// identity.json) cannot be applied under the open store: the agent exits
// gracefully and systemd restarts it, which applies it at startup.
func (a *agent) retryIdentity(ctx context.Context) {
	t := time.NewTicker(a.d.IdentityRetry)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		id, err := a.readIdentity(ctx)
		if err != nil {
			a.identity.fail(err)
			a.setIdentityPhase()
			continue
		}
		f, err := ident.LoadFile(a.l.IdentityFile)
		if err != nil || !sameMachine(f.MachineID, id.MachineID) {
			a.log.Warn("agent: a machine identity appeared that is not applied yet; restarting to apply it",
				"machine_id", id.MachineID)
			a.exit()
			return
		}
		a.identity.set(id)
		a.setIdentityPhase()
		a.log.Info("agent: machine identity is valid now", "machine_id", id.MachineID)
		a.startTunnel(ctx)
		return
	}
}

// sameMachine compares two machine ids written with or without dashes.
func sameMachine(x, y string) bool {
	norm := func(s string) string { return strings.ToLower(strings.ReplaceAll(s, "-", "")) }
	return x != "" && norm(x) == norm(y)
}

// startReason names the start for agent.started: boot when the boot id
// differs from the previous run's, update when this version is the target of
// a pending update, rollback when a rollback waits to be reported, restart
// otherwise. It runs before CheckPending, which consumes those files.
func (a *agent) startReason() string {
	if prev, ok := a.st.Meta(metaLastBootID); !ok || string(prev) != a.bootID {
		return reasonBoot
	}
	if p, ok, err := update.ReadPending(a.l); err == nil && ok && p.To == a.version {
		return reasonUpdate
	}
	if update.RollbackRecorded(a.l) {
		return reasonRollback
	}
	return reasonRestart
}

// updateKeys returns the update keys of the current version.
func (a *agent) updateKeys() []ed25519.PublicKey {
	keys, err := update.ReadKeys(filepath.Join(a.l.CurrentLink, filepath.FromSlash(update.UpdateKeysName)))
	if err != nil {
		a.log.Error("agent: read update keys", "err", err)
		return nil
	}
	return keys
}

// identityState is the machine identity of the run: valid (with the boot
// secret, memory only) or failed with a reason.
type identityState struct {
	cfgURL string

	mu  sync.Mutex
	id  *ident.Identity
	err string
}

func (s *identityState) set(id ident.Identity) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.id, s.err = &id, ""
}

func (s *identityState) fail(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.id, s.err = nil, err.Error()
}

func (s *identityState) ready() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.id != nil
}

func (s *identityState) errText() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.err
}

// machineID returns the machine id, or "" while failed.
func (s *identityState) machineID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.id == nil {
		return ""
	}
	return s.id.MachineID
}

// tunnelURL returns the effective tunnel URL and its source (S5 14).
func (s *identityState) tunnelURL() (url, source string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	smbios := ""
	if s.id != nil {
		smbios = s.id.TunnelURL
	}
	return effectiveTunnelURL(smbios, s.cfgURL)
}

// Tunnel URL sources (S5 section 14).
const (
	SourceSmbios = "smbios"
	SourceConfig = "config"
)

// effectiveTunnelURL picks the smbios override (product_family) over the
// agent.toml value.
func effectiveTunnelURL(smbios, cfg string) (url, source string) {
	if smbios != "" {
		return smbios, SourceSmbios
	}
	return cfg, SourceConfig
}

// holdEmitter queues events until release and then passes them on in
// order, followed by every later event.
type holdEmitter struct {
	next events.Emitter

	mu   sync.Mutex
	open bool
	held []events.Recorded
}

// Emit implements events.Emitter.
func (h *holdEmitter) Emit(typ string, payload proto.Message) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.open {
		h.held = append(h.held, events.Recorded{Type: typ, Payload: payload})
		return
	}
	h.next.Emit(typ, payload)
}

// release emits the queued events and opens the emitter.
func (h *holdEmitter) release() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, e := range h.held {
		h.next.Emit(e.Type, e.Payload)
	}
	h.held, h.open = nil, true
}
