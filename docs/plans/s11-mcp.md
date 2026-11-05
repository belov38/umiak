> Historical design: Keycloak, oauth2-proxy and OIDC authentication were removed on 2026-11-05. Current deployments use owner authentication over Tailscale; see [architecture](../architecture.md).

# S11 MCP server: implementation plan

> Historical plan, predating R1. Current names and contracts: `docs/specs/rename-umiak.md`.

> **For implementers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (one subagent per task, a review by a fresh subagent after each task) and superpowers:test-driven-development. Steps are `- [ ]` checkboxes.

**Goal:** implement the S11 MVP per `docs/specs/s11-mcp.md`: the package `@sbx/mcp` (`apps/mcp`) with 38 tools in 5 toolsets, the stdio server `sbx mcp` in the CLI binary and the stateless remote Streamable HTTP server `/mcp`, the `mcp` service in `deploy/compose` and the dev stand route.

**Architecture:** `apps/mcp` is a thin MCP adapter over `@sbx/sdk`: tools are described declaratively (`ToolDef`: zod schema, toolset, scopes, annotations, handler), and the registry builds an `McpServer` from them taking filters into account. The handler gets a `ToolContext` (SDK client, 50 s deadline, cancellation, progress, log). stdio uses `serveStdio` from `@modelcontextprotocol/server/stdio` with a transport wrapper that distinguishes `notifications/cancelled` from stdin closing. HTTP is Hono + `createMcpHandler` (stateless), the bearer is verified via `GET /v1/me` with a cache. Tests run against a fake API (in-memory Hono), every request and response of which is checked against `apps/api/openapi/v1.json` (and the S10 §13 fragment for the desktop).

**Stack:** Node 26.13.0 (type stripping), TypeScript 7.0.2, vitest 5.0.5, biome 2.6.4, Bun 1.4.4 (CLI). Libraries (checked with `npm view` 2026-10-31, nothing stable newer than the spec): `@modelcontextprotocol/server` 2.4.0, `@modelcontextprotocol/client` 2.4.0 (tests), `@modelcontextprotocol/hono` 2.0.2 — **not used** (see decision 4), `hono` 4.13.14, `@hono/node-server` 2.1.5, `zod` 4.6.7, `pino` 10.4.0, `prom-client` 15.1.3, `@modelcontextprotocol/conformance` 0.1.16 (0.2.0 exists only as alpha), `@modelcontextprotocol/inspector` 2.13.0, `ajv` 8.20.0 + `ajv-formats` 3.0.1 (tests).

**Specification:** `docs/specs/s11-mcp.md` (source of truth; the § below are from it). Related: S7 (`apps/api/openapi/v1.json`, `@sbx/sdk`, `apps/cli`), S10 §12–§13 (computer-use API, not implemented yet).

## Global constraints

- Tools only via mise (`mise exec -- <cmd>`). Before adding a dependency — `npm view <pkg> version`.
- The package in the S7 style: `"exports": {".": "./src/index.ts"}`, tsconfig like `apps/cli` (`allowImportingTsExtensions`, `erasableSyntaxOnly`, `noEmit`), scripts `test` (`vitest run`), `typecheck`. No `enum`, `namespace`, parameter properties. The HTTP process is `node src/main.ts`. In root files — only your own lines.
- `apps/mcp` talks only to the public API `/v1/*` through `@sbx/sdk` (`Sbx`, `sbx.raw`). It has no DB of its own and no state between calls.
- Tool names, toolsets, scopes, annotations are exactly the tables of §8. The order of `tools/list` is the order of §8.1–§8.7.
- Schemas are a subset of §7.2: root `object`; no `oneOf/anyOf/allOf/not/$ref/$defs/if/then/else`, no type arrays and `nullable`; `enum` only strings; every property has a `description`; arguments are `snake_case`.
- No call lasts longer than 50 s (`CALL_BUDGET_MS = 50_000`); internal waits end `RESPONSE_MARGIN_MS = 1_500` before the deadline.
- Secrets do not get into arguments, logs, metrics. pino `redact`: `*.content`, `*.old_text`, `*.new_text`, `*.text`, `*.env`, `*.command`, `*.authorization`, `req.headers.authorization`. Exceptions in responses are only `url_with_token` and the `desktop_url` link, marked "secret".
- stdio: only JSON-RPC goes to stdout; logs go to stderr or `--log-file`.
- Run and change nothing on `pve` and CT 590.
- Code comments in English. Commits without `Claude-Session:` and claude.ai links.

## Implementer's decisions (deviations and spec clarifications)

