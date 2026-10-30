# template-builder (`sbx-tpl`)

Builds Proxmox VM templates from the recipes in `infra/templates/` (spec: `docs/specs/s5-linux-template.md`,
plan: `docs/plans/s5-linux-template.md`). The build VM is driven only through the QEMU guest agent
(no SSH to the guest, no root SSH to the host).

## Prerequisites (operator's Mac or a Linux CI runner)

- Tools through mise (`mise exec -- node ...`); `xorriso` in `PATH` (macOS: `brew install xorriso`).
  `hdiutil` is not used: it shortens names with dots (`sudoers.d` became `sudoersd`).
- Host runbook steps done: `infra/pve/setup.sh media` (role `SbxTemplateMedia` on `/storage/local`) and
  `infra/pve/setup.sh node` (an `sbx-node` with `media.list`/`media.remove` and template origins in its range).
- The S1 client config (`SBX_PVE_URL`, `SBX_PVE_TLS_NAME`, `SBX_NODE_SSH_HOST`, `~/.config/sbx/`).
- VMIDs: a build takes the first free slot of its recipe (`vmids` in `template.yaml`: Linux 597 and 599,
  Windows 598) inside `SBX_TEMPLATE_VMID_RANGE` (default `597-599`); 599 is skipped while it is the PoC
  template (`SBX_TEMPLATE_VMID`). Sandboxes stay in `SBX_VMID_RANGE` (`500-589`). With one free Linux
  slot, `sbx-tpl retire <buildId> --delete-vm` the previous build (refused for the build the worker
  config uses and the newest ready one unless `--force`, for the PoC slot unless `--force-poc`).

## Build

```sh
export SBX_PVE_URL=https://100.64.10.2:8006 SBX_PVE_TLS_NAME=pve SBX_NODE_SSH_HOST=100.64.10.2
mise exec -- node apps/template-builder/src/main.ts preflight

# The agent package: the tunnel CA is a build parameter (one build = one tunnel CA bundle).
pkg=$(infra/templates/agent-package.sh --tunnel-ca ~/.config/sbx/dev-ca/ca.pem --out /tmp/sbx-agent-pkg)

mise exec -- node apps/template-builder/src/main.ts build linux --agent-package "$pkg"
# Dev stand: also check that a clone's agent connects to the dev gateway (CT 590).
#   --connect-url wss://tunnel.192-168-68-90.sslip.io/v1/connect --dev-cp-ssh sbx@192.168.68.90
```

Options: `--refresh` (run `versions --update` first, then commit `versions.toml`), `--tunnel-url` (a default
URL in `agent.toml`; without it the worker sets the URL per VM through `smbios1.family`), `--sbx-cli`,
`--api-url`, `--ssh-user-ca`, `--keep-on-failure`, `--no-verify`, `--fail-step <step>` (test flag).

A build takes about 10 minutes plus verify. Output: a Proxmox template VM `sbx-tpl-<slug>-<YYYYMMDD>-<n>`
(tag `sbx-tpl`, pool `sandbox`), the manifest in `~/.local/state/sbx/templates/<buildId>.json`
(`SBX_TEMPLATE_REGISTRY`), step logs in `build-logs/<buildId>/`, and the `sbx-admin template register`
line plus the `topology.templateBuilds` YAML for the worker.

Other commands: `versions <slug> [--update]`, `verify <buildId>`, `list`, `show <buildId> [--field f]`,
`show --active-vmid <slug>`, `cleanup` (failed build VMs, seed images, template leases; never a template).
`promote` and `gc` belong to S6 (`sbx-admin template promote`).

## How a build runs

1. Verify the agent package (ed25519 over `manifest.json`, file sha256s, strict tar parsing) and fetch the
   Ubuntu minimal image (signed `SHA256SUMS`, pinned key fingerprint, sha256 from `versions.toml`).
2. Upload the image to `local:import` once per serial; render the NoCloud seed (`cidata`) and upload it as
   `local:import/sbx-seed-<buildId>.raw`.
3. Create the build VM: `scsi0` imported from the image, the seed as disk `scsi1` (the first boot of the
   cloud image has no initrd, so CD drivers load after cloud-init looks for its seed), `smbios1` serial
   `ds=nocloud`. Tags are set right after the create call (Proxmox checks tags on `/vms/<id>` without the pool).
4. Run the steps as transient systemd units (`systemd-run`), tailing `/var/log/sbx-build/<step>.log` by
   byte offset through `agent/file-read`; `reboot` after `00-base`.
5. Record the facts (packages, tool versions), write `/etc/sbx-template/build.json`, drop the build logs and
   the random seed, `sbx-agent seal`, zero-fill free space, `fstrim`, power off.
6. Remove the seed disk and `smbios1`, drop the build VM's firewall config, convert to a template.
7. Verify (spec section 10): a clone with a test smbios, `verify.sh` through stdin, `sbx-agent doctor`, tools,
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
