> Historical design: Keycloak, oauth2-proxy and OIDC authentication were removed on 2026-11-05. Current deployments use owner authentication over Tailscale; see [architecture](../architecture.md).

# S8. Web (Payload): admin panel, dashboard, users and teams — specification

Status: agreed (the master session on Ilia's behalf), 2026-10-29. The IdP is Keycloak, offboarding is option A (Ilia's decision 2026-10-29, §5, §9.8, §20.1). Supplemented with the MVP recommendations R3, R4 (`docs/roadmap-phase2.md` §6, decisions of the master session 2026-10-29). Area S8 from `docs/roadmap.md`. Architecture: `docs/architecture.md` (§2, §10, §11). Relies on `docs/specs/s7-public-api.md` (listeners, keys, scopes, `IdentityStore`, §17.3, §22), `docs/specs/s6-control-plane.md` (§5.11 `ConfigReader`, §8.5 quotas, §13.1 secrets), `docs/specs/s4-gateway.md` (§6.1–6.2 routes and blocks, §8.4 SSO, §14.1 cookies).

The answers to Q1–Q3 and the author's decisions were agreed with the master session on Ilia's behalf (2026-10-29). The mark **[S8 decision]** is a decision of the spec author within the brief (approved by the master session); it can be changed during planning if the reason is recorded. The mark **[S7 change]** / **[S6 change]** marks a place where S8 adds something to an already agreed spec; the summary is §17.

## 1. Why

S8 is the human face of the platform. Operators configure it in `/admin` (templates, sizes, quotas, pool, users, keys). Users in `/app` create sandboxes, look at logs, open a terminal, work with files and ports, and `owner`s issue team API keys for agents and CI (people log in to the CLI through Keycloak, S7 §7.6). Besides, S8 gives `api` and `worker` two sources of truth: who the user is and what they may do (`IdentityStore`), and how the platform is configured (`ConfigReader`).

What counts as success:
1. A new employee opens `https://app.<domain>`, logs in through Keycloak, and a minute later works in the terminal of their sandbox. No registration and no operator are needed.
2. A change in `/admin` (a template turned off, a quota lowered, a key revoked, `public` turned off) takes effect on all `api`, `worker`, and gateway pods within seconds, without a restart.
3. The dashboard can do everything the CLI can, through the same public API. There is no separate path to runtime data bypassing the API.
4. No platform account is accepted from a header that did not come from oauth2-proxy, and a secret value cannot be read from either the dashboard or `/admin`.
5. A developer brings up `apps/web` locally without an IdP with one command, and the production code contains no authentication bypass.

## 2. Goals, non-goals, anti-goals

**Goals**
- `apps/web`: one Next.js application with Payload 3; `/admin` for operators, `/app` for users.
- `packages/payload`: the Payload config, collections, hooks, the auth strategy, JIT, the `IdentityStore` implementation (S7 §17.3) — imported from `api` and `worker` without Next.
- `PayloadConfigReader` in `packages/config` (S6 §5.11).
- The model of teams and the roles `owner`/`member`, a personal team at first login, invitations by email.
- Team environments (the second wave of the MVP) — storage in `runtime`, endpoints in `api` (§10).
- The "Operator" section in `/app`: all sandboxes of all teams, blocks (§9.10).
- Local development without oauth2-proxy (§13), migrations of the `payload` schema (§12), the build and deploy form (§14).

**Non-goals (other areas)**
- The public API and its internals (S7), state machines and the worker (S6), the gateway (S4), the desktop (S10), MCP (S11), Helm charts and IdP setup (S12), cloning repositories from environments (S13; S8 only stores the repository list, §10.1).
- SSO for ports (`/umiak-auth/*`): served by `api` (S7 §7.7), S8 only stores the data it reads. CLI login is the Keycloak device grant (S7 §7.6): `web` and `api` have no pages of their own for it.
- Billing, organizations with wallets, public registration.

