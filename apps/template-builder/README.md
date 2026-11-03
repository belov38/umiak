# template-builder (`umiak-tpl`)

Builds Proxmox VM templates from the recipes in `infra/templates/` (spec: `docs/specs/s5-linux-template.md`,
plan: `docs/plans/s5-linux-template.md`). The build VM is driven only through the QEMU guest agent
(no SSH to the guest, no root SSH to the host).

## Prerequisites (operator's Mac or a Linux CI runner)

- Tools through mise (`mise exec -- node ...`); `xorriso` in `PATH` (macOS: `brew install xorriso`).
  `hdiutil` is not used: it shortens names with dots (`sudoers.d` became `sudoersd`).
- Host runbook steps done: `infra/pve/setup.sh media` (role `UmiakTemplateMedia` on `/storage/local`) and
  `infra/pve/setup.sh node` (an `umiak-node` with `media.list`/`media.remove` and template origins in its range).
- The S1 client config (`UMIAK_PVE_URL`, `UMIAK_PVE_TLS_NAME`, `UMIAK_NODE_SSH_HOST`, `~/.config/umiak/`).
- Dev template slots: `linux` 597, `linux-desktop` 596, `windows` 595. Templates 595–597 are read-only on the active stand: no rebuilds or deletes. VM 598 (old headless Windows) was deleted on 2026-11-04; slots 598 and 599 are free.

## Build

```sh
export UMIAK_PVE_URL=https://100.64.10.2:8006 UMIAK_PVE_TLS_NAME=pve UMIAK_NODE_SSH_HOST=100.64.10.2
mise exec -- node apps/template-builder/src/main.ts preflight

# The agent package: the tunnel CA is a build parameter (one build = one tunnel CA bundle).
pkg=$(infra/templates/agent-package.sh --tunnel-ca ~/.config/umiak/dev-ca/ca.pem --out /tmp/umiak-agent-pkg)

mise exec -- node apps/template-builder/src/main.ts build linux --agent-package "$pkg"
# Dev stand: also check that a clone's agent connects to the dev gateway (CT 590).
#   --connect-url wss://tunnel.192-168-68-90.sslip.io/v1/connect --dev-cp-ssh umiak@192.168.68.90
```

Options: `--refresh` (run `versions --update` first, then commit `versions.toml`), `--tunnel-url` (a default
URL in `agent.toml`; without it the worker sets the URL per VM through `smbios1.family`), `--umiak-cli`,
`--api-url`, `--ssh-user-ca`, `--keep-on-failure`, `--no-verify`, `--fail-step <step>` (test flag).

A build takes about 10 minutes plus verify. Output: a Proxmox template VM `umiak-tpl-<slug>-<YYYYMMDD>-<n>`
(tag `umiak-tpl`, pool `umiak`), the manifest in `~/.local/state/umiak/templates/<buildId>.json`
(`UMIAK_TEMPLATE_REGISTRY`), step logs in `build-logs/<buildId>/`, and the `umiak-admin template register`
line plus the `topology.templateBuilds` YAML for the worker.

Other commands: `versions <slug> [--update]`, `verify <buildId>`, `list`, `show <buildId> [--field f]`,
`show --active-vmid <slug>`, `cleanup` (failed build VMs, seed images, template leases; never a template).
`promote` and `gc` belong to S6 (`umiak-admin template promote`).

## Windows build

Spec: `docs/specs/s9-windows.md`. Recipe `infra/templates/windows` (Windows 11), shared steps, unattend files
and keys in `infra/templates/_windows`. Windows includes Sunshine, moonlight-web and cua-driver (`60-desktop` / `65-streamer`). Services remain Manual and start on first desktop open. `verify: windows` runs baseline and desktop checks. The legacy `windows-desktop` builder argument resolves to `windows`; only one recipe is stored. Dev template slot 595; VM 598 stays retired and read-only.

Host prerequisites on top of the Linux ones: `infra/pve/setup.sh console` (role `UmiakConsole` with
`VM.Console` on `/pool/umiak`, needed for `sendkey`), an `umiak-node` with `media.sha256`, and the user's
Windows ISO in `local:iso` under its Microsoft name (`umiak-tpl iso upload <file>` or the Proxmox web UI).
`preflight windows` checks the `VM.Console` right, the pinned machine type and the ISO sha256 through
`media.sha256`.

