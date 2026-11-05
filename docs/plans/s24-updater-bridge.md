# S24 updater bridge

Owner-approved prerequisite to S24, separate branch `s24-updater-bridge`.
Owner merges/releases/installs this before the SPA cutover; no compatibility services.

## Contract

Release metadata lists deduplicated pinned images derived from target Compose,
`dbCompatible`, and optional `minUpdater` (release version). Installed bridge code
checks its own bundle VERSION against minUpdater before any update side effect.
Missing requirement means legacy release; malformed metadata fails closed.
Image names must stay in the trusted Umiak GHCR namespace with the target tag
(or the pinned PostgreSQL Alpine image from Compose);
no commands or arbitrary download destinations from metadata.

Backup/restore/resume discovers services in the Compose it acts on. Stop/start
existing long-lived writers only, excluding Postgres and one-shots identified by service_completed_successfully
dependencies. Restart policy does not determine whether a service is a writer.
Restore discovers target writers before restoring source Compose and data.
Full DB/state backup, checksums, health gates and rollback contract stay intact.

Literal pre-bridge Python ignores minUpdater and cannot be fixed by target JSON.
Both supported installs must receive the bridge before cutover publication.
Clarification sent to master; do not claim old code enforces the new gate.

## Tasks and checks

- [x] Add failing metadata/image/minUpdater tests: old, equal, new, prerelease,
  missing metadata legacy fallback, malformed/foreign/unpinned image rejection.
- [x] Implement bundle metadata generation and validated Release readers; gate
  run_update using actual installed runtime VERSION before backend construction.
- [x] Add backup tests with removed web services and renamed writer, including
  forced restore and resume; implement Compose service discovery.
- [x] Replace hardcoded pre-pull with target metadata images; test exact pull list.
- [x] Run full installer pytest, Biome and diff checks; fresh branch review.
- [ ] Commit/push and report SHA/gates/limitations to master immediately.

Ruling: version for S24 minUpdater is the actual bridge release Ilia publishes;
do not invent a release version during implementation.

## Verification (2026-11-06)

- `mise exec -- uv run --directory deploy/installer pytest -q`: 295 passed.
- `mise exec -- pnpm lint`: passed, one pre-existing informational MCP lint.
- `git diff --check`: passed.
- Fresh independent review identified restart-policy writer classification as
  unsafe for services without restart. Fixed by classifying one-shots through
  completed-successfully dependencies; tests include default/no-restart writers.
- Tests exercise target-only pre-pull, real separate-process runtime VERSION gate,
  target-without-web restore ordering, DB/state restore commands, manifest
  validation and promotion repinning. Backup/host commands use local fakes here;
  bridge -> real S24 Docker stack/forced rollback remains S24 acceptance work.
- No Proxmox/dev-stand actions. No release published by this branch.
