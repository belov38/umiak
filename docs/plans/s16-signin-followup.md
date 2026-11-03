# S16 sign-in follow-up implementation and evidence

User authorized autonomous implementation, rulings and state-preserving CT590
redeployment, with no additional design/start approval. Spec:
`docs/specs/s16-quickstart.md`, sign-in follow-up rulings.

- [x] Reproduce owner-write regression and source-state growth with failing tests.
- [x] Move source buckets into bounded process memory; coalesce last-use writes.
- [x] Cover HTTP errors, JSON gate, session revocation and console capacity.
- [x] Add PATH wrapper, terminal-safe audit routing, sessions UI and docs.
- [x] Exercise pairing continuation, rate feedback and current-browser UI.
- [x] Complete sequential gate and record measurements.
- [x] Recheck PVE operations, deploy and compare session hashes; anonymous check.
- [x] Commit logical changes and push signin-followup; do not merge.

Review focus: legacy source JSON removal preserves sessions; concurrent code use
remains atomic; capacity retains existing source buckets; pairing URL survives
sign-in; console help and capacity errors never mint extra codes.

## Measurements and checks

On an isolated Postgres 18.6 container (`signin-perf-1103`), 1,000 sequential
`authenticate` + `touch` calls with 10,000 source buckets took **56,706 ms before**
and **551 ms after**. Owner-row mutation transactions: **1,000 → 0**. This measures
the storage path, excluding HTTP overhead; it is separate from acceptance's
40.9 s HTTP measurement. The before harness loads the original owner module from
`f5189e1c`; after uses process-memory buckets. The regression also exercises a full
legacy persisted map and minute-boundary writes. Temporary perf stack removed.

- `pnpm build`, `pnpm lint`, `pnpm typecheck`, e2e typecheck: PASS.
- `pnpm -r --workspace-concurrency=1 test`: 4,609 TS tests passed, 8 skipped;
  Python SDK ruff/format and 83 pytest tests passed.
- `node --test --test-concurrency=1` quickstart/local/meta-proxy: 169/169 PASS,
  including both compiled CLI HTTP/HTTPS paths.
- Shellcheck: PATH wrapper, installer, deploy-quickstart and quickstart-preflight
  PASS. The later Windows scope changes gateway Go; its complete gate is recorded below.
- Initial OIDC run: 26/27. The stopped Desktop visual fixture supplied a template
  name but omitted `endpoints.desktop`, now required by the inherited
  windows-single capability contract. Corrected only the test response.
- Corrected OIDC rerun: 27/27 PASS, project `signin-oidc-1103`.
- Local Playwright: 2/2 PASS, unique project `signin-local-1103`.

- Quickstart Playwright: PASS, including short command, 429 minutes, current
  browser, pairing continuation, prominent code, expiry countdown and copy. The
  added copy check first exposed Clipboard API denial without fallback. Added
  execCommand fallback on denial and verified the same browser check passes.
- E2E images used unique `umiak-signin-*:1103` tags. Both stacks were torn down
  with their own volumes; unrelated projects were left alone.

## CT590 evidence

Read-only `qm list` found no sandbox VM 500–589. An initial attempt to query
cluster tasks with `--running` was rejected by PVE; before service restart,
`pvesh get /nodes/pve/tasks --source active --output-format json` returned `[]`.
Used `infra/dev-cp/deploy-quickstart.sh`; existing guest certificate checksums
passed. The exact sessions-object MD5 before and after was identical:
`8d3e6737b41455a46e2ad1305c5cd4f2`.

From the SSH login directory, without Compose files or env-file flags:
`docker compose -p umiak exec -T quickstart umiak-signin --help` printed usage.
No real code was issued; no live sign-in, claim, recovery or pairing was performed.
A fresh incognito preview at `http://192.168.68.90:4180/owner/sessions` showed
Sign in, no dashboard navigation, and `docker compose exec quickstart umiak-signin`.
Closed the preview tab afterward. No PVE mutations or firewall/network changes.

Final operator command, valid from any directory on CT590:

```sh
docker compose -p umiak exec quickstart umiak-signin
```

## Screenshots outside git

Directory: `/tmp/umiak-signin-followup-20261103/`. `*-light.png` and `*-dark.png`
are 1440 px wide; `*-light-390.png` and `*-dark-390.png` are 390 px wide.
The fixture uses synthetic sessions, never the stand's owner credentials.