```sh
pkg=$(infra/templates/agent-package.sh --tunnel-ca ~/.config/umiak/dev-ca/ca.pem --out /tmp/umiak-agent-pkg --os windows)
mise exec -- node apps/template-builder/src/main.ts preflight windows
# First build with a new ISO: compute its sha256 and write it into versions.toml (commit it afterwards).
mise exec -- node apps/template-builder/src/main.ts build windows --agent-package "$pkg" --accept-iso-sha256
```

Windows options: `--iso <file>` (an ISO in `local:iso` other than `versions.toml [iso]`; needs `--iso-sha256 <hex>`
or `--accept-iso-sha256`), `--edition <name>` (`/IMAGE/NAME` in `install.wim`), `--product-key-file <file>` (a
real key; it never reaches the manifest). The build VM gets 4 vCPU / 4 GB, so the RAM guard needs that much free.

Stages: media (user ISO sha256, virtio-win 0.1.271 uploaded once as `umiak-virtio-win-<v>.iso`, build and offline
ISOs) → build VM (OVMF, Secure Boot, vTPM, network down) → install (`sendkey` for "Press any key", unattended
setup, wait for QGA) → steps as SYSTEM scheduled tasks (`run-step.ps1`) → `umiak-agent seal` and sysprep → offline
WinPE stage (Defender, WaaSMedic off) → template → verify (a clone through specialize, then a fork with a new
identity). Build and verify times: `docs/specs/s9-windows.md` section 24.4 (filled after the pve runs).

Build the patched moonlight-web executable first with `infra/templates/windows/moonlight-web/build.sh`. The quickstart wizard and Templates page accept a licensed Windows ISO HTTPS URL or an uploaded ISO, following S16. No ISO is bundled.

## How a build runs

1. Verify the agent package (ed25519 over `manifest.json`, file sha256s, strict tar parsing) and fetch the
   Ubuntu minimal image (signed `SHA256SUMS`, pinned key fingerprint, sha256 from `versions.toml`).
2. Upload the image to `local:import` once per serial; render the NoCloud seed (`cidata`) and upload it as
   `local:import/umiak-seed-<buildId>.raw`.
3. Create the build VM: `scsi0` imported from the image, the seed as disk `scsi1` (the first boot of the
   cloud image has no initrd, so CD drivers load after cloud-init looks for its seed), `smbios1` serial
   `ds=nocloud`. Tags are set right after the create call (Proxmox checks tags on `/vms/<id>` without the pool).
4. Run the steps as transient systemd units (`systemd-run`), tailing `/var/log/umiak-build/<step>.log` by
   byte offset through `agent/file-read`; `reboot` after `00-base`.
5. Record the facts (packages, tool versions), write `/etc/umiak-template/build.json`, drop the build logs and
   the random seed, `umiak-agent seal`, zero-fill free space, `fstrim`, power off.
6. Remove the seed disk and `smbios1`, drop the build VM's firewall config, convert to a template.
7. Verify (spec section 10): a clone with a test smbios, `verify.sh` through stdin, `umiak-agent doctor`, tools,
   Docker, a raw-disk scan of the clone for build secrets (patterns on stdin), hard stop and restart, a fork
   with a new identity, optionally the tunnel session on the dev gateway; clones are deleted.

## Image notes

Auto-update of the coding-agent CLIs is off through each vendor's system-wide config
(`infra/templates/linux/files/etc/`, installed by `40-coding-agents`). Versions change with a new
template build; a user can still update a CLI with `sudo`.

| CLI | File | Setting | Source |
|---|---|---|---|
| Claude Code | `/etc/claude-code/managed-settings.json` | `env.DISABLE_AUTOUPDATER = "1"` | code.claude.com docs (setup, managed settings) |
| Gemini CLI | `/etc/gemini-cli/settings.json` | `general.enableAutoUpdate`, `general.enableAutoUpdateNotification` = `false` | `docs/reference/configuration.md` in the npm package |
| OpenCode | `/etc/opencode/opencode.json` | `autoupdate: false` | opencode.ai/docs/config (managed config dir `/etc/opencode`) |
| Codex | `/etc/codex/config.toml` | `check_for_update_on_startup = false` | `codex-rs/core/config.schema.json` in openai/codex; system config path from the Codex docs |

All four have a system-wide switch. Whether OpenCode and Codex read these files at the pinned versions is
taken from their docs and release binaries, not observed in a running image.
