# S24: static SPA and API-owned configuration

Status: approved by owner/master on 2026-11-06. Branch: `s24-spa`.
Prerequisite: separate `s24-updater-bridge`, released and installed before cutover.
Supersedes the Next.js/Payload implementation in S8. Depends on S7/S8/S18/S20/S22.

## Intent

Remove Next.js and Payload from build and runtime while preserving existing
configuration, owner identity and public sandbox APIs. Keep TypeScript Hono +
zod-openapi in `apps/api`, pg-boss in `apps/worker`, React 19, existing
Radix/Tailwind/cva/lucide components, xterm.js, sonner and `@umiak/sdk` in web.
No new identity system, Go changes, warm-pool implementation or live stand access.
Use `mise exec --`; secrets remain files; CI remains manual-only.

## Current implementation

- `packages/payload` owns eight collections and `platform-defaults`. Identity
  reads already use SQL, but writes use Local API and hooks. API/worker instantiate
  Payload and gate readiness on a second migration system.
- ConfigReader uses 5-second list/quota caches, NOTIFY invalidation and cache
  clearing on reconnect. Policy defaults are uncached to avoid gateway races.
- Payload local authentication is disabled: quickstart owns browser sessions,
  CLI pairing and stable owner identity. There are no Payload auth sessions to
  translate. Preserve quickstart state volumes and owner credentials unchanged.
- Next actions implement default-team selection, team/membership management and
  template enablement. Admin additionally exposes catalog/default/quota edits.
- Quickstart routes `/api/*` to API's browser listener, `/v1/*` to its public
  listener, `/mcp` to MCP, other app paths to `web:3000`. It owns TLS ingress,
  setup, claim, signin and desktop proxying.
- S22's concrete declaration is `release.json` with `dbCompatible: boolean`.
  The bundle builder defaults false; manual release input is `db_compatible`.

## Approaches

**Recommend API static serving.** Build Vite output into the shared quickstart
image and serve through Hono behind the current ingress. Remove `web` and
`web-migrate`, their network/secret mounts and separate web image publication.
No extra HTTP process is necessary. Gateway serving adds Go/static packaging work
and couples application delivery to the tunnel/preview data plane. A dedicated
static server keeps an avoidable container/image. Owner approved API delivery; gateway/static-server alternatives were rejected.

## Storage and API ownership

Create `runtime.users`, `teams`, `memberships`, `api_keys`, `ssh_keys`, `templates`,
`sizes`, `pool_targets`, `platform_defaults`. Reserve SQL range `0800–0899` for
S24 in the roadmap. Use the existing SQL journal, checksum enforcement, advisory
lock and one Compose `migrate` job. Never rewrite applied migrations.

API owns configuration mutations/validation. Shared pg identity adapter lives
in `packages/auth`; pg configuration reader lives in `packages/config`; schema
metadata and migration runner remain in `packages/db`. Worker uses shared readers
directly, without importing the API app or depending on an HTTP round trip.
The historical `identity` stand-in schema is not an active second source.

Preserve IdentityStore/ConfigReader contracts, public ID codecs, UUIDs, nullable
quota inheritance, zero quotas for missing teams, catalog ordering, uncached
policy defaults and reconnect invalidation. Transfer hooks to SQL triggers and
transactional API services. Preserve channel/message formats for
`umiak_identity`, `umiak_config`, `umiak_routes`, `umiak_ssh_revoke`, commit-only
delivery and bookkeeping-only update silence. Rotation/revocation must still
invalidate consumers. Preserve personal-team/last-owner rules, immutable slugs,
size references, guarded team deletion and unique fingerprints/key hashes.

## Public OpenAPI surface

Reuse existing `/v1/me`, catalog, API/SSH keys, environments and sandbox endpoints.
Add these documented zod-openapi routes using existing errors/public IDs:

| Route | Responsibility |
|---|---|
| `GET /v1/settings/session` | User, teams with personal flag, default team for SPA shell |
| `PATCH /v1/settings/account` | Default team with membership validation |
| `GET, POST /v1/settings/teams` | Owner workspace list/create |
| `GET, PATCH, DELETE /v1/settings/teams/{teamId}` | Name/quota; runtime-guarded deletion |
| `GET, POST /v1/settings/templates` | Full catalog config list/create |
| `PATCH, DELETE /v1/settings/templates/{slug}` | Validated edits/guarded deletion |
| `GET, POST /v1/settings/sizes` | Full size config list/create |
| `PATCH, DELETE /v1/settings/sizes/{slug}` | Validated edits/guarded deletion |
| `GET, PUT /v1/settings/platform-defaults` | Global settings |
| `GET, PUT /v1/settings/pool-targets` | Stored targets; does not implement warm pools |