**Anti-goals (a failure even if everything works)**
- `web` or `api` accepted a user by an `X-Auth-Request-*` that did not come from oauth2-proxy.
- A secret value (an env secret, a secret file, an API key's secret after the first display, a port token after issuing) is visible in the dashboard, in `/admin`, in the Payload REST, in `web` logs.
- A user without the operator role read or changed something through the Payload REST or a server action bypassing the checks.
- The dashboard showed runtime data read from the DB directly, not through the API (it would diverge from what the CLI sees).
- After a key is revoked, a user deactivated, or `public` turned off, the old behavior holds longer than promised in §11.
- The authentication stub code for development ended up in the production image.

## 3. Constraints

- The toolchain from `mise.toml` (Node 26.13.0, pnpm 12.16.1). The library versions are in §16, checked 2026-10-29; re-check during implementation and take the latest stable (`CLAUDE.md`).
- Layout per `CLAUDE.md`: `apps/web`, `packages/payload`; vitest and Playwright tests; biome lint.
- One Postgres (S6 §3): the `payload` schema belongs to S8. S8 neither reads nor writes `runtime` from `web` (§14.3); the runtime tables for environments and blocks are added by migrations in the S8 range (§17.3) and used only by `api`/`worker`.
- An internal company platform; users come only from Keycloak (realm `umiak`, architecture §10): in the browser — behind oauth2-proxy, in the CLI, SDK, and MCP — by Keycloak JWT (S7 §7.10). Later Keycloak may broker a corporate IdP (Google, Entra, LDAP); not in the MVP.
- The interfaces `IdentityStore` and `ConfigReader` are set by S7/S6; S8 implements them and extends them only by additions (§17).

## 4. Overview

```
 browser
   |  https://app.<domain>
   v
 ingress (TLS, HTTP/2) ──> oauth2-proxy (Keycloak OIDC, cookie __Host-oauth2_proxy)
                              |  injects X-Auth-Request-Email/-User/-Groups/-Preferred-Username,
                              |  strips client-supplied copies
          ┌───────────────────┼───────────────────────────────┐
          | /api/* (strip /api), /umiak-auth/*                   | everything else
          v                                                    v
   apps/api :8081 (proxied listener, S7)              apps/web :3000 (Next.js 16 + Payload 3)
     IdentityStore ── packages/payload ──┐              /admin   Payload admin (operators)
     ConfigReader ── packages/config ────┤              /app     dashboard (React, @umiak/sdk -> /api/v1)
                                         |              /cms-api Payload REST (operators only)
   apps/worker: ConfigReader ────────────┤              server actions: teams, members, settings
                                         v
                         Postgres: schema payload (S8)  <- Payload Local API (getPayload)
                                   schema runtime (S6/S7/S8 additions) <- only api, worker
                         NOTIFY umiak_identity, umiak_config, umiak_routes '*'
```

- The browser talks to `web` only behind oauth2-proxy. `web` renders the `/app` shell and the team management forms (Payload Local API), while everything about sandboxes, commands, files, ports, snapshots, keys, SSH keys, and environments the browser takes itself from `https://app.<domain>/api/v1/*` through `@umiak/sdk` (the same origin, the same oauth2-proxy cookie).
- `web` does not call `api` from the server side and does not forward identity headers [S8 decision]: so there is no second path where a user could be forged.
- `api` and `worker` bring up the same Payload config through `getPayload` (without Next) and read/write collections through the Local API.

### 4.1 Packages and applications

| Path | Name | What |
|---|---|---|
| `packages/payload` | `@umiak/payload` | `buildConfig` (without React imports; admin components by import map paths), collections and globals, `NOTIFY` hooks, the `oauth2-proxy` auth strategy, `resolveSession` (JIT), `PayloadIdentityStore`, migrations of the `payload` schema, `getUmiakPayload()` with an instance cache |
| `packages/config` | S6 | S8 writes `PayloadConfigReader` on top of `@umiak/payload` (S6 §5.11) |
| `packages/auth` | S7 | The `IdentityStore` interface, the key format, public ID codecs; S8 adds a shared `IdentityStore` contract test suite (§15) |
| `apps/web` | `@umiak/web` | The Next.js application: Payload routes (`/admin`, `/cms-api`), `/app`, server actions, `/healthz`; `dev/` — the authentication stub (§13), not part of the image |

## 5. Authentication

### 5.1 Chain of trust

- All of `app.<domain>` is closed by oauth2-proxy in reverse proxy (upstream) mode [S8 decision; config — S12]. The provider is Keycloak: in the alpha config `providers[].provider: keycloak-oidc`, `oidcConfig.issuerURL: https://<keycloak>/realms/umiak`, the confidential client `oauth2-proxy` with an Audience mapper to itself (oauth2-proxy checks `aud` against `client-id`) and a Group Membership mapper into the claim `groups` (architecture §10). Through the alpha config `injectRequestHeaders` oauth2-proxy sets for the upstream `X-Auth-Request-Email` (claim `email`), `X-Auth-Request-User` (claim **`sub`** — the IdP's immutable identifier, not the login or email), `X-Auth-Request-Groups` (the groups claim), `X-Auth-Request-Preferred-Username` from claims, and strips client-sent copies (`preserveRequestValue: false`, the default). An unverified email is not accepted (oauth2-proxy by default requires `email_verified`; `--insecure-oidc-allow-unverified-email` is not enabled).
- Requirements for the oauth2-proxy session (S12): `--cookie-refresh=5m` (a flag, not in the alpha config; on refresh Keycloak refuses a disabled user and returns current groups), `--cookie-expire` no more than 12 h. Only this way do disabling a user and removing a group in the IdP reach `web` and `api` (§11). Path routing is also in the alpha config: `/api/` → `api:8081` with `rewriteTarget` without `/api`, `/umiak-auth/` → `api:8081`, the rest → `web:3000`. If S12 chooses an nginx-like `auth_request`, the contract for `web` and `api` is the same: these four headers are set only by oauth2-proxy.
- The oauth2-proxy cookie is `__Host-oauth2_proxy`, host-only, `Secure`, without `--cookie-domain` (S4 §14.1).
- `web` trusts the headers only because only oauth2-proxy is allowed to reach its port (NetworkPolicy, S12), like `api :8081` (S7 §7.1). There is no separate secret between oauth2-proxy and `web` [S8 decision]: the NetworkPolicy is the same boundary as for `api`, and a second mechanism would only complicate dev.
- Probes are **exec probes** inside the container (`node healthcheck.js` → `http://127.0.0.1:3000/healthz`), not kubelet HTTP probes [S8 decision after review]: then the NetworkPolicy lets only oauth2-proxy pods onto `:3000`, without node addresses (otherwise any hostNetwork pod or node process could send a forged `X-Auth-Request-*`). `/healthz` requires no headers and returns only `200 ok` (Postgres, Payload initialization, migrations §12).
- A request to any other `web` path without `X-Auth-Request-Email` gets `401` (a plain HTML "not signed in" page). In production this happens only on a misconfiguration.

### 5.2 Header parsing

- `email` — `X-Auth-Request-Email`, lowercased and trimmed; required, otherwise `401`.
- `user` — `X-Auth-Request-User` (claim `sub`), required; `preferredUsername` — `X-Auth-Request-Preferred-Username`, optional.
- `groups` — `X-Auth-Request-Groups`: oauth2-proxy may send one comma-separated value or several values; Node joins repeats with `, `. Parsing: split on `,`, trim, drop empties, remove duplicates. Groups with a comma in the name are not supported (the limitation is recorded in the S12 documentation).

### 5.3 JIT and `resolveSession`

`resolveSession({email, user, groups, preferredUsername})` lives in `@umiak/payload` and is used three times: by the Payload auth strategy in `web`, by `PayloadIdentityStore.resolveSession` in `api` for the browser (S7 §7.4) and for the Keycloak JWT from the CLI, SDK, and MCP (S7 §7.10, input from the claims `email`, `sub`, `groups`, `preferred_username`). The logic is one, so the browser and the CLI are the same identity by `sub`:

The identity is bound to `sub` (`idpSubject`, a unique index); email is the second key for the first login and invitations [S8 decision after review]. `X-Auth-Request-User` is required (without it `401`).

1. Find the user by `idpSubject = user`. Found:
   - the email in the header is different (changed in the IdP) → update `email` if it is free. If the email is taken by a placeholder (§6.3) — move its memberships to this user and delete the placeholder. If it is taken by another user who has already logged in — `403` ("the email is taken by another account, contact an operator").
2. Not found — look up by `email`:
   - a placeholder (`idpSubject` empty) → bind: write `idpSubject`, `name`, create a personal team if there is none;
   - a user with another `idpSubject` → `403` ("the IdP account changed, contact an operator"): a new person with a reused email does not get someone else's teams and keys. An operator resets `idpSubject` in `/admin`.
3. Not found by email either — create: `email`, `name` (`preferredUsername` → the part of the email before `@`), `idpSubject`, `active: true`. In the same transaction — a personal team (§6.1) and an `owner` membership; `defaultTeam` = the personal team. The race of two first requests is resolved by unique indexes: the loser re-reads the row.
4. `active: false` — refusal: in `web` the page "account disabled" (`403`), in `api` — `403 forbidden` with `details.reason: "user_disabled"` [S8 decision].
5. `isOperator` = the intersection of `groups` with `UMIAK_OPERATOR_GROUPS` (a comma-separated list, the group name is set by S12/Ilia). Write `groups`, `isOperator`, `lastLoginAt` if they changed (no more often than once per 60 s for `lastLoginAt`), so that an ordinary request does not write to the DB.
6. The response is `SessionIdentity`: the user, `isOperator`, teams with roles, `defaultTeamId`.

An in-process cache for 30 s by `sha256(email + groups + user)`, reset by `LISTEN umiak_identity` (S7 §7.4 — the same behavior in `api`).

### 5.4 Payload: a strategy instead of passwords

- The collection `users`: `auth: { disableLocalStrategy: true, strategies: [{ name: "oauth2-proxy", authenticate }] }`. `authenticate({ headers, payload })` calls `resolveSession` and returns `{ user: { ...user, collection: "users", _strategy: "oauth2-proxy" } }` or `{ user: null }`.
- There are no passwords, login, logout, JWT, or Payload cookies: the strategy runs on every request by the headers. `admin.user = "users"`.
- Payload's `cookiePrefix` is `__Host-payload` [S8 decision]: the admin's service cookies (language, theme) are also host-only. If Payload cannot set them with this prefix, the implementer records this in the plan; these cookies grant no access and are not credentials.
- Sign-out is a link to oauth2-proxy's `/oauth2/sign_out` (with `rd` to the Keycloak logout page, configured by S12). Signing out in Keycloak ends the SSO session to which the CLI's refresh token is also bound (S7 §7.6): after signing out of the dashboard the CLI will ask for `umiak login`. This is written in the hint at the sign-out button.

### 5.5 The operator role

- An operator is a user who has a group from `UMIAK_OPERATOR_GROUPS` in the current session. The field `users.isOperator` is read-only in `/admin`, updated at every `resolveSession`.
- **Operator rights apply only in a browser session** [S8 decision, S7 change C6]: the principal by API key and by a Keycloak JWT from the CLI has `isOperator = false`. So a key leaked from CI does not give access to all teams, and removing a group in the IdP takes away rights at the next oauth2-proxy session refresh (§5.1, §11), not after manual actions.
- **SSH also without an operator exception** [S8 decision after review, S7 change C6]: `ssh/authorize` lets in only members of the sandbox's team; the S7 §12.1 rule "or an operator" is removed. The SSH session has no fresh groups, and the stored flag could be stale. An operator who needs a shell in someone else's sandbox has the browser terminal (the "Operator" section).
- The stored `users.isOperator` serves only for display in `/admin` and filters.

### 5.6 CSRF in `web`

- All unsafe requests to `web` (server actions, Payload REST, uploads in the admin) require `Origin == UMIAK_APP_ORIGIN`; otherwise `403`. The check is in the Next 16 `proxy.ts` (formerly middleware) for all paths except `/healthz`. Next's server actions additionally compare `Origin` with `Host` themselves; `serverActions.allowedOrigins` is not extended.
- `csrf` Payload = `[UMIAK_APP_ORIGIN]`.
- `web` responses: `Content-Security-Policy` with `frame-ancestors 'self'`, `default-src 'self'`; `connect-src 'self'` (the dashboard goes only to its own origin, WebSocket — `wss://app.<domain>`); `frame-src https://*.<umiak-domain>` for port previews and the desktop (S10). `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`. The exact list is up to the implementer, the Payload admin may require `'unsafe-inline'` for styles.

## 6. Teams and roles [decision Q1]

### 6.1 Model

- **A personal team.** Created at first login: `name` = the user's name (in the implementation — `<email>'s team`, §21.5), `personal: true`, the only member is the user (`owner`). It cannot be deleted, it can be renamed; others cannot be invited into it [S8 decision]: a "personal" team must stay personal, shared teams exist for joint work.
- **A shared team.** Created by any user in `/app` (the creator is `owner`). The limit is no more than 3 shared teams where the user is `owner` [S8 decision; the value `maxOwnedTeamsPerUser` in `PlatformDefaults`, an operator can change it]. A new shared team gets the quota `newSharedTeamQuota` from `PlatformDefaults` (by default equal to `defaultQuota`; an operator can set zeros, then the team works only after an operator grants a quota).
- **Quotas are fairness, not capacity** [S8 decision after review]: node RAM overuse is prevented by the S6 admission (§8.2, `out_of_capacity`), not by quotas. A user with several teams can occupy more than one quota; this is a deliberate compromise of an internal platform, the levers are `maxOwnedTeamsPerUser`, `newSharedTeamQuota`, and the quotas of individual teams.
- **Default team** (`users.defaultTeam`) — the one used without `Umiak-Team` (S7 §7.4); personal by default, the user changes it in settings. If the user leaves the default team, it becomes the personal one again.
- Syncing teams from IdP groups is phase 2 (§18).

### 6.2 Roles

| Action | `member` | `owner` | Operator |
|---|---|---|---|
| All team sandboxes within scopes (S7 §7.5): create, view, exec, files, ports, stop/resume/fork/delete, snapshots | yes | yes | yes (any team) |
| Own SSH keys | yes | yes | yes |
| See team API keys (who created, scopes, expiry) | yes | yes | yes |
| Use team environments on create | yes | yes | yes |
| Create, change, delete team environments | no | yes | yes |
| Issue and rotate team API keys | no | yes | no |
| Revoke team API keys | no | yes | yes |
| Invite, remove members, change roles | no | yes | yes (in `/admin`) |
| Rename the team | no | yes | yes |
| Leave the team | yes | yes, if another `owner` remains | — |
| Delete a shared team | no | no | yes (§6.4) |
| Team quota | view only | view only | change (`/admin`) |

- A team always has at least one `owner`: the last `owner`'s role cannot be removed and the last `owner` cannot be deleted (checked in the server action and in the `beforeChange`/`beforeDelete` hook of the `memberships` collection, so `/admin` cannot bypass it either).
- Removing a member does not touch the team's sandboxes or the team keys they created (these belong to the team, S7 §7.2): the keys keep working, and `owner`s see them marked "creator left" (§9.8). Their open streams, PTYs, and SSH sessions in this team are closed immediately (C9, S4 §9.5).

### 6.3 Invitation by email

- An `owner` enters an email. If a user with this email exists, a membership with the chosen role is created. If not, a **placeholder** is created: a `users` row with this email, `active: true`, `lastLoginAt: null`, no personal team; and a membership. At first login JIT completes it (§5.3 step 3).
- No emails are sent [S8 decision]: on an internal platform people pass the dashboard link themselves; on the team page the placeholder is shown as "has not logged in yet".
- The email is not checked against the company domain: logging in is only possible through the IdP anyway. A placeholder that nobody has logged into for 90 days is a candidate for deletion by an operator (a list in `/admin`, filter `lastLoginAt is null`).

### 6.4 Deleting a team

Only an operator deletes, in `/admin` [S8 decision]: `web` has no access to runtime, and a team with live sandboxes cannot be deleted. Order: the operator in the "Operator" section (`/app/operator`, §9.10) sees the team's sandboxes and snapshots and deletes them; the team delete button in `/admin` (a custom action) before deleting calls, from the operator's browser, `GET /v1/sandboxes?allTeams=true&teamId=…&limit=1` and `GET /v1/snapshots` with `Umiak-Team` and refuses if anything exists. The operator also deletes the team's environments beforehand (`DELETE /v1/environments/...`), and the check accounts for them. A race is possible between the check and the deletion (someone managed to create a sandbox); it is not dangerous: `api` will no longer find memberships in the team, and such a sandbox is available only to the operator (the "Operator" section), who deletes it. This is a known limitation. When a team is deleted, the `beforeDelete` hook deletes its memberships and sets `revokedAt` on all its keys (with `NOTIFY umiak_identity`).

## 7. Payload collections (the `payload` schema)

General rules:
- Adapter `@payloadcms/db-postgres`: `schemaName: "payload"`, `idType: "uuidv7"` (S7 §17.3: UUID), `push: false`, migrations — §12. Public IDs (`usr_`, `team_`, `key_`, `sshk_`) are `packages/auth` codecs on top of these UUIDs.
- Payload table names must not collide with tables of the `runtime`, `tunnel`, `pgboss` schemas (the adapter's `schemaName` limitation is marked experimental). So collections are not named `snapshots`, `nodes`, `queue`, `job`, etc.; a test compares the table lists of all schemas after migrations (§15).
- Multi-valued fields (`groups`, `scopes`, `allowedSizes`, `capabilities`) are `json` or `select` with `hasMany`, without `array` fields with separate tables where this does not hinder the admin [S8 decision]: fewer tables and simpler hooks.
- GraphQL is off (`graphQL: { disable: true }`). Payload's REST is moved from `/api` to `/cms-api` (`routes.api`), because `/api/*` on `app.<domain>` belongs to `api` (S7 §5.1).
- Access (`access`) of all collections and globals: read and write only for an operator (`req.user?.isOperator`), unless the table below says otherwise. `api`, `worker`, and `web` server actions work through the Local API with `overrideAccess: true` and check rights themselves (§9.11).
- The `afterChange` and `afterDelete` hooks send `NOTIFY` (§8).

| Collection | Fields | Notes |
|---|---|---|
| `users` | `email` (unique, lower), `name`, `idpSubject` (Keycloak `sub`, unique, null for placeholders), `deactivatedReason` (`operator` \| `idp_disabled` \| `idp_deleted`, null), `deactivatedAt`, `preferredUsername`, `groups` (json, latest from the IdP), `isOperator` (read-only), `active`, `defaultTeam` → teams, `personalTeam` → teams, `lastLoginAt`, `createdAt` | auth collection (§5.4). Deletion is forbidden for everyone [S8 decision]: the rows are needed for `created_by` in runtime and for audit; `active: false` instead of deletion. The exception is placeholders with no login and no memberships |
| `teams` | `name` (1–64), `personal` (bool), `createdBy` → users, `quota` (group: `maxActiveSandboxes`, `maxRamMb`, `maxSavedSnapshots`; empty means the default value), `createdAt` | only an operator changes `quota`. Deletion — §6.4 |
| `memberships` | `user` → users, `team` → teams, `role` (`owner` \| `member`), `invitedBy` → users, `createdAt` | unique (`user`, `team`); the last-`owner` rule (§6.2) |
| `api-keys` | per S7 §17.3: `name`, `team`, `createdBy` → users (audit), `revokedByKey` (the key that revoked this key, or itself), `kind` (`team`; `sandbox` is reserved, S7 §7.2), `sandbox` (uuid, null), `secretHash` (unique, hidden in the admin), `prefix`, `last4`, `scopes` (json, S7 §7.3 names), `expiresAt` (required), `revokedAt`, `revokedBy` → users, `lastUsedAt`, `createdVia` | creation in the admin is forbidden (keys are issued only by `api` through `packages/auth`, S7 §17.3). An operator can only revoke (the button sets `revokedAt`, `revokedBy`) |
| `team-notices` | `team` → teams, `kind` (`member_deactivated`), `user` → users, `apiKeys` (json: id, name, prefix), `createdAt`, `acknowledgedBy` → users, `acknowledgedAt` | written by the Keycloak sync (§20.1); read and acknowledged by the team's `owner`s through the server action `acknowledgeNotice` |
| `ssh-keys` | per S7 §17.3: `user`, `name`, `publicKey`, `fingerprint` (unique), `type`, `lastUsedAt`, `createdAt` | an operator can delete |
| `templates` | `slug` (unique, `[a-z0-9-]{1,40}`), `name`, `description`, `os` (`linux` \| `windows`), `enabled`, `defaultSize` (slug), `allowedSizes` (slugs), `loginUser` (default `user`), `capabilities` (`exec`, `files`, `ssh`, `desktop`), `sortOrder` | S6 §5.11, S7 §13. Validation: `defaultSize ∈ allowedSizes`, the size slugs exist. The slug does not change after creation (`template_builds` and `sandboxes` store it) |
| `sizes` | `slug` (unique, e.g. `2gb`), `vcpu`, `memoryMb`, `sortOrder` | the slug does not change; a size referenced by a template or a pool target cannot be deleted |
| `pool-targets` | `template` (slug), `size` (slug), `providerId` (uuid, optional, S6 `providers`), `target` (0–50), `maxAgeHours` | unique (`template`, `size`, `providerId`). `providerId` is entered as text: the topology lives in runtime, the provider list is `umiak-admin` until phase 2 |
| global `platform-defaults` | S6: `ttlSeconds` (null), `maxTtlSeconds`, `idleTimeoutSeconds` (900), `stoppedRetentionDays` (null), `errorRetentionDays` (7), `recoverMinIntervalSeconds` (600); S7: `defaultTemplate`, `publicPortsEnabled` (true), `ssoPortPolicy` (`any`), `rateLimits {requestsPerSecond, burst, startsPerMinute}`; S8: `defaultQuota {maxActiveSandboxes, maxRamMb, maxSavedSnapshots}` (for personal teams and empty fields), `newSharedTeamQuota` (copied into `teams.quota` when a shared team is created), `maxOwnedTeamsPerUser` (3), `ssoPolicyEpoch` (read-only, §8) | defaults come from the first seed migration. PoC quota: 3 sandboxes, 6144 MB, 10 snapshots [S8 decision, from the 8 GB budget] |

`ConfigReader.teamQuota(teamId)` = the `teams.quota` fields, with `defaultQuota` where empty [S6 change S3]. A deleted or nonexistent team → a quota of zeros (create refuses with `quota_exceeded`).

## 8. Cache invalidation (`NOTIFY`)

| Channel | Payload | Sender | Listener |
|---|---|---|---|
| `umiak_identity` | `'<collection>:<id>'` | hooks of `users`, `teams`, `memberships`, `api-keys`, `ssh-keys` | `api` (session and key cache, S7 §7.2, §7.4), `web` (`resolveSession` cache) |
| `umiak_config` | `'<collection-or-global>:<id>'` | hooks of `templates`, `sizes`, `pool-targets`, `teams` (quota), global `platform-defaults` | `api`, `worker` (`ConfigReader`, S6 §5.11) |
| `umiak_routes` | `'*'` | the `platform-defaults` hook, if `publicPortsEnabled` or `ssoPortPolicy` changed | gateway (S4 §6.2, S7 O7) |
| `umiak_ssh_revoke` | `'user:<id>'`, `'member:<team>:<user>'`, `'key:<id>'`, `'team:<id>'` | hooks of `users` (became inactive), `memberships` (`afterDelete`), `api-keys` (`revokedAt`), `teams` (`afterDelete`) | gateway: close SSH sessions (S4 §9.5) |

- `NOTIFY` runs **inside the Payload request's transaction** (through the adapter's session for `req.transactionID`), so Postgres delivers it only after commit: a listener that receives the notification reads already-new data. If there is no transaction (a Local API call without `req`), the hook opens its own short transaction after the write. A `NOTIFY` error rolls the write back [S8 decision]: a silently stale cache is worse than an explicit error.
- **Order for `public`.** On `'*'` the gateway immediately re-requests routes from `api`, and `api` may not have processed `umiak_config` yet; any cache in `api` here creates a race after which the gateway caches the old answer. So `routes.lookup` reads `publicPortsEnabled`, `ssoPortPolicy`, and `ssoPolicyEpoch` **without a cache**: one global row from Payload per gateway cache miss [S7 change C7]. The load is small (the gateway caches routes), and the S4 acceptance "`403` within 1 s" is met.
- **Changing `ssoPortPolicy`.** On a switch `any` → `team`, the old `sso` cookies of outside users must stop working. The hook increments `PlatformDefaults.ssoPolicyEpoch`, and `routes.lookup` for `sso` routes returns `authEpoch = hosted_ports.auth_epoch + ssoPolicyEpoch` (the same value is written to `port_auth_codes`) [S7 change C7]. The sum grows monotonically, the gateway compares it with the epoch in the cookie (S4 §8.2) and changes nothing on its side.
- When `api` revokes a key through the API, it sends `umiak_identity` itself (S7 §7.2) — it is the same hook: `api` writes through the Local API.

## 9. The `/app` dashboard

### 9.1 Technology [S8 decision, approved]

- Next.js 16 App Router in the same application as Payload. The route group `(app)` sits next to `(payload)`.
- The server side of `/app` only renders the shell: `layout` gets the user through `payload.auth({ headers })` (the same strategy) and passes `{user, teams, isOperator}` to the client. Pages are client components.
- Data about sandboxes, teams, files, ports, snapshots, keys, SSH keys, environments, limits comes from `@umiak/sdk` in the browser, `baseUrl = "/api"` (the same origin), with the `Umiak-Team` header on every request. Caching, retries, and background refresh — TanStack Query.
- Teams and members, renaming a team, the default team — server actions on the Payload Local API (§9.11).
- UI: Tailwind CSS 4 + shadcn/ui (components are copied into `apps/web/src/components/ui`). Terminal and command output — xterm.js 6.
- Connection order: the ingress must serve HTTP/2 (S12), otherwise the browser runs into 6 connections per origin. The dashboard holds no more than one long-poll and two NDJSON streams per tab; the rest are closed when leaving the page.

### 9.2 URL and team

- The team is part of the path: `/app/t/<teamId>/...`, where `teamId` is the public `team_...`. Links that colleagues exchange open in the right team. `/app` redirects to the default team.
- A team not in the user's list (and the user is not an operator) — a "no access to the team" page.
- The browser cannot set headers on a WebSocket or on a plain download link. For these two cases the proxied listener accepts the team in the query `team=team_...` [S7 change C4].

### 9.3 Screen map

```
/app/t/<team>/                       Sandboxes (list)            [default]
/app/t/<team>/sandboxes/new          Create sandbox (dialog over list)
/app/t/<team>/sandboxes/<slug>       Sandbox detail, tabs: Overview | Terminal | Commands | Files | Ports | SSH | Env | Desktop*
/app/t/<team>/snapshots              Saved snapshots
/app/t/<team>/environments           Environment: list and selected details
/app/t/<team>/keys                   API keys
/app/t/<team>/settings               Team: name, members, roles, invite, quota and usage, leave
/app/account                         SSH keys, default team, profile (from IdP, read-only), sign out
/app/teams/new                       Create shared team
/app/operator                        Operator: all sandboxes, blocks (operators only)
* Desktop — only when the template has the `desktop` capability
```

Common frame: a fixed left panel 17.5rem wide with its own brand mark,
a team switcher, a divider, and the items Sandboxes, Snapshots, Environment,
API keys, Account, Team; the selected item is highlighted. Content is limited to 72rem and
centered. `[Operator]` and `[Admin]` are visible only to operators; Operator shows an
active state. The team switcher changes `<team>` in the path.

At width <1024px — a top bar with the team switcher and a menu button;
navigation opens as a side modal drawer. The skip link is available on mobile too.
Light/Dark is saved locally and applied by an inline bootstrap before the first paint;
notifications follow the theme. The Payload admin uses its own layout.

Environment shows **all** environments as a list: name, default/revision/updated, and
available actions. Selecting a row or the selector expands its env/secrets/files/repos;
after creation the new environment is selected. The New/Edit/Delete icons have accessible
labels; permissions and delete confirmation are kept.

Create opens an accessible, vertically scrollable dialog up to 32rem wide
over the list. Nested fields and hints shrink in width, without horizontal
clipping. Only real API fields; billing and missing features are not shown.

### 9.4 Sandbox list

```
Sandboxes                 2 of 3 active · 4096 of 6144 MB  [+ New sandbox]
[search name/slug] [State v] [label: k=v]
| Name / slug | Sandbox ID | State | Created (UTC) | Type | Health | Activity | Actions |
| ci-run-42   | sb_… [copy]| ready | absolute date | 2gb  | ok     | busy     | ›  …    |
| slug        |            |       |               | linux|        |          |         |
```

At width <1400px — cards with the same essential data: state under the name,
ID/copy, template/size, **Health and Activity**; degraded with a visible reason
`healthReason`. The … menu is at the top right. On mobile the search takes the full
width, New sandbox stays next to the heading, the quota is on a separate line.


- `GET /v1/sandboxes` with filters (S7 §8.2) and infinite scroll by `nextCursor`; quota and usage — `GET /v1/limits`.
- Refresh — polling every 5 s while the tab is visible, and immediately after an action. `deleted` are not shown.
- Transitional states (`creating`, `starting`, `stopping`, `deleting`) — with a spinner and the step of the active operation (`activeOperation.kind`). `error` — in red, with `error.message` in a tooltip. `degraded` — in yellow, with `healthReason`. Blocked by an operator — a lock icon with the reason.
- Row/card actions: › opens detail; the … menu contains Stop / Resume (by state), Fork, Open terminal, Delete (confirmation by typing the slug). A blocked Resume explains "Blocked by a platform operator".

### 9.5 Creating a sandbox

```
New sandbox
 Template   (o) linux — Ubuntu 24.04         ( ) windows — Windows 11 (disabled by operator: hidden)
 Size       [2gb · 2 vCPU · 2048 MB v]        (only allowedSizes of the template)
 From       (o) template  ( ) saved snapshot [web-stack v]
 Name       [ci-run-42        ]   Slug [auto: three words   ]  (optional, live validation)
 Environment [default: base v | none]                           (wave 2)
 Labels     [k=v] [+]
 Env vars   [KEY] [value] [+]        Secrets [KEY] [value •••] [+]   Secret files [upload] (name, mode, link path)
 Lifetime   TTL [none v]   Idle stop after [15 min v]
                                                              [Cancel] [Create]
```

- Catalog — `GET /v1/templates`, `GET /v1/sizes`, snapshots — `GET /v1/snapshots`.
- `POST /v1/sandboxes` with `Idempotency-Key` (the SDK sets it itself) → a transition to the sandbox page, where the operation progress is visible. Errors (`quota_exceeded`, `out_of_capacity`, `slug_taken`, `template_unavailable`) — in plain text at the form, `out_of_capacity` — with an offer to retry.
- Secrets in the form do not end up in the URL, in `localStorage`, or in client logs; the fields are `type=password` with a "show" button.

### 9.6 Sandbox page

Header: name, slug (with a rename button, `PATCH slug`), state, health, activity, template and version, size, `origin`, labels, TTL/deadline, idle timeout, buttons Stop/Resume/Fork/Recover/Extend/Save snapshot/Delete. Active operation — a strip with `kind` and `step`; `error` — a block with the code, message, and a Recover button, if applicable.

Live state: a long-poll loop `GET /v1/sandboxes/{slug}?waitFor=<all states except the current>&waitSeconds=30` (S7 §5.10); health and activity do not wake the long-poll, so there is also polling every 10 s. An operation started by a button is awaited through `waitForOperation`.

**Overview.** Properties, endpoints (`portUrlTemplate`, SSH command), the last 10 commands, published ports.

**Terminal.**
- The "New terminal" button → `POST /ptys {cols, rows}` (`Idempotency-Key`), then a WebSocket `wss://app.<domain>/api/v1/sandboxes/{sb}/ptys/{cmd}/connect?team=…` with subprotocol `umiak.pty.v1` (S7 §10.2) through the SDK's `sb.pty()`.
- xterm.js 6 + `addon-fit` (size by container, `resize` frame), `addon-web-links`, `addon-search`; copy and paste by browser means.
- Terminal tabs within the page. Open PTYs of the sandbox — `GET /commands?mode=pty&status=running`; after a page reload the dashboard reconnects to them with `tailBytes = 64 KiB`. A PTY without a client is closed by the agent after 10 min (S7 §10.1) — the hint at the tab close button says so ("Detach" leaves the process, "Close" sends `exit` through `kill`).
- Reconnection — the SDK (by offset); during a pause — a "reconnecting…" strip. Close codes `4409`/`4503` — plain text and a retry button.

**Commands.**
- Table of `GET /commands` (status, command, exit code, duration, who started, tags); status filter.
- "Run command": command line, cwd, user, env, timeout → `sb.start()` (detached, `Idempotency-Key`), then output.
- Output viewing — xterm.js in read-only mode (ANSI colors, large volume): `cmd.follow({ from: "start" | tail })` over NDJSON, stdout and stderr in one window, stderr highlighted (a "stdout/stderr only" toggle). `truncated` frames are shown as the line "… start of output evicted". For finished commands — `follow=false`. The "Download stdout/stderr" link goes to `/output?stream=…&offset=…&limit=4194304&team=…` (S7 §9.4) and returns a piece up to 4 MiB from the chosen offset (by default the last 4 MiB); there is no single link for the full output file in v1 [S8 decision].
- Kill / Signal for running ones.

**Files.**

```
/home/user/my-app                                   [Upload] [New folder] [Refresh]
 ..
 [d] src/             -          2026-10-29 12:00   drwxr-xr-x  user
 [f] package.json     1.2 KB     2026-10-29 11:58   -rw-r--r--  user   [Download] [Rename] [Delete]
```

- `GET /files/list` (with pagination), breadcrumbs, directory navigation, showing hidden files.
- Viewing a text file up to 1 MiB: `GET /files/content` with `Range: bytes=0-1048575`, shown as text in `<pre>` (never as HTML or through an `<iframe>`); a binary or larger file is download only. There is no editing in v1 (phase 2).
- Download — a link to `/api/v1/sandboxes/{sb}/files/content?path=…&team=…` (S7 returns `Content-Disposition: attachment`).
- Upload: drag-and-drop or a button; files up to 64 MiB — `PUT /files/content`, larger — `sb.files.upload()` in chunks with progress and resume. Whole directories are not uploaded (a hint about `umiak push`).
- Mkdir, Move/Rename, Delete (recursive — with confirmation).

**Ports.**

```
Hosted
 3000  https://quiet-otter-lamp-3000.umiak.example.com   access [token v]  [Copy URL] [Rotate token] [Unpublish]
Listening (not published)
 5173  node (vite)  127.0.0.1                                              [Publish...]
```

- `GET /ports`; publishing `PUT /ports/{port}` with a choice of `access` (`token`, `sso`, `public`) and `hostRewrite`; `public` is unavailable with a hint if `publicPortsEnabled` is off (`403 public_disabled`).
- The token and `urlWithToken` are shown **once** in a dialog after publishing or rotation (with a copy button and a note that it cannot be seen again). A blocked port — a lock and the reason.
- The "Open" link opens the URL in a new tab. Embedding the preview in an iframe is not in v1.

**SSH.** `GET /sandboxes/{sb}/ssh`: the connection command, `known_hosts` lines with a copy button, `hasKeys: false` — a link to the account's SSH keys.

**Env.** `GET /env`: a table of env (values visible), secret names (values — "•••", never delivered), secret files (name, mode, path). Editing is line by line through `PATCH /env` with merge semantics [S7 change C2]: change or delete one secret without knowing the rest. A response `delivered: false` → the hint "will apply at the next start".

**Desktop** (only with the `desktop` capability): a placeholder "the desktop will appear in S10" with a place for an iframe; the iframe contract is set by S10.

### 9.7 Saved snapshots

A table of `GET /v1/snapshots` (name, state, source, template and version, size, consistency, created); "Create sandbox from" → the create form with the snapshot selected; Delete. Saving is from the sandbox page (name, a warning about replacing a snapshot with the same name, S7 §13). There is no sharing between teams in phase 1 [S8 decision, approved].

Fork and Save snapshot of a running Windows sandbox (S9 §24.8). The OS is taken from the catalog `GET /v1/templates` by the sandbox's `template` (the sandbox resource has no OS field). Fork shows the confirmation "This stops the sandbox, takes the snapshot and starts it again. Running commands and sessions are interrupted." with the button "Stop and fork" and sends `forceStop: true`; the Save snapshot dialog shows the same warning, the button is "Stop and save snapshot". If the catalog is not loaded or the template is unknown, the response `409 snapshot_requires_stop` shows the same warning, and the next request goes with the flag. A failed restart of the source is visible as its `error` (`resume_failed`).

### 9.8 API keys

```
API keys
[Team keys: framed intro]
[Key name                  ] [Expires in: 90 days]
Access: [read-only / ci / full / custom scopes, inline preset rows]
[+ Create key]
 name        prefix…last4   scopes  created by               expires     last used
 ci-main     umiak_a1B2…9xYz  ci      ilia@… (left the team)   2027-01-27  2 min ago   [Rotate] [Revoke]
```

- Keys are **team** keys [Ilia's decision 2026-10-29, S7 change C5]: they belong to the team, the creator is recorded for audit. `GET /v1/api-keys` is visible to all members; the inline Create key form and Rotate are for `owner` only; Revoke follows permissions (§6.2). People do not need keys for the CLI: the page suggests `umiak login` (Keycloak, S7 §7.6).
- If the creator is deactivated or left the team, the key is marked, and the key keeps working; above the table is the sync notice (§20.1) with the list of such keys and a "revoke selected" button.
- Creation is an inline form inside the team card (not a separate New key dialog): name, preset (`read-only`, `ci`, `full`) or a choice of scopes by checkboxes, expiry (default 90 days, maximum 365, S7 §7.2). The secret is shown once in a dialog with copying and examples `export UMIAK_API_KEY=…` and `umiak login --key-stdin`.
- The name and expiry fields are aligned; Access labels a continuous frame of presets. The selected row is highlighted, scope chips use the regular font and a neutral background.
- Rotate (a new secret in the same dialog), Revoke (confirmation). Revoked and expired keys are collapsed at the bottom.

### 9.9 Account and team

- **SSH keys** (`/app/account`): `GET/POST/DELETE /v1/ssh-keys`; adding is pasting a public key, errors `ssh_key_in_use` and unsupported type are shown as text.
- **Default team** — a server action.
- **Team** (`/app/t/<team>/settings`): name (rename — `owner`), members (email, name, role, "has not logged in yet", last login), invite by email with a role, change role, remove, leave; quota and usage (`/v1/limits`). A `member` sees the member list without actions.
- **New shared team** (`/app/teams/new`): name → server action → transition to it.

### 9.10 The "Operator" section [decision Q3]

`/app/operator`, only for a session with `isOperator`:
- All sandboxes of all teams: `GET /v1/sandboxes?allTeams=true` with filters `teamId`, `state`, `q` [S7 change C3]; a team column (the team name is taken from Payload in the server `layout`, the team list is passed to the client).
- Actions: Block / Unblock a sandbox (reason `operator` or `abuse` and a note), Block / Unblock an individual port, Stop, Delete (with the sandbox team's `Umiak-Team`, S7 §7.4). Navigation to the sandbox page of any team.
- A link to `/admin` for configuration.
- Pool and node state is phase 2; until then `umiak-admin pool status` (S6 §15.3).

### 9.11 Server actions

| Action | Who | What |
|---|---|---|
| `createTeam(name)` | anyone, limit `maxOwnedTeamsPerUser` | team + `owner` membership |
| `renameTeam(teamId, name)` | `owner`, operator | |
| `inviteMember(teamId, email, role)` | `owner`, operator; not into a personal team | a placeholder user if needed + membership |
| `setRole(membershipId, role)` | `owner`, operator | last-`owner` rule |
| `removeMember(membershipId)` / `leaveTeam(teamId)` | `owner`, operator / the member themselves | last-`owner` rule; a personal team cannot be left |
| `setDefaultTeam(teamId)` | the user themselves, a team from their list | |
| `acknowledgeNotice(noticeId)` | `owner` of the notice's team | sets `acknowledgedBy`, `acknowledgedAt` |

Every action: the user comes from `payload.auth({ headers })` (the same strategy), rights are checked against `memberships` in the same transaction, input is validated with zod, the write goes through the Local API with `overrideAccess: true` and `req` (so the `NOTIFY` hooks run inside the transaction). The response is `{ok}` or `{error: {code, message}}` with the codes `forbidden`, `not_found`, `validation`, `last_owner`, `team_limit`, `already_member`.

## 10. Environments (second wave of the MVP) [decision Q2]

### 10.1 Purpose

An environment is a named set of team settings that a new sandbox receives at creation: `env`, `secrets`, `secretFiles` (the same three sets as a sandbox has, S7 §8.3), a list of repositories `repositories`, and the flag `excludeOwnerSecrets`. Git credentials will be added later (S13).

- **`repositories`** — `[{url, branch?, path?}]`, up to 20: `url` is `https://…` or `ssh://…`/`git@host:org/repo.git` with no credentials in the URL; `branch` is a branch or tag; `path` is a directory relative to the `user`'s home directory (by default the repository name). In the MVP the list is **only stored and returned** by the API: cloning at claim and access to private repositories belong to S13, phase 2.
- **`excludeOwnerSecrets`** — "do not pass the owner's personal secrets into the sandbox" (of whoever creates the sandbox): credentials tied to the user, not to the team or environment (the future `sandbox` key in the VM — S7 §7.2, personal AI credentials — S16, personal git tokens — S13). In the MVP the platform puts no such secrets into the VM, so the flag is only stored; phase 2 features must honor it. The flag is also in `POST /v1/sandboxes`; `true` takes effect if it is `true` in the request or in the chosen environment. The sandbox stores the result, and fork inherits it.

- A team can have one default environment.
- On create (`POST /v1/sandboxes`) the `environment` field: a name → that environment; absent → the team's default environment, if any; `null` → none [S7 change C1].
- Values are **copied** into `sandbox_secrets` on create; the values from the request itself are layered over each set (the same key — the request wins; secret files — by name). The S7 §8.3 limits are checked on the merge result.
- There are no versions or auto-update, unlike boat [S8 decision]: changing an environment affects only new sandboxes. A sandbox remembers which environment and which revision it was created from (`environment: {id, name, revision}` in the Sandbox resource), and the dashboard shows "the environment changed after creation". Re-applying is phase 2.
- Fork inherits the source's env and secrets (S6 §7.7), not the environment; the `env`, `secrets`, `secretFiles` values from the fork request are layered on top (S7 §8.2). Create from a saved snapshot takes the environment like an ordinary create.
- Deleting an environment does not touch sandboxes created from it.
- **Environment secrets are not hidden from team members** [S8 decision after review, as in boat]: anyone who can create a sandbox and run a command in it will read `env` inside. The `owner` role for writing protects integrity (who changes what everyone will receive), not confidentiality. The default environment applies to all creates of the team, including creates by agent and CI API keys: that is its point (an agent gets the needed keys without passing them in each request). For existing clients behavior does not change until an `owner` assigns a default environment; a client that does not need it passes `environment: null`.

### 10.2 API [S7 change C1]

| Method and path | What | Scope |
|---|---|---|
| `GET /v1/environments` | the team's list: `{id, name, isDefault, revision, envKeys, secretKeys, secretFiles[{name, mode, linkPath, sizeBytes}], repositories, excludeOwnerSecrets, createdAt, updatedAt, updatedBy}` | `environments:read` |
| `GET /v1/environments/{environment}` | the same + `env` values (not secrets) | `environments:read` |
| `POST /v1/environments` | `{name, isDefault?, env?, secrets?, secretFiles?, repositories?, excludeOwnerSecrets?}` → `201` | `environments:write` + role `owner` |
| `PATCH /v1/environments/{environment}` | `{name?, isDefault?, env?, secrets?, secretFiles?, repositories?, excludeOwnerSecrets?}`; sets are merged, `null` deletes a key (like `PATCH /env`, C2); `repositories` is a full replacement; `revision+1` | `environments:write` + `owner` |
| `DELETE /v1/environments/{environment}` | `204` | `environments:write` + `owner` |

- `{environment}` is an ID (`env_...`) or a name; the name is `^[a-z0-9][a-z0-9-]{0,62}$`, unique within the team.
- Scopes `environments:read` (in the presets `read-only`, `ci`, `full`) and `environments:write` (only in `full`), S7 §7.3. For writes (`environments:write`) the `member` role gets `403 forbidden` (`details.reason: "role"`) even if the scope is present: the role is checked for sessions and for Keycloak JWTs. A team key has no role, the scope is enough for it (S7 §7.5).
- Secret values are never returned; the `api` logger strips `env`, `secrets`, `secretFiles` (as in S7 §8.3).
- The CLI (`umiak env-sets list|show|create|set|unset|rm`, `umiak create --environment`) and the SDK get this from OpenAPI; the CLI command names are up to the S7/S8 implementer.

### 10.3 Storage [S6 change S1]

```
environments(                       -- schema runtime, migration in the S8 range (§17.3)
  id uuid pk,                       -- uuidv7, public env_...
  team_id uuid, name text,
  is_default bool,
  revision int,                     -- +1 on every change
  env_keys text[], secret_keys text[], secret_files jsonb,  -- names and metadata only, for listing
  repositories jsonb,               -- [{url, branch, path}], stored only in the MVP (S13)
  exclude_owner_secrets bool,       -- default false
  key_version int, nonce bytea, ciphertext bytea,           -- AES-256-GCM blob {env, secrets, secretFiles}, S6 §13.1
  created_by uuid, updated_by uuid,
  created_at, updated_at, deleted_at null)
unique (team_id, name) where deleted_at is null
unique (team_id) where is_default and deleted_at is null
```

- Encryption and the key ring are as for `sandbox_secrets` (S6 §13.1), AAD = `environment:<id>:v<keyVersion>`; key rotation re-encrypts these rows too (the same cleanup controller).
- The service is `EnvironmentService` in `packages/core` (`list`, `get`, `create`, `patch`, `delete`, `resolveForCreate(teamId, name|undefined|null)`); `SandboxService.create` calls `resolveForCreate` and merges the sets before encrypting `sandbox_secrets`.
- Values do not end up in `operations.request`, `idempotency_keys.response`, logs, or metrics (S6 §13.1). The create idempotency hash is computed from the request body (with the environment name, without its values).
- `sandboxes` gets `environment_id uuid null`, `environment_revision int null`, `exclude_owner_secrets bool not null default false` (not added in the MVP, §21.1, §21.7).

## 11. Propagation times for changes

| Change | Where it applies | Time |
|---|---|---|
| Revoking a key, removing a member, deactivating a user in `/admin` | new `api` requests | immediately via `NOTIFY`, no later than 30 s (S7 §7.2) |
| Same | already open `api` streams and PTYs | closed on `NOTIFY` (an `error` frame `unauthorized` / close `4401`) [S7 change C9] |
| Removing a member, deactivating a user, revoking a key | gateway SSH sessions | closed immediately (`NOTIFY umiak_ssh_revoke`, S4 §9.5); new logins are rejected immediately |
| Deactivating a user in `/admin` | `web`, `api` sessions | immediately via `NOTIFY`, no later than 30 s |
| Deactivating a user | `sso` ports | up to 12 h (gateway cookie, S4 §8.4); immediate revocation is phase 2 (§18) |
| Disabling a user or removing a group in Keycloak | browser (`web`, `api`) | no later than `cookie-refresh` (5 min) + 30 s of cache (§5.1) |
| Disabling or deleting a user in Keycloak | CLI, SDK, MCP (JWT) | the refresh is rejected immediately; an issued access token lives up to 5 min, and after the sync (≤ 5 min, §20.1) `api` rejects it too |
| Same | `users.active`, streams, PTYs, SSH | sync ≤ 5 min (§20.1), then as deactivation in `/admin` |
| Same | team keys that the user created | unchanged; `owner`s get a notice (§20.1) |
| Templates, sizes, quotas, pool targets, `PlatformDefaults` | `api`, `worker` | immediately via `NOTIFY`, no later than 10 s (S6 §5.11) |
| `publicPortsEnabled`, `ssoPortPolicy` | gateway | ≤ 1 s (§8) |
| Blocking a sandbox or port by an operator | gateway, SSH | immediately (the `umiak_routes` trigger, S4 §6.2) |

## 12. Migrations of the `payload` schema

- Payload migrations (`payload migrate:create`) live in `packages/payload/src/migrations` and are committed; `push: false` everywhere, in dev too [S8 decision]: the schema is the same in dev and prod, and CI catches drift (`payload migrate:create --skip-empty` with no changes → empty).
- The first migration creates the `payload` schema, the tables, the seed of `platform-defaults`, the seed of the `linux` template and the `2gb` size (PoC, S6 §9.1), the pool target `linux/2gb = 1` (not seeded, §21.3).
- Migrations are applied by **one** Kubernetes Job (`web-migrate`, the `web` image, command `payload migrate`; in the implementation — its own runner, §21.3) before rolling out `web`, `api`, `worker` (a Helm hook or a pipeline step, S12). The Payload adapter takes no advisory lock, so migrations are not run at pod start (`prodMigrations` are not used). The order relative to the runtime migrations (`db/migrations`, the S6 runner) is arbitrary: the schemas do not reference each other with foreign keys.
- **Expand/contract** [S8 decision after review]: a migration does not break the previous code version (new columns are nullable or have a default; removal and renaming go in a separate release after the old code is gone). So during a rolling deploy the old pods keep working on the new schema.
- `api`, `worker`, and `web` check at startup and in readiness that **all migrations known to their code are applied** (newer ones unknown to the code are acceptable); otherwise `/readyz` (`/healthz` for `web`) returns an error: a new pod does not accept traffic until the migration Job is done.
- Postgres roles [S8 decision, configured by S12]: the migration Job uses a separate role `umiak_payload_migrate` (DDL in `payload`). `umiak_web` has DML in `payload`, except `INSERT` into the tables `api_keys` and `ssh_keys` (`web` never creates them), with no access to `runtime`, `tunnel`, `pgboss`. `api` and `worker` have DML in `payload` (the Local API writes keys, SSH keys, users).

## 13. Local development

- The **dev proxy** `apps/web/dev/auth-proxy.ts` (Node, no dependencies beyond `node:http`) imitates ingress + oauth2-proxy:
  - listens only on `127.0.0.1:3000` (refuses other addresses);
  - on each request strips any sent `X-Auth-Request-*` and sets them from the dev cookie `umiak_dev_identity`;
  - `/__dev/login` — an identity picker page: email, name, groups (ready buttons "user", "second user", "operator"); `/__dev/logout`;
  - routes as in prod (§5.1): `/api/*` → `127.0.0.1:8081` without `/api`, `/umiak-auth/*` → `127.0.0.1:8081`, the rest → `next dev` on `127.0.0.1:3001`; WebSocket upgrade is proxied.
- `web` and `api` have no flags or code branches for "dev auth": they receive the same headers as in prod. The `dev/` directory is excluded from the image build (`.dockerignore`, a CI check that `.next/standalone` has no `auth-proxy`).
- `pnpm --filter @umiak/web dev` brings up `next dev` and the proxy; Postgres comes from the shared S6 dev environment (docker compose or testcontainers); `api` with `PayloadIdentityStore` per the S7 instructions. Without `api`, `/admin` and the team pages work, and the sandbox dashboard shows "API unavailable".
- `UMIAK_OPERATOR_GROUPS` in dev is `umiak-operators`.
- CLI in dev: a team key (`umiak login --key-stdin`) or Keycloak from the shared dev environment (`kc.sh start-dev` in a container with the `umiak` realm imported from `infra/keycloak/`, S12) to test the device grant and JWT.

## 14. Build and deploy (the shape; details — S12)

### 14.1 Image

- Next `output: "standalone"`, image `umiak-web` (Node 26 slim, unprivileged user). The same image contains the Payload CLI for the migration Job.
- Configuration through env: `DATABASE_URL`, `PAYLOAD_SECRET` (Payload requires it although JWTs are not used), `UMIAK_APP_ORIGIN`, `UMIAK_OPERATOR_GROUPS`, `UMIAK_UMIAK_DOMAIN` (for CSP `frame-src`), `UMIAK_API_PUBLIC_URL` (hints in the UI). `web` has no data secrets (`UMIAK_DATA_KEYS_FILE`).

### 14.2 Kubernetes

- Deployment `web`: 2 replicas, exec readiness/liveness probes on `/healthz` (§5.1), `terminationGracePeriodSeconds: 30`.
- Job `web-migrate` (§12).
- NetworkPolicy: ingress to `web :3000` only from oauth2-proxy pods (no node addresses); egress — Postgres.
- `api` and `worker` link `@umiak/payload` as a library; they need `DATABASE_URL`, `PAYLOAD_SECRET`, `UMIAK_OPERATOR_GROUPS` (`api`).
- oauth2-proxy: upstream mode, alpha config (§5.1), `--cookie-name=__Host-oauth2_proxy`, `--upstream-timeout ≥ 660s` (S7 §17.6), WebSocket. Ingress: HTTP/2, response buffering off for NDJSON (S7 §17.6).

### 14.3 The `web` data boundary

`web` reads and writes only the `payload` schema. It gets runtime data only from the user's browser through `api`. This is an architecture rule ("work with a sandbox only through `apps/api`") and damage limitation: `web` has no data keys and no access to `runtime`, so encrypted sandbox and environment secrets cannot be bulk-exported from it. There is no full isolation, and this is recorded honestly: a compromised `web` can write itself a membership in any team and then get access to its sandboxes through the API (including reading env from inside). The ban on `INSERT` into `api_keys`/`ssh_keys` (§12) only prevents it from issuing a key bypassing `api`.

## 15. Tests and acceptance

**Unit (vitest):**
- header parsing (§5.2): email case, comma-separated and repeated groups, empty values;
- `resolveSession`: creation, placeholder → full user, deactivated, `idpSubject` change, groups → `isOperator` and back, no extra writes on repeated requests;
- server action rights per the §6.2 table, the last-`owner` rule, the team limit, inviting into a personal team is forbidden;
- merging an environment with the create request and the limits after the merge (in `packages/core`).

**Integration** (Postgres 18, Payload with migrations, without Next):
- simultaneous first requests of one user (10 in parallel) → one user, one personal team;
- **the `IdentityStore` contract suite** in `packages/auth` — one set of tests that `StaticIdentityStore` (S7) and `PayloadIdentityStore` both pass; likewise for `ConfigReader` (`StaticConfigReader` and `PayloadConfigReader`);
- `NOTIFY`: a listener gets the notification only after commit and reads the new data; a rolled-back write sends no notification; changing `publicPortsEnabled` yields `umiak_config` and `umiak_routes '*'`;
- access to Payload REST (`/cms-api/*`): a user without the operator group gets `403` on read and write of every collection and global; creating `api-keys` in the admin is forbidden for everyone;
- the tables of the `payload` schema do not overlap by name with `runtime`, `tunnel`, `pgboss` after all migrations;
- migrations: a clean DB → the latest version; a second run does nothing; schema drift in CI.

**E2E** (Playwright: dev proxy, `web`, `api` with `PayloadIdentityStore`, `packages/core` with a fake worker and the fake agent of S7 §16):
- a new user logs in → personal team → create → `ready` → terminal: echo, resize, page reload and reconnect without losing output;
- command: start, live output, kill; files: uploading 100 MiB in chunks, download, viewing text, rename, delete;
- port: publishing `token` (the token is visible once), rotation, `public` with the switch off — a clear error;
- API key: create → `curl https://…/v1/me` with it works → revoke → `401`;
- teams: an `owner` invites an email → the second user logs in and sees the team's sandboxes; a `member` does not see management buttons, and a direct server action call gives `forbidden`;
- operator: sees another team's sandbox, blocks it → the gateway route (fake or S4) gets `blocked`; the owner gets `sandbox_blocked` on exec, fork, save snapshot, resume, rename and can only read, stop, delete; a blocked port cannot be removed and re-published; a non-operator gets `403` on `/app/operator`, `/admin`, and `GET /v1/sandboxes?allTeams=true`; neither the operator's Keycloak JWT nor a team key gives operator rights;
- `ssoPortPolicy` `any` → `team`: an outside user's old `sso` cookie stops working (the epoch grew); turning off `public` → `routes.lookup` immediately returns `blocked`;
- revoking a key with an open stream and PTY → the stream gets `error unauthorized`, the PTY closes with `4401`;
- login: changing the email in the IdP with the same `sub` updates the user; a different `sub` with a taken email → `403`;
- Keycloak (a test realm in a container): logging in through the browser and `umiak login` give one user by `sub`; disabling a user in Keycloak → after a `ctl-idp-sync` pass `active: false`, the open stream gets `error unauthorized`, the PTY closes with `4401`, the SSH session is closed, `owner`s see a notice with the list of the user's team keys, the keys keep working; deleting a user → `idp_deleted`; enabling back → active again; a Keycloak response with an empty list deactivates nobody (`umiak_idp_sync_aborted`);
- team key: the creator left the team → the key works, the key is marked; a `member` does not see the issue buttons;
- environments (second wave): creation by an `owner`, create with it, values in the guest (the fake agent received the sets), a `member` cannot change it, secret values nowhere in responses.

**Security:**
- a request to `web` without `X-Auth-Request-Email` → `401`; a client-sent `X-Auth-Request-Email` is stripped by the proxy (the dev proxy repeats the oauth2-proxy behavior; on the S12 stand — the same test against a real oauth2-proxy);
- a server action and `POST /cms-api/*` with a foreign `Origin` → `403`;
- no response of `web` or `/cms-api` contains `secretHash`, secret values, or port tokens (a search over E2E responses);
- the `umiak-web` image does not contain `auth-proxy`.

**S8 readiness criterion (MVP, first wave):** unit, integration, and E2E tests pass; `api` works with `PayloadIdentityStore` and `worker`/`api` with `PayloadConfigReader` on the `pve` stand; the scenario "new user → terminal in a minute" passes manually through a real oauth2-proxy and IdP (S12).

## 16. Libraries

Checked 2026-10-29 (`npm view`, GitHub releases); re-check during implementation.

| Purpose | Library | Version |
|---|---|---|
| CMS and admin | `payload`, `@payloadcms/next`, `@payloadcms/ui` | 3.92.1 |
| Postgres adapter (`idType: "uuidv7"`, `schemaName`) | `@payloadcms/db-postgres` (inside — `drizzle-orm` 0.45.2, `pg` 8.20.0) | 3.92.1 |
| Framework (Payload peer: `>=16.3.3 <17`) | `next` | 16.4.3 |
| UI | `react`, `react-dom` | 19.3.1 |
| Styles and components | `tailwindcss` / `shadcn` (CLI) | 4.3.3 / 4.23.0 |
| Client-side data | `@tanstack/react-query` | 5.105.0 |
| Terminal and output | `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`, `@xterm/addon-search` | 6.0.0, 0.11.0, 0.12.0, 0.16.0 |
| API client | `@umiak/sdk` (S7) | workspace |
| Validation | `zod` | as in S7 (4.6.7) |
| E2E | `@playwright/test` | 1.64.1 |
| Unit | `vitest` | 5.0.5 |
| Authentication proxy (S12) | oauth2-proxy | v7.15.5 |

The versions of `drizzle-orm` and `pg` inside the Payload adapter (0.45.2, 8.20.0) lag those chosen by S6 (0.45.4, 8.23.1); one major line, no conflict, pnpm keeps both. The implementer re-checks during implementation.

Rejected:
- Auth.js / NextAuth in `web`: a second login next to oauth2-proxy, its own cookie on the main domain; oauth2-proxy is already needed by `api` and port SSO.
- Payload's local strategy (passwords) and Payload's JWT cookie: an extra account and a cookie that would have to be protected per S4 §14.1.
- Payload's UI components (`@payloadcms/ui`) for `/app`: they are designed for the admin and pull in its context; shadcn/ui is easier to customize.
- Monaco for viewing files and logs: heavy; `<pre>` and xterm.js are enough for v1.

## 17. Changes in other specs

### 17.1 S7 (`apps/api`, `packages/auth`, SDK, CLI)

| # | What | Details |
|---|---|---|
| C1 | Environments: the `/v1/environments` endpoints, scopes `environments:read` and `environments:write` (S7 §7.3), the fields `environment` and `excludeOwnerSecrets` in `POST /v1/sandboxes`, the fields `environment {id, name, revision}` and `excludeOwnerSecrets` in the Sandbox resource, the ID prefix `env_` | §10.2 |
| C2 | `PATCH /v1/sandboxes/{sandbox}/env` — a merge by keys (`{env?: {K: v \| null}, secrets?: {K: v \| null}, secretFiles?: {name: file \| null}}`, `null` deletes), the response as for `PUT /env`. `PUT /env` stays | §9.6 Env |
| C3 | Operator endpoints, only for an operator session (`403 forbidden` for everyone else and for any API keys): `GET /v1/sandboxes?allTeams=true[&teamId=]`; `POST /v1/sandboxes/{sandbox}/block {reason: "operator" \| "abuse", note?}` and `/unblock`; `POST /v1/sandboxes/{sandbox}/ports/{port}/block {reason, note?}` and `/unblock`. In the Sandbox and HostedPort resources — `blocked`, `blockReason`. Only an operator can lift a block. The note goes to `sandbox_events`. Semantics below | §9.10 |
| C4 | The proxied listener accepts the team in the query `team=team_...` for `GET`/`HEAD` and WebSocket upgrade (the browser sets no headers). If both the header and the query are present, they must match (`400 validation`) | §9.2 |
| C5 | Team keys (S7 §7.2): issued and rotated by a human `owner`, visible to all members, revoked by an `owner`, an operator, or a key with `keys:admin`; the key does not depend on the creator | §9.8 |
| C6 | `Principal.isOperator = true` only for a browser session; for a principal by API key or Keycloak JWT it is always `false`. `ssh/authorize` lets in only members of the sandbox's team (the "or an operator" rule from S7 §12.1 is removed) | §5.5 |
| C7 | `routes.lookup` reads `publicPortsEnabled`, `ssoPortPolicy`, `ssoPolicyEpoch` without a cache; for `sso` routes `authEpoch = hosted_ports.auth_epoch + ssoPolicyEpoch`, the same value goes to `port_auth_codes` and the SSO check (S7 §7.7) | §8 |
| C8 | `resolveSession` for a deactivated user → `403 forbidden` (`details.reason: "user_disabled"`), not JIT; `SessionIdentity` has `defaultTeamId`; `X-Auth-Request-User` (`sub`) is required, the lookup is §5.3 | §5.3 |
| C9 | `api` keeps a registry of open NDJSON streams and PTY WebSockets by `(userId, apiKeyId, teamId)` and on `NOTIFY umiak_identity` closes those whose principal no longer passes the check (key revoked, member removed, user deactivated): an `error` frame with `code: unauthorized`, `retryable: false` / close `4401`. SSH sessions in the same cases are closed by the gateway on `NOTIFY umiak_ssh_revoke` from the hooks (§8, S4 §9.5) | §11 |
| C10 | Keycloak: `api` accepts a Keycloak access token (S7 §7.10) and calls the same `resolveSession`; `/v1/meta.oidc`. The `owner_inactive` rule (30 days without a browser session) is cancelled: the Keycloak sync replaces it (§20.1) | §20.1 |

**Block semantics (C3)** [S8 decision after review]:
- **A sandbox is blocked:** all its routes reach the gateway with `blocked: true` and its `blockReason` (S4 §6.1); `ssh/authorize` refuses. For everyone except an operator only reads (get, list, operations, command list, command output, file read and list, `GET /env`, `GET /ports`) and `stop`, `delete` are allowed. Everything else is `403 forbidden` with `details.reason: "sandbox_blocked"`: exec and PTY, file writes, publishing and changing port modes, `resume`, `fork`, `recover`, `extend`, save snapshot, `PUT`/`PATCH /env`, `PATCH` (including slug). So a block cannot be bypassed through fork, snapshot, or rename.
- **A port is blocked:** the gateway gets `blocked: true`. For everyone except an operator, `PUT /ports/{port}`, `rotate-token`, and `DELETE /ports/{port}` of this port are `403 forbidden` (`details.reason: "port_blocked"`): the block survives an attempt to remove and re-publish the port.
- An operator can do everything; `unblock` lifts the restrictions immediately (the `umiak_routes` trigger).

Implementer: the C1–C10 changes are made by the S8 implementer in `apps/api` (per the S7 §20.2 precedent), coordinating with the `s7-impl` track; if `s7-impl` is not yet merged, they hand them to it as additions to the frozen interface. OpenAPI is regenerated, `oasdiff` must find no breaking changes (everything is additions). C6 and the block semantics are clarifications of behavior, not of the API shape.

### 17.2 S6 (`packages/core`, `db/migrations`)

| # | What |
|---|---|
| S1 | The table `runtime.environments` and `EnvironmentService` (§10.3); in `sandboxes` — `environment_id`, `environment_revision`, `exclude_owner_secrets`; `create` accepts `environment` and merges the sets before encryption; data key rotation re-encrypts `environments` too |
| S2 | `patchEnv(p, id, patch)` — a merge by keys inside `core` (decrypt, merge, encrypt), with delivery to the agent as for `updateEnv` |
| S3 | `teamQuota(teamId)` = `teams.quota` with `PlatformDefaults.defaultQuota` substituted for empty fields; a nonexistent team → zeros |
| S4 | Blocks: the columns and trigger are already part of the S7 §20.2 item 3 addition (`hosted_ports.blocked`, `block_reason`, "sandbox block by an operator"); S8 does not duplicate them but refines: in `sandboxes` — `blocked bool`, `block_reason text null`, `blocked_at`, `blocked_by uuid null`; the `umiak_routes` trigger (S7 O7) also fires on changes of these fields; `routes.lookup` returns `blocked` = port block OR sandbox block OR `public` with `publicPortsEnabled` off, the reason in this order; the block semantics checks (§17.1) in `SandboxService`; `list` with `allTeams` for operators. Whoever implements first (S7 or S8) depends on track readiness, the second one reuses it |
| S5 | `ConfigReader.defaults()` also returns the S7/S8 fields of `PlatformDefaults` (§7) |
| S6 | The controller `ctl-idp-sync` in `apps/worker` (queue `exclusive`, every 300 s, like the S6 §15.1 controllers); the logic lives in `@umiak/payload` (§20.1) |

### 17.3 Runtime migrations

Per the S7 §20.2 precedent: changes to S6 tables (`sandboxes.environment_*`, `sandboxes.blocked*`, triggers) go as migrations in the S6 range **0200–0299**, coordinated with `s6-impl`. The new S8 tables (`environments`) go in the range **0400–0499** [S8 decision, continuing S6 §5.12 / S7 O6].

There are no blocks in Payload [clarification of S7 §17.3]: blocks are runtime data, written by `api` through the operator endpoints C3. Only the global `publicPortsEnabled` lives in Payload.

### 17.4 S4

`blockReason` already contains `operator`, `public_disabled`, `abuse` (S4 §6.1); `'*'` in `umiak_routes` is sent by the S8 hook (§8). New: login with SSH certificates and `NOTIFY umiak_ssh_revoke` (S4 §9.2, §9.5).

### 17.5 S12

Keycloak in the cluster next to the control plane, realm `umiak` and the clients per architecture §10; the `umiak-worker` client secret for `worker`. oauth2-proxy in upstream mode with the alpha config and the `keycloak-oidc` provider (§5.1): headers from claims (`X-Auth-Request-User` = `sub`), path routing, `--cookie-refresh=5m`, `--cookie-expire` ≤ 12 h, only a verified email; HTTP/2 on the ingress; the Payload migration Job before rollout; Postgres roles (§12); exec probes and a NetworkPolicy for `web` only from oauth2-proxy (§5.1, §14.2); the operator group (`UMIAK_OPERATOR_GROUPS`) in the IdP.

### 17.6 `docs/architecture.md`

§3: team environments are stored in `runtime` encrypted, the configuration collections are listed more fully; §10: the operator role applies only in a browser session, oauth2-proxy routes `/api/*` to `api` and the rest to `web`.

## 18. Phases

| Phase | What is included |
|---|---|
| **MVP, first wave** | `packages/payload` (collections, strategy, JIT, hooks), `PayloadIdentityStore`, `PayloadConfigReader`, migrations and the Job; `/admin`; `/app`: sandbox list and creation, sandbox page (overview, terminal, commands, files, ports, ssh, env, desktop placeholder), snapshots, API keys, SSH keys, teams and members, the "Operator" section; changes S7 C2–C10 and S6 S2–S6; Keycloak sync (§20.1); the dev proxy; the image and deploy shape |
| **MVP, second wave** | Environments: S7 C1, S6 S1, the page `/app/t/<team>/environments`, selection on create |
| **Phase 2** | Syncing teams with Keycloak groups (groups → teams); brokering a corporate IdP in Keycloak; pool and node state in the "Operator" section; immediate revocation of a user's `sso` sessions (`authEpoch+1` on their routes); re-applying an environment to a live sandbox; a file editor; port preview in an iframe; the full command output file; the desktop (S10); cloning environment repositories (S13); an audit of actions in `/admin` |

## 19. Left to the implementer

- The file layout in `apps/web` and `packages/payload`; the markup and visual style of `/app` (no external fonts or CDNs, everything from its own origin).
- The exact list of CSP directives, taking the Payload admin requirements into account.
- How exactly to run `NOTIFY` in the request's transaction through the Payload adapter API (a session by `req.transactionID`); if the adapter API changes, an equivalent way with the same "only after commit" property.
- How the strategy distinguishes Payload admin requests from `/app` for the "no access" page (a custom `unauthorized` view).
- Whether `cookiePrefix: "__Host-payload"` and the admin's service cookies work with this prefix (§5.4).
- CLI command names for environments.
- `web` metrics (minimum): requests by route and status, authentication failures by reason, `resolveSession` duration, server action errors by code.

## 20. Offboarding and open questions

### 20.1 Offboarding: sync with Keycloak [Ilia's decision 2026-10-29, option A]

- **Browser.** A user disabled in Keycloak loses `/app` and `/admin` at the next oauth2-proxy `cookie-refresh` (5 min, §5.1).
- **CLI, SDK, MCP.** People have no long-lived personal keys (S7 §7.6): a disabled user cannot refresh the token, and access ends within the access token lifetime (5 min).
- **Team keys** belong to the team and are not disabled when their creator leaves (S7 §7.2); the decision to revoke them is made by the `owner`s.
- **Sync.** The controller `ctl-idp-sync` in `worker` every 300 s (`UMIAK_IDP_SYNC_INTERVAL`) reads the Keycloak Admin REST API with the client `umiak-worker` (client credentials, a service account with the `view-users` role of the `realm-management` client, architecture §10): `GET /admin/realms/umiak/users?briefRepresentation=true&first=&max=` page by page (no library needed, `fetch` is enough). Matching is `users.idpSubject` = the Keycloak user `id` (= `sub`).
  - An active platform user whose Keycloak `enabled` is `false` is deactivated with `deactivatedReason: idp_disabled`; one missing from the full list — with `idp_deleted`, but only if `GET /admin/realms/umiak/users/{id}` confirms `404` (a paged walk can miss a user if the list changes during the pass). Placeholders (without `idpSubject`) are not touched.
  - Changes are applied only after a fully successful walk. If one pass would deactivate more than 20% of active users (and more than 5), the controller changes nothing and raises the alarm metric `umiak_idp_sync_aborted`: so a configuration error or an empty response does not disable everyone.
  - Deactivation follows the same path as deactivation by an operator in `/admin` and member removal: `active: false`, `deactivatedAt` through the Local API, the hooks send `NOTIFY umiak_identity` → `api` rejects sessions and JWTs (`403 user_disabled`), closes streams and PTYs (C9), and `NOTIFY umiak_ssh_revoke 'user:<id>'` → the gateway closes SSH sessions (§8, S4 §9.5). Memberships stay for audit and grant no access.
  - A user re-enabled in Keycloak is activated on the next pass if the sync disabled them (`idp_*`). The sync does not lift deactivation by an operator (`operator`).
  - **Notice to the `owner`s** of every team the user was a member of: a record in the `team-notices` collection (`team`, `kind: member_deactivated`, `user`, `apiKeys[]` — the team keys the user created, `createdAt`, `acknowledgedBy`), a banner on the keys and team pages (§9.8). No emails (as in §6.3). Keys are not revoked automatically. If a team has no active `owner` left, operators see the notice (a "teams without an active owner" list in `/admin`), and they assign a new `owner` or revoke the keys.
- The rule "30 days without a browser session" (`apiKeyOwnerInactivityDays`, `owner_inactive`) is cancelled.

### 20.2 Open questions

- The operator group name in Keycloak — S12 / Ilia (architecture §13).
- The default team quota (PoC: 3 sandboxes, 6144 MB, 10 snapshots) — revisit after S6 measurements and when a second node appears.

## 21. MVP implementation (`s8-impl`)

Added after implementation (branch `s8-impl`, 2026-10-31). This records what was done differently or in more detail than in the sections above; such places above are marked with a reference to §21. "Decision N" is the list "Implementer decisions" in `docs/plans/s8-web.md`; the rest was decided during implementation. Sections 1–20 remain the history of the agreement.

### 21.1 Not in the MVP

- **Warm pool** (Ilia's decision 2026-10-29): the pool target `linux/2gb = 1` from §12 is not seeded, the `pool-targets` collection is empty (§21.3). There is no pool and node state in the "Operator" section (phase 2, §18).
- **`web` metrics** (§19): not done. Only `/healthz` exists.
- **The "teams without an active owner" list** in `/admin` (§20.1): not done. The operator sees notices about such teams in the `team-notices` collection in `/admin`.
- **The columns `sandboxes.environment_id`, `environment_revision`, `exclude_owner_secrets`** (S6 S1, §10.3) are not added (decision 2): S7 decision 7 stands. In the Sandbox resource `environment: null`; `excludeOwnerSecrets: true` in create — `400`. The environments service is S7's `PgEnvironmentStore` (`packages/auth`), not `EnvironmentService` in `core`.
- **Postgres roles** (§12): in compose `web`, `web-migrate`, `api`, `worker` run under the shared superuser `umiak`. Roles — S12.
- **Python SDK:** for blocks only the generated client (`sandboxes_block`, `ports_block`, etc.), no facade methods.
- **dev-cp** (`infra/dev-cp`): `web` and the routes are added, but not verified on CT 590 (the checklist is in `infra/dev-cp/README.md`).

### 21.2 Identity storage and the move from `identity`

- Identities live in the `payload` schema (decision 1). The first Payload migration copies `identity.teams`, `users`, `memberships`, `api_keys`, `ssh_keys` with the same UUIDs if `identity.users` exists (`ON CONFLICT DO NOTHING`). Memberships get new ids. A user with `idp_subject` gets `lastLoginAt = createdAt` (otherwise they would become a placeholder). `personalTeam` is the personal team where the user is `owner`.
- The `identity` schema and `PgIdentityStore` stay: the contract phase is a separate release. `PgIdentityStore` is the reference for the `IdentityStore` contract suite (`packages/auth`); `PayloadIdentityStore` passes the same suite.
- The move from the stand-in is one-time, with `api` and `worker` stopped: the old code writes to `identity`, and rows written after the copy are not carried over. Before the first S8 rollout onto an existing volume — `docker compose stop api worker`, then `docker compose up` (`web-migrate` copies, `api` and `worker` start after it). `infra/dev-cp/deploy.sh` does this itself if Postgres has `identity.users` but no `payload.payload_migrations`. After that — expand/contract (§12).
- `api` and `worker` take identities and config only from Payload (decision 5). Their `UMIAK_CONFIG_FILE` is removed (the extra variable is ignored), the new required variable is `PAYLOAD_SECRET` (`api`, `worker`, `web`). `api` keeps `UMIAK_IDENTITY_FILE`: the same YAML is loaded as an upsert into Payload (`seedPayloadIdentity`). New teams, users, and keys from the file are inserted with SQL (the Local API does not create a row with a given id), and the NOTIFYs of the creation hooks are sent explicitly. A role change in the file that removes the last `owner` fails the whole seed (`last_owner`); the stand-in skipped this.
- `/readyz` of `api` and `worker`, and `/healthz` of `web`, are not ready until all Payload migrations known to the code are applied (reason `payload_migrations`). `@umiak/payload` in `api` is loaded by a dynamic `import()` in `buildDeps`, so tests importing `@umiak/api` do not bring up Payload.
- The `api` tests assemble dependencies through `makeTestDeps` (`PgIdentityStore`, `StaticConfigReader`); `buildDeps` with Payload is checked by a separate test (`test/payload-deps.test.ts`).

### 21.3 Payload

- **IDs** — `idType: "uuidv7"` (decision 7: adapter 3.92.1 supports it). The application generates ids: the `id` columns have no default in the database, and raw `INSERT`s (seeds, copies) pass Postgres 18's `uuidv7()`.
- **Migrations** are applied by its own runner `node packages/payload/src/migrate.ts` (decision 6), not `payload migrate` and not `payload.db.migrate()`: Payload's runner does `process.exit(1)` on error, asks about the dev batch, and takes no lock. The own runner holds `pg_advisory_lock(727003)`, runs each migration in a Payload transaction, and throws on error. The pool needs at least 3 connections (the adapter holds one forever). New migrations — `node packages/payload/src/create-migration.ts <name>` (a wrapper over `payload.db.createMigration`, fixes imports for type stripping). Drift is caught by the test `schema.test.ts`. Migrations: `20261030_164255_initial`, `20261030_171459_api_keys_team_nullable`.
- `CREATE SCHEMA "payload"` was added by hand in the first migration (the generator does not write it).
- **`pool-targets`** are unique by (`template`, `size`, `providerId`) with `NULLS NOT DISTINCT`: otherwise two targets without a provider would pass. Payload cannot express this: a manual edit in the first migration, absent from the `.json` snapshot; a migration that recreates the index must add the condition again.
- **Windows catalog (S9):** the data-only migration `20261101_000000_windows_template` adds the missing `windows` (enabled, `loginUser=user`, `exec/files/ssh`, `defaultSize=4gb`, `allowedSizes=[4gb]`) and `4gb` (2 vCPU, 4096 MB) on new and existing installs. Records previously created by an operator stay unchanged (`ON CONFLICT DO NOTHING`), as do Linux, quotas, and pool targets. The runtime build is registered separately via `umiak-admin bootstrap` from the compose YAML; a YAML entry alone is not enough for the public catalog. The migration sends `umiak_config '*'`; rollback does not delete catalog records that sandboxes may already reference.
- **The pool target is not seeded** (Ilia's decision on no warm pool in the MVP; `umiak.yaml` also has `pools: []`). Seeds: `platform-defaults`, templates `linux`/`windows`, sizes `2gb`/`4gb`.
- **`api_keys.team` is nullable** in the database (`ON DELETE SET NULL`), required only on creation. Payload makes required relations `NOT NULL` with `ON DELETE SET NULL`, so deleting a team with keys would fail. When a team is deleted, its keys are revoked and remain for audit without a team; the `beforeDelete` hook deletes memberships and `team-notices`.
- **Collection rules** are `APIError(code, 400)` codes: `last_owner`, `personal_team`, `user_not_stub` (only a placeholder can be deleted), `size_in_use`, `membership_immutable` (a membership's `user` and `team` cannot be changed: replacement is delete and create, so that the deletion closes SSH sessions). Bulk `update`/`delete` by `where` for `memberships` and `teams` is forbidden through access (`operatorByIdOnly`): Payload runs the hooks of a bulk operation in parallel in one transaction, and the last-`owner` check does not see them. Server code also changes memberships only by single id.
- `api-keys` through `/admin` and REST: `revokedAt` can be set only once (the hook writes `revokedBy`); other fields are silently dropped. `secretHash` is not readable through access.
- Multi-valued fields (`groups`, `scopes`, `allowedSizes`, `capabilities`, `apiKeys`) are `json`, not `select hasMany` (extra tables).
- **One instance per process:** `getUmiakPayload` counts references by `DATABASE_URL`, `closeUmiakPayload` releases one. A larger `poolMax` on the next call raises the pool size; the other options (secret, operator groups, session cache) come from the first call. Pools: `api` — 10, `worker` — 4. `web` gets the Payload instance through `getPayload({config})` (the same as the admin).

### 21.4 NOTIFY

- The helper `notify(req, channel, payload)` sends `pg_notify` in the adapter's session by `req.transactionID` (decision 3): delivery after commit, a rollback sends nothing, a `pg_notify` error rolls the write back. Without a transaction — a separate statement; a closed `transactionID` — an exception.
- `umiak_identity`: `'<collection>:<uuid>'`; for `memberships` — `'memberships:<userUuid>:<teamUuid>'`, not the membership id as in decision 3: the S7 §23.10 format, parsed by the `api` stream registry (after the row is deleted the membership id cannot be matched). Updates of only `lastUsedAt`, `lastLoginAt`, `updatedAt` (for `users` also `groups` and `preferredUsername`: they are not in `SessionIdentity`) send nothing.
- `umiak_identity 'sandboxes:<uuid>'` is a new payload: a sandbox block (§21.8). The `api` and `web` session caches and the key cache do not reset on it.
- `umiak_ssh_revoke` from the hooks carries the same payloads as the triggers `0302`/`0303` (`user:usr_…`, `member:team_…:usr_…`, `key:key_…`, `team:team_…`). The triggers stay on `identity` until the contract phase.
- `umiak_ssh_revoke ''` (empty payload) is sent by a sandbox block: the gateway rechecks all open SSH sessions through `ssh/authorize`, and it refuses a blocked sandbox. No gateway changes are needed.
- `umiak_config` is sent for `teams` on creation too (a quota appeared), not only on `quota` change and deletion.

### 21.5 JIT and sessions

- **The personal team name** is `<email>'s team` (`personalTeamName` of `@umiak/auth`), not the user's name (§6.1): the S7 contract suite requires it.
- `resolveSession` runs in one Payload transaction: user rows under `FOR UPDATE`, writes through the Local API with the same `req`. The race of first logins is a retry on unique violation, up to 3 attempts (10 parallel logins give one user and one personal team).
- An email change with the same `sub`, if the email is taken by a placeholder: the placeholder's memberships are moved one at a time (creation or promotion to `owner`, then deletion of the placeholder's membership), and the placeholder is deleted. An inactive placeholder is not merged — `identity_conflict`.
- Besides `groups`, `isOperator`, `lastLoginAt` (§5.3 step 5), `preferredUsername` is updated too. `lastLoginAt` is written no more than once per 60 s and sends no `umiak_identity`.
- The oauth2-proxy `keycloak-oidc` provider adds realm and client roles to `X-Auth-Request-Groups` as `role:<name>`, while the CLI JWT carries only the `groups` claim. `role:` entries are dropped when parsing headers (`parseAuthHeaders` in `@umiak/payload`, `parseGroups` in `api`), otherwise logins from the browser and from the CLI would overwrite `users.groups` in turn. A change of only `groups` or `preferredUsername` sends no `umiak_identity` (a change of `isOperator` does).
- `isOperator` and `groups` are not written in `/admin` and `/cms-api` (field access `create`/`update: false`), only by `resolveSession` through the Local API. `isOperator` of the strategy's `req.user` comes from the resolved session, not from re-reading the document.
- `teams.personal` does not change after creation (`personal_immutable`). A personal team has one membership: `owner` — its creator (`createdBy`), first; any other membership, including from `/admin`, is `400 personal_team`.
- `users.active` `true → false` without a reason (an operator in `/admin`) writes `deactivatedReason: "operator"` and `deactivatedAt`; `false → true` clears both. `ctl-idp-sync` passes its own reason.
- The Payload service collection `payload-locked-documents` (by default available to any signed-in user) — operators only; `payload-migrations` is closed; `payload-preferences` is restricted by Payload itself to the user's own rows.
- `parseAuthHeaders`: an empty, repeated, or comma-joined `X-Auth-Request-Email` or `X-Auth-Request-User` is treated as absent (`401`).
- The Payload strategy is `packages/payload/src/identity/strategy.ts`. A denial (`subject_required`, `user_disabled`, `identity_conflict`) in a REST response is the header `X-Umiak-Auth-Denied: <code>`. The `web` pages take the reason from `authenticateHeaders` (`anonymous` / `denied` / `session`).
- The `web` session cache (decision 8) lives in `@umiak/payload` and is attached to the instance in `onInit`, so the Payload strategy (`/admin`, `/cms-api`) and `/app` use one cache. The key is sha256 of email, `sub`, groups, and names (like the `api` `SessionResolver`). Only sessions are cached. `LISTEN umiak_identity` resets the cache on any payload except `sandboxes:`, `api-keys:`, `ssh-keys:`, and on every reconnect. Server actions reset their process's cache right after success.

### 21.6 `ConfigReader`

- `PayloadConfigReader` lives in `@umiak/payload`, not in `packages/config` (decision 4: otherwise a dependency cycle). The contract suite is `runConfigReaderContract` in `@umiak/config/testing`; `StaticConfigReader` and `PayloadConfigReader` both pass it. The difference between them is parameterized: the quota of an unknown team is the defaults for `StaticConfigReader` and zeros for Payload (S6 S3).
- The cache is reset on `LISTEN umiak_config` on its own connection (reconnect with growing delay, a reconnect also resets the cache); without LISTEN — TTL 5 s. `defaults()` is not cached (C7). An empty quota field in `platform-defaults` is the PoC quota 3 / 6144 / 10.

### 21.7 Environments

- The table is `runtime.environments` (`0400_environments_runtime.sql`, decision 2): `identity.environments` has foreign keys to `identity.teams/users`, and teams are now in `payload`. The new table has no foreign keys, rows are copied with the same ids (AAD `environment:<id>:v<n>` stays valid). `identity.environments` stays until the contract phase.
- `PgEnvironmentStore` no longer answers `not_found` for an unknown team: the team comes from the principal.
- The environment rows of a deleted team are not deleted: the operator deletes the environments before deleting the team (§6.4, the button checks).
- **Re-encryption by key:** the cleanup controller re-encrypts `runtime.environments` too (row by row in its own transaction under `FOR UPDATE`; `revision` and `updated_at` do not change). The gauge `umiak_secrets_old_key_rows` is the sum over `sandbox_secrets` and `environments`, so "0 — the old key can be removed" still holds.
- An operator session can write the environments of any team (§6.2): `requireOwnerUnlessKey` in `api` lets the operator in. Without it the operator could not clear a team before deleting it.

### 21.8 Blocks (C3)

- Migration `0206_sandbox_block_meta.sql` (runtime range): `blocked_at`, `blocked_by` on `sandboxes` and `hosted_ports`; `CHECK` `block_reason IN ('operator', 'abuse')`. `umiak_routes` on block changes is already sent by the triggers `0204` (sandboxes) and `0201` (hosted_ports).
- Endpoints as in C3. `requireOperator` comes before path parsing: any non-operator gets `403 forbidden` with `details.reason: "operator_required"`, even for a nonexistent sandbox. The operator finds a sandbox in any team (id or slug), `Umiak-Team` is not needed. A repeat with the same reason is a no-op, a different reason is an update and a new event. Unblocking an unblocked one is a no-op. Blocking a `deleted` one — `409 invalid_state`. Events — `blocked`, `unblocked`, `port_blocked`, `port_unblocked` with `{reason, note, by[, port]}`.
- Forbidden actions are `403 forbidden` with `details.reason: "sandbox_blocked"` or `"port_blocked"` (`details.port`). Beyond §17.1, these are forbidden: `input`, `kill`, `signal` of a command, PTY connect and resize, `DELETE /ports/{port}` on a blocked sandbox. The operator also does not enter a blocked sandbox over SSH (C6). `PATCH` with an empty body returns `200` without changes (no core call). Renaming does not lift a port block.
- `routes.lookup`: the reason is the port block, then the sandbox block, then `public_disabled` (S4 in §17.2).
- **Open sessions when a sandbox is blocked** are closed immediately: in the block transaction `umiak_ssh_revoke ''` (SSH, §21.4) and `umiak_identity 'sandboxes:<uuid>'` are sent. The `api` stream registry closes the exec streams, sync commands, and PTYs of this sandbox that were not opened by operators: an `error` frame `forbidden` with `details.reason: "sandbox_blocked"`, PTY — close `4403`. Reading output (`GET …/commands/{id}/stream`) stays open: reading is allowed. Blocking a port and lifting a block close nothing.
- The block check on paths to the agent does not lock the row: one call started before the block commits can pass.
- Resources: Sandbox has `blocked`, `blockReason`; `HostedPort.blockReason` is the same extensible enum. `GET /v1/sandboxes?allTeams=true&teamId=team_…`: `teamId` only together with `allTeams`. OpenAPI — no breaking changes (additions; `HostedPort.blockReason` is narrowed to an enum in the response). TS SDK: `sb.block`, `sb.unblock`, `sb.ports.block`, `sb.ports.unblock`, `umiak.operator.listSandboxes`.

### 21.9 ctl-idp-sync

- The logic is `KeycloakAdminClient` and `KeycloakIdpSync` in `@umiak/payload`, the controller is in `apps/worker` (decision 9). It is enabled if `UMIAK_IDP_SYNC_KEYCLOAK_URL` (the internal Keycloak address) is set. The other variables: `UMIAK_IDP_SYNC_REALM` (`umiak`), `UMIAK_IDP_SYNC_CLIENT_ID` (`umiak-worker`), `UMIAK_IDP_SYNC_CLIENT_SECRET_FILE` (required together with the URL), `UMIAK_IDP_SYNC_INTERVAL` (300 s).
- Metrics: `umiak_idp_sync_total{result}`, the counter `umiak_idp_sync_aborted_total{reason}`, the gauge `umiak_idp_sync_aborted` (1 after an abort, 0 after a successful pass, a failed pass does not change it) and `log.error` with `wouldDeactivate`, `active`.
- The threshold counts only confirmed deletions (after the `404` check). With an empty list this is one `GET /users/{id}` per active user before the abort — acceptable for the PoC.
- Each user gets its own transaction, the row under `FOR UPDATE` with a recheck: a concurrent deactivation by an operator wins. An error for one user does not stop the others; the pass then throws (pg-boss will retry, the pass is idempotent).
- Notice: `apiKeys` is `[{id, publicId, name, prefix}]`, `publicId` is the public `key_…` for `DELETE /v1/api-keys/{key}`; revoked keys are not included. While an unacknowledged notice for the same (team, user) exists, no new one is created. The deactivated user's personal team gets a notice too.
- Unchanged: `idp_disabled`, later deleted in Keycloak, stays `idp_disabled`; `idp_deleted`, reappearing disabled, stays `idp_deleted`.

### 21.10 `web`

- **The SDK in the browser** is a new mode `new Umiak({baseUrl: "/api", session: true, team})`: no credential chain and no `Authorization` (the proxied listener answers `400` to any `Authorization`), `baseUrl` can be relative, PTY gets the team in `?team=`. The SDK retry budget in the dashboard is 5 s. Added `umiak.sandboxes.handle(data)` (a handle without a request) and a fix for the `204` response in the browser.
- **401/403** — Next's `unauthorized()` / `forbidden()` (`experimental.authInterrupts`). If the flag is removed from Next, the pages need another mechanism.
- **CSP** — as in `apps/web/README.md`; `script-src` and `style-src` with `'unsafe-inline'` (Next inline chunks and Payload/Radix styles). So that nothing loads from a foreign origin, Gravatar (`admin.avatar: "default"`) and Monaco (loaded from jsDelivr) are turned off in the admin: five JSON fields are a `textarea`.
- **Cookie `__Host-payload`** (§19): the admin writes `__Host-payload-theme` from JS without `Secure`, the browser drops it, and the theme is not kept between visits. These cookies grant no rights; not fixed.
- **IDs for the dashboard only** — `mbr_…` (membership) and `ntc_…` (notice), the same base32 over a UUID; only server actions accept them. They are not in `/api/v1`.
- **Server actions:** a human gets `forbidden` for both a foreign and a nonexistent row (so they cannot tell whether a foreign team exists); an operator gets `not_found`. `removeMember`, like `leaveTeam`, returns the removed user's default team to the personal one. In the dashboard only an `owner` can acknowledge a notice; an operator does it in `/admin`.
- **Create and fork** keep the `Idempotency-Key` between manual retries while the body is the same and the outcome of the last attempt is unknown: a retry does not create a second sandbox.
- **Team deletion** (decision 12): the button in `/admin` on the shared team page checks that there are no sandboxes, snapshots, or environments, and sends `DELETE /cms-api/teams/<uuid>` with the header `x-umiak-delete-team: checked`. Without the header, deleting a team is `403`, so Payload's standard Delete is not shown for teams. This protects against accidental deletion and is not a security boundary; the §6.4 race remains.
- `/` → `307` to `/app` (a page, not the config's `redirects`: otherwise an anonymous user would get `307` instead of `401`). The proxy protects `/_next/image` too; only `/healthz`, `/_next/static`, and `favicon.ico` are free.
- **`/admin` and `/cms-api` are for operators only already in `proxy.ts`**: the operator is determined the same way as in the session (§5.5) — a group from `UMIAK_OPERATOR_GROUPS` in `X-Auth-Request-Groups`; others get `403` "Operators only" before Payload. So a non-operator does not get the admin client config with field names (`secretHash`, `idpSubject`, `ssoPolicyEpoch`) and cannot reach `payload-preferences` and `payload-locked-documents`. Rights are still checked by Payload's access too (a deactivated operator, etc.).
- **The `users` auth endpoints that need Payload's local strategy or JWT are closed** (there are none, §5.4): `login`, `refresh-token` (it would issue a JWT accepted nowhere), `first-register`, `forgot-password`, `reset-password`, `unlock`, `verify/:id`, `:id/api-key/reveal` — `403` for everyone, operators too. `me`, `access`, `init`, `logout` are needed by the admin and open to operators.
- The "Operator" section without `Umiak-Team` takes the operator's default team: an operator with no teams gets `team_forbidden`.
- Build: `next build` does not check types (`typescript.ignoreBuildErrors`: TypeScript 7 has no JS API), `pnpm typecheck` does. `hoistPattern: ["*", "!next"]` in `pnpm-workspace.yaml`: otherwise Next's global types broke the typecheck of other packages. The image is ~725 MB (standalone and the full prod set of `@umiak/payload` for migrations).
- The admin HTML contains the field name `secretHash` in the client config (without a value); only operators get it (the proxy, above).

### 21.11 compose and dev-cp

- `web` is only in the network `web-internal` (`internal: true`) together with `oauth2-proxy` and `postgres`; no port is published on the host. The name `web` does not resolve from the `umiak` network.
- `web-migrate` (the `web` image, `node packages/payload/src/migrate.ts`) runs after `migrate` and `secrets-init`, before `api`, `worker`, `web`: the first migration sees the `identity` tables it copies.
- oauth2-proxy: `/` → `web:3000`, `/api/` and `/umiak-auth/` as in S7.
- Postgres: `max_connections=200` (`api` ~36 connections, `worker` ~37, `web` ~11).
- Secrets: `payload-secret` (copies for `api`, `worker`, `web`), `worker/idp-sync-client-secret` (from the `umiak-worker` client secret).
- **Sign-out** (decision 11): `/oauth2/sign_out?rd=<UMIAK_LOGOUT_URL>`; by default the Keycloak logout returning to `<UMIAK_APP_ORIGIN>/app`. The Keycloak domain is added to `OAUTH2_PROXY_WHITELIST_DOMAINS`.
- `worker` waits for a healthy Keycloak (`depends_on: keycloak: service_healthy`), so the first `ctl-idp-sync` pass on a fresh stack does not fail.
- The first S8 rollout onto an existing volume: build the images, stop `api` and `worker`, then `up` (`deploy/compose/README.md`; in dev-cp `deploy.sh` does this, the build happens before the stop).
- `dev@example.com` is not an operator; how to make them one — `deploy/compose/README.md`.

### 21.12 `umiak-admin`

`umiak-admin` takes its config from YAML (`UMIAK_CONFIG_FILE`): `bootstrap` (topology and template builds) and `pool status` (pool targets). `api` and `worker` read Payload. While there is no warm pool the divergence is not visible; when it appears, `pool status` must be moved to `PayloadConfigReader`. In compose the `worker` container has no YAML, and `pool status` shows pairs without targets.

### 21.13 E2E

The stack is `deploy/compose/e2e.yaml` (decision 10): real Keycloak, oauth2-proxy, Postgres, `web`, `web-migrate`; instead of `api` and `worker` there is `e2e-backend` (the `api` and `worker` code in one process, `FakeAgent`, a fake PVE world, the real `KeycloakIdpSync`). Run: `pnpm --filter @umiak/web test:e2e`; 8 files, 18 tests. Every page response is checked for secrets (`secretHash` with a value, a key secret, a port token, secret values).

- **Covered:** the §15 E2E scenarios except those listed below, including the device grant of `umiak login` (the same user as in the browser; an operator's JWT does not give operator rights) and the §15 security items (forged headers, CSRF on `/cms-api` and server actions, the `web` network, image contents).
- **Approximated:** the `blocked` route and the `sso` epoch (`ssoPortPolicy any → team`) are checked via `GET /internal/v1/gateway/routes/{label}`, not through the gateway: there is no gateway in the stack. PTY resize — by the sizes the agent received; echo — through command output (the fake PTY has no tty).
- **Skipped:** closing SSH sessions on offboarding and blocking (no gateway; covered by `api` and gateway tests); the environments UI (creation by an `owner`, read-only for a `member`). Environments on create are covered: the fake guest received the env and secret names.

### 21.14 Deferred minor items

- **Payload:** no `umiak_identity users:<id>` for users whose personal or default team is nulled by a team deletion; the test "a NOTIFY error rolls the write back" does not go through the hook; `api-keys.sandbox` accepts any text; the `platform-defaults` comment about defaults matching the seed is inaccurate.
- **JIT:** `resolveSession` opens a transaction with `FOR UPDATE` on every call (softened by the caches); no tests for an inactive placeholder on email change and for a disabled placeholder.
- **Caches and LISTEN:** `ChannelListener.start()` twice leaks a client, an exception in `onError` skips the reconnect; no test for NOTIFY during loading; the TTL check in the test may flake on slow CI; parity of the "bare" template for `StaticConfigReader` is not pinned.
- **`api`:** `seedPayloadIdentity` without an advisory lock (a race of several replicas on an empty database); `/readyz` with Postgres down also reports `payload_migrations`; the cleanup log field `sandboxId` instead of `id`; the block HTTP matrix lacks some rows (move, chmod, archive PUT, upload commit/delete, signal, PTY connect); the text of the environments write `403` in OpenAPI is outdated.
- **ctl-idp-sync:** no early exit when the threshold is already exceeded; pagination stops only on an empty page (the safeguard is a repeat of a full page and a page count limit); tests are missing (abort with pending reactivations, exactly 20%, a failure mid-apply, non-`404` in `userExists`); a notice on deduplication keeps the old key list; expired keys get into the list.
- **`web`:** a parallel Dismiss overwrites the first acknowledgment; the infinite list re-requests all pages every 5 s; disabled header buttons do not each have a reason; finished commands are read with `follow=true`; an operator in the environments editor is shown as "former member"; the team deletion confirmation does not recheck; the snapshot count on team deletion is one page; `lucide-react` in `minimumReleaseAgeExclude` should be removed later.
- **SDK:** `NULL_BODY_STATUSES` includes `101`/`103`; the WebSocket connection check is by substring.
- **E2E:** `typecheck:e2e` is not part of `pnpm -r typecheck`; the `403` JWT checks are not tied to `details.reason`; `deviceLogin` depends on the Keycloak theme text; sandboxes from runs accumulate on a persistent stack.

### 21.15 Open questions

- The contract phase: remove the `identity` schema (tables, triggers `0302`/`0303`, `identity.environments`) and `PgIdentityStore` as a backend — a separate release after the move.
- `umiak-admin` `pool status` on `PayloadConfigReader` — together with the warm pool (phase 2).
- `web` metrics (§19) and the "teams without an active owner" list in `/admin` (§20.1).
- Next's `experimental.authInterrupts`: watch on upgrades.
- Postgres roles (§12), NetworkPolicy, and the `web` image size — S12.
- Checking `web` on the CT 590 dev stand.
- From §20.2: the operator group name in Keycloak; the default quota.
