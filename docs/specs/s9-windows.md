# S9. Windows: specification

> Superseded template selection (2026-11-03): [S17](s17-windows-single.md) makes `windows` the single Windows 11 desktop recipe (VM 595). `windows-desktop` is an input alias. VM 598 is retired, read-only, and retained for existing sandboxes/snapshots. Historical build evidence below is unchanged.

Status: implemented per the plan `docs/plans/s9-windows.md` (branch `s9-impl`); the `pve` numbers are in §24.4. **Ilia's decisions of 2026-10-31** (they change the spec, details in §24): Windows 11 only; no pool via hibernation, no vTPM + `suspend --todisk` spike; create is cold — clone the template + sysprep specialize on first boot, up to 5 min acceptable, 2–3 min good; the trust boundary is the VM; secrets per §12.8; no Tailscale or tunnel services; the template slot on `pve` is 598. The sections about hibernation (§14, §15 item 15, §16, §18.1 items 4–6, §18.6 items 1–4, `resume-hint`) are marked "not implemented in the MVP" and kept as phase 2 material.

Earlier: agreed (master session), 2026-10-29; the implementer review is done, remarks incorporated. Scope change from Ilia (2026-10-29): the MVP has only `windows` (Windows 11), Windows Server Core is moved to phase 2 (§22). Area S9 from `docs/roadmap.md`. Architecture: `docs/architecture.md` (§4 agent, §5 storage, §6 warm pool, §8 desktop, §11 security). Relies on `docs/specs/s5-linux-template.md` (the `umiak-tpl` pipeline, which is extended here), `docs/specs/s3-guest-agent.md` (the agent, §18 portability), `docs/specs/s1-proxmox-foundation.md` (`DiskSet`, snapshot with vCPU pause), `docs/specs/s6-control-plane.md` (pool, RAM accounting, deadlines §7.9), `docs/specs/s4-gateway.md` (§9 SSH), `docs/specs/s2-tunnel-protocol.md` (§5.2 smbios).

The decisions in the question sections 1–4 (pool via hibernation, secrets on Windows, image contents, identity and processes) were agreed with the master session on 2026-10-29. The mark **[S9]** is a decision of the spec author within what was agreed; it can be changed without new agreement if the reason is recorded.

## 1. Why and what counts as success

The `windows` template (Windows 11) gives agents and people a Windows sandbox with the same API as Linux: exec (PowerShell), files, ports, SSH, and also a desktop (S10). `windows-core` (Windows Server 2025 Core) is phase 2 (§22). Windows boots slowly, needs more RAM, can be renamed only with a reboot, and has no tmpfs. The spec decides how to keep the platform's properties anyway: a fast claim, a clean fork, no manual steps in the build, and honestly described deviations.

