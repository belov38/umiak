# S5. Linux template: specification

> Historical record: references below to `infra/pve` describe the retired PoC host-preparation path.
> For supported installation and host preparation, use the [Proxmox installer](../getting-started.md#install-on-proxmox);
> for added-node checks and preparation, use the [installer node console](../operations-multi-node.md).

> S17 update (2026-11-03): `windows` now includes desktop; `windows-desktop` is a compatibility alias. VM 598 is retired and read-only; VM 595 is the active Windows build. Historical build notes below do not authorize template mutations. See [S17](s17-windows-single.md).

Status: agreed (master session), 2026-10-29; implementer review passed, remarks incorporated. Supplemented with the MVP recommendations R5, R6 (`docs/roadmap-phase2.md` §6, decisions of the master session 2026-10-29). Area S5 from `docs/roadmap.md`. Architecture: `docs/architecture.md` (§4 agent, §5 storage, §6 warm pool). Relies on `docs/specs/s1-proxmox-foundation.md` (primitives, `packages/pve`, `umiak-bench`), `docs/specs/s3-guest-agent.md` (§7.3 `seal`, §17 package, §20 template requirements), `docs/specs/s6-control-plane.md` (§5.2 `template_builds`, §9 warm pool, §14.3 registration), `docs/specs/s2-tunnel-protocol.md` (§5.2 smbios, §5.4 TLS).

The decisions in the question sections 1–4 were agreed with the master session on 2026-10-29. The mark **[S5]** is a decision of the spec author within what was agreed; it can be changed without new agreement if the reason is recorded.

## 1. Why, and what counts as success

The `linux` template is the disk from which S1 makes a thin clone for each machine. The warm pool refill time and cold start, the correctness of fork identity (S3), security (no foreign services and keys in the image), and the agent's and user's having something to work with depend on it.

Success:
1. One command from the Mac builds the template from the official Ubuntu image, verifies it with a clone, and registers it. A person inside the VM does nothing.
2. The build is repeatable: the same recipe, `versions.toml`, base image number, and apt snapshot give the same set of packages and tool versions.
3. A new build rolls out to the warm pool without downtime and rolls back with a repeated `promote`; sandboxes and saved snapshots on old builds are not affected.
4. Clone boot on `pve`: median from start to a QEMU guest agent answer ≤ 8 s, to agent readiness ≤ 10 s (`umiak-bench s5`, compared with 599).
5. The pipeline is the same for `linux-desktop` (S10) and Windows (S9): the recipe, the source, and the sealing method change, not the builder.

## 2. Goals, non-goals, anti-goals

**Goals:** the `linux` v1 recipe and its content; the `umiak-tpl` builder (TS, on top of `packages/pve`); build verification; the manifest and registration in `template_builds`; versions, rollout, rollback, and garbage collection; boot optimization and the `umiak-bench s5` scenario; overriding the tunnel URL via `smbios1`; the move from template 599; the list of changes to S1/S2/S3/S6.

**Non-goals:** agent internals (S3); Proxmox primitives and the driver (S1, here only requests for small changes, §17); pool and state logic (S6); the desktop (S10); Windows (S9), except the extension points (§16); OS updates in already created sandboxes (their disks are their own; the agent updates itself, S3 §17.4); scheduled rebuilds in CI (later, S12).

**Anti-goals** (a failure even if everything works):
- the image contains a foreign or extra network service (tailscaled, avahi, cups, a VMware agent, etc.), a port open outward, or a password/key for login;
- two clones of one template share the machine-id, SSH host keys, random seed, the systemd `credential.secret`, or the agent's state;
- build secrets remain in the image (the agent signing key, tokens, build logs with them);
- a clone with a different MAC is left without a network or waits for `wait-online` until the timeout;
- a hard stop (the regular one in S6) adds a delay to the next boot (GRUB recordfail, fsck prompts);
- deleting an old build breaks a running sandbox, saved snapshot, or fork;
- the build depends on template 9000, on manual actions on the host, or on root SSH.

## 3. Constraints

- Host `pve`: Proxmox VE 9.2.21, kernel 7.0.14, `local-lvm` (VG `pve`, thin pool `data`, QLC). PoC: VMID 500–599, the RAM of all platform VMs ≤ 8 GB, network `umiak0` (S1 §4.3) with internet egress and no LAN access.
- The builder's access to the host is only the token `umiak@pve!dev` through the PVE API and (if needed) `umiak-node`. Root SSH and changing host files by the builder are not used. New rights are only those listed in §17.1.
- The network `umiak0` is closed: one cannot reach the guest by IP from the Mac. Therefore the build is driven through the QEMU guest agent (QGA), not SSH.
- Tools through mise. All versions are the latest stable at build time (`umiak-tpl versions --update`, §6.3), recorded in `versions.toml` and the manifest.
- Checked 2026-10-29: Ubuntu 26.04.1 LTS (`resolute`) is the current LTS; 26.10 is out but not an LTS. The minimal cloud image `release-20261024` (310 packages, 420 MB) and the regular server image `release-20261017` (678 packages): systemd 259.9, kernel 7.0.0-38, dracut 110, cloud-init 26.2, OpenSSH 10.2p1. Node 26.13.0 is LTS "Lithium" since 2026-10-28.

## 4. Overview

```
 Mac (PoC) / later a Kubernetes Job
 +-------------------------------------------------------------+
 | umiak-tpl build linux                                         |
 |  1 fetch base image + SHA256SUMS(.gpg), verify, cache       |
 |  2 render seed ISO (cidata): user-data, meta-data,          |
 |    network-config, build/ (steps, files, agent package)     |
 |  3 upload image (local:import) and ISO (local:iso)  --------+--> PVE API
 |  4 allocate VMID (purpose=template), create build VM:       |
 |    scsi0 import-from image, resize 64G, ide2 = seed ISO,    |
 |    net0 in umiak0 + firewall umiak-egress                       |
 |  5 start, wait QGA; run steps as systemd units via QGA,     |
 |    stream logs by offset (file-read); reboot after base     |
 |  6 cleanup + umiak-agent seal + fstrim, poweroff              |
 |  7 detach ISO, convert to template (base-<vmid>-disk-0)     |
 |  8 verify: S1 create from template, boot, checks, hard      |
 |    stop + start, delete                                     |
 |  9 manifest -> registry (status ready); promote separately  |
 +-------------------------------------------------------------+
```

The build always starts from a clean official image. The template is the build VM itself, turned into a template in place (the same VMID).

## 5. Recipe

The recipe is data in the repository, the builder is code. The directory `infra/templates/<slug>/` **[S5]**:

```
infra/templates/
  keys/ubuntu-cloud-images.asc     # pinned signing key for SHA256SUMS.gpg
  linux/
    template.yaml                  # recipe: source, hw, steps, seal, verify profile
    versions.toml                  # pinned versions and checksums (§6.3)
    seed/user-data.tmpl, meta-data.tmpl, network-config
    steps/00-base.sh 10-system.sh 20-docker.sh 30-toolchains.sh
          40-coding-agents.sh 50-umiak-agent.sh 90-cleanup.sh
    files/                         # config files copied by the steps (§8)
```

`template.yaml` (the form is refined by the builder):

```yaml
slug: linux
os: linux
extends: null                    # linux-desktop: extends: linux (S10)
source:
  kind: cloud-image              # S9: iso-install
  distro: ubuntu
  release: "26.04"
  flavor: minimal
disk: { slot: scsi0, size: 64G }
hw:                              # copied into the template config, S1 whitelist (§9)
  machine: q35
  cpu: host
  bios: seabios
  ostype: l26
  scsihw: virtio-scsi-single
  agent: "enabled=1"
  serial0: socket
  vga: std
  tablet: 0
  rng0: "source=/dev/urandom"
  cloudinit: false               # sandboxes get no cloud-init drive (§17.1)
build_vm: { cores: 4, memory_mb: 4096 }
steps: [00-base, reboot, 10-system, 20-docker, 30-toolchains, 40-coding-agents, 50-umiak-agent, 90-cleanup]
seal: umiak-agent                  # S9: sysprep
boot_timeout_s: 300
vmids: [597, 599]                # template slots, first free wins; not inherited (S9: [598])
```

`reboot` is a built-in builder step: after the kernel and packages are updated the VM reboots so that the following steps run on the new kernel and the old kernels can be removed.

## 6. Base image and reproducibility

### 6.1 Image

- `https://cloud-images.ubuntu.com/minimal/releases/resolute/release-<serial>/ubuntu-26.04-minimal-cloudimg-amd64.img`. The serial is pinned in `versions.toml` (`base.serial`, `base.sha256`).
- The builder downloads the image, `SHA256SUMS`, and `SHA256SUMS.gpg`, verifies the signature with the pinned key from `infra/templates/keys/` (the `openpgp` library, no system gpg) and the image sha256. Cache on the builder machine: `~/.cache/umiak/images/`.
- In Proxmox the image is uploaded once per serial: `local:import/umiak-ubuntu-26.04-minimal-<serial>.qcow2` (`POST /nodes/{node}/storage/local/upload`, `content=import`, `checksum` sha256: Proxmox verifies it itself). If such a file already exists and the sha256 matches, the upload is skipped.
- Why minimal: half the packages, no extra services that would then have to be turned off. What is missing (man, vim, etc.) is installed by the `00-base` step. `unminimize` is not run.
- Why not 9000 and not 599: 9000 is Ilia's personal dev template (user `ib` with uid 1000, `tailscaled`, snapd, ufw, open-vm-tools, unattended-upgrades, three kernels). In 599 the network is bound to the build VM's MAC (`50-cloud-init.yaml`, `match: macaddress`), and `systemd-networkd-wait-online` waited the full 2 minutes. The fix for 599 was passed to `s1-impl` (§15).

### 6.2 Ubuntu packages

- During the build the apt sources point to an archive snapshot: `Snapshot: <ts>` in `/etc/apt/sources.list.d/ubuntu.sources` (`snapshot.ubuntu.com`, format `20261029T000000Z`), the value `apt.snapshot` from `versions.toml`. The same snapshot is used when installing `qemu-guest-agent` from `user-data`.
- In the `90-cleanup` step the sources return to the regular archive without a snapshot, the package lists are deleted: the user in a sandbox runs `apt update` and gets current packages.

### 6.3 `versions.toml`

One file per recipe, committed. An example of the form:

```toml
[base]
serial = "20261024"
sha256 = "..."

[apt]
snapshot = "20261029T000000Z"

[docker]           # apt repo download.docker.com, exact versions with =
docker_ce = "5:29.x.y-1~ubuntu.26.04~resolute"
containerd_io = "..."
compose_plugin = "..."
buildx_plugin = "..."

[tools]            # tarballs with sha256 from the official checksum files
node = { version = "26.13.0", sha256 = "..." }
go = { version = "1.27.3", sha256 = "..." }
bun = { version = "1.4.4", sha256 = "..." }
uv = { version = "0.13.6", sha256 = "..." }
gh = { version = "2.103.3", sha256 = "..." }
rust = { version = "1.99.1", rustup_init_sha256 = "..." }

[chrome]           # .deb from dl.google.com by exact version, sha256 from the signed repo index
google_chrome_stable = { version = "156.0.8078.73-1", sha256 = "..." }

[npm]              # global CLIs, exact versions; npm checks integrity from the registry
"@anthropic-ai/claude-code" = "2.1.312"
"@openai/codex" = "0.165.0"
"opencode-ai" = "1.19.5"
"@google/gemini-cli" = "0.66.0"
"pnpm" = "12.16.1"

[umiak]              # our CLI (S7 §15.5): linux-x64 binary, sha256 from the release SHA256SUMS
cli = { version = "...", sha256 = "..." }
```

- `umiak-tpl versions linux --update` finds the latest stable versions (a fresh image serial, a snapshot of "now", the latest Node LTS, the latest Go/Rust/Bun/uv/gh/Docker/Chrome, the latest versions of npm packages, the latest release of the `umiak` CLI), downloads the official checksum files, and rewrites `versions.toml`. The values above were checked on 2026-10-29 (`npm view`, Chrome — Google's versionhistory API) and are given as an example; the result of `--update` goes into the commit. Ubuntu packages (JDK, ffmpeg, xdotool) are pinned by the apt snapshot (§6.2) and need no separate line.
- `umiak-tpl build` uses the file as is. `--refresh` = `versions --update` before the build (the usual mode for a new build; the file is committed afterward).
- Reproducibility: the same recipe, `versions.toml`, and git commit give the same package list (`dpkg-query`) and the same tool versions. Bit-for-bit identical disks are not required.

## 7. The `umiak-tpl` builder (`apps/template-builder`)

A TS CLI, uses `packages/pve` (PVE API, `umiak-node`, allocator, machine primitives, VM firewall). The configuration and secrets are the same variables as in S1 §6.1 (`UMIAK_PVE_*`, `UMIAK_NODE_*`, `UMIAK_STATE_DB`, `UMIAK_VMID_RANGE`).

### 7.1 Commands

| Command | What it does |
|---|---|
| `preflight [--node]` | read only: token rights (including upload and read of `local`, §17.1), content `import`/`iso` of `local`, free RAM for the build VM, the ISO tool, the image signing key |
| `versions <slug> [--update]` | show or update `versions.toml` (§6.3) |
| `build <slug> [--node pve] --agent-package <tar> [--umiak-cli <file>] [--api-url <url>] [--tunnel-url <wss-url>] [--ssh-user-ca <file>] [--refresh] [--keep-on-failure] [--no-verify]` | build (§7.2) and verification (§10); the result is a build in the status `ready` |
| `verify <buildId>` | repeated verification (§10) |
| `promote <buildId>` | make the build active (§12.2); the same call for rollback |
| `list [<slug>]`, `show <buildId>` | the registry and manifest |
| `gc [--dry-run]` | garbage collection (§12.4) |
| `cleanup` | leftovers of failed builds: VMs, ISOs, allocator leases |

Step logs are saved locally in `build-logs/<buildId>/` (in `.gitignore`).

### 7.2 Stages of `build`

1. **Preparation.** Read the recipe and `versions.toml`. Verify the agent package on the builder machine with TS code (a linux/amd64 binary cannot be run on a Mac): the ed25519 signature `manifest.sig` over `manifest.json` (`node:crypto`), the sha256 of files, `os/arch = linux/amd64`. The keys are the pinned update public keys from the repository, the same ones baked into the agent installer (S3 §17.1, §17.3; the path is set by the S3 implementation). This is the root of trust of the build: in the guest `install-package` runs the binary from the same package, and its self-check adds nothing. Create a registry entry: `status = building`, `buildId` (UUIDv7), `version` (§11), `build_memory_mb`.
2. **Image** (§6.1): download, verify, upload if not there yet.
3. **Seed ISO** (`cidata`, ISO9660 + Joliet + Rock Ridge, if the tool can):
   - `meta-data`: `instance-id: <buildId>`, `local-hostname: umiak-build`;
   - `network-config`: v2, `match: {name: "en*"}`, `dhcp4: true`;
   - `user-data`: no users and keys (`users: []`, `ssh_pwauth: false`, `disable_root: true`), apt on the snapshot (§6.2), `packages: [qemu-guest-agent]`, `runcmd: systemctl enable --now qemu-guest-agent`;
   - `build/`: steps, `files/`, `versions.toml`, the agent package, the `umiak` CLI binary and `config.json` with `--api-url` (§8.9), `agent.toml` (with the default tunnel URL, §14), the template's SSH CA keys (if passed).

   Tool: `xorriso` (Linux, CI) or `hdiutil makehybrid -iso -joliet` (macOS) **[S5]**. Steps are run as `bash <file>`, so exec bits are not needed on the ISO. Upload: `local:iso/umiak-seed-<buildId>.iso`.
4. **Build VM.** A VMID from the allocator with `purpose=template` (§17.1). `POST /nodes/{node}/qemu`: `name=umiak-tpl-<slug>-<version with dashes>`, `pool=umiak`, `tags=umiak-tpl` (by this tag the S1 cleanup and the S6 reconcile do not touch build VMs and templates, §17.1 item 8, §17.4 item 6), hardware from the recipe's `hw`, `cores`/`memory` from `build_vm`, `balloon=0`, `scsi0=local-lvm:0,import-from=local:import/<image>,discard=on,iothread=1,ssd=1`, `ide2=local:iso/umiak-seed-<buildId>.iso,media=cdrom`, `net0=virtio=<MAC>,bridge=umiak0,firewall=1`, `boot=order=scsi0`, `description` with the buildId and the git commit. Then `PUT resize scsi0 64G` and the firewall as for sandboxes (S1 §4.4). Before start — a RAM check: in the PoC before S6 as in `umiak-bench` (the sum of `memory` of the running pool VMs + the build one ≤ `--ram-cap`, default 8 GB); with S6 — accounting of the `building` row in admission (§17.4).
5. **First boot.** Start, wait for `agent/ping` (up to 10 min: cloud-init installs QGA). In this boot cloud-init expands the root partition to 64 GiB (`growpart`).
6. **Steps.** Each step runs in the guest as a transient unit: `systemd-run --unit=umiak-build-<n> --property=... bash /mnt/seed/build/steps/<n>.sh` (the ISO is mounted at `/mnt/seed` by the first call). Output goes to `/var/log/umiak-build/<n>.log`. The builder polls `systemctl show -p ActiveState,Result,ExecMainStatus` (via `agent/exec`) and reads the rest of the log via `agent/file-read` with `offset` and `count` (the parameters exist in PVE 9.2, checked with `pvesh usage`) every 2 s, printing it to the console. This way a long step does not run into QGA exec timeouts. The `reboot` step: `agent/exec systemctl reboot` (`agent/shutdown` has no reboot mode, and `status/reboot` is a shutdown and a new QEMU start), waiting for a new `boot_id` and `agent/ping`. Steps are written idempotently, but a retry of a build after a failure is always a new build from scratch (the build is one-shot) **[S5]**.
7. **Sealing.** `90-cleanup.sh` (§8.10), then `umiak-agent seal` (S3 §7.3) as the last call, then `fstrim -av`, `sync`, `agent/shutdown` (poweroff), waiting for `stopped`. After `seal` the VM does not boot until it is turned into a template.
8. **Template.** `PUT config` `delete=ide2`, `POST /nodes/{node}/qemu/{vmid}/template`. The disk becomes `base-<vmid>-disk-0`. Delete the ISO via `umiak-node media.remove` (§17.1 item 3).
9. **Verification** (§10), unless `--no-verify`. Success → the manifest (§11) into the registry, `status = ready`.

**An error at any stage:** status `failed` (stage, step, the last 200 log lines in the manifest). Unless `--keep-on-failure`: `stop`, `DELETE /qemu/{vmid}?purge=1&destroy-unreferenced-disks=1`, delete the ISO (`umiak-node media.remove`), release the VMID. The base image in `local:import` stays (a cache).

Expected duration: 10–20 min, mostly apt, Docker, and tools.

## 8. Image content

The requirements of S3 §20 are fully met; below is how. Where it says "mask", the service cannot just be disabled: after sealing, the first boot must not bring it back.

### 8.1 Packages and kernel (`00-base`)

- `apt full-upgrade` from the snapshot, one kernel `linux-image-virtual` (generic flavour); after `reboot` all kernels except the running one are removed.
- Installed: `build-essential`, `pkg-config`, `libssl-dev`, `git`, `git-lfs`, `curl`, `wget`, `ca-certificates`, `gnupg`, `jq`, `ripgrep`, `fd-find` (+ a `fd` symlink), `tmux`, `vim`, `nano`, `less`, `man-db`, `htop`, `rsync`, `unzip`, `zip`, `xz-utils`, `zstd`, `file`, `tree`, `sqlite3`, `make`, `cmake`, `openssh-server`, `openssh-client`, `sudo`, `bash-completion`, `python3`, `python3-venv`, `python3-pip`, `python3-dev`, `openjdk-25-jdk-headless` (the current LTS in `resolute`), `ffmpeg`, `xdotool`, `qemu-guest-agent`, `chrony`, `iproute2`, `iputils-ping`, `dnsutils`, `netcat-openbsd`, `lsof`, `strace`.
- Purged, if present in the image: `snapd`, `apport`, `unattended-upgrades`, `ubuntu-pro-client`, `update-notifier-common`, `landscape-common`, `pollinate`, `fwupd`, `modemmanager`, `multipath-tools`, `open-iscsi`, `udisks2`, `lxd-installer`, `ufw`, `open-vm-tools`, `rsyslog`, `sysstat`, `avahi-daemon`, `cups*`, `tailscale`.
- Masked: `apt-daily.timer`, `apt-daily-upgrade.timer`, `motd-news.timer`, `man-db.timer`, `e2scrub_all.timer`, `systemd-oomd.service` (if present; OOM is the kernel only, the `oom_score_adj` policy is S3's). Kept: `fstrim.timer` (the thin pool gets space back), `logrotate.timer`, `systemd-tmpfiles-clean.timer`, `cron`, `chrony`.

### 8.2 Users and login (`10-system`)

- The user `user`: uid/gid 1000, shell `/bin/bash`, groups `sudo`, `docker` (added in `20-docker`) and `kvm` (§8.6), password locked, `/etc/sudoers.d/90-umiak-user` `user ALL=(ALL) NOPASSWD:ALL` (0440, checked with `visudo -c`), `loginctl enable-linger user`. There is no user `ubuntu` and no other users with uid ≥ 1000. The root password is locked.
- Nobody has `authorized_keys`.
- Locale `C.UTF-8`, time zone `UTC`.

### 8.3 sshd and PAM

- `/etc/ssh/sshd_config.d/10-umiak.conf`: `ListenAddress 127.0.0.1`, `ListenAddress ::1`, `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `PermitRootLogin prohibit-password`, `TrustedUserCAKeys /etc/ssh/umiak_user_ca.pub`. `AuthorizedKeysFile` stays default: there are no `authorized_keys` files in the image, login is by certificate only **[S5]**.
- In Ubuntu 26.04 sshd is started through `ssh.socket`, and the generator takes `ListenAddress` from the config. The check in §10 looks at the actual listening sockets, not only the config.
- `/etc/umiak-agent/ssh-user-ca.pub` — the SSH CA keys from `--ssh-user-ca` or an empty file; `/etc/ssh/umiak_user_ca.pub` is its copy (S3 §5).
- `/etc/pam.d/sshd`: the two `pam_env` lines from S3 §8.2; `/etc/umiak/env` is created empty.
- The host keys are deleted by `seal`; new ones are created by `umiak-identity` on first boot (S3 §7.2). Ubuntu's key generation at sshd start (`sshd-keygen`) must not get ahead of `umiak-identity`: the order is set by the S3 unit (`Before=ssh.service ssh.socket`).

### 8.4 Network, DNS, time

- `/etc/netplan/10-umiak.yaml`: ethernet `en` with `match: {name: "en*"}`, `dhcp4: true`, `dhcp6: false`, `accept-ra: false`. The file `50-cloud-init.yaml` is deleted. There is no MAC binding anywhere.
- `systemd-networkd-wait-online`: drop-in `ExecStart=… --any --timeout=15`.
- `systemd-resolved`: DNS from DHCP (S1 §4.3 hands out `1.1.1.1`), `/etc/systemd/resolved.conf.d/10-umiak.conf` `FallbackDNS=1.1.1.1 9.9.9.9`. This is needed because a sandbox no longer has a cloud-init disk with `nameserver` (§17.1).
- `chrony` by default.

### 8.5 Boot: GRUB, kernel, initrd

- `/etc/default/grub.d/90-umiak.cfg` (after `50-cloudimg-settings.cfg` from the image):
  ```
  GRUB_TIMEOUT=0
  GRUB_TIMEOUT_STYLE=hidden
  GRUB_RECORDFAIL_TIMEOUT=0
  GRUB_DISABLE_OS_PROBER=true
  GRUB_CMDLINE_LINUX_DEFAULT="console=tty1 console=ttyS0,115200n8 systemd.machine_id=firmware quiet loglevel=3"
  ```
  Then `update-grub`. `GRUB_RECORDFAIL_TIMEOUT=0` is mandatory: S6 regularly stops a VM hard, and by default Ubuntu waits in the GRUB menu after an unfinished boot. Additionally `grub-editenv /boot/grub/grubenv unset recordfail` in `90-cleanup`. The check is §10 item 16.
- `systemd.machine_id=firmware` (systemd 259 ≥ 257, S3 §20): machine-id = `product_uuid` = `machineId` from PID 1.
- initrd — dracut by default, boot always through the initrd with `root=UUID=` (this is how 599 boots on the 26.04 image). If the image has `/etc/default/grub.d/40-force-partuuid.cfg` (`GRUB_FORCE_PARTUUID`: an attempt to boot without an initrd with a rollback via `initrdfail` in grubenv), the `10-system` step deletes it and checks that `grub.cfg` does not contain `initrdfail`: a hard stop during the first boot must not switch the next one to a different path. Shrinking the initrd and booting without it are experiments of §13.3, not a requirement.

### 8.6 Kernel and limits

- `/etc/sysctl.d/90-umiak.conf`:
  - `kernel.apparmor_restrict_unprivileged_userns = 0` — unprivileged user namespaces are needed by coding-agent sandboxes (bubblewrap) and rootless tools; the trust boundary is the VM (S3 §4);
  - `fs.inotify.max_user_watches = 524288`, `fs.inotify.max_user_instances = 1024` — dev servers and builders watch files.
- `/etc/systemd/system.conf.d/90-umiak.conf`: `DefaultLimitNOFILE=65536:524288` **[S5]**.
- **KVM in the guest is best-effort, not a platform guarantee in the MVP** (MVP rec. R6). `/dev/kvm` appears only if the host passes virtualization through: `cpu: host` (§9) passes the `vmx`/`svm` flag if on the host the `kvm_intel`/`kvm_amd` module is loaded with `nested=1` (the S1 runbook does not change it, S1 §12). The template enables nothing itself: KVM modules are in the `linux-image-virtual` kernel, udev gives `/dev/kvm` to the group `kvm`, `user` is in it (§8.2). Whether KVM is present in a build is recorded by the check §10 item 19; the API does not promise it.
- No swap: no partition, no file, no zram (`systemd-zram-generator` is not installed). Checked in `90-cleanup` and in §10.

### 8.7 journald

`/etc/systemd/journald.conf.d/90-umiak.conf`: `Storage=persistent`, `SystemMaxUse=256M`, `RuntimeMaxUse=64M`.

### 8.8 Docker (`20-docker`)

- Docker CE, `containerd.io`, `docker-compose-plugin`, `docker-buildx-plugin` from `download.docker.com` (`resolute stable`), versions from `versions.toml`.
- `/etc/docker/daemon.json`: `{"log-driver": "local"}`; the default userland-proxy (S3 §20); the default image store (the containerd snapshotter in Docker 29). Images are not pre-pulled.
- `docker.service` is enabled: the agent's `docker` phase waits for it (S3 §8.5). Socket activation is an experiment of §13.3.

### 8.9 Tools and coding agents (`30-toolchains`, `40-coding-agents`)

Rule: each tool command is found by name from the standard Ubuntu `PATH` (`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`) for `user` — both with a direct exec (argv, S3 §8.2 assembles env without a shell) and in `bash -lc`. For root — where possible.

| Tool | How it is installed **[S5]** |
|---|---|
| Node LTS (+ npm, npx) | official tarball → `/usr/local`; corepack is not part of Node ≥ 25 and is not installed |
| Bun | official zip → `/usr/local/bin/bun` (+ `bunx`) |
| Go | official tarball → `/usr/local/go`, symlinks `go`, `gofmt` in `/usr/local/bin` |
| Rust | `rustup-init` as `user` (`~/.rustup`, `~/.cargo`), the toolchain from `versions.toml`, components `rustfmt`, `clippy`; proxy symlinks (`cargo`, `rustc`, `rustup`, `rustfmt`, `cargo-clippy`, `clippy-driver`) in `/usr/local/bin` |
| Python 3 | system (`python3`, `venv`, `pip`); `uv`, `uvx` → `/usr/local/bin` |
| gh | official tarball → `/usr/local/bin/gh` |
| Claude Code, Codex, OpenCode, Gemini CLI, pnpm | `npm install -g <pkg>@<version>` as root (`/usr/local/lib/node_modules`, bin in `/usr/local/bin`) |
| Java (OpenJDK 25 LTS: `java`, `javac`, `jar`) | apt `openjdk-25-jdk-headless` in `00-base` |
| ffmpeg, xdotool | apt in `00-base`; `xdotool` works only with an X display (S10 or the user's own Xvfb) |
| Google Chrome (`google-chrome`, `google-chrome-stable`) | a `.deb` from `dl.google.com` at the exact version from `versions.toml` (the sha256 is checked), `apt install ./<deb>` in `30-toolchains`; for headless runs of agents and Playwright/Puppeteer. The Chrome sandbox works as `user` thanks to user namespaces (§8.6). The Google apt source that the package installs stays: the user updates Chrome themselves |
| `umiak` CLI (S7 §14) | the binary from `--umiak-cli` (the linux-x64 release of S7 §15.5, sha256 = `versions.toml`) → `/usr/local/bin/umiak` in `40-coding-agents`; `/etc/umiak/config.json` `{"apiUrl": "<--api-url>"}` (S7 §14.1). There is no key in the image: the user passes a team key (S7 §7.2) as the sandbox secret `UMIAK_API_KEY`; a `sandbox`-type key in the VM is phase 2 (S7 §7.2). Inside the sandbox VM the default sandbox is `UMIAK_SANDBOX_ID` (S3 §8.2). Until S7 has a release, `--umiak-cli` is optional, in the manifest `tools.umiak = null` |

- Versions and sha256 come from `versions.toml`, the resulting versions (`--version` of each) go in the manifest.
- Auto-update of agent CLIs in the sandbox is turned off where it can be configured system-wide (for example, Claude Code managed settings); versions are updated by a new template build **[S5]**. The user can update them themselves via `sudo`.
- Caches (`npm`, `go build`, `rustup` downloads, `uv`, `pip`) are cleaned in `90-cleanup`.
- The set is brought to parity with boat per the MVP rec. R5 (`docs/roadmap-phase2.md` §6): Node+pnpm, Python+uv, Go, Rust, Java, Docker+Compose+buildx, gh, rg, jq, Chrome, ffmpeg, xdotool, the coding-agent CLIs, and `umiak`. Not part of `linux`: the desktop (X server, window manager, Sunshine — S10), Scala/Kotlin/Gradle/Maven, Deno, Ruby, PHP, .NET, R, Android, the GitHub Actions runner; the user installs those via `sudo`.
- The template adds no default env: `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` and the rest of the platform env are set by the agent (S3 §8.2).

### 8.10 Agent (`50-umiak-agent`) and cleanup (`90-cleanup`)

`50-umiak-agent`:
- `umiak-agent install-package --trust-keys /mnt/seed/build/update-keys.pub /mnt/seed/build/umiak-agent-<v>-linux-amd64.tar` (S3 §17.1): signature verification with the keys with which the builder verified the package (`update-keys.pub` in the seed), layout into `versions/<v>`, the `current` symlinks, `/usr/local/bin/umiak-agent`.
- `/etc/umiak-agent/agent.toml` (S3 §5) from the recipe template: `[tunnel] url` — the default tunnel URL (`--tunnel-url`, §14), `[user] default = "user"`, `[docker] enabled = true`, the rest is S3 defaults.
- The units of S3 §17.2 and §7.2 (`umiak-identity.service`, `umiak-agent.service`, `umiak-agent-rollback.service`, `umiak-cmd.slice`) are enabled.
- `qemu-guest-agent` is enabled (the S1/S3 fallback channel).

`90-cleanup` (before `seal`):
- apt sources → the regular archive (§6.2), `apt clean`, `rm -rf /var/lib/apt/lists/*`;
- `cloud-init clean --logs --seed`, `touch /etc/cloud/cloud-init.disabled`, delete `/etc/netplan/50-cloud-init.yaml` and `/etc/ssh/sshd_config.d/50-cloud-init.conf`; the cloud-init package stays but is disabled (S3 §20) **[S5]**;
- delete: `/var/lib/systemd/random-seed`, `/var/lib/systemd/credential.secret`, `/var/log/umiak-build`, `/var/log/*` (the contents, the directory structure stays), `journalctl --rotate --vacuum-time=1s`, `/tmp/*`, `/var/tmp/*`, the shell history of root and `user`, tool caches;
- write `/etc/umiak-template/build.json` — the manifest without the verification part (§11);
- check: no swap, one kernel, none of the "purged" packages, no `authorized_keys`.

`seal` (S3 §7.3) wipes the agent state, host keys, and `/etc/machine-id` (an empty file, not `uninitialized`: this way the first boot of a clone is not counted as a systemd first boot and does not apply presets that could enable what was disabled; check §10 item 13).

## 9. Template hardware

The template VM config = the recipe's `hw` (§5) + `scsi0` (64 GiB, `discard=on,iothread=1,ssd=1`). Why **[S5]**:
- SeaBIOS: the Linux template does not need UEFI, and OVMF firmware boots longer. The Ubuntu image supports both boot modes (a BIOS boot partition exists).
- `rng0` (virtio-rng): a fresh clone has entropy right away for `ssh-keygen` in `umiak-identity`.
- `tablet: 0`: a USB tablet is not needed by a headless VM.
- `vga: std` is kept for the operator console; `serial0` — for xterm.js and boot logs.
- Neither the template nor the sandbox has a cloud-init disk (`cloudinit: false`, §17.1).
- `cpu: host`: the guest sees all the CPU flags of the host (AVX-512, `vmx`/`svm` for nested KVM, §8.6), and this gives the best performance. The price: live migration is possible only between nodes with the same CPU. In the PoC there is one node, so `cpu: host` stays; a cluster with mixed CPUs needs a named model (for example `x86-64-v3`) — a decision for S12 / phase 2 (S1 §12).

`disk_layout` and `hw` (keys from the S1 whitelist + `rng0`) are written to the manifest and to `template_builds`.

## 10. Build verification

`verify` creates a machine from the template with the S1 `create` primitive (size 2 vCPU / 2 GB, a test `smbios1`: a random `uuid`, a serial of the S2 format with a test BS, a `family` with a test tunnel URL, §14), boots it, runs checks via QGA, and deletes it with a check for the absence of traces (S1 §6.3). Any red check → the build is `failed` (when called from `build`) or a non-zero code (for a separate `verify`).

1. OS: `26.04`, one kernel, `systemctl --version` ≥ 257.
2. `/proc/cmdline` contains `systemd.machine_id=firmware`; `/etc/machine-id` = `product_uuid` without dashes.
3. Swap: `swapon --show` is empty, no swap in `fstab`, no zram.
4. Listening sockets (`ss -tulpn`):
   - TCP: only `127.0.0.1:22` and `[::1]:22` (owner `systemd` via `ssh.socket` or `sshd`), resolved on `127.0.0.53:53` and `127.0.0.54:53`. Not a single TCP socket on `0.0.0.0`, `::`, or an interface address.
   - UDP: resolved on `127.0.0.53`/`127.0.0.54`, chronyd on loopback (`323`), the `systemd-networkd` DHCP client on `<ip>%en*:68`. No others.
5. `sshd -T`: `passwordauthentication no`, `trustedusercakeys /etc/ssh/umiak_user_ca.pub`, both `listenaddress`. SSH host keys exist and were created in this boot.
6. `/etc/pam.d/sshd` contains the lines of S3 §8.2; `/etc/umiak/env` exists.
7. cloud-init: `cloud-init status` = disabled; no `50-cloud-init.yaml`; netplan matches `en*`; IPv4 from `10.88.0.0/24`.
8. Users: `user` uid 1000 in the groups `sudo` and `docker`; `sudo -n true` as `user` works; linger is on; no `ubuntu`; no other uid ≥ 1000; the root and `user` passwords are locked; no `authorized_keys` files.
9. Agent: `umiak-agent doctor --json` — version = manifest, `identity` ready with the `machineId` from the test smbios, the effective tunnel URL = the test one from `family` (source `smbios`), the units `umiak-identity` and `umiak-agent` are active. The tunnel connection is not checked: the gateway may be absent in verify, and the agent must be `active` without it (§17.3 item 4).
10. Docker: `docker info` and `docker run --rm hello-world` (an image from the internet through the `umiak0` egress).
11. Tools: every command from §8.9 — `--version` (for Go — `go version`; for `gofmt`, `bunx`, `uvx`, `npx` — only `command -v`) as `user` by direct exec and via `bash -lc`; versions = manifest.
12. Network: `getent hosts example.com`, `curl -fsS https://example.com`; `systemd-networkd-wait-online` finished within 15 s.
13. systemd: `is-system-running` = `running`; no failed units; no active jobs; the services from "masked" and "purged" (§8.1) are neither active nor enabled.
14. Leftovers: no `/var/log/umiak-build`, `/var/lib/cloud/instances/*`, shell history; `/etc/umiak-template/build.json` exists.
15. The sysctl of §8.6 are in effect; `unshare -Ur true` as `user` passes.
16. **Hard stop:** S1 `stop` (without shutdown), then start. The time to `agent/ping` is no more than the first boot time + 3 s; there is no `recordfail` in `grubenv` or it gives no wait (`GRUB_RECORDFAIL_TIMEOUT=0` in `grub.cfg`).
17. Disk: root size ≈ 64 GiB; `fstrim -v /` works.
18. Boot measurements (first boot and boot after a hard stop): the metrics of §13.1 are written to the manifest (`verify.boot`).
19. **KVM (best-effort, does not fail the build):** if `/proc/cpuinfo` has `vmx` or `svm`, `/dev/kvm` exists and `user` opens it for reading and writing; the result is `verify.kvm` (`available` / `unavailable` with a reason) in the manifest.

## 11. Version, manifest, registry

- **Version:** `<YYYYMMDD>.<n>` (the UTC date of the build start, `n` — the sequence number within the day for the slug). VM name: `umiak-tpl-<slug>-<YYYYMMDD>-<n>`. `buildId` — UUIDv7 = `template_builds.id`.
- **Manifest** (`build.json`) **[S5: contents, JSON format]**: `buildId`, `templateSlug`, `version`, `os`, `status`, `node`, `storage`, `pveVmid`, `gitCommit`, `recipeDigest` (sha256 of the recipe directory), `base` (distro, release, flavor, serial, sha256), `apt.snapshot`, `kernel`, `systemd`, `packages` (`dpkg-query` name → version), `tools` (name → `--version`), `agentVersion`, `defaultTunnelUrl`, `hw`, `diskLayout`, `bootTimeoutS`, `buildMemoryMb`, `startedAt`, `finishedAt`, `verify` (check results, `boot`), `error` (when `failed`).
- A copy without `verify` lies in the image (`/etc/umiak-template/build.json`).
- **Registry** — the interface `TemplateRegistry` (`create`, `update`, `get`, `list`, `promote`, `retire`):
  - before S6 is implemented: SQLite in `UMIAK_STATE_DB` (the same file as the S1 allocator), a table with the columns of S6 `template_builds`;
  - with S6: Postgres via `packages/db` (S6 §14.3: `umiak-admin template register|promote` or direct calls of the same code).
  - transition: `umiak-tpl registry migrate --to postgres` moves the build rows and their leases (`purpose=template`) from SQLite to Postgres. Performed before the first run of the S6 reconcile on this node; until then reconcile is protected by the tag `umiak-tpl` (§17.4 item 6).
- `umiak-bench` and the S3 stand take the template VMID from the active build (`umiak-tpl show --active linux --field pveVmid`) or from `UMIAK_TEMPLATE_VMID`.

## 12. Rollout, rollback, garbage collection

### 12.1 Statuses

`building → ready → active → deprecated → retired`; from `building` — `failed`. `ready` (verified but not active) and `failed` are added to the statuses of S6 §5.2 **[S5]**.

| Status | New machines | Template VM and LVs |
|---|---|---|
| `building` | no | the build VM |
| `ready` | no | present |
| `active` | yes (pool and cold create) | present |
| `deprecated` | no | present (rollback possible) |
| `retired` | no | deleted, the row stays for history (`template_build_id` of machines and snapshots) |
| `failed` | no | deleted (or kept with `--keep-on-failure` until `cleanup`) |

### 12.2 Promote and rollback

- `promote <buildId>`: the build is in `ready` or `deprecated`, its VM exists and is a template. In one transaction: the current `active` for `(slug, node)` → `deprecated` (`deprecated_at`), this one → `active` (`promoted_at`). The pool replaces warm machines itself (S6 §9.2 step 4, §9.4); sandboxes on the old build are not touched.
- Rollback = `promote` of the previous `deprecated` build. A repeated verification is not needed: the build is already verified and its disk is unchanged (a template is only read).
- A build is active on a node: with several nodes (phase 2) the build is done for each node (`--node`), `promote` too per node. Moving a finished image between nodes is phase 2.

### 12.3 Why deleting a template is safe

In dm-thin a template clone (`lvcreate -s`, S1 §6.2) and machine snapshots are independent of the source volume, and Proxmox does not consider our `vm-N-disk-K` linked clones (they have no name of the form `base-X/vm-N`). Therefore `DELETE /qemu/<vmid>` of a template does not affect running and stopped sandboxes, forks, and saved snapshots. Only blocks nobody uses anymore free space. Checked by acceptance (§19, item 4).

### 12.4 `gc`

For each pair `(slug, node)`:
- `active` and the two latest `deprecated` (by `deprecated_at`) remain;
- the other `deprecated` ones are deleted if `deprecated_at` is older than 7 days and there is no machine with this `template_build_id` in `allocating`, `provisioning`, `booting`, `warm` (new clones from `deprecated` do not start: the pool and cold create take only `active`). Deletion: `DELETE /nodes/{node}/qemu/{vmid}?purge=1`, check for the absence of LVs `base-<vmid>-*`, release the VMID in the allocator, status `retired`, `retired_at`;
- `failed` with leftovers → as `cleanup`;
- base images in `local:import/umiak-*` that no non-`retired` build refers to are deleted; ISOs `umiak-seed-*` older than 1 day too. Both deletions go through `umiak-node media.remove` (§17.1 item 3).

In the PoC before S6 the allocator does not know a machine's `template_build_id`. Therefore `gc` deletes a build only if the allocator has no lease in `reserved` (a clone in progress) and the pool `umiak` has no VM being created (a `clone`/`create` lock in the config); running machines of the old build do not prevent deletion (§12.3). In the PoC `gc` is run manually. With S6 — the same code in a worker controller or in a CronJob (S6/S12 choose); the "no machine" check is a query to `runtime.machines`.

### 12.5 Rebuild

In the PoC manually (`umiak-tpl build linux --refresh`, then `promote`). Later — weekly in CI or a Kubernetes Job (S12) with the same CLI; promote after a green check can be automated there as well.

## 13. Boot time

### 13.1 Metrics and `umiak-bench s5`

A new scenario `umiak-bench s5 --build <buildId> [--baseline 599] [--runs 5]` in `apps/bench`. For each build N times: S1 `create` → start → measurements → hard stop → start → measurements → delete.

| Metric | How |
|---|---|
| `start_to_qga` | from the start call to the first `agent/ping` (like `boot` in S1) |
| `start_to_ip` | to an IPv4 in `network-get-interfaces` |
| `start_to_agent_ready` | the host time of the kernel start (`t_ping − uptime` at the moment of ping) + the monotonic readiness mark of the agent: phases `agent` and `identity` ready, plus `docker` ready (from `umiak-agent doctor --json`, §17.3); until the marks exist — `ActiveEnterTimestampMonotonic` of the units `umiak-agent` and `docker` |
| `kernel`, `initrd`, `userspace` | `systemd-analyze` |
| `critical_chain` | `systemd-analyze critical-chain umiak-agent.service` |
| `blame_top10` | `systemd-analyze blame` |
| `hard_stop_restart` | `start_to_qga` after `stop` without shutdown |

Report: median, p95, min, max; a comparison table with the baseline (599 or another build). JSON in `bench-results/s5-<ts>.json`. When S4 and S6 appear, the scenario adds `start_to_tunnel` (the agent's connection by gateway data).

### 13.2 Targets

On `pve`, `local-lvm`, 2 vCPU / 2 GB: median `start_to_qga` ≤ 8 s, `start_to_agent_ready` ≤ 10 s; `hard_stop_restart` no more than a regular boot + 3 s. Not worse than 599 on any metric. The numbers are written in §20.

### 13.3 Mandatory measures and experiments

Mandatory (in the recipe from the first build): GRUB without waiting and without recordfail (§8.5), removed and masked services (§8.1), `wait-online --any --timeout=15`, cloud-init off, no cloud-init disk in a sandbox (§17.1), SeaBIOS, `boot: order=scsi0`.

Experiments (each is a separate build with a recipe flag, compared with `umiak-bench s5 --baseline`; accepted if the median `start_to_agent_ready` improves by at least 300 ms and the check in §10 is green):
1. dracut `hostonly` with a minimal set of modules (virtio, scsi, ext4).
2. Boot without an initrd (`root=PARTUUID=`), if virtio-scsi and ext4 are built into the kernel.
3. The `linux-kvm` kernel instead of generic (Docker modules needed: overlay, br_netfilter, veth, nf_tables).
4. `docker.socket` instead of an early `docker.service`.
5. `umiak-agent.service` without `After=network-online.target` (the agent repeats the connection itself) — an S3 change, only if `wait-online` turns out to be on the critical path.
6. `vga: none` / serial only.

## 14. Tunnel URL: the default and an override via `smbios1`

Master session's decision: the URL is baked into the image only as a default, and the worker may override it for each VM. Then one build suits dev and prod.

- **Default:** `agent.toml [tunnel] url` from `--tunnel-url` at build time (in the manifest `defaultTunnelUrl`).
- **Override:** the `family` field in `smbios1`: `family=<base64("umiakt1:" + url)>` with the shared flag `base64=1` (S2 §5.2). The agent reads `/sys/class/dmi/id/product_family`; with the prefix `umiakt1:` and a valid URL (`wss://`, non-empty host, ≤ 200 bytes) it uses it, otherwise the value from `agent.toml` with a warning in the log. `doctor --json` shows the effective URL and the source.
- **Checked in the Proxmox 9.2 sources (`PVE/QemuServer.pm`):** `smbios1` accepts `uuid`, `serial`, `manufacturer`, `product`, `version`, `sku`, `family`, `base64`; with `base64=1` all fields except `uuid` are passed to QEMU decoded (commas are escaped). The whole `smbios1` string is no more than **512 characters**. About 175 are used now: `uuid=<36>` (41), `,serial=<base64 of 85 bytes>` (124), `,base64=1` (9). About 335 characters remain, i.e. `,family=` and up to ~245 bytes of URL before base64. The 200-byte URL limit leaves a margin. The length and the reading of `product_family` are checked by the stand (§19, item 3).
- `product_family` in sysfs is available to all VM users (unlike `product_serial`). The URL is not a secret, this is acceptable.
- `sku` is not used and stays in reserve.
- **One build — one tunnel CA bundle** (master session's decision, 2026-10-29). The agent trusts only the tunnel CA bundle from its package (S2 §5.4); the override changes the address but not the trust. There is no shared dev + prod bundle. One build serves several installations only if they have the same tunnel CA (for example several environments of one installation); within these limits the override via `family` is useful.

## 15. Template 599 and the transition

- 599 (`umiak-ubuntu-poc`) is the S1 stand's template: a thin snapshot of 9000 with `qemu-guest-agent`, built by the S1 §4.6 runbook. It inherits from 9000 the user `ib` (uid 1000, a conflict with `user` from S3), `tailscaled`, snapd, and the network bound to the MAC. The master session passed the fix to `s1-impl` (2026-10-29).
- S5 does not depend on 599 or 9000.
- Until the first S5 build exists, the S1 stand runs on 599. After the first `active` build of `linux`: `umiak-bench s1`, the S3 stand, and the S6 E2E use it (`UMIAK_TEMPLATE_VMID` from the registry, §11).
- 599 stays as the baseline for `umiak-bench s5 --baseline 599` until the targets of §13.2 are confirmed and the numbers are recorded. Then it is deleted by the step `infra/pve/setup.sh revert template` (S1). VMID 599 returns to the allocator.

## 16. Extensibility (S9, S10)

The builder knows the stages, the recipe sets the content:

| Point | `linux` | `linux-desktop` (S10) | Windows (S9) |
|---|---|---|---|
| `source.kind` | `cloud-image` | `cloud-image` | `iso-install`: the user's ISO (license) in `local:iso`, `autounattend` on a second ISO, `virtio-win.iso` |
| build medium | seed ISO `cidata` | the same | the `autounattend` ISO + the `build/` directory |
| step executor | `bash` through QGA | the same | PowerShell through QGA (virtio-win) |
| `extends` | — | `linux`: the `linux` steps + its own; the build also starts from a clean image, not on top of the `linux` LV | — |
| sealing | `umiak-agent seal` | the same | `umiak-agent seal` + `sysprep /generalize /oobe /shutdown` |
| hardware | SeaBIOS, `scsi0` | the same + video per the S10 decision | OVMF, `efidisk0`, `tpmstate0` (the slots already exist in the S1 `DiskSet`) |
| verification | §10 | §10 + desktop | its own profile |

The registry, versions, promote, gc, and `umiak-bench s5` are shared. `boot_timeout_s` from the recipe (Windows — 1200, S6 §5.2).

## 17. Changes in neighboring areas

Agreed by the master session; made by the implementers of these areas (`s1-impl`, the S3 and S6 implementations).

### 17.1 S1 (`packages/pve`, `umiak-node`, runbook)

1. **Template VMIDs from the allocator.** `allocate("template")` instead of a hard-coded 599; `ensureTemplate` reserves the VMIDs of all registered builds. `UMIAK_TEMPLATE_VMID` stays as an override for the stand.
2. **`umiak-node lv.snapshot`:** origin `base-<any VMID of the range>-*` instead of `base-<templateVmid>-*` (the prefix `base-` exists only on template disks). The name `vm-<id>-disk-*` is forbidden if `<id>` has an LV `base-<id>-*`. The parameter `templateVmid` in `/etc/umiak-node.toml` is removed.
3. **Rights and files on `local`.**
   - The role `UmiakTemplateMedia` (`Datastore.AllocateTemplate`, `Datastore.Audit`) on `/storage/local` for `umiak@pve` and the token: uploading images and ISOs (`upload`), `import-from`, and attaching an ISO (checked in `PVE/API2/Storage/Status.pm` and `PVE/Storage.pm`).
   - Deleting through the API (`DELETE …/content/<volid>`) requires `Datastore.Allocate` (checked in `PVE/API2/Storage/Content.pm`). This right allows changing the storage itself and deleting Ilia's ISOs and backups, so we do not grant it. Instead — `umiak-node` operations: `media.list` (read only) and `media.remove` — deleting only the files `/var/lib/vz/template/iso/umiak-seed-*.iso` and `/var/lib/vz/import/umiak-*.{qcow2,img,raw}`, the name is checked against a pattern, without `..` and symlinks.
   - The content `import` of `local` is enabled (already on `pve`). If it is missing, the S1 runbook enables it (a `storage.cfg` change, a step with confirmation), not the builder.
4. **No cloud-init for sandboxes.** If the template has `hw.cloudinit = false`, `create` does not add `ide2=…:cloudinit`, `ipconfig0`, `ciuser`. `fork` follows the source: `snapshot` writes a mark `umiak-cloudinit` (`0`/`1`, whether the source had a cloud-init disk) into the snapshot hardware, and a fork from a sandbox of such a template gets no cloud-init. For 599 and snapshots without the mark the behavior is as before.
5. **The hardware whitelist** + `rng0`.
6. **`smbios1`:** `create`/`fork` accept `family` (§14) together with `uuid` and `serial`; a check that the whole string is ≤ 512.
7. The VM firewall setup function (S1 §4.4) is exported for the build VM.
8. **Cleanup does not touch templates.** `umiak-bench cleanup --all-sandbox-resources` and `preflight` skip VMs with the tag `umiak-tpl` (builds and templates), leases with `purpose=template`, and do not count them as leftovers; instead of "except 599" — "except `umiak-tpl`". The cleanup is global, affects the sandboxes of all runs, and requires an explicit flag; after `verify` only the VMID and snapshot listed in its output are deleted.

### 17.2 S2

The `family` format in `smbios1` (§14) is an addition to S2 §5.2: `umiakt1:<url>`, an optional field.

### 17.3 S3 (agent)

1. Reading `product_family`, the priority `smbios > agent.toml`, URL validation (§14).
2. `doctor --json`: the effective tunnel URL and its source; monotonic marks of the readiness phase transitions to `ready` (for `umiak-bench s5`, §13.1).
3. The pinned update public keys lie in the repository in a file that the builder also reads (§7.2 item 1).
4. `umiak-agent.service` (`Type=notify`) sends `READY=1` after opening `state.db` and restoring the shim, **without waiting** for the tunnel: without a gateway (build, verify, a drop) the unit must be `active`, not in a restart loop with rollback.

### 17.4 S6 (control plane)

1. `template_builds`: statuses `building | ready | active | deprecated | retired | failed`; columns `manifest jsonb`, `build_memory_mb int`, `verified_at`, `deprecated_at`, `retired_at`; the uniqueness of `active` by `(template_slug, node_id)` is as before.
2. Admission (§8.1): the RAM of a build in `building` on its node is part of `reserved` and `powered`.
3. The worker writes `family` into `smbios1` (§7.4 step 4) if the installation's configuration has a tunnel URL (`UMIAK_TUNNEL_URL`); otherwise the field is not set.
4. `boot_timeout_s` and `hw` (with `cloudinit: false`) are taken from the build and passed to S1.
5. `gc` (§12.4): S6 decides where it runs (a controller or an S12 CronJob).
6. **Reconcile does not touch templates.** A VM with the tag `umiak-tpl` or `template: 1` is never deleted by reconcile; if it has no `template_builds` row, it only reports (a metric, a log). Leases with `purpose=template` are not considered orphans.

## 18. Code structure

```
apps/template-builder/        TS: umiak-tpl CLI (recipe loader, image fetch/verify, seed ISO,
                              build stages, QGA step runner, verify, registry, gc)
infra/templates/keys/         pinned Ubuntu cloud image signing key
infra/templates/linux/        recipe: template.yaml, versions.toml, seed/, steps/, files/
apps/bench/                   + scenario s5 (§13.1)
packages/pve/                 + changes §17.1 (by s1-impl)
```

Libraries (checked 2026-10-29 via `npm view`, re-check during implementation): `openpgp` 6.3.2 (the `SHA256SUMS.gpg` signature), `smol-toml` 1.9.1, `yaml` 2.9.1, `zod` 4.6.7 (recipe and manifest schemas), `commander` 15.0.0 or whatever is already chosen in `apps/bench`. Packer (1.16.2, the proxmox plugin 1.2.4) was considered and rejected: it needs SSH to the guest in the closed `umiak0`, does not set our tags and does not know the allocator, the BUSL license.

Tests (vitest):
- unit: parsing and validating the recipe and `versions.toml`, checking the signature and sha256 (a test key), assembling `user-data`/`network-config`, the order of PVE API calls in `build` and rollback on error (a fake `packages/pve`), running a step via QGA with reading the log by offset (a fake QGA), the `gc` rules (a table of cases), the format and length of `smbios1` with `family`;
- shellcheck for `steps/*.sh`;
- integration is the build itself and `verify` on `pve`, plus `umiak-bench s5`.

## 19. Acceptance

On `pve`:
1. `umiak-tpl preflight` is green; `umiak-tpl build linux --refresh --agent-package <tar> --umiak-cli <bin> --api-url <url> --tunnel-url <url>` passes from the official image without manual actions; the build is `ready`, all checks of §10 are green.
2. A repeated build with the same `versions.toml` and commit gives the same `packages` and `tools` in the manifest.
3. `smbios1` with `family` of the maximum allowed length (a 200-byte URL) is accepted by Proxmox; the agent sees the URL; a string longer than 512 characters is rejected by the builder before the API call.
4. **GC is safe:** machine A from build X is running, a saved snapshot (or an S1 snapshot) of A exists; `promote` of build Y; `gc` with a forced threshold deletes X; A keeps working, reboots, a fork from A's snapshot boots; there is no LV `base-<X>-*`, the VMID of X is released.
5. `promote` Y → rollback `promote` X (before deletion) → the S6 pool (if any) or the stand uses X.
6. `umiak-bench s5 --baseline 599`: the targets of §13.2 are met; `hard_stop_restart` within limits; the numbers are written to §20.
7. A failed build (a step that fails intentionally, a test flag) leaves no VM, ISO, and lease; with `--keep-on-failure` it leaves them, `cleanup` removes them.
8. The S1 `inventory` "world before" and "world after" of the build and `gc` differ only in the VMs and LVs of the new build and the deleted builds.

## 20. Results

> A historical report predating R1; current names are in `docs/specs/rename-umiak.md`.

Implementation 2026-10-30, branch `s5-impl`; plan `docs/plans/s5-linux-template.md`. Builds on `pve` (Proxmox VE 9.2.21).

### 20.1 Numbers

**Build** of `linux` (`sbx-tpl build linux`, Mac → `pve`): 10–14 min from the official image to a ready template, plus 5–6 min of `verify`. The base image `release-20261024` is uploaded to `local:import` once per serial (420 MB). The image: 658 packages, kernel `7.0.0-42-generic`, systemd 259.9, 39 tool commands (§8.9, no `sbx` yet). Thin pool usage: see §20.4.

**Reproducibility (§19 item 2):** two builds with one `versions.toml` (20261030.10 and .11) gave identical `packages` (658) and `tools` (39).

**`verify` (§10):** 97 checks PASS, 0 FAIL (build .15), including the agent (`doctor`, version, identity, tunnel URL from `smbios`), the clone agent's connection to the dev gateway (`tunnel_connected`, CT 590, `--connect-url`), Docker `hello-world`, a scan of the template disk and the clone for build secrets (§20.2 item 6), a hard stop (≤ first boot + 3 s), a fork with new machine-id, hostname, host keys, IP, random seed, and agent state. KVM in the guest: `available` (on `pve` `kvm_intel nested=Y`).

**`sbx-bench s5 --template 598 --baseline 599 --runs 5`** (build .15; 2 vCPU / 2 GB, `local-lvm`), ms, median (p95):

| Metric | S5 (598) | 599 |
|---|---|---|
| `start_to_qga` | 9094 (9174) | 11605 (14142) |
| `start_to_ip` | 9296 (9379) | 11811 (14249) |
| `start_to_agent_ready` | 8955 (9074) | — (no agent) |
| kernel / initrd / userspace | 466 / 1940 / 3103 | 851 / 2123 / 6087 |
| `hard_stop_restart` | 8886 (9070) | 10024 (14707) |

Build .11 (597) gave the same numbers (`start_to_qga` 9013, `start_to_agent_ready` 8821). The S5 template is not worse than 599 on any metric. The target of §13.2 `start_to_agent_ready` ≤ 10 s is met; `start_to_qga` ≤ 8 s is **not met** (9.1 s): kernel + initrd + userspace ≈ 5.3 s, the rest is SeaBIOS and QEMU startup. Ilia's decision "we do not optimize creation time" (`docs/roadmap.md`) makes this target optional for the MVP; the experiments of §13.3 were not run.

**`sbx-bench s1`:** against template 597 — 126/126 (clone 1.0 s, boot 9.9 s, fork 11.2 s; the `qm clone` baseline from the template also passes); against 598 — 125/126 (clone 1.0 s, fork 13.5 s), the only FAIL is "world before/after": the first clone of a new template activates its LV (`attr`), a repeated run does not.

**A failed build (§19 item 7):** `--fail-step 20-docker` — the rollback deleted the VM, seed, and lease, only the base image cache remained on the host; `--fail-step 00-base --keep-on-failure` — the VM, seed, and lease remained, `sbx-tpl cleanup` removed them, the template was not touched.

### 20.2 Deviations from the specification

1. **The seed is a disk, not a CD** (§7.2 items 3–4, §7.2 item 8). The first boot of a cloud image goes without an initrd (`GRUB_FORCE_PARTUUID`); the CD drivers (AHCI, `sr_mod`) are modules and appear after cloud-init looks for the seed, and cloud-init gets disabled. The seed (the same ISO 9660 `cidata`) is uploaded to `local:import/sbx-seed-<buildId>.raw` and attached as `scsi1` (`import-from`); virtio-scsi and sd are built into the kernel. Additionally the build VM has `smbios1 serial=ds=nocloud`. Before `template` the disk is deleted (`unlink force=1`), `smbios1` is removed.
2. **ISO only through `xorriso`** (§7.2 item 3, §21). `hdiutil` shortens names with dots and longer than 30 characters (`sudoers.d` → `sudoersd`). On the Mac: `brew install xorriso`.
3. **The registry is JSON files** (§11). S6 already exists, the SQLite registry was not made: manifests in `~/.local/state/sbx/templates/<buildId>.json` (`SBX_TEMPLATE_REGISTRY`), the version number is an exclusive claim file. Registration for the worker — `topology.templateBuilds` in `deploy/compose/config/sbx.yaml` (or `sbx-admin template register`, the line is printed by `build`). `promote` — `sbx-admin template promote` (S6), `gc` — S6/S12 (§17.4 item 5). `sbx-tpl retire <buildId>` marks a `ready` build `retired`; if the template VM of this build still exists, `--delete-vm` is needed (deletes the VM and releases the slot lease). A build from the worker config (`SBX_CONFIG_FILE`, by default `deploy/compose/config/sbx.yaml`, `topology.templateBuilds`) and the newest `ready` build of a template are not touched by `retire` without `--force`, a build in the PoC slot 599 — without `--force-poc`. `show --active ... --field pveVmid` is implemented as `show --active-vmid <slug>` (the newest `ready` build).
4. **Template VMIDs** — the slots are set by the recipe (`vmids`, the first free one): Linux 597 and 599, Windows (S9) 598. `SBX_TEMPLATE_VMID_RANGE` (597–599 by default) is the outer boundary of the slots, the `pve` layout in S1 §4.7. 599 is skipped while it is the PoC template (`SBX_TEMPLATE_VMID`); until it is retired Linux has one slot, and before a new build the old one must be retired (`retire`).
5. **The default tunnel URL is empty** (§14). `agent.toml` without `[tunnel] url` unless `--tunnel-url` is given; the worker writes `smbios1.family` from `SBX_TUNNEL_URL` (§17.4 item 3 was done in this branch). The tunnel CA is a parameter of building the agent package (`infra/templates/agent-package.sh --tunnel-ca`); the dev build uses the dev CA of the CT 590 gateway.
6. **The scan for secrets runs on the host** (§10). The new operation `sbx-node lv.scan` (only `base-<slot>-*` with the tag `sbx-tpl` and `vm-<id>-disk-N` of the sandbox range with the tags `sbx`, `sbx-vm-<id>`; patterns via SSH stdin, not written to the `sbx-node` journal) scans the template disk and the clone disk after boot. Patterns: the update signing key (PEM and seed in base64/hex), the PVE token secret, the `sbx-node` and dev CA keys, the clone's BS.
7. **`wait-online`** (§8.4, §10 item 12). netplan 26.04 enables `systemd-networkd-wait-online` only for interfaces with a known name; with `match: {name: "en*"}` the unit is skipped by condition, `network-online.target` is reached at once. The check accepts this (plus `network-online.target active`) or a wait ≤ 15 s.
8. **`sbx-bench s5`** accepts `--template <vmid>` instead of `--build <buildId>`.
9. **Sealing** (§7.2 item 7) is extended: stopping `systemd-random-seed` and deleting `random-seed`, `credential.secret` before `seal` (otherwise ExecStop saves the seed at poweroff); after `seal` the initrd is rebuilt (`update-initramfs -u -k all`: dracut puts `/etc/machine-id` and `/etc/hostname` into it, otherwise the early boot of every clone ran under the machine-id and hostname of the build VM), journald is switched to `/run` and `/var/log/journal/*` is deleted; zero-fill of free space, `sync`, `fstrim`; the build fails if `base-<vmid>-disk-0` is more than 40% used. The build VM's firewall is removed before `template` (otherwise `qm clone` copies the ipset).
10. **apt.** The sources during the build are a snapshot; `snapshot.ubuntu.com` answered 503 for about 30 min: cloud-init retries the installation of `qemu-guest-agent`, the steps use `apt-get update --error-on=any` with retries.
11. **Docker** is held with `apt-mark hold` only during the build; removed in the template.

### 20.3 Rights and host changes added as needed

- The role `SbxTemplateMedia` (`Datastore.AllocateTemplate`, `Datastore.Audit`) on `/storage/local` (`infra/pve/setup.sh media`). `Datastore.Allocate` is not granted; the step check verifies this.
- `sbx-node`: the sandbox range 500–589 and template slots 597–599 (`templateVmidMin`/`templateVmidMax`); clone only from `base-<slot>-*` with the tag `sbx-tpl`, a ban on `vm-<id>-disk-*` on top of a template; operations `media.list`, `media.remove`, `lv.tagTemplate` (the tag `sbx-tpl` on the template slot disks; the builder calls it before `lv.usage`), `lv.scan`, `lv.usage` (LV fill; an inactive LV is activated for the duration of the read, only after the tag check). Deployment: `setup.sh node`.

### 20.4 Template

The active build in `deploy/compose/config/sbx.yaml`: `linux` **20261030.16**, VMID **597**, agent `0.1.0+20261030.78c73ee` (tunnel CA — the dev CA of the CT 590 gateway). `verify`: 99 PASS, 0 FAIL, 2 INFO (added `fork_journal` — the fork's journal under its own machine-id from the start of boot, and `initrd` — without the build's machine-id and hostname). Thin pool usage: **7.3 GiB** (`sbx-node lv.usage`). `sbx-bench s1` against 597: 126/126 (clone 1.4 s, boot 9.2 s, fork 10.1 s). Build .15 (598) was retired (`sbx-tpl retire --delete-vm`), .7 and .11 were marked `retired`; slot 598 was given to the Windows template (S9), Linux alternates between 597 and 599 (`infra/pve/README.md`). The previous build .11 took 95%: the zero-fill did not return to the pool because `rm` and `fstrim` ran without an ext4 journal commit; now `rm; sync; fstrim`, and the build fails when more than 40% is used.

## 21. Open questions and risks

- ~~A shared tunnel CA for dev and prod~~ (§14). Decided by the master session: there is no shared dev + prod bundle, the rule is "one build — one tunnel CA bundle".
- The ISO tool on the Mac: `hdiutil` does not write Rock Ridge; steps are run via `bash`, so it does not matter, but check long file names (Joliet).
- Uploading the image from the Mac over Tailscale (~420 MB) — once per serial; if slow, later `download-url` on the node (needs `Sys.Modify` on the node, not taken now).
- In Ubuntu 26.04 sshd via `ssh.socket` and the generator: check that `ListenAddress` from `sshd_config.d` really gives only loopback (the check §10 item 4).
- Auto-update of agent CLIs: which of them can be configured system-wide — check during implementation; where it cannot, leave as is and record it.
- Google keeps only fresh Chrome versions on `dl.google.com`: a rebuild with an old `versions.toml` may not find the `.deb`. Then the build fails at the `30-toolchains` step, and `--refresh` is needed.
- The image size will grow because of Chrome, JDK, and ffmpeg (an estimate of +1 GB in the thin pool); this does not affect boot time (they add no services), checked by `umiak-bench s5`.
- `systemd.machine_id=firmware` with an empty `/etc/machine-id`: make sure systemd does not count the boot as a first boot and the machine-id is written to disk (`systemd-machine-id-commit`), the check §10 items 2 and 13.

## S10 template slots (Ilia's decision 2026-10-31)

`linux-desktop` extends `linux` but uses its own VMID `[596]` from the dev infrastructure 590–596 (CT 590 stays); `windows-desktop` (S10, `extends: windows`) — `[595]` (master's decision 2026-11-01). Linux `[597, 599]` and Windows `[598]` do not change and S10 does not touch them. There are no pools in the MVP; default size 4gb, allowed 4gb/8gb are set in runtime seeds/config.
