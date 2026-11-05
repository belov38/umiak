# S22: release channels and host-owned platform updates

## Intent and constraints

Umiak maintains its platform and template recipes through exactly two channels:
`stable` (default) and `edge`. No control-plane component gains host root or a
host command API. Workflows remain manual (`workflow_dispatch`). Live PVE nodes
and CT 590 are out of scope for implementation testing.

## Decisions

- Stable versions are X.Y.Z; edge versions X.Y.Z-edge.YYYYMMDD.N. Stable uses
  GitHub latest; edge selects the greatest semantic version among published edge
  prereleases and stable releases (stable outranks an edge of the same base).
- Promotion retags the existing image digests; it must not rebuild images. The
  installer bundle is repackaged with the stable version and checksums.
- New installs default to stable/automatic; legacy state defaults to stable/off
  and shows a one-line availability hint. The owner confirmed this migration.
- The platform channel also selects the signed recipe channel. Reuse the
  parallel recipe rollout's verification/activation primitives after rebasing;
  do not create a second template rollout engine.
- Settings controls channel, automatic/notify-only, pause and local host-time
  maintenance window (default 03:00–04:00). The host reads bounded declarative
  data through its own pct console, never commands/URLs supplied by the web.
- A host systemd timer polls settings. Every installer action holds a host lock;
  updates skip active template builds. The control plane must hold a durable
  maintenance fence before the host proceeds, preventing new builds.
- Every update, manual or automatic, takes a pre-update logical Postgres dump
  plus the small state volumes and compose configuration. Writers are stopped
  during the snapshot; VM guests are never stopped. Keep the last three complete
  backups, tagged with source release. Backup failure/insufficient space aborts
  before applying the release. Gateway interruption is control-plane downtime.
- Each release declares database compatibility. Compatible failures restore old
  images; incompatible (or undeclared) failures restore the pre-update DB and
  state volumes too. Record data loss since backup explicitly in update history.
  The owner requires autonomous updates even across incompatible migrations.
- History exposes updated/rolled-back/failed/available/skipped with source and
  target release, backup identity, reason and timestamps. Unknown/untrusted data
  cannot alter host paths, commands or destinations.
- Running version/channel and a dev-<sha> replacement warning are visible in the
  installer header and Settings. Pause is explicit; edge-to-stable may require
  a deliberate channel switch to a lower version.

## Approaches

The selected approach is host pull using systemd and a constrained pct console.
Giving the control plane root SSH conflicts with the established security model.
A control-plane updater cannot update host-managed binaries safely. A separate
root HTTP agent would add an unnecessary privileged network surface.

## Acceptance

Channel resolution/order/pagination, immutable promotion, legacy defaults, lock
contention, windows crossing midnight, build fencing, backup failures, retention,
image-only and full restore rollback, restart/crash recovery, owner-only settings
and invalid inputs are tested without live hosts. The owner performs live
acceptance. Never claim successful rollback until health passes on the old stack.
