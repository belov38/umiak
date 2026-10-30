# S11 MCP-сервер: план реализации

> **Для исполнителей:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (по задаче на субагента, после каждой задачи — ревью свежим субагентом) и superpowers:test-driven-development. Шаги — чекбоксы `- [ ]`.

**Цель:** реализовать MVP S11 по `docs/specs/s11-mcp.md`: пакет `@sbx/mcp` (`apps/mcp`) с 38 инструментами в 5 toolsets, stdio-сервер `sbx mcp` в бинарнике CLI и удалённый Streamable HTTP сервер `/mcp` без состояния, сервис `mcp` в `deploy/compose` и маршрут dev-стенда.

**Архитектура:** `apps/mcp` — тонкий адаптер MCP поверх `@sbx/sdk`: инструменты описаны декларативно (`ToolDef`: zod-схема, toolset, scopes, аннотации, обработчик), реестр собирает из них `McpServer` с учётом фильтров. Обработчик получает `ToolContext` (SDK-клиент, срок 50 s, отмена, progress, журнал). stdio — `serveStdio` из `@modelcontextprotocol/server/stdio` с обёрткой транспорта, которая отличает `notifications/cancelled` от закрытия stdin. HTTP — Hono + `createMcpHandler` (stateless), bearer проверяется через `GET /v1/me` с кэшем. Тесты идут против фейкового API (Hono в памяти), каждый запрос и ответ которого проверяется по `apps/api/openapi/v1.json` (и фрагменту S10 §13 для рабочего стола).

**Стек:** Node 26.13.0 (type stripping), TypeScript 7.0.2, vitest 5.0.5, biome 2.6.4, Bun 1.4.4 (CLI). Библиотеки (проверено `npm view` 2026-10-31, новее спеки ничего стабильного нет): `@modelcontextprotocol/server` 2.4.0, `@modelcontextprotocol/client` 2.4.0 (тесты), `@modelcontextprotocol/hono` 2.0.2 — **не берём** (см. решение 4), `hono` 4.13.14, `@hono/node-server` 2.1.5, `zod` 4.6.7, `pino` 10.4.0, `prom-client` 15.1.3, `@modelcontextprotocol/conformance` 0.1.16 (0.2.0 есть только alpha), `@modelcontextprotocol/inspector` 2.13.0, `ajv` 8.20.0 + `ajv-formats` 3.0.1 (тесты).

**Спецификация:** `docs/specs/s11-mcp.md` (источник истины; § ниже — из неё). Смежные: S7 (`apps/api/openapi/v1.json`, `@sbx/sdk`, `apps/cli`), S10 §12–§13 (computer-use API, ещё не реализован).

## Глобальные ограничения

- Инструменты только через mise (`mise exec -- <cmd>`). Перед добавлением зависимости — `npm view <pkg> version`.
- Пакет в стиле S7: `"exports": {".": "./src/index.ts"}`, tsconfig как у `apps/cli` (`allowImportingTsExtensions`, `erasableSyntaxOnly`, `noEmit`), скрипты `test` (`vitest run`), `typecheck`. Без `enum`, `namespace`, parameter properties. HTTP-процесс — `node src/main.ts`. В корневых файлах — только свои строки.
- `apps/mcp` ходит только в публичное API `/v1/*` через `@sbx/sdk` (`Sbx`, `sbx.raw`). Своей БД и состояния между вызовами нет.
- Имена инструментов, toolsets, scopes, аннотации — ровно таблицы §8. Порядок `tools/list` — порядок §8.1–§8.7.
- Схемы — подмножество §7.2: корень `object`; без `oneOf/anyOf/allOf/not/$ref/$defs/if/then/else`, без массивов типов и `nullable`; `enum` только строковые; у каждого свойства `description`; аргументы `snake_case`.
- Ни один вызов не дольше 50 s (`CALL_BUDGET_MS = 50_000`); ожидания внутри заканчиваются за `RESPONSE_MARGIN_MS = 1_500` до срока.
- Секреты не попадают в аргументы, логи, метрики. pino `redact`: `*.content`, `*.old_text`, `*.new_text`, `*.text`, `*.env`, `*.command`, `*.authorization`, `req.headers.authorization`. Исключения в ответах — только `url_with_token` и ссылка `desktop_url`, с пометкой «secret».
- stdio: в stdout — только JSON-RPC; логи — stderr или `--log-file`.
- На `pve` и CT 590 ничего не запускать и не менять.
- Комментарии в коде на английском. Коммиты без `Claude-Session:` и ссылок claude.ai.

## Решения исполнителя (отклонения и уточнения спеки)

