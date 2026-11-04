# S3. Guest agent v0 (Linux)

Status: agreed, 2026-10-29 (master session; implementer review passed, remarks incorporated). Supplemented with the MVP recommendations R7 (`docs/roadmap-phase2.md` §6, decisions of the master session 2026-10-29). Area S3 from `docs/roadmap.md`. Architecture: `docs/architecture.md` §4. The contract the agent stands on: `docs/specs/s2-tunnel-protocol.md` (especially §5, §9, §10, §15). Neighboring areas: S1 `docs/specs/s1-proxmox-foundation.md` (quiesce, smbios), S4 (gateway, SSH), S5 (template), S6 (control plane).

The mark **[implementer]** is a decision of the spec author within the brief; it can be changed without new agreement if the reason is recorded. The other decisions were agreed with the master session (2026-10-29).

## 1. Why, and what counts as success

The agent is the only platform process inside the VM. Through it the control plane runs commands, works with files, publishes ports, hands the sandbox to the user (claim), takes consistent snapshots, and updates the agent itself. Linux now, Windows (S9) with the same code later.

Scenarios by priority:

1. **Commands survive everything except a reboot.** An hour-long command keeps running through a tunnel drop, an agent restart, and an agent self-update; the output is read byte for byte by offset, the exit code is right, the command is never executed twice.
2. **Claim in fractions of a second.** A warm machine receives env, secrets, hostname, and the SSH CA key and reports readiness by phases.
3. **Forks and snapshots are clean.** A fork gets a new identity (machine-id, hostname, SSH host keys, empty agent state) before the network starts; secrets do not reach disk and do not go into a snapshot.
4. **A snapshot of a running machine is consistent.** Docker is paused, filesystems are frozen for seconds, and the freeze lifts itself even if the caller disappears.
5. **Updates without a human.** A signed package is delivered through the tunnel; a failed version rolls itself back.

## 2. Goals, non-goals, anti-goals

**Goals:** the services `proto/umiak/agent/v1` (`Process`, `Filesystem`, `System`) and the `/files/*` endpoints; the shim and supervisor; durable state and retention; claim and readiness; identity change; quiesce/thaw; ports and CONNECT; installation, unit files, self-update, recovery through the QEMU guest agent; the user model. The code is portable to Windows: everything OS-dependent is behind interfaces (§18), without cgo.

**Non-goals:** the tunnel protocol and the shared Go tunnel library (S2, `libs/tunnel`); the gateway, the `*.umiak` HTTP proxy, the SSH gateway (S4); Proxmox operations (S1); image building (S5, only requirements for it here, §20); the data model and state machines (S6); the public API (S7); Windows specifics (S9) other than portability; the desktop and computer-use (S10); built-in coding agents, AI proxy, an output copy outside the VM (phase 2).

**Anti-goals** (a failure even if it formally works):
- a command ran twice after a `Start` retry;
- the output on attach differs from the recorded one by even a byte; `exit` arrived before the last byte;
- a secret (BS, MT, `secretEnv`, `secretFiles`, env from the command spec) is written to the guest disk or to swap;
- the filesystem stayed frozen longer than the lease because the caller disappeared;
- a fork booted with the source's machine-id, SSH host keys, or event journal;
- a failed update left the VM without an agent and without a rollback;
- the agent is the last process the kernel kills on OOM, yet it inflates memory itself (buffers output in RAM).

## 3. Overview

```
 VM (Ubuntu)
 +-------------------------------------------------------------------------+
 | umiak-identity.service (oneshot, early boot, before network and sshd)     |
 |                                                                         |
 | umiak-agent.service (root)                     umiak-cmd.slice              |
 |  +------------------------------+            +-----------------------+  |
 |  | libs/tunnel client (WSS, h2) |            | umiak-cmd-<id>.service  |  |
 |  | Connect: umiak.agent.v1.*      |  D-Bus     |  shim (root)          |  |
 |  |          umiak.tunnel.v1.*     |----------->|  payload/ (cgroup)    |  |
 |  | /files/*, CONNECT            |  unix sock |   bash -lc ... (user) |  |
 |  | state: bbolt + log files     |<---------->|  pipes -> log files   |  |
 |  +------------------------------+            +-----------------------+  |
 |         | Docker API (unix)        umiak-quiesce-watchdog-<lease>.service |
 |  sshd 127.0.0.1:22 / [::1]:22 (TrustedUserCAKeys from claim)            |
 |  qemu-guest-agent (fallback channel, S1)                                |
 +-------------------------------------------------------------------------+
```

- One binary `umiak-agent` (`services/guest-agent`, the Go module `github.com/belov38/umiak/services/guest-agent`) with subcommands: `run` (the agent), `shim`, `identity`, `quiesce-watchdog`, `rollback`, `doctor`, `thaw`, `install-package`, `seal`, `selftest`.
- The tunnel is the S2 library `libs/tunnel`: the agent gives it an `http.Handler` (Connect services, `/files/*`, CONNECT) and an implementation of the event journal and capabilities (§16, §17).
- The agent has no inbound TCP ports. It talks to the shim through unix sockets in `/run/umiak-agent` (root 0700).

## 4. Users, permissions, security

The security model: **the trust boundary is the VM.** Root inside the VM was accepted by Ilia (S2 §16, item 1): it can read the BS and MT of its own VM, but that gives access only to its own VM. Hence the decisions below (agreed by the master session, Ilia informed and may revisit):

- The agent runs as **root** (`umiak-agent.service`, `User=root`).
- Commands by default run as **`user`** (uid 1000, groups `sudo` and `docker`, **NOPASSWD sudo**, linger on). The user is created in the template (S5); the name comes from `agent.toml` (`[user] default`).
- The `user` field in a command spec allows any existing user, including `root`.
- File operations are executed by the agent as root. New files and directories get the owner `user` (or `owner` from the request). There are no path restrictions (unlike boat).
- Secrets live only in a separate tmpfs `/run/umiak` with the option `noswap` (kernel ≥ 6.4), which the agent mounts at startup. The command spec with env also lies there during the start. The env from the command spec is not written to disk (§9.2). Swap in the template is forbidden (§20): secrets are also in process memory, and `noswap` protects only the tmpfs.
- The agent does not log env values, secrets, file bodies, or RPC bodies.
- The state directories (`/var/lib/umiak-agent`, `/run/umiak-agent`) are root 0700. This is not protection from `user` (who has sudo), but protection from accidental corruption.
- CONNECT only to the addresses of the VM itself (S2 §4.2).
- Updates are signed with ed25519 (§17.3).

## 5. Configuration and directories

`/etc/umiak-agent/agent.toml` — template settings (placed by S5) **[implementer: TOML format]**:

```toml
[tunnel]
url = "wss://tunnel.example.com/v1/connect"

[user]
default = "user"

[readiness]
required = ["identity", "claim", "secrets", "docker"]   # phases that gate "ready"

[docker]
enabled = true                 # pause on quiesce, "docker" readiness phase

[ports]
exclude = [22, 53]             # not reported in ports.changed

[output]
per_stream_bytes = "128MiB"
total_bytes = "2GiB"
total_fraction = 0.10          # of the state filesystem; the smaller limit wins

[limits]
max_running_commands = 256

[idle]
window = "5m"
```

Trusted material (the tunnel CA bundle, the update public keys) lies **in the version directory** (`versions/<v>/trust/`), not in `/etc`: it is updated and rolled back together with the binary (S2 §5.4). For development the path can be overridden in `agent.toml`.

| Path | What | Survives |
|---|---|---|
| `/usr/local/lib/umiak-agent/versions/<v>/` | `umiak-agent`, `manifest.json`, `manifest.sig`, `trust/tunnel-ca.pem`, `trust/update-keys.pub` | everything |
| `/usr/local/lib/umiak-agent/current`, `previous` | symlinks to versions | everything |
| `/usr/local/bin/umiak-agent` | symlink to `current/umiak-agent` (CLI for `doctor` and QGA) | everything |
| `/var/lib/umiak-agent/state.db` | bbolt: commands, the `requestId` cache, the event journal, uploads, claim without secrets, meta | reboot; erased on identity change |
| `/var/lib/umiak-agent/commands/<id>/` | `stdout`, `stderr`, `pty`, `shim.json`, `exit.json` | reboot; erased on identity change |
| `/var/lib/umiak-agent/uploads/` | temporary upload files | reboot; erased on identity change |
| `/var/lib/umiak-agent/identity.json` | machineId, the recorded machine-id, host key fingerprints | everything; rewritten on identity change |
| `/var/lib/umiak-agent/pending-update.json` | an unfinished update `{from, to, deadline}`. This is a file, not bbolt: it is read by `rollback` (§17.4) | reboot |
| `/run/umiak-agent/` | shim sockets, quiesce lease, `status.json` | only until reboot |
| `/run/umiak/` | tmpfs `noswap`, mounted by the agent: `secrets/` (0750 `root:user`: `env`, `files/<name>`), `cmd-spec/` (0700 root: the command spec until the shim has read it) | only until reboot |
| `/etc/umiak/env` | the sandbox's non-secret env for PAM (SSH sessions), §8.2 | reboot; cleared on identity change |
| `/etc/umiak-agent/ssh-user-ca.pub` | the gateway SSH CA keys from the template (may be empty) | everything (part of the template) |
| `/etc/ssh/umiak_user_ca.pub` | the effective SSH CA keys: from claim, otherwise a copy of the template ones | reboot; rewritten from the template on identity change |

## 6. Boot and agent lifecycle

Order at boot:

1. `umiak-identity.service` (oneshot, §7): compares smbios with `identity.json` and resets the identity on change. Runs before the network, sshd, and the agent.
2. `umiak-agent.service`:
   1. If `/run/umiak-agent/quiesce.json` exists — lift the freeze (§14.4). Otherwise a test write to the state directory; if it hangs for more than 15 s — a forced thaw (§14.4). The agent does not write to disk before this. Then mount the tmpfs `/run/umiak` (if it is not there yet) and create the empty `secrets/env` and `/etc/umiak/env` if they do not exist.
   2. Open `state.db`, migrations (additive only, §17.5).
   3. If `bootId` changed — set `LOST` (reason `REBOOT`) for all commands in `RUNNING` without `exit.json`, emit `command.exited`. Otherwise — find the live shims and reconnect to their sockets (§9.6).
   4. Confirm or roll back a pending update (`pending-update.json`, §17.4).
   5. Read smbios, connect via `libs/tunnel` (S2 §4–§6).
   6. The event `agent.started`, the readiness phases (§8.5).
3. `SIGTERM` (VM stop, `systemctl restart`): the agent closes the tunnel, flushes buffers to `state.db`, and exits. It does not touch shims and commands: they are in their own units.

What survives what:

| Event | Commands and PTYs | Output, journal, `requestId` cache | Claim (env, hostname, SSH CA) | Secrets | Tunnel, TCP streams, attach |
|---|---|---|---|---|---|
| tunnel drop | alive | intact | intact | intact | TCP breaks; attach continues by offset |
| agent restart or update | alive (shim in its own units) | intact | intact | intact (tmpfs) | reconnect with BS; TCP breaks |
| reboot (stop/resume) | `LOST`, PTYs closed | intact | intact | **gone**, phase `secrets: pending` | a new connection |
| identity change (fork, VM from a saved snapshot) | no (cold start) | **erased**, `seq` from 1 | **erased**, waits for a new claim | no | a new connection |

## 7. Identity

### 7.1 Source

- `/sys/class/dmi/id/product_serial` (readable by root only) contains `umiak1:<machineId>:<base64url(BS)>`: Proxmox decodes `base64=1` from `smbios1` (S2 §5.2, S1 §6.4). `product_uuid` must match `machineId`; on a mismatch — a warning in the log, we trust the serial.
- **vmgenid is not read on Linux**: the `vmgenid` driver only reseeds the RNG and does not expose the value to userspace (the uevent `NEW_VMGENID` was reverted in 2024). So on Linux a fork is detected only by `machineId`. The agent sends the header `Umiak-Vmgenid` empty. On Windows (S9) vmgenid is read.
- A fork for us is always a cold start of a new VM (there are no memory snapshots), so an identity change is visible only at boot, not on a running VM.
- If there is no serial or it cannot be parsed (template build), the agent works without a tunnel, phase `identity: failed`, re-reading once per 60 s.

### 7.2 `umiak-identity.service`

```ini
[Unit]
Description=umiak machine identity
DefaultDependencies=no
After=local-fs.target systemd-remount-fs.service
Before=network-pre.target systemd-networkd.service ssh.service ssh.socket cloud-init-local.service umiak-agent.service systemd-journal-flush.service sysinit.target
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/lib/umiak-agent/current/umiak-agent identity apply

[Install]
WantedBy=sysinit.target
```

`identity apply`: if the `machineId` from smbios equals the one saved in `identity.json` — do nothing. Otherwise (or if `identity.json` is absent — the first boot after `seal`):

