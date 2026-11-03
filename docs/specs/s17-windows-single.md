# S17: one Windows template

Decision: Ilia, 2026-11-03. Supersedes the separate Windows catalog/recipe
rulings in S9/S10; Linux retains `linux` and `linux-desktop`.

## Rulings

- The canonical public slug is `windows`, named **Windows 11**. It includes
  exec, files, ssh and desktop; sizes are `4gb` (default) and `8gb`.
  Setup and Templates present it as **Windows 11 (with desktop)**.
- `windows-desktop` is an input compatibility alias. API responses use
  `windows`, including listings and snapshot metadata. The alias is never a
  separate catalog choice. CLI, SDKs and MCP accept it through the API.
- Existing sandboxes and saved snapshots retain their exact build version.
  The headless VM 598 build is inactive for new creates, but remains resolvable
  for resume/fork/delete. No guest is converted or rebuilt.
- On the dev stand the desktop build `20261101.7` on VM 595 becomes the active
  Windows build. Migration preserves references before removing the old catalog
  choice; fresh installations do not invent a locally available PVE build.
- The Windows recipe incorporates the former desktop steps and verification,
  retaining shared `_windows` installation steps and the S16 ISO URL flow.
  Streamer services remain Manual and start on first desktop open.
- Desktop startup retains HTTP 503, `desktop_starting`, Retry-After and the
  five-second refresh contract. HTML says “Starting the desktop…” and “This
  takes up to a minute.” It uses dashboard brand colors in light/dark mode,
  an accessible spinner, reduced-motion support and no external assets.
- VM 598 is read-only and remains on PVE. Reclaiming it requires Ilia's explicit
  approval. No template rebuilds, ISO downloads, network or firewall changes.
- Deployment must preserve owner sessions and guest CA, include current main,
  and occur only after checking CT590/origin and active operations.

## Upgrade ordering and legacy UI

Compose runs runtime bootstrap before Payload migrations. Bootstrap recognizes
an existing `windows-desktop` build by node, version and VMID and reuses its ID;
Payload performs the identity change after retiring the headless build. The
migration also handles custom desktop versions/slots and duplicate historical
registrations without activating two builds on a node. It never deletes builds.
The down migration is intentionally a no-op: restore the previous application,
config and catalog backup together for a full rollback.

A legacy VM 598 sandbox has no desktop endpoint or Desktop tab, even though its
canonical catalog identity is now `windows`; its original disk/build is retained.

The deployed tree also includes owner-signin commits `74a35b17` and `e96b5efa`
(cherry-picked), to preserve the parallel feature on CT590.
