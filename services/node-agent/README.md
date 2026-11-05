# Restricted node agent (`umiak-node`)

The [Proxmox installer](../../docs/getting-started.md#install-on-proxmox) owns host
preparation, the forced-command SSH key, binary and `/etc/umiak-node.toml`.
Added sandbox nodes are prepared through the [installer node console](../../docs/operations-multi-node.md).
There is no separate host setup script. Existing installs need no migration.

## Command reference

`umiak-node --stdio` reads a JSON request from stdin and writes a JSON response
with `ok` and either `result` or `error`. The restricted SSH transport uses this
protocol; it does not expose an unrestricted host shell. For example, the
read-only request `{"op":"media.list","args":{}}` lists builder media.

- `media.list` lists managed builder ISOs and imported images. `media.remove`
  with `{"names":["<managed filename>"]}` removes only matching regular files,
  never paths or symlinks. The user's Windows ISO is excluded from removal.
- `media.sha256` with `{"name":"<file>.iso"}` hashes a regular ISO directly in
  `isoDir`, including the user's Windows ISO. No paths or symlinks are accepted.
  Digests are cached by name, size and mtime in `<stateDir>/media-sha256.json`.
- `lv.usage` and `lv.scan` inspect only allowed template and sandbox disks.
  Template origins must be `base-<id>-*` disks in the configured template range
  with the `umiak-tpl` tag. Sandbox disks must have the `umiak` and
  `umiak-vm-<id>` tags and belong to the configured sandbox range.
- `lv.tagTemplate` with `{"vmid":<id>}` tags disks only for a configured template
  slot whose Proxmox config has `template: 1` and the `umiak-tpl` tag.
- `lv.adopt` with `{"vmid":<id>}` tags attached Proxmox-allocated sandbox disks
  (such as a Windows clone's fresh TPM state). It requires a sandbox VMID and a
  non-template config tagged `umiak`; it excludes `unusedN`, base/snapshot LVs,
  other VMIDs and template-tagged LVs. The result has `tagged` and `already` lists.

Media directories come from `isoDir` and `importDir`; `stateDir` defaults to
`/var/lib/umiak-node`. VMID bounds come from the installed config, not fixed dev
slots. New installs default to sandboxes 10000–19999 and templates 20000–20099,
with `templateVmid = 0` (no legacy reservation).

The complete operation whitelist is in [dispatch.go](internal/ops/dispatch.go).
