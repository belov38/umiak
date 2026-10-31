# @sbx/web

The dashboard `/app` and the Payload admin `/admin` (S8): Next.js 16 with
Payload 3 in one app, behind oauth2-proxy. Payload REST is at `/cms-api`
(`/api/*` of the same origin belongs to the api service).

## Routes

| Path | What |
|---|---|
| `/healthz` | `200 ok` once Postgres answers, Payload is up and every payload migration known to this code is applied; `503` otherwise. No identity headers needed (exec probe `node healthcheck.js`). |
| `/admin` | Payload admin (`app/(payload)`, from Payload's Next.js template). Operators only: `users` admin access; others get Payload's `/admin/unauthorized`. |
| `/cms-api/*` | Payload REST (collection access: operators). A refused login answers with `X-Sbx-Auth-Denied: <reason>`. |
| `/` | `307` to `/app` (a page, not a config redirect, so an anonymous `/` is still `401`). |
| `/app` | Redirect to the default team, `/app/t/<team_…>`. |
| `/app/t/<team>` | Team frame (S8 §9.3): team switcher, sections, operator links, user menu with sign-out. A team the user is not in: 403 page (operators may open any team). The page itself: sandboxes (§9.4), below. |
| `/app/t/<team>` (page) | Sandboxes: `GET /v1/sandboxes` with search (`q`), state and `label=k=v` filters, infinite scroll over `nextCursor`; quota line from `GET /v1/limits`. Polled every 5 s while the tab is visible and refetched at once after an action. Transitional states with a spinner and `activeOperation.kind: step`, `error` red with its message, `degraded` with `healthReason`, a lock for a blocked sandbox. Row actions: Stop / Resume, Fork (→ the new sandbox page), Open terminal (`?tab=terminal`), Delete (type the slug; `Sbx-Confirm-Delete` = id). Blocked: Resume and Fork disabled. |
| `/app/t/<team>/sandboxes/new` | Create (§9.5): template (enabled ones only), size (`allowedSizes`, the quota reason from `/v1/limits`), from a saved snapshot, name, slug (checked live), environment (team default → field omitted, a name, `none` → `environment: null`), labels, env, secrets (`type=password` with a show toggle), secret files (read into memory as base64; name, mode, link path), TTL and idle-stop (platform default → omitted, `none` → `null`). `POST /v1/sandboxes` through the SDK (Idempotency-Key), then the sandbox page. `quota_exceeded`, `out_of_capacity` (with "Try again"), `slug_taken`, `template_unavailable` as text at the form. The URL carries only `template`, `size`, `snapshot` (`newSandboxHref`/`parsePrefill`); inputs have no `name`, so a submit before hydration sends nothing. |
| `/app/t/<team>/sandboxes/<slug>` | Sandbox page (§9.6), below. `<slug>` may also be an `sb_…` id (snapshot sources link by id; the URL then shows the slug). |
| `/app/t/<team>/snapshots` | Saved snapshots (§9.7): `GET /v1/snapshots` (polled while one is creating or deleting), "Create sandbox" → the create form with the snapshot chosen, Delete (`sbx.snapshots.delete`, confirm). |
| `/app/t/<team>/keys` | Team API keys (§9.8): `GET /v1/api-keys`; presets `read-only`/`ci`/`full` (`@sbx/auth/scopes`) or scopes by hand, lifetime 90 days by default, at most 365; the secret once in a dialog with copy, `export SBX_API_KEY=…` and `sbx login --key-stdin`; Rotate (new secret in the same dialog), Revoke. New and Rotate for owners, Revoke for owners and operators (§6.2). Marks "creator left the team" / "creator deactivated" (`createdBy.member`/`active`); the IdP-sync notice banner above (same loader as settings); revoked and expired keys collapsed at the bottom; the `sbx login` hint for people. |
| `/app/t/<team>/settings` | Team (S8 §9.9): name (rename: owner, operator), members (email, name, role, "Not signed in yet", last sign-in), invite / role / remove (owner, operator), leave, quota and usage (`GET /v1/limits`), the IdP-sync notice banner (§9.8, §20.1) for owners and operators: "Revoke selected" (`DELETE /v1/api-keys/{key_…}` through the SDK), "Dismiss" (`acknowledgeNotice`, owners). |
| `/app/teams/new` | New shared team: name → `createTeam` → the new team. |
| `/app/account` | Profile (read-only), default team (`setDefaultTeam`), SSH keys (`GET/POST/DELETE /v1/ssh-keys`; `ssh_key_in_use` and unsupported types as text), sign-out with the `sbx login` hint. |
| `/app/t/<team>/environments` | Environments (§10): `GET /v1/environments`, a card per environment with env and secret names (values never), secret file metadata, repositories, default, "no personal secrets", revision, last change and by whom (member names from Payload, like settings). New / Edit / Delete for owners and operators (`can(…, "manageEnvironments")`), members read. Edit reads `GET /v1/environments/{id}` (env values) and sends a merge `PATCH`: only what changed, `null` for removed keys and files, secret values only when typed, `repositories` whole when changed (`src/lib/environment-form.ts`). Repository URLs are checked like the api (https, ssh or `user@host:path`; no credentials, query or fragment), at most 20. `excludeOwnerSecrets` is stored only (S7 decision 7). |
| `/app/operator` | Operator section (§9.10). The server page checks `isOperator` of the resolved session (`requireOperator`, `src/lib/operator.ts`); others get the 403 page (`operator/forbidden.tsx`). Every team comes from Payload (`toOperatorTeams`) for the team column and filter. `GET /v1/sandboxes?allTeams=true` with team, state and search filters, polled every 5 s. Per row: Ports (hosted ports with Block / Unblock), Block / Unblock (reason `operator`/`abuse`, note ≤ 500), Stop, Delete (type the slug), links to the team and the sandbox page. Actions carry `Sbx-Team` of the sandbox's team. Link to `/admin`. No pool or node status (phase 2). |

## Delete team in /admin (S8 §6.4)

The team edit view shows "Delete team" for shared teams
(`src/components/admin/delete-team-control.tsx`, a server component
registered in `@sbx/payload` by path). In the operator's browser it reads
`/api/v1/sandboxes?allTeams=true&teamId=…&limit=1`, `/api/v1/snapshots` and
`/api/v1/environments` with `Sbx-Team` of the team and refuses with what is
left; otherwise it confirms and sends `DELETE /cms-api/teams/<uuid>` with
`x-sbx-delete-team: checked` (`src/lib/team-delete.ts`), then opens the
teams list. Payload's own Delete is not offered for teams: teams access
requires that header. A sandbox created between the check and the delete
is the known race of §6.4.

## Sandbox page (S8 §9.6)

`src/features/sandbox/*`; the tab is in `?tab=` and only the open tab is
mounted, so leaving a tab (or the page) closes its streams and sockets.

- **Live state** (`live.ts`, `use-sandbox.ts`): one loop per page with at
  most one long-poll in flight: `GET /v1/sandboxes/{id}?waitFor=<every state
  but the current>&waitSeconds=30` (none in `error`/`deleting`/`deleted`,
  where the api answers at once); an operation started by a button
  (`track(op)`) is awaited in the same loop (`waitForOperation`) and ends the
  sandbox long-poll first. Plus a plain GET every 10 s for health and
  activity. After the first answer everything uses the `sb_…` id.
- **Header**: name, slug + rename (`PATCH slug`, then the URL follows),
  state, health, activity, template/version, size, origin, labels,
  TTL/deadline, idle stop; Stop/Resume, Fork (same idempotency slot as the
  list), Recover (confirm), Extend, Save snapshot (name, warning when a ready
  snapshot of that name is replaced), Delete (type the slug). Operation bar
  (`kind`, `state · step`), error block with Recover. Blocked: lock, reason
  banner; only Stop and Delete stay enabled, and the tabs disable writes.
- **Terminal**: xterm.js 6 (`fit`, `web-links`, `search`), loaded with
  `next/dynamic` (`ssr: false`), CSS from the package. Tabs = running PTYs
  (`GET /commands?mode=pty&status=running`) plus new ones (`POST /ptys`);
  the open tab attaches with `tailBytes=65536` through `sb.connectPty`
  (WebSocket `/api/v1/sandboxes/{sb}/ptys/{cmd}/connect?team=…`,
  `sbx.pty.v1`). The SDK reconnects by offset; `src/lib/ws.ts` (the
  browser WebSocket factory: subprotocols only) reports socket closes for the
  "Reconnecting…" bar. Final errors (`4409`, `4503` after retries, `4401`,
  `4404`, `4416`) get text and, where it helps, "Reconnect". Detach keeps the
  shell (ended by the agent after 10 min without a client); Close kills it.
- **Commands**: table with status filter and pages; Run command
  (`sb.start`, detached, Idempotency-Key kept across a manual retry with an
  unknown outcome); output in a read-only xterm via `cmd.follow` (from the
  start, or the last 1 MiB per stream for long output), stderr red,
  stdout/stderr filter, `truncated` and the exit as dim lines; Download of up
  to 4 MiB from an offset (`/output?…&team=`, default the last 4 MiB);
  Signal and Kill while running.
- **Files**: `GET /files/list` with pages, breadcrumbs, `..`, hidden files;
  preview of files ≤ 1 MiB (`Range: bytes=0-1048575`) as text in `<pre>`,
  binary or larger → download only; download links
  `/api/v1/sandboxes/{id}/files/content?path=…&team=…`; upload by button or
  drop (≤ 64 MiB one `PUT /files/content`, larger `sb.files.upload` in
  chunks with progress and cancel; folders → hint to use the CLI); new
  folder, move/rename, delete (recursive for folders, confirmed).
- **Ports**: hosted and listening; publish/change (`access`
  token/sso/public, `hostRewrite`), the token and `urlWithToken` once in a
  dialog that closes only through "I have copied it" (also after Rotate);
  Unpublish; a blocked port shows the lock and keeps its buttons disabled;
  `403 public_disabled` → hint at the form and `public` disabled.
- **SSH**: command, `known_hosts` lines, `hasKeys: false` → link to
  `/app/account` and the `sbx ssh` hint.
- **Env**: env with values, secret names with `•••` (values are never
  fetched), secret files; every change is one key through `PATCH /env`
  (merge); `delivered: false` → "applies at the next start".
- **Desktop**: only for templates with the `desktop` capability; a
  placeholder until S10.

## Server actions (S8 §9.11)

`src/actions/{teams,members,account,notices}.ts` are `"use server"`
wrappers: `createTeam(name)`, `renameTeam(teamId, name)`,
`inviteMember(teamId, email, role)`, `setRole(membershipId, role)`,
`removeMember(membershipId)`, `leaveTeam(teamId)`,
`setDefaultTeam(teamId)`, `acknowledgeNotice(noticeId)` →
`{ok: true, …} | {error: {code, message}}`. The logic is
`…Impl(ctx: {payload, session}, args)` in `src/lib/team-actions/` (tested
without Next, `test/actions.test.ts`).

- Session: `requestAuth()` (the same cached resolution as the layouts and
  the Payload strategy); none → `forbidden`. After a success the session
  cache of the process is flushed at once and `/app` is revalidated.
- One Payload transaction per action (`inTransaction`: `createLocalReq` +
  `initTransaction`/`commitTransaction`/`killTransaction`). The team row is
  locked (`FOR NO KEY UPDATE`, the lock of the last-owner hook), then the
  caller's membership is read in the transaction and checked with
  `can()` (`src/lib/permissions.ts`, the table of §6.2). Writes: Local API,
  `overrideAccess: true`, the same `req` (hooks and NOTIFY in the
  transaction), memberships one id at a time. An error result rolls back.
  A unique violation (two invites of a new email at once) retries the
  action (3 attempts).
- Input: zod. Codes: `validation` (bad input or malformed id),
  `forbidden`, `not_found`, `last_owner` (the hook's `APIError`),
  `team_limit`, `already_member`.
- `forbidden` vs `not_found`: a person gets `forbidden` both for a row of a
  team they may not act on and for a row that does not exist, so nobody
  learns whether a foreign team, membership or notice exists. Operators
  (who see every team) get `not_found` for a missing row.
- Rules beyond the table: `createTeam` counts shared teams where the user
  is `owner` against `PlatformDefaults.maxOwnedTeamsPerUser` (3 if unset;
  the user row is locked so concurrent creates serialize) and copies
  `newSharedTeamQuota`; `inviteMember` lowercases and trims the email,
  links an existing user or creates a stub (`active`, no `idpSubject`, no
  personal team), never into a personal team (operators neither);
  `leaveTeam`/`removeMember` reset a default team that was this team to the
  personal team (a stub: none); the personal team cannot be left;
  `setDefaultTeam` needs a membership (operators too);
  `acknowledgeNotice` is for owners of the notice's team only (operators
  use `/admin`) and keeps the first acknowledgement.

### Dashboard ids

Memberships and team notices have no public id in `/api/v1`. The
dashboard uses `mbr_…` and `ntc_…` (`src/lib/ids.ts`): the same Crockford
base32 body over the Payload UUID as `usr_`/`team_`, accepted only by these
server actions. Teams are `team_…`, users `usr_…`, notice keys `key_…`.

## Authentication (S8 §5)

- `src/proxy.ts` (Next 16 proxy, Node runtime) on every path but `/healthz`
  and Next's static files: no `X-Auth-Request-Email` → `401` HTML page; an
  unsafe method (anything but GET, HEAD, OPTIONS) whose `Origin` is not
  exactly `SBX_APP_ORIGIN` (or missing) → `403`. It also sets the security
  headers below on every answer. The checks live in `src/lib/guard.ts`.
- The identity is resolved by `authenticateRequest` of `@sbx/payload`: the
  same function the Payload strategy calls, through one per-process session
  cache (30 s, keyed by sha256 of email, sub, groups and names; flushed by
  `LISTEN sbx_identity` on its own connection, `sandboxes:`, `api-keys:`
  and `ssh-keys:` payloads ignored; plan decision 8). `/admin` and `/app`
  therefore always agree on who is logged in.
- `/app` layouts call `getAppSession()` (`src/lib/session.ts`): anonymous or
  `subject_required` → `unauthorized()` (401 page), `user_disabled` or
  `identity_conflict` → `forbidden()` (403 page with the reason). This uses
  Next's `authInterrupts` (experimental flag in `next.config.ts`).
- The browser gets `AppSession` with public ids only (`usr_…`, `team_…`).
- Sign-out: `/oauth2/sign_out?rd=<SBX_LOGOUT_URL>` (or without `rd`).

## Browser data access

`src/lib/api.ts`: `SbxProvider` (TanStack Query client + per-team SDK
clients) and `useSbx(teamId)`. The SDK runs in session mode
(`new Sbx({baseUrl: "/api", session: true, team})`): no Authorization
header (the proxied listener refuses one), the oauth2-proxy cookie of the
same origin is the credential; PTY WebSockets get the team as `?team=`.
The dashboard's SDK clients retry for at most 5 s (`DASHBOARD_RETRY_BUDGET_MS`;
the SDK default is 60 s), so a missing api shows "API unavailable" quickly.