1. **Versions** — as in spec §13.2; no newer stable ones exist (2026-10-31). `@modelcontextprotocol/conformance` stays at 0.1.16: 0.2.x is alpha only.
2. **Desktop (S10 is not implemented).** The `/desktop*` endpoints are called through `sbx.raw` with a type cast (they are not in `v1.json`) in one module `src/desktop/api.ts`; after S10 SDK helpers will replace it. The fake API checks them against the fragment `apps/mcp/test/fake-api/desktop.openapi.json`, written from S10 §13.2. Gate: a `404` from a desktop endpoint (code other than `sandbox_not_found`, i.e. the API has no such route) and `422 desktop_unsupported` → the tool error `desktop_unsupported` with a hint; the tools stay in the list (the list is static, golden). The API has no `desktop` scope yet, so a team key does not see `desktop_url` and `computer_*` until S10 — correct per §8.7.
3. **SDK:** `RunOptions` gets a callback `onStarted?: (s: {commandId: string; replayed: boolean}) => void` (the `started` frame) so that `exec_run` marks `replayed: true` (§7.4). The rest (`signal`, `retryBudgetMs`) already exists in S7. Create, fork, `exec_start`, `snapshot_save` read `Idempotency-Replayed` from the `sbx.raw` response themselves.
4. **HTTP adapter:** `@modelcontextprotocol/hono` is not needed — `createMcpHandler(factory).fetch(request, {authInfo})` is already web-standard; the routes, `Host`/`Origin` checks, and the body limit are our own in Hono. Fewer dependencies.
5. **`401` from the API in the middle of a call (§6.3 item 3):** the handler marks a per-request `AuthFailure`; if the `createMcpHandler` response is JSON (SSE not started), the route replaces it with HTTP `401` with `WWW-Authenticate: ... error="invalid_token"`; if the SSE stream is already going, the tool error `unauthorized` (`retryable: true`) remains.
6. **Conformance:** a run against `createHttpApp` with an injected `authenticate` (a fixed principal) and the fake API; scenarios requiring resources/prompts/sampling etc. go in `apps/mcp/test/conformance-baseline.yml` with a reason.
7. **stdio and scopes:** when the connection starts, `GET /v1/me` with a 5 s timeout; an error (not logged in, network) — the list as for a person (all tools), calls are still checked by `api`.
8. **`Host` check:** allowed are the host and hostname without port from `SBX_MCP_PUBLIC_URL` plus `SBX_MCP_ALLOWED_HOSTS` (comma-separated); a mismatch gives `421`. An `Origin` not in `SBX_MCP_ALLOWED_ORIGINS` gives `403`. `/healthz`, `/readyz` without checks.
9. **Ports:** `mcp` listens on `:8080` (`/mcp`, PRM, `/healthz`, `/readyz`) and `:9090` (`/metrics`, `/healthz`, `/readyz`). Compose publishes `127.0.0.1:8090:8080` and `127.0.0.1:9092:9090`. dev-cp: Serve `8443:/mcp` and `8443:/.well-known/oauth-protected-resource/mcp` → `127.0.0.1:8090`.
10. **`exec_output`:** reading is `GET /commands/{cmd}` (status, `streams`) + `GET /output` per stream; waiting is `Command.follow({from: offsets, encoding: "base64"})` until the first chunk + 500 ms of extra collection or `exit` (§17 leaves the choice to the implementer).
11. **`files_read`:** `sbx.raw` `GET /files/content` with `Range: bytes=a-b` (`parseAs: "arrayBuffer"`); the first 8 KiB for `as: auto` — by the same request.
12. **Integration tests against the real `api`** in process (`@sbx/api/testing`, like `apps/cli/test/helpers/api.ts`) — one end-to-end scenario in task 13, on top of the spec: it catches discrepancies between the fake and the API.
13. **E2E on `pve` (§14.4) and the manual client checklist** — not in this thread (CT 590 and `pve` are forbidden); the scenario `sbx-bench s11` is not written, the checklist and configs are recorded in `apps/mcp/README.md`, the results are an open question for master.
14. The label `created-via=mcp` is valid (labels in the API are free-form, `apps/api/src/schemas/common.ts`).
15. **`fail_fast` and `warmAvailable` are not introduced:** S7 removed them from the public contract (Ilia's decision, no warm pool; `failFast` in the body is `400`). The `pool_exhausted` hint is not needed.
16. **Progress:** with a `progressToken`, the waits of create/resume/fork/recover/stop, `snapshot_save`, and `exec_run` send `notifications/progress` about every 5 s (a counter of seconds waited, `message` — the state or the output bytes).
17. **`traceparent`** from the request `_meta` is passed to `api` in the `traceparent` header (§13.3) if present; the SDK `User-Agent` is `sbx-mcp/<version> (<client>/<version>; stdio|http)`, the client from `clientInfo` if known at the time the SDK client is created, otherwise without it.

## Review Focus

1. **A multibyte character at the boundary of a tail or chunk** (`max_output_bytes` cuts in the middle of UTF-8, the tail starts with a continuation byte). Expectation: offsets always on a character boundary, a chain of `exec_output` assembles the output byte for byte. Test — task 2 (unit) and task 7 (sha256 of output with Cyrillic and emoji).
2. **`wait_seconds` expired while `POST /commands` is still waiting for the sandbox to be ready** (the command id is unknown). Expectation: `deadline_exceeded`, `retryable: true`, `idempotency_key` in the response; a retry with it attaches to the same command. Test — task 7.
3. **Parallel stdio calls with an expired token.** Expectation: one refresh through the CLI provider, both calls succeed. Test — task 11.
4. **`--sandbox self` without `SBX_SANDBOX_ID`** or with a foreign sandbox in the arguments. Expectation: a clear startup error on stderr and exit code 2; the tools have no `sandbox` argument, the bound one is substituted. Test — tasks 5 and 11.
5. **`files_edit` on a file with CRLF and an `old_text` with LF; a file > 1 MiB; a file changed between read and write.** Expectation: "not found" with a match count of 0, a size error, `conflict`; the file is untouched. Test — task 8.

---

### Task 1: `apps/mcp` skeleton and the Bun spike (§12.2)

**Files:**
- Create: `apps/mcp/{package.json,tsconfig.json,vitest.config.ts}`, `apps/mcp/src/{index.ts,version.ts}`, `apps/mcp/test/bun-spike.test.ts`, `apps/mcp/test/fixtures/spike-server.ts`
- Modify: `pnpm-lock.yaml` (via `pnpm install`)

**Interfaces:**
- Produces: the package `@sbx/mcp` (`exports: {".": "./src/index.ts"}`), `MCP_SERVER_NAME = "sbx"`, `MCP_VERSION` (= the CLI version `0.1.0`).

- [ ] **Step 1:** `package.json`: dependencies `@modelcontextprotocol/server@2.4.0`, `@sbx/sdk: workspace:*`, `hono@4.13.14`, `@hono/node-server@2.1.5`, `zod@4.6.7`, `pino@10.4.0`, `prom-client@15.1.3`; devDependencies `@modelcontextprotocol/client@2.4.0`, `@modelcontextprotocol/conformance@0.1.16`, `@modelcontextprotocol/inspector@2.13.0`, `ajv@8.20.0`, `ajv-formats@3.0.1`, `@sbx/api`, `@sbx/core`, `@sbx/db` (workspace, for integration). The vitest config is like `apps/cli` (the `source` condition, `globalSetup` `@sbx/db/testing/global-setup`, `testTimeout` 120 000). `pnpm install`.
- [ ] **Step 2: failing test** `bun-spike.test.ts`: `bun build --compile` of the fixture `spike-server.ts` (import of `serveStdio` from `@modelcontextprotocol/server/stdio`, one tool `ping`) into tmp; run the binary; the `@modelcontextprotocol/client` over stdio: `tools/list` contains `ping`, `tools/call ping` → the text `pong`. A second case: the same for `--target=bun-linux-x64`, build only (code 0).
- [ ] **Step 3:** the fixture and `src/index.ts`/`version.ts`; the test is green. If `bun build --compile` cannot build the SDK — record the reason in the plan and spec §19, pick a workaround (§12.2) before continuing.
- [ ] **Step 4:** `pnpm --filter @sbx/mcp test && pnpm --filter @sbx/mcp typecheck && pnpm lint` — green.
- [ ] **Step 5:** commit `mcp: package skeleton and Bun compile spike`.

### Task 2: Output for the LLM: decoder, sanitizing, fencing, truncation (§9, §11.3)

**Files:**
- Create: `apps/mcp/src/output/{utf8.ts,sanitize.ts,fence.ts,budget.ts,result.ts}`
- Test: `apps/mcp/test/output-{utf8,sanitize,fence,budget,result}.test.ts`

**Interfaces:**
- Produces:
  - `decodeUtf8Chunk(bytes: Uint8Array, opts: {atStart: boolean; final: boolean}): {text: string; startSkip: number; endHold: number}` — `atStart=false` skips leading continuation bytes (≤ 3), `final=false` holds an incomplete sequence at the end (≤ 3); invalid bytes become U+FFFD.
  - `sanitizeForLlm(text: string): string` — §9.3 + §11.3 item 3 (ANSI CSI/OSC/other ESC are removed; `\r\n`→`\n`; a lone `\r` — the text after the last `\r` in the line remains; C0/C1 except `\t`,`\n` → `\u{XX}`; Unicode Tags U+E0000–E007F, bidi U+202A–202E, U+2066–2069, U+200E, U+200F, U+061C, U+200B, U+2060–2064, U+FEFF not at the start → `\u{XXXX}`; U+200C/U+200D stay).
  - `fenceUntrusted(blocks: {label: string; text: string}[], rand?: () => string): string` — a shared `nonce` (6 hex) per response, format `<<<sbx-untrusted id=<nonce> <label>>>>\n…\n<<<end id=<nonce>>>`; if any text contains `<<<end id=<nonce>` — a new nonce. The text is cleaned by `sanitizeForLlm` inside.
  - `splitBudget(max: number, sizes: {stdout: number; stderr: number}): {stdout: number; stderr: number}` — half each, what the shorter stream does not use goes to the longer one.
  - `truncationNote(stream: string, r: {from: number; to: number; size: number; mode: "tail" | "forward"}): string | null` — "stdout: last N of M bytes. Earlier output: exec_output with stdout_offset=0." / "bytes A–B of M …"; `null` if there is no truncation.
  - `MAX_RESULT_CHARS = 80_000`; `toolText(header: Record<string, unknown>, extra?: string[]): CallToolResult` (compact JSON without empty fields, `snake_case` keys — as passed) and `capResult(r: CallToolResult): CallToolResult` (text beyond 80 000 characters is cut with an explicit line "response cut at 80000 characters").
- [ ] **Step 1: failing tests:** cuts of `"é"`, `"€"`, `"😀"` at every byte (`startSkip`/`endHold` and the concatenation of two calls = the original text); `0xFF` → U+FFFD; sanitizing: `\x1b[31mred\x1b[0m`→`red`, OSC 8 with a link → only the link text, OSC 52 removed, `"a\rb\rc\n"`→`"c\n"`, `\x07`→`\u{07}`, `\u0085`→`\u{85}`, `"\u{E0041}"`→`"\u{E0041}"` as a visible notation, `"a‮b"`→`"a\u{202E}b"`, `"👨‍👩‍👧"` unchanged, a leading U+FEFF is kept, an inner one is replaced; fencing: data `<<<end id=abc123>>>` with `rand` → `abc123`, then `def456` — the block with `def456`, data intact; a fake end with another id does not close the block; `splitBudget(16384, {stdout: 100000, stderr: 912})` → `{stdout: 15472, stderr: 912}`; `capResult` cuts 100 000 characters to ≤ 80 000 with a note.
- [ ] **Step 2:** run — FAIL. **Step 3:** implement. **Step 4:** PASS, `typecheck`, `lint`.
- [ ] **Step 5:** commit `mcp: utf8 decoder, sanitizer, untrusted fence, truncation`.

### Task 3: Errors, call deadline, idempotency keys (§7.4–§7.6)

**Files:**
- Create: `apps/mcp/src/{errors.ts,deadline.ts,idempotency.ts}`
- Test: `apps/mcp/test/{errors,deadline,idempotency}.test.ts`

**Interfaces:**
- Produces:
  - `class ToolError extends Error {code: string; retryable: boolean; hint?: string; details?: Record<string, unknown>; idempotencyKey?: string}`.
  - `errorResult(err: unknown, extra?: {idempotencyKey?: string}): CallToolResult` (`isError: true`, text in the format of §7.6: `error`, `message`, `retryable`, `retry_after` (s, if present), `hint`, `idempotency_key`, `request_id`; an unknown error — `internal`, without a stack).
  - `hintFor(code: string, ctx: {sandbox?: string; details: Record<string, unknown>}): string | undefined` — the table of §7.6 plus `not_logged_in` ("run `sbx login` in a terminal, then retry"), `desktop_unsupported`, `desktop_busy`, `idempotency_key_reused` ("use a new idempotency_key"), `deadline_exceeded`, `rate_limited`, `token_provider_failed`.
  - `CALL_BUDGET_MS = 50_000`, `RESPONSE_MARGIN_MS = 1_500`; `class Deadline { constructor(parent: AbortSignal, budgetMs = CALL_BUDGET_MS); signal: AbortSignal; remainingMs(): number; waitMs(waitSeconds: number): number /* min(ws*1000, remaining − margin), ≥ 0 */; expired(): boolean; cancelled(): boolean /* parent aborted */ }`.
  - `apiIdempotencyKey(tool: string, modelKey: string, sandboxId?: string): string` — `mcp:<tool>:<sandbox id>:<key>` or `mcp:<tool>:<key>`; longer than 255 — the `sha256` hex of the string. `IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._-]{1,128}$/`.
- [ ] **Step 1: failing tests:** every row of the S7 §5.5 table (`sandbox_not_ready`, `sandbox_starting`, `agent_unavailable`, `operation_in_progress`, `forbidden` with `details.requiredScope`, `confirmation_required`, `quota_exceeded`, `path_not_found`, `not_found`, `validation`, `rate_limited`, `idempotency_key_reused`) and S10 §13.2 (`desktop_unsupported`, `desktop_not_ready`, `desktop_busy`, `invalid_action`, `action_failed`, `streamer_unavailable`) → the text contains `error: <code>` and the expected `hint`; `forbidden` with `requiredScope: "files:write"` → the hint mentions `files:write`; `Deadline` with fake timers: `waitMs(50)` at start = 48 500; after 50 s `expired()`; parent cancellation → `cancelled()`; `apiIdempotencyKey("exec_run","k1","sb_1")` = `mcp:exec_run:sb_1:k1`, a 128-character key on a long id — sha256.
- [ ] **Steps 2–4:** FAIL → implement → PASS, typecheck, lint.
- [ ] **Step 5:** commit `mcp: tool errors with hints, call deadline, idempotency keys`.

### Task 4: Fake API for contract tests (§14.2)

**Files:**
- Create: `apps/mcp/test/fake-api/{index.ts,state.ts,routes-sandboxes.ts,routes-commands.ts,routes-files.ts,routes-ports.ts,routes-snapshots.ts,routes-desktop.ts,openapi-check.ts,desktop.openapi.json}`
- Test: `apps/mcp/test/fake-api.test.ts`

**Interfaces:**
- Produces: `startFakeApi(o?: FakeApiOptions): Promise<FakeApi>`:
  ```ts
  interface FakeApi {
    url: string;                       // http://127.0.0.1:<port>
    tokens: Map<string, FakePrincipal>; // bearer -> principal
    journal: string[];                  // "METHOD /path" of every request
    state: FakeState;                   // sandboxes, commands, files (tmp dir), ports, snapshots, desktop
    script: FakeScript;                 // per-test faults
    contractErrors: string[];           // OpenAPI mismatches; tests assert it stays empty
    close(): Promise<void>;
  }
  interface FakePrincipal { kind: "oidc" | "team_key"; scopes: string[]; teamId: string; userEmail?: string; keyId?: string; expiresAt?: string; disabled?: boolean }
  interface FakeScript {
    holdCommandsPostMs?: number;        // POST /commands answers after this delay
    breakStreamAfterBytes?: number;     // cut the NDJSON stream once
    silent?: boolean;                   // long-polls never answer
    expireTokenOnce?: string;           // next request with this bearer -> 401 token_expired
    failNext?: {path: RegExp; status: number; code: string; retryable: boolean};
    noDesktopRoutes?: boolean;          // desktop routes -> plain 404 (API without S10)
  }
  ```
  The fake's commands are scenario-based: a `command` of the form `fake:emit <bytes>:<chunk>:<delayMs>` generates deterministic output (including multibyte), `fake:sleep <s>`, `fake:exit <code>`, `fake:inject` prints `\x1b[31m`, Unicode tags, and a fake `<<<end id=...>>>`. The rest is `echo`-like. Sandboxes go `creating→ready` after `readyAfterMs` (default 50). The screenshot is a fixed 1280×800 PNG and JPEG; actions are recorded in `state.desktop.actions`.
- [ ] **Step 1: failing test** `fake-api.test.ts`: the validator (ajv 2020 + formats over `apps/api/openapi/v1.json` and `desktop.openapi.json`) catches a deliberately wrong response (`contractErrors` is not empty); an ordinary SDK scenario (`new Sbx({baseUrl, apiKey})`: create → wait → exec → files write/read → ports → stop → delete) passes with an empty `contractErrors`; `GET /v1/me` for a `team_key` returns `auth.kind: "team_key"` and scopes; NDJSON `/stream` with `follow=true` returns `heartbeat`, `truncated`, `exit`.
- [ ] **Steps 2–4:** FAIL → implement (Hono + `@hono/node-server` on a random port; request and response checks by the path and method from OpenAPI in middleware) → PASS.
- [ ] **Step 5:** commit `mcp: in-memory fake API checked against the OpenAPI document`.

### Task 5: Registry, context, server factory, schema linter (§5, §7.1–§7.3, §7.7–§7.8, §8.8)

**Files:**
- Create: `apps/mcp/src/{registry.ts,context.ts,server.ts,instructions.ts,schema-rules.ts,log.ts}`
- Test: `apps/mcp/test/{registry,schema-rules,server}.test.ts`, `apps/mcp/test/helpers/connect.ts`

**Interfaces:**
- Consumes: Task 2 (`toolText`, `capResult`), Task 3 (`Deadline`, `errorResult`, `ToolError`).
- Produces:
  ```ts
  type Toolset = "core" | "files" | "ports" | "snapshots" | "desktop";
  const TOOLSETS: readonly Toolset[];
  interface ToolDef<Shape extends z.ZodRawShape = z.ZodRawShape> {
    name: string; title: string; description: string;
    toolset: Toolset;
    scopes: readonly string[];          // all required for a team key
    annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
    sandboxArg: boolean;                // registry prepends `sandbox` unless pinned
    hiddenWhenPinned?: boolean;
    shape: Shape;                       // without `sandbox`
    handler(args: z.infer<z.ZodObject<Shape>> & { sandbox: string }, ctx: ToolContext): Promise<CallToolResult>;
  }
  interface ServerOptions {
    tools: readonly ToolDef[];            // ALL_TOOLS by default
    toolsets?: readonly Toolset[];        // default all
    readOnly?: boolean;
    principal?: { kind: "oidc" | "team_key" | "session"; scopes: string[] } | null; // null: unknown -> person
    pinnedSandbox?: string;               // id or slug
    sbx: () => Sbx;                       // may throw ToolError not_logged_in
    transport: "stdio" | "http";
    log: Logger;                          // pino
    wasCancelledByClient?: (requestId: string | number) => boolean;
    onAuthFailure?: () => void;           // HTTP: API answered 401 (decision 5)
    acquireSlot?: () => (() => void) | null; // HTTP concurrency limit; null -> rate_limited
  }
  function selectTools(o: Pick<ServerOptions, "tools" | "toolsets" | "readOnly" | "principal" | "pinnedSandbox">): ToolDef[];
  function inputSchemaOf(t: ToolDef, pinned: boolean): z.ZodObject;
  function createServer(o: ServerOptions): McpServer;  // name "sbx", version MCP_VERSION, instructions, cacheHints tools/list {ttlMs: 3_600_000, cacheScope: "private"}
  interface ToolContext {
    sbx(): Sbx;
    deadline: Deadline;
    call: { signal: AbortSignal; retryBudgetMs: number }; // for every SDK call
    sandbox(ref: string): string;          // pinned substitution
    progress(progress: number, total?: number, message?: string): Promise<void>; // no-op without progressToken
    cancelledByClient(): boolean;          // stdio notifications/cancelled for this request
    transport: "stdio" | "http";
    log: Logger;
    userAgent: string;                     // sbx-mcp/<version> (<client>/<ver>; stdio|http)
  }
  const SERVER_INSTRUCTIONS: string;       // ≤ 1500 chars, text of §7.8
  function lintToolSchema(name: string, schema: unknown): string[]; // §7.2 violations
  ```
  The call wrapper in `createServer`: `Deadline` from `ctx.mcpReq.signal`; `acquireSlot`; errors → `errorResult`; `SbxError` 401 → `onAuthFailure` and the error `unauthorized` `retryable: true`; `capResult`; log (tool, sandbox, `command_id`, duration, error code, `request_id`) without arguments.
- [ ] **Step 1: failing tests** with a test set of 4 dummy `ToolDef`s (one each for read-only, destructive, pinned-hidden, scope `files:write`): `selectTools` for toolsets × readOnly × principal (a `team_key` without `files:write` does not see the tool; `oidc` sees everything) × pinned (hidden ones disappear, the rest have no `sandbox` in the schema, a call substitutes the pinned id); `tools/list` via an in-memory client (`helpers/connect.ts`: `connectInMemory(server)` for the 2026-07-28 era and `legacy` 2025-11-25) — order as in the array, all four annotations, the result has `ttlMs`/`cacheScope` in the modern era; calling a hidden tool is a JSON-RPC "unknown tool" error; an argument error is a result with `isError: true`; `SERVER_INSTRUCTIONS.length ≤ 1500`; `lintToolSchema` finds `anyOf`, `type: ["integer","null"]`, a property without `description`, a numeric `enum`, a non-`object` root.
- [ ] **Steps 2–4:** FAIL → implement → PASS, typecheck, lint.
- [ ] **Step 5:** commit `mcp: tool registry, filters, pinned mode, server factory`.

### Task 6: `core` tools: catalog and sandbox (§8.1–§8.2)

**Files:**
- Create: `apps/mcp/src/tools/{catalog.ts,sandboxes.ts,index.ts,shapes.ts}`
- Test: `apps/mcp/test/tools-sandboxes.test.ts`

**Interfaces:**
- Consumes: Task 5 `ToolDef`, `ToolContext`; Task 4 fake.
- Produces: `CATALOG_TOOLS` (`limits_get`, `templates_list`), `SANDBOX_TOOLS` (`sandbox_create`, `sandbox_list`, `sandbox_get`, `sandbox_update`, `sandbox_stop`, `sandbox_resume`, `sandbox_fork`, `sandbox_recover`, `sandbox_delete`); `ALL_TOOLS` in `tools/index.ts` (extended by the following tasks in the order of §8); `sandboxView(s: SandboxData): Record<string, unknown>` — the response shape of §8.2 (`snake_case`, no extra fields); `waitSandbox(ctx, id: string, target: "ready" | "stopped", waitMs: number): Promise<SandboxData>` — a long-poll `GET ?waitFor=&waitSeconds=` until the target, a final state, or the deadline, with no exception on the deadline; shared schema fields in `shapes.ts` (`waitShape`, `idempotencyKeyShape`, `envShape` with the description "non-secret values only", `labelsShape`).
- [ ] **Step 1: failing tests** via an in-memory client and the fake: `limits_get` for a key — "team key key_…", scopes, quotas; `templates_list` — `capabilities` and sizes; `sandbox_create` adds `created-via=mcp`, waits for `ready`, the response has no `createdBy`/`templateVersion`, has `idempotency_key`; with `readyAfterMs` 60 000 and `wait_seconds: 2` — a response with `state: creating`, `operation_id`, and the hint `sandbox_get wait_for=ready` within ≤ 3 s; a retry with the same `idempotency_key` — one sandbox in the fake and `replayed: true`; `error` → `isError: true` with `sandbox.error`; `sandbox_resume` with `env` + `unset_env` → the body `{env: {A: "1", B: null}}` in the fake's journal; `sandbox_update ttl_seconds: 0` → `ttlSeconds: null`; `sandbox_delete` without `confirm` — a schema error; with a foreign `confirm` — `confirmation_required` and the sandbox is intact; with the right one — deleted; the create/resume/fork schemas contain no `secrets`/`secret_files`.
- [ ] **Steps 2–4:** FAIL → implement → PASS, `contractErrors` empty.
- [ ] **Step 5:** commit `mcp: catalog and sandbox lifecycle tools`.

### Task 7: Command tools (§8.3, §9.1–§9.2, §10.2) + `onStarted` in the SDK

**Files:**
- Create: `apps/mcp/src/tools/commands.ts`, `apps/mcp/src/output/tail.ts`
- Modify: `packages/sdk-ts/src/commands.ts` (`RunOptions.onStarted`, called on the `started` frame), `packages/sdk-ts/test/facade.test.ts` (an `onStarted` test with `replayed`)
- Test: `apps/mcp/test/tools-commands.test.ts`

**Interfaces:**
- Consumes: Task 2, 3, 5, 6.
- Produces: `COMMAND_TOOLS` (`exec_run`, `exec_start`, `exec_output`, `exec_list`, `exec_kill`); `class ByteTail { constructor(max: number); push(bytes: Uint8Array, nextOffset: number): void; truncate(availableFrom: number): void; bytes(): Uint8Array; from: number; to: number }`; `KILL_GRACE_MS = 5_000` (stdio cancellation), `exec_kill` SIGTERM — `graceMs: 10_000`.
- [ ] **Step 1: failing tests:**
  - SDK: `run(..., {onStarted})` gets `{commandId, replayed: true}` on a retry with the same key.
  - `exec_run` of a short command: `status: exited`, `exit_code`, tails in fencing, no truncation note.
  - `exec_run` `fake:emit 200000` with `max_output_bytes: 16384`: header `stdout: {size, from, to}`, the line "last N of 200000 bytes"; with `wait_seconds: 1` and a long command — `status: running`, `command_id`, offsets, the `exec_output` hint; a chain of `exec_output` (`wait_seconds: 5`) with the returned offsets until `done: true` assembles the output, the sha256 matches the expected one (output with Cyrillic and emoji).
  - An NDJSON break (`breakStreamAfterBytes`) in the middle of `exec_run` — the same bytes.
  - `holdCommandsPostMs: 70_000` and `wait_seconds: 50` — a response in < 50 s: `deadline_exceeded`, `retryable: true`, `idempotency_key`; a retry with it — the same command (`replayed: true`), one command in the fake.
  - One model key on two sandboxes — two commands; the same key with different arguments — an error with the hint "new idempotency_key".
  - `exec_output` without offsets — the tail; an offset < `available_from` — the line "N bytes were dropped by retention"; a stopped sandbox — `sandbox_not_ready`.
  - Cancellation: `ctx.cancelledByClient()` = true on abort → `POST /kill` with `graceMs: 5000` in the journal; an abort without client cancellation (stdin closing, HTTP) → no `kill`.
  - `exec_start` → `command_id`, `pid`; `exec_list` defaults to `status=running`; `exec_kill` SIGTERM → `/kill`, SIGINT → `/signal`.
  - The `fake:inject` output is sanitized, a fake fence end does not close the block.
- [ ] **Steps 2–4:** FAIL → implement (`exec_run`: `sb.run(cmd, {encoding: "base64", idempotencyKey: apiIdempotencyKey(...), timeoutSeconds, signal, onStart, onStarted})`, the wait is cut by the timer `deadline.waitMs(wait_seconds)` by leaving the loop; before the `command_id` is known — `deadline_exceeded`) → PASS.
- [ ] **Step 5:** commit `mcp: exec tools with offsets, deadlines and cancellation; sdk: onStarted`.

### Task 8: File tools (§8.4)

**Files:**
- Create: `apps/mcp/src/tools/files.ts`, `apps/mcp/src/output/image.ts`
- Test: `apps/mcp/test/tools-files.test.ts`

**Interfaces:**
- Produces: `FILE_TOOLS` (`files_read`, `files_write`, `files_edit`, `files_list`, `files_stat`, `files_delete`); `sniffImage(head: Uint8Array): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null`; `IMAGE_MAX_BYTES = 3 * 1024 * 1024`, `WRITE_MAX_BYTES = 1024 * 1024`.
- [ ] **Step 1: failing tests:** `files_read` of 100 000 bytes of text with `max_bytes: 32768` — `next_offset`, the end moved to a character boundary, the last chunk is `eof: true`; a PNG ≤ 3 MiB with `as: auto` — image content `image/png`; binary (NUL in the first 8 KiB) — without content, the hint `as: base64`; `as: image` for 4 MiB — error; `files_write` `encoding: base64`, `mode: "0644"` → `mode=420` in the journal; larger than 1 MiB — an error before the API with the advice `sbx cp`; `files_edit`: 0 matches — "not found", 2 without `replace_all` — "matches 2 times…", `replace_all` — the number of replacements and ≤ 5 lines of context; a CRLF file and an `old_text` with `\n` — "not found"; a file > 1 MiB — error; a file changed by the fake between read and write — `conflict`, content untouched; binary — error; `mode` is preserved; `files_list` — rows `d|f|l`, size, `modified_at`, path, symlink target, a name with `‮` sanitized and fenced; `files_stat` of a missing one — `exists: false` without `isError`; `files_delete recursive`.
- [ ] **Steps 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** commit `mcp: file tools with ranges, images and files_edit`.

### Task 9: Ports and snapshots (§8.5–§8.6)

**Files:**
- Create: `apps/mcp/src/tools/{ports.ts,snapshots.ts}`
- Test: `apps/mcp/test/tools-ports-snapshots.test.ts`

**Interfaces:**
- Produces: `PORT_TOOLS` (`port_expose`, `port_list`, `port_unexpose`), `SNAPSHOT_TOOLS` (`snapshot_save`, `snapshot_list`, `snapshot_delete`).
- [ ] **Step 1: failing tests:** a new port without `access` → `PUT` with `access: "sso"`, the response without `url_with_token`; `access: token` → `url_with_token` with the note "secret: give it to the user, do not store it"; a port already in `token`, a call without `access` → no `PUT` sent (journal), the same mode, the token not shown; `rotate_token: true` → `rotate-token` and `url_with_token`; `port_list` merges `hosted` and `listening` (process, addresses, published, mode, URL), process names sanitized; `snapshot_save` with `wait` → state `ready`, a retry with a key — `replayed: true`; a name outside `^[a-z0-9][a-z0-9-]{0,62}$` — a schema error; `snapshot_delete` with a wrong `confirm` — `confirmation_required`, the snapshot intact; with the right one — deleted.
- [ ] **Steps 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** commit `mcp: port and snapshot tools`.

### Task 10: Desktop and computer-use (§8.7, S10 §12–§13)

**Files:**
- Create: `apps/mcp/src/desktop/{api.ts,coords.ts,keys.ts}`, `apps/mcp/src/tools/desktop.ts`
- Test: `apps/mcp/test/{desktop-coords,desktop-keys,tools-desktop}.test.ts`

**Interfaces:**
- Produces:
  - `desktopApi(ctx: ToolContext, sandbox: string)`: `status()`, `link()`, `screenshot(q)`: `{bytes, contentType, screen, image, cursor}`, `act(body)`, `clipboardGet()`, `clipboardSet(text)` — via `sbx.raw` with type casts; `404` without a route → `ToolError desktop_unsupported`.
  - `defaultCoordinateSpace(screen: {width: number; height: number}, max = {width: 1280, height: 800}): {width: number; height: number}` — how the API scales the screenshot (fit preserving the aspect ratio, do not enlarge, rounding as in S10 §12.1: `scale = min(maxW/w, maxH/h, 1)`, sizes `Math.round`).
  - `parseChord(s: string): string[]` (the S10 §12.2 dictionary; an unknown name → `ToolError invalid_action` with a list of allowed ones); `KEY_NAMES`.
  - `TYPE_BUDGET_MS = 40_000`; `SCREEN_CACHE_MS = 10_000` (an in-process cache of `GET /desktop` per sandbox).
  - `DESKTOP_TOOLS` (`desktop_url`, `computer_screenshot`, `computer_click`, `computer_move`, `computer_drag`, `computer_scroll`, `computer_key`, `computer_type`, `computer_clipboard_read`, `computer_clipboard_write`), scopes `computer_*` — `["desktop", "sandboxes:read"]`, `desktop_url` — `["desktop"]`.
- [ ] **Step 1: failing tests:** coordinate vectors (1920×1080 → 1280×720; 1280×800 → 1280×800; 3840×2160 → 1280×720; 1024×768 → 1024×768; 2560×1600 → 1280×800); `parseChord("ctrl+shift+t")`, `"enter"`, unknown `"hyper"`; a screenshot — image content `image/jpeg` by default, text with `coordinate_space`, with `region_*` — without `coordinate_space` and with the line "region view…"; `computer_click` without `coordinate_*` → `coordinateSpace` in the journal per the fake's screen, the action `wait` `settle_ms` and `screenshot` in the body, the response is text + image; `computer_key repeat: 3` — three `key` actions; `computer_type` of 10 000 characters with `delay_ms: 5` — an error before the API (empty journal), the advice `computer_clipboard_write` + `ctrl+v`; the `computer_type` text is not in the log; `noDesktopRoutes` → `desktop_unsupported`; `desktop_busy` → `retryable: true`; `desktop_url` — the note "secret".
- [ ] **Steps 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** commit `mcp: desktop and computer-use tools (S10 API, faked)`.

### Task 11: stdio — `runStdio` and `sbx mcp` (§6.1, §10.2)

**Files:**
- Create: `apps/mcp/src/stdio.ts`
- Modify: `apps/cli/src/commands/mcp.ts` (replacing the stub), `apps/cli/package.json` (`@sbx/mcp: workspace:*`), `apps/mcp/src/index.ts`
- Test: `apps/mcp/test/stdio.test.ts`, `apps/cli/test/mcp.test.ts`, `apps/mcp/test/inspector-smoke.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface StdioOptions {
    sbx: () => Sbx;                 // throws SbxError/ToolError not_logged_in when there is no login
    toolsets?: Toolset[]; readOnly?: boolean; pinnedSandbox?: string;
    log: Logger;
    stdin?: Readable; stdout?: Writable;   // tests
  }
  function runStdio(o: StdioOptions): Promise<{ closed: Promise<void>; close(): Promise<void> }>;
  class CancelTrackingTransport implements Transport { /* wraps StdioServerTransport, records ids of notifications/cancelled */ wasCancelled(id: string | number): boolean }
  function parseToolsets(csv: string): Toolset[];  // unknown name -> Error listing the valid ones
  ```
  CLI: `sbx mcp [--toolsets] [--read-only] [--sandbox <id|slug|self>] [--log-level] [--log-file]`, env `SBX_MCP_TOOLSETS`, `SBX_MCP_READ_ONLY=1`; global `--profile`, `--api-url`, `--team` — as for the other commands; `sbx` for MCP is `new Sbx({..., tokenProvider})` from `ctx.bearer`, the CLI errors `not_logged_in`/`login_required` → `SbxError {code: "not_logged_in"}`; `self` without `SBX_SANDBOX_ID` → an error on stderr, code 2.
- [ ] **Step 1: failing tests:**
  - `stdio.test.ts` (in-memory stream): `tools/list`; `notifications/cancelled` for `exec_run` → `kill` in the fake's journal; closing stdin in the middle of `exec_run` → no `kill`; nothing but JSON-RPC in stdout (intercepted).
  - `apps/cli/test/mcp.test.ts` (child process `bun src/main.ts mcp` against the fake): without login — `tools/list` works, a call → `not_logged_in` with text about `sbx login`; with `SBX_API_KEY` of a `read-only` key — only read tools; a profile with an expired JWT — two parallel calls, one refresh at the test OIDC (`startTestOidcServer`), both succeed; `--sandbox self` without `SBX_SANDBOX_ID` — code 2 and a message on stderr; `--sandbox sb_x` — the schemas have no `sandbox`; the child's stdout is parsed entirely as JSON-RPC; `notifications/cancelled` over real stdio → `kill`.
  - `inspector-smoke.test.ts`: `inspector --cli bun <cli>/src/main.ts mcp --method tools/list` and `--method tools/call --tool-name limits_get` against the fake — code 0, 38 tools.
- [ ] **Steps 2–4:** FAIL → implement → PASS; `pnpm --filter @sbx/cli test` and `pnpm --filter @sbx/cli build` (the binary builds).
- [ ] **Step 5:** commit `mcp: stdio server; cli: sbx mcp`.

### Task 12: Remote HTTP server (§6.2–§6.6, §11.5, §13.3)

**Files:**
- Create: `apps/mcp/src/http/{app.ts,auth.ts,prm.ts,limits.ts}`, `apps/mcp/src/{settings.ts,metrics.ts,main.ts}`, `apps/mcp/test/conformance-baseline.yml`
- Test: `apps/mcp/test/{http-auth,http-app,conformance}.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface HttpOptions {
    apiUrl: string;                 // SBX_MCP_API_URL
    publicUrl: string;              // SBX_MCP_PUBLIC_URL, e.g. https://api.example.com/mcp
    issuer: string | null;          // SBX_OIDC_ISSUER (PRM authorization_servers)
    allowedHosts?: string[]; allowedOrigins?: string[];
    log: Logger; metrics?: Metrics;
    fetch?: typeof fetch;
    authenticate?: (req: Request, team: string | undefined) => Promise<Principal | Response>; // tests, conformance
    now?: () => number;
  }
  interface Principal { token: string; team?: string; kind: "oidc" | "team_key" | "session"; scopes: string[]; expiresAt: number | null /* ms */ }
  function createHttpApp(o: HttpOptions): { app: Hono; close(): Promise<void> };
  class MeCache { /* key sha256(token)+team; ok: min(30 s, exp − now); fail: 5 s */ }
  const EXP_MARGIN_MS = 55_000; const MAX_BODY_BYTES = 2 * 1024 * 1024; const MAX_CALLS_PER_PRINCIPAL = 16;
  function protectedResourceMetadata(o: {publicUrl: string; issuer: string | null}): Record<string, unknown>;
  ```
  `main.ts`: `loadSettings(env)` → `createHttpApp` on `:8080` (`SBX_MCP_PORT`), ops on `:9090`; SIGTERM — `close()` and exit within ≤ 10 s.
- [ ] **Step 1: failing tests** (`createHttpApp` on a random port, the fake API, the `@modelcontextprotocol/client` Streamable HTTP client in the eras 2026-07-28 and 2025-11-25):
  - without a bearer — `401`, `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"`; PRM per RFC 9728 (`resource`, `authorization_servers`, `scopes_supported` without `offline_access`, `bearer_methods_supported: ["header"]`); an invalid token — `401` with `error="invalid_token"`; `user_disabled` — `403`; a JWT with `exp` in 30 s — `401` "token expires too soon"; cache: a second request within 30 s without `/v1/me`, after 31 s — again, a refusal is cached for 5 s; `Sbx-Team` and `?team=` reach `/v1/me` and the calls.
  - `Origin: https://evil.example` — `403`; a foreign `Host` — `421`; `GET /mcp`, `DELETE /mcp` — `405`; a body > 2 MiB — `413`.
  - `?toolsets=core&read_only=1` filters; a `read-only` key sees only reads; a call to a hidden tool — unknown tool; another team's resource: a sandbox of another team → `not_found` from the API, nothing changed.
  - `expireTokenOnce` in the middle of `exec_run` without progress → HTTP `401` with `WWW-Authenticate`; with a `progressToken` (SSE started) → the tool error `unauthorized`, `retryable: true`.
  - The 17th simultaneous call of one principal — `rate_limited`; an HTTP cancel/break of `exec_run` — no `kill`.
  - `/healthz`, `/readyz` without auth; `/metrics` on ops — call counters and `401`.
  - `conformance.test.ts`: `conformance server --url … --expected-failures test/conformance-baseline.yml` with an injected `authenticate` — code 0.
- [ ] **Steps 2–4:** FAIL → implement (`createMcpHandler(factory, {legacy: "stateless", maxRequestBodySize: MAX_BODY_BYTES})`; the factory takes the principal from `authInfo.extra`) → PASS.
- [ ] **Step 5:** commit `mcp: remote Streamable HTTP server with bearer check via /v1/me`.

### Task 13: Golden list, client compatibility, security, integration (§14.1–§14.2, §14.4)

**Files:**
- Create: `apps/mcp/golden/tools-list.json`, `apps/mcp/scripts/golden.ts`
- Test: `apps/mcp/test/{golden,client-compat,security,integration}.test.ts`, `apps/mcp/test/helpers/real-api.ts`

**Interfaces:**
- Consumes: everything above.
- [ ] **Step 1: failing tests:**
  - `golden.test.ts`: `tools/list` (all toolsets, a person) equals `golden/tools-list.json` (name, title, description, inputSchema, annotations); exactly 38 tools in the order of §8; the JSON of the whole response ≤ 40 000 characters; the names from `git show origin/main:apps/mcp/golden/tools-list.json` (if the file exists there) are all present. `UPDATE_GOLDEN=1` rewrites the file (`scripts/golden.ts`).
  - `client-compat.test.ts`: for every tool — `lintToolSchema` is empty; Claude Code: `mcp__sbx__<name>` ≤ 64 and `^[a-zA-Z0-9_-]+$`, root `type: object`; Codex/OpenAI: name ≤ 64, arrays have `items`, no keywords outside the OpenAI function parameters list; OpenCode: the union of the Anthropic and OpenAI rules (the schema is passed as is); Gemini CLI: after stripping `$schema` and `additionalProperties` the schema stays valid JSON Schema with the same `required`, the keywords from the Gemini OpenAPI 3.0 subset (`type`, `description`, `enum`, `properties`, `required`, `items`, `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`, `pattern`, `default`, `format`).
  - `security.test.ts`: (a) prompt injection — command output, file content, a file name, the clipboard with `<<<end id=…>>>`, `\x1b]8;;`, Unicode tags, and "ignore previous instructions" → data only inside the fence with an unguessable nonce, invisible characters made visible; (b) scope filter — a `ci` key and a key without `ports:write`: the tools are hidden and a call is unknown tool; (c) cross-team — a sandbox of another team by id: `not_found`, the journal unchanged; (d) `confirm` bypass — an empty string, the slug of another sandbox, an id with a space, case — nothing deleted; secrets: the logs (pino capture) contain no bearer, `content`, `command`, `text`, `url_with_token`.
  - `integration.test.ts` (the real `api` in process via `helpers/real-api.ts` modeled on `apps/cli/test/helpers/api.ts`): create (`markReady`) → `exec_run` → `files_write`/`files_read` → `port_expose` → `sandbox_stop` → `sandbox_delete` with `confirm` via an in-memory client; responses without errors.
- [ ] **Steps 2–4:** FAIL → generate the golden, fix what is found → PASS.
- [ ] **Step 5:** commit `mcp: golden tool list, client schema compatibility, security and integration tests`.

### Task 14: Delivery: image, compose, dev-cp, client configs, documents

**Files:**
- Create: `apps/mcp/Dockerfile`, `apps/mcp/README.md`
- Modify: `deploy/compose/compose.yaml` (service `mcp`), `deploy/compose/README.md`, `infra/dev-cp/{compose.dev-cp.yaml,names.sh,README.md}`, `docs/architecture.md` (§2, §10 per S11 §16.2), `docs/specs/s11-mcp.md` §19, `docs/plans/s11-mcp.md` (results)
- Test: `apps/mcp/test/compose.test.ts`

**Interfaces:**
- Produces: image `sbx-mcp:dev`; service `mcp` (`SBX_MCP_API_URL=http://api:8080`, `SBX_MCP_PUBLIC_URL=${SBX_MCP_PUBLIC_URL:-http://localhost:8090/mcp}`, `SBX_OIDC_ISSUER=*oidc-issuer`, `SBX_MCP_ALLOWED_ORIGINS=`, ports `127.0.0.1:8090:8080`, `127.0.0.1:9092:9090`, healthcheck `/readyz` on 9090, `depends_on: api healthy`); dev-cp: `SBX_MCP_PUBLIC_URL=https://<TS name>:8443/mcp` in `compose.dev-cp.yaml`, Serve `8443:/mcp=http://127.0.0.1:8090/mcp` and `8443:/.well-known/oauth-protected-resource/mcp=http://127.0.0.1:8090/.well-known/oauth-protected-resource/mcp` in `names.sh`.
- [ ] **Step 1: failing test** `compose.test.ts`: `docker compose -f deploy/compose/compose.yaml config` contains the service `mcp` with the needed env and ports (skipped without Docker); `names.sh` `SERVE` contains both `/mcp` paths.
- [ ] **Step 2:** Dockerfile modeled on `apps/api/Dockerfile` (prod dependencies `@sbx/mcp...`, `node apps/mcp/src/main.ts`, `USER node`, `EXPOSE 8080 9090`); `docker build -f apps/mcp/Dockerfile .` passes; the container answers `/healthz`.
- [ ] **Step 3:** README of `apps/mcp`: running, variables, Inspector (UI and `--cli`), configs for Claude Code, Codex, OpenCode, Gemini CLI (§12.3) — re-check the keys against the clients' documentation (perplexity) and record the date; the OpenCode callback port — if fixed and not 33418, record it as an open question (do not change the realm without master).
- [ ] **Step 4:** architecture §2/§10, spec §19 (the result of the Bun spike, the actual `tools/list` budget, deviations from this plan), compose README; `pnpm -r test`, `pnpm -r typecheck`, `pnpm lint`, `pnpm build` — green.
- [ ] **Step 5:** commit `mcp: image, compose service, dev-cp route, client configs`.

---

## Implementation results

All 14 tasks were completed on branch `s11-impl` (2026-10-31); details, the `tools/list` budget, and open questions are in `docs/specs/s11-mcp.md` §19.

- **Result:** 38 tools in 5 toolsets; `sbx mcp` (stdio) and the HTTP server `node apps/mcp/src/main.ts` (stateless, `/mcp` + PRM, `/healthz`, `/readyz`, `/metrics`); image `sbx-mcp:dev`; service `mcp` in `deploy/compose` (`127.0.0.1:8090`, ops `9092`); Tailscale Serve routes `8443:/mcp` and `8443:/.well-known/oauth-protected-resource/mcp` in `infra/dev-cp`; configs for Claude Code, Codex, OpenCode, Gemini CLI in `apps/mcp/README.md`.
- **Budget:** `tools/list` — 37 922 characters of 40 000 (golden test).
- **Bun:** `bun build --compile` builds the 2.4.0 server without workarounds (host and linux-x64 checked).
- **Deviations from the spec:** decisions 1–17 above and the controller's decisions during review (§19.3): `files_list.limit` ≤ 200, `files_read.max_bytes` ≤ 65 536, TTL ≤ 30 days in the schemas, `port_expose` requires `sandboxes:read`, the `exec_run` wait before `command_id` is limited by the call deadline, the `desktop_unsupported` gate via re-reading the sandbox.
- **Confirmed against the clients' documentation 2026-10-31, differs from §12.3:** OpenCode listens on a fixed port 19876 (the README sets `callbackPort: 33418`, the realm was not changed); Gemini CLI — the path `/oauth/callback`; Codex — `[mcp_servers.<name>.oauth]` and `oauth.callback_port`.
- **Not done (questions for master):** E2E on `pve` and `sbx-bench s11`; the manual client checklist; deploy to CT 590 (the Host that Serve passes); confirmation of OpenCode's `callbackPort` or an edit of the `sbx-mcp` redirect URIs; moving `src/desktop/api.ts` to SDK helpers after S10; deferred minors from the review of task 12.
