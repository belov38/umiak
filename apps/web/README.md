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
| `/app` | Redirect to the default team, `/app/t/<team_…>`. |
| `/app/t/<team>` | Team frame (S8 §9.3): team switcher, sections, operator links, user menu with sign-out. A team the user is not in: 403 page (operators may open any team). |

Pages of the sections arrive with later tasks of the S8 plan.

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
operator in `sbx-operators`, or custom); `/__dev/logout` and
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

`pnpm --filter @sbx/web test`: proxy and CSRF decisions, security headers,
env parsing, team paths, the dev proxy over real sockets (header stripping,
routing, WebSocket upgrade, 127.0.0.1 only), and the web Payload config
against Postgres (`@sbx/db/testing/global-setup`): strategy, shared session
cache, public-id session.
