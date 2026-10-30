//go:build integration && linux

package integration

// Stand tests of the pve acceptance run (apps/bench `s3`). They skip unless
// SBX_STAND=1: the bench driver runs them one at a time, as root, in a real
// Proxmox VM around actions it takes from outside the guest (a reboot, an S1
// snapshot between Quiesce and Thaw, a fork). They share files with the driver
// in standRun (tmpfs) and standVar (survives a reboot); secrets come on stdin
// and are never written anywhere.

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	agentv1 "github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/events"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/readiness"
	"github.com/belov38/boat-dev-clone/services/guest-agent/internal/supervisor"
)

const (
	standRun = "/run/sbx-stand"
	standVar = "/var/lib/sbx-stand"
	// rebootCmd is the command that runs across the reboot.
	rebootCmd = "stand-reboot"
	// standSnapshotWait bounds the wait for the driver's S1 snapshot.
	standSnapshotWait = 25 * time.Second
)

// standOnly skips a test outside the pve stand.
func standOnly(t *testing.T) {
	t.Helper()
	if os.Getenv("SBX_STAND") != "1" {
		t.Skip("pve stand test: run by apps/bench s3")
	}
}

// rebootRecord is what TestStandRebootBefore leaves for TestStandRebootAfter.
type rebootRecord struct {
	CommandID string `json:"command_id"`
	BootID    string `json:"boot_id"`
}

// phaseState returns the state of readiness phase name in info.
func phaseState(info *agentv1.InfoResponse, name string) agentv1.PhaseState {
	for _, p := range info.GetReadiness() {
		if p.GetName() == name {
			return p.GetState()
		}
	}
	return agentv1.PhaseState_PHASE_STATE_UNSPECIFIED
}

// standSecrets returns a fresh secret env and secret file (values never
// written to disk by the test).
func standSecrets() (map[string]string, []*agentv1.SecretFile) {
	return map[string]string{"STAND_SECRET": "stand-env-" + uuid.NewString()},
		[]*agentv1.SecretFile{{Name: "stand.txt", Content: []byte("stand-file-" + uuid.NewString()), Mode: 0o600}}
}

// Spec 21 item 4, before the reboot: claim with secret env and files, start a
// long command and record the boot id.
func TestStandRebootBefore(t *testing.T) {
	standOnly(t)
	c := newClient()
	env, files := standSecrets()
	claim(t, c, &agentv1.ClaimRequest{Hostname: "stand-host", PortDomain: portDomain, SecretEnv: env, SecretFiles: files})
	var info *agentv1.InfoResponse
	eventually(t, 30*time.Second, "secrets phase ready", func() bool {
		info = waitAgent(t)
		return phaseState(info, readiness.PhaseSecrets) == agentv1.PhaseState_PHASE_STATE_READY
	})
	start(t, c, rebootCmd, shellSpec("echo before-reboot; exec sleep 3600", "user"))
	eventually(t, 30*time.Second, "the command output", func() bool {
		r := attach(t, c, &agentv1.AttachRequest{CommandId: rebootCmd}, false)
		return string(r.stdout) == "before-reboot\n"
	})
	if got := get(t, c, rebootCmd).GetState(); got != agentv1.CommandState_COMMAND_STATE_RUNNING {
		t.Fatalf("command state = %v, want RUNNING", got)
	}
	if out := sh(t, "ls "+secretsDir+"/files"); strings.TrimSpace(out) != "stand.txt" {
		t.Fatalf("secret files = %q", out)
	}
	writeJSON(t, filepath.Join(standVar, "reboot.json"), rebootRecord{CommandID: rebootCmd, BootID: info.GetBootId()})
	t.Logf("boot %s, command %s running, secrets ready", info.GetBootId(), rebootCmd)
}

// secretsDir is the tmpfs with the materialized secrets (spec 8.3).
const secretsDir = "/run/sbx/secrets"