1. **Версии** — как в спеке §13.2; новее стабильных нет (2026-10-31). `@modelcontextprotocol/conformance` остаётся 0.1.16: 0.2.x только alpha.
2. **Рабочий стол (S10 не реализован).** Ручки `/desktop*` вызываются через `sbx.raw` с приведением типа (в `v1.json` их нет) в одном модуле `src/desktop/api.ts`; после S10 его заменят хелперы SDK. Фейк API проверяет их по фрагменту `apps/mcp/test/fake-api/desktop.openapi.json`, написанному по S10 §13.2. Гейт: `404` от ручки рабочего стола (код не `sandbox_not_found`, т. е. в API нет маршрута) и `422 desktop_unsupported` → ошибка инструмента `desktop_unsupported` с подсказкой; инструменты в списке остаются (список статичен, golden). Scope `desktop` в API пока нет, поэтому командный ключ не видит `desktop_url` и `computer_*` до S10 — это верно по §8.7.
3. **SDK:** в `RunOptions` добавлен колбэк `onStarted?: (s: {commandId: string; replayed: boolean}) => void` (кадр `started`), чтобы `exec_run` помечал `replayed: true` (§7.4). Остальное (`signal`, `retryBudgetMs`) уже есть в S7. Create, fork, `exec_start`, `snapshot_save` читают `Idempotency-Replayed` из ответа `sbx.raw` сами.
4. **HTTP-адаптер:** `@modelcontextprotocol/hono` не нужен — `createMcpHandler(factory).fetch(request, {authInfo})` уже web-standard; маршруты, проверка `Host`/`Origin` и лимит тела — свои в Hono. Меньше зависимостей.
5. **`401` от API посреди вызова (§6.3 п. 3):** обработчик помечает per-request `AuthFailure`; если ответ `createMcpHandler` — JSON (SSE не начат), маршрут заменяет его на HTTP `401` с `WWW-Authenticate: ... error="invalid_token"`; если поток SSE уже идёт — остаётся ошибка инструмента `unauthorized` (`retryable: true`).
6. **Conformance:** прогон против `createHttpApp` с внедрённым `authenticate` (фиксированный principal) и фейковым API; сценарии, требующие resources/prompts/sampling и т. п., — в `apps/mcp/test/conformance-baseline.yml` с причиной.
7. **stdio и scopes:** при старте соединения `GET /v1/me` с таймаутом 5 s; ошибка (нет входа, сеть) — список как у человека (все инструменты), вызовы всё равно проверяет `api`.
8. **Проверка `Host`:** допустимые — host и hostname без порта из `SBX_MCP_PUBLIC_URL` плюс `SBX_MCP_ALLOWED_HOSTS` (через запятую); несовпадение — `421`. `Origin` не из `SBX_MCP_ALLOWED_ORIGINS` — `403`. `/healthz`, `/readyz` без проверок.
9. **Порты:** `mcp` слушает `:8080` (`/mcp`, PRM, `/healthz`, `/readyz`) и `:9090` (`/metrics`, `/healthz`, `/readyz`). Compose публикует `127.0.0.1:8090:8080` и `127.0.0.1:9092:9090`. dev-cp: Serve `8443:/mcp` и `8443:/.well-known/oauth-protected-resource/mcp` → `127.0.0.1:8090`.
10. **`exec_output`:** чтение — `GET /commands/{cmd}` (статус, `streams`) + `GET /output` по потокам; ожидание — `Command.follow({from: offsets, encoding: "base64"})` до первого куска + 500 ms добора или `exit` (§17 оставляет выбор исполнителю).
11. **`files_read`:** `sbx.raw` `GET /files/content` с `Range: bytes=a-b` (`parseAs: "arrayBuffer"`); первые 8 KiB для `as: auto` — тем же запросом.
12. **Интеграционные тесты против настоящего `api`** в процессе (`@sbx/api/testing`, как `apps/cli/test/helpers/api.ts`) — один сквозной сценарий в задаче 13, сверх спеки: ловит расхождения фейка с API.
13. **E2E на `pve` (§14.4) и ручной чек-лист клиентов** — не в этом треде (CT 590 и `pve` запрещены); сценарий `sbx-bench s11` не пишется, чек-лист и конфиги записываются в `apps/mcp/README.md`, результаты — открытый вопрос для master.
14. Метка `created-via=mcp` — валидна (labels в API свободной формы, `apps/api/src/schemas/common.ts`).
15. **`fail_fast` и `warmAvailable` не вводятся:** S7 убрал их из публичного контракта (решение Ильи, тёплого пула нет; `failFast` в теле — `400`). Подсказка `pool_exhausted` не нужна.
16. **Progress:** при `progressToken` ожидания create/resume/fork/recover/stop, `snapshot_save` и `exec_run` шлют `notifications/progress` раз в ~5 s (счётчик секунд ожидания, `message` — состояние или байты вывода).
17. **`traceparent`** из `_meta` запроса передаётся в `api` заголовком `traceparent` (§13.3), если он есть; `User-Agent` SDK — `sbx-mcp/<version> (<client>/<version>; stdio|http)`, клиент — из `clientInfo`, если известен на момент создания SDK-клиента, иначе без него.

## Review Focus

1. **Многобайтовый символ на границе хвоста или куска** (`max_output_bytes` режет посреди UTF-8, хвост начинается с байта продолжения). Ожидание: offset-ы всегда на границе символа, цепочка `exec_output` собирает вывод байт в байт. Тест — задача 2 (unit) и задача 7 (sha256 вывода с кириллицей и эмодзи).
2. **`wait_seconds` истёк, пока `POST /commands` ещё ждёт готовности sandbox** (id команды неизвестен). Ожидание: `deadline_exceeded`, `retryable: true`, `idempotency_key` в ответе; повтор с ним подключается к той же команде. Тест — задача 7.
3. **Параллельные вызовы stdio при истёкшем токене.** Ожидание: один refresh через поставщик CLI, оба вызова успешны. Тест — задача 11.
4. **`--sandbox self` без `SBX_SANDBOX_ID`** или с чужой sandbox в аргументах. Ожидание: понятная ошибка запуска в stderr и код выхода 2; у инструментов нет аргумента `sandbox`, подставляется привязанная. Тест — задачи 5 и 11.
5. **`files_edit` по файлу с CRLF и `old_text` с LF; файл > 1 MiB; файл изменился между чтением и записью.** Ожидание: «not found» с числом совпадений 0, ошибка размера, `conflict`; файл не тронут. Тест — задача 8.

---

### Task 1: Каркас `apps/mcp` и спайк Bun (§12.2)

**Files:**
- Create: `apps/mcp/{package.json,tsconfig.json,vitest.config.ts}`, `apps/mcp/src/{index.ts,version.ts}`, `apps/mcp/test/bun-spike.test.ts`, `apps/mcp/test/fixtures/spike-server.ts`
- Modify: `pnpm-lock.yaml` (через `pnpm install`)

**Interfaces:**
- Produces: пакет `@sbx/mcp` (`exports: {".": "./src/index.ts"}`), `MCP_SERVER_NAME = "sbx"`, `MCP_VERSION` (= версия CLI `0.1.0`).