Success:
1. One command from a Mac builds the template from the user's ISO and `virtio-win`: install, tools, agent, sysprep, verification, registration. A person does not enter the VM console: Defender Tamper Protection, "Press any key to boot from CD", and OOBE are bypassed automatically.
2. The same registry, versions, `promote`, rollback, and `gc` as S5.
3. Claiming a Windows sandbox from the pool takes no more than 30 s in the PoC (a pool machine sleeps on disk and takes no RAM, §14). *Not implemented in the MVP (Ilia's decision 2026-10-31): there is no Windows pool, create is cold, the target is ≤ 5 min, 2–3 min is good (§14).*
4. A fork and a VM from a saved snapshot get a new identity (name, `MachineGuid`, SSH host keys, empty agent state) before the user logs in and keep the user's data, including DPAPI.
5. Commands, PTY, files, ports, SSH, and agent update work on Windows with the same semantics as on Linux, except for the deviations listed in §12.
6. After boot, `windows` has an unlocked `user` session with a helper process, on which S10 relies. *As built: autologon and a session without a lock exist, the helper `umiak-session` and the `desktop` phase are moved to S10 (§24.2 item 2).*

## 2. Goals, non-goals, anti-goals

**Goals:** the `windows` recipe; the `iso-install` branch in `umiak-tpl` (media, autounattend, PowerShell steps through QGA, sysprep, the WinPE offline stage); image contents; hardware; verification; the agent on Windows (service, ConPTY, job objects, NTFS, identity, quiesce through VSS, secrets, update); desktop hooks for S10; the pool via hibernation (`qm suspend --todisk`); measurements; licensing limits; changes in S1/S2/S3/S4/S5/S6/S7.

**Non-goals:** desktop streaming and computer-use (S10); the Linux template (S5); the whole control plane (S6, only changes here); the gateway (S4); legal decisions about licenses; Docker, WSL2, Hyper-V, and VBS inside the guest; Windows Server Core (phase 2, §22), Windows 10, Server Desktop Experience, and other editions (the recipe is parameterized, but only Windows 11 is verified in the MVP); stopping user sandboxes via hibernation (a phase 2 experiment, §14.6).

**Anti-goals** (a failure even if everything works):
- the build requires human actions in the VM console or root on the host;
- the image has a service exposed outward: RDP, WinRM, an SMB server, sshd not on loopback, a firewall rule that allows inbound traffic;
- two clones share a computer name, `MachineGuid`, SSH host keys, vTPM, or agent state; two clones of a template share the `user` password (fork keeps the source's password deliberately, §11.2);
- the build password in `unattend.xml`, build logs, installers, or build secrets remain in the image;
- a hard stop (the normal one in S6) sends the next boot into Automatic Repair or the recovery menu;
- a user process sees secret files of the previous boot or of the fork source before the agent erased them;
- a saved snapshot (`kind=saved`) carries secret files;
- Windows Update, Defender, or Store change the machine during the sandbox's life (reboot, install, CPU load).

## 3. Constraints

- The `pve` host: Proxmox VE 9.2.21, kernel 7.0.14, CPU Intel Core Ultra 9 285HX (nested virtualization is on at the host), `pve-edk2-firmware` 4.2026.08, `swtpm` 0.8.0. PoC: VMID 500–599, the RAM of all platform VMs ≤ 8 GB, `local-lvm`, network `umiak0` (S1 §4.3).
- The builder's access is the token `umiak@pve!dev` and `umiak-node` (S5 §3). Root SSH is not used. New rights and operations only from §18.1.
- The Windows ISO and license are the user's responsibility (Ilia's decision). The platform provides the pipeline, checks the checksum, and activates nothing itself.
- Checked 2026-10-29 (re-check during implementation; the result of `umiak-tpl versions --update` goes into the commit):
  - Windows 11 26H2 — build 26300, GA since 2026-09-29; the Evaluation Center offers Windows 11 Enterprise 26H2 Evaluation (90 days);
  - virtio-win: the stable one on fedorapeople is 0.1.302 (2026-08-27), but it has known problems (TRIM via vioscsi, a workaround in the QEMU config, reports of VSS regressions). Proxmox recommends 0.1.271. On `pve` there is `local:iso/virtio-win.iso` = 0.1.302 (Ilia's, we do not use it);
  - PowerShell 7.6.9 (LTS), Git for Windows 2.56.0.windows.4, Node 26.13.0 (LTS), Python 3.15.2, Go 1.27.3, Bun 1.4.4, uv 0.13.6, gh 2.103.3;
  - Win32-OpenSSH on GitHub (10.4.0.0p1) is marked "preview, non-production"; the supported path is the built-in Windows OpenSSH (on Windows 11 — a Feature on Demand).
- Ilia's template 9001 and its directory `~/prj-other/home-server/pve/win11-template` are a source of experience (TRIM, Tamper Protection, MSIX and sysprep, network during installation), but not a dependency: S9 does not touch or use them.

## 4. Overview

```
 Mac (PoC)                                                  pve
 +--------------------------------------------------+
 | umiak-tpl build windows --iso local:iso/<user.iso>  |
 |  1 verify user ISO sha256 (umiak-node media.sha256) |
 |  2 fetch virtio-win <pinned>, upload once         |
 |  3 render build ISO: autounattend.xml, build/     |
 |  4 create build VM: OVMF+SB, efidisk0, tpmstate0, |--> PVE API
 |    scsi0, net0 link_down=1, 3 CD-ROMs             |
 |  5 start + sendkey (Press any key), WinPE install |
 |    -> specialize -> OOBE -> SetupComplete: QGA    |
 |  6 steps (PowerShell, scheduled task, logs by     |
 |    offset via QGA); link up after policies        |
 |  7 offline stage (before sysprep): WinPE of the   |
 |    Windows ISO from a one-time BCD ramdisk entry, |
 |    offline autounattend: SYSTEM hive edit         |
 |    (Defender, WaaSMedic), shutdown                |
 |  8 verify-offline: boot the disk, check the log,  |
 |    Start=4, MsMpEng; umiak-agent seal, sysprep      |
 |    /generalize /oobe /shutdown                    |
 |  9 detach media, convert to template              |
 | 10 verify: clone, specialize, checks, identity    |
 |    change reboot, hard stop, hibernate + resume   |
 | 11 manifest -> registry (ready); promote          |
 +--------------------------------------------------+
```

## 5. Recipes

The directory `infra/templates/windows/` in the S5 §5 format. Shared Windows files are in `infra/templates/_windows/` (steps, unattend templates, `files/`), and the recipe references them **[S9]** so that the phase 2 recipe (§22) reuses them.

```yaml
# infra/templates/windows/template.yaml
slug: windows
os: windows
extends: null
source:
  kind: iso-install
  family: client                       # client | server; ISO, edition and key come from versions.toml [iso]
  drivers: w11                         # virtio-win subfolder: w11 | 2k25
  locale: { formats: en-US, keyboard: en-US, timezone: UTC }   # UI language = the image's own
disk: { slot: scsi0, size: 96G }
hw:
  machine: pinned                      # builder pins the newest pc-q35-<x>+pve<n> at build time, recorded in hw
  cpu: host
  bios: ovmf
  ostype: win11
  scsihw: virtio-scsi-single
  agent: "enabled=1"
  vga: std                             # S10 may change
  tablet: 1                            # absolute pointer for the console and computer-use
  rng0: "source=/dev/urandom"
  efidisk0: { efitype: 4m, pre-enrolled-keys: 1, ms-cert: 2023k }
  tpmstate0: { version: v2.0 }
  cloudinit: false
build_vm: { cores: 4, memory_mb: 4096 }
steps: [00-base, reboot, network-up, 10-system, 30-toolchains, 40-coding-agents, 50-umiak-agent, 60-desktop, 90-cleanup]
seal: sysprep
offline: [defender-off, waasmedic-off]
options: { vs_buildtools: false }
pool: { mode: hibernated }             # default mode for poolTargets of this template (§14)
size_default: { vcpu: 2, memory_mb: 4096 }
boot_timeout_s: 1200
verify: windows-desktop
```

The `windows-core` recipe is phase 2 (§22).

*As built* (`infra/templates/windows/template.yaml`): no `pool` and no `size_default` (there is no pool, §14); `shared: _windows`; an extra `reboot` after `40-coding-agents`, before `50-umiak-agent` (§24.3 R11); `install_timeout_s: 2400`; `step_timeouts` (minutes per step: `30-toolchains` 60, `40-coding-agents` 45, `90-cleanup` 120, the rest 60); `verify: windows`; `vmids: [598]`. The builder does not set `vmstatestorage`.

The builder's built-in steps: `reboot` (as in S5, but through `shutdown /r /t 0`) and `network-up` (`net0 link_down=0`, waiting for IPv4).

### 5.1 `versions.toml` (Windows)

```toml
[iso]                        # user's ISO in local:iso, see §6.1 (PoC: Ilia's retail ISO)
file = "Windows11_Client_x64_en-gb_26300_9457.iso"
sha256 = "7e3f373b...df98a5d"
edition = "Windows 11 Pro"   # /IMAGE/NAME in install.wim
product_key = "generic-pro"  # name of a public generic key in infra/templates/_windows/keys.toml; null for eval media
channel = "retail"           # retail | evaluation | volume: what verify expects from licensing (§15 item 17)

[virtio_win]                 # pinned to the version Proxmox recommends, not "stable"
version = "0.1.271"
sha256 = "..."

[tools]                      # official installers/archives, sha256 from the vendor or computed by --update
pwsh = { version = "7.6.9", sha256 = "..." }          # MSI
git = { version = "2.56.0.windows.4", sha256 = "..." } # Git-64-bit.exe
node = { version = "26.13.0", sha256 = "..." }        # MSI
python = { version = "3.15.2", sha256 = "..." }       # python.org amd64 installer
go = { version = "1.27.3", sha256 = "..." }           # MSI
bun = { version = "1.4.4", sha256 = "..." }           # zip
uv = { version = "0.13.6", sha256 = "..." }           # zip
gh = { version = "2.103.3", sha256 = "..." }          # MSI

[npm]                        # same packages as linux (S5 §6.3)

[vs_buildtools]              # only with options.vs_buildtools = true
channel = "..."
```

- For Windows `--update` also checks virtio-win against the Proxmox recommendation (the Windows VirtIO Drivers page in the Proxmox wiki) and warns if `stable` is newer than the pinned version. The virtio-win version is never raised automatically: only an explicit file change after a green `verify` (§15, the VSS and TRIM checks).
- `[iso]` describes the ISO of a specific installation; the file is committed like the other versions. The flags `--iso`, `--iso-sha256`, `--edition`, `--product-key-file` override it for one build, and the result goes into the manifest. Git holds only Microsoft's public generic keys (they select an edition but do not activate); a real key is passed as a file and does not go into the manifest.
- **PoC:** `windows` is built and verified on Ilia's ISO (Windows 11 Pro 26300 retail, no activation). Policies that Pro does not honor (zero telemetry, `NoLockScreen`) are checked by result (§15). Enterprise Evaluation is the same recipe with a different `[iso]`, with no separate verification in the PoC.

## 6. Build media

### 6.1 The user's ISO

- The user puts the ISO into `local:iso` under the original Microsoft name (through the Proxmox web interface or `umiak-tpl iso upload <file>`: upload through the PVE API with the same right as S5). The builder only reads it and never deletes it (`media.remove` does not touch it, §18.1).
- Expected names (the builder does not require them, but `preflight` hints):
  - Windows 11 Enterprise Evaluation: `*CLIENTENTERPRISEEVAL_OEMRET_x64FRE_*.iso`;
  - retail multi-edition (like Ilia's): `Windows11_Client_x64_*.iso` or `Win11_*_x64*.iso`, the edition is selected by `edition` and usually needs a generic key in `product_key`.
- **Checksum.** The builder calls `umiak-node media.sha256 <file>` (a new read-only operation, §18.1) and compares with `[iso] sha256`. The value is taken from the Microsoft download page if it is published there, otherwise the user computes it locally (`shasum -a 256`) before uploading to the host. A mismatch → the build does not start. The first build with a new ISO: `--accept-iso-sha256` prints the computed value and writes it to `versions.toml` (the file is then committed).
- The builder does not check the edition inside the ISO in advance (the host has no `wimlib`, and packages cannot be installed). A wrong `edition` shows up as no QGA response until `install_timeout` (40 min), with a hint in the error; `--keep-on-failure` leaves the VM for the console.

### 6.2 virtio-win

The builder downloads `virtio-win-<v>.iso` from `fedorapeople.org/.../archive-virtio/virtio-win-<v>-1/` into the cache `~/.cache/umiak/images/`, checks the sha256 from `versions.toml`, and uploads it once per version as `local:iso/umiak-virtio-win-<v>.iso`. Ilia's ISO `virtio-win.iso` is not used.

### 6.3 Build ISO

`local:iso/umiak-build-<buildId>.iso`, volume label `UMIAKBUILD` (Joliet; `hdiutil` or `xorriso`, as S5 §7.2 item 3):

```
autounattend.xml            # rendered: edition, product key, build password, driver paths
build/
  SetupComplete.cmd         # installs virtio guest tools + QGA, logs to C:\umiak-build\logs
  run-step.ps1              # step wrapper: transcript to <n>.log, exit code to <n>.exit
  steps/*.ps1, files/       # from infra/templates/_windows + recipe
  versions.toml, agent.toml
  umiak-agent-<v>-windows-amd64.tar
  ssh-user-ca.pub           # optional (--ssh-user-ca)
  umiak-unattend.xml          # sysprep answer file (§10.2)
```

The build password is random, generated per build, and lives only in this ISO's `autounattend.xml` and in the builder's memory. The ISO is deleted after the build (`media.remove`). On every clone the `user` password is changed at first boot (§11.2).

### 6.4 Offline ISO

`local:iso/umiak-offline-<buildId>.iso`, label `UMIAKOFFL`: `autounattend.xml` with only the `windowsPE` pass (`RunSynchronous` → `offline.cmd`) and `offline.cmd` (§10.3). Deleted after the build.

## 7. The build (`iso-install`)

The S5 §7.2 stages with differences:

1. **Preparation.** Check the agent package (`os/arch = windows/amd64`), the user's ISO (§6.1), virtio-win (§6.2). Write `building` to the registry.
2. **Media.** The build ISO and the offline ISO (§6.3, §6.4).
3. **The build VM.** `POST /nodes/{node}/qemu`: hardware from `hw`, `efidisk0=local-lvm:1,efitype=4m,pre-enrolled-keys=1,ms-cert=2023k`, `tpmstate0=local-lvm:1,version=v2.0` (for `windows`), `scsi0=local-lvm:<size>,discard=on,iothread=1,ssd=1`, `net0=virtio=<MAC>,bridge=umiak0,firewall=1,link_down=1`, `ide2=<user ISO>,media=cdrom`, `sata1=umiak-virtio-win-<v>.iso`, `sata2=umiak-build-<id>.iso`, `boot=order=scsi0;ide2`, `vmstatestorage=local-lvm`, `balloon=0`, tags and name as in S5. The network is off (`link_down=1`) until the `00-base` step sets the policies: otherwise Windows Update and Store updates during OOBE break sysprep (the 9001 experience).
4. **Installation.** Start, and right after the start call answers — `sendkey f12` four times a second for 60 s (`PUT …/sendkey`, the right `VM.Console`, §18.1): the ISO loader waits for "Press any key to boot from CD" for about 5 s. The presses go on a timer (250 ms) without waiting for the answer to the previous one: one API call on a slow channel takes seconds. Individual refusals (`not running` before QEMU starts, a monitor `Broken pipe`) do not stop the presses; during the presses the builder does not ping QGA (pinging a booting VM occupies a pvedaemon worker for a long time). After that without participation: WinPE installs the `vioscsi`, `NetKVM` drivers from virtio-win, partitions the disk, installs the edition; specialize; OOBE by the answers; `SetupComplete.cmd` installs `virtio-win-gt-x64.msi` and `qemu-ga-x86_64.msi`. The builder waits for `agent/ping` up to `install_timeout` (40 min) **[S9]**.
5. **Steps.** Each step is a scheduled task from SYSTEM, created and started through QGA (`schtasks /create /ru SYSTEM /tr "powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:\build\run-step.ps1 -Step <n>"` and `/run`). This way a step survives a QGA restart and does not hit its timeouts (the analog of the transient unit in S5). `run-step.ps1` finds the build ISO by the volume label, writes the log `C:\umiak-build\logs\<n>.log` and the exit code `<n>.exit`. Every 2 s the builder reads `<n>.exit` and a piece of the log by offset with one `agent/exec` of a PowerShell script (the files are opened with FileShare ReadWrite|Delete). `agent/file-read` is not used for files the guest writes into: on a `guest-file-open` timeout qemu-ga on Windows leaves a handle without FILE_SHARE_WRITE, and all further writes to the file fail. `Write-Log` in `run-step.ps1` retries the write when the log is busy, then accumulates lines in memory; a log error does not change the step's exit code. Steps before `10-system` run in Windows PowerShell 5.1, after PowerShell 7 is installed — in `pwsh` (`run-step.ps1` decides by the step header).
6. **Offline stage** (§10.3), after `90-cleanup` and before sysprep, on a running Windows: `sata2` → the offline ISO by a hot media swap (virtio-win stays on `sata1`; if Proxmox refused or left the swap pending — shutdown, config, boot Windows); through QGA exec a PowerShell script copies `\sources\boot.wim` and `\boot\boot.sdi` of the user's ISO into `C:\umiak-pe`, creates `{ramdiskoptions}` and an `osloader` entry with the description `umiak offline` (`device`/`osdevice` = `ramdisk=[C:]\umiak-pe\boot.wim,{ramdiskoptions}`, `winpe yes`) and sets it for one boot (`bcdedit /bootsequence`); the exit code of every `bcdedit` is checked. Then `shutdown /r /t 0` through QGA and waiting for `stopped` (up to 10 min); the boot order stays `scsi0`. If QGA responds again with a new boot time, Windows Boot Manager booted Windows, not WinPE: the entry is set again, and after the second time — `failed`. Then **verify-offline**: `sata2=none`, `boot=order=scsi0`, start, waiting for QGA; through QGA exec it reads `C:\Windows\Setup\Scripts\umiak-offline.log` (the last line `DONE errors <n>` — `DONE errors 0`, no `ERROR` lines), the `Start` of the offline set's services (4 or no key) and the `MsMpEng` process (must not be running). Otherwise `failed` with the log tail. Then the BCD entries with the description `umiak offline` (and `{ramdiskoptions}`) and `C:\umiak-pe` are deleted; `bcdedit /enum all /v` must not contain `umiak offline`, otherwise `failed`. The result goes into the manifest (`windows.offline`) and `build.json`. On this boot the agent service runs; the build VM has no umiak SMBIOS serial, `identity apply` is skipped, and the agent state is erased by the next `umiak-agent seal`.
7. **Sealing** on the VM running after verify-offline: `umiak-agent seal` (§12.11), then asynchronously through QGA `sysprep.exe /generalize /oobe /shutdown /quiet /unattend:C:\Windows\System32\Sysprep\umiak-unattend.xml`. Waiting for `stopped` up to 30 min. On an error, the last lines of `C:\Windows\System32\Sysprep\Panther\setuperr.log` go into the manifest: the builder reads them through QGA before shutdown. If sysprep failed, the VM is still running. Then `delete=ide2,sata1,sata2`, `boot=order=scsi0`, `net0 link_down=0`.
8. **Template.** `POST …/template`. The disks become `base-<vmid>-disk-<k>` for `efidisk0`, `scsi0`, `tpmstate0` (the order of `k` is recorded in `disk_layout`). Delete the build ISO and offline ISO (`media.remove`).
9. **Verification** (§15) and the manifest (S5 §11 + the §15.2 fields).

An error at any stage is handled as in S5 §7.2. Expected duration: 50–80 min (install 10–15, tools 15–25, component cleanup 10–20, sysprep 5–10).

## 8. Image contents

Below is what must be in the image; the specific registry keys, package lists, and the way of writing them are decided by the implementer in `steps/` and `files/`. Everything is checked by the §15 profile.

### 8.1 System and services (`00-base`)

- **Policies before the network:** Windows Update (`NoAutoUpdate=1`; the Windows Update servers are not blocked, because OpenSSH FoD is installed from them in `10-system`; the `wuauserv` service is disabled in `90-cleanup`), Store (`AutoDownload=2`, no app auto-updates), consumer features and CloudContent off, Delivery Optimization off, telemetry at the edition's minimum level (0 for Enterprise and Server, 1 for Pro), Error Reporting off, Edge without first-run and without background updates, Copilot, Widgets, Spotlight, Start tips and recommendations off, OneDrive not installed.
- **Services disabled** (Disabled): `wuauserv`, `UsoSvc`, `DoSvc`, `WSearch`, `SysMain`, `DiagTrack`, `dmwappushservice`, `MapsBroker`, `lfsvc`, `WerSvc`, `RemoteRegistry`, `Spooler`, `SSDPSRV`, `FDResPub`, `LanmanServer` (no SMB server and no port 445), `TermService` (RDP), `WinRM`, `CDPSvc` (port 5040). `WaaSMedicSvc` is protected from online change and is disabled by the offline stage (§10.3). The scheduled maintenance tasks (defragmentation, Compatibility Appraiser, CEIP, automatic maintenance) are off.
- **Defender is fully disabled** by the offline stage (§10.3) — the services and drivers `WinDefend`, `WdNisSvc`, `Sense`, `WdBoot`, `WdFilter`, `WdNisDrv` with `Start=4`. The engine does not start, so Tamper Protection does not come back (verified by Ilia on 9001). Why it is off: the trust boundary is the VM, Windows Update is off, and scanning noticeably slows `npm install` and builds.
- **Power and boot:** the High performance scheme, sleep and monitor off — never, guest hibernation off (`powercfg /h off`, no `hiberfil.sys`), Fast Startup off. For BCD: `bootstatuspolicy ignoreallfailures`, `recoveryenabled no`; WinRE disabled (`reagentc /disable`), no recovery partition. This is the analog of `GRUB_RECORDFAIL_TIMEOUT=0`: a hard stop must not lead to Automatic Repair.
- **Memory and secrets** (master's decision, §12.8): the pagefile is on with a fixed size (2 GiB **[S9]**: commit = RAM + pagefile, and the cleanup time at shutdown is bounded), `ClearPageFileAtShutdown=1`, memory dumps off (`CrashDumpEnabled=0`). System Restore and scheduled shadow copies are off; the VSS services (`VSS`, `swprv`) stay Manual: QGA's `fsfreeze` runs on them (§12.10).
- **Other:** time zone UTC, locale and layout en-US, system code page UTF-8 (ACP/OEMCP 65001), `LongPathsEnabled=1`, Developer Mode (symbolic links without elevation), VBS and HVCI off (with `cpu: host` and nested virt on the host, Windows would otherwise turn on Hyper-V under itself and slow down). For w32time: NTP `time.windows.com`, `MaxPosPhaseCorrection` and `MaxNegPhaseCorrection` = `0xFFFFFFFF` (large jumps after waking, §14.3).
- **Firewall on** in all profiles: inbound denied, all preinstalled inbound allow rules disabled, local rules ignored by policy (`AllowLocalPolicyMerge=0` in `HKLM\SOFTWARE\Policies\Microsoft\WindowsFirewall\<Profile>` for Domain/Private/Public: Setup and Appx registration on a clone turn the rules back on), and there also `DoNotAllowExceptions=1` ("shields up", in the ActiveStore `AllowInboundRules=False`): inbound allow rules are not applied at all, including the AppX capability rules of `user`'s first login, which live outside the local store; notifications about new listeners are off (`NotifyOnListen=False`, otherwise the "allow access" dialog interferes with computer-use). The firewall does not filter loopback, so the agent's CONNECT and sshd on loopback work. Further protection is the Proxmox firewall (`policy_in=DROP`, S1 §4.4).
- **Appx (`windows`):** remove the provisioned packages that the sandbox does not need and that break sysprep on update (Teams, the new Outlook, Clipchamp, News, Weather, Xbox, Solitaire, Bing, Feedback Hub, Get Help, Office Hub, To Do, Copilot, etc.; the list is `files/appx-remove.txt`). Keep Edge, Terminal, Notepad, Calculator, Paint, Snipping Tool, Photos, Store, and App Installer (`winget` for the user). Nobody logs in to the `user` profile before sysprep, so there are no per-user MSIX packages that break sysprep (`0x80073cf2`, the 9001 experience).

### 8.2 Users and login (`10-system`)

- A local `user` in the Administrators group. It is created by the build OOBE (`LocalAccounts` in `autounattend.xml`) with the build password. The password has no expiry, and nobody logs in to the profile before sysprep. The built-in Administrator is disabled. There are no other enabled local accounts (Guest, DefaultAccount, WDAGUtilityAccount are disabled).
- The `user` password is changed on every clone (§11.2) and stored only in LSA secrets (`DefaultPassword` for autologon, `L$umiak_user` for the agent). It is in no files.
- UAC is on (`EnableLUA=1`: without it MSIX apps, including Terminal, do not work), but without prompts: `ConsentPromptBehaviorAdmin=0`, `PromptOnSecureDesktop=0`.

### 8.3 SSH

- The built-in OpenSSH Server is installed by `Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0` (a Feature on Demand from Windows Update; the `wuauserv` service is disabled only in `90-cleanup`) **[S9]**. Win32-OpenSSH from GitHub is not used: all its releases are marked "non-production". If the FoD is unavailable, the fallback is the recipe flag `openssh: github` (the MSI of the same build as 9001), without changing the rest of the scheme.
- `C:\ProgramData\ssh\sshd_config`: `ListenAddress 127.0.0.1`, `ListenAddress ::1`, `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `PubkeyAuthentication yes`, `TrustedUserCAKeys __PROGRAMDATA__/ssh/umiak_user_ca.pub`. The `Match Group administrators` block with `administrators_authorized_keys` stays as default; the file does not exist, login is by certificate only (S4 §9.3, principal `user`).
- `HKLM\SOFTWARE\OpenSSH\DefaultShell` = `C:\Program Files\PowerShell\7\pwsh.exe` (S4 §13: the default shell is PowerShell).
- The `sshd` service is **Manual**: the agent starts it after checking identity (§12.3). This way sshd never runs with old host keys. The firewall rule `OpenSSH-Server-In-TCP` is deleted.
- `C:\ProgramData\umiak-agent\ssh-user-ca.pub` — the template's CA keys (from `--ssh-user-ca` or an empty file); `umiak_user_ca.pub` is its copy with the ACL sshd requires (owner SYSTEM, write only for SYSTEM and Administrators).
- A known Windows OpenSSH limitation: login by key or certificate gives an S4U token without network credentials. In an SSH session Credential Manager and the user's DPAPI do not work (e.g. storing a `gh` token in Windows Credential Manager). Agent commands do not suffer from this (§12.5). The limitation is recorded in the S7 documentation.

### 8.4 PowerShell and profiles

- PowerShell 7 LTS (MSI, all users, in `PATH`, without telemetry: `POWERSHELL_TELEMETRY_OPTOUT=1` in the system env). Windows PowerShell 5.1 stays.
- AllUsersAllHosts profiles (`$PSHOME\profile.ps1` for pwsh 7 and for 5.1): if `UMIAK_ENV_APPLIED` is not set, run `umiak-agent env --format pwsh` and apply the result. This way SSH sessions get the sandbox env (§12.7). Agent commands arrive with `UMIAK_ENV_APPLIED=1`, so the profile does not overwrite their env. Console encoding is UTF-8.

### 8.5 Tools (`30-toolchains`, `40-coding-agents`)

The rule is as in S5 §8.9: every command is found by name from the system `PATH` — both for `user` in agent commands (direct exec and `pwsh -Command`) and in an SSH session.

| Tool | How it is installed **[S9]** |
|---|---|
| Git for Windows (+ Git Bash) | the official installer, silent, all users; `core.autocrlf=false`, `core.symlinks=true` at the system level. Git Bash is needed by Claude Code on Windows (`CLAUDE_CODE_GIT_BASH_PATH` in the system env) |
| PowerShell 7 | §8.4 |
| Node LTS (+ npm, npx) | MSI. The global npm prefix = `C:\ProgramData\npm` (in the system `PATH`), otherwise `npm -g` from SYSTEM writes into the SYSTEM profile |
| Python 3 | the python.org installer: all users, `PrependPath`, the `py` launcher; `uv`, `uvx` — a zip in `C:\Program Files\uv` |
| Bun | zip → `C:\Program Files\bun` |
| Go | MSI |
| gh | MSI |
| Claude Code, Codex, OpenCode, Gemini CLI | `npm install -g <pkg>@<version>` (versions as in S5) |
| VS Build Tools (C++), Rust (MSVC) | only with `options.vs_buildtools: true` (master's decision: off by default because of the Visual Studio license and +6–8 GB) |

- Not included: Docker, WSL2, Hyper-V, JVM, Chrome (S10 will decide the browser for computer-use; Edge is in Windows 11).
- CLI auto-update is turned off where it can be configured system-wide (as in S5).

### 8.6 The agent (`50-umiak-agent`)

- `umiak-agent install-package D:\build\umiak-agent-<v>-windows-amd64.tar` (§12.12) → `C:\Program Files\umiak-agent\versions\<v>\`, the junctions `current`, `previous`, the service `umiak-agent` (§12.2), `C:\ProgramData\umiak-agent\agent.toml` (§12.1).
- A computer startup script in the local group policy: `umiak-agent.exe early` (§12.3) and `SyncForegroundPolicy=1`, so that it finishes before login.
- `qemu-guest-agent` (the service `QEMU-GA`) — automatic start, a fallback channel. The `VSS provider` from the virtio-win guest tools is registered (needed for `fsfreeze`, §12.10).

### 8.7 Desktop (`60-desktop`)

- The scheduled task `\umiak\session`: trigger "at `user` logon", `RunLevel Highest`, restart on failure once a minute, action `C:\Program Files\umiak-agent\current\umiak-session.exe` (§13). *Not done in S9: the task and the helper are S10.*
- The Winlogon keys for autologon are written by `identity apply` (§11.2), not by the build.
- No lock screen: `NoLockScreen=1` (where the edition honors it: Enterprise, Education, Server), `powercfg CONSOLELOCK 0` (no login required on wake), the screensaver off. In the Default User hive: `DisableLockWorkstation=1`, the first-logon animation (`EnableFirstLogonAnimation=0`), the privacy experience, "let's finish setting up" (SCOOBE), the PIN and Windows Hello offer, and tip notifications are off. The `user` profile is created at first autologon from Default User.

### 8.8 Cleanup (`90-cleanup`)

- The services `wuauserv`, `UsoSvc` → Disabled (until then the FoD needs them).
- `Dism /Online /Cleanup-Image /StartComponentCleanup /ResetBase`; delete `C:\umiak-build`, `C:\Windows\Temp\*`, downloads and installer caches (`npm`, `pip`, `uv`, `go`), `C:\Windows\Panther\unattend*.xml` and copies of the answers (they contain the build password); clear the event logs.
- Write `C:\ProgramData\umiak-template\build.json` (the manifest without the verification part).
- `Optimize-Volume -DriveLetter C -ReTrim`: an error is not fatal while TRIM through vioscsi is not fixed (§23).
- Check: no services from §8.1 are in the Running/Automatic state, no `authorized_keys` files, no password in `Panther`.

## 9. Template hardware

The template VM config = the recipe's `hw` + disks (§5). Why **[S9]**:
- **OVMF + Secure Boot with the Microsoft 2023 keys, vTPM 2.0** — Windows 11 requirements, no hardware check bypasses are needed.
- **Each machine from the template has its own vTPM.** A copy of the template's `tpmstate0` would give all sandboxes identical TPM keys (EK, SRK) and ownership data. So S1 `create` from a template does not clone `tpmstate0` but creates a new one (`tpmstate0=local-lvm:1,version=v2.0`, Proxmox allocates a volume, swtpm initializes it at first start), and Windows sees a new TPM at specialize. A fork and a VM from a snapshot copy the source's `tpmstate0` together with the disks: it is a copy of the same machine. `efidisk0` is always cloned (Secure Boot keys and boot entries).
- **BitLocker and automatic device encryption are forbidden** (`PreventDeviceEncryption=1` in the install's specialize): with TPM and Secure Boot Windows 11 may turn it on during installation. This would break the offline stage and sysprep and write the whole disk into the thin pool.
- **`machine` is pinned** (the builder takes the newest `pc-q35-<x>+pve<n>` at build time, now `pc-q35-11.0+pve2`, as with 9001): changing the machine type version changes the devices for Windows. S1 copies `machine` from the template, and clones inherit the pinned version.
- **`cpu: host`** with VBS and HVCI off in the guest (§8.1). The §16.3 experiment compares it with `x86-64-v3`.
- **`args` is not used:** only root can set it, and the 9001 TRIM workaround (`discard_granularity=65536`) requires `args`. Instead virtio-win 0.1.271 is pinned; once a driver with the TRIM fix is released (virtio-win #1574, fixed in code 2026-10-15), the TRIM check becomes mandatory (§15, §23).
- `balloon=0` (S1), `rng0` (the `viorng` driver from virtio-win), `vga: std` (S10 will decide the video), `vmstatestorage=local-lvm` (for hibernation, §14).
- The default size in the PoC: 2 vCPU / 4 GB (the Windows 11 minimum). A thin 96 GiB disk.

## 10. Sealing

### 10.1 Order

`90-cleanup` → the offline stage (WinPE from a one-shot BCD entry) → verify-offline (disk boot, result check) → `umiak-agent seal` → `sysprep /generalize /oobe /shutdown` → template. Sysprep runs once per template. Specialize is passed by every pool machine on first boot; the pool hides this time (master's decision, §11.1).

### 10.2 `umiak-unattend.xml` (answers for clones)

- `generalize`: `PersistAllDeviceInstalls=true` (the virtio drivers are not reinstalled, so specialize is shorter), `SkipRearm=0`.
- `specialize`: `RunSynchronous` → `"C:\Program Files\umiak-agent\current\umiak-agent.exe" identity apply --specialize` (§11.2), then `reg.exe add` `Start=4` for `dmwappushservice` (§10.3). In Shell-Setup a stub `ComputerName=UMIAKTEMPLATE`: Setup always overwrites the name set in specialize, so the agent sets `UMI<12 hex>` with one reboot after setup (R16).
- `oobeSystem`: all OOBE screens are hidden (`HideEULAPage`, `HideLocalAccountScreen`, `HideOEMRegistrationScreen`, `HideOnlineAccountScreens`, `HideWirelessSetupInOOBE`, `ProtectYourPC=3`) and skipped (`SkipMachineOOBE`, `SkipUserOOBE`: without them OOBE stops at "Who's going to use this device?"), locale en-US, UTC. No new accounts (`user` already exists), autologon is not set here (the agent writes it).
- `SystemLocale` is in no pass: it rewrites the code pages.
- **The clone's first-boot script.** Generalize, specialize, and OOBE reset some of the image's settings. `90-cleanup` puts in `C:\Windows\Setup\Scripts\SetupComplete.cmd` (`files/SetupComplete-clone.cmd`) and `C:\ProgramData\umiak-template\firstboot.ps1` (ACL: SYSTEM and Administrators full control, Users read). Setup runs it as SYSTEM after OOBE, before the first login: the §8.1 services (the `lib.ps1` list, `CDPSvc`, `dmwappushservice`) → Disabled, ACP/OEMCP/MACCP = 65001 (effective from the next boot — the rename reboot), `reagentc /disable`, BCD `recoveryenabled no` and `bootstatuspolicy ignoreallfailures`, NetBIOS off, the firewall policy `AllowLocalPolicyMerge=0` and `DoNotAllowExceptions=1`. Errors are only written to `C:\ProgramData\umiak-template\firstboot.log` (no secrets, the last line `done`), the exit is always 0. The last action is `C:\ProgramData\umiak-template\firstboot.done` (UTC time), also after errors; the image does not have it (`90-cleanup`). The agent starts in parallel with `SetupComplete.cmd`: while `SetupComplete.cmd` exists and `firstboot.done` does not, it waits for the marker (up to 5 min, then a warning in the log) before the boot step and before the rename reboot, otherwise the reboot interrupts `firstboot.ps1`.
- The file lies in `C:\Windows\System32\Sysprep\` and contains no passwords. After the first boot setup itself replaces the copies of the answers in `Panther`; the agent deletes `umiak-unattend.xml` on a clone in `identity apply`.

### 10.3 The WinPE offline stage

It is needed because some settings cannot be changed in a running Windows: Tamper Protection blocks Defender, `WaaSMedicSvc` is protected. The builder has no root on the host (like `hivex` in 9001).

- WinPE from the user's ISO `boot.wim` is booted once from a ramdisk BCD entry of the installed, not yet sealed Windows (§7 item 6): the Windows Boot Manager on the disk starts it deterministically, without the "Press any key" prompt and without `sendkey`. Windows Setup in this WinPE finds `autounattend.xml` on the offline ISO and in the `windowsPE` pass runs `RunSynchronous` → `offline.cmd`. The file answers the language, key, and license pages as installation answers (`International-Core-WinPE` with `ui_language`, `UserData` with a generic key and `AcceptEula`), so that Setup does not wait for input. The installation itself does not begin: at the end the script runs `wpeutil shutdown`.
- `offline.cmd` (cmd and `reg.exe`, there is no PowerShell in the install WinPE): load the disk driver (`drvload <virtio-win>\vioscsi\w11\amd64\vioscsi.inf`: the install WinPE has no virtio driver, and `DriverPaths` from `windowsPE` apply only to the installation itself); find the volume with `\Windows\System32\config\SYSTEM` (the drive letter is not known in advance); `reg load HKLM\OFFSYS`; for each `ControlSet00x` set `Start=4` for the services from the recipe's `offline` (`defender-off`: the six services and drivers of §8.1; `waasmedic-off`: `WaaSMedicSvc`); `reg unload`; write `\Windows\Setup\Scripts\umiak-offline.log`; `wpeutil shutdown`.
- `dmwappushservice` is not in the offline set: without it sysprep `/generalize` may hang, and the offline stage runs before sysprep. On the template it is Manual; on every clone specialize disables it (`umiak-unattend.xml`, `RunSynchronous` Order 2: `reg.exe add …\Services\dmwappushservice /v Start /t REG_DWORD /d 4 /f`) before services start for the first time.
- The builder waits for `stopped` up to 10 min. An error in WinPE is visible only as a timeout (there is no QGA in WinPE). The result is checked at once, in verify-offline (§7 item 6): the log, `Start=4`, `MsMpEng`; `verify` on a clone checks it once more (§15 item 8).
- **Why not a CD boot (R17).** Earlier the stage booted the ISO with `boot=order=ide2` and pressed a key at "Press any key to boot from CD". After an unsealed Windows had run (the normal build course), OVMF skipped the prompt every time (9 of 9 attempts on `pve`) and booted the disk through the Windows Boot Manager entry in `efidisk0`. The one-shot BCD entry does not depend on this; if the Windows Boot Manager still ignores it, QGA answers with a new boot time (WinPE has none), and the builder sets the entry again. The stage runs before sysprep, so booting the disk instead of WinPE is harmless; verify-offline checks the result before sysprep. `VM.Console` is needed only for the installation prompt (§7 item 4).
- Why not a script of the installation's PE stage (like unattend-generator by Schneegans, where the installation is driven by its own script: diskpart, dism, hive editing, bcdboot): the offline stage is shorter, does not replace Windows Setup, and suits any future offline edits.

## 11. The clone's first boot and identity

### 11.1 A pool machine (from the template)

1. Specialize: `identity apply --specialize` (§11.2), with no reboot by the agent.
2. OOBE by the answers, no screens (`SkipMachineOOBE`, `SkipUserOOBE`); `SetupComplete.cmd` → `firstboot.ps1` (§10.2).
3. Setup overwrote the name with `UMIAKTEMPLATE`: the agent renames the machine to `UMI<12 hex>` with one reboot (§11.2 item 8, R16).
4. A normal boot: the startup script `umiak-agent early` (identity matches, secrets cleanup), the `umiak-agent` service starts sshd and connects to the tunnel.
5. `windows`: autologon of `user` → the first login creates the profile → `\umiak\session` starts `umiak-session` → phase `desktop: ready` (§13). *As built: only autologon and the profile; the helper and the `desktop` phase are S10.*
6. Phase `pool_ready` (§12.13) → S6 puts the machine into hibernation (§14). *Not implemented in the MVP (Ilia's decision 2026-10-31): right after the agent is ready — an immediate claim (cold create).*

### 11.2 `identity apply`

Compares the `machineId` from smbios with `C:\ProgramData\umiak-agent\identity.json`. On a match it does nothing. Otherwise (a fork, a VM from a saved snapshot, the first boot after `seal`):

1. Erase the agent state (as S3 §7.2 item 1) and the secrets directory (§12.8); `env` is empty; `umiak_user_ca.pub` is a copy of the template's.
2. `MachineGuid` (`HKLM\SOFTWARE\Microsoft\Cryptography`) = `machineId`.
3. SSH host keys: delete `C:\ProgramData\ssh\ssh_host_*`, create new ones (`ssh-keygen -A` from the built-in OpenSSH), set the ACLs sshd requires.
4. The computer name `UMI` + the last 12 hex of `machineId` in uppercase (15 characters is the NetBIOS limit) through `SetComputerNameExW(ComputerNamePhysicalDnsHostname)`.
5. **For a template clone only** (`identity.json` does not exist, i.e. the first boot after `seal`): a new random `user` password (32 characters), `L$umiak_user`, for `windows` also `DefaultPassword` and the Winlogon keys (`AutoAdminLogon=1`, `DefaultUserName=user`, `DefaultDomainName=.`). The `user` profile does not exist yet at this moment, so nothing is lost. **A fork and a VM from a saved snapshot do not change the password:** an administrator's password reset makes the user's DPAPI data unavailable (Credential Manager, `gh` tokens, Edge cookies), and a fork is a copy of the same machine. The LSA secret is copied with the disk, and autologon and the agent's tokens keep working.
- Delete `C:\Windows\System32\Sysprep\umiak-unattend.xml` if it still exists.
7. Write `identity.json` with `resetPending` (FlushFileBuffers).
8. If the effective name (`ActiveComputerName`) ≠ the new one and this is not the `--specialize` mode — a reboot (`InitiateShutdownW`, reason "planned"). A fork and a VM from a saved snapshot therefore boot one reboot longer (master's decision: +15–25 s). A template clone too: after specialize Setup always sets the name from the answers (`UMIAKTEMPLATE`), so on its first boot the agent does exactly one such reboot after setup (R16, ~25 s). *s10-followups:* `identity.json` stores `rebootBoot` — the `bootId` of the boot that requested the reboot. While `bootId` is the same, the reboot counts as not yet happened: each agent start in this boot asks for it again (without incrementing `renameReboots` and without hitting `MaxRenameReboots`), and the `identity` phase does not become ready in this boot. Earlier, under load Windows performed the reboot later than the agent's 2 min wait, after two restarts the agent stopped asking for it, became ready, the sandbox got a claim — and ~4 min later rebooted under the user. Now such a create is just longer; `MaxRenameReboots` counts only boots that actually rebooted and where the name still did not apply.

The machine SID does not change: there is no domain, and a duplicate machine SID outside a domain affects nothing. A consequence for a future KMS: a fork inherits the CMID (§17).

Where it runs (the same code under one global named mutex): `--specialize` in the specialize pass; `umiak-agent early` on every boot before the login screen; the `umiak-agent` service at start as insurance (if the startup script did not run — with the same reboot and a log warning).

### 11.3 Hostname from the claim

Not applied on Windows (master's decision): renaming requires a reboot, and a claim must take fractions of a second. The name stays `UMI<12 hex>`. The agent answers a claim with `hostname_applied = false` and returns the effective name in `System/Info.hostname`. The value from the claim is available to commands as the env `UMIAK_HOSTNAME`.

## 12. The agent on Windows

The same binary and protocols as in S3. Below are the implementations of the S3 §18 interfaces and all semantic differences. What is not mentioned works as in S3.

### 12.1 Directories

| Path | What | Linux analog |
|---|---|---|
| `C:\Program Files\umiak-agent\versions\<v>\` | `umiak-agent.exe`, `umiak-session.exe`, `manifest.json`, `manifest.sig`, `trust\` | `/usr/local/lib/umiak-agent/versions/<v>/` |
| `C:\Program Files\umiak-agent\current`, `previous` | junctions to versions; `current` is in the system `PATH` | symlinks |
| `C:\ProgramData\umiak-agent\agent.toml` | template settings | `/etc/umiak-agent/agent.toml` |
| `C:\ProgramData\umiak-agent\state\` | `state.db`, `commands\<id>\`, `uploads\`, `identity.json`, `pending-update.json`; ACL SYSTEM only | `/var/lib/umiak-agent/` |
| `C:\ProgramData\umiak-agent\run\` | sockets, `status.json`, the quiesce lease; cleared at start if `bootId` changed | `/run/umiak-agent/` (tmpfs) |
| `C:\ProgramData\umiak-agent\logs\` | `agent.log` with rotation (10 × 10 MiB), asynchronous writes | journald |
| `C:\ProgramData\umiak\secrets\` | `files\<name>` (§12.8) | `/run/umiak/secrets/` (tmpfs) |
| `C:\ProgramData\umiak-agent\ssh-user-ca.pub`, `C:\ProgramData\ssh\umiak_user_ca.pub` | the template's SSH CA keys and the effective ones | `/etc/umiak-agent/…`, `/etc/ssh/…` |

The Windows `agent.toml`: `[user] default = "user"`, `[docker] enabled = false`, `[readiness] required = ["identity", "claim", "secrets", "desktop"]`, `[ports] exclude = [22, 135]` and `exclude_processes` (§12.9).

### 12.2 The service (`ServiceManager`)

- `umiak-agent`, LocalSystem, Automatic (not Delayed), `ImagePath = "C:\Program Files\umiak-agent\current\umiak-agent.exe" run`, through `golang.org/x/sys/windows/svc`. Process priority `ABOVE_NORMAL` (the analog of `CPUWeight`).
- Accepts `SERVICE_CONTROL_PRESHUTDOWN` (timeout 15 s): finish the command jobs, erase secrets (§12.8), flush `state.db`.
- **Failure actions** (the analog of `Restart=always` + `StartLimitBurst` + `OnFailure`): restart after 1 s, restart after 1 s, then `run command` = `previous\umiak-agent.exe rollback` (if `previous` does not exist — `current`); reset period 120 s; `FailureActionsOnNonCrashFailures=1`. Self-update: the agent responds and exits with a nonzero code without `SERVICE_STOPPED`, and SCM restarts it, now from the new version (S3 §17.4 item 5). After switching versions `rollback` runs `sc start umiak-agent`.
- `READY` in the S5 §17.3 item 4 sense: the service moves to `SERVICE_RUNNING` after opening `state.db` and restoring the shim, without waiting for the tunnel.

### 12.3 Boot

0. **While Windows Setup is running** (specialize and OOBE of a clone; `ImageState` in `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Setup\State` ≠ `IMAGE_STATE_COMPLETE`), the service and `early` do nothing: no identity work and no reboots, the service waits. Identity during this time is set only by `identity apply --specialize` (§11.2).
1. **`umiak-agent early`** — the computer startup script (local GPO): identity (§11.2, on change — a reboot before login), clearing the secrets directory (§12.8), clearing `run\` on a new `bootId`, the marker `run\early.json {bootId}`. So that the script is guaranteed to finish before login (including before autologon), the policy "Always wait for the network at computer startup and logon" (`SyncForegroundPolicy=1`) is turned on: without it Fast Logon Optimization runs the computer policy asynchronously. The cost is that login waits for the network, DHCP in `umiak0` answers in seconds; measurement §16.
2. **The service** (starts in parallel with the script): waits for the current boot's `early.json` up to 60 s, otherwise performs the same steps itself. Until then `Start`, `Claim`, and `UpdateSecrets` are not served (`unavailable identity_not_ready`). Then the S3 §6 item 2 steps. After identity is ready the agent starts `sshd` (`Start-Service`, the service is Manual, §8.3).

Why not "before the network" as on Linux: on Windows the network stack is a driver, and a service cannot start earlier than it. On Linux the order is needed because of the DHCP DUID derived from machine-id. Windows uses a client id by MAC, so a fork has no duplicate IP. Secrets are unavailable over the network: there is no SMB server, and inbound is denied by the Windows and Proxmox firewalls.

The master's requirement "before any user process" rests on order, not on ACLs. `user` is an administrator with an elevated token, and bypass traversal checking gives access to a file by its full path if the file's own ACL allows it. The order is: the startup script with `SyncForegroundPolicy` before login; agent commands only after `early.json`; one edge case remains: a "at startup" scheduler task created by the user themselves runs in parallel with the startup script. It can read the secret files only of its own sandbox (after a hard stop) or of the fork source (a fork inherits secrets by design). A VM from a saved snapshot carries no secret files (§18.6 item 5). The §20 item 5 acceptance check: a secret file left by a hard stop is not visible to the `user` session's autostart program.

### 12.4 Identity (`IdentitySource`)

- **smbios:** `GetSystemFirmwareTable('RSMB')`, structure type 1: `uuid`, `serial` (`umiak1:…`, S2 §5.2), `family` (`umiakt1:<url>`, S5 §14). On Windows any unprivileged process can read SMBIOS (on Linux only root reads `product_serial`). BS is visible to all VM processes. This is acceptable within the accepted model (the trust boundary is the VM, S3 §4) and is recorded in S2.
- **vmgenid:** `\\.\VmGenerationCounter`, `IOCTL_VMGENCOUNTER_READ` (16 bytes) → the header `Umiak-Vmgenid` (hex). Informational only: our fork is always a cold start, and the decision to change identity is made by `machineId`.
- **bootId:** a UUIDv5 of `machineId` and the boot counter `BootId` (`HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management\PrefetchParameters`). Waking from Proxmox hibernation is not a boot, `bootId` does not change, and that is right: the processes are alive. If the counter proves unreliable, the implementer takes the kernel boot time (`NtQuerySystemInformation`) with a check for resilience to clock changes and records the reason. *As built: the fallback is a random UUID in a volatile registry key, not the kernel boot time (§24.2 item 14).*

### 12.5 Users and tokens (`Credentials`)

- `user` (default): `LogonUserW(user, ".", <password from L$umiak_user>, LOGON32_LOGON_INTERACTIVE)` → the linked elevated token (`TokenLinkedToken`). This is the analog of NOPASSWD sudo from S3 §4 (master's decision). The token comes with a password, so DPAPI and Credential Manager work for the process. The profile is loaded by `LoadUserProfileW` for the duration of the command.
- `SYSTEM`: the service's own token. The name `root` is an alias for `SYSTEM` for script portability **[S9]**.
- Other names → `invalid_argument user_not_found` (in v1 only these two).
- Files created by the agent get the request's user as owner; the ACL is inherited from the parent.

### 12.6 Processes (`Supervisor`, `PTY`)

**Shim.** `umiak-agent shim --id <id>` is started by the agent with `CREATE_BREAKAWAY_FROM_JOB | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` from its own version's directory. SCM does not kill child processes when the service stops or restarts, so the shim and commands survive an agent restart and update. A version directory with live shims is not deleted (Windows will not let a running exe be deleted anyway).

- **The job is a permanent named object.** The shim creates the job `\BaseNamedObjects\Global\umiak-cmd-<id>` through `NtCreateJobObject` with `OBJ_PERMANENT` (SYSTEM has the right `SeCreatePermanentPrivilege`; an ntdll call without cgo). An ordinary named object disappears with its last handle: the job's processes hold no handle to it, and after the shim died the job could not be found. A permanent job survives the shim and the agent until reboot. The agent opens it by name (`OpenJobObject`) for `Kill`, `SIGKILL`, `KILL_LEFTOVERS`, and recovery. Permanence is removed by `NtMakeTemporaryObject` when the command ended with no leftovers or was deleted (`Remove`, retention); after a reboot the objects are gone.
- **Exactly one start.** If a job with that name already exists (`STATUS_OBJECT_NAME_COLLISION`), the shim exits: this is the analog of the deterministic unit name. The `shim.json` marker and the `Start` retry rules are as in S3 §9.2. If `OBJ_PERMANENT` turns out unavailable, the implementer's fallback: the agent holds a duplicate of the job handle (`DuplicateHandle` from the shim), and `shim.json` stores pids for lookup after an agent restart; the reason is recorded in §24.
- **Agent ↔ shim IPC:** an AF_UNIX socket `C:\ProgramData\umiak-agent\run\cmd\<id>.sock` (Go `net` supports AF_UNIX on Windows; the directory ACL is SYSTEM only). The protocol is S3 §9.6. The command spec with env is passed as the first message over the socket, not as a file: Windows has no tmpfs. Readiness is the message `Started{pid}` instead of `READY=1`. *As built: the spec goes to the shim's stdin, readiness is the line `READY` in its stdout, the socket protocol was not changed (§24.2 item 3); shim liveness is the mutex `Global\umiak-shim-<id>` (§24.2 item 5).*
- **Launch:** `CreateProcessAsUserW` with the attributes `PROC_THREAD_ATTRIBUTE_JOB_LIST` (the process goes into the job at once), `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` (pipes), and for a PTY `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE`; `CREATE_UNICODE_ENVIRONMENT`. Without a PTY — `CREATE_NO_WINDOW` (a hidden console, which console programs need). The desktop is the logon session's service window station; with `desktop: true` — `winsta0\default` of the console session (§13).
- **Job limits:** `JOB_OBJECT_LIMIT_BREAKAWAY_OK` is not set (descendants do not leave the job), `KILL_ON_JOB_CLOSE` is not set: if the shim crashed, the command lives, and the agent finds the job by name and can kill it (the analog of `cgroup.kill`).
- **Leftovers:** the number of active processes in the job (`JOBOBJECT_BASIC_ACCOUNTING_INFORMATION.ActiveProcesses`, the message `JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO` through a completion port). The shim does not exit while the job is non-empty and the pipes are not closed (as S3 §9.3).
- **Output:** pipes → the files `stdout`, `stderr`, `pty` (§12.9). Draining at exit is as in S3; for ConPTY after the main process exits — `ClosePseudoConsole` and reading to EOF.
- **ConPTY:** `CreatePseudoConsole`, `ResizePseudoConsole`, `ClosePseudoConsole` from `golang.org/x/sys/windows`. `term` from the spec does not affect ConPTY; `TERM=xterm-256color` is set in the process env. Input and `seq` deduplication are as in S3 §9.4.

**`argv`.** `argv[0]` is looked up through `PATH` and `PATHEXT` of the assembled env (§12.7). The command line is built by MSVCRT rules (like `syscall.EscapeArg`). `.cmd` and `.bat` (e.g. `npm`, `npx`) are launched through `cmd.exe /d /s /c` with safe escaping; arguments that cannot be safely passed to a batch file (the BatBadBut class) → `invalid_argument unsafe_batch_args`.

**`shell`.** `pwsh.exe -NoLogo -NonInteractive [-NoProfile if login=false]` (master's decision). `pwsh -Command` itself turns any exit code of the last external program, other than 0 and 1, into 1. So the agent passes the user's script with an epilogue that preserves the code **[S9: the contract is mandatory, the epilogue form is the implementer's]**:

```powershell
$global:LASTEXITCODE = 0
<shell>
# epilogue (own line, so a trailing comment in <shell> cannot swallow it)
$__umiak_ok = $?; if ($__umiak_ok) { exit 0 } elseif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } else { exit 1 }
```

The contract: `exit N` in the script → N; the last command succeeded → 0; the last command is an external program with a nonzero code → its code; the last command is a cmdlet with an error → a nonzero code (1, or the code of an earlier failed external program); a syntax error → 1. The script is passed through `-EncodedCommand` (no escaping problems), and if it is longer than the command line limit — as a `.ps1` file in the command directory (no env in it) through `-File`. Acceptance checks: `exit 7` → 7, `cmd /c exit 3` → 3, `Get-Item C:\nope` as the last command → 1, `Write-Output ok` → 0. cmd.exe — through `argv`.

**Signals and Kill** (master's decision):

| Request | Without PTY | PTY |
|---|---|---|
| `SIGINT`, `SIGTERM` | `CTRL_BREAK_EVENT` to the process group (the shim attaches to the command's console) | the byte `0x03` into the ConPTY input |
| `SIGHUP` | `unsupported_signal` | `ClosePseudoConsole` (`CTRL_CLOSE_EVENT` to console processes) |
| `SIGKILL` | `TerminateJobObject` | `TerminateJobObject` |
| others | `invalid_argument unsupported_signal` | the same |

`Kill(grace_ms)`: `SIGTERM`, after `grace_ms` — `TerminateJobObject`. PTY timeout without a client: `ClosePseudoConsole`, after 10 s — `TerminateJobObject`.

**Exit.** `code` is the process exit code (`uint32`, NTSTATUS codes like `0xC0000005` pass as is), `signal` is empty. After `TerminateJobObject` — `status KILLED`, `code 1`, `reason` as in S3 (`SIGNAL`, `TIMEOUT`, `PTY_IDLE`). `reason OOM` does not occur on Windows: there is no OOM killer, and no job memory limits are set in v1. When commit runs out, processes get memory allocation errors.

### 12.7 Env

The order is as in S3 §8.2, the last wins. Merging is case-insensitive, the canonical name is kept (`Path`).
1. `CreateEnvironmentBlock(token, FALSE)`: system and user variables from the registry (`Path`, `USERPROFILE`, `APPDATA`, `TEMP` …).
2. Platform: `UMIAK=1`, `UMIAK_SANDBOX_ID`, `UMIAK_PORT_DOMAIN`, `UMIAK_HOSTNAME`, `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`, `UMIAK_ENV_APPLIED=1`, `TERM` for a PTY.
3. `env` from the claim. 4. `secret_env`. 5. `env` from the spec.

**SSH sessions:** the pwsh profile (§8.4) calls `umiak-agent env --format pwsh`. The CLI gets items 2–4 from the service over the AF_UNIX socket `run\env.sock`: the ACL is SYSTEM, Administrators, and `user`; AF_UNIX on Windows has no peer credentials, access is decided by the socket file's ACL. `cmd.exe` sessions do not get the sandbox env (documented in S7).

**Desktop session:** `umiak-session` writes the non-secret claim env to `HKCU\Environment` and broadcasts `WM_SETTINGCHANGE`. Secrets do not go there.

### 12.8 Secrets (`SecretStore`)

The master's decision (conditions a–d), the trust boundary is the VM:
- **`secret_env`** — only in the agent's memory and in process envs. After an agent restart (crash, update) the values vanish, the `secrets` phase → `pending`, the event `readiness.changed`; S6 sends `UpdateSecrets` again (§18.6 item 7). While `secrets: pending` with a non-empty `secretsDigest`, `Start` waits for `UpdateSecrets` up to 30 s, then `unavailable secrets_pending` (retryable): a command must not start quietly without secrets.
- **`secret_files`** — `C:\ProgramData\umiak\secrets\files\<name>` with the attribute `FILE_ATTRIBUTE_TEMPORARY`, ACL SYSTEM + `user` (the mode from the request reduces to read-only or read-write; *as built: any write bit in `mode` → `user` read-write, otherwise read-only, §24.2 item 13*). `link_path` is a symlink to the file (as S3 §8.1). The ACL protects against accidental access but not against an administrator; the cleanup order (§12.3) protects against reading stale files.
- **Cleanup** (overwrite with zeros in place, then delete):
  - (a) on every boot and on identity change — in `umiak-agent early` before login (§12.3);
  - in `System/PrepareStop` (the `prepare` step of S6 stop): the response `{secret_files_wiped: true}` confirms the cleanup, and S6 uses it to clear the `secret_files_on_disk` flag (§18.6 item 5). Duplicated in `PRESHUTDOWN`;
  - (b) in the quiesce for a saved snapshot (§12.10).
- **(c)** the pagefile is on with `ClearPageFileAtShutdown=1`, memory dumps are off (§8.1).
- **(d) Accepted risks** (under the same policy; Ilia was informed by the master session). A "at startup" task created by the user can read the secret files before cleanup (§12.3), accepted by the master session. In addition, a snapshot of a running VM (fork and saved) may contain secret fragments in the pagefile, in free NTFS clusters, in `$MFT` (small files are stored resident), and in `$LogFile`. Overwriting with zeros before deletion reduces but does not exclude this. A fork inherits secrets by design (S3 §8.1). A RAM disk (a third-party driver) is a possible improvement later.

### 12.9 Files, output, ports

**Files** (S3 §11, differences):
- Paths: `C:\…` or `C:/…`; `~` is the profile of the request's user. UNC and device paths (`\\server\…`, `\\.\…`) → `invalid_argument`. Long paths are supported (`LongPathsEnabled`). Case does not matter.
- `FileInfo.mode` is synthesized: a directory `0755`, a file `0644`, with the read-only attribute — without write bits, `+0111` for extensions from `PATHEXT`. `owner` is the owner account name (`user`, `SYSTEM`, `Administrators`), `group` is empty, `uid`/`gid` = 0. `ETag` = volume serial number + file index + size + mtime.
- `Chmod`: from `mode` only the owner write bit is used (the read-only attribute); `owner` changes the owner; `group` is ignored; `recursive` as in S3.
- Symlinks and junctions are shown as `SYMLINK` with a target; recursive deletion does not follow them.
- Write: a temporary file → `FlushFileBuffers` → `MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)`. A sharing violation (the file is open in another process without `FILE_SHARE_DELETE`/`FILE_SHARE_WRITE`) → `failed_precondition file_in_use` (`retryable: true`), the same in `Move` and `Remove`.

**Output and retention** (S3 §10): output files are sparse (`FSCTL_SET_SPARSE` at creation), eviction is `FSCTL_SET_ZERO_DATA` aligned to 64 KiB (the NTFS sparse deallocation unit, not 4 KiB), `available_from` is the start of the first allocated range (`FSCTL_QUERY_ALLOCATED_RANGES`). The shim opens files with `FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE`. The recheck after reading is as in S3.

**Ports** (`PortScanner`): `GetExtendedTcpTable(TCP_TABLE_OWNER_PID_LISTENER)` for IPv4 and IPv6 once a second, the owner by pid (`QueryFullProcessImageNameW`, the token's user). Windows system listeners (RPC 135 and dynamic RPC 49664+ of `lsass`, `wininit`, `services`, `svchost`, `spoolsv`, `System`) are not reported: `[ports] exclude = [22, 135]` and `exclude_processes = ["System", "lsass.exe", "wininit.exe", "services.exe", "svchost.exe", "spoolsv.exe"]` **[S9]**. CONNECT is as in S3 §12.

**Metrics:** `gopsutil`; `swap` = pagefile usage.

### 12.10 Quiesce (`Quiescer`)

On Windows the FS is frozen by VSS, and the guest's VSS provider already exists in the QEMU guest agent from virtio-win. There is no need to write our own VSS provider in Go. So for Windows the worker's `QuiesceHook` is composite **[S9]**:

```
freeze(): System/Quiesce{fs: false, docker: false, wipe_secret_files: kind == saved}
          -> QGA fsfreeze-freeze (VSS)
S1:       pause vCPU (multi-disk), lvcreate -s for scsi0, efidisk0, tpmstate0, resume
thaw():   QGA fsfreeze-thaw -> System/Thaw
```

- Agent: hooks `C:\ProgramData\umiak-agent\quiesce.d\*.ps1` with the argument `freeze`/`thaw`, up to 5 s each; the lease and auto-release by `deadline` are the agent's internal timer (no watchdog process is needed: VSS lifts the freeze itself).
- `fs: true` on Windows → `failed_precondition fs_freeze_unsupported`. Capabilities: `system.quiesce.v1` and the new `system.quiesce.wipe_secrets.v1`; `docker` is ignored on Windows.
- **Budget.** S1 counts 10 s from the return of `freeze()` (VSS already holds writes) to the start of `thaw()`, i.e. the vCPU pause, `lvcreate`, and resume. The preparation before that (agent hooks, secret cleanup, preparing VSS writers in `fsfreeze-freeze`) is not in the budget and is bounded by its own timeout: the whole `freeze()` ≤ 30 s, otherwise the snapshot is cancelled. For Linux the meaning is the same: S3 freezes the FS at the end of `Quiesce`. This is a clarification of S1 §6.2 (§18.1 item 9).
- **VSS holds writes for no more than 10 s** and lifts the freeze itself. This matches the S1 budget and replaces the S3 §14.3 watchdog. If `fsfreeze-thaw` reports the freeze is already lifted, the snapshot is only crash-consistent, and the worker acts as for `auto_thawed` (S3 §14.3). On error `Qga.fsfreezeThaw` reads `fsfreeze-status` and on `thawed` returns `{autoThawed: true}` instead of an error; S1 `snapshot` with a QGA hook returns `SnapshotRef.autoThawed` by default, and on any error after `lv.snapshot` it deletes the snapshot LV.
- **Secret cleanup for a saved snapshot** (condition b): with `wipe_secret_files` the agent overwrites the secret files with zeros and deletes them before the freeze, and `Thaw` restores them from memory. If some file is open without sharing for write and delete, the agent rolls back those already wiped and answers `failed_precondition secrets_in_use`. Then S6 requires stopping the sandbox before saving (§18.6 item 5). An agent restart during the lease: the files are restored only after `UpdateSecrets` (the phase `secrets: pending`).
- If the agent is not connected, the worker does only the QGA `fsfreeze` (as S1 does now); for `kind=saved` with secret files this is forbidden (`agent_unavailable`).
- `umiak-agent thaw --force` on Windows restores the secret files and lifts the lease; it does not touch the FS.

### 12.11 `seal`

S3 §7.3 for Windows: stop the service, erase `C:\ProgramData\umiak-agent\state` and `run`, the SSH host keys, the secrets directory, restore the template's `umiak_user_ca.pub` and an empty env, stop `sshd`. The versions directory stays. `MachineGuid`, the name, and the password are changed by `identity apply` on the clone.

### 12.12 Package and update

- `umiak-agent-<v>-windows-amd64.tar` (the S3 §17.1 format; tar for uniformity, Go reads it on Windows): `umiak-agent.exe` (console subsystem), `umiak-session.exe` (GUI subsystem, `-H windowsgui`, no console window), `manifest.json`, `manifest.sig`, `trust\`.
- The update is S3 §17.4: switching the `previous`/`current` junctions (delete and create; there is no rename atomicity, it is compensated by `pending-update.json` and rollback), a restart through SCM (§12.2), rollback through the failure action.
- **QGA recovery** (S3 §17.6): `umiak-agent doctor --json`; `umiak-agent logs -n 500` (the last lines of `agent.log`); `Restart-Service umiak-agent`; `umiak-agent rollback [--to <v>]`; `umiak-agent install-package <path>`; `umiak-agent thaw --force`.

### 12.13 Readiness

- The S3 §8.5 phases; `docker` = `disabled`; `desktop` (`windows` only) — §13.
- `pool_ready` (S6 §9.3) for `windows` = `agent` + `identity` + `desktop`.

### 12.14 New CLI subcommands

| Subcommand | Why |
|---|---|
| `early` | the startup script (§12.3) |
| `identity apply [--specialize]` | §11.2 (exists on Linux, here with the specialize mode) |
| `env --format pwsh` | the env for an SSH session profile (§12.7) |
| `resume-hint --unix-ms <t>` | after waking from hibernation (§14.3); works on Linux too. *Not implemented in the MVP (Ilia's decision 2026-10-31)* |
| `exec --user <u> -- <argv>` | a local launch through the same token and shim path; for verify and QGA (Administrators only) |
| `logs -n <N>` | the analog of `journalctl` |

*As built:* also `call <Service/Method> [<json>|-]` (a unary API call over `admin.sock`, §24.2 item 4), `selftest --pty`, `quiesce-watchdog --lease <id>`. `exec` and `call` work through `run\admin.sock`, not through a separate path.

## 13. Desktop: hooks for S10

> *As built (plan, decision 2):* S9 has only the autologon of `user`, the absence of a lock, and no first-logon wizards (`60-desktop`). `umiak-session.exe`, the task `\umiak\session`, `run\session.sock`, and the `desktop` phase are not built, that is S10; `readiness.required = ["identity", "claim", "secrets"]`. `CommandSpec.desktop = true` → `failed_precondition desktop_not_ready`.

- **Autologon** of `user` into the console session (§11.2, §8.7); no lock, no UAC prompts, no first-logon wizards.
- **`umiak-session.exe`** is a helper in the interactive session: a service from session 0 cannot capture the screen or send input. It is started by the task `\umiak\session` at login, elevated (UIPI does not prevent controlling elevated windows). It connects to the agent over the AF_UNIX `run\session.sock` (ACL: SYSTEM and `user`) and reports `Hello{session_id, user, version}` and `State{locked, input_desktop, width, height, dpi}` at every change (WTS session notifications). It accepts `ApplyEnv` (§12.7). The protocol is length-prefixed, extensible protobuf: screen capture, input, clipboard, and starting the streamer will be added by S10.
- **The `desktop` phase:** `ready` when the helper is connected, the session is active and unlocked, and the input desktop is `Default` (not `Winlogon`). Otherwise `pending`, and with an error (the helper crashes in a loop) — `failed`.
- **`CommandSpec.desktop: true`** (a new proto field): the process starts in the console session (`WTSGetActiveConsoleSessionId` → `WTSQueryUserToken` → the linked elevated token), on `winsta0\default`, inside the shim's job, with output captured as usual. If there is no session → `failed_precondition desktop_not_ready`. On Linux S10 will define the field.
- The video adapter, resolution, Sunshine, cua-driver — S10.

## 14. Pool, boot, hibernation

> **Not implemented in the MVP (Ilia's decision 2026-10-31).** There is no Windows pool via hibernation, no vTPM + `suspend --todisk` spike (§21 item 1), no `resume-hint`, and `vmstatestorage` is not set. **Create is cold:** S1 `create` clones the template (with a fresh vTPM, §9), the first boot goes through sysprep specialize and OOBE (§11.1 items 1–3), then the claim. The target is ≤ 5 min, 2–3 min is good; the S6 cold create deadline of 20 min (§14.5) leaves margin. The `windows` pool target = 0. Stopping Windows is an ordinary shutdown (§14.6). The text of §14.1–14.4 is kept as phase 2 material.

### 14.1 Why hibernation

Within the PoC limit of 8 GB a running warm Windows machine (4 GB) would take half the RAM, and a cold Windows create takes 3–5 min (specialize, OOBE, first login). A machine hibernated to disk (`qm suspend --todisk`) takes no RAM and wakes in seconds with an already prepared session and a connectable agent. The master's decision: the Windows pool works this way; a spike at the start of the implementation (§21) confirms operation with vTPM.

### 14.2 Preparing a pool machine

S6 §9.3 (clone, start, waiting for `pool_ready` no longer than `boot_timeout_s`), then:
1. The machine → `suspending`. S1 `hibernate(vmid)`: `POST …/status/suspend` with `todisk=1` (the state in `vmstatestorage=local-lvm`), waiting for the task, checking `lock: suspended` and `vmstate` in the config.
2. The machine → `hibernated`: its RAM is in neither `reserved` nor `powered` (§18.6).

Before hibernating the agent does nothing: the tunnel simply stops responding, and the gateway closes the connection by ping (S2). The machine token (in the agent's memory) may turn out expired after waking; the agent then connects with BS, as after any break.

### 14.3 Claim from hibernation

1. API: RAM admission of the machine (evicting warm machines of other pairs, S6 §8.2), the machine → `claiming`.
2. Worker: a RAM check before the start, S1 `start` (Proxmox resumes the VM from the saved state and deletes `vmstate`).
3. QGA `agent/ping`, then `agent/exec`: `umiak-agent resume-hint --unix-ms <host time>` (*`resume-hint` is not implemented in the MVP, Ilia's decision 2026-10-31*). The agent:
   - sets the system time (`SetSystemTime`; SYSTEM has the right) if the difference exceeds 1 s, and runs `w32tm /resync /force`. Without this the guest clock lags by the sleep time, and TLS to the tunnel may fail on the `notBefore` of a fresh certificate;
   - closes the old WebSocket connection and reconnects at once, without waiting for the 15 s ping timeout;
   - recomputes the phases (`desktop` for `windows`).
4. Waiting for the connection (a new `epoch`) and `pool_ready`, then `System/Claim` → `running`.

Goal: claim-to-ready ≤ 30 s (§16).

### 14.4 Pool targets in the PoC (master's decision)

| Pair | Target | Mode | RAM when idle |
|---|---|---|---|
| `linux/2GB` | 1 | running | 2 GB |
| `windows/4GB` | 1 | hibernated | 0 |

While preparing and on claim the Windows machine occupies RAM as usual, per S6 admission. Space on `local-lvm`: the state ≈ the guest's occupied RAM (thin) plus the disks.

**If the §21 spike fails:** the `windows` target = 0, create is cold (3–5 min, within the S6 20 min deadline). The decision is recorded in §24.

### 14.5 Deadlines and timeouts

The S6 §7.9 deadlines for Windows are confirmed unchanged: create from the pool 5 min (hibernation fits with margin), cold / from snapshot / fork target 20 min, fork (snapshot) 3 min, stop 5 min, resume and recover 15 min, `boot_timeout_s` = 1200. The pool's `maxAgeHours` is 24 h, as in S6; it can be set differently for a pair.

### 14.6 Stop via hibernation (phase 2)

Stopping a user sandbox through `suspend --todisk` would preserve processes, but changes the S6 semantics (commands are not `LOST`, disk snapshots of a stopped VM are only crash-consistent, quiesce is impossible). This is a phase 2 experiment (master's decision); in v1 stopping Windows is an ordinary shutdown.

## 15. Build verification (the `windows-desktop` profile)

### 15.1 Checks

`verify` creates a machine from the template with the S1 primitive (a test `smbios1` with `family`), boots it (specialize), checks through QGA, and deletes it with its traces (including the hibernation state LV, §18.1). Commands as `user` run through `umiak-agent exec --user user` (§12.14), i.e. by the same path as agent commands.

1. OS: edition and build = recipe/manifest; `Get-ComputerInfo`.
2. **Specialize:** the name `UMI<12 hex>` of the test `machineId`; `MachineGuid` = `machineId`; the number of boots of the first boot is no more than for a setup without the agent, plus one planned `umiak-agent.exe` reboot for the rename (R16; by the event log, IDs 6005/1074); `firstboot.log` ends with `done`; `umiak-unattend.xml` is deleted; no password in `Panther`.
3. **Sockets:** TCP listeners only from the recipe's allow-list: `127.0.0.1:22`, `[::1]:22`, 135 and the dynamic RPC 49664–49670 (`lsass`, `wininit`, `services`, `svchost`, `spoolsv`, `System`). Ports 3389, 5985, 5986, 445, 139, 5357, 7680 are absent. UDP: the DHCP client; mDNS and LLMNR are off.
4. **Firewall:** on in all profiles, inbound denied by default, not a single effective inbound allow rule: in the ActiveStore `AllowInboundRules=False` in all three profiles (remaining allow rules are not applied and only listed) or no enabled inbound allow rule at all (with `AllowLocalPolicyMerge=0` — in `-PolicyStore ActiveStore`), `NotifyOnListen=False`.
5. **sshd:** `sshd -T` — `passwordauthentication no`, `trustedusercakeys`, both `listenaddress`; the service runs (the agent started it); host keys were created in this boot; `DefaultShell` = pwsh 7. Login by certificate with a test CA: `ssh -i <key> -o CertificateFile=<cert> user@127.0.0.1 "$env:UMIAK"` (the CA is placed through `umiak_user_ca.pub` for the duration of the check).
6. **Agent:** `umiak-agent doctor --json` — version, `identity` ready, the tunnel URL from `family`, the service Running, failure actions set, the startup script ran (`early.json`), the phases per profile.
7. **Users and login:** `user` in Administrators, the password never expires, the LSA secret exists; Administrator and Guest are disabled; UAC: `EnableLUA=1`, `ConsentPromptBehaviorAdmin=0`, `PromptOnSecureDesktop=0`. `windows`: the `user` session is active (`query user`) and not locked (`WTSSessionInfoEx`), `LogonUI.exe` is not running in this session (waiting up to 180 s after the agent is ready), the `desktop` phase = ready.
8. **Services and policies:** §8.1 — service states, Defender (`Start=4` for the six services and drivers, no `MsMpEng` process), `WaaSMedicSvc` `Start=4`, `umiak-offline.log` without errors, Fast Startup and guest hibernation off, the pagefile exists and `ClearPageFileAtShutdown=1`, `CrashDumpEnabled=0`, VBS off (`Win32_DeviceGuard`), BitLocker off (`manage-bde -status`), the TPM is ready and differs from the template's (`Get-Tpm`, for `windows`), BCD `bootstatuspolicy`/`recoveryenabled`, WinRE off, code page 65001.
9. **Tools:** every command of §8.5 — `--version` as `user` by direct exec and through `pwsh -Command`; versions = the manifest; `npm -g` writes to `C:\ProgramData\npm`.
10. **Network:** IPv4 from `10.88.0.0/24`, `Resolve-DnsName example.com`, `Invoke-WebRequest https://example.com`; time is synchronized, the time zone is UTC.
11. **Agent processes:** through `umiak-agent exec` and the `shell` path: exit codes per the §12.6 contract; a `.cmd` from `PATH` (`npm --version`) starts; a ConPTY session with `pwsh` answers input (the local selftest `umiak-agent selftest --pty`).
12. **VSS:** QGA `fsfreeze-freeze` → `fsfreeze-status` = frozen → `fsfreeze-thaw` within ≤ 10 s, no VSS errors in the event log.
13. **Identity change (the fork path):** *as built — a real fork: an S1 snapshot with a QGA VSS hook → `cloneFromSnapshot`, the source is shut down before the fork starts because of RAM (§24.2 item 9). On a slow host (a vCPU pause + lvcreate + resume longer than the ~10 s VSS hold) a snapshot with `FreezeBudgetExceededError` or `autoThawed` is repeated once, then a crash-consistent snapshot is taken with the line `WARN vss_snapshot` (freeze time and reason); the fork checks remain the criterion.* Shut the VM down, change `smbios1` (a new `machineId` and BS), boot. One reboot for the rename happened; the new name, `MachineGuid`, host keys, empty agent state, `identity.reset` in the log; the `user` password is the same, autologon works, a secret saved through DPAPI before the identity change is readable. The time is recorded.
14. **Hard stop:** S1 `stop` without shutdown, then start; the boot is without Automatic Repair, the time to agent readiness ≤ a normal boot + 10 s.
15. *Not implemented in the MVP (Ilia's decision 2026-10-31, §14).* **Hibernation** (if `pool.mode = hibernated`): S1 `hibernate`, start, `resume-hint`; the agent is connected and `pool_ready`; the clocks differ from the host by < 2 s; `windows`: the session is not locked. The time is recorded.
16. **TRIM:** `Optimize-Volume -ReTrim`. While the pinned virtio-win lacks the fix, an error is a warning; afterwards a red check.
17. **License:** edition, license state, channel, days remaining (`SoftwareLicensingProduct`) → the manifest (`license`). For `channel = evaluation`: the check waits up to 10 min for online activation of the evaluation on the clone; under 30 days is a warning, under 7 a red check (§17). For `retail` and `volume` only the edition match is checked; an unactivated Windows is not an error.
18. **Leftovers:** no `C:\umiak-build`, installers, or `authorized_keys` files; `C:\ProgramData\umiak-template\build.json` exists.
19. **Boot measurements** (§16) → `verify.boot` in the manifest.

### 15.2 Manifest: Windows fields

On top of S5 §11: `windows` {`edition`, `build`, `ubr`, `family`, `isoFile`, `isoSha256`, `virtioWinVersion`, `openssh` (inbox/github and version), `appxRemoved`, `options`, `offline` {`services` with `Start=4`, `missing` without a key, `log`}}, `license` {`status`, `channel`, `daysRemaining`, `expiresAt`}, `verify.boot` (§16), `poolMode`.

## 16. Measurements

### 16.1 `umiak-bench s9`

A scenario in `apps/bench` on top of `s5` (S5 §13.1) for the Windows build, N runs:

| Metric | How |
|---|---|
| `first_boot_to_agent_ready` | a clone from the template: start → agent ready (specialize, OOBE included) |
| `first_boot_to_desktop_ready` | the same up to `desktop: ready` (`windows`) |
| `boot_to_agent_ready` | a normal boot after shutdown |
| `hard_stop_restart` | after `stop` without shutdown |
| `identity_change_boot` | after changing `smbios1` (with the rename reboot) |
| `hibernate` | the duration of `suspend --todisk`, the size of the state LV. *Not implemented in the MVP (Ilia's decision 2026-10-31)* |
| `resume_to_agent_ready` | start of the hibernated machine → `resume-hint` → agent connected and `pool_ready`. *Not implemented in the MVP (Ilia's decision 2026-10-31)* |
| `freeze` | QGA VSS freeze → thaw |

*As built* (`apps/bench/src/s9.ts`): the metrics `create`, `create_to_agent_ready`, `first_boot_to_agent_ready`, `boot_to_agent_ready`, `start_to_qga`, `tunnel_connected`, `hard_stop_restart`, `freeze_ms`, `fork_snapshot_ms`, `fork_clone_ms`, `fork_start_to_agent_ready`, `fork_boot_to_agent_ready`, `fork_to_agent_ready` (definition — §24.3 R13), `fork_tunnel_connected`. There is no `first_boot_to_desktop_ready` (the `desktop` phase is S10).

### 16.2 Targets (estimates, to be verified; the numbers are written to §24)

On `pve`, `local-lvm`, the §9 sizes: `first_boot_to_desktop_ready` ≤ 4 min; `boot_to_agent_ready` ≤ 60 s; `identity_change_boot` ≤ 2 min; `hibernate` ≤ 30 s; `resume_to_agent_ready` ≤ 20 s (claim-to-ready ≤ 30 s). *For the MVP: `hibernate` and `resume_to_agent_ready` are not measured; instead of claim-to-ready the target is `create_to_agent_ready` ≤ 5 min (2–3 min is good).*

### 16.3 Experiments

A separate build with a recipe flag, compared with `umiak-bench s9 --baseline`: `cpu: x86-64-v3` instead of `host`; virtio-win 0.1.302 and the next release (VSS, TRIM, I/O); without `sysprep /generalize` (only to estimate the specialize gain; does not change the decision).

## 17. Licensing (constraints only)

Licensing decisions belong to the user and lawyers, not to the platform (`research/05` §7.5 is a reference, not advice).
- **Evaluation versions:** Windows 11 Enterprise Evaluation — 90 days (Server — §22). When it expires Windows shuts down every hour. When the countdown starts for clones of a sysprep template (from the install at build time, or from each clone's online activation after the rearm at `generalize`) is not known for certain. Until it is measured, the rule is conservative: the countdown runs from the build, and a template from an evaluation ISO is rebuilt no less often than every 60 days. The implementation measures this (`daysRemaining` of the verify clone on the build day and of a pool machine a week later) and writes the result to §24. Clones activate the evaluation online themselves (the `umiak0` egress exists). `verify` writes `license.expiresAt`, `umiak-tpl list` shows the days remaining, and S12 adds an alert 14 days ahead and a scheduled rebuild.
- **Retail or unactivated Windows** (like Ilia's ISO, Pro): works with personalization limits; the user's responsibility.
- **KMS later:** a GVLK in `product_key`, the KMS address in `agent.toml [windows] kms_host` or in the claim (the field is added on request). A fork inherits the CMID (the SID does not change); for KMS a fork may need `slmgr /rearm` on identity change — to be solved together with KMS.
- **For reference** (`research/05` §7.5): Windows 11 in a VM is licensed per person (VDA/E3/E5, up to 4 VMs per user), which fits ephemeral VMs for AI agents poorly; Windows Server Datacenter licenses the host's cores; external customers need SPLA. AVMA does not work on Proxmox.
- **VS Build Tools** are off by default (the Visual Studio license); a user who has a license turns them on with a recipe flag.

## 18. Changes in neighboring areas

Made by the implementers of those areas; agreement is with the master session.

### 18.1 S1 (`packages/pve`, `umiak-node`, runbook)

1. **The `VM.Console` right** in the role `UmiakPoC` on the pool `umiak` (master's decision): `sendkey` for "Press any key" during installation (not needed by the offline stage, R17).
2. **`DiskSet` with `efidisk0` and `tpmstate0`** is checked in practice: `snapshot`, `cloneFromSnapshot`, `delete` for three disks; the options `efitype`, `pre-enrolled-keys`, `ms-cert`, `version` are carried over. `cloneFromTemplate` clones `scsi0` and `efidisk0`, while `tpmstate0` is created new through the PVE API at `create` (§9). Proxmox names the new volume `vm-<vmid>-disk-<k>` without the `umiak` tag; `delete` removes it through `purge` and checks that no `vm-<vmid>-*` remains. In `umiak-bench s1` — a run with the Windows template (the fork boots, `Get-Tpm` in the fork is `TpmReady`).
3. **Hardware allow-list:** + the `efidisk0`/`tpmstate0` options, `vmstatestorage`; `machine` with a version is copied as is.
*Items 4–6 are not implemented in the MVP (Ilia's decision 2026-10-31, §14).* Item 1 was done as a separate role `UmiakConsole` (§24.3 R4).

4. **`hibernate(vmid)`:** `POST status/suspend todisk=1`, waiting for the task, checking `lock: suspended`. The rights exist: `VM.PowerMgmt`, `VM.Config.Disk`, `Datastore.AllocateSpace` on `local-lvm` (checked in `PVE/API2/Qemu.pm`). `start` of a hibernated VM is an ordinary `start`.
5. **`umiak-node vm.discard-suspend <vmid>`** (master's decision): for a VM in the range, in the pool `umiak`, with the tag `umiak` and `lock: suspended` — `qm unlock`, delete the `vmstate` key and its volume (`pvesm free`). Without this a VM with a hibernation state cannot be deleted: `skiplock` is allowed only for root. `delete` calls it first if the VM is in `lock: suspended`.
6. **The `delete` check:** besides the LV with the tag `umiak-vm-<vmid>` — there is no LV `vm-<vmid>-state-*` (the state volume is created by Proxmox and has no `umiak` tag).
7. **`umiak-node`:** `media.sha256 <file>` (read-only, only `/var/lib/vz/template/iso/*.iso`, without `..` and symlinks, cached by name, size, and mtime); the `media.remove` templates are extended with `umiak-build-*.iso`, `umiak-offline-*.iso`, `umiak-virtio-win-*.iso`.
8. `waitReady` and `network-get-interfaces` work with the Windows QGA unchanged (checked on the stand).
9. **The freeze budget** in `snapshot` is counted from the return of `hook.freeze()` to the call of `hook.thaw()` (10 s); `freeze()` itself has a separate 30 s timeout (§12.10).

### 18.2 S2

- `Umiak-Boot-Id` on Windows — §12.4; `Umiak-Vmgenid` — hex from `\\.\VmGenerationCounter`.
- On Windows smbios (with BS) is readable by any VM process; accepted within the model "the trust boundary is the VM" (S2 §16).

### 18.3 S3 (the agent)

1. The S3 §18 implementations for Windows per §12; the S3 §18 portability table is updated: agent ↔ shim IPC is AF_UNIX on both OSes; `Quiescer` on Windows is only hooks and secret cleanup, the FS is QGA VSS; `SecretStore` is §12.8.
2. Proto (additions only): `CommandSpec.desktop`, `ClaimResponse.hostname_applied`, `QuiesceRequest.wipe_secret_files`; the error codes `unsupported_signal`, `unsafe_batch_args`, `file_in_use`, `secrets_in_use`, `secrets_pending`, `fs_freeze_unsupported`, `desktop_not_ready`; the capability `system.quiesce.wipe_secrets.v1`.
3. The §12.14 subcommands; `resume-hint` on Linux too (close the connection, reconnect, synchronize the clock).
4. CI: besides cross-compilation — integration tests on a GitHub Actions Windows runner (Server 2025): the service and failure actions, shim and job objects (survives a service restart), ConPTY, sparse files and eviction, AF_UNIX, `LogonUser` with a test local user, files and error codes, ports.
5. `Start` with `secrets: pending` and a non-empty `secretsDigest` waits up to 30 s (§12.8). On Linux this is also useful after a reboot; the S3 implementation decides.

### 18.4 S4

`loginUser` for Windows templates is `user`; sshd is built in, the default shell is pwsh 7, the sandbox env comes through the profile (§8.4, §12.7). Nothing needs changing in S4; the S4U token limitation (§8.3) goes into the documentation.

### 18.5 S5 (`umiak-tpl`)

1. `source.kind: iso-install`, `seal: sysprep`, `offline: [...]`, the built-in steps `network-up` and `reboot` for Windows, the step executor through a scheduled task and `run-step.ps1` (§7).
2. The media of §6; `iso upload`; `--iso`, `--iso-sha256`, `--accept-iso-sha256`, `--edition`, `--product-key-file`; `install_timeout`.
3. The verification profiles of §15, the manifest of §15.2, `umiak-bench s9`.
4. `gc`: the ISO `umiak-virtio-win-*` is deleted if no non-`retired` build references the version; `umiak-build-*` and `umiak-offline-*` — like `umiak-seed-*`. The user's ISO is never touched.
5. Build admission (S5 §7.2 item 4) accounts for `build_vm.memory_mb` 4096.

### 18.6 S6 (control plane)

*Items 1–4 are not implemented in the MVP (Ilia's decision 2026-10-31, §14). What was done in the worker and what is left for S6 — §24.5.*

1. **Machine states:** `suspending` (being hibernated; its RAM is in `reserved` and `powered`) and `hibernated` (warm on disk; its RAM is counted nowhere). `hibernated` is supply for the pool (supply counts `allocating`, `provisioning`, `booting`, `warm`, `suspending`, `hibernated`).
2. **`poolTargets.mode`:** `running | hibernated` (default from `template.yaml pool.mode`). After `pool_ready` with `mode = hibernated` the controller moves the machine to `suspending` → S1 `hibernate` → `hibernated`.
3. **Claim:** from `warm` (if any) before `hibernated`. A claim of `hibernated`: RAM admission (like resume), the machine → `claiming` (in `reserved`), the §14.3 steps (start with a RAM check, QGA `resume-hint`, waiting for the connection), then the claim. An error → `deleting`, retry by the S6 §7.3 rules.
4. **Pool rules:** §9.2 item 5 (agent disconnected > 60 s) does not apply to `suspending` and `hibernated`. `maxAgeHours` is as for warm. Reconcile expects for `hibernated` the Proxmox status `stopped` with `lock: suspended`; otherwise → `deleting`. Deleting `hibernated` is S1 `discard-suspend`, then an ordinary delete (§18.1 item 5).
5. **Windows saved snapshot** (condition b): a running machine — a composite quiesce (§12.10) with `wipe_secret_files`; `secrets_in_use` → the operation fails with `snapshot_requires_stop` (S7). A stopped machine — allowed only if `machines.secret_files_on_disk = false`. The field is set to `true` when a Windows machine received non-empty `secret_files`, and to `false` on the response `PrepareStop{secret_files_wiped: true}` before a clean shutdown or after the set is replaced with an empty one. A hard stop leaves `true` → `snapshot_requires_clean_stop`. Fork is not limited by these rules.
6. **`QuiesceHook` for Windows** is composite (§12.10); chosen by `template_builds.os`.
7. **Resending secrets:** `UpdateSecrets` also on `readiness.changed{secrets: pending}` without a `boot_id` change (an agent restart or update on Windows), not only after a reboot.
8. Hostname: for Windows the sandbox field is not applied in the guest; the effective name is taken from `System/Info`. `user` = `root` in commands is mapped by the agent to `SYSTEM`.
9. The §7.9 deadlines and `boot_timeout_s` are confirmed (§14.5).
10. **Stopping Windows:** the `prepare` step (`System/PrepareStop`, 10 s) on Windows erases the secret files and answers `secret_files_wiped` (§12.8); the `shutdown` timeout for `os = windows` is 120 s instead of 60 s (pagefile cleanup at shutdown, §8.1), then a hard `stop`, as now. Since 2026-11-01 — 300 s (§24.9 item 7).

### 18.7 S7

Documentation of the Windows semantics: `shell` = `pwsh -Command`; signals (§12.6); file `mode`/`owner` (§12.9); SSH sessions get env only in PowerShell; the SSH S4U limitation; hostname is not applied. The `desktop` field in commands (after S10 — for Linux too). New error codes: `unsupported_signal`, `unsafe_batch_args`, `file_in_use`, `secrets_pending`, `snapshot_requires_stop`, `snapshot_requires_clean_stop`, `desktop_not_ready`.

### 18.8 S8

`poolTargets` gets the field `mode` (§18.6 item 2).

## 19. Code structure

```
infra/templates/_windows/     shared: autounattend.xml.tmpl, umiak-unattend.xml, offline/,
                              SetupComplete.cmd, run-step.ps1, steps/*.ps1, files/
infra/templates/windows/      template.yaml, versions.toml
apps/template-builder/        + iso-install path, media, sysprep/offline stages, windows verify
apps/bench/                   + scenario s9
services/guest-agent/         + *_windows.go implementations, cmd umiak-session
packages/pve/, services/node-agent/   + §18.1
```

Tests: unit — rendering of `autounattend.xml` and `umiak-unattend.xml` (schema, no password in `umiak-unattend.xml`), the order of `iso-install` calls and rollback (a PVE fake), the offline stage, the `gc` rules for ISOs; PSScriptAnalyzer for `steps/*.ps1`; the agent — §18.3 item 4; integration — build and `verify` on `pve`, `umiak-bench s9`.

## 20. Acceptance

On `pve`:
1. `umiak-tpl preflight` is green (including `VM.Console`, `media.sha256`, the user's ISO and its sha256). `umiak-tpl build windows --agent-package <tar> --tunnel-url <url>` passes with no manual actions; the build is `ready`, the §15 checks are green.
2. A repeated build with the same `versions.toml` and commit gives the same OS edition and build, the same `tools` and virtio-win version in the manifest.
3. A failed build (a deliberately failing step, a wrong `edition`, an ISO with a wrong sha256) leaves no VM, no `umiak-build-*` and `umiak-offline-*` ISOs, no lease; the user's ISO is untouched.
4. **Pool:** with the §14.4 targets within 8 GB, a Linux warm machine, a hibernated Windows machine, and a Linux sandbox run at the same time; a `windows` claim from the hibernated machine ≤ 30 s, the `user` session is unlocked, `desktop: ready`; `reserved` and `powered` do not exceed the limit (S6 metrics). Deleting a hibernated machine leaves no LV `vm-<vmid>-*`.
5. **Secrets:** `secret_files` and `secret_env` are visible to commands; after `PrepareStop` the files are gone; a file left by a hard stop is not visible to the `user` session's autostart program and is erased before the agent is ready; a saved snapshot of a running machine (files not in use) contains no secret files (a search over the snapshot LV); with a busy file the saved snapshot is rejected with `snapshot_requires_stop`.
6. **Fork:** a fork of a running Windows sandbox boots with a new identity (§15 item 13), the `user` data and DPAPI are preserved, the source machine is unaffected, the VSS snapshot is consistent (a file written before the snapshot is present).
7. **Agent:** the S3 §21 items 1–13 acceptance on Windows with the §12 differences: commands survive a service restart and self-update; `Kill` after a killed shim works; retention on sparse files; ConPTY with resize; `shell` exit codes per the §12.6 contract; `unsupported_signal`; `file_in_use`; ports and CONNECT; SSH by certificate through the S4 gateway with the sandbox env in pwsh.
8. `umiak-bench s9`: the §16 numbers are written to §24; the §16.2 targets are met or the deviation is explained.
9. The S1 `inventory` "world before" and "world after" the build, `verify`, and `gc` differ only by the VMs and LVs of the builds.

## 21. Implementation order

1. *Not done (Ilia's decision 2026-10-31): there is no pool via hibernation. The OVMF `bootorder` and `OBJ_PERMANENT` checks go in the build and in the agent tests on `pve`.* **The spike (first, master's decision):** on `pve` in the PoC range — a Windows 11 VM with vTPM and OVMF (temporary is fine, outside the pipeline), `suspend --todisk` → `start`: the TPM and session state is preserved, hibernate and wake times, the size of the state volume; `discard-suspend` (a `umiak-node` prototype) and deletion; also — whether Proxmox's OVMF loads the Windows Boot Manager entry from `efidisk0` if `boot` has only `ide2` (§10.3), and whether the permanent job works (`OBJ_PERMANENT`, §12.6). The result: `pool.mode` for Windows and the numbers in §24. A failure → the `windows` target = 0.
2. S1 §18.1 (rights, `DiskSet` with three disks, `hibernate`, `discard-suspend`, `media.sha256`).
3. The agent on Windows (§12) with CI on a Windows runner.
4. `umiak-tpl` `iso-install` and the `windows` recipe (Ilia's ISO is on `pve`).
5. `verify`, `umiak-bench s9`, the numbers.
6. S6 §18.6 (the hibernation pool, the saved snapshot rules) — in the S6 implementation.

## 22. Phase 2: Windows Server Core

Ilia's decision 2026-10-29: the MVP has only `windows` ("win11 will do for now, a server is not needed"). The template `windows-core` and its pool target (`windows-core/2GB`) are postponed; Ilia's ISO is not needed. Below are the decisions already made, to return to them without a new brainstorm:
- **Source:** Windows Server 2025 Datacenter Evaluation (180 days; the last GA LTSC as of 2026-10-29, vNext is a preview). The user puts the ISO into `local:iso` under the original name like `*SERVER_EVAL_x64FRE_*.iso`; the sha256 is written into `versions.toml`, checked by `umiak-node media.sha256` (§6.1).
- **`versions.toml [iso]`:** `edition = "Windows Server 2025 Datacenter Evaluation"` (this is Core; Desktop Experience has the suffix `(Desktop Experience)`), `product_key = null`, `channel = "evaluation"`.
- **Rebuild rule:** no less often than every 150 days, until it is measured when the clones' countdown starts (§17).
- **Recipe (sketch):** `family: server`, `drivers: 2k25`, no `tpmstate0`, `tablet: 0`, no `60-desktop` step and no `desktop` phase; Defender is removed with `Uninstall-WindowsFeature Windows-Defender`; `offline: [waasmedic-off]`; OpenSSH Server is built into the OS; WinRM is off; the same tool set; 2 vCPU / 2 GB, a 64 GiB disk, a 1 GiB pagefile; the verification profile `windows-server`; `pool_ready` = `agent` + `identity`.
- The shared code (`_windows`, the agent, `iso-install`, the hibernation pool) is written so that the Server recipe is added without pipeline changes.

## 23. Open questions and risks

- **TRIM:** virtio-win 0.1.271 and 0.1.302 lack the #1574 fix; `discard_granularity` through `args` is unavailable without root. Until the fix exists, space is freed by deleting the LV (sandboxes are disposable), and the template is slightly larger. After a driver with the fix is released — a new pinned version and the mandatory §15 item 16 check.
- **vTPM and hibernation:** whether `suspend --todisk` works with `tpmstate0` in Proxmox 9.2 — the §21 spike.
- **Specialize order:** whether `RunSynchronous` in specialize gives the name `UMIAK…` without an extra reboot — the §15 item 2 check, the fallback is a reboot by the agent.
- **The `BootId` counter** as the basis of `bootId` (§12.4).
- **OpenSSH FoD on Windows 11** needs Windows Update during the build; on failures — `openssh: github`.
- **Policies that Pro does not honor** (`NoLockScreen`, zero telemetry): on Ilia's ISO (Pro) the lock screen is bypassed by autologon and `CONSOLELOCK 0`; the §15 item 7 check looks at the result.
- **Commit limit:** 4 GB RAM + a pagefile on a thin disk; heavy builds run into the RAM of the size, not an OOM killer.
- **Remnants of secrets** in the pagefile and NTFS metadata are the accepted risk §12.8 (d).
- **A "at startup" task created by the user** can read the secret files of its own sandbox (after a hard stop) or of the fork source before cleanup in `early`. This is an accepted risk (master, 2026-10-29): a fork inherits secrets by design, `user` is an administrator inside the VM, the trust boundary is the VM (§12.3). The §20 item 5 acceptance check stays.
- **The evaluation period** of the template (§17): when the countdown starts for clones is measured by the implementation; until then — a rebuild no less often than every 60 days (Windows 11 Evaluation).
- **`SyncForegroundPolicy`** delays login until the network appears; the cost is measured in `first_boot_to_desktop_ready` and `boot_to_agent_ready`.
- **Windows Boot Manager ignores the one-shot WinPE entry** (§10.3): Windows boots instead of WinPE; the stage runs before sysprep, so this is harmless: the entry is set again, and verify-offline checks the result.

## 24. Implementation results and decisions

> Historical report predating R1; current names — `docs/specs/rename-umiak.md`.

The plan: `docs/plans/s9-windows.md` (the section "Decisions taken here"). Below is what from the implementation changes or clarifies the sections above.

### 24.1 Ilia's decisions of 2026-10-31

- Windows 11 only (`windows`); Server Core is phase 2 (§22).
- No pool via hibernation, no vTPM + `suspend --todisk` spike (§14, §21 item 1). Create is cold: a template clone + sysprep specialize on first boot; ≤ 5 min acceptable, 2–3 min good.
- The trust boundary is the VM. Secrets follow §12.8.
- No Tailscale and no tunnel services (cloudflared, ngrok, etc.) in the code or in the image.
- The template slot on `pve` is 598 (`vmids: [598]`); 597 and 599 are Linux.

### 24.2 Decisions of the plan and the implementation

1. **No hibernation** (plan 1): `pool` and `size_default` are removed from the recipe; §14, §15 item 15, the `hibernate`/`resume_to_agent_ready` metrics of §16, §18.1 items 4–6, §18.6 items 1–4, and `resume-hint` are not implemented.
2. **The desktop helper is in S10** (plan 2): the autologon of `user` is done by `identity apply`; `sbx-session.exe`, `\sbx\session`, `run\session.sock`, and the `desktop` phase are not built. `readiness.required = ["identity", "claim", "secrets"]`. `CommandSpec.desktop = true` → `failed_precondition desktop_not_ready`.
3. **The spec goes to the shim's stdin, readiness is the line `READY`** in its stdout (`FAIL <text>` or EOF is a launch error), not the first message over the socket and not a file (§12.6): Windows has no tmpfs, and there is no chicken-and-egg problem with the socket. The socket protocol (shimproto) was not changed.
4. **The local admin socket** `C:\ProgramData\sbx-agent\run\admin.sock` (ACL SYSTEM + Administrators) always serves the full agent API, like `--debug-listen` on Linux. Its clients are `sbx-agent exec` and `sbx-agent call` (verify and QGA recovery). `exec` through it does not wait for deferred secrets, but for a non-SYSTEM user the boot readiness check remains. `exec` exit codes: 125 — an agent or CLI error, 127 — `START_FAILED`. `run\env.sock` (ACL SYSTEM, Administrators, `user`) serves only the env for `sbx-agent env --format pwsh` (HTTP `GET /env`).
5. **Shim liveness** is the named mutex `Global\sbx-shim-<id>`, held by the shim; the command is the permanent job `Global\sbx-cmd-<id>`. `State`: the mutex exists or the job has processes → `UnitActive`; the job exists and is empty → `UnitInactive`; otherwise `UnitNotFound`.
6. **The tools are downloaded in the build VM** from the official URLs in `versions.toml` and verified with `Get-FileHash` against the pinned sha256 (they are not in the build ISO).
7. **Agent tests on a real Windows:** `go test -c` for `GOOS=windows` (`services/guest-agent/test/windows/build-tests.sh`), the binaries are on an ISO attached to a template clone (R12), run as SYSTEM (`sbx-bench s9 agent-tests`). A GitHub Actions job on `windows-2025` (`workflow_dispatch`) is optional, not a gate (a clarification of §18.3 item 4).
8. **Each machine has its own vTPM** (§9): S1 `create` from the template does not clone `tpmstate0` but adds `tpmstate0=<storage>:1,version=v2.0` through the PVE API; fork and `cloneFromSnapshot` copy it.
9. **Verify uses a fork** to check the identity change (§15 item 13): an S1 snapshot with a QGA VSS hook → `cloneFromSnapshot` instead of editing `smbios1`; the source is shut down before the fork starts (RAM). The fork is ready only when `System/Info.hostname` is the new name.
10. **The template's boot disk** is `scsi0` = `base-598-disk-1` (`SLOT_ORDER` efidisk0, scsi0, tpmstate0); the builder's disk checks take the slot index from `diskLayout`, not `disk-0`.
11. **The hostname from the claim is not applied on Windows** (§11.3): `hostname_applied = false`, the value is the env `SBX_HOSTNAME`.
12. **Version switching uses NTFS junctions** (`FSCTL_SET_REPARSE_POINT`): a temporary junction, delete the old one, rename; protected by `pending-update.json`. A missing `current` is restored by `early` and `rollback` (`RepairCurrent`: `to` from `pending-update.json` → `from` → `previous`).
13. **Secret files** (§12.8): on Windows the `secret_files` contents are also kept in the agent's memory (`SecretEnvInMemory`) so that `Thaw` after quiesce restores the wiped files; on Linux they are not. `PrepareStop` when a file is open without sharing is a success with `secret_files_wiped = false` (not an error); everything that can be wiped is wiped. A `mode` with any write bit → `user` read-write, otherwise read-only (on Linux the exact `mode`). There is no Administrators write entry in the ACL: `user` has an elevated token, and it would give write access to a read-only secret. A new file is created next to the target with the final DACL and `FILE_ATTRIBUTE_TEMPORARY`; an existing one is overwritten with zeros in place before replacement.
14. **The fallback `bootId`** (§12.4): if the `BootId` counter cannot be read, a random UUID in the volatile key `HKLM\SOFTWARE\sbx-agent\Volatile` (SYSTEM only, lives until reboot). The kernel boot time does not fit: it shifts when the clock is set.
15. **The agent's freeze budget depends on the OS:** on Windows the agent's part of `freeze()` (watchdog, `*.ps1` hooks up to 5 s each, secret cleanup) is limited to 20 s, on Linux to 5 s. Of the 30 s for the whole `freeze()` (§12.10), 10 s remain for VSS. The quiesce lease must be greater than 20 s (worker: 30 s). Secret cleanup comes after the freeze hooks (hooks may stop processes holding files); on thaw the files are restored before the hooks. The Windows watchdog runs the thaw hooks but does not restore files (there is nothing to do it with outside the agent process); `sbx-agent thaw --force` calls `System/Thaw` over the admin socket.
16. **Paths:** the files API rejects paths without a drive (`\x`, `/x`) — `invalid_argument invalid_path`, while the command's `cwd` maps `\x` to the user profile's drive. The drive letter is uppercased.
17. **`PRESHUTDOWN`** (§12.2): first finishes the command jobs (`TerminateJobObject`, up to 3 s), then `PrepareStop` (secret cleanup, `state.db` flush); all within 10 s of the 15 s timeout.
18. **SCM failure actions:** restart 1 s, restart 1 s, then `cmd.exe /d /c if exist "<previous>\sbx-agent.exe" (… rollback) else ("<current>\sbx-agent.exe" rollback)`; reset 120 s. That is, the new version gets two restarts within 120 s, after that a rollback. Any agent-initiated exit (update, rollback, identity change) is code 75 without `SERVICE_STOPPED`. A missing `current` is not healed by the failure actions (the image path does not resolve); `early` does it (item 19).
19. **The wrapper `sbx-early.cmd`** is the GPO startup script: it runs `sbx-agent early` from `current\`, otherwise `previous\`, otherwise the newest `versions\<v>\`.
20. **ACLs of the agent directories:** `state\` is a protected DACL with SYSTEM only, `run\` is SYSTEM + Administrators; they are set before reading `early.json` and opening sockets. An `early.json` whose owner is not SYSTEM/Administrators is ignored.
21. **A clone's boot:** if the service saw Windows Setup running, after it ends the service performs the boot step itself at once, without the 60 s wait for `early.json` (on the clone's first boot the startup script ran during Setup and did nothing). A boot step error → exit 75 and a retry through the failure actions. While identity is not ready, the sockets are not open.
22. **Build steps:** `00-base`…`90-cleanup` in `infra/templates/_windows/steps/`; `60-desktop` is only the lock screen, first login, and the Default User hive. The `10-system` step installs OpenSSH only from the FoD (`openssh.source = inbox`), the `github` fallback is not implemented.
23. **A clone's first boot** (§10.2, §11.1): `SkipMachineOOBE`/`SkipUserOOBE`, the stub `ComputerName=SBXTEMPLATE`, no `SystemLocale`; the clone's `SetupComplete.cmd` runs `firstboot.ps1`, which restores what sysprep reset (services, code pages, BCD, WinRE, NetBIOS, the firewall policy). Verified on a 26H2 clone: OOBE passes, the `user` autologon works; ACP applies only after the rename reboot.
24. **A path with a file instead of a directory in the middle:** NTFS answers `ERROR_PATH_NOT_FOUND`, and Go defines `syscall.ENOTDIR` as the same code, so on Windows this is `not_found path_not_found` unless the file service itself saw the file on the path (then `failed_precondition not_directory`, as on Linux).
25. **The output trimming granularity on Windows is 64 KiB** (NTFS sparse files free space in 64 KiB blocks); `available_from` is always a multiple of 64 KiB, on Linux 4 KiB.

### 24.3 Coordinator decisions (R1–R17)

| | Decision | What it changes |
|---|---|---|
| R1 | Task 10 before Task 9 | the work order |
| R2 | the 30 s wait for deferred secrets in `Start` is Windows only (`PendingSecretsWait`: Linux 0, Windows 30 s) | §18.3 item 5: not enabled on Linux |
| R3 | two parallel tracks (Go and TS) | the work order |
| R4 | `setup.sh console` is a separate role `SbxConsole` (`VM.Console` on `/pool/umiak`), not a right in `SbxPoC` | §18.1 item 1 |
| R5 | the Windows template slot is 598, only after the old 598 is removed in `s5-fix`; do not touch 597 | §24.1 |
| R6 | the pwsh epilogue is separated from the script by an empty line (`\n\n`): a trailing backtick does not eat it | §12.6 |
| R7 | the shim itself resolves the program again and builds `BatchCommandLine`, passing the resolved path as the application name; the long pwsh script file is readable by the command's user | §12.6 |
| R8 | `offline.cmd` always ends with `wpeutil shutdown`; errors are `DONE errors <n>` in `sbx-offline.log`, judged by verify (§15 item 8) | §10.3 |
| R9 | the OS-independent shim server code is moved to a `linux \|\| windows` file unchanged | code structure |
| R10 | `DoSvc` stays Manual until `90-cleanup` (the FoD is downloaded through Delivery Optimization) and is disabled there together with `wuauserv`, `UsoSvc` | §8.1, §8.8 (the final image does not change) |
| R11 | a second reboot after `40-coding-agents`, before `50-sbx-agent`: DISM `ResetBase` in `90-cleanup` fails with pending CBS operations, and a reboot after `50` would start the agent and `identity apply` on the build VM | §5 `steps` |
| R12 | `agent-tests` attaches the test binaries as an ISO image (`sbx-build-agenttests-<ts>.iso`, `ide2`) instead of copying over QGA | §24.2 item 7 |
| R13 | `fork_to_agent_ready` = the duration of the snapshot + (`cloneFromSnapshot` → start → ready with the new name); the source shutdown between them is not included; both parts are in the report | §16 |
| R14 | `env --format pwsh`: values with control characters (or non-UTF-8) — `$env:K = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('<b64>'))`, the rest — `$env:K = '<v>'` with doubled `'`; `profile.ps1` accepts exactly these two forms | §8.4, §12.7 |
| R15 | the offline stage before sysprep (build 9 booted a sealed disk): booting the disk instead of WinPE is shut down and repeated (up to 3 attempts), the result is checked by booting the disk before sysprep (verify-offline); `dmwappushservice` is disabled by the clone's specialize, not by the offline stage | §7 items 6–7, §10.1, §10.3, §15.2 |
| R16 | one agent reboot for the rename on a clone's first boot (the §23 fallback): Setup overwrites the name from specialize in all tried variants; the cost of the mistake is ~25 s per create | §10.2, §11.1, §11.2 item 8, §15.1 item 2 |
| R17 | the offline stage boots WinPE not from a CD but from a one-shot ramdisk BCD entry (`bcdedit /bootsequence`) of the installed, not yet sealed Windows: after Windows ran, OVMF skipped "Press any key" 9 times out of 9; verify-offline deletes the entry and `C:\sbx-pe`; key presses remain only for the installation; replaces the CD boot and the R15 retries | §7 items 4, 6, §10.1, §10.3, §18.1 item 1, §23 |

### 24.4 Results on `pve`

| What | Value |
|---|---|
| Build duration (`sbx-tpl build windows`, without verify / with verify) | ≈ 27 min / 34.7 min (build `20261031.9`; verify alone 7.5 min) |
| Template size in the thin pool (`base-598-disk-*`) | 16.6 GiB used of 96 GiB (`diskUsedGiB`) |
| OpenSSH install method (FoD inbox, version) | FoD inbox, `OpenSSH_9.5p2 for Windows` |
| The `BootId` counter (reliable / fallback) | reliable: readable on a clone (`PrefetchParameters\BootId`), the agent's volatile key is not created |
| Reboots on a clone's first boot (specialize, §15 item 2) | 3 boots after seal: 2 from Setup (sysprep, winlogon) + 1 rename by the agent (R16) |
| Create: `create_to_agent_ready` (median / p95) | S1 create ≈ 2 s; start → agent ready: median 111.0 s, maximum 127.2 s (7 measurements: 5 bench attempts + 2 verify) |
| Fork: `fork_to_agent_ready` (median / p95; snapshot + clone→ready) | fork start → agent ready under the new name: 44.6 / 45.8 / 47.7 s (3 verify); snapshot ≈ 2–4 s; bench `--runs 3` did not finish (thaw hang, §24.5) |
| `freeze_ms` (QGA VSS freeze → thaw) | 544 / 614 / 1100 ms (the pause + `lvcreate` window in the snapshot, 3 verify) |
| `first_boot_to_agent_ready` / `boot_to_agent_ready` | median 111.0 s / 16.5–21.3 s; after a hard stop 14.0–16.9 s (median 15.2 s) |

### 24.5 Contracts for neighboring areas

A historical acceptance list; the current follow-up decisions, including the replacement of QGA/VSS by a crash fallback, are in §24.7; a Windows snapshot only from a stopped VM (replacing the crash fallback) is in §24.8.

- **S6.** Done in the worker (S9 Task 4): the shutdown timeout for `os = windows` is 120 s; a composite quiesce hook (agent `fs: false`, `wipe_secret_files` for `kind = saved`, then QGA VSS); the result `PrepareStop{secret_files_wiped}` is written to the stop progress. What remains for S6:
  - `machines.secret_files_on_disk` and the saved snapshot rules (§18.6 item 5): `secrets_in_use` → `snapshot_requires_stop`, a stopped machine with `true` → `snapshot_requires_clean_stop`;
  - discard a saved snapshot with `auto_thawed`: an expired lease between the agent's `Quiesce` and the QGA `fsfreeze` restores the secret files before VSS;
  - for Windows always send `fs: false` (by default `fs` = true → `fs_freeze_unsupported`);
  - the quiesce `lease_ms` greater than 20 s (§24.2 item 15);
  - resending `UpdateSecrets` on `readiness.changed{secrets: pending}` without a `boot_id` change (§18.6 item 7) — not done in S9.
  - `stop` right after `shutdown` + `start` may fail with `can't lock file ... got timeout`: qmeventd holds the VM lock for up to 30 s while waiting for the old QEMU to exit (seen on `pve`). The worker treats this as a transient error (`TRANSIENT_4XX_RE`) and retries; the retries must cover 30 s. A snapshot in this window waits for the lock inside the freeze budget and fails with `freeze took … (budget …)`; the worker must retry this too (or not take a snapshot earlier than 35 s after start, `VM_LOCK_AFTER_RESTART_MS`). `retryOnVmLock` from `@sbx/pve` is a ready retry for stop and snapshot.
  - **Open:** an S1 snapshot of a running Windows machine (QGA VSS freeze → pause → `lvcreate` → resume → thaw) in about half the attempts hangs thaw in qemu-ga: the guest stays frozen (12 min with no disk writes, `agent.log` and the Windows logs are empty), the QGA socket is busy until a hard stop (`ThawFailedError`). Seen in bench (a snapshot 35 s after restart, 3 of 3) and manually (3 of 6); the fork-snapshot verify passed in all three runs, and a manual `qm` + `lvcreate` sequence on a fresh boot too. Host load, warm-up (a freeze + thaw beforehand), and time after boot do not explain the cause; it is in qemu-ga/Windows VSS and was not found. After a hard stop NTFS is intact, the guest writes after the freeze are lost. The S6 protection is implemented in `s9-fix`: a bounded wait for thaw and a hard stop on `ThawFailedError` (§24.6); the root cause remains open.
- **S7.** Documentation of the Windows semantics and the error codes of §18.7, including `desktop_not_ready` (for now on any `desktop: true`), `secrets_in_use`, `fs_freeze_unsupported`; `hostname_applied = false`; `exec`/`call` are local tools, not an API.
- **S10.** Not done in S9: `sbx-session.exe`, the task `\sbx\session`, `run\session.sock`, the `desktop` phase (and `desktop` in `readiness.required`), launching commands with `CommandSpec.desktop` in the console session (§13). Present: the `user` autologon, with no lock and no first-logon wizards.


### 24.6 S9 acceptance fixes (`s9-fix`, 2026-11-01 NZ / 2026-10-31 UTC)

Decisions and behavior:

1. **Resumable upload / NTFS ACL.** On Windows commit always copies the contents into `writeTemp` next to the target, then atomically places the file. A rename from the SYSTEM-only `state\uploads` no longer carries its DACL over. The source handle is closed **before** the upload file is deleted: otherwise Windows leaves the source and breaks restoring the result after a lost response. Unix keeps the fast rename; a cross-device copy also closes the handle before unlink. The cost on Windows is an extra copy of the contents at commit.
2. **Update / NTFS ACL.** The signed package is still unpacked and verified in a protected staging area. On Windows the verified tree is copied into a temporary directory directly under `VersionsDir`, then renamed to the version: the files and the nested `trust` inherit the permissions of versions. Unverified files are not published into versions. The cost is one extra copy of a small package.
3. `composeHooks.thaw()` marks the cancellation **before** waiting for the hooks. An agent freeze that finishes late is released again, and the VSS freeze is not started after the cancellation.
4. A saved Windows snapshot requires the declared capability `system.quiesce.wipe_secrets.v1`. A connected agent without it gives a permanent `quiesce_failed` naming the capability before the snapshot / freeze. An unavailable agent remains a transient error; there is no QGA-only fallback for a saved Windows.
5. Replacing a secret holds the old handle with DELETE until the rename completes. On failure the zeroed old file is deleted via delete-on-close, and the replacement error is returned explicitly (not masked as "secret left in use"). New secrets are still not flushed, old ones are zeroed and flushed before replacement.
6. The global `sbx-bench cleanup` requires an explicit `--all-sandbox-resources` and without it refuses before any cleanup actions. This is a **global**, not run-scoped, mode; it must not be used during parallel work. The verify abort message recommends deleting only the VMIDs and snapshots of its own run, explicitly warning about the global flag.
7. **Thaw safety.** S1 limits each thaw attempt to 10 s, by default 3 attempts and 500 ms delays (up to 31.5 s of waiting for thaw; the LV deletion / PVE stop timeouts apply separately). After a `ThawFailedError` the worker, under the shared power lock, checks the original lease owner and hard-stops the VM; a recycled VMID of another owner is not stopped. The operation gets a permanent `quiesce_failed` with the message hard-stopped / start again normally; if the stop failed, the message contains both errors. The LVs of the failed snapshot are deleted by S1. A fake-PVE test checks stopped and a successful subsequent ordinary start; a separate S1 test checks a thaw that never returns and the absence of snapshot LVs.

Verification on a real Windows clone **570** of the read-only **598 / 20261031.9**:

- RED: `TestUploadInheritsTargetACL` and `TestInstallInheritsVersionsACL` on the old code both failed with a DACL containing only SYSTEM. GREEN: all **19/19** Windows test binaries passed, including these regressions, the lost commit result, and `TestReplaceFailureRemovesZeroedSecret`.
- The built fixed agent was installed with a signed `install-package` as `0.1.0+s9-fix.1` on the clone; the template was not changed. HTTP `PUT /files/uploads/s9fix?offset=0&user=user`, then commit into `C:\Users\user\sbxt\up.txt` — 200 / 200. `icacls` of the file: SYSTEM, Administrators and **user:(I)(F)**. Version and binary: **BUILTIN\Users:(I)(RX)**. `exec --user user` reads `upload-readable`, the version manifest, and runs `current\sbx-agent.exe env --format pwsh`.
- After a claim with `S9_ACL=verified`, the command `exec --user user -- pwsh -Command ...` with an ordinary profile prints `verified`; `env --format pwsh` contains `S9_ACL`, `SBX_HOSTNAME`, and `SBX_SANDBOX_ID`. This also verifies the profile path after the version switch.
- The full Windows run revealed two portable bugs in old tests: a check of Unix mode 0644 for the SSH CA on Windows, and replacing a fake `/proc/net/tcp` through an ordinary `os.Rename` that conflicts with a reader handle. The tests are fixed: the Unix mode is checked only on Unix, the fixture uses `os.Root.Rename` (POSIX rename semantics on Windows).

**The thaw investigation (item 8), the root cause is not eliminated.** On the clone verbose QEMU-GA was enabled in `C:\Program Files\Qemu-ga\qemu-ga.log` (a change on the clone only). QGA reports **109.1.0**; VirtIO SCSI / net / serial / RNG — **100.100.104.27100** (the 0.1.271 media). Before the freeze VSS and `QEMU Guest Agent VSS Provider` are Manual / Stopped, the writers are Stable / No error; these states alone cannot prove an unfinished start. VSS Application events: only **8224, shutting down due to idle timeout**; there are no QEMU-GA crash events from SCM in the check.

Repeat: hard stop 12:40:40 UTC → start 12:40:41 → agent ready 12:40:56. A snapshot about 53 s after start again gave **ThawFailedError after 27.927 s**; a hard stop was called, then an ordinary start restored QGA and sbx-agent. The log contains `guest-fsfreeze-freeze`, then `disabling logging due to filesystem freeze` (12:41:34); there is no thaw entry in the file because logging is disabled during the freeze. The verbose log collected after recovery contains GLib `gspawn-win32.c:681 (might_be_console_process): should not be reached` and `error sending error response: Input/output error`; a lost exec status was also observed. These are separate observations, **not a proven cause of the VSS hang**. Verbose `prepare/check` creates hundreds of MB within minutes; the log must be read in bounded byte ranges, an ordinary tail may not keep up with the growing file. Verbose is not enabled in production.

No reliable readiness predicate / retry pattern was found: there is no basis to declare `quiesce_ready` from agent-ready alone, from the state of Manual services, or from Stable writers. No mitigating VSS change was made, and a successful `sbx-bench s9 --runs 3` is not claimed. The protection from item 7 remains; the investigation was carried out within the 2 h limit, without rebuilding the template or changing the host.

Checks: workspace build, typecheck, Biome; TS suites sequentially (worker 381 + 5 skipped, PVE 192, bench 44); Python SDK 77; Go race/vet/golangci-lint of all modules, Linux cross-build; Windows build/vet/lint of all applicable modules (node-agent is Linux-only). The initial parallel API suite had a teardown flake `terminating connection due to administrator command`; the sequential API run — 1008 passed.

Final cleanup of `pve`: VM 570 deleted, the allocator snapshots of its own run are empty; both ISOs (`sbx-build-agenttests-20261031123309.iso`, `sbx-build-s9-fix.iso`) deleted. The checks `qm list`, `lvs -o lv_name,lv_tags`, and `pvesm list local --content iso` confirmed the absence of my VMs/LVs/ISOs and of any `sbx-snap-*` LVs. VM 596 of another thread was left unchanged.

### 24.7 S9 follow-ups (2026-11-01 NZ)

**Snapshot decision: Windows uses a crash-consistent fallback without QGA/VSS.**
*Replaced by §24.8: a Windows fork and saved snapshot are taken only from a stopped VM; the crash fallback is removed from the public path.*
`Machines.snapshot` for `ostype=win*` does not call QGA freeze/thaw by default;
a multi-disk snapshot still does pause → LVM snapshots → resume.
The new metadata contains `consistency=crash` (a stopped VM — `powered_off`).
The worker explicitly selects the same mode. A saved snapshot requires an available agent with
`system.quiesce.wipe_secrets.v1`: `Quiesce{fs:false,wipe_secret_files:true}` →
snapshot → agent Thaw, **without a second QGA hook**. The agent's watchdog/auto-thaw
still invalidates a saved snapshot: otherwise secrets could
be restored before the copy. This is not an application-consistent/VSS backup;
applications recover as after a power loss. Linux is unchanged.
`crashConsistent:false` in S1 is kept for explicit diagnostic experiments;
the worker does not use it for Windows. The bounded thaw / hard stop protection remains.

**Observations on a separate clone 580 of template 598:**

- QGA/provider `109.1.0`, command line `qemu-ga.exe -d --retry-path`.
  The provider is registered; the QEMU-GA, VSS, and provider services ran
  after successful cycles. The Application log has VSS 8194: System Writer,
  `IVssWriterCallback`, `0x80070005`; it also occurs on successful snapshots.
- 10 manual cycles of QGA freeze → pause → snapshot of three LVs → resume → thaw
  passed; then 10 consecutive snapshots through the real S1 passed too.
  After a hard stop/start the first S1 snapshot reproduced `ThawFailedError`.
  The experiment has no sbx-agent quiesce: a collision of composite hooks is not required.
- On **this clone**, without changing 598, the MSI current at the time of the experiment was installed
  from `https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/latest-qemu-ga/qemu-ga-x86_64.msi`.
  SHA-256 `19dcf8abc30f70c2eb6e87282601fd0476e4e0b19936f63d9c80be30db0796ed`,
  size 11909632 bytes; MSI install exit 0, QGA/provider became `110.2.3`.
  10 S1 snapshots passed, but **the first after a hard stop/start hung again**.
  Updating QGA alone is not a fix.
- The new QGA trace: freeze POST 13:50:17.896–13:50:22.443 UTC (4.547 s),
  pause/LVM/resume until 13:50:23.305 (0.862 s); the first thaw started right after
  and did not answer. The following thaw/status gave `QEMU guest agent is not running`.
  The interval from the start of the freeze to the thaw is 5.409 s; the single hypothesis of exceeding the
  10 s VSS hold window is not enough. PVE suspend/resume without includestate
  calls QMP stop/cont and does not start a second VSS requestor.

**The root cause inside Windows/QGA/VSS remains open.** It is not proven
that VSS 8194, VirtIO serial/SCSI, or waiting for VSS async completion is to blame.
The next experiment to return to the application-consistent mode: on a separate
clone with 110.2.3 collect the thread stacks of QGA and the VSS provider at the hang (WinDbg/WPR),
in parallel a raw virtio-serial request/response and a QMP timeline; separately
compare freeze/thaw without a pause and with a pause after a hard restart. Upstream
`requester_thaw` signals an event, then waits without a limit on `IVssAsync::Wait`;
it needs to be determined whether the hung thread entered there and where the provider stands.
Sources: [QGA protocol](https://www.qemu.org/docs/master/interop/qemu-ga-ref.html),
[upstream requester](https://github.com/qemu/qemu/blob/master/qga/vss-win32/requester.cpp).
A mode without writers is not provided in the public QGA RPC; we do not substitute it
with undocumented registry settings. We do not change the QGA recipe: the new version
did not remove the hang, **rebuilding 598 is not required for this fallback**.

**Contracts and minor fixes.** The runtime migration `0207` conservatively
marks existing Windows machines with a tenant as potentially dirty.
Non-empty secret files are marked before the RPC; a clean PrepareStop/a successful empty
replacement clears the flag. A running saved snapshot with the dirty flag → `snapshot_requires_stop`,
a stopped dirty one → `snapshot_requires_clean_stop`; fork is not limited by this flag.
This is a conservative clarification of §18.6 item 5: a live save with files requires
a clean stop first. Secret delivery is repeated on reconnect/restart and
same-boot `secrets:pending`, with durable generations for pending during another
operation; stop/snapshot retry the qmeventd lock with a new fencing and a fresh hook.
Details and test contracts — S6.

The Payload data migration `20261101_000000_windows_template` adds the missing
`windows`/`4gb` on existing installations without overwriting operator settings;
build 598 is already registered separately from the compose YAML. There is no deploy to CT 590.
The CLI refresh regression was reproduced by a forced GC: the weak reference of Request to
AbortController could be lost. The HTTP send holds the Request and waits for the original abort
directly, the timeout and lock release are checked in a separate GC process.
`sbx-agent call … -` strips a leading UTF-8 BOM; a typed `user_not_found` in exec
gives 127 (other RPC errors 125), the S7 API keeps 400 validation.
Upload copy-commit stores a durable identity anchor next to the target, recognizes
a repeat by inode rather than by byte match; cleanup after a durable commit is best effort.
The copy fallback requires hardlinks (in particular NTFS), an ordinary Unix rename is kept.

**Fallback check:** on the original 598 (QGA 109.1.0), VM 570,
10 consecutive snapshots of a running VM 13:56:57–13:57:11 UTC,
all `consistency=crash`, pause/snapshot/resume 543–862 ms; after each
attempt the snapshot LVs were deleted. The series ran on the first boot A of the second
bench run: it adds pauses to its create-to-ready, so these
times cannot be taken as a clean performance comparison.

**Local branch checks.** `mise exec -- pnpm --workspace-concurrency=1 -r
--if-present build`, serial `typecheck`, `pnpm lint` passed. The full serial
workspace test: 4342 TS passed, 6 skipped; Python SDK 77 passed. After
adding stop-inside-delete coverage, worker again: 397 passed,
5 skipped; PVE: 195 passed; bench unit: 44 passed. All five Go modules:
`go test -race ./...`, `go vet ./...`, `golangci-lint run` — exit 0.
For guest-agent 19 Windows test binaries were built (GOOS=windows/amd64);
execution of the new Windows regression tests on a guest is not claimed here.

**Bench and cleanup result:** `sbx-bench s9 --template 598 --runs 3` through
`runS9` with an additional host guard before each start finished with exit 0,
3/3 runs (14:06:35 UTC). The range of this run is 570–579, a separate
local allocator state; CT 590/the tunnel registrar was not used.
All three forks booted with a new identity and hostname. Snapshot total /
pause window: 1040/815, 1745/1067, 791/562 ms. This is a check of the **fallback**,
not of a successful VSS thaw; the template still has QGA 109.1.0.
The final `qm list`, `lvs -o lv_name,lv_tags`, `pvesm list local --content iso`
confirmed the absence of VMs 570/571/580, snapshot LVs, and the temporary
`s9-followups-qga.iso`. Resources of the parallel S10 were not changed.
Next: independent master acceptance and a deploy with both migrations. The sbx-agent
fixes must be delivered to existing guests via an update or a future
template build; there was no rebuild of 598 in this branch and the crash fallback
does not require it.

### 24.8 Windows fork and saved snapshot only from a stopped VM (`win-force-stop`, 2026-11-01 NZ)

**Ilia's decision.** QGA/VSS thaw hangs (§24.5–§24.7), and a crash-consistent snapshot of a running VM (§24.7) loses or zeroes recent writes from the guest cache. So a Windows fork and saved snapshot are made only from a stopped VM; the crash fallback is removed from the public path. The value `consistency = crash` remains in the schema for old snapshots and for Linux after a hard stop (§24.9); the platform creates no Windows snapshots with it.

**Contract.**

- A running (`ready`) Windows sandbox: `POST /v1/sandboxes/{sandbox}/fork` and `POST /v1/snapshots` without `forceStop: true` → `409`, nothing is created:

  ```json
  {"error": {"code": "snapshot_requires_stop",
    "message": "Windows sandboxes are forked from a stopped VM; stop it first or retry with forceStop: true (CLI --force-stop), which stops the sandbox, takes the snapshot and starts it again",
    "retryable": false,
    "details": {"reason": "windows_running", "retryWith": {"forceStop": true}, "cli": "--force-stop"},
    "requestId": "req_..."}}
  ```

  For save the message begins with "Windows snapshots are saved from a stopped VM; …". The CLI prints the message and `hint: use --force-stop …`; MCP (`force_stop` on `sandbox_fork` and `snapshot_save`) — the hint "retry with force_stop: true …"; the SDKs return `SbxError` with `code` and `details`; the web shows a confirmation and sends the flag (S8 §9.7).
- `forceStop: true`: in the same fork / save_snapshot operation the worker does a stop (PrepareStop with erasing secret files, a shutdown of up to 300 s without a hard stop; a timeout → `shutdown_timeout`, no snapshot, the source is started again, §24.9), a snapshot of the stopped VM (`powered_off`), a start of the source (with `retryOnVmLock` for the qmeventd lock), waiting for the agent on the new boot and re-delivery of env/secrets, then continues the fork (handing the snapshot to the target). The steps, progress, RAM, and deadlines are in S6 §7.8, §7.9, §8.1. The operation returns `forceStop {sourceStopped, sourceRestarted, restartError}` (S7 §8.4).
- A failed restart of the source after the snapshot does not fail the fork (neither an error nor an expired deadline): the source is `error` / `resume_failed`, the machine `stopped`, the snapshot is intact; it is brought up with an ordinary resume. Transient restart errors are retried. A failure before the snapshot is compensated, and the compensation starts the source.
- A stopped Windows — without the flag, as before. Linux — unchanged (live quiesced); `forceStop` is accepted and ignored (not written to the operation).

**Live check on `pve`** (2026-10-31 23:06–23:12 UTC, the opt-in test `apps/worker/test/pve-force-stop.test.ts`, `SBX_PVE_FORCE_STOP=1`). Real worker operations (cold create, fork with `forceStop`, stop, create of the fork target, delete) through the real PVE adapter; a clone of template **598**, VMID 580/581, one 4 GB VM at a time (a `qm list` check before each start; a VM of S10 ran in parallel). The agent port is `ConnectAgentPort` with a transport through QGA (`sbx-agent call` to the agent's admin socket), tunnel sessions are emulated by polling `System/Info` over QGA: the gateway and tunnel are not needed, CT 590 was not touched.

| Step | Time |
|---|---|
| Cold create of the source → ready | 128.5 s |
| fork without the flag | `409 snapshot_requires_stop` (the body above), the VM keeps running |
| Write 20,000 bytes to `C:\sbx-force-stop.txt` (`WriteAllText`, no flush) → immediately a forced fork | — |
| Forced fork, the whole operation | 79.8 s |
| · PrepareStop + shutdown (clean, `secretFilesWiped: true`) | ≈ 61 s (shutdown 60.2 s) |
| · snapshot of the stopped VM (`powered_off`) | 0.73 s |
| · S1 start | 1.2 s |
| · start → agent ready on the new boot, provision | ≈ 16 s |
| Source after the operation | `ready`, machine `running`, a new boot id, the name unchanged `SBX83E1650251FA` |
| Create of the fork target (clone from the snapshot → start → agent → claim) | 61.8 s; the fork booted as `SBX7B666382CEC3` |
| The file in the fork | SHA-256 matched (`ecbdbf07…a9c8c`), the write is intact |

Before starting the target the source was stopped with an ordinary stop (22.7 s) only for the one-4-GB-VM rule. Cleanup: both VMs deleted through the worker delete, the fork_source snapshot deleted by `snapshot-op`; `qm list` (no 580–589), `lvs` (no `vm-58x-*` and `sbx-snap-*` of the run), the run's leases — 0. In the first of six runs the cold create of the source failed right after the session connected; the error log was not printed then, and in the following runs the same step passed. The other failures of the runs were errors of the harness itself (the QGA `input-data` limit of 65,536 characters, PowerShell stdin through QGA without EOF, the test team's RAM quota).

### 24.9 Acceptance fixes for `win-force-stop` (`win-force-stop-fix`, 2026-11-01 NZ)

Master session decisions on the findings of the independent acceptance (they follow Ilia's decision: there are no crash-consistent Windows snapshots).

1. **A shutdown timeout does not give a crash snapshot labeled `powered_off`.** The graceful shutdown budget is `SHUTDOWN_TIMEOUT_S` (`apps/worker/src/ops/stop.ts`): Windows 300 s, Linux 60 s, for both an ordinary stop and a forced one (item 7); the forced one has its own override `timing.forceStopShutdownTimeoutS`. A timeout → the operation `failed`, `shutdown_timeout`, `retryable: true`, the message "the guest did not shut down cleanly within N s; nothing was snapshotted, the sandbox is started again". The hard stop is done by the compensation (the machine in `stopping`), which then starts the source. An ordinary stop after the budget still does a hard stop (without `clean_stop`).
2. **A snapshot after a hard stop is never `powered_off` on any path.** The new `machines.clean_stop` (migration `0208`, a reset trigger) — S6 §7.8. A stopped Windows without a clean shutdown → `snapshot_requires_clean_stop`; Linux → `consistency = crash`. The paths where this triggers: a stop with a hard stop after a timeout or in `stop_verify`, a machine after a failed resume / restart (the compensation hard-stops it), a VM stopped by reconcile after a manual start, a crashed VM.
3. **A restart after the snapshot does not fail the operation.** The restart budget = max(the resume deadline, `boot_timeout_s` + 5 min) (for template 598 with 1200 s — 25 min). After `progress.snapshotTaken` the deadline no longer applies: an expired deadline during `restart_agent` leads to a successful fork, and a failed restart leads to `sourceRestarted: false`, the snapshot is not deleted.
4. **Transient restart errors are retried** (any error that is not `retryable: false`, including `ECONNRESET` and the qmeventd lock) with a 5 s pause up to the extended deadline; only then the source → `error`.
5. **S1 without a silent crash.** `Machines.snapshot` of a running Windows without an explicit `crashConsistent` (with or without a hook) → `SnapshotModeRequiredError` (worker: `snapshot_requires_stop`, permanent). The worker always passes `crashConsistent: false`. Bench S9 explicitly passes `true` (measuring the crash fallback), the Windows template check (`template-builder`) passes `false` for VSS attempts (as intended and as its tests expect; after 4c55eba7 it silently got a crash), then an explicit `true` for the fallback with a WARN.
6. **MCP `sandbox_fork`** after waiting re-reads the `sourceOperation` of a forced fork and, like `snapshot_save`, writes "the copy is made, but the source sandbox did not start again after the forced stop (code: message); call sandbox_resume on the source".


7. **Ordinary Windows stop: shutdown 300 s** (was 120 s), Linux 60 s unchanged. The Windows stop deadline 5 → 7 min (300 s shutdown + PrepareStop 10 s, VM lock retries, verify); a forced fork/save of Windows 10 / 12 min until the snapshot, respectively. The 120 s in §18.6 item 10 and §24.5 is replaced by this.
8. **A shutdown that did not take the VM lock is no longer considered a guest timeout.** An observation of a live run (00:21:27 UTC): an ordinary stop right after a hard stop + start (the compensation of the timeout scenario) went "shutdown 10.3 s, then stop 4.2 s". The PVE task log: `qmshutdown` failed after 10 s with `can't lock file '/var/lock/qemu-server/lock-580.conf' - got timeout` (the lock was held by qmeventd after the hard stop at 00:21:10), the guest did not get the ACPI request; the adapter saw `running` and returned `timeout`, stop did a hard stop. The label was honest (`shutdown: hard`, `clean_stop = false`), but the hard stop was unnecessary; in the forced path the same would have given a false `shutdown_timeout`. Now `PveNodeInfra.shutdown` retries such a task (`retryOnVmLock`, 5 attempts of 10 s, the fence is rechecked in the pauses and under the power lock) and returns `timeout` only on a real guest timeout; exhausted retries are a transient error, the job is repeated. `clean_stop`: a clean shutdown after a retry → `true`, a hard stop (a guest timeout or a VM still running in `stop_verify`) → `false`.
9. **Not verified live:** template-builder (the Windows template check) now really tries VSS with a freeze budget and retry, then an explicit crash fallback with a WARN (item 5). To be checked at the next Windows template rebuild.

**Live check on `pve`** (2026-11-01 00:18–00:22 UTC, the same opt-in test `apps/worker/test/pve-force-stop.test.ts`, a clone of template 598, VMID 580/581, one 4 GB VM at a time; VM 500 of S10 ran in parallel). Cold create of the source 114.8 s; fork without the flag — `409 snapshot_requires_stop`; forced fork 48.4 s: guest shutdown **28.7 s** (clean, budget 300 s), snapshot 0.68 s (`powered_off`), start 1.2 s, agent and provision ≈ 17 s, `sourceRestarted: true`. The timeout scenario: a forced save with a shutdown budget of 5 s → `failed shutdown_timeout`, `retryable: true`, 22.4 s; the snapshot `failed`, `consistency` null, no LV with its tag; compensation: hard stop 0.35 s, start 0.9 s, the source `ready`, machine `running`. The fork target booted in 44.3 s under the new name, the SHA-256 of the unflushed file matched. Cleanup through the delete worker: no VMs in 580–589, leases 0, no `sbx-snap-*` LVs.

Linux: forceStop and the refusal without the flag for Linux are covered only by unit tests (fake PVE: `ops-force-stop.test.ts`, "Linux ignores forceStop", "Linux after a hard stop … crash"); a live Linux fork was not run: template 597 has the old agent (`sbx-agent: unknown command "call"`), the templates were not rebuilt.

**Live check of an ordinary stop** (2026-11-01 00:38–00:42 UTC, the same opt-in test, `-t "plain stop"`, clone 598, VMID 580/581, one 4 GB VM at a time; VM 595 of S10 ran in parallel). Cold create 108.7 s; ordinary stop 13.6 s: guest shutdown **13.2 s**, clean, hard stop 0, `secretFilesWiped: true`, machine `stopped`, `clean_stop = true`. A fork without the flag from the stopped one: no 409, the operation 1.3 s, the snapshot `powered_off` 0.89 s, the source stays `stopped`; the fork target booted in 59.7 s. Cleanup: no VMs in 580–589, leases 0, no `sbx-snap-*` LVs.

### 24.10 Rebuild of 598 with the `rebootBoot` fix (`win598-rebuild`, 2026-11-02 NZ)

The `windows` template in 598 was rebuilt with the agent from `main` (`767aace0`, the §11.2 `rebootBoot` fix from `s10-followups`). The procedure is the same as for `windows-desktop 20261101.6`, unchanged: `infra/templates/agent-package.sh --tunnel-ca ~/.config/sbx/dev-ca/ca.pem --os windows`; the old build is removed before the new one (there is one slot): `sbx-tpl retire <buildId> --delete-vm --force` with `SBX_TEMPLATE_VMID_RANGE=598-598`; `sbx-tpl build windows --agent-package <tar> --connect-url wss://tunnel.192-168-68-90.sslip.io/v1/connect --dev-cp-ssh sbx@192.168.68.90`; the version and agent go in `deploy/compose/config/sbx.yaml`, then `infra/dev-cp/deploy.sh`.

- Build `windows 20261101.1` (`01a19869-15ea-7719-80ee-cb771e00e973`), agent `0.1.0+20261101.767aace0`; 2395 s with the built-in verify, 16.8 GiB in the thin pool; `pve` load 8–20. Verify: 101 PASS, 0 FAIL, 5 INFO. The verify VSS snapshot passed normally (freeze → thaw 4.1 s), the thaw hang (§24.7, roadmap) did not occur. The clone's first boot 112 s, identity change 37.7 s, exactly one rename reboot. Build `20261031.9` is `retired`, the VM deleted; `sbx-tpl cleanup` — nothing to clean.
- Live on CT 590 (CLI, `e2e@example.com`): create `windows` → ready in 111.5 s. The rename reboot (1074 from `sbx-agent.exe`) 26 s before ready, no reboots after the claim: the source for 12 min (until the forced fork stopped it), the fork for 7 min after ready (`LastBootUpTime` the same, no new 1074). Forced fork (`--force-stop`) — ready in 75.9 s: the source's file is in place, its own name, one rename reboot before ready; the source was restarted (1074 from `qemu-ga.exe`) and is ready.
- The quota of the dev team `e2e@example.com` is 6144 MB (the Payload default), and a forced fork of Windows 4gb holds two 4 GB VMs: `quota_exceeded` before the snapshot. For the check, `quota_max_ram_mb = 8192` was temporarily set on the team, then NULL again. For the stand this is expected (an immediate refusal, before the source is stopped).
- After deploying the branch: `infra/dev-cp/e2e.sh` 20/20; Windows `e2e-desktop` (`windows-desktop 20261101.6`) — 44 checks, 0 failures, create 133.7 s. After cleanup there are no VMs 500–589.