// Spec 21 item 4, after the reboot: the command is LOST/REBOOT with its
// output readable, the secrets are gone and the phase is pending until
// UpdateSecrets.
func TestStandRebootAfter(t *testing.T) {
	standOnly(t)
	var rec rebootRecord
	readJSON(t, filepath.Join(standVar, "reboot.json"), &rec)
	c := newClient()
	info := waitAgent(t)
	if info.GetBootId() == rec.BootID {
		t.Fatalf("boot id %s unchanged: no reboot", rec.BootID)
	}
	cmd := waitExited(t, c, rec.CommandID, time.Minute)
	if cmd.GetExit().GetStatus() != agentv1.ExitStatus_EXIT_STATUS_LOST || cmd.GetExit().GetReason() != agentv1.ExitReason_EXIT_REASON_REBOOT {
		t.Errorf("exit = %v, want LOST/REBOOT", cmd.GetExit())
	}
	r := attach(t, c, &agentv1.AttachRequest{CommandId: rec.CommandID}, false)
	if string(r.stdout) != "before-reboot\n" {
		t.Errorf("stdout after the reboot = %q", r.stdout)
	}
	if r.exit == nil || r.exit.GetStatus() != agentv1.ExitStatus_EXIT_STATUS_LOST || r.exit.GetReason() != agentv1.ExitReason_EXIT_REASON_REBOOT {
		t.Errorf("attach exit = %v, want LOST/REBOOT", r.exit)
	}
	if got := phaseState(info, readiness.PhaseSecrets); got != agentv1.PhaseState_PHASE_STATE_PENDING || info.GetReady() {
		t.Errorf("after the reboot: secrets phase %v, ready %v; want PENDING, not ready", got, info.GetReady())
	}
	if out, _ := shErr("ls -A " + secretsDir + "/files 2>/dev/null; cat " + secretsDir + "/env 2>/dev/null"); strings.TrimSpace(out) != "" {
		t.Errorf("secrets survived the reboot: %d bytes listed", len(out))
	}
	env, files := standSecrets()
	if _, err := c.sys.UpdateSecrets(tctx(t, 30*time.Second), connect.NewRequest(&agentv1.UpdateSecretsRequest{SecretEnv: env, SecretFiles: files})); err != nil {
		t.Fatalf("UpdateSecrets: %v", err)
	}
	eventually(t, 30*time.Second, "secrets ready after UpdateSecrets", func() bool {
		info = waitAgent(t)
		return phaseState(info, readiness.PhaseSecrets) == agentv1.PhaseState_PHASE_STATE_READY && info.GetReady()
	})
	if out := sh(t, "ls "+secretsDir+"/files"); strings.TrimSpace(out) != "stand.txt" {
		t.Errorf("secret files after UpdateSecrets = %q", out)
	}
	t.Logf("boot %s -> %s, exit %v, ready again", rec.BootID, info.GetBootId(), cmd.GetExit())
}

// standWriter starts a 4 KiB write with fsync to path and returns a channel
// closed when it completes.
func standWriter(t *testing.T, path string) <-chan struct{} {
	t.Helper()
	done := make(chan struct{})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	cmd := exec.CommandContext(ctx, "dd", "if=/dev/zero", "of="+path, "bs=4k", "count=1", "conv=fsync", "status=none")
	if err := cmd.Start(); err != nil {
		cancel()
		t.Fatal(err)
	}
	go func() {
		_ = cmd.Wait()
		cancel()
		close(done)
	}()
	return done
}