All settings routes require owner session/operator authority. Team API keys,
including all-scope keys, cannot use them. Paired CLI owner sessions intentionally
have the same settings authority as the owner browser; this is an owner API,
not a browser-only authority. Existing scoped public catalog reads
stay unchanged. Apply strict schemas, body limits, host/peer and Origin checks;
do not trust JSON role flags. Never expose hashes; plaintext keys remain one-time
issuance responses. Regenerate committed OpenAPI and both SDKs; test CLI/MCP.

## SPA behavior and delivery

Use Vite + React 19 + TanStack Router/Query. Registry observations on 2026-11-06:
Vite 8.3.6, React Vite plugin 6.2.1, Router 1.170.46, Query 5.106.1. Recheck
`npm view <pkg> version` before adding dependencies; pin stable versions.

Preserve `/app`, team-scoped sandbox/key/environment/snapshot URLs, template build
status, getting-started, settings, appearance, terminal reconnect and desktop
iframe. Session becomes a query with explicit loading/error states. Replace Next
navigation/dynamic/fonts with Router, React lazy and bundled fonts. Query keys
include team IDs; team switches discard prior team data. Mutations invalidate
affected queries. One-time key secrets never enter persistent storage/query cache.

Settings replace owner-facing admin: templates, sizes, defaults, quotas, keys,
stored pool targets. `/admin` redirects to `/app/settings`; recognized former
collection/global deep links redirect to the matching settings section. Unknown
CMS paths return 404/410. Drop invitation/member-role editing, user provisioning,
operator cross-user sandbox/blocking screens. Keep owner workspaces (create,
rename, select default, guarded delete). Preserve legacy user/membership records
and key authorization effects even though their management screens disappear.

Mount static delivery on `createProxiedApp` only. Preserve
`/api/v1/* -> :8081/v1/*` and `/v1/* -> :8080/v1/*`. Quickstart must authenticate
application and asset requests before proxying; peer admission alone is not a
replacement for owner ingress authentication. Test requests through actual ingress.
Serve built assets only from API's browser/application listener, never internal
or ops listeners. Explicit app GET/HEAD routes use index fallback. API routes,
unknown assets, traversal/encoded traversal and unsafe methods never fall back
to HTML. Correct MIME, hashed immutable asset caching, no-cache HTML, security
headers and desktop frame origins are required. Production script CSP needs
only self; retain styling support required by existing components. Static build
contains no backend secrets or database URLs. Quickstart changes its app upstream
to API; TLS/auth/desktop boundaries stay intact.

Remove Next actions, Payload REST/admin/import map/instrumentation and production
dependencies on `next`, `payload`, `@payloadcms/*`, `graphql`, `server-only`.
Remove `packages/payload` after moving relevant contract coverage.

## Setup wizard scope

Owner decision: **follow-up S24b**. Keep
`deploy/compose/quickstart/setup-ui.mjs`, claim/signin/pairing/recovery HTML.
They work before app readiness and manage host setup/recovery; moving them adds
onboarding risk without helping Payload removal. S24 updates broken links and
upstreams and proves setup can reach the new dashboard.

## Data migration and upgrades

`0800_api_configuration.sql` creates owned tables;
`0801_import_payload.sql` imports source data transactionally. A subsequent
`0802_pending_catalog_changes.sql` translates pending source data migrations:
in particular, the checked-in Debian deferral removes its pool targets/catalog
entry, resets a Debian default to Linux and retires matching builds. Test both
the published source with Debian and already-updated sources; preserve unrelated
operator edits. Support the
owner-only source release `0.4.0-edge.20261105.3` and later checked-in catalog
migrations by recognizing schema shapes, not requiring the latest Payload entry.
An existing unsupported/incomplete source fails with an actionable error; it
must never be treated as a fresh install and seeded over.

Copy all eight collections and the global, including owner subject and
personal/default team pointers, all memberships, hashes/scopes/audit/revocation
timestamps, SSH keys/fingerprints, template operator edits, sizes, pool targets,
nullable retention and quota fields. Use explicit mappings and enum conversion,
dependency-ordered inserts and deferred cyclic references. Preserve UUIDs and
runtime references. Validate row counts, relationships and hash equality before
commit. Conflicting target rows fail rather than conflict-ignore. Migration
journal makes successful import one-time; interruption rolls back import and
journal entry. Fresh seeds run only without legacy source. Identity YAML and
startup seeding must never overwrite imported edits.