- `src/lib/errors.ts`: API error → text (`describeError`), `isApiUnavailable`
  (no answer, or a 502/503/504 page without the API envelope, or the api
  shutting down). `src/components/app/query-error.tsx` renders it for a query.
- `src/lib/idempotency.ts`: create and fork keep their Idempotency-Key
  (`slotFor`/`slotAfter`, per form or source sandbox) while the body is the
  same and the outcome of the last attempt is unknown (no answer, a page
  without the API envelope, `server_shutting_down`, `details.outcome:
  "unknown"`); a success, a definitive API error or a changed body gives a
  new key. A manual retry therefore cannot create a second sandbox.
- `src/lib/client-call.ts`: `attempt(fn)` for server actions and SDK calls
  from handlers and transitions: an exception becomes a toast, not the error
  boundary or an unhandled rejection; nothing is logged (bodies may hold
  secrets).
- Query keys: `["operator-sandboxes", filter]`, `["sandboxes", team, …]` (the page: `["sandboxes", team,
  "one", ref]`), `["commands", team, sb]`, `["ptys", team, sb]`,
  `["files", team, sb, …]`, `["ports", team, sb]`, `["env", team, sb]`,
  `["ssh", team, sb]`, `["limits", team]`,
  `["snapshots", team]`, `["api-keys", team]`, `["templates", team]`,
  `["sizes", team]`, `["environments", team]`.