// Spec 21 item 11 on a real root filesystem. STAND_QUIESCE=snapshot:
// Quiesce (30 s), a write to / blocks, the driver takes an S1 snapshot
// (markers frozen/snapshotted/thawed in standRun), Thaw answers auto_thawed=false
// and the write completes. STAND_QUIESCE=autothaw: no Thaw; the lease
// deadline thaws within 5 s and Thaw answers auto_thawed=true. With
// STAND_CONTAINER set, that container must be among the paused ones.
func TestStandQuiesce(t *testing.T) {
	standOnly(t)
	mode := os.Getenv("STAND_QUIESCE")
	if mode != "snapshot" && mode != "autothaw" {
		t.Fatalf("STAND_QUIESCE = %q, want snapshot or autothaw", mode)
	}
	if !slices.Contains(freezableMounts(t), "/") {
		t.Fatalf("/ is not freezable: %v", freezableMounts(t))
	}
	if err := os.MkdirAll(standRun, 0o755); err != nil {
		t.Fatal(err)
	}
	frozenMark, snapMark := filepath.Join(standRun, "frozen"), filepath.Join(standRun, "snapshotted")
	for _, m := range []string{frozenMark, snapMark, filepath.Join(standRun, "thawed")} {
		_ = os.Remove(m)
	}
	leaseMs := uint32(30000)
	if mode == "autothaw" {
		leaseMs = 10000
	}
	c := newClient()
	after := lastSeq(t)
	res, err := c.sys.Quiesce(tctx(t, 30*time.Second), connect.NewRequest(&agentv1.QuiesceRequest{
		LeaseMs: proto.Uint32(leaseMs), Docker: proto.Bool(dockerPresent()), Fs: proto.Bool(true),
	}))
	if err != nil {
		t.Fatalf("Quiesce: %v", err)
	}
	q := res.Msg
	t.Logf("lease %s, frozen %v, paused %v, deadline in %v", q.GetLeaseId(), q.GetFrozenMounts(), q.GetPausedContainers(), time.Until(q.GetDeadline().AsTime()).Round(time.Millisecond))
	if !slices.Contains(q.GetFrozenMounts(), "/") {
		t.Errorf("frozen mounts %v lack /", q.GetFrozenMounts())
	}
	// STAND_CONTAINER: a running Docker container the driver started.
	if ctr := os.Getenv("STAND_CONTAINER"); ctr != "" && !slices.ContainsFunc(q.GetPausedContainers(), func(id string) bool {
		return strings.HasPrefix(ctr, id) || strings.HasPrefix(id, ctr)
	}) {
		t.Errorf("paused containers %v lack %s", q.GetPausedContainers(), ctr)
	}
	w := standWriter(t, "/var/tmp/stand-quiesce-"+mode)
	if !blocked(w, 2*time.Second) {
		t.Fatal("a write to / completed while quiesced")
	}
	// Reads keep working while frozen (spec 14.4).
	ictx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	info, err := c.sys.Info(ictx, connect.NewRequest(&agentv1.InfoRequest{}))
	cancel()
	if err != nil {
		t.Errorf("System/Info while frozen: %v", err)
	} else if !info.Msg.GetQuiesce().GetActive() || info.Msg.GetQuiesce().GetLeaseId() != q.GetLeaseId() {
		t.Errorf("Info quiesce = %v", info.Msg.GetQuiesce())
	}

	if mode == "snapshot" {
		if err := os.WriteFile(frozenMark, []byte(q.GetLeaseId()+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(standSnapshotWait)
		for {
			if _, err := os.Stat(snapMark); err == nil {
				break
			}
			if time.Now().After(deadline) {
				t.Error("the driver did not take the snapshot in time")
				break
			}
			time.Sleep(50 * time.Millisecond)
		}
		select {
		case <-w:
			t.Error("the write completed during the snapshot")
		default:
		}
		began := time.Now()
		th, err := c.sys.Thaw(tctx(t, 30*time.Second), connect.NewRequest(&agentv1.ThawRequest{LeaseId: q.GetLeaseId()}))
		if err != nil {
			t.Fatalf("Thaw: %v", err)
		}
		if err := os.WriteFile(filepath.Join(standRun, "thawed"), nil, 0o644); err != nil {
			t.Error(err)
		}
		if th.Msg.GetAutoThawed() || th.Msg.GetAlreadyThawed() {
			t.Errorf("Thaw = %v, want auto_thawed=false", th.Msg)
		}
		if blocked(w, 10*time.Second) {
			t.Fatal("the write did not complete after Thaw")
		}
		t.Logf("thaw %v, write completed %v after Thaw", th.Msg, time.Since(began).Round(time.Millisecond))
		return
	}

	deadline := q.GetDeadline().AsTime()
	if blocked(w, time.Until(deadline.Add(5*time.Second))) {
		t.Fatalf("not thawed %v after the deadline", time.Since(deadline).Round(time.Millisecond))
	}
	if early := time.Until(deadline); early > autoThawEpsilon {
		t.Errorf("thawed %v before the deadline", early)
	}
	t.Logf("write completed %v after the deadline", time.Since(deadline).Round(time.Millisecond))
	var ev agentv1.QuiesceAutoThawed
	waitEvent(t, after, events.TypeQuiesceAutoThawed, 15*time.Second, &ev, func() bool { return ev.GetLeaseId() == q.GetLeaseId() })
	th, err := c.sys.Thaw(tctx(t, 30*time.Second), connect.NewRequest(&agentv1.ThawRequest{LeaseId: q.GetLeaseId()}))
	if err != nil {
		t.Fatalf("Thaw after the auto thaw: %v", err)
	}
	if !th.Msg.GetAutoThawed() {
		t.Errorf("Thaw = %v, want auto_thawed=true", th.Msg)
	}
	t.Logf("auto thawed by %q, Thaw %v", ev.GetBy(), th.Msg)
}

// dockerPresent reports whether a Docker daemon socket exists.
func dockerPresent() bool {
	_, err := os.Stat("/run/docker.sock")
	return err == nil
}

// Spec 21 item 14, the planting part: three secrets from stdin (one per line)
// go into secret_env, a secret file and a command's spec env (a finished and a
// running command); then sync. The driver greps the block devices.
func TestStandSecretsPlant(t *testing.T) {
	standOnly(t)
	sc := bufio.NewScanner(os.Stdin)
	var sec []string
	for sc.Scan() {
		if s := strings.TrimSpace(sc.Text()); s != "" {
			sec = append(sec, s)
		}
	}
	if len(sec) != 3 {
		t.Fatalf("want 3 secrets on stdin, got %d", len(sec))
	}
	c := newClient()
	if _, err := c.sys.UpdateSecrets(tctx(t, 30*time.Second), connect.NewRequest(&agentv1.UpdateSecretsRequest{
		SecretEnv:   map[string]string{"STAND_SEC_ENV": sec[0]},
		SecretFiles: []*agentv1.SecretFile{{Name: "stand.txt", Content: []byte(sec[1]), Mode: 0o600}},
	})); err != nil {
		t.Fatalf("UpdateSecrets: %v", err)
	}
	spec := shellSpec(`printf %s "$STAND_SEC_CMD" | sha256sum; printf %s "$STAND_SEC_ENV" | sha256sum`, "user")
	spec.Env = map[string]string{"STAND_SEC_CMD": sec[2]}
	r := run(t, c, newID("stand-secret"), spec, time.Minute)
	if want := sha256hex(sec[2]) + "  -\n" + sha256hex(sec[0]) + "  -\n"; string(r.stdout) != want {
		t.Fatalf("secrets in the command env: stdout %q, want the hashes", r.stdout)
	}
	if got := sha256hex(string(readFileT(t, secretsDir+"/files/stand.txt"))); got != sha256hex(sec[1]) {
		t.Fatal("secret file content differs")
	}
	long := shellSpec("exec sleep 3600", "user")
	long.Env = map[string]string{"STAND_SEC_CMD": sec[2]}
	start(t, c, newID("stand-secret-long"), long)
	sh(t, "sync")
	t.Log("planted 3 secrets, synced")
}

// standFacts is the identity state of a machine as the stand compares it.
type standFacts struct {
	MachineID      string `json:"machine_id"`
	SmbiosUUID     string `json:"smbios_uuid"`
	EtcMachineID   string `json:"etc_machine_id"`
	Hostname       string `json:"hostname"`
	EtcHostname    string `json:"etc_hostname"`
	HostKeysSHA256 string `json:"host_keys_sha256"`
	SandboxID      string `json:"sandbox_id"`
	BootID         string `json:"boot_id"`
	FirstSeq       uint64 `json:"first_seq"`
	FirstType      string `json:"first_type"`
	FirstMachineID string `json:"first_machine_id"`
	LastSeq        uint64 `json:"last_seq"`
	Commands       int    `json:"commands"`
	Ready          bool   `json:"ready"`
	SSHActive      string `json:"ssh_active"`
}

// TestStandFacts prints the identity facts of this machine as one line
// `STAND-FACTS <json>` on stdout for the driver (spec 21 item 12).
func TestStandFacts(t *testing.T) {
	standOnly(t)
	info := waitAgent(t)
	f := standFacts{
		MachineID:    info.GetMachineId(),
		SmbiosUUID:   strings.TrimSpace(string(readFileT(t, "/sys/class/dmi/id/product_uuid"))),
		EtcMachineID: strings.TrimSpace(string(readFileT(t, "/etc/machine-id"))),
		EtcHostname:  strings.TrimSpace(string(readFileT(t, "/etc/hostname"))),
		SandboxID:    info.GetSandboxId(),
		BootID:       info.GetBootId(),
		Ready:        info.GetReady(),
		SSHActive:    strings.TrimSpace(sh(t, "systemctl is-active ssh.service || true")),
	}
	f.Hostname, _ = os.Hostname()
	sum := sha256.Sum256(hostKeys(t))
	f.HostKeysSHA256 = hex.EncodeToString(sum[:])
	evs := journal(t, 0, 500*time.Millisecond)
	if len(evs) > 0 {
		f.FirstSeq, f.FirstType = evs[0].GetSeq(), evs[0].GetType()
		f.LastSeq = evs[len(evs)-1].GetSeq()
		if f.FirstType == events.TypeIdentityReset {
			var reset agentv1.IdentityReset
			if err := evs[0].GetPayload().UnmarshalTo(&reset); err == nil {
				f.FirstMachineID = reset.GetMachineId()
			}
		}
	}
	entries, err := os.ReadDir(filepath.Join(stateDir, "commands"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	f.Commands = len(entries)
	b, _ := json.Marshal(f)
	fmt.Printf("STAND-FACTS %s\n", b)
}

// smapsPrivate returns Private_Clean+Private_Dirty and Pss of pid in bytes.
func smapsPrivate(t *testing.T, pid string) (private, pss int64) {
	t.Helper()
	b, err := os.ReadFile("/proc/" + pid + "/smaps_rollup")
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		kb, err := strconv.ParseInt(f[1], 10, 64)
		if err != nil {
			continue
		}
		switch f[0] {
		case "Private_Clean:", "Private_Dirty:":
			private += kb << 10
		case "Pss:":
			pss = kb << 10
		}
	}
	return private, pss
}

// standMem is one process's memory as the stand reports it.
type standMem struct {
	RSS     int64 `json:"vm_rss"`
	RssAnon int64 `json:"rss_anon"`
	RssFile int64 `json:"rss_file"`
	Private int64 `json:"private"`
	Pss     int64 `json:"pss"`
}

// memOf returns the memory figures of pid.
func memOf(t *testing.T, pid string) standMem {
	t.Helper()
	m := standMem{RSS: statusKB(t, pid, "VmRSS"), RssAnon: statusKB(t, pid, "RssAnon"), RssFile: statusKB(t, pid, "RssFile")}
	m.Private, m.Pss = smapsPrivate(t, pid)
	return m
}

// TestStandMemory prints the idle agent's and one shim's memory as
// `STAND-MEM <json>` (spec 21 item 15).
func TestStandMemory(t *testing.T) {
	standOnly(t)
	c := newClient()
	waitAgent(t)
	time.Sleep(10 * time.Second) // idle
	agent := memOf(t, strconv.Itoa(mainPID(t)))
	id := newID("stand-mem")
	start(t, c, id, shellSpec("exec sleep 60", "user"))
	time.Sleep(3 * time.Second)
	shimPID := strings.TrimSpace(sh(t, "systemctl show -p MainPID --value "+supervisor.UnitName(id)))
	shim := memOf(t, shimPID)
	if _, err := c.proc.Kill(tctx(t, 10*time.Second), connect.NewRequest(&agentv1.KillRequest{CommandId: id})); err != nil {
		t.Errorf("Kill: %v", err)
	}
	b, _ := json.Marshal(map[string]standMem{"agent": agent, "shim": shim})
	fmt.Printf("STAND-MEM %s\n", b)
	if agent.RSS >= 40<<20 {
		t.Errorf("agent VmRSS %d >= 40 MiB", agent.RSS)
	}
}

// writeJSON writes v as JSON to path, creating its directory.
func writeJSON(t *testing.T, path string, v any) {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b, 0o644); err != nil {
		t.Fatal(err)
	}
}

// readJSON reads JSON from path into v.
func readJSON(t *testing.T, path string, v any) {
	t.Helper()
	if err := json.Unmarshal(readFileT(t, path), v); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
}