- [ ] **Step 1:** `package.json`: dependencies `@modelcontextprotocol/server@2.4.0`, `@sbx/sdk: workspace:*`, `hono@4.13.14`, `@hono/node-server@2.1.5`, `zod@4.6.7`, `pino@10.4.0`, `prom-client@15.1.3`; devDependencies `@modelcontextprotocol/client@2.4.0`, `@modelcontextprotocol/conformance@0.1.16`, `@modelcontextprotocol/inspector@2.13.0`, `ajv@8.20.0`, `ajv-formats@3.0.1`, `@sbx/api`, `@sbx/core`, `@sbx/db` (workspace, для интеграции). vitest config — как у `apps/cli` (условие `source`, `globalSetup` `@sbx/db/testing/global-setup`, `testTimeout` 120 000). `pnpm install`.
- [ ] **Step 2: failing test** `bun-spike.test.ts`: `bun build --compile` фикстуры `spike-server.ts` (импорт `serveStdio` из `@modelcontextprotocol/server/stdio`, один инструмент `ping`) в tmp; запуск бинарника; клиент `@modelcontextprotocol/client` по stdio: `tools/list` содержит `ping`, `tools/call ping` → текст `pong`. Второй кейс: то же для `--target=bun-linux-x64` только сборка (код 0).
- [ ] **Step 3:** фикстура и `src/index.ts`/`version.ts`; тест зелёный. Если `bun build --compile` не собирает SDK — записать причину в план и спеку §19, выбрать обходной путь (§12.2) до продолжения.
- [ ] **Step 4:** `pnpm --filter @sbx/mcp test && pnpm --filter @sbx/mcp typecheck && pnpm lint` — зелёные.
- [ ] **Step 5:** commit `mcp: package skeleton and Bun compile spike`.

### Task 2: Вывод для LLM: декодер, очистка, ограждение, усечение (§9, §11.3)

**Files:**
- Create: `apps/mcp/src/output/{utf8.ts,sanitize.ts,fence.ts,budget.ts,result.ts}`
- Test: `apps/mcp/test/output-{utf8,sanitize,fence,budget,result}.test.ts`

**Interfaces:**
- Produces:
  - `decodeUtf8Chunk(bytes: Uint8Array, opts: {atStart: boolean; final: boolean}): {text: string; startSkip: number; endHold: number}` — `atStart=false` пропускает ведущие байты продолжения (≤ 3), `final=false` удерживает неполную последовательность на конце (≤ 3); некорректные байты — U+FFFD.
  - `sanitizeForLlm(text: string): string` — §9.3 + §11.3 п. 3 (ANSI CSI/OSC/прочие ESC удаляются; `\r\n`→`\n`; одиночный `\r` — остаётся текст после последнего `\r` в строке; C0/C1 кроме `\t`,`\n` → `\u{XX}`; Unicode Tags U+E0000–E007F, bidi U+202A–202E, U+2066–2069, U+200E, U+200F, U+061C, U+200B, U+2060–2064, U+FEFF не в начале → `\u{XXXX}`; U+200C/U+200D остаются).
  - `fenceUntrusted(blocks: {label: string; text: string}[], rand?: () => string): string` — общий `nonce` (6 hex) на ответ, формат `<<<sbx-untrusted id=<nonce> <label>>>>\n…\n<<<end id=<nonce>>>`; если любой текст содержит `<<<end id=<nonce>` — новый nonce. Текст очищается `sanitizeForLlm` внутри.
  - `splitBudget(max: number, sizes: {stdout: number; stderr: number}): {stdout: number; stderr: number}` — по половине, неиспользованное коротким потоком отдаётся длинному.
  - `truncationNote(stream: string, r: {from: number; to: number; size: number; mode: "tail" | "forward"}): string | null` — «stdout: last N of M bytes. Earlier output: exec_output with stdout_offset=0.» / «bytes A–B of M …»; `null`, если усечения нет.
  - `MAX_RESULT_CHARS = 80_000`; `toolText(header: Record<string, unknown>, extra?: string[]): CallToolResult` (компактный JSON без пустых полей, `snake_case` ключи — как переданы) и `capResult(r: CallToolResult): CallToolResult` (текст сверх 80 000 символов режется с явной строкой «response cut at 80000 characters»).
- [ ] **Step 1: failing tests:** разрезы `"é"`, `"€"`, `"😀"` на каждом байте (`startSkip`/`endHold` и склейка двух вызовов = исходный текст); `0xFF` → U+FFFD; очистка: `\x1b[31mred\x1b[0m`→`red`, OSC 8 со ссылкой → только текст ссылки, OSC 52 удалён, `"a\rb\rc\n"`→`"c\n"`, `\x07`→`\u{07}`, `\u0085`→`\u{85}`, `"\u{E0041}"`→`"\u{E0041}"` видимой записью, `"a‮b"`→`"a\u{202E}b"`, `"👨‍👩‍👧"` без изменений, ведущий U+FEFF сохраняется, внутренний — заменяется; ограждение: данные `<<<end id=abc123>>>` при `rand` → `abc123`, затем `def456` — блок с `def456`, данные целы; поддельный конец с другим id не закрывает блок; `splitBudget(16384, {stdout: 100000, stderr: 912})` → `{stdout: 15472, stderr: 912}`; `capResult` режет 100 000 символов до ≤ 80 000 с пометкой.
- [ ] **Step 2:** запустить — FAIL. **Step 3:** реализовать. **Step 4:** PASS, `typecheck`, `lint`.
- [ ] **Step 5:** commit `mcp: utf8 decoder, sanitizer, untrusted fence, truncation`.

### Task 3: Ошибки, срок вызова, ключи идемпотентности (§7.4–§7.6)