## Environment

All required unless marked; validated at start (`src/instrumentation.ts`),
every problem listed at once, the process exits on error.

| Variable | |
|---|---|
| `DATABASE_URL` | Postgres (schema `payload`) |
| `PAYLOAD_SECRET` | ≥ 16 characters (Payload requires it; no JWT is issued) |
| `SBX_APP_ORIGIN` | e.g. `https://app.example.com` (no path, no trailing slash) |
| `SBX_OPERATOR_GROUPS` | comma-separated IdP groups |
| `SBX_SBX_DOMAIN` | sandbox host domain, for CSP `frame-src https://*.<domain>` |
| `SBX_API_PUBLIC_URL` | public API URL shown in the UI |
| `SBX_LOGOUT_URL` | optional: Keycloak logout page after oauth2-proxy sign-out |

## Security headers and CSP

Every answer that passes through `proxy.ts`:

```
Content-Security-Policy: default-src 'self'; base-uri 'self'; object-src 'none';
  form-action 'self'; frame-ancestors 'self'; connect-src 'self';
  frame-src https://*.<SBX_SBX_DOMAIN>; img-src 'self' data: blob:;
  font-src 'self' data:; style-src 'self' 'unsafe-inline';
  script-src 'self' 'unsafe-inline'; worker-src 'self' blob:
X-Content-Type-Options: nosniff
Referrer-Policy: same-origin
X-Frame-Options: SAMEORIGIN
```

