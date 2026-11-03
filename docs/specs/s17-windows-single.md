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

## Validation (2026-11-03)

- Build, lint, typecheck passed after including owner-signin. Sequential workspace
  suites passed; MCP's changed descriptions required refreshing its golden list
  and compacting copy to retain the fixed tools/list budget (715 passed, 1 skipped).
  Worker/Payload upgrade-order regressions passed (15 and 23 tests).
- Node quickstart/local/meta-proxy: 162 passed; Python SDK: 83 passed;
  gateway build/vet/test/golangci-lint: passed, 0 lint issues; shellcheck passed.
- Playwright: OIDC 27 passed, local 2 passed, quickstart UI passed.
  Initial isolated runs hit occupied default ports / mismatched configured API
  URL; reruns used a unique project and consistent alternate API/host ports.
- CT590 deployed with `infra/dev-cp/deploy-quickstart.sh` after owner-signin's done
  notice. Read-only PVE inventory and runtime operations were idle before deploy.
  Catalog: linux, linux-desktop, windows. Windows `.7`/595 active, `.2`/598 retired.
  Guest gateway certificate checksums retained. All four owner sessions retained:
  excluding the CLI-updated `lastUsed`, sessions MD5 stayed
  `4c549392fd902c5cf5ad821094f3f8a2`.
- Live CLI `create --template windows-desktop --size 4gb` created exactly one
  sandbox (`windows-single-check`, VM500): canonical windows `.7`, ready in
  124.775 seconds. First desktop navigation showed the friendly HTTP503 loading
  page and automatically advanced to a real Windows desktop stream.
  `umiak rm windows-single-check --yes` completed; DB state deleted and VM500 gone.
  No other sandbox was deleted; VM598 remains present and unchanged.
- Screenshot artifacts (local, outside git):
  `/tmp/windows-single-visuals/desktop-starting-light.png`,
  `/tmp/windows-single-visuals/desktop-starting-dark.png`,
  `/tmp/windows-single-visuals/live-desktop-starting.png`,
  `/tmp/windows-single-visuals/live-desktop-ready.png`.

### Acceptance follow-up rulings (2026-11-03)

- A build carries `runtime.template_builds.headless`. Existing rows start NULL;
  new registrations default false because current Windows recipes include desktop.
  Before rekeying, the consolidation migration snapshots every original Windows
  headless identity as true and the old desktop identity as false. Only true
  builds retire. Replay never reclassifies a previously snapshotted build.
- API capability and preview admission use the build flag, independent of slot.
  An unclassified legacy Windows build is conservatively headless until its
  original metadata has been verified. Quickstart excludes headless/unknown
  Windows records from both detection and registration, including deprecated ones.
- The consolidated enabled flag is the OR of both old flags. Keep a customized
  canonical name; otherwise use the desktop name. Union both allowed-size lists
  and the selected default; prefer the desktop default when set, then canonical.
  Fallback 4gb/8gb applies only to unset size policies. Never revive an inactive
  historical build. If duplicate desktop identities are active on one node,
  preserve the newest active build and deprecate the other before rekeying.
- Pre-release stands that already ran the faulty consolidation have lost the old
  slug distinction. Do not infer it from VMID or re-run catalog conversion.
  Classify those build IDs from verified original artifact metadata before
  upgrading. On CT590 read-only PVE names identify `.7` as desktop and `.2` as
  headless; record only the corresponding build flags, preserving owner sessions.
- Legacy prefill accepts `windows-desktop`; catalog headings use operator names.
  The OIDC visual fixture supplies an explicit desktop endpoint, matching the
  production capability contract. Retired/headless artifact deletion requires
  explicit force, regardless of VMID. Starting pages retain the request ID and
  shared brand mark.

### Windows follow-up rulings (2026-11-04)

- New Windows desktop artifacts carry `desktopMarker: "umiak-desktop"` in
  their manifest and `umiak-desktop` in PVE tags. Names and absent runtime rows
  never establish desktop capability. Adoption checks PVE evidence even on an
  empty database, and checks again at registration; retired/headless DB guards
  still apply independently.
- Unmarked legacy artifacts may be adopted only with a ready, verified manifest
  in `/pve-secrets/template-registry/<buildId>.json`. The PVE description build ID,
  node, VMID and exact VM name must match. Legacy verification must include PASS
  for `desktop_sunshine`, `desktop_display` and `desktop_agent_config`. Missing,
  invalid or mismatched evidence fails closed. This supports VM595 from its
  original `.7` manifest without changing PVE; VM598 has no desktop checks.
- Retire uses the same manifest marker for Windows; Linux desktop pins are not
  a Windows capability flag. Configured/newest/slot guards remain independent.
- Bootstrap rejects a newly inserted Windows build without `desktopMarker` once
  runtime 0501 exists. Operators must verify the artifact before adding the
  explicit marker to topology config. Existing build identities and pre-0501
  upgrade ordering remain intact.
- Normalize shipped Windows names (`windows`, `windows-desktop`, `Windows 11
  Desktop`, `Windows 11`) to `Windows 11`; preserve operator names, including a
  custom old desktop name. A forward migration handles already consolidated DBs.
  Templates continues to display the catalog name.
- A console sign-in that issues no code exits 2. Sign-in commands wrap and their
  copy button occupies a separate line, including at 390px.

### Follow-up validation (2026-11-04)

- Final build, lint and typecheck passed. Node quickstart/local/meta-proxy:
  175 passed. Playwright OIDC: 27 passed; local: 2 passed; quickstart UI passed,
  including a 390px command/button geometry assertion. Screenshot inspected:
  `/tmp/windows-followup-visuals/signin-dark-390.png` (outside git).
- Regression suites: template-builder 597, Payload 220, worker 426 passed
  (7 pre-existing skips). Python SDK: 83 passed plus Ruff checks. No Go touched.
- Raw shellcheck reports existing main-branch SC1091/SC2155/SC2012 diagnostics
  in dev-cp helper scripts and the Linux verification script. The same inputs
  pass with those baseline diagnostics excluded. No shell scripts changed.
- Deployed with `infra/dev-cp/deploy-quickstart.sh` after read-only checks found
  no active PVE task or unfinished runtime operation; all sandboxes were deleted.
  Gateway CA/certificate checksums passed the deployment script's preservation check.
- The original verified manifests of 595 and 598 were copied only into CT590's
  private `/home/umiak/.config/umiak/template-registry`; no PVE tags/config changed.
  Real PVE GETs classify 595 desktop and 598 headless. Running wizard detection
  against those two VMs with an empty runtime-query fixture offers only 595.
- Live Templates browser check displays `Windows 11`, active `.7`, VM595.
  It used a temporary deployment-owner session (`local@umiak.invalid`), then
  revoked only that session; never authenticated as `ilia@example.com`.
  All four original sessions retain exact JSON MD5
  `7a90f0dfafbbabc2d7692364c9e337e3` before/after (excluding `lastUsed`:
  `4c549392fd902c5cf5ad821094f3f8a2`). Config SHA256 for each of VM595–598
  matches before/after. No PVE guest, tag, configuration or sandbox was created.
- Final full workspace rerun (`pnpm -r --workspace-concurrency=1 --no-bail test`)
  exited 0: 4634 Vitest tests passed, 8 skipped, plus Python SDK 83 passed.