**Files:**
- Create: `apps/mcp/src/{errors.ts,deadline.ts,idempotency.ts}`
- Test: `apps/mcp/test/{errors,deadline,idempotency}.test.ts`

**Interfaces:**
- Produces:
  - `class ToolError extends Error {code: string; retryable: boolean; hint?: string; details?: Record<string, unknown>; idempotencyKey?: string}`.
  - `errorResult(err: unknown, extra?: {idempotencyKey?: string}): CallToolResult` (`isError: true`, текст в формате §7.6: `error`, `message`, `retryable`, `retry_after` (s, если есть), `hint`, `idempotency_key`, `request_id`; неизвестная ошибка — `internal`, без стека).
  - `hintFor(code: string, ctx: {sandbox?: string; details: Record<string, unknown>}): string | undefined` — таблица §7.6 плюс `not_logged_in` («run `sbx login` in a terminal, then retry»), `desktop_unsupported`, `desktop_busy`, `idempotency_key_reused` («use a new idempotency_key»), `deadline_exceeded`, `rate_limited`, `token_provider_failed`.
  - `CALL_BUDGET_MS = 50_000`, `RESPONSE_MARGIN_MS = 1_500`; `class Deadline { constructor(parent: AbortSignal, budgetMs = CALL_BUDGET_MS); signal: AbortSignal; remainingMs(): number; waitMs(waitSeconds: number): number /* min(ws*1000, remaining − margin), ≥ 0 */; expired(): boolean; cancelled(): boolean /* parent aborted */ }`.
  - `apiIdempotencyKey(tool: string, modelKey: string, sandboxId?: string): string` — `mcp:<tool>:<sandbox id>:<key>` или `mcp:<tool>:<key>`; длиннее 255 — `sha256` hex строки. `IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._-]{1,128}$/`.
- [ ] **Step 1: failing tests:** каждая строка таблицы S7 §5.5 (`sandbox_not_ready`, `sandbox_starting`, `agent_unavailable`, `operation_in_progress`, `forbidden` с `details.requiredScope`, `confirmation_required`, `quota_exceeded`, `path_not_found`, `not_found`, `validation`, `rate_limited`, `idempotency_key_reused`) и S10 §13.2 (`desktop_unsupported`, `desktop_not_ready`, `desktop_busy`, `invalid_action`, `action_failed`, `streamer_unavailable`) → текст содержит `error: <code>` и ожидаемый `hint`; `forbidden` с `requiredScope: "files:write"` → hint упоминает `files:write`; `Deadline` с фейковыми таймерами: `waitMs(50)` при старте = 48 500; после 50 s `expired()`; отмена родителя → `cancelled()`; `apiIdempotencyKey("exec_run","k1","sb_1")` = `mcp:exec_run:sb_1:k1`, ключ 128 символов на длинном id — sha256.
- [ ] **Steps 2–4:** FAIL → реализовать → PASS, typecheck, lint.
- [ ] **Step 5:** commit `mcp: tool errors with hints, call deadline, idempotency keys`.

### Task 4: Фейковый API для контрактных тестов (§14.2)

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
  Команды фейка — сценарные: `command` вида `fake:emit <bytes>:<chunk>:<delayMs>` генерирует детерминированный вывод (в том числе многобайтовый), `fake:sleep <s>`, `fake:exit <code>`, `fake:inject` печатает `\x1b[31m`, теги Unicode и поддельный `<<<end id=...>>>`. Остальное — `echo`-подобно. Сандбоксы переходят `creating→ready` через `readyAfterMs` (по умолчанию 50). Скриншот — фиксированная PNG 1280×800 и JPEG; действия пишутся в `state.desktop.actions`.
- [ ] **Step 1: failing test** `fake-api.test.ts`: валидатор (ajv 2020 + formats над `apps/api/openapi/v1.json` и `desktop.openapi.json`) ловит намеренно неверный ответ (`contractErrors` не пуст); обычный сценарий SDK (`new Sbx({baseUrl, apiKey})`: create → wait → exec → files write/read → ports → stop → delete) проходит с пустым `contractErrors`; `GET /v1/me` для `team_key` отдаёт `auth.kind: "team_key"` и scopes; NDJSON `/stream` с `follow=true` отдаёт `heartbeat`, `truncated`, `exit`.
- [ ] **Steps 2–4:** FAIL → реализовать (Hono + `@hono/node-server` на случайном порту; проверка запроса и ответа по пути и методу из OpenAPI в middleware) → PASS.
- [ ] **Step 5:** commit `mcp: in-memory fake API checked against the OpenAPI document`.

### Task 5: Реестр, контекст, фабрика сервера, линтер схем (§5, §7.1–§7.3, §7.7–§7.8, §8.8)

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
  Обёртка вызова в `createServer`: `Deadline` от `ctx.mcpReq.signal`; `acquireSlot`; ошибки → `errorResult`; `SbxError` 401 → `onAuthFailure` и ошибка `unauthorized` `retryable: true`; `capResult`; журнал (инструмент, sandbox, `command_id`, длительность, код ошибки, `request_id`) без аргументов.
- [ ] **Step 1: failing tests** с тестовым набором из 4 фиктивных `ToolDef` (по одному на read-only, destructive, pinned-hidden, scope `files:write`): `selectTools` для toolsets × readOnly × principal (`team_key` без `files:write` не видит инструмент; `oidc` видит всё) × pinned (скрытые пропадают, у остальных нет `sandbox` в схеме, вызов подставляет pinned id); `tools/list` через in-memory клиента (`helpers/connect.ts`: `connectInMemory(server)` для эры 2026-07-28 и `legacy` 2025-11-25) — порядок как в массиве, аннотации все четыре, у результата `ttlMs`/`cacheScope` в модерн-эре; вызов скрытого инструмента — ошибка JSON-RPC «unknown tool»; ошибка аргументов — результат `isError: true`; `SERVER_INSTRUCTIONS.length ≤ 1500`; `lintToolSchema` находит `anyOf`, `type: ["integer","null"]`, свойство без `description`, числовой `enum`, корень не `object`.
- [ ] **Steps 2–4:** FAIL → реализовать → PASS, typecheck, lint.
- [ ] **Step 5:** commit `mcp: tool registry, filters, pinned mode, server factory`.

