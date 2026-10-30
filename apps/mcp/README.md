# @sbx/mcp

MCP server of the sbx platform (S11, `docs/specs/s11-mcp.md`). It exposes the public API `/v1/*` as 38 MCP tools (sandboxes, commands, files, ports, saved snapshots, desktop and computer-use) on top of `@sbx/sdk`. It has no database and no state between calls; every call is authorized by the `api` with the caller's own credentials.

Two ways to run it:

| | Transport | Credentials | Entry |
|---|---|---|---|
| local | stdio | `sbx login` (or `SBX_API_KEY`) | `sbx mcp` in the CLI binary (`apps/cli`) |
| remote | Streamable HTTP, stateless | `Authorization: Bearer` team key `sbx_...` or Keycloak JWT | `node apps/mcp/src/main.ts`, image `sbx-mcp` |

Server name in every client config below is `sbx`.

## stdio: `sbx mcp`

```
sbx mcp [--toolsets core,files,...] [--read-only] [--sandbox <sb>] [--log-level info] [--log-file <path>]
```

- Needs `sbx login` once (or `SBX_API_KEY`); without it `tools/list` still works and every call answers `not_logged_in`.
- `--toolsets` (env `SBX_MCP_TOOLSETS`): `core`, `files`, `ports`, `snapshots`, `desktop`; default all.
- `--read-only` (env `SBX_MCP_READ_ONLY=1`): only tools that change nothing.
- `--sandbox <sb>`: bind every tool to one sandbox (ID, slug, or `self` inside a sandbox, from `SBX_SANDBOX_ID`).
- stdout carries JSON-RPC only; logs go to stderr or `--log-file`. The process ends when the client closes stdin.

From a checkout: `mise exec -- bun apps/cli/src/main.ts mcp`.

## HTTP server

```
SBX_MCP_API_URL=http://localhost:8080 \
SBX_MCP_PUBLIC_URL=http://localhost:8090/mcp \
SBX_MCP_PORT=8090 mise exec -- node apps/mcp/src/main.ts
```

| Variable | Default | |
|---|---|---|
| `SBX_MCP_API_URL` | required | public listener of the api, e.g. `http://api:8080` |
| `SBX_MCP_PUBLIC_URL` | required | URL clients use, e.g. `https://api.example.com/mcp`; its host is the only accepted `Host` (plus `SBX_MCP_ALLOWED_HOSTS`) and its value is `resource` in the protected resource metadata |
| `SBX_OIDC_ISSUER` | unset | Keycloak issuer named in the metadata (`authorization_servers`); unset: no authorization server |
| `SBX_MCP_ALLOWED_ORIGINS` | empty | origins allowed in `Origin` (comma separated); a request with another `Origin` gets `403` |
| `SBX_MCP_ALLOWED_HOSTS` | empty | extra `Host` values (comma separated); other `Host` gets `421` |
| `SBX_MCP_PORT` | 8080 | `/mcp`, `/.well-known/oauth-protected-resource/mcp`, `/healthz`, `/readyz` |
| `SBX_MCP_OPS_PORT` | 9090 | `/metrics`, `/healthz`, `/readyz` |
| `SBX_LOG_LEVEL` | info | `fatal` ... `trace`, `silent` |

- A request without a bearer gets `401` with `WWW-Authenticate: Bearer resource_metadata="<public origin>/.well-known/oauth-protected-resource/mcp"`. A person in several teams picks one with the header `Sbx-Team: team_...` or `?team=team_...` in the URL.
- SIGTERM stops within 25 s: readiness goes false and new requests get `503` with `Retry-After`, calls in flight get the rest of the grace period. A request (headers and body) must arrive within 60 s (headers within 15 s), else `408`.
- Image: `docker build -f apps/mcp/Dockerfile -t sbx-mcp:dev .` (context is the repo root). Local stack: the `mcp` service of `deploy/compose` listens on `http://localhost:8090/mcp` (README of `deploy/compose`, section MCP). Dev control plane: `infra/dev-cp/README.md`, section S11 MCP behind Tailscale Serve.

## Client configs

Checked against the documentation of each client on 2026-10-31 (code.claude.com/docs/en/mcp, developers.openai.com/codex, opencode.ai/docs/mcp-servers, geminicli.com and google-gemini/gemini-cli `docs/tools/mcp-server.md`). Replace `https://api.example.com/mcp` with your server (local stack: `http://localhost:8090/mcp`; dev control plane behind Tailscale Serve: `https://<TS name>:8443/mcp`, see `infra/dev-cp/README.md`).