- `script-src 'unsafe-inline'`: Next.js streams inline `<script>` chunks
  (RSC payload) and the Payload admin relies on them; a nonce-based policy
  would need a nonce threaded through Payload's RootLayout.
- `style-src 'unsafe-inline'`: the Payload admin and Radix set inline styles.
- `next dev` adds `'unsafe-eval'` to `script-src` (React dev tooling).
- `connect-src 'self'` also covers `wss://` of the own host (PTY, HMR).
- Nothing loads from another origin. Two admin defaults that did are
  changed in `@sbx/payload`: `admin.avatar: "default"` (no Gravatar) and
  JSON fields render as a textarea (`src/components/admin/json-field.tsx`)
  instead of Monaco, which Payload loads from cdn.jsdelivr.net.

Checked in a browser against `next dev` and the standalone build: no CSP
violations on `/app`, the admin dashboard, list and edit views (saving a
template through the admin works).

## Payload cookies (S8 §5.4, §19)

`cookiePrefix` is `__Host-payload`. The admin writes its theme cookie from
the browser as `__Host-payload-theme=…; path=/` without `Secure`, which
browsers refuse for a `__Host-` name, so the theme choice is not kept
between visits. These cookies grant nothing; no change made.

## Admin import map

`src/app/(payload)/admin/importMap.js` is generated (`pnpm generate:importmap`,
needs no database) and committed; `next dev` also rewrites it when the
config gains components. Component paths in `@sbx/payload` are relative to
this directory (`/src/components/...`).