### Task 6: Инструменты `core`: каталог и sandbox (§8.1–§8.2)

**Files:**
- Create: `apps/mcp/src/tools/{catalog.ts,sandboxes.ts,index.ts,shapes.ts}`
- Test: `apps/mcp/test/tools-sandboxes.test.ts`

**Interfaces:**
- Consumes: Task 5 `ToolDef`, `ToolContext`; Task 4 фейк.
- Produces: `CATALOG_TOOLS` (`limits_get`, `templates_list`), `SANDBOX_TOOLS` (`sandbox_create`, `sandbox_list`, `sandbox_get`, `sandbox_update`, `sandbox_stop`, `sandbox_resume`, `sandbox_fork`, `sandbox_recover`, `sandbox_delete`); `ALL_TOOLS` в `tools/index.ts` (дополняется следующими задачами в порядке §8); `sandboxView(s: SandboxData): Record<string, unknown>` — форма ответа §8.2 (`snake_case`, без лишних полей); `waitSandbox(ctx, id: string, target: "ready" | "stopped", waitMs: number): Promise<SandboxData>` — long-poll `GET ?waitFor=&waitSeconds=` до цели, финального состояния или срока, без исключения по сроку; общие поля схем в `shapes.ts` (`waitShape`, `idempotencyKeyShape`, `envShape` с описанием «non-secret values only», `labelsShape`).
- [ ] **Step 1: failing tests** через in-memory клиента и фейк: `limits_get` для ключа — «team key key_…», scopes, квоты; `templates_list` — `capabilities` и размеры; `sandbox_create` добавляет `created-via=mcp`, ждёт `ready`, ответ без `createdBy`/`templateVersion`, есть `idempotency_key`; при `readyAfterMs` 60 000 и `wait_seconds: 2` — ответ с `state: creating`, `operation_id` и подсказкой `sandbox_get wait_for=ready` за ≤ 3 s; повтор с тем же `idempotency_key` — одна sandbox в фейке и `replayed: true`; `error` → `isError: true` с `sandbox.error`; `sandbox_resume` с `env` + `unset_env` → тело `{env: {A: "1", B: null}}` в журнале фейка; `sandbox_update ttl_seconds: 0` → `ttlSeconds: null`; `sandbox_delete` без `confirm` — ошибка схемы; с чужим `confirm` — `confirmation_required` и sandbox цела; с верным — удалена; схемы create/resume/fork не содержат `secrets`/`secret_files`.
- [ ] **Steps 2–4:** FAIL → реализовать → PASS, `contractErrors` пуст.
- [ ] **Step 5:** commit `mcp: catalog and sandbox lifecycle tools`.

### Task 7: Инструменты команд (§8.3, §9.1–§9.2, §10.2) + `onStarted` в SDK

**Files:**
- Create: `apps/mcp/src/tools/commands.ts`, `apps/mcp/src/output/tail.ts`
- Modify: `packages/sdk-ts/src/commands.ts` (`RunOptions.onStarted`, вызов на кадре `started`), `packages/sdk-ts/test/facade.test.ts` (тест `onStarted` с `replayed`)
- Test: `apps/mcp/test/tools-commands.test.ts`

**Interfaces:**
- Consumes: Task 2, 3, 5, 6.
- Produces: `COMMAND_TOOLS` (`exec_run`, `exec_start`, `exec_output`, `exec_list`, `exec_kill`); `class ByteTail { constructor(max: number); push(bytes: Uint8Array, nextOffset: number): void; truncate(availableFrom: number): void; bytes(): Uint8Array; from: number; to: number }`; `KILL_GRACE_MS = 5_000` (stdio-отмена), `exec_kill` SIGTERM — `graceMs: 10_000`.
- [ ] **Step 1: failing tests:**
  - SDK: `run(..., {onStarted})` получает `{commandId, replayed: true}` на повторе с тем же ключом.
  - `exec_run` короткой команды: `status: exited`, `exit_code`, хвосты в ограждении, без примечания об усечении.
  - `exec_run` `fake:emit 200000` с `max_output_bytes: 16384`: заголовок `stdout: {size, from, to}`, строка «last N of 200000 bytes»; при `wait_seconds: 1` и долгой команде — `status: running`, `command_id`, offset-ы, подсказка `exec_output`; цепочка `exec_output` (`wait_seconds: 5`) с возвращёнными offset-ами до `done: true` собирает вывод, sha256 совпадает с ожидаемым (вывод с кириллицей и эмодзи).
  - Обрыв NDJSON (`breakStreamAfterBytes`) посреди `exec_run` — байты те же.
  - `holdCommandsPostMs: 70_000` и `wait_seconds: 50` — ответ за < 50 s: `deadline_exceeded`, `retryable: true`, `idempotency_key`; повтор с ним — та же команда (`replayed: true`), в фейке одна команда.
  - Один ключ модели на двух sandbox — две команды; тот же ключ с другими аргументами — ошибка с hint «new idempotency_key».
  - `exec_output` без offset-ов — хвост; offset < `available_from` — строка «N bytes were dropped by retention»; остановленная sandbox — `sandbox_not_ready`.
  - Отмена: `ctx.cancelledByClient()` = true при abort → `POST /kill` с `graceMs: 5000` в журнале; abort без отмены клиентом (закрытие stdin, HTTP) → `kill` нет.
  - `exec_start` → `command_id`, `pid`; `exec_list` по умолчанию `status=running`; `exec_kill` SIGTERM → `/kill`, SIGINT → `/signal`.
  - Вывод `fake:inject` очищен, поддельный конец ограждения не закрывает блок.