- `/tmp/umiak-signin-followup-20261103/claim-light.png`
- `/tmp/umiak-signin-followup-20261103/claim-light-390.png`
- `/tmp/umiak-signin-followup-20261103/claim-dark.png`
- `/tmp/umiak-signin-followup-20261103/claim-dark-390.png`
- `/tmp/umiak-signin-followup-20261103/signin-light.png`
- `/tmp/umiak-signin-followup-20261103/signin-light-390.png`
- `/tmp/umiak-signin-followup-20261103/signin-dark.png`
- `/tmp/umiak-signin-followup-20261103/signin-dark-390.png`
- `/tmp/umiak-signin-followup-20261103/pair-approve-light.png`
- `/tmp/umiak-signin-followup-20261103/pair-approve-light-390.png`
- `/tmp/umiak-signin-followup-20261103/pair-approve-dark.png`
- `/tmp/umiak-signin-followup-20261103/pair-approve-dark-390.png`
- `/tmp/umiak-signin-followup-20261103/sessions-light.png`
- `/tmp/umiak-signin-followup-20261103/sessions-light-390.png`
- `/tmp/umiak-signin-followup-20261103/sessions-dark.png`
- `/tmp/umiak-signin-followup-20261103/sessions-dark-390.png`
- `/tmp/umiak-signin-followup-20261103/setup-light.png`
- `/tmp/umiak-signin-followup-20261103/setup-light-390.png`
- `/tmp/umiak-signin-followup-20261103/setup-dark.png`
- `/tmp/umiak-signin-followup-20261103/setup-dark-390.png`

## Windows acceptance scope addition

B1 is fixed in its own commit and a full OIDC rerun passed 27/27 before the
remaining Windows changes. S1 alias and catalog-name regressions passed 37 focused
web tests. S2 covers a custom headless build on slot 600 and a modern desktop on
598 in API and migration tests. S3 covers detection plus registration of a
headless deprecated build. S4 covers enabled combinations, custom names, merged
size policy, unset policy and preserving the newer active image; 32 focused
Payload migration tests passed. See S17 acceptance follow-up rulings.

Cheap lows are included: catalog name, request ID, shared SVG mark, retired and
headless artifact deletion guard, and OpenAPI alias documentation with Python SDK
regeneration. A builder parallel run hit one existing Windows CD timeout; its
focused rerun and full 597-test run with two workers passed. One local migration
run was interrupted when Docker Desktop stopped; after restarting Docker, the
real failing regressions and green fixes were rechecked. No live PVE writes.

## Final expanded live verification

Before the last deployment, PVE active tasks were `[]` and no sandbox VM existed
in 500–589. CT590 had already applied the pre-release consolidation. A guarded
metadata-only transaction initialized the new column, classifying the verified
original build IDs (`.2` headless/retired; `.7` desktop/active); Linux flags were
set false. It did not change catalog settings, VM objects, snapshots or owner
state. The schema migration is additive and records its checksum normally.

Final `deploy-quickstart.sh` completed; guest CA and both leaf hashes passed.
The complete sessions JSON MD5 was identical before/after:
`7a90f0dfafbbabc2d7692364c9e337e3`. The additional fingerprint excluding
`lastUsed` also matched (`4c549392fd902c5cf5ad821094f3f8a2`); all four sessions
survived. The earlier sign-in-only checkpoint used the hash recorded above;
normal owner use between checkpoints changed last-use metadata.

`docker compose -p umiak exec -T quickstart umiak-signin --help` passed from the
SSH login directory. Fresh incognito `/owner/sessions` showed Sign in and the
short command without owner navigation; the tab was closed. No real live code,
login, claim, recovery or pairing was issued/performed.

Go build/vet/test (`-p 1`)/golangci-lint passed for all five workspace modules.
The first expanded TS run found a pinned migration-list expectation; it now
checks the namespace migration without forbidding later migrations. The next
run exposed the legacy worker fixture being built with the new column default;
it now upgrades a real pre-0501 schema before asserting build/snapshot identity.
Its focused regression passed before the final complete rerun.

Both generated SDKs were refreshed after the OpenAPI alias-description change.
The TypeScript SDK freshness test caught its old generated comment, which was
then regenerated before the complete rerun. Audit routing was also exercised in
an isolated Linux Node container as user `node`: `/proc/1/fd/1` reached container
logs and the exec terminal output was exactly zero bytes; that project was removed.

Final verification logs outside git use `/tmp/followup-`: `build.log`, `lint.log`,
`types-final.log`, `e2e-types.log`, `go.log`, `shellcheck.log`, `tests4.log`,
`node.log`, `ui.log`, `oidc.log`, `local.log`, `deploy.log`, `live-help.log`,
`sessions-before.log`, `sessions-after.log`, and `session-identities-after.log`.
The measurement harness and JSON output are `/tmp/signin-perf.mjs` and
`/tmp/signin-perf.log`; the source module used for the before measurement was
saved from the branch base before any sign-in edits.

Final expanded complete workspace run (`--workspace-concurrency=1 --no-bail`):
**4,628 TS tests passed, 8 skipped**, plus **83 Python tests**, ruff and generated
client freshness. Final Node suite: **170/170**, including compiled CLI. Final
quickstart UI: **1/1**, with a forced Clipboard API rejection and successful real
execCommand fallback. All 20 listed PNG files were checked for the requested
1440/390 widths; no live-owner screenshots or code material were captured.

Final expanded Playwright: **OIDC 27/27**, **local 2/2**, quickstart fixture
**1/1**. Unique test projects and their volumes/networks were removed afterward.
Final lint has only the pre-existing MCP String.raw informational notice. Live
migration journal confirms `0501_template_build_headless.sql`. All requested
items are committed separately by logical scope; no main merge was performed.