## Development (S8 §13)

```
pnpm --filter @sbx/payload migrate      # DATABASE_URL, PAYLOAD_SECRET
DATABASE_URL=postgres://… pnpm --filter @sbx/web dev
open http://127.0.0.1:3000/__dev/login
```

`dev/dev.ts` runs `next dev` on 127.0.0.1:3001 and `dev/auth-proxy.ts` on
127.0.0.1:3000 (ports: `SBX_DEV_PORT`, `SBX_DEV_NEXT_PORT`,
`SBX_DEV_API_PORT`). The proxy plays ingress + oauth2-proxy: it listens on
127.0.0.1 only, drops client `X-Auth-Request-*` headers and sets them from
the `sbx_dev_identity` cookie chosen at `/__dev/login` (user, second user,
operator in `sbx-operators`, or custom; the form's POST needs `Origin` =
`SBX_APP_ORIGIN`, and an identity with control characters or a comma in the
email or sub is refused, also from a hand-made cookie); `/__dev/logout` and
`/oauth2/sign_out` clear it. Routes as in `deploy/compose/oauth2-proxy`:
`/api/*` → 127.0.0.1:8081 without `/api`, `/sbx-auth/*` → 127.0.0.1:8081,
the rest → `next dev`; WebSocket upgrades too. Without the api, `/admin` and
the team frame still work.

Dev defaults (only in `dev/dev.ts`): `SBX_APP_ORIGIN=http://127.0.0.1:3000`,
`SBX_OPERATOR_GROUPS=sbx-operators`, `SBX_SBX_DOMAIN=sbx.localhost`,
`SBX_API_PUBLIC_URL=http://127.0.0.1:8080`, a dev `PAYLOAD_SECRET`.

