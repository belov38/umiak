# Release channels implementation plan

**Goal:** autonomous host-owned updates with shared stable/edge platform and recipe selection.
**Architecture:** stdlib Python installer and systemd own privileged actions; owner settings are bounded JSON, consumed by the host. Existing quickstart/Postgres serialize build fences.
**Tech stack:** Python, systemd, Docker Compose, Node quickstart, React Settings, manual GitHub Actions.
**Spec:** docs/specs/s22-release-channels.md

## Global constraints

Exactly stable and edge; no root authority in control plane; no live host tests;
manual workflows only; mise toolchain; existing installs stable/off, new stable/on.

## Review focus

- Partial backup/update and process death must leave a recoverable checkpoint.
- A build starting after a busy check must be fenced out.
- Edge listing can be paginated, unordered, and include unrelated prereleases.
- Database restoration must not reuse newer mutable state or silently lose data.
- Old bundles/images and installer migration must remain usable for recovery.

## Phases

- [x] Release primitives: test channel semver resolution; implement saved channel,
  bootstrap selection and workflow validation/promotion with digest preservation.
  Run installer tests and workflow validation; commit, rebase, fast-forward main.
- [x] Update transaction: fake-runner tests for lock/window/fence/backup/retention/
  both rollback modes; implement host updater, persistent checkpoints, systemd
  install/removal and shared manual path. Run installer and quickstart tests;
  commit, rebase, fast-forward main.
- [x] Owner Settings: test authorization/input validation and host console; expose
  version/channel/dev notice, auto/notify, pause/window/history. Rebase and reuse
  signed recipe channel primitives. Run affected TS/Node checks and installer
  suite; commit, rebase, fast-forward main.
- [x] Documentation and final verification: README line, getting-started update
  section and live checklist. Review complete diff, run required checks; commit,
  rebase onto current main, fast-forward push; report exact SHA and remaining
  acceptance work.


## Execution notes

Implemented inline, without additional subagents. Each phase was committed,
rebased onto origin/main, and pushed by fast-forward. Reused the parallel signed
recipe channel's `state.platform.channel` and its rollout/verification primitives.
Rulings: pre-pull images before fencing; missing DB marker means full restore;
keep a failed release quarantined until manual retry or a newer release, avoiding
repeated automatic rollback and data loss. The target installer, not the old
running package, becomes the timer runtime. Root-only backup archives are verified
before destructive restoration and state ownership is restored numerically.

Live acceptance belongs to the owner; no PVE host or CT was accessed.