Leave `payload` **unused** for this release; no runtime reads, views, dual writes
or migrations against it. Keep old schema/legacy secret files for inspection
until separate cleanup. Remove secret generation and every active consumer.
This still requires incompatible rollback because new writes diverge.

**S22 declaration: `release.json` contains `{"dbCompatible":false}`.** Prevent
accidentally marking the cutover release compatible in its release workflow.
Updater pre-pulls, fences maintenance, stops writers and backs up DB/state/config
before migration. Migration/health failure restores old images AND that backup.
Only report successful rollback after old health passes; record any data loss
since backup. No reverse SQL shortcut or updater bypass. Test locally; owner
performs live acceptance. No Proxmox hosts, pve/pve2 or CT590 access in this scope.

## Acceptance and build measurements

Record evidence in `docs/plans/s24-spa-no-payload-acceptance.md`: source/target SHA,
commands, image digests, machine/platform/CPU/RAM and cache mode. Measure baseline
before product edits and after on the same platform: wall build seconds, whole
build cgroup `memory.peak` (not Docker CLI RSS), uncompressed image bytes and
compressed transfer size if measured. Use cold build cache with warmed downloads
and disclose failures/resource limits. After removal there is no web image:
report Vite build stage/static bytes AND total shared-image build/size, rather
than a fictitious zero web cost. Count steady/one-shot services separately and
logical secrets separately from per-service copies. Expected removals: `web`,
`web-migrate`, `payload-secret`; verify actual inventories.

Gates: Biome; affected TS typecheck/Vitest; generated SDK checks; CLI/MCP;
quickstart Node tests; installer updater tests; local image/Compose smoke; SPA
navigation, terminal and desktop regression. The upgrade test starts a populated
source stack/schema, makes operator edits distinct from seeds, upgrades to this
branch, verifies all mapped fields, owner access, old key auth/revocation and SSH
lookup, restarts and checks again. Include revoked audit keys whose deleted team
is NULL, nullable creator/revoker links and self-referencing revocation IDs;
new keys still require a live team. Exercise migration failure and full DB/state
restore to old images. Document fixture provenance; synthetic-only testing must
not be presented as upgrade testing of the published release.

### Installed updater transition (owner-approved two-release sequence)

The source host runtime pre-pulls both quickstart/web target tags and its restore
helper stops hardcoded web/web-meta services against the target Compose BEFORE
restoring source Compose. Updating only target updater code cannot fix that:
the timer runtime is replaced after successful update. Compatibility image tags
alone are insufficient. Implement a prerequisite bridge on `s24-updater-bridge` that enumerates
trusted bundled images and actual Compose writers, installed before the S24
cutover. Its rollout and minimum-updater gate must prevent older automatic
updaters skipping the prerequisite. Owner merges/releases the bridge and installs it on the stand/homelab first.
Do not add compatibility services. Target S24 metadata declares `minUpdater`
with the actual bridge version and `dbCompatible: false`. The bridge rejects
requirements above its running version before pull/fence/backup/application.
Literal pre-bridge code ignores new metadata; operational rollout of the bridge
is mandatory before publishing cutover (confirmed by master).
Test minUpdater refusal for bridge-aware runtimes and retain a historical
pre-bridge regression documenting that the metadata gate is unsupported; no
external enforcement or compatibility services are needed. Do not claim direct source
upgrade support until the source executable-to-target bundle test passes for
success AND full rollback. Container/image removal counts must disclose any
temporary bridge artifacts.

## Owner decisions (2026-11-06)

1. Approved: API static delivery, unused legacy schema, incompatible rollback,
   obsolete screens removed with rows preserved, owner CLI settings authority.
2. Approved: setup/claim/recovery stays separate; S24b tracks SPA integration.
3. Approved: separate generic updater bridge and minUpdater gate; owner releases
   and installs it before S24. No temporary compatibility services.

Bridge prerequisite confirmed by owner: `0.4.0-edge.20261105.5` is released
and installed on the sole supported CT590. S24 release must set
`minUpdater: "0.4.0-edge.20261105.5"` and `dbCompatible: false`. The branch was
rebased on main after bridge merge. Live upgrade/forced rollback is owner-run
when requested; no implementer access to the stand.