`web` itself has no dev-auth code path: `dev/` is outside `src`, excluded
from the image (`.dockerignore`) and `pnpm check:image` fails if any file of
`.next/standalone` or `.next/static` mentions it.

## Build and image (S8 §14.1)

- `pnpm --filter @sbx/web build`: `next build` (Turbopack), `output:
  "standalone"`, `transpilePackages` for `@sbx/*` (TypeScript sources with
  `.ts` import extensions). Types are checked by `pnpm typecheck`, not by
  `next build` (TypeScript 7 has no JS API).
- `docker build -f apps/web/Dockerfile .` (repo root context). Default
  command: the Next server on `:3000` as user `node`. The migration job uses
  the same image: `node packages/payload/src/migrate.ts` with WORKDIR
  `/app/migrate`. `HEALTHCHECK` runs `node healthcheck.js`.

## Tests

`pnpm --filter @sbx/web test`: the role table (`permissions.test.ts`), the
dashboard logic without a DOM (`errors.test.ts`: a text per create error,
retry for `out_of_capacity`, "API unavailable"; `create-form.test.ts`: the
create body, blank rows dropped, `environment: null` for none, secrets never
in the search params; `api-keys.test.ts`, `sandboxes.test.ts`), the
server actions against Postgres and Payload (`actions.test.ts`: forbidden
matrix for member, non-member and operator, last owner, concurrent
demotions, personal team, team limit, already member, stubs, default team
fallback, notices), proxy and CSRF decisions, security headers,
env parsing, team paths, the operator guard and list query
(`operator-page.test.ts`), the environment form and its merge patch
(`environment-form.test.ts`), the team-delete checks (`team-delete.test.ts`), the dev proxy over real sockets (header stripping,
routing, WebSocket upgrade, 127.0.0.1 only), and the web Payload config
against Postgres (`@sbx/db/testing/global-setup`): strategy, shared session
cache, public-id session.

## E2E (Playwright, S8 §15)

`pnpm --filter @sbx/web test:e2e` (`e2e/run.ts`) brings up the compose E2E
stack (`deploy/compose/e2e.yaml`, project `sbx-e2e`: real Keycloak,
oauth2-proxy, Postgres and this image; `api` + `worker` replaced by
`e2e/backend`, the real api and worker code in one process with the fake
agent and the fake PVE world), runs `e2e/playwright.config.ts` (Chromium,
one worker, files in order) and tears the stack down with its volumes.
`SBX_E2E_KEEP=1` keeps it; then `pnpm exec playwright test -c e2e` runs
against it. `SBX_E2E_LARGE=1` uploads 100 MiB instead of 70 MiB. `pnpm test`
(vitest) never runs these. `pnpm typecheck:e2e` checks `e2e/`.

- `global-setup.ts` creates this run's Keycloak users (Admin API) and the
  Payload "filler" users; `fixtures.ts` signs in through the real Keycloak
  page and audits every response of every page: no `secretHash` value, no
  registered secret, no API key secret or port token after its dialog.
  The audit routes every app request (`context.route` + `route.fetch`) and
  scans the body before the page gets it (reading bodies from response
  events loses them on navigation); downloads, uploads, NDJSON streams,
  long-polls and `/oauth2/*` pass through. With interception on, Chromium's
  Local Network Access checks refuse the PTY WebSocket to localhost, so the
  config disables that feature for the test browser.
- Specs: `01-onboarding` (JIT, create, terminal echo/resize/reload),
  `02-sandbox` (commands, files, ports), `03-keys` (key on the public API,
  revoke closes streams and PTYs), `04-teams` (invite, member rights,
  cross-team, CSRF), `05-operator` (403s, block), `06-idp-sync`
  (Keycloak offboarding, empty answer), `07-security` (forged headers,
  `/cms-api` CSRF, web network, image content, secrets), `08-identity`
  (IdP email change, deletion, reused email, sso epoch, `sbx login` device
  grant: same user as the browser, an operator's JWT has no operator
  rights).
- `e2e/backend` is test-only: its own image
  (`e2e/backend/Dockerfile`, context filter `Dockerfile.dockerignore`);
  the root `.dockerignore` keeps `apps/web/e2e` out of every other image.
  Its control listener (`127.0.0.1:19099` on the host) runs ctl-idp-sync
  passes, switches the Keycloak list to empty, reads `routes.lookup` from
  the internal listener and what the fake guest received.