- [ ] **Steps 2–4:** FAIL → реализовать (`exec_run`: `sb.run(cmd, {encoding: "base64", idempotencyKey: apiIdempotencyKey(...), timeoutSeconds, signal, onStart, onStarted})`, ожидание обрывается таймером `deadline.waitMs(wait_seconds)` выходом из цикла; до известного `command_id` — `deadline_exceeded`) → PASS.
- [ ] **Step 5:** commit `mcp: exec tools with offsets, deadlines and cancellation; sdk: onStarted`.

### Task 8: Инструменты файлов (§8.4)

**Files:**
- Create: `apps/mcp/src/tools/files.ts`, `apps/mcp/src/output/image.ts`
- Test: `apps/mcp/test/tools-files.test.ts`

**Interfaces:**
- Produces: `FILE_TOOLS` (`files_read`, `files_write`, `files_edit`, `files_list`, `files_stat`, `files_delete`); `sniffImage(head: Uint8Array): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null`; `IMAGE_MAX_BYTES = 3 * 1024 * 1024`, `WRITE_MAX_BYTES = 1024 * 1024`.
- [ ] **Step 1: failing tests:** `files_read` текста 100 000 байт с `max_bytes: 32768` — `next_offset`, конец сдвинут к границе символа, последний кусок — `eof: true`; PNG ≤ 3 MiB при `as: auto` — image content `image/png`; бинарный (NUL в первых 8 KiB) — без содержимого, подсказка `as: base64`; `as: image` для 4 MiB — ошибка; `files_write` `encoding: base64`, `mode: "0644"` → в журнале `mode=420`; больше 1 MiB — ошибка до API с советом `sbx cp`; `files_edit`: 0 совпадений — «not found», 2 без `replace_all` — «matches 2 times…», `replace_all` — число замен и ≤ 5 строк контекста; CRLF-файл и `old_text` с `\n` — «not found»; файл > 1 MiB — ошибка; файл изменён фейком между чтением и записью — `conflict`, содержимое не тронуто; бинарный — ошибка; `mode` сохраняется; `files_list` — строки `d|f|l`, размер, `modified_at`, путь, цель symlink, имя с `‮` очищено и в ограждении; `files_stat` отсутствующего — `exists: false` без `isError`; `files_delete recursive`.
- [ ] **Steps 2–4:** FAIL → реализовать → PASS.
- [ ] **Step 5:** commit `mcp: file tools with ranges, images and files_edit`.

### Task 9: Порты и снапшоты (§8.5–§8.6)

**Files:**
- Create: `apps/mcp/src/tools/{ports.ts,snapshots.ts}`
- Test: `apps/mcp/test/tools-ports-snapshots.test.ts`

**Interfaces:**
- Produces: `PORT_TOOLS` (`port_expose`, `port_list`, `port_unexpose`), `SNAPSHOT_TOOLS` (`snapshot_save`, `snapshot_list`, `snapshot_delete`).
- [ ] **Step 1: failing tests:** новый порт без `access` → `PUT` с `access: "sso"`, ответ без `url_with_token`; `access: token` → `url_with_token` с пометкой «secret: give it to the user, do not store it»; порт уже в `token`, вызов без `access` → `PUT` не отправлен (журнал), режим тот же, токен не показан; `rotate_token: true` → `rotate-token` и `url_with_token`; `port_list` сводит `hosted` и `listening` (процесс, адреса, опубликован, режим, URL), имена процессов очищены; `snapshot_save` с `wait` → состояние `ready`, повтор с ключом — `replayed: true`; имя вне `^[a-z0-9][a-z0-9-]{0,62}$` — ошибка схемы; `snapshot_delete` с неверным `confirm` — `confirmation_required`, снапшот цел; с верным — удалён.
- [ ] **Steps 2–4:** FAIL → реализовать → PASS.
- [ ] **Step 5:** commit `mcp: port and snapshot tools`.

### Task 10: Рабочий стол и computer-use (§8.7, S10 §12–§13)

**Files:**
- Create: `apps/mcp/src/desktop/{api.ts,coords.ts,keys.ts}`, `apps/mcp/src/tools/desktop.ts`
- Test: `apps/mcp/test/{desktop-coords,desktop-keys,tools-desktop}.test.ts`

**Interfaces:**
- Produces:
  - `desktopApi(ctx: ToolContext, sandbox: string)`: `status()`, `link()`, `screenshot(q)`: `{bytes, contentType, screen, image, cursor}`, `act(body)`, `clipboardGet()`, `clipboardSet(text)` — через `sbx.raw` с приведением типов; `404` без маршрута → `ToolError desktop_unsupported`.
  - `defaultCoordinateSpace(screen: {width: number; height: number}, max = {width: 1280, height: 800}): {width: number; height: number}` — как API масштабирует скриншот (вписать с сохранением пропорций, не увеличивать, округление как в S10 §12.1: `scale = min(maxW/w, maxH/h, 1)`, размеры `Math.round`).
  - `parseChord(s: string): string[]` (словарь S10 §12.2; неизвестное имя → `ToolError invalid_action` со списком допустимых); `KEY_NAMES`.
  - `TYPE_BUDGET_MS = 40_000`; `SCREEN_CACHE_MS = 10_000` (кэш `GET /desktop` по sandbox в процессе).
  - `DESKTOP_TOOLS` (`desktop_url`, `computer_screenshot`, `computer_click`, `computer_move`, `computer_drag`, `computer_scroll`, `computer_key`, `computer_type`, `computer_clipboard_read`, `computer_clipboard_write`), scopes `computer_*` — `["desktop", "sandboxes:read"]`, `desktop_url` — `["desktop"]`.