1. Erase the agent state: `state.db`, `commands/`, `uploads/`, `pending-update.json`, other files from the managed list (`/var/lib/umiak-agent/managed-files`); leave `/etc/umiak/env` empty. Rewrite `/etc/ssh/umiak_user_ca.pub` with a copy of the template's `/etc/umiak-agent/ssh-user-ca.pub`.
2. **machine-id.** If `/etc/machine-id` is empty, equals `uninitialized`, or equals the value from the old `identity.json` (inherited), write a new one: the hex `machineId` without dashes (32 characters). If systemd has already set another value (`systemd.machine_id=firmware`, §20), leave it. `/var/lib/dbus/machine-id` is a symlink to `/etc/machine-id`.
3. **SSH host keys.** Delete `/etc/ssh/ssh_host_*`, run `ssh-keygen -A`. On Linux calling a system utility is acceptable: OpenSSH is in the image; on Windows (S9) a separate path.
4. **Hostname.** `umiak-<last 12 hex of machineId>` (the last ones, because the first 48 bits of a UUIDv7 are the creation time and coincide for neighboring machines). `sethostname`, `/etc/hostname`, the `127.0.1.1` line in `/etc/hosts` (a managed block). Claim will then replace the hostname.
5. Write `identity.json` with the flag `resetPending` (fsync).
6. **journald.** If step 2 replaced the effective machine-id (the fork inherited the parent's id), `systemctl try-restart systemd-journald` and wait for the restart. journald remembered the old id at startup and would write into `/var/log/journal/<old id>`, where the fork's `journalctl` finds nothing. The unit runs before `systemd-journal-flush.service`, so flushing the runtime journal into `/var/log/journal` goes under the new id and picks up the entries from the start of boot. A restart error is logged and does not fail apply.

At startup the agent sees `resetPending`, writes `identity.reset` as the first event of the new journal (`seq = 1`), and clears the flag.

This way the machine-id and the DHCP DUID (systemd-networkd derives it from the machine-id) change before the network starts. This closes the S1 risk "the same IP for A and F". PID 1 caches the machine-id from early boot; journald is restarted by step 6, the other processes are fine with the new `/etc/machine-id`.

**A safeguard in the agent.** If at startup the agent sees a mismatch (`umiak-identity` is off or crashed), it performs the same steps itself, then `systemctl try-restart ssh` and `networkctl renew`, and writes a warning.

### 7.3 `umiak-agent seal` (for S5)

Image preparation before `qm template`: stop the agent, erase `/var/lib/umiak-agent` entirely (together with `identity.json`) and the host keys, clear `/etc/machine-id` (an empty file), return the managed files to template ones (`/etc/umiak/env` empty, `/etc/ssh/umiak_user_ca.pub` — a copy of the template keys). The version directory `/usr/local/lib/umiak-agent` stays. The first boot from the template goes through §7.2 as an identity change.

## 8. Claim, env, secrets, SSH, readiness

### 8.1 Claim

`System/Claim` (with `Umiak-Request-Id`) is executed **once per machine identity**. A retry with the same `requestId` returns the saved response. A claim with different content after a successful one — `failed_precondition` `already_claimed`. If the `identity` phase is not yet `ready` — `unavailable` `identity_not_ready` (retryable).

```proto
message ClaimRequest {
  string sandbox_id = 1;
  string hostname = 2;                 // e.g. sandbox slug; RFC 1123 label
  string port_domain = 3;              // e.g. "umiak.example.com", for default env
  map<string, string> env = 4;         // non-secret, persisted in /etc/umiak/env
  map<string, string> secret_env = 5;  // tmpfs only
  repeated SecretFile secret_files = 6;
  repeated string ssh_user_ca_keys = 7; // gateway SSH CA public keys (current + next)
}
message SecretFile {
  string name = 1;        // file name under /run/umiak/secrets/files/
  bytes content = 2;      // <= 1 MiB each, <= 8 MiB total
  uint32 mode = 3;        // default 0440, group = default user
  string link_path = 4;   // optional symlink on disk pointing into tmpfs
}
```

Steps (each is idempotent):
1. Hostname: `sethostname`, `/etc/hostname`, `/etc/hosts`.
2. Env (platform and `env`) — into `state.db` (the claim record) and into `/etc/umiak/env` for PAM, atomically (tmp + fsync + rename).
3. Secrets into `/run/umiak/secrets` (`env`, `files/`); `link_path` symlinks (only the symlink lies on disk, the content is in tmpfs; after a reboot the symlink dangles until the secrets are sent again).
4. `/etc/ssh/umiak_user_ca.pub` atomically; an empty list in claim → a copy of the template keys. sshd need not be reloaded: it reads `TrustedUserCAKeys` on every authentication. The implementer verifies this with a test from §21; if it turns out otherwise — `systemctl try-reload-or-restart ssh.service`, an inactive unit is not an error.
5. Write the claim without secrets and `secretsDigest` (the sha256 of the canonical secret set, not the values themselves) into `state.db`.
6. The phases `claim` and `secrets` → `ready`, the event `claim.applied`.

Further changes are by full replacement of the set:
- `System/UpdateEnv{env}` — new commands see the new env, running ones do not;
- `System/UpdateSecrets{secret_env, secret_files}` — after every reboot (resume) the control plane calls it again: at agent start the phase `secrets` = `pending` if `secretsDigest` is non-empty. S6 stores secrets encrypted and re-sends them on resume; a fork inherits the source's env and gets a claim anew; a saved snapshot carries no secrets;
- `System/UpdateSshCa{keys}` — gateway CA rotation. The control plane calls it after every boot together with `UpdateEnv` and `UpdateSecrets` (S6 §7.6, step `provision`) with the current key set, so keys that changed after claim reach the sandbox on resume. A repeat with the same keys changes nothing: the file is overwritten with the same content, sshd need not be restarted.

### 8.2 Env of commands and SSH sessions

The agent assembles the process env itself, not relying on a shell. Order (the last wins):
1. basic: `HOME`, `USER`, `LOGNAME`, `SHELL`, `PATH` (Ubuntu default), `LANG=C.UTF-8`, `XDG_RUNTIME_DIR=/run/user/<uid>` (present thanks to linger), `TERM` for PTY;
2. platform default: `UMIAK=1`, `UMIAK_SANDBOX_ID`, `UMIAK_PORT_DOMAIN`, `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=.<port_domain>` (the Vite dev server accepts hosts `*.umiak.<domain>`, an S4 requirement);
3. `env` from claim;
4. `secret_env`;
5. `env` from the command spec.

A login shell (`bash -lc`) reads `/etc/profile` and `~/.profile`, but the platform env is not added there, so the env from the spec is not overwritten by anything.

**SSH sessions** (login and non-login: `ssh host cmd`, scp, sftp) get items 2–4 through PAM. S5 adds two lines to `/etc/pam.d/sshd`:

```
session required pam_env.so readenv=1 envfile=/etc/umiak/env
session required pam_env.so readenv=1 envfile=/run/umiak/secrets/env
```

- The agent writes both files in the `KEY=VALUE` format read by `pam_env`. The implementer checks the exact escaping with a test.
- Values with a line break or NUL do not get into these files: they are seen only by the agent's commands. Multi-line secrets are passed through `secret_files`.
- The files always exist (empty before claim) so that PAM does not fail.
- The desktop (S10) later uses the same path through PAM.

### 8.3 SSH

S4 decision: the gateway terminates SSH and goes through the tunnel (CONNECT `127.0.0.1:22`) into the VM's system OpenSSH with short-lived user certificates from the gateway SSH CA. Therefore:
- sshd listens only on `127.0.0.1` and `::1` (a template setting, S5);
- `TrustedUserCAKeys /etc/ssh/umiak_user_ca.pub`; the content arrives in claim (`ssh_user_ca_keys`, the current and the next key), and if claim is empty — a copy of the template's `/etc/umiak-agent/ssh-user-ca.pub`;
- the principal in the certificate is the VM user name (`user`, `root` if needed); the choice of principals is S4's;
- user keys are verified by the gateway, the agent does not maintain `authorized_keys`;
- the public host keys are returned in `System/Info.ssh_host_keys` so that the gateway can pin them (S4).

### 8.4 Hostname

Before claim — `umiak-<12 hex>` from §7.2, after — from claim. The agent checks that the value is a valid RFC 1123 label (up to 63 characters), otherwise `invalid_argument`.

### 8.5 Readiness phases

| Phase | `ready` when | Note |
|---|---|---|
| `agent` | the agent is running | always |
| `identity` | §7 done, serial read | |
| `claim` | claim applied | before claim — `pending` (the machine is in the warm pool) |
| `secrets` | the secrets in tmpfs match `secretsDigest` (an empty set is `ready` at once) | after a reboot `pending` until `UpdateSecrets` |
| `docker` | `docker.service` is active and `GET /_ping` on the unix socket answers | `disabled` if `[docker] enabled = false` |
| `desktop` | — | S10 |

States: `pending`, `ready`, `failed` (with an error), `disabled`. `System/Info.readiness` returns all phases and the aggregate `ready` (all phases from `[readiness] required` are ready). Each change is a `readiness.changed` event.

## 9. Processes

### 9.1 API (`umiak.agent.v1.Process`)

| Method | Kind | Idempotency |
|---|---|---|
| `Start(command_id, spec)` | unary | by `command_id` (S2 §9.1) |
| `Run(command_id, spec, attach options)` | server stream | `Start` + `Attach`, the first event `started` |
| `Attach(command_id, stdout_offset, stderr_offset, pty_offset, tail_bytes, follow)` | server stream | `NO_SIDE_EFFECTS` |
| `SendInput(command_id, input_session_id, seq, data, close_stdin)` | unary | `IDEMPOTENT` (deduplication by `seq`) |
| `Update(command_id, cols, rows)` | unary | `IDEMPOTENT` |
| `Signal(command_id, signal)` | unary | `IDEMPOTENT` |
| `Kill(command_id, grace_ms)` | unary | `IDEMPOTENT` |
| `Get(command_id)` | unary | `NO_SIDE_EFFECTS` |
| `List(state, tags, page_size, page_token)` | unary | `NO_SIDE_EFFECTS` |
| `Remove(command_id)` | unary | `IDEMPOTENT`; only for finished ones, deletes the logs and the record |

```proto
message CommandSpec {
  oneof cmd {
    Argv argv = 1;              // exec directly
    string shell = 2;           // /bin/bash -lc <shell> (or -c if login = false)
  }
  bool login = 3;               // default true for shell
  string cwd = 4;               // default: home of user; relative -> relative to home
  map<string, string> env = 5;  // never written to disk
  string user = 6;              // default from agent.toml; "root" allowed
  Pty pty = 7;                  // set -> PTY command with a single "pty" stream
  bool stdin = 8;               // open a stdin pipe (non-PTY); otherwise /dev/null
  uint64 timeout_ms = 9;        // 0 = none; enforced by the shim
  OnExit on_exit = 10;          // KEEP_LEFTOVERS (default) | KILL_LEFTOVERS
  map<string, string> tags = 11; // small labels for List
}
message Pty { uint32 cols = 1; uint32 rows = 2; string term = 3; } // term default xterm-256color
```

Unlike S2 §9.1, `Attach` has `pty_offset` (the PTY stream is separate, an added field), and also:
- `tail_bytes` — start each stream at `max(available_from, size − tail_bytes)`, for terminal scrollback;
- `follow` — `true` by default. With `false` return what exists and close the stream; `exit` will arrive if the command has already finished.

`CommandInfo` (in the responses of `Start`, `Get`, `List`): `command_id`, the spec without env values (keys only), `state` (`STARTING`, `RUNNING`, `EXITED`), `pid`, `started_at`, `ended_at`, `exit` (`status`: `EXITED`/`KILLED`/`LOST`; `code`, `signal`, `reason`: `NONE`/`SIGNAL`/`TIMEOUT`/`OOM`/`PTY_IDLE`/`REBOOT`/`SHIM_LOST`/`START_FAILED`), per stream `size`, `available_from`, and `end` (after exit), `has_leftovers`, `attached_clients`, the shim's `agent_version`, `output_truncated` (`""` or `disk_full`: part of the output was not written for lack of space; offsets and `end` refer only to what was written). The statuses `exited/killed/lost` are as in S2; `reason` is an added field.

### 9.2 Start: durable and exactly one launch

1. Validate the spec, the user, the `max_running_commands` limit (otherwise `resource_exhausted` `too_many_commands`).
2. Find `command_id` in `state.db`:
   - present and `spec_hash` matches → return the current `CommandInfo` (if the record is in `STARTING` — see item 5);
   - present with a different hash → `already_exists`.
3. Write `STARTING`: the spec without env values + `spec_hash` (the sha256 of the full spec, including env) + `bootId`; fsync. Env is not written to disk: on a `Start` retry after a failure the caller will send the spec again, and the hash will confirm that it is the same spec.
4. Put the full spec in `/run/umiak/cmd-spec/<id>` (tmpfs `noswap`, 0600). The shim will read it and delete it.
5. Start the transient unit `umiak-cmd-<id>.service` via D-Bus `StartTransientUnit` (§9.3). The name is deterministic: systemd will not create a second unit with the same name while the first is alive.
   - The shim writes the marker `shim.json` `{state: "launching", agentVersion, shimProto}` with fsync **before** launching the process. There is no pid in the marker: in Go there is no point between fork and exec. The shim appends the pid after launching (an atomic rewrite of the same file).
   - A retry for a record in `STARTING`: if `shim.json` exists, the launch may have happened, and the command is considered launched (wait or read its state). If there is neither `shim.json` nor a unit — there was no launch, we launch.
   - So a retry never gives a second launch. In the worst case (the shim died between the marker and the launch) the command will be `LOST` with `SHIM_LOST`.
6. Wait for `READY=1` from the shim (`Type=notify`): it created the cgroup and started the process. Write `RUNNING` + `pid`, fsync, respond.

If the process did not start (no binary, no `cwd`, unknown user) — the command is at once `EXITED` with `reason START_FAILED` and `code 127`. The error text is written to the command's `stderr` so that the client sees it through attach.

### 9.3 Shim and cgroup

The unit (properties are passed to `StartTransientUnit`):

```
umiak-cmd-<id>.service
  Slice=umiak-cmd.slice
  Type=notify, NotifyAccess=main
  ExecStart=/usr/local/lib/umiak-agent/versions/<v>/umiak-agent shim --id <id>
  Delegate=yes
  KillMode=control-group      # only used by explicit unit stop during cleanup
  # OOMScoreAdjust stays 0 so the payload inherits 0; the shim lowers only itself to -900 after the start
  CollectMode=inactive-or-failed
```

Shim:
1. Reads and deletes the spec from `/run`.
2. Moves itself into the leaf `<unit>/shim`, enables the controllers `memory pids cpu` in `<unit>/cgroup.subtree_control`, creates `<unit>/payload`.
3. Creates pipes for stdout and stderr and copies them into `commands/<id>/stdout` and `stderr` (root 0600) with a 64 KiB buffer. The offset is a position in the file. The files are written by the shim itself, the agent is not involved (S2 §9.1).
   Why not give the process the file directly: the idiom `echo x >/dev/stderr` reopens fd 2 via `/proc/self/fd`. For a root-owned file this is `EACCES`, and for a file owned by the user it is `O_TRUNC`, which zeroes the log and breaks the offsets.
4. For PTY: opens a PTY (`creack/pty`), the process is a session leader with a controlling terminal. The shim copies master → `commands/<id>/pty` and writes input to the master.
5. For `stdin: true` holds a write pipe, otherwise the process's stdin is `/dev/null`.
6. `PR_SET_CHILD_SUBREAPER`: orphaned descendants stay children of the shim, not PID 1.
7. Writes the marker `shim.json` (fsync, §9.2).
8. Starts the process via `SysProcAttr`:
   - `UseCgroupFD`/`CgroupFD` — `CLONE_INTO_CGROUP` into `payload`;
   - `Credential` — uid, gid, and groups from `/etc/passwd` and `/etc/group` (`os/user` without cgo);
   - `Setpgid` (non-PTY) or `Setsid` + `Setctty` (PTY).

   The process inherits `oom_score_adj` 0 from the unit. After the launch the shim writes -900 only to its own `/proc/self/oom_score_adj` (root has `CAP_SYS_RESOURCE`). Then it appends `pid` and `startedAt` to `shim.json` and sends `READY=1`.
9. Listens on `/run/umiak-agent/cmd/<id>.sock` (§9.6).
10. Watches `timeout_ms`: on expiry it performs Kill (§9.5) with `reason TIMEOUT`. The timer lives in the shim, so it does not depend on the agent.

**Exit.** When the main process has finished:
- the shim drains the pipes with a non-blocking read until `EAGAIN` or EOF: everything the process wrote before exit is already in the pipe buffer. For a PTY the master is drained until `EIO`;
- the `end` of each stream = the file size after this draining;
- the shim determines `reason`: `OOM` if `oom_kill` of `payload/memory.events` grew and the process was killed by `SIGKILL`; otherwise by the signal or by the Kill command;
- writes `exit.json` (fsync) and reports to the agent through the socket (the agent also sees the unit state change via D-Bus and `exit.json` via inotify).

**Background processes (leftovers).** `cmd &` and `nohup` live on in `payload`:
- the shim does not exit while `payload` is non-empty (it watches `cgroup.events` `populated`) and the pipes have not given EOF: if the main process of the service unit exits, systemd would kill the cgroup;
- the shim keeps reading the pipes, so leftovers do not get SIGPIPE and do not block. Their late output is written to the same files beyond `end` and does not reach attach;
- in `CommandInfo` the field `has_leftovers = true`;
- `Kill` or `Signal(SIGKILL)` on a finished command kills the leftovers;
- `on_exit: KILL_LEFTOVERS` kills them right after the main process exits.

If the shim dies (OOM, a bug), the read end of the pipe closes and the process gets SIGPIPE on its next write. Therefore the shim is small and protected by `oom_score_adj` -900.

### 9.4 Input and PTY

- The agent passes `SendInput` to the shim's socket. The shim keeps `last_seq` per `input_session_id` and drops `seq ≤ last` (S2 §9.3). The state is in the shim, so deduplication survives an agent restart. Handling in the shim is single-threaded: applying and updating `seq` are atomic.
- `close_stdin` closes the pipe (EOF for the process). Not applicable to a PTY: the client sends EOF itself as the byte `^D`.
- `Update(cols, rows)` → `TIOCSWINSZ` in the shim (the kernel sends SIGWINCH to the process).
- `SendInput` and `Update` for a finished command → `failed_precondition` `command_exited`.
- **PTY timeout without a client** (S2 §9.3): the agent counts the attach streams of the PTY command. When the last one disconnects, it writes `pty_detached_at` to `state.db` and sets a 10 min timer (after an agent restart the timer is restored from the record). If the command was never attached, the count runs from the start. On expiry — `SIGHUP` to the session group, after 10 s `cgroup.kill`, `reason PTY_IDLE`.

### 9.5 Signals and Kill

- `Signal(sig)` — a signal to the process group of the main process. `Signal(SIGKILL)` — `cgroup.kill` on `payload` (everything, including leftovers).
- `Kill(grace_ms)`, default `grace_ms` = 10000: `SIGTERM` to the group, after `grace_ms` — `cgroup.kill` on `payload`. The sequence is performed by the shim, so it survives an agent restart. If there is no shim — the agent does `cgroup.kill` itself.
- `Signal` and `Kill` on a finished command without leftovers do nothing and return the current `CommandInfo`.

### 9.6 Agent ↔ shim protocol

The unix socket `/run/umiak-agent/cmd/<id>.sock` (root 0700), length-prefixed protobuf messages **[implementer]**.

Messages: `Hello{shim_proto_min, shim_proto_max}`, `Status → {pid, state, last_seq per session, leftovers}`, `Input{session, seq, data}`, `CloseStdin`, `Resize{cols, rows}`, `Kill{grace_ms}`, `SignalGroup{sig}`, the shim → agent event `Exited{...}`.

The shim protocol version is separate. The agent supports **all** shim protocol versions within its major: shims of an old version survive several updates (§17.4).

If a shim version is still unsupported (after a major change), the command is not lost. The agent reads the logs and `exit.json` (their format is stable) and can kill it through `cgroup.kill`. `SendInput`, `Update`, and `Kill` with grace answer `failed_precondition` `shim_outdated` in this case.

The shim is launched from `versions/<v>/`; this version is not deleted while live shims with it exist.

Recovery after an agent restart: for each `RUNNING` record the agent checks `exit.json` (present → complete the record), otherwise the unit (alive → connect to the socket), otherwise (no unit, no `exit.json`) → `LOST` with `SHIM_LOST`.

### 9.7 Limits and memory

- `max_running_commands` (256 by default) counts commands with a live main process.
- Target **[implementer]**: RSS of an idle agent < 40 MiB, shim < 8 MiB (`GOGC`, `GOMEMLIMIT` for the shim are set in the unit; verified by acceptance §21).

## 10. Output: reading and retention

**Reading (Attach).**
- The agent reads the file from the requested offset in chunks of up to 64 KiB. `Send` into the Connect stream blocks on HTTP/2 flow control, so the agent accumulates nothing in memory (S2 §9.1).
- The agent sees new data via inotify on the command directory (`fsnotify`), with a fallback poll every 250 ms. The goal is an extra < 10 ms to the PTY echo (S2 §14.3, echo p99 ≤ 50 ms).
- If the requested offset is less than `available_from` — the event `truncated{stream, available_from}`, then reading from `available_from`.
- The janitor may punch a hole at the same time as a read, and what was read turns out to be zeros. So after each read the agent takes `available_from` again (`SEEK_DATA`). If it became greater than the start of the chunk read, the part before it is dropped and `truncated` is returned. Holes only advance forward, so one re-check is enough.
- `heartbeat` after 15 s of silence. `exit` — only when all streams have been delivered up to `end` (S2 §9.1).
- Several simultaneous attaches to one command are allowed: each reads the file independently.

**Retention** (S2 left the decision to S3).
- Old output is evicted by **punching holes** (`fallocate(PUNCH_HOLE|KEEP_SIZE)`) from the start of the file, in multiples of 4 KiB. Offsets do not shift, space is freed. `available_from` is taken from the file itself (`lseek(SEEK_DATA, 0)`), no separate accounting is needed. On NTFS (S9) the same via sparse files.
- The agent's janitor every 1 s:
  - each stream of each command: if `size − available_from > per_stream_bytes` (128 MiB) — punch the start up to `size − per_stream_bytes`;
  - the total volume of `commands/` more than `min(total_bytes, total_fraction × FS size)` (2 GiB / 10%) — delete the logs of the oldest **finished** commands entirely (`available_from = end`), then trim the oldest running ones;
  - free space on the state directory's FS below 1 GiB or 5% — the per-stream limit is temporarily 16 MiB, the event `disk.low`; on recovery — `disk.ok`.
- A record of a finished command is kept 7 days or while there are more than 10 000 commands (old ones are deleted first). The logs of a deleted record are deleted with it.
- A command is **not killed** because of space: only old output is lost.

## 11. Files

### 11.1 General rules

- The path is absolute; `~`, `~/...` and a relative one are resolved from the home directory of the user in the request (`user` by default).
- Operations are performed as root; new files and directories get the owner `owner` (by default the request's user) (§4).
- Symlinks: reading, writing, and `Stat` follow them (`Stat` has `no_follow`); `List` shows a symlink as `SYMLINK` with the target; recursive delete does not traverse them.
- Errors: `ENOENT` → `not_found` `path_not_found`; `EEXIST` → `already_exists`; `ENOTDIR`/`EISDIR` → `failed_precondition` `not_directory`/`is_directory`; `ENOSPC`/`EDQUOT` → `resource_exhausted` `no_space`; `EACCES` → `permission_denied`. The HTTP endpoints return the same codes in JSON `{code, message, retryable}` with the corresponding HTTP status.

### 11.2 HTTP `/files/*` (S2 §9.5)

| Endpoint | What it does |
|---|---|
| `GET /files?path=&user=` | Content. `Range` (one range; several → the whole file with `200`), `If-Range`, `ETag` = `"<inode>-<size>-<mtime_ns>"`, `Last-Modified`, `Accept-Ranges: bytes`. A directory → `400 is_directory`. `HEAD` too |
| `PUT /files?path=&mode=&owner=&make_parents=true` | Write as a single stream of any size: a temporary file in the same directory → fsync → rename. The response is `FileInfo` JSON. Not resumable; a retry with the same body gives the same result |
| `PUT /files/uploads/{uploadId}?offset=&path=` | A chunk up to 8 MiB. `offset` must equal the current size, otherwise `409` with the header `Umiak-Upload-Offset`. `path` in the first chunk is a hint where to keep the temporary file (§11.3) |
| `HEAD /files/uploads/{uploadId}` | `Umiak-Upload-Offset`; `404` if there is no upload |
| `POST /files/uploads/{uploadId}/commit` | JSON `{path, sha256?, mode?, owner?, overwrite=true, make_parents=true}` → `FileInfo`. Idempotent by `uploadId`: a retry returns the saved result for 24 h. A `sha256` mismatch → `422 checksum_mismatch`, the upload is deleted |
| `DELETE /files/uploads/{uploadId}` | Cancel |
| `GET /files/archive?path=&user=&format=tar\|tar.gz` | The directory `path` as a single tar stream (POSIX pax; `tar.gz` — streamed gzip), names relative to `path`. The walk does not follow symlinks (they are written as symlinks), hardlinks as separate files, sockets, FIFOs, and devices are skipped. Not a directory → `400 not_directory`. Files that change during reading are returned as read: there is no directory snapshot. An error in the middle of the stream aborts the response without the final tar blocks |
| `PUT /files/archive?path=&user=&format=tar\|tar.gz&overwrite=true&make_parents=true` | Unpacking a tar stream (`format=tar` by default) into the directory `path` (created with `make_parents`). Entries: files, directories, symlinks, hardlinks inside the archive; an absolute path, `..`, a hardlink outward, devices and FIFOs → `400 invalid_path`. Paths are resolved from `path` without following symlinks (`openat2` with `RESOLVE_BENEATH \| RESOLVE_NO_SYMLINKS`), so a write does not escape `path` either through a symlink from the archive or through one that already exists (such an entry → `400 invalid_path`). The owner is `owner` (by default the request's user), the archive's uid/gid are ignored; the mode is from the archive without setuid/setgid; mtime is preserved. `overwrite=false` and the file exists → `already_exists`. Limits: 200 000 entries, 16 GiB of unpacked data, a path up to 4 096 bytes → `413 payload_too_large`. Not atomic: on error what was written stays, the error response has `entries_written`. The response is `{path, entries, size}` JSON. A retry with `overwrite=true` gives the same result |

Temporary uploads without activity are deleted after 24 h. A directory archive (MVP rec. R7) goes through the same `/files/*`, so the gateway and `AgentClient.fetch` do not tell it apart (S2 §9.5, S7 §17.1); capability `files.archive.v1`.

### 11.3 Where the temporary upload file lies

- In `/var/lib/umiak-agent/uploads/<uploadId>` if the `path` hint is on the same FS (a VM usually has one disk). On identity change such files are erased along with the state.
- Otherwise — `.umiak-upload-<uploadId>` in the destination directory; the path is recorded in `state.db`, the janitor will find it by the record.
- On `commit` a rename; if `EXDEV` (there was no hint) — a copy into a temporary file in the destination directory, fsync, rename.

### 11.4 `umiak.agent.v1.Filesystem` (Connect unary)

| Method | Fields | Idempotency |
|---|---|---|
| `Stat` | `path, user, no_follow` → `FileInfo` | `NO_SIDE_EFFECTS` |
| `List` | `path, user, depth (1–8, default 1), include_hidden (default true), page_size (≤ 10 000), page_token` → `entries[], next_page_token`. Ordered by path, the cursor is the last path | `NO_SIDE_EFFECTS` |
| `MakeDir` | `path, user, parents, mode, owner`. The directory already exists → success `created=false` | `Umiak-Request-Id` |
| `Move` | `src, dst, user, overwrite`. Across filesystems: files are copied, directories → `failed_precondition cross_device` **[implementer]** | `Umiak-Request-Id` |
| `Chmod` | `path, user, mode?, owner?, group?, recursive` | `Umiak-Request-Id` |
| `Remove` | `path, user, recursive`. No path → success `existed=false` | `Umiak-Request-Id` |

`FileInfo`: `path, name, type (FILE/DIR/SYMLINK/OTHER), size, mode, owner, group, uid, gid, mtime, symlink_target`.

Not in v0 (later, by capability): directory watching (`WatchDir`, like E2B envd).

## 12. Ports and CONNECT

**Discovery.**
- Every 1 s the agent reads `/proc/net/tcp` and `/proc/net/tcp6`: sockets in `LISTEN`, addresses `0.0.0.0`, `::`, loopback, and the VM interface addresses.
- Ports from `[ports] exclude` are not reported. The agent has no TCP listeners.
- The owner (pid, process name, user) is determined by the socket inode through `/proc/*/fd` only when the set of ports changes.
- `System/ListPorts` → `[{port, addresses[], pid, process, user}]`.
- The event `ports.changed` is a full snapshot, with a 2 s debounce.

A known gap: Docker with `userland-proxy=false` publishes ports through iptables without a `LISTEN` socket, and they are not visible. userland-proxy is on by default; accounting via the Docker API is later.

**CONNECT** (S2 §4.2). The agent accepts `CONNECT <host>:<port>` from the gateway:
- `host` is `localhost`, `127.0.0.1`, or empty: the agent tries in turn `127.0.0.1`, `[::1]`, then the VM interface addresses (IPv4 first, then IPv6), 1 s per attempt. A refused connection → the next address. This way a service that listens only on `::1` or only on an interface address is also reachable (this is what S4 expects, a separate `--localhost` flag is not needed). The order may start with the address on which the port is visible in discovery — the result is the same;
- another VM address — connect strictly to it;
- an address not from the VM → `403`; a port outside 1–65535 → `400`; all attempts refused → `502` with `Umiak-Dial-Error: refused` (or `timeout` if at least one attempt or the overall 10 s deadline expired by time);
- the stream is full duplex, half-close via END_STREAM; the sockets belong to the agent and break on its restart (S2 §11).

## 13. System: info, metrics, idle

`umiak.agent.v1.System`:

| Method | What | Idempotency |
|---|---|---|
| `Info` | version (`current`, `previous`), os/arch, kernel, `boot_id`, boot time, `machine_id`, hostname, `sandbox_id`, claim (without secrets), readiness phases, `ssh_host_keys`, quiesce state, update state, `idle_since`, default user | `NO_SIDE_EFFECTS` |
| `Metrics` | CPU (usage over 5 s, core count, load 1/5/15), memory (total, available, used, swap), disks by mount point (total, used, free, inodes), network (rx/tx bytes and rate), the number of processes, running commands, attach streams, and TCP streams | `NO_SIDE_EFFECTS` |
| `ListPorts` | §12 | `NO_SIDE_EFFECTS` |
| `Claim`, `UpdateEnv`, `UpdateSecrets`, `UpdateSshCa` | §8 | `Umiak-Request-Id` |
| `Quiesce`, `Thaw` | §14 | `Umiak-Request-Id` |
| `ApplyUpdate` | §17.4 | `Umiak-Request-Id` |

Capabilities (`Control/Info`, S2 §10.2) are strings: `process.v1`, `process.pty`, `process.stdin`, `files.v1`, `files.upload.v1`, `files.archive.v1`, `system.claim.v1`, `system.quiesce.v1`, `system.update.v1`, `system.ports.v1`, `system.metrics.v1`.

The control plane requests metrics itself when needed; they are not written to the event journal.

**Idle.** Every 10 s the agent considers the VM idle if all of the following hold:
- no running commands (leftovers are not counted, they are caught by the following conditions);
- no attach streams and TCP streams through the tunnel;
- the average CPU load of the whole VM < 5% and network and disk exchange < 16 MiB per minute over `[idle] window` (5 min).

A state change gives the event `idle.changed{idle, since}`. The auto-stop policy is S6's.

## 14. Quiesce and thaw

### 14.1 How this fits with S1

S1 currently implements `QuiesceHook` through QGA `fsfreeze` because the agent does not exist yet. After S3 the worker gets `AgentQuiesceHook` (the main implementation): `freeze()` = `System/Quiesce`, `thaw()` = `System/Thaw`. The QGA path stays as a **fallback** when the agent is not connected or there is no capability `system.quiesce.v1` (Docker is then not paused). The two paths are not used for one machine at the same time: the worker holds a lock on the machine (S6).

### 14.2 `Quiesce{lease_ms = 30000 (≤ 120000), docker = true, fs = true}`

1. If already frozen → `failed_precondition` `already_quiesced` with `lease_id`.
2. Write the lease to `/run/umiak-agent/quiesce.json` (tmpfs): `lease_id`, `deadline`, then along the way — the list of paused containers and frozen mounts.
3. Start the watchdog: the transient unit `umiak-quiesce-watchdog-<lease_id>.service` (`umiak-agent quiesce-watchdog --lease ...`). It waits for `deadline` and lifts the freeze itself (§14.3). Plus a timer inside the agent.
4. Docker: `GET /containers/json` via the unix socket, `POST /containers/{id}/pause` for the running ones (up to 8 in parallel, up to 5 s in total). Each id is written to the lease **before** the pause.
5. Hooks `/etc/umiak-agent/quiesce.d/*` (executable, by name) with the argument `freeze`, up to 5 s each (for DBMSs etc.; an analog of the QGA `fsfreeze-hook`).
6. `sync()`.
7. FIFREEZE (ioctl) on the mount points from `/proc/self/mountinfo`: block `ext4`, `xfs`, `btrfs`, not `ro`.
   - One point per source (device): bind mounts and btrfs subvolumes share a superblock, and a second FIFREEZE would give `EBUSY`.
   - Deeper points first.
   - `EBUSY` on a source that the agent has not frozen yet (frozen by someone else, for example QGA) → rollback and `failed_precondition` `frozen_by_other`.
8. Response: `{lease_id, deadline, paused_containers[], frozen_mounts[]}`.

An error in steps 4–7 → rollback in reverse order and an error. The S1 freeze budget is 10 s from freeze to thaw; Quiesce must fit in 5 s.

### 14.3 `Thaw{lease_id}` and auto-thaw

- `Thaw`: FITHAW in reverse order (`EINVAL`, i.e. not frozen, is normal), hooks with `thaw` in reverse order, `unpause` of containers, stopping the watchdog unit, deleting the lease, flushing buffers to disk.
- Response: `{auto_thawed, auto_thawed_at}`. A repeat, an unknown, or an already lifted lease → success with `already_thawed = true`.
- If `auto_thawed = true` and the auto-thaw time is before the end of the snapshot, the snapshot is only crash-consistent. The worker (S6, through S1) repeats the snapshot or marks it.
- The watchdog at `deadline` does the same as `Thaw` and leaves a marker in `/run/umiak-agent`. By the marker the agent sends `quiesce.auto_thawed{by: watchdog}`.

### 14.4 Agent behavior during a freeze and after a failure

- Any disk write may block at any moment, during its own or someone else's freeze. Therefore all durable writes go through one `state.db` writer. Handlers wait for it within their call's deadline and hold no locks needed by the read paths.
- While the filesystems are frozen by its own lease, the agent **does not write to disk**:
  - `state.db` records (the event journal, `requestId` responses) accumulate in memory (up to 10 000 records or 64 MiB) and are flushed on thaw;
  - events in memory are still **without `seq`**: `seq` is assigned on writing to `state.db`, and `Events/Subscribe` returns only what was written. If the agent crashes during a freeze, these events are lost, but their `seq` will not go to other events. `command.exited` will be restored from `exit.json`, ports and phases will be recomputed;
  - mutations that need a durable write (`Start`, `Claim`, uploads) wait for thaw until their deadline, then `unavailable` `quiesced` (retryable);
  - reads (attach, `GET /files`, `Stat`) work;
  - the agent log is asynchronous and non-blocking: on buffer overflow messages are dropped with a counter. Otherwise journald writing to a frozen FS would stop the agent.
- User processes that write to disk block (as intended); the shim writes PTY output and also waits.
- **The agent restarted during a freeze:** before the first write it sees `quiesce.json` and performs thaw with `by: agent_start`.
- **Someone else's forgotten freeze** (for example, the QGA path with a crashed worker). At startup, and then every 5 s, if there is no lease of its own, the agent in a separate goroutine does a test write with `fdatasync` into the state directory. If it did not finish within 15 s — FITHAW of all block filesystems and the event `quiesce.auto_thawed{by: foreign}`. 15 s is more than the S1 budget (10 s), so a regular QGA snapshot is not affected.
- The emergency command for QGA: `umiak-agent thaw --force` (FITHAW of all and `unpause` of all paused containers).

## 15. Durable state

`state.db` is bbolt (pure Go, works on Windows). Records are protobuf, so an old agent version reads the records of a new one (unknown fields are ignored, §17.5).

| Bucket | Key → value |
|---|---|
| `meta` | schema version, `identity` (a reference), `last_seq`, `acked_seq`, update state, `pty_detached_at` |
| `commands` | `command_id` → the command record |
| `requests` | `requestId` → `{procedure, request_hash, code, response, expires_at}` |
| `events` | `seq` (big-endian) → the event envelope (S2 §9.6) |
| `uploads` | `uploadId` → `{temp_path, size, created_at, last_activity, commit_result?}` |
| `claim` | claim without secrets, `secretsDigest` |

**The `requestId` cache** (S2 §9.2). A Connect interceptor on mutating methods:
- hash = sha256(procedure + request body);
- TTL 24 h, up to 10 000 records (on overflow the oldest are deleted);
- responses larger than 1 MiB are not cached: only the hash and the code are stored;
- a parallel duplicate waits for the first call (in-memory singleflight).

**The event journal** (S2 §9.6):
- `seq` is monotonic across agent restarts, starting from 1 after an identity change. It is assigned in the write transaction; `EventJournal.Read` (an interface of `libs/tunnel`) returns only written events;
- `Events/Ack(seq)` deletes records up to `seq`;
- the limit is 100 000 events or 64 MiB; on overflow the oldest are deleted and `journal.gap{from_seq, to_seq}` is written. On receiving it the control plane reconciles through `Process/List` and `System/Info`;
- event writes are batched into one bbolt transaction (an fsync per transaction).

## 16. Events (type → payload)

Payloads are messages from `proto/umiak/agent/v1/events.proto`, in the S2 envelope (`protobuf Any`). This is the agent-side answer to the open question of S2 §19; S6 will add its own types.

| Type | Payload | When |
|---|---|---|
| `agent.started` | `version, previous_version, boot_id, reason (boot / restart / update / rollback)` | at every agent start |
| `identity.reset` | `machine_id` | the first event after an identity change |
| `command.exited` | `command_id, status, code, signal, reason, stdout_end, stderr_end, pty_end, ended_at` | a command exit, including `LOST` after a reboot |
| `readiness.changed` | `phase, state, error` | a phase change |
| `claim.applied` | `sandbox_id` | claim performed |
| `ports.changed` | the full list of ports | a change of the set, 2 s debounce |
| `idle.changed` | `idle, since` | an idle change |
| `quiesce.auto_thawed` | `lease_id, at, by (watchdog / agent_start / agent_stop / foreign)` | auto-thaw |
| `disk.low`, `disk.ok` | `mount, free_bytes` | the threshold of §10 |
| `update.result` | `from, to, ok, rolled_back, error` | after an update or rollback |
| `journal.gap` | `from_seq, to_seq` | journal overflow |
| `output.truncated` | `command_id, stream, reason (disk_full)` | the shim could not write part of the output (`ENOSPC`/`EDQUOT`); once per stream, the agent learns on connecting to the shim or at the command's exit |

`command.started` is not needed: the command is created by the control plane, which knows about it from the `Start` response.

## 17. Installation, units, update, recovery

### 17.1 Package

`umiak-agent-<version>-linux-<arch>.tar`:
- `umiak-agent`;
- `manifest.json`: `{format: "umiak-agent-manifest/v1", version, os, arch, files: {name: sha256}, created_at}`;
- `manifest.sig` — an ed25519 signature over the bytes of `manifest.json`;
- `trust/tunnel-ca.pem` — the tunnel CA bundle, current and next (S2 §5.4);
- `trust/update-keys.pub` — the update keys, current and next.

Installation into the template (S5) and updating go the same way: `umiak-agent install-package <tar>` verifies the signature and lays the package out in `versions/<v>`. The initial installation trusts the keys baked into the installer (built from the repository) or, instead of them, the keys from `--trust-keys <update-keys.pub>`: they are passed by the template builder over its trusted build channel (seed/ISO) — the keys with which it itself verified the package signature (the homelab installer signs packages with its own key, which is not in the released binary). The flag is allowed only without a current version; updates are verified only with the keys of `current/trust`.

### 17.2 Units

```ini
# umiak-agent.service
[Unit]
Description=umiak guest agent
After=network-online.target umiak-identity.service
Wants=network-online.target umiak-identity.service
OnFailure=umiak-agent-rollback.service
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
Type=notify
ExecStart=/usr/local/lib/umiak-agent/current/umiak-agent run
Restart=always
RestartMode=direct
RestartSec=1
TimeoutStartSec=90
TimeoutStopSec=15
OOMScoreAdjust=-900
MemoryMin=64M
CPUWeight=500
IOWeight=500

[Install]
WantedBy=multi-user.target
```

- `RestartMode=direct` (systemd ≥ 254): an automatic restart bypasses the failed state, so `OnFailure=` (rollback) fires only after `StartLimitBurst` is exhausted, not on the first crash.
- `TimeoutStartSec=90`: the start up to `READY=1` may wait for the identity fallback paths (up to 60 s), so the deadline is higher with a margin; set explicitly so as not to depend on the image's `DefaultTimeoutStartSec`. A version that hangs at startup is killed after 90 s. The agent arms the update confirmation deadline (§17.4) right after the Startup quiesce, before the slow startup steps: a new version that hangs is rolled back by deadline, and a restart after it immediately returns `current` to the old version.
- `OOMScoreAdjust=-900`, not -1000 (as in boat): under memory shortage the kernel kills user tasks first, but the agent cannot bring the VM to a panic.
- `umiak-agent-rollback.service` is a oneshot `/usr/local/lib/umiak-agent/previous/umiak-agent rollback` (if there is no `previous` — from `current`). The behavior is described in §17.4.
- `umiak-cmd.slice` is the shared slice of commands (a place for future limits).
- `umiak-identity.service` — §7.2.

### 17.3 Signature

- An ed25519 key. **PoC:** the key is generated locally and stored outside the repository (`~/.config/umiak/update-signing/`). The public keys (current and next) are pinned in `trust/update-keys.pub`.
- **Production:** the signing key is held by CI, certified by an offline root. Decided in S12.
- Rotation: the next key is pinned in advance, a package signed with the current key brings a new `trust/` pair.
- The signing tool is a subcommand of the release utility in `services/guest-agent` **[implementer]**.

### 17.4 Self-update

1. The control plane uploads the package through `/files/uploads` (§11.2) with the hint `path=/var/lib/umiak-agent/staging/` and calls `System/ApplyUpdate{upload_id}` (with `Umiak-Request-Id`). The agent downloads nothing itself: the VM's outbound access is needed only for the tunnel.
2. The agent unpacks the package into `staging/<v>` and checks:
   - the signature with the keys from `current/trust`;
   - the sha256 of files;
   - `os` and `arch`;
   - that `version` ≠ the current one. Rolling back to an old signed version is allowed: that is the control plane's decision.
3. Move into `versions/<v>` and run `versions/<v>/umiak-agent selftest --schema <N> --shim-protos <list>` (up to 10 s). Selftest checks the config and the trusted material, and that the new version supports the current `state.db` schema and the protocols of the live shims. Selftest does not open `state.db` itself: the running agent holds the exclusive bbolt lock on it.
4. Write `pending-update.json` `{from, to, deadline = now + 120 s}` (fsync). Switch `previous` → `from`, `current` → `to` (an atomic symlink replacement via rename).
5. Respond and exit with code 0 after sending the response; systemd restarts the agent (`Restart=always`) already in the new version.
6. The new agent sees `pending-update.json`, connects to the tunnel:
   - the first `101` and a served `Control/Info` → confirmation, `update.result{ok}`;
   - did not connect before `deadline` → return `current` to `from`, exit; the old version writes `update.result{rolled_back}`;
   - crashes in a loop → `StartLimitBurst` → `OnFailure` → `umiak-agent-rollback.service`.
   - `umiak-agent rollback`:
     - `pending-update.json` exists → `current` = `from`, `previous` is not changed. The version `to` is written to `bad-versions`: the control plane will repeat it only with an explicit flag. The file is deleted, the event `update.result{rolled_back}` goes out at the next start;
     - no `pending-update.json` (a long-stable version crashes: a bug, a full disk) → does not touch versions and waits 30 s;
     - in both cases then runs `systemctl reset-failed umiak-agent` and `systemctl start umiak-agent`. The agent restarts endlessly with a pause, versions are not switched back and forth;
     - `rollback --to <v>` (manually via QGA) switches to the given version from the already installed ones.
7. Commands and PTYs are unaffected: shims live in their own units and run from their own version directories. `current`, `previous`, and versions with live shims are kept; the janitor deletes the rest.

If the tunnel is unavailable for a reason unrelated to the update, the rollback will fire in vain. This is safe: the control plane will repeat the update later.

### 17.5 State compatibility

- The `state.db` schema within a major only grows (new buckets and fields). An old version after a rollback works with a database written by a new one.
- A breaking change is a new agent major with a migration and no rollback below it (the manifest will specify `min_rollback_version` — when needed).
- The shim protocol: §9.6.

### 17.6 Recovery through the QEMU guest agent

QGA (S1) is a fallback channel when there is no tunnel. Through the PVE API `agent/exec` (the S1 token has the rights `VM.GuestAgent.Unrestricted`):

| Command | Why |
|---|---|
| `umiak-agent doctor --json` | versions `current`/`previous`, unit states, identity (without BS), tunnel state and recent errors (from `/run/umiak-agent/status.json`, which the agent updates every 5 s), quiesce, free space |
| `journalctl -u umiak-agent -n 500 --no-pager` | the log |
| `systemctl restart umiak-agent` | restart |
| `umiak-agent rollback [--to <v>]` | rollback to an available version |
| `umiak-agent thaw --force` | emergency thaw |
| `umiak-agent install-package <path>` | installing a package uploaded via QGA `file-write` in chunks into `/var/lib/umiak-agent/staging/` |

An agent below the security minimum version (`426`, S2 §5.3): warm machines are retired (S6), on busy ones the package is uploaded through QGA and installed with `install-package`. Further — `recover` (a VM reboot).

## 18. Portability (for S9)

Everything OS-dependent is behind interfaces, files `*_linux.go` / `*_windows.go`. CI builds `GOOS=windows CGO_ENABLED=0` from day one.

| Interface | Linux (S3) | Windows (S9, as built; packages in `services/guest-agent/internal/`) |
|---|---|---|
| `Supervisor` (launching a command unit, lookup, kill) | a systemd transient service via D-Bus + shim, cgroup v2 | `supervisor/windows.go`: the shim is launched with `CREATE_BREAKAWAY_FROM_JOB \| DETACHED_PROCESS`, the spec on stdin, readiness is the line `READY`; liveness is the mutex `Global\umiak-shim-<id>`, the command is a permanent job `Global\umiak-cmd-<id>` (`winproc/job_windows.go`, `NtCreateJobObject` + `OBJ_PERMANENT`); the shim is `shim/*_windows.go` |
| IPC agent ↔ shim | AF_UNIX, shimproto | the same: AF_UNIX `run\cmd\<id>.sock`, shimproto unchanged |
| `PTY` | `creack/pty` | ConPTY (`winproc/conpty_windows.go`) |
| Command line | `argv` as is, `shell` = `bash -lc` (`-c` without login) | `wincmd`: MSVCRT rules, `.cmd`/`.bat` via `cmd.exe /d /s /c` (BatBadBut → `unsafe_batch_args`), `shell` = `pwsh -EncodedCommand` with an exit-code epilogue (S9 §12.6) |
| `IdentitySource` (machineId, BS, vmgenid, bootId) | DMI sysfs, `/proc/sys/kernel/random/boot_id`; no vmgenid | `ident/source_windows.go`: `GetSystemFirmwareTable('RSMB')` (`ident/smbios.go`), bootId = UUIDv5(machineId, the `BootId` counter in the registry), fallback — a volatile registry key; vmgenid is not read |
| `IdentityResetter` | machine-id, host keys, hostname | `ident/{apply,reset,early,seal}_windows.go`: `MachineGuid`, host keys of the built-in OpenSSH, the name `UMI<12 hex>`, the `user` password only on a template clone; `identity apply --specialize`, `early` (the startup script `umiak-early.cmd`) |
| `Quiescer` | Docker pause + FIFREEZE | `quiesce/{freeze,hooks}_windows.go`: only the hooks `quiesce.d\*.ps1` and cleaning of secret files; the filesystem is frozen by QGA VSS from the worker |
| `PortScanner` | `/proc/net/tcp{,6}` | `ports/scan_windows.go`: `GetExtendedTcpTable` every 1 s, a process filter (`ports/filter.go`) |
| `Metrics` | `gopsutil` | `gopsutil` |
| `Credentials` | uid/gid/groups (`os/user` without cgo) | `process/users_windows.go`, `winapi/{logon,lsa,profile}_windows.go`: `LogonUserW` + the linked elevated token, the password from the LSA secret `L$umiak_user`; `root` = `SYSTEM` |
| `SecretStore` | tmpfs `noswap` | `claim/secrets_windows.go`, `claim/acl_windows.go`: `C:\ProgramData\umiak\secrets\files`, ACL SYSTEM + `user`, `FILE_ATTRIBUTE_TEMPORARY`, overwriting with zeros before deletion; `secret_env` and file content are in memory only |
| `ServiceManager` | systemd D-Bus | SCM (`x/sys/windows/svc`, `update/service_windows.go`, `cmd/umiak-agent/service_windows.go`) |
| Version switching | `current`/`previous` symlinks | NTFS junctions (`update/junction_windows.go`) |
| `OutputStore` (hole punching) | `fallocate PUNCH_HOLE` | sparse files: `FSCTL_SET_SPARSE`, `FSCTL_SET_ZERO_DATA` in 64 KiB steps, `FSCTL_QUERY_ALLOCATED_RANGES` (`output/store_windows.go`) |
| Files | POSIX | `files/*_windows.go`: paths `C:\…`, `mode`/`owner` are synthesized, `file_in_use` (S9 §12.9) |
| Local sockets | `--debug-listen` (tests) | `run\admin.sock` (SYSTEM + Administrators, clients `exec`, `call`), `run\env.sock` (`env --format pwsh`) — `agent/localsock_windows.go` |

The Windows package: `umiak-agent-<v>-windows-amd64.tar` with `umiak-agent.exe` (`umiak-release pack --os windows`, `infra/templates/agent-package.sh --os windows`). Differences and implementation decisions — S9 §24.

## 19. Proto

`proto/umiak/agent/v1/`: `process.proto`, `filesystem.proto`, `system.proto`, `events.proto`, `common.proto` (`FileInfo`, `CommandInfo`). Conventions of S2 §10: additions only, `buf breaking`; `idempotency_level` on methods as in the tables of §9.1, §11.4, §13; errors are Connect codes + `ErrorDetail{code, retryable}` from `umiak.tunnel.v1`.

The agent's `ErrorDetail.code` values: `already_exists`, `command_not_found`, `command_exited`, `too_many_commands`, `start_failed`, `user_not_found`, `path_not_found`, `is_directory`, `not_directory`, `no_space`, `cross_device`, `upload_offset_mismatch`, `checksum_mismatch`, `identity_not_ready`, `already_claimed`, `not_claimed`, `quiesced`, `already_quiesced`, `frozen_by_other`, `signature_invalid`, `update_in_progress`, `shim_outdated`.

Added in S9 (Windows): `unsupported_signal`, `unsafe_batch_args`, `file_in_use`, `secrets_in_use`, `secrets_pending`, `fs_freeze_unsupported`, `desktop_not_ready`. S9 proto fields (additions only): `CommandSpec.desktop`, `ClaimResponse.hostname_applied` (always `true` on Linux), `QuiesceRequest.wipe_secret_files`, `PrepareStopResponse.secret_files_wiped` (`true` on Linux after a successful wipe). The capability `system.quiesce.wipe_secrets.v1` is declared only by the Windows agent.

The generated code is placed as in the S2 implementation: Go in `libs/proto` (`github.com/belov38/umiak/libs/proto/umiak/agent/v1`), TS in `packages/proto`.

## 20. Template requirements (S5)

- Ubuntu 26.04 (the S1 template `ubuntu-2604-dev-tpl`), systemd ≥ 257: `systemd.machine_id=firmware` in the kernel cmdline. Then machine-id = `product_uuid` = `machineId` from PID 1 itself; `umiak-identity` accounts for this (§7.2). Kernel ≥ 6.4 for `tmpfs noswap`.
- **No swap** (no partition and no swap file): secrets are in process memory.
- The user `user` (uid 1000), groups `sudo` and `docker`, `/etc/sudoers.d/90-umiak-user`: `user ALL=(ALL) NOPASSWD:ALL`; `loginctl enable-linger user`.
- sshd: `ListenAddress 127.0.0.1` and `::1`, `PasswordAuthentication no`, `TrustedUserCAKeys /etc/ssh/umiak_user_ca.pub`. The template's CA keys (if any) in `/etc/umiak-agent/ssh-user-ca.pub`. In `/etc/pam.d/sshd` — the two `pam_env` lines from §8.2.
- cloud-init is disabled after the build (`/etc/cloud/cloud-init.disabled`) or the modules `ssh`, `set_hostname`, `update_hostname`, `users-groups` are turned off: the identity is owned by the agent. The network is netplan with DHCP by name (`en*`), not by MAC. The cloud-init disk from S1 is harmless then.
- Docker (userland-proxy by default), `qemu-guest-agent`, OpenSSH.
- The agent: `umiak-agent install-package`, `agent.toml`, units enabled; the last build step is `umiak-agent seal` (§7.3).

## 21. Acceptance

Where tests run **[implementer]**:
- **Unit:** fakes of the §18 interfaces; storage, retention, the `requestId` cache, the journal, smbios parsing, the CONNECT address order.
- **Linux integration in CI:** on the VM of a GitHub Actions runner (where systemd is PID 1 and sudo exists) under the tag `integration`: transient units and the shim, cgroup, PTY, agent restart, hole punching, FIFREEZE on ext4 in a loop image, Docker pause.
- **The `pve` stand:** a real VM from the S5 template (or S1 599 with the agent installed).
- **Windows:** cross-compilation only (S9).

Checks on the stand:

1. **Commands.** `Run`: output byte for byte (sha256), the exit code; `echo x >/dev/stderr` and `>/dev/stdout` as `user` and as root work and do not corrupt the log. A repeated `Start` with the same `command_id` (including after a SIGKILL of the agent between the write and the response) — the marker file is created exactly once. A different spec with the same id → `already_exists`.
2. **Agent restart** (`systemctl restart`, `SIGKILL`) and **self-update** during a 20-minute command and an open PTY: the command is alive, attach continues by offset, `exit` is right, the PTY with the same scrollback.
3. **Update rollback:** a package with a binary that exits at once with code 1 → via `StartLimitBurst` a rollback to the previous version, `update.result{rolled_back}`. A package with a wrong signature → `signature_invalid`, nothing changes.
4. **Reboot:** running commands → `LOST/REBOOT`, their output is readable; secrets are gone, phase `secrets: pending`; `UpdateSecrets` returns `ready`.
5. **PTY:** resize, input with duplicate `seq` (a repeat is not applied twice), closing after 10 min without a client, still alive at 9 min.
6. **Leftovers:** `sleep 1000 &` survives the command's exit, `has_leftovers = true`; `Kill` kills it. `on_exit: KILL_LEFTOVERS` kills at once.
7. **Timeout and OOM:** `timeout_ms` → `KILLED/TIMEOUT`; a process exceeding memory → `KILLED/OOM`, the agent is alive.
8. **Retention:** a command writes 1 GiB to stdout → the space taken by the command ≤ 128 MiB + 1 s of writes; attach from 0 gets `truncated`, the offsets agree with the file size.
9. **Files:** a `Range` download of 1 GiB with a break and resumption (sha256); a chunked upload with a break, `HEAD`, continuation, `commit` twice → one result; `sha256` mismatch → `422`. Archive: a directory with nested directories, symlinks, a hardlink, and a 1 GiB file — `GET /files/archive` and `PUT /files/archive` into another directory give the same sha256, modes, and symlink targets; an archive with `../x`, `/etc/x`, a write through a symlink to `/etc`, and a device → `invalid_path`, nothing is created outside `path`; 200 001 entries → `413`.
10. **Ports:** `python3 -m http.server` on `127.0.0.1`, `::1`, `0.0.0.0`, and the interface address → `ports.changed` within ≤ 3 s; CONNECT to `localhost:<port>` works in all four cases; CONNECT to a neighboring VM → `403`.
11. **Quiesce:** with a write to a file and in a Docker container `Quiesce` → the write blocks, an S1 snapshot, `Thaw`; a fork from the snapshot boots, the data is consistent. Without `Thaw` → auto-thaw no later than `deadline + 5 s`, an event. `SIGKILL` of the agent during a freeze → thaw at its start. A QGA freeze with a "forgotten" thaw while the agent is running → the agent thaws after 15–20 s.
12. **Identity:** a fork → new machine-id, host keys, hostname, empty agent state, `seq` from 1, `identity.reset` as the first event, a different IP; the source VM is unaffected.
13. **Claim and env:**
    - env from claim is visible in agent commands, in the SSH login shell, and in `ssh host env` (non-login) — through the S4 gateway or through a local `ssh` with a CA certificate;
    - env from the spec overrides the claim env;
    - `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` is set;
    - a CA change via `UpdateSshCa` takes effect without restarting sshd.
14. **Secrets not on disk:** a unique secret string from `secret_env`, `secret_files`, and the command env is not found by a search over the VM's block device (`grep -a` over the LV snapshot) after `sync`; there is no swap in the VM or `noswap` is verified.
15. **Memory:** the agent's idle RSS < 40 MiB, shim < 8 MiB.
16. Joint acceptance of S2 §14 (chaos, drain, perf, terminal) with S4.

## 22. Interfaces to other areas

- **S1:** `AgentQuiesceHook` is the main implementation of `QuiesceHook`, QGA fsfreeze is the fallback (§14.1). Smbios per S2 §5.2. QGA exec for recovery (§17.6).
- **S2 / `libs/tunnel`** (the `s2-impl` plan, package `libs/tunnel/agent`). The agent fills `agent.Config`:
  - `Handler` — Connect `umiak.agent.v1` and `/files/*`;
  - `Journal` — `EventJournal` on top of `state.db` (§15);
  - `Info` — capabilities (§13);
  - `Credentials` — smbios (§7.1);
  - `Identity` — `bootId`, `agentInstanceId`, version; `Vmgenid` is empty on Linux.

  CONNECT is served by the library itself with the `LocalOnly` policy. For the address order of §12 **an addition to S2 is needed**: a field `Dial func(ctx context.Context, host string, port int) (net.Conn, error)` in `agent.Config`. With `nil` the dial is direct, as now; a `Dial` error → `502`. Answers to the open questions of S2 §19: retention — §10, agent event types — §16.
- **S4:** the CONNECT address order (§12); sshd only on loopback with `TrustedUserCAKeys` from claim (§8.3); host keys in `System/Info`; `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` in the default env.
- **S5:** the requirements of §20, `umiak-agent seal`, `install-package`.
- **S6:**
  - claim when issuing from the warm pool; `UpdateSecrets` after every boot (by `agent.started{reason: boot}` or the phase `secrets: pending`); claim for a fork with the source's env;
  - a lock on the machine for quiesce, handling `auto_thawed`;
  - the update policy: a package when the version is below the desired one; retiring warm machines with an old agent;
  - consuming the events of §16; auto-stop by `idle.changed`;
  - `degraded` and `journal.gap` → reconciliation via `List`/`Info`.
- **S7:** the public commands (sync / stream / detached / attach / kill / list), files, ports, env/secrets on top of these RPCs.
- **S9:** the interfaces of §18.
- **S12:** the production signing key (CI + offline root), rotation of the tunnel CA through agent packages.

## 23. Libraries

Project rule: the latest stable versions, re-check before adding (`go list -m -versions`). Checked 2026-10-29:

| Purpose | Module | Version |
|---|---|---|
| Go toolchain | `mise.toml` | go 1.27.3 |
| Tunnel, Connect, protobuf, WebSocket, HTTP/2 | `libs/tunnel` and its dependencies (S2 §17): `connectrpc.com/connect`, `google.golang.org/protobuf`, `github.com/coder/websocket`, `golang.org/x/net` | v1.21.1, v1.36.12, v1.8.15, v0.62.0 |
| systemd D-Bus (transient units, properties), sd_notify | `github.com/coreos/go-systemd/v22` (on top of `github.com/godbus/dbus/v5`) | v22.7.0, v5.2.4 |
| PTY | `github.com/creack/pty` | v1.1.24 |
| State | `go.etcd.io/bbolt` | v1.5.0 |
| inotify | `github.com/fsnotify/fsnotify` | v1.10.1 |
| Metrics | `github.com/shirou/gopsutil/v4` | v4.26.9 |
| ioctl FIFREEZE, fallocate, cgroup, Windows API | `golang.org/x/sys` | v0.49.0 |
| ed25519 is in the stdlib; SSH formats if needed | `golang.org/x/crypto` | v0.58.0 |
| Config | `github.com/pelletier/go-toml/v2` | v2.4.3 |

The Docker Engine API is plain HTTP calls over the unix socket via the stdlib, without the Docker SDK (fewer dependencies).

## 24. Left to the implementer

- The structure of the Go packages inside `services/guest-agent` and the shape of the §18 interfaces.
- The format of the shim protocol messages (length-prefixed protobuf is the recommendation).
- The implementation of signing and the release utility; the tar format (with or without zstd).
- The exact order of CONNECT addresses when the listener is known (the semantics of §12 are mandatory).
- Janitor details (frequency, order) provided the limits of §10 are met.
- Batching of bbolt writes.
- The concrete values of `GOGC`/`GOMEMLIMIT` for the shim.

## 25. Open questions

- Docker ports with `userland-proxy=false` — via the Docker API (later).
- `WatchDir`, per-command resource limits, a list of all OS processes (`ps`) — on S7's request.
- A copy of command output outside the VM (history after the sandbox is deleted) — phase 2 (architecture §3).
- Principals of SSH certificates (`user`, `root`) — S4.
- The production signing key and the offline root — S12.