Browser sign-in uses the Keycloak public client `sbx-mcp` (authorization code + PKCE). Its redirect URIs are `http://127.0.0.1:33418/*` and `http://localhost:33418/*`, so every client below must be told to listen on port **33418**. A client that does not know a `client_id` tries dynamic registration, which the realm refuses.

### Claude Code

```bash
# local, uses `sbx login`
claude mcp add --transport stdio --scope user sbx -- sbx mcp
# remote, browser sign-in through Keycloak (client sbx-mcp)
claude mcp add --transport http --scope user --client-id sbx-mcp --callback-port 33418 \
  sbx https://api.example.com/mcp
claude mcp login sbx
```

Team key (`.mcp.json` of a project; `${SBX_API_KEY}` is expanded from the environment, keep `Authorization` out of the config when you want OAuth):

```json
{ "mcpServers": { "sbx": { "type": "http", "url": "https://api.example.com/mcp",
  "headers": { "Authorization": "Bearer ${SBX_API_KEY}" } } } }
```

Verified: flags `--transport`, `--scope`, `--client-id`, `--client-secret`, `--callback-port` (HTTP and SSE only), `claude mcp login <name>` (also `/mcp` inside a session), `.mcp.json` keys `type`, `url`, `headers` with `${VAR}` expansion. Same as the spec.

### Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.sbx]
command = "sbx"
args = ["mcp"]
tool_timeout_sec = 60
default_tools_approval_mode = "writes"   # auto | prompt | writes | approve

# remote with a team key
[mcp_servers.sbx-remote]
url = "https://api.example.com/mcp"
bearer_token_env_var = "SBX_API_KEY"
```

Browser sign-in (one server name for one transport, so a separate entry):

```bash
codex mcp add sbx-oauth --url https://api.example.com/mcp --oauth-client-id sbx-mcp
codex mcp login sbx-oauth
```

and fix the callback port, either global or per server:

```toml
mcp_oauth_callback_port = 33418            # global
# or
[mcp_servers.sbx-oauth.oauth]
client_id = "sbx-mcp"
callback_port = 33418
```

Verified: `command`, `args`, `url`, `bearer_token_env_var`, `tool_timeout_sec`, `default_tools_approval_mode`, `codex mcp add --url --oauth-client-id`, `codex mcp login`, global `mcp_oauth_callback_port`. Differences from the spec: `codex mcp add` stores `client_id` (and the callback) in `[mcp_servers.<name>.oauth]`, a per-server `oauth.callback_port` exists and overrides the global one, and Codex sends `redirect_uri` `http://127.0.0.1:<port>/callback[/<server id>]`, which `http://127.0.0.1:33418/*` of the realm covers. `default_tools_approval_mode` accepts `auto`, `prompt`, `writes`, `approve`.

### OpenCode (`opencode.json`)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "sbx": { "type": "local", "command": ["sbx", "mcp"] },
    "sbx-remote": { "type": "remote", "url": "https://api.example.com/mcp",
      "oauth": { "clientId": "sbx-mcp", "callbackPort": 33418 } },
    "sbx-ci": { "type": "remote", "url": "https://api.example.com/mcp", "oauth": false,
      "headers": { "Authorization": "Bearer {env:SBX_API_KEY}" } }
  }
}
```

Browser sign-in: `opencode mcp auth sbx-remote`.

Verified: `type` `local`/`remote`, `command` array, `url`, `headers` with `{env:VAR}`, `oauth` object (`clientId`, `clientSecret`, `scope`) or `false`, `opencode mcp auth <name>`. Differences from the spec:

- The OAuth callback of OpenCode is **fixed**: `http://127.0.0.1:19876/mcp/oauth/callback` (port 19876), not 33418. The documented `oauth` table lists `clientId`, `clientSecret`, `scope` only; the config schema in the source also has `callbackPort` ("Port for the local OAuth callback server (default: 19876)") and `redirectUri`, which is why the snippet sets `callbackPort: 33418`. The realm stays as is (`http://127.0.0.1:33418/*` matches `/mcp/oauth/callback`).
- The preview docs for OpenCode v2 (`opencode.ai/v2/docs/mcp-servers`) use another layout: servers under `mcp.servers`, snake_case keys (`client_id`, `callback_port`), no fixed port by default. Which layout applies depends on the installed version; the snippet above is the layout of the current stable docs.