- [ ] **Step 1: failing tests:** векторы координат (1920×1080 → 1280×720; 1280×800 → 1280×800; 3840×2160 → 1280×720; 1024×768 → 1024×768; 2560×1600 → 1280×800); `parseChord("ctrl+shift+t")`, `"enter"`, неизвестное `"hyper"`; скриншот — image content `image/jpeg` по умолчанию, текст с `coordinate_space`, с `region_*` — без `coordinate_space` и со строкой «region view…»; `computer_click` без `coordinate_*` → в журнале `coordinateSpace` по экрану фейка, действие `wait` `settle_ms` и `screenshot` в теле, ответ — текст + image; `computer_key repeat: 3` — три действия `key`; `computer_type` 10 000 символов с `delay_ms: 5` — ошибка до API (журнал пуст), совет `computer_clipboard_write` + `ctrl+v`; текст `computer_type` не в логе; `noDesktopRoutes` → `desktop_unsupported`; `desktop_busy` → `retryable: true`; `desktop_url` — пометка «secret».
- [ ] **Steps 2–4:** FAIL → реализовать → PASS.
- [ ] **Step 5:** commit `mcp: desktop and computer-use tools (S10 API, faked)`.

### Task 11: stdio — `runStdio` и `sbx mcp` (§6.1, §10.2)

**Files:**
- Create: `apps/mcp/src/stdio.ts`
- Modify: `apps/cli/src/commands/mcp.ts` (замена заглушки), `apps/cli/package.json` (`@sbx/mcp: workspace:*`), `apps/mcp/src/index.ts`
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
  CLI: `sbx mcp [--toolsets] [--read-only] [--sandbox <id|slug|self>] [--log-level] [--log-file]`, env `SBX_MCP_TOOLSETS`, `SBX_MCP_READ_ONLY=1`; глобальные `--profile`, `--api-url`, `--team` — как у остальных команд; `sbx` для MCP — `new Sbx({..., tokenProvider})` от `ctx.bearer`, ошибки `not_logged_in`/`login_required` CLI → `SbxError {code: "not_logged_in"}`; `self` без `SBX_SANDBOX_ID` → ошибка в stderr, код 2.
- [ ] **Step 1: failing tests:**
  - `stdio.test.ts` (поток в памяти): `tools/list`; `notifications/cancelled` для `exec_run` → `kill` в журнале фейка; закрытие stdin посреди `exec_run` → `kill` нет; ничего, кроме JSON-RPC, в stdout (перехват).
  - `apps/cli/test/mcp.test.ts` (дочерний процесс `bun src/main.ts mcp` против фейка): без входа — `tools/list` работает, вызов → `not_logged_in` с текстом про `sbx login`; с `SBX_API_KEY` ключа `read-only` — только инструменты чтения; профиль с истёкшим JWT — два параллельных вызова, один refresh у тестового OIDC (`startTestOidcServer`), оба успешны; `--sandbox self` без `SBX_SANDBOX_ID` — код 2 и сообщение в stderr; `--sandbox sb_x` — у схем нет `sandbox`; stdout дочернего процесса разбирается целиком как JSON-RPC; `notifications/cancelled` по настоящему stdio → `kill`.
  - `inspector-smoke.test.ts`: `inspector --cli bun <cli>/src/main.ts mcp --method tools/list` и `--method tools/call --tool-name limits_get` против фейка — код 0, 38 инструментов.
- [ ] **Steps 2–4:** FAIL → реализовать → PASS; `pnpm --filter @sbx/cli test` и `pnpm --filter @sbx/cli build` (бинарник собирается).
- [ ] **Step 5:** commit `mcp: stdio server; cli: sbx mcp`.

### Task 12: Удалённый HTTP-сервер (§6.2–§6.6, §11.5, §13.3)

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
  `main.ts`: `loadSettings(env)` → `createHttpApp` на `:8080` (`SBX_MCP_PORT`), ops на `:9090`; SIGTERM — `close()` и выход ≤ 10 s.
- [ ] **Step 1: failing tests** (`createHttpApp` на случайном порту, фейк API, клиент `@modelcontextprotocol/client` Streamable HTTP в эрах 2026-07-28 и 2025-11-25):
  - без bearer — `401`, `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"`; PRM по RFC 9728 (`resource`, `authorization_servers`, `scopes_supported` без `offline_access`, `bearer_methods_supported: ["header"]`); невалидный токен — `401` с `error="invalid_token"`; `user_disabled` — `403`; JWT с `exp` через 30 s — `401` «token expires too soon»; кэш: второй запрос в 30 s без `/v1/me`, после 31 s — снова, отказ кэшируется 5 s; `Sbx-Team` и `?team=` попадают в `/v1/me` и вызовы.
  - `Origin: https://evil.example` — `403`; чужой `Host` — `421`; `GET /mcp`, `DELETE /mcp` — `405`; тело > 2 MiB — `413`.
  - `?toolsets=core&read_only=1` фильтрует; ключ с `read-only` видит только чтение; вызов скрытого — unknown tool; чужая команда: sandbox другой команды → `not_found` от API, ничего не изменено.
  - `expireTokenOnce` посреди `exec_run` без progress → HTTP `401` с `WWW-Authenticate`; с `progressToken` (SSE начат) → ошибка инструмента `unauthorized`, `retryable: true`.
  - 17-й одновременный вызов одного principal — `rate_limited`; HTTP-отмена/обрыв `exec_run` — `kill` нет.
  - `/healthz`, `/readyz` без auth; `/metrics` на ops — счётчики вызовов и `401`.
  - `conformance.test.ts`: `conformance server --url … --expected-failures test/conformance-baseline.yml` с внедрённым `authenticate` — код 0.
- [ ] **Steps 2–4:** FAIL → реализовать (`createMcpHandler(factory, {legacy: "stateless", maxRequestBodySize: MAX_BODY_BYTES})`; фабрика берёт principal из `authInfo.extra`) → PASS.
- [ ] **Step 5:** commit `mcp: remote Streamable HTTP server with bearer check via /v1/me`.

### Task 13: Golden-список, совместимость клиентов, безопасность, интеграция (§14.1–§14.2, §14.4)

**Files:**
- Create: `apps/mcp/golden/tools-list.json`, `apps/mcp/scripts/golden.ts`
- Test: `apps/mcp/test/{golden,client-compat,security,integration}.test.ts`, `apps/mcp/test/helpers/real-api.ts`

**Interfaces:**
- Consumes: всё выше.
- [ ] **Step 1: failing tests:**
  - `golden.test.ts`: `tools/list` (все toolsets, человек) равен `golden/tools-list.json` (имя, title, description, inputSchema, annotations); ровно 38 инструментов в порядке §8; JSON всего ответа ≤ 40 000 символов; имена из `git show origin/main:apps/mcp/golden/tools-list.json` (если файл там есть) все присутствуют. `UPDATE_GOLDEN=1` переписывает файл (`scripts/golden.ts`).
  - `client-compat.test.ts`: для каждого инструмента — `lintToolSchema` пуст; Claude Code: `mcp__sbx__<name>` ≤ 64 и `^[a-zA-Z0-9_-]+$`, корень `type: object`; Codex/OpenAI: имя ≤ 64, у массивов `items`, нет ключевых слов вне списка OpenAI function parameters; OpenCode: объединение правил Anthropic и OpenAI (схема передаётся как есть); Gemini CLI: после вырезания `$schema` и `additionalProperties` схема остаётся валидной JSON Schema с теми же `required`, ключевые слова — из подмножества OpenAPI 3.0 Gemini (`type`, `description`, `enum`, `properties`, `required`, `items`, `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`, `pattern`, `default`, `format`).
  - `security.test.ts`: (а) prompt injection — вывод команды, содержимое файла, имя файла, буфер обмена с `<<<end id=…>>>`, `\x1b]8;;`, тегами Unicode и «ignore previous instructions» → данные только внутри ограждения с неугадываемым nonce, невидимые символы видимы; (б) фильтр scopes — ключ `ci` и ключ без `ports:write`: инструменты скрыты и вызов — unknown tool; (в) cross-team — sandbox другой команды по id: `not_found`, журнал без изменений; (г) обход `confirm` — пустая строка, slug другой sandbox, id с пробелом, регистр — ничего не удалено; секреты: в логах (перехват pino) нет bearer, `content`, `command`, `text`, `url_with_token`.
  - `integration.test.ts` (настоящий `api` в процессе через `helpers/real-api.ts` по образцу `apps/cli/test/helpers/api.ts`): create (`markReady`) → `exec_run` → `files_write`/`files_read` → `port_expose` → `sandbox_stop` → `sandbox_delete` с `confirm` через in-memory клиента; ответы без ошибок.
- [ ] **Steps 2–4:** FAIL → сгенерировать golden, исправить найденное → PASS.
- [ ] **Step 5:** commit `mcp: golden tool list, client schema compatibility, security and integration tests`.

### Task 14: Поставка: образ, compose, dev-cp, конфиги клиентов, документы

**Files:**
- Create: `apps/mcp/Dockerfile`, `apps/mcp/README.md`
- Modify: `deploy/compose/compose.yaml` (сервис `mcp`), `deploy/compose/README.md`, `infra/dev-cp/{compose.dev-cp.yaml,names.sh,README.md}`, `docs/architecture.md` (§2, §10 по S11 §16.2), `docs/specs/s11-mcp.md` §19, `docs/plans/s11-mcp.md` (итоги)
- Test: `apps/mcp/test/compose.test.ts`

**Interfaces:**
- Produces: образ `sbx-mcp:dev`; сервис `mcp` (`SBX_MCP_API_URL=http://api:8080`, `SBX_MCP_PUBLIC_URL=${SBX_MCP_PUBLIC_URL:-http://localhost:8090/mcp}`, `SBX_OIDC_ISSUER=*oidc-issuer`, `SBX_MCP_ALLOWED_ORIGINS=`, порты `127.0.0.1:8090:8080`, `127.0.0.1:9092:9090`, healthcheck `/readyz` на 9090, `depends_on: api healthy`); dev-cp: `SBX_MCP_PUBLIC_URL=https://<TS name>:8443/mcp` в `compose.dev-cp.yaml`, Serve `8443:/mcp=http://127.0.0.1:8090/mcp` и `8443:/.well-known/oauth-protected-resource/mcp=http://127.0.0.1:8090/.well-known/oauth-protected-resource/mcp` в `names.sh`.
- [ ] **Step 1: failing test** `compose.test.ts`: `docker compose -f deploy/compose/compose.yaml config` содержит сервис `mcp` с нужными env и портами (пропуск без Docker); `names.sh` `SERVE` содержит оба пути `/mcp`.
- [ ] **Step 2:** Dockerfile по образцу `apps/api/Dockerfile` (прод-зависимости `@sbx/mcp...`, `node apps/mcp/src/main.ts`, `USER node`, `EXPOSE 8080 9090`); `docker build -f apps/mcp/Dockerfile .` проходит; контейнер отвечает `/healthz`.
- [ ] **Step 3:** README `apps/mcp`: запуск, переменные, Inspector (UI и `--cli`), конфиги Claude Code, Codex, OpenCode, Gemini CLI (§12.3) — ключи заново проверить по документации клиентов (perplexity) и записать дату; порт callback OpenCode — если фиксирован и не 33418, записать открытым вопросом (realm не менять без master).
- [ ] **Step 4:** архитектура §2/§10, спека §19 (итог спайка Bun, фактический бюджет `tools/list`, отклонения из этого плана), compose README; `pnpm -r test`, `pnpm -r typecheck`, `pnpm lint`, `pnpm build` — зелёные.
- [ ] **Step 5:** commit `mcp: image, compose service, dev-cp route, client configs`.