**Open question for master:** confirm `callbackPort: 33418` with a real OpenCode (the key is not on its documentation page), or add `http://127.0.0.1:19876/*` to the redirect URIs of `sbx-mcp` (S11 §6.4, a realm change that needs master's decision). Not done here.

### Gemini CLI (`~/.gemini/settings.json`)

```json
{ "mcpServers": {
  "sbx": { "command": "sbx", "args": ["mcp"], "timeout": 120000 },
  "sbx-remote": { "httpUrl": "https://api.example.com/mcp",
    "oauth": { "enabled": true, "clientId": "sbx-mcp",
      "redirectUri": "http://localhost:33418/oauth/callback" } } } }
```

Or: `gemini mcp add -s user sbx sbx mcp`, and for a remote server `gemini mcp add -s user -t http -H "Authorization: Bearer $SBX_API_KEY" sbx-ci https://api.example.com/mcp` (your shell expands `$SBX_API_KEY` when the command runs). Browser sign-in: `/mcp auth sbx-remote` inside Gemini CLI.

Verified: `command`, `args`, `timeout`, `httpUrl` (streamable HTTP; `url` is the SSE endpoint), `headers`, `oauth.enabled`, `oauth.clientId`, `oauth.redirectUri`, `gemini mcp add [-s|--scope] [-t|--transport] [-H|--header]`. Differences from the spec: the default callback is `http://localhost:<random port>/oauth/callback`, so the snippet uses the same path `/oauth/callback` with port 33418 (the spec had `/callback`; both match the realm's `http://localhost:33418/*`). Gemini CLI documents `$VAR` / `${VAR}` expansion only for the `env` block, not for `headers`, so the team key from `gemini mcp add -H` ends up as plaintext in `settings.json`; prefer OAuth there.

Inside a sandbox `sbx` is in the template and the key is the secret `SBX_API_KEY` (registration in harness configs: S15).

## Inspector

The package depends on `@modelcontextprotocol/inspector` (dev dependency), so it runs from a checkout without a global install:

```bash
# web UI against the stdio server
mise exec -- pnpm --filter @sbx/mcp exec inspector bun ../cli/src/main.ts mcp
# web UI against the HTTP server (team key)
mise exec -- pnpm --filter @sbx/mcp exec inspector --transport http \
  --server-url http://localhost:8090/mcp --header "Authorization: Bearer $SBX_API_KEY"
# CLI mode, one method per run
mise exec -- pnpm --filter @sbx/mcp exec inspector --cli --method tools/list \
  -e SBX_API_URL=http://localhost:8080 -e SBX_API_KEY=$SBX_API_KEY bun ../cli/src/main.ts mcp
mise exec -- pnpm --filter @sbx/mcp exec inspector --cli --method tools/call --tool-name sandbox_list \
  --transport http --server-url http://localhost:8090/mcp --header "Authorization: Bearer $SBX_API_KEY"
```

The mode flag (`--cli`) goes before the other options. `test/inspector-smoke.test.ts` runs the CLI mode against `sbx mcp` and the fake API.

## Tests

```bash
mise exec -- pnpm --filter @sbx/mcp test            # unit, contract (fake API), http, golden, conformance, security, integration (real api in process)
mise exec -- pnpm --filter @sbx/mcp typecheck
```

- `test/golden.test.ts` compares `tools/list` with `golden/tools-list.json` (names, titles, descriptions, schemas, annotations) and keeps the whole list at or under 40 000 characters. After an intentional change regenerate and review the diff:
  `mise exec -- node apps/mcp/scripts/golden.ts` (or `UPDATE_GOLDEN=1 mise exec -- pnpm --filter @sbx/mcp test golden`).
- `test/client-compat.test.ts` checks every schema against the rules of Claude Code, Codex/OpenAI, OpenCode and Gemini CLI.
- `test/conformance.test.ts` runs `@modelcontextprotocol/conformance` against the HTTP app; scenarios that need features this server does not offer are listed in `test/conformance-baseline.yml` with a reason.
- `test/compose.test.ts` resolves `deploy/compose` and the dev-cp overlay with `docker compose config` (skipped with a message when `docker compose` is missing) and checks the Serve mapping of `infra/dev-cp/names.sh`.
- `test/bun-spike.test.ts` compiles an MCP server with `bun build --compile` (needs `bun` on PATH; mise provides it).

## Manual client checklist (not run yet)

Against a deployed server, for each of Claude Code, Codex, OpenCode, Gemini CLI: connect (stdio and remote, team key and browser sign-in), `tools/list` shows 38 tools, `sandbox_create` + `exec_run` + `files_write`/`files_read` + `sandbox_delete` with `confirm`, and the browser sign-in survives a token refresh. Results go to S11 §19.
