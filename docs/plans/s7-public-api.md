# S7 Публичное API v1, SDK, CLI: план реализации

> Исторический план до R1. Действующие имена и контракты — `docs/specs/rename-umiak.md`.

> **Для исполнителей:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (по задаче на субагента, после каждой задачи — ревью свежим субагентом) и superpowers:test-driven-development. Шаги — чекбоксы `- [ ]`.

**Цель:** реализовать MVP S7 по `docs/specs/s7-public-api.md`: `apps/api` (три listener-а, все ресурсы `/v1`, внутренние ручки gateway), `packages/auth`, OpenAPI 3.1, `@sbx/sdk` (TS), `sbx-sdk` (Python), CLI `sbx` на Bun, сервисы `api`, Keycloak и oauth2-proxy в `deploy/compose`.

**Архитектура:** `apps/api` — Hono + `@hono/zod-openapi` на Node; маршруты вызывают `SandboxService` из `packages/core` (S6) и агента через интерфейс `AgentApi` (фейк до слияния S3, файловая часть — через `AgentClient.fetch`). Личности (пользователи, команды, ключи, SSH-ключи) — интерфейс `IdentityStore` из `packages/auth` с временной Postgres-реализацией до S8. OpenAPI генерируется из zod-схем и коммитится; из него строятся SDK TS (`openapi-typescript` + `openapi-fetch`) и Python (`openapi-python-client`), CLI работает на SDK TS.

**Стек:** Node 26.13.0 (type stripping, импорты `.ts`), TypeScript 7, vitest 5, biome 2.6.4, Bun 1.4.4 (CLI), Python 3.15.2 + uv 0.13.6 (SDK Python). Библиотеки (проверено `npm view` / PyPI 2026-10-30): `hono` 4.13.14, `@hono/zod-openapi` 1.6.3, `zod` 4.6.7, `@hono/node-server` 2.1.5, `ws` 8.22.0 / `@types/ws` 8.18.2, `@scalar/hono-api-reference` 0.12.16, `rate-limiter-flexible` 11.2.3, `pino` 10.4.0, `prom-client` 15.1.3, `jose` 6.2.14, `ulid` 3.0.2, `yaml` 2.9.1, `tar-stream` 3.2.2 (только тесты), `ajv` 8.20.0 + `ajv-formats` 3.0.1 (тесты), `openapi-typescript` 7.13.0, `openapi-fetch` 0.17.0, `commander` 15.0.0; Python: `openapi-python-client` 0.29.1, `httpx` 0.28.1, `attrs` 26.1.0, `websockets` 17.3, `pytest` 9.2.0, `pytest-asyncio` 1.4.1, `ruff` 0.17.3. Keycloak 26.8.1, oauth2-proxy v7.15.5, Postgres 18.6.

**Спецификация:** `docs/specs/s7-public-api.md` (источник истины; § ниже — из неё). Смежные: S6 (`packages/core`, §14), S2 §8.4, §9 (`@sbx/agent-client`), S3 §9–§13 и `proto/sbx/agent/v1` в ветке `s3-impl`, S4 §6.1, §8.4, §9.2 и `services/gateway/internal/cpapi` в `s4-impl`, S8 §5, §10.2, §17.1 (C1–C10), S11 §16.1, `docs/architecture.md` §10.

## Глобальные ограничения

- Инструменты только через mise (`mise exec -- <cmd>`). Перед добавлением зависимости — `npm view <pkg> version`; версии выше.
- Пакеты в стиле S6: `"exports": {".": "./src/index.ts"}`, tsconfig как у `apps/worker` (`allowImportingTsExtensions`, `erasableSyntaxOnly`, `noEmit`), скрипты `test` (`vitest run`), `typecheck`, при необходимости `build`. Без `enum`, `namespace`, parameter properties. Процесс запускается `node src/main.ts`.
- Новые пакеты: `packages/auth` (`@sbx/auth`), `apps/api` (`@sbx/api`), `packages/sdk-ts` (`@sbx/sdk`), `apps/cli` (`@sbx/cli`, бинарник `sbx`), `packages/sdk-py` (`sbx-sdk`). В корневых файлах — только свои строки.
- Миграции: S7 — `db/migrations/03NN_*.sql`; изменения таблиц S6 — в диапазоне S6 (`0204_*`), как разрешает §20.2. Обычный SQL без `BEGIN/COMMIT`.
- Публичные ID — §5.3, только через кодеки `@sbx/auth`. Внутри `api` всё на UUID/ULID; кодирование — на границе HTTP.
- Ошибки — всегда `{error:{code,message,retryable,details,requestId}}` + заголовок `Request-Id` (§5.5), на любом listener-е и статусе. Внутренние ручки gateway дополнительно кладут `code` на верхний уровень тела (S4 `cpapi` читает `{"code": "route_not_found"}`).
- Секреты (env, secrets, secretFiles, секрет API-ключа, токен порта, код SSO, bearer, закрытый ключ CA) не попадают в логи, метрики, ответы `GET`, URL. pino `redact`: `req.headers.authorization`, `*.env`, `*.secrets`, `*.secretFiles`, `*.secret`, `*.token`, `*.code`, `*.contentBase64`.
- **`failFast` и `pool_exhausted` не входят в публичный контракт** (решение Ильи: тёплого пула в MVP нет). Схема create их не содержит: `failFast` в теле — `400 validation` (неизвестное поле). `warmAvailable` в `/limits` нет. Код `pool_exhausted` в таблицу HTTP не попадает (если core его бросит — `500 internal`).
- `Operation.request` наружу не отдаётся никогда (там `bodyHash`). Операции `reprovision` наружу не отдаются: в `activeOperation` — `null`, `GET /operations/{id}` — `404`.
- `waitForState` в core без проверки доступа: `api` всегда сначала читает ресурс через `get` с principal-ом.
- Postgres в тестах — global setup `@sbx/db/testing/global-setup` (как S6). На `pve` ничего не запускать.
- Код S2 (`libs/tunnel`, `packages/agent-client`) не править. Код S6 правится только в объёме §20.2 и задачи 3.
- Комментарии в коде на английском. Коммиты без `Claude-Session:` и ссылок claude.ai.

## Решения исполнителя (отклонения и уточнения спеки)

1. **Тёплый пул и `failFast` скрыты** (решение Ильи). Спека правится в задаче 23: §5.5 (`pool_exhausted`), §8.2, §13 (`warmAvailable`), §14.2 (`--fail-fast`), §15.4, §16, §17.5 — помечены «фаза 2».
2. **`IdentityStore` до S8 — `PgIdentityStore`** в `packages/auth` (схема `identity`, миграция `0300`) с загрузкой YAML (`SBX_IDENTITY_FILE`: пользователи, команды, участники, ключи по sha256) при старте, JIT-пользователем с личной командой и `NOTIFY sbx_identity`. Статическая только-чтение реализация не нужна: compose должен уметь выпускать ключи. S8 заменит её на `PayloadIdentityStore`; контрактный набор тестов `IdentityStore` лежит в `packages/auth/test/contract.ts` и экспортируется (`@sbx/auth/testing`). Environments хранятся там же (`identity.environments`) за интерфейсом `EnvironmentStore` — до S8.
3. **Агент.** Go-фейка `agentv1fake` и `tunnelharness -agent fake-v1` (§16) нет: S3 в работе. RPC агента — через интерфейс `AgentApi` (задача 8) с TS-фейком, который запускает настоящие процессы. Реальная реализация `ConnectAgentApi` подключается, когда master скажет (после слияния S3); до этого в процессе `api` RPC-методы отвечают `503 agent_unavailable`, а `/files/*` уже идут через `AgentClient.fetch`. Chaos-тест стрима (§16) идёт на уровне `api` и SDK: обрывы attach у фейка, остановка процесса `api` и переподключение SDK ко второму экземпляру; chaos через туннель — после подключения S3.
4. **События агента** (`/internal/v1/agent-events`): тело — binary protobuf `AgentEventsRequest` (`@sbx/proto`); payload `Any` разбирается реестром типов. Типы S3 в `main` ещё нет: payload известного JSON-совместимого вида (`google.protobuf.Struct`/`Value`) разбирается, остальное сохраняется как `{"@type": typeUrl}`; полный разбор — вместе с S3.
5. **Курсоры** — обёртка `api` над курсором core: `base64url(JSON{c: <cursor core>}) + "." + HMAC-SHA256(SBX_API_CURSOR_KEY)` усечённый до 16 байт; подделка → `400 invalid_cursor`.
6. **Словарь slug** остаётся словарём core (~300 слов, 2,7·10⁷ сочетаний, затем четыре слова); замена на 1 500 слов — позже.
7. **Environment в ресурсе Sandbox** — всегда `null`, `excludeOwnerSecrets` — `false`: колонки для них — изменение S6 S1 из S8 §10.3. Сами environments (CRUD и применение при create: наборы environment, поверх — наборы запроса) работают.
8. **S8 C1–C10.** Сделано здесь: C1 (environments, см. п. 7), C2 (`PATCH /env`), C4 (`?team=` на proxied для `GET`/`HEAD`/WebSocket), C6 (`isOperator` только у сессии; `ssh/authorize` без исключения оператора), C7 (`routes.lookup` читает `publicPortsEnabled`/`ssoPortPolicy`/`ssoPolicyEpoch` из `ConfigReader` без кэша; `authEpoch` sso = `auth_epoch + ssoPolicyEpoch`), C8 (`user_disabled`), C9 (реестр открытых стримов и PTY, закрытие по `NOTIFY sbx_identity`), C10 (JWT Keycloak, `/meta.oidc`). Не сделано (S8): C3 (операторские ручки и блокировки — колонки `blocked`/`block_reason` есть, ручек нет), `PayloadIdentityStore`, `PayloadConfigReader`.
9. **Рабочий стол (S10 §13)** — не здесь: scope `desktop` и ручки добавит S10. Ответ `routes.lookup` содержит `kind: "port"`.
10. **SSH-сертификат** — свой кодировщик OpenSSH-сертификата (`ssh-ed25519-cert-v01@openssh.com` и др. типы ключа пользователя, подпись ed25519 CA через `node:crypto`), без `sshpk`. Проверка в тестах — `ssh-keygen -L` и собственный разбор.
11. **Python SDK в MVP** (§19 его оставляет): генерируемый клиент + фасады `Sbx`/`AsyncSbx` с тем же набором хелперов, кроме `pty` (WebSocket) и `uploadDir`/`downloadDir` — они в Python позже, запись в задаче 23.
12. **`sbx mcp`** — заглушка: печатает «implemented by S11» и выходит с кодом `1`; S11 заменяет обработчик.
13. **Keycloak в compose** — realm `sbx` импортом из `deploy/compose/keycloak/realm-sbx.json` (клиенты `oauth2-proxy`, `sbx-cli`, `sbx-api`, `sbx-mcp`, `sbx-worker`, scope `groups`, сроки architecture §10). Секреты клиентов `oauth2-proxy`/`sbx-worker`, cookie secret, service tokens, ключ курсора и SSH login CA генерирует одноразовый сервис `secrets-init` при первом старте в том `deploy/compose/secrets/`. Тесты аутентификации — на собственном OIDC-сервере с JWKS (`@sbx/api/testing`), Keycloak проверяется smoke-тестом под флагом `SBX_KEYCLOAK_TEST=1`. **Итог реализации:** тест под `SBX_KEYCLOAK_TEST=1` не написан; realm, вход через oauth2-proxy и device grant `sbx-cli` проверены ручным smoke-тестом compose (`deploy/compose/README.md`, «Первый вход»), см. спеку §23.12.

## Review Focus

1. **Повтор `POST /commands` с тем же `Idempotency-Key`, пока первый запрос ещё ждёт `Start` или стримит.** Ожидание: одна команда у агента, второй ответ — та же команда (`replayed: true` в кадре `started`), без `idempotency_key_reused`. Тест — задача 9.
2. **Чужая команда по ID из другой команды (IDOR) на каждой ручке**, включая `commandId` чужой sandbox внутри своей sandbox в пути, `uploadId`, `operationId`, имя снапшота, порт. Ожидание: `404 not_found`, ничего не меняется. Тест — задача 19 (матрица) и точечные в задачах 9, 11.
3. **UTF-8 на границе кусков и `encoding: base64`**: символ, разрезанный между кадрами агента, обрыв после первой половины и reattach с `nextOffset`. Ожидание: текст байт в байт, `nextOffset` на границе символа. Тест — задача 9 (unit декодера + интеграция с фейком, отдающим по 1 байту).
4. **Ключ, отозванный во время открытого стрима или PTY.** Ожидание: стрим получает кадр `error {code: unauthorized, retryable: false}`, PTY — close `4401`, не позже чем через секунду после `NOTIFY sbx_identity`. Тест — задачи 9 и 10.
5. **SIGTERM пода `api` посреди `sync`, `stream` и PTY.** Ожидание: стрим — кадр `reconnect {reason: server_shutdown}`, PTY — кадр `reconnect` и close `1012`, sync — `503 server_shutting_down` (`retryable` только с `Idempotency-Key`), процесс выходит ≤ 10 s. Тест — задача 18.

---

### Task 1: `packages/auth` — ID, ключи, scopes, bearer, интерфейс `IdentityStore`

**Files:**
- Create: `packages/auth/{package.json,tsconfig.json,vitest.config.ts}`, `src/index.ts`, `src/ids.ts`, `src/api-key.ts`, `src/scopes.ts`, `src/bearer.ts`, `src/identity.ts`
- Modify: `packages/core/src/principal.ts` (`SCOPES`, `Scope` реэкспортируются из `@sbx/auth`), `packages/core/package.json`
- Test: `packages/auth/test/{ids,api-key,scopes,bearer}.test.ts`

**Interfaces:**
- Produces:
  - `ID_PREFIXES = {sandbox:"sb", operation:"op", command:"cmd", snapshot:"snap", apiKey:"key", sshKey:"sshk", environment:"env", user:"usr", team:"team", upload:"upl", request:"req"} as const`; `type IdKind = keyof typeof ID_PREFIXES`.
  - `encodeUuid(kind: IdKind, uuid: string): string` (26 символов Crockford base32 в нижнем регистре от 128 бит; старшие 2 бита нулевые); `decodeUuid(kind, publicId: unknown): string | null` (UUID в нижнем регистре; любой регистр на входе; неверный префикс/длина/алфавит/переполнение → `null`).
  - `encodeUlid(kind, ulid: string): string` (`cmd_` + ulid в нижнем регистре); `decodeUlid(kind, publicId): string | null` (ULID в верхнем регистре); `newPublicUlid(kind): string`.
  - `SCOPES` (14 строк, порядок как в `packages/core/src/principal.ts`), `type Scope`, `isScope(s): s is Scope`, `PRESETS: Record<"read-only"|"ci"|"full", readonly Scope[]>` (§7.3), `SANDBOX_SELF_PRESET` (резерв, не выдаётся).
  - `API_KEY_RE = /^sbx_[0-9A-Za-z]{49}$/`; `generateApiKeySecret(): string` — `sbx_` + base62(32 случайных байта, дополнено `0` слева до 43) + base62(`zlib.crc32("sbx_" + body)`, до 6); `isWellFormedApiKey(s): boolean` (формат и CRC); `apiKeyHash(secret): string` (sha256 hex); `apiKeyDisplay(secret): {prefix: string /*8 символов после sbx_*/; last4: string}`.
  - `classifyBearer(token: string): "team_key" | "reserved" | "jwt" | "invalid"` (`sbx_` → team_key, `sbxs_` → reserved, три непустые base64url-части → jwt).
  - Типы `IdentityStore` (§17.3) + записи: `UserRecord {id, email, name: string|null, active, isOperator, idpSubject: string|null, defaultTeamId: string|null}`, `TeamMembership {teamId, name, role: "owner"|"member"}`, `SessionIdentity {user: UserRecord; teams: TeamMembership[]; defaultTeamId: string|null; isOperator: boolean}`, `SessionHeaders {email, user?, groups: string[], preferredUsername?, name?}`, `ApiKeyCreator {id, email, active, member}`, `ApiKeyRecord {id, kind:"team", sandboxId:null, teamId, name, secretHash, prefix, last4, scopes: Scope[], createdBy: ApiKeyCreator|null, createdVia: "api"|"cli"|"dashboard", createdAt: Date, expiresAt: Date, lastUsedAt: Date|null, revokedAt: Date|null}`, `NewApiKey {teamId, name, scopes, expiresAt, createdByUserId, createdVia, secretHash, prefix, last4}`, `SshKeyRecord {id, userId, name, publicKey, fingerprint, type, createdAt, lastUsedAt}`, `NewSshKey {userId, name, publicKey, fingerprint, type}`. Методы — §17.3 плюс `team(teamId): Promise<{id,name}|null>`, `rotateApiKey(id, s: {secretHash, prefix, last4}): Promise<ApiKeyRecord>`, `touchSshKey(id): Promise<void>`. Ошибки: `class IdentityError extends Error {code: "user_disabled"|"fingerprint_taken"|"not_found"|"name_taken"}`.

- [ ] **Step 1: тесты.** `ids.test.ts`: известный вектор (`encodeUuid("sandbox","00000000-0000-0000-0000-000000000000") === "sb_" + "0".repeat(26)`, `ffffffff-…` → `"sb_7zzzzzzzzzzzzzzzzzzzzzzzzz"`), круговая проверка 1000 случайных UUIDv7 и сортировка по времени (`encodeUuid` двух uuidv7 с разницей в 1 ms сравниваются как строки), верхний регистр принимается, `sb_` с 27 символами/`8zzz…`(переполнение)/`i`,`l`,`o`,`u` → `null`, чужой префикс (`op_` для sandbox) → `null`. `api-key.test.ts`: `API_KEY_RE` матчит 1000 сгенерированных, длина 53, `isWellFormedApiKey` ловит изменённый последний символ тела, `apiKeyDisplay` даёт 8 и 4 символа. `scopes.test.ts`: пресеты из §7.3 буквально, `full` = `SCOPES`, `SCOPES` из `@sbx/core` идентичен. `bearer.test.ts`: четыре класса.
- [ ] **Step 2: прогнать — FAIL** (`mise exec -- pnpm --filter @sbx/auth test`).
- [ ] **Step 3: реализовать модули;** `core/src/principal.ts` реэкспортирует `SCOPES`, `Scope` из `@sbx/auth` (прочее не меняется).
- [ ] **Step 4: прогнать auth и core — PASS;** `pnpm --filter @sbx/core typecheck`.
- [ ] **Step 5: commit** `auth: public ids, team key format, scopes, IdentityStore types`.

### Task 2: `packages/auth` — SSH-ключи и сертификаты

**Files:**
- Create: `packages/auth/src/ssh.ts`
- Test: `packages/auth/test/ssh.test.ts`

**Interfaces:**
- Produces:
  - `parseSshPublicKey(line: string): {type: SshKeyType; blob: Buffer; comment: string|null; fingerprint: string}` — типы `ssh-ed25519`, `ecdsa-sha2-nistp256|384|521`, `ssh-rsa` (модуль ≥ 3072 бит); сертификаты (`*-cert-v01@openssh.com`), DSA, `sk-*`, короткий RSA → `SshKeyError {reason}`. `fingerprint` = `"SHA256:" + base64(sha256(blob))` без `=`.
  - `loadSshCa(pemOrOpenSsh: string): SshCa` — закрытый ed25519 (PKCS#8 PEM или OpenSSH `-----BEGIN OPENSSH PRIVATE KEY-----` без пароля); `SshCa.publicKey: string` (строка `ssh-ed25519 AAAA…`).
  - `signUserCertificate(ca: SshCa, input: {publicKey: string; keyId: string; principals: string[]; validAfter: Date; validBefore: Date; serial?: bigint}): {certificate: string /* "<type>-cert-v01@openssh.com AAAA… keyId" */; serial: bigint}` — формат PROTOCOL.certkeys, `CertType` 1 (user), расширения `permit-X11-forwarding`, `permit-agent-forwarding`, `permit-port-forwarding`, `permit-pty`, `permit-user-rc` в лексикографическом порядке, critical options пусто, serial — 8 случайных байт.
  - `parseUserCertificate(line): {keyId, principals, serial, validAfter, validBefore, signatureKey: string}` (для тестов и `ssh-cert --ensure`).
  - `loadSshHostKeys(text): string[]` — строки публичных ключей из `SBX_SSH_HOST_KEYS_FILE` (закрытые → ошибка).

- [ ] **Step 1: тесты.** Генерировать ключи `ssh-keygen -t ed25519|ecdsa -b 384|rsa -b 3072|rsa -b 2048` во временном каталоге (пропуск, если `ssh-keygen` нет): fingerprint совпадает с `ssh-keygen -lf`; RSA 2048 отклонён; строка сертификата отклонена. Подписанный сертификат: `ssh-keygen -L -f cert.pub` выходит с 0 и печатает `Key ID: "sbx:user:usr_…"`, `Principals: sb_…`, `Valid: from … to …`; `ssh-keygen -Y`-подобная проверка не нужна — собственный `parseUserCertificate` проверяет подпись CA через `crypto.verify`. Подмена байта в теле → проверка подписи падает.
- [ ] **Step 2–4: FAIL → реализация → PASS.**
- [ ] **Step 5: commit** `auth: ssh public keys and login certificates`.

### Task 3: дополнения `packages/core`, `packages/config`, миграция `0204` (§20.2)

**Files:**
- Create: `db/migrations/0204_s7_core_additions.sql`, `packages/core/src/service/env.ts`, `packages/core/src/service/rename.ts`, `packages/core/src/usage.ts`
- Modify: `packages/core/src/service/{commands,ports,snapshots,read,index}.ts`, `packages/core/src/{rows,routes}.ts`, `packages/config/src/{types,static}.ts`, `apps/worker/src/controllers/cleanup*.ts` (удаление `runtime.port_auth_codes` старше суток, если таблица есть)
- Test: `packages/core/test/s7-additions.test.ts`, `packages/config/test/static.test.ts`

**Interfaces:**
- Миграция 0204: `commands` + `user text NOT NULL DEFAULT 'user'`, `tags jsonb NOT NULL DEFAULT '{}'`, `argv jsonb`, `pid int`; `hosted_ports` + `host_rewrite text NOT NULL DEFAULT 'preserve' CHECK (… IN ('preserve','localhost'))`, `app_protocol text NOT NULL DEFAULT 'http1' CHECK (… IN ('http1','h2c'))`, `blocked boolean NOT NULL DEFAULT false`, `block_reason text`; `sandboxes` + `blocked boolean NOT NULL DEFAULT false`, `block_reason text`. Индекс `commands (sandbox_id, status)`.
- `@sbx/config`: `TemplateConfig` + `name: string` (по умолчанию slug), `loginUser: string` (`"user"`), `capabilities: string[]` (`["exec","files","ssh"]`); `PlatformDefaults` + `publicPortsEnabled: boolean` (`true`), `ssoPortPolicy: "any"|"team"` (`"any"`), `ssoPolicyEpoch: number` (`0`).
- `@sbx/core` (методы `SandboxService` и экспорт):
  - `CommandSpec` + `user?: string` (по умолчанию `"user"`), `argv?: string[]|null`, `tags?: Record<string,string>`; `Command` + `user`, `argv: string[]|null`, `tags`, `pid: number|null`.
  - `createCommandWithKey(p, idOrSlug, spec: CommandSpec, idemKey: string, requestBody: unknown): Promise<{command: Command; replayed: boolean}>` — scope `commands.create`, hash `requestHash(keys, "commands.create", {sandbox: <uuid>, body: requestBody})`, строка `idempotency_keys` с `response = {"commandId": …}`; повтор на другой sandbox или с другим телом → `idempotency_key_reused`. Повтор, когда sandbox уже не `ready`, всё равно возвращает команду.
  - `markCommandRunning(commandId: string, pid: number|null): Promise<void>` (`starting` → `running`, `started_at`).
  - `listCommands(p, idOrSlug, filter: {status?: CommandStatus[]; mode?: CommandMode; limit?: number}, cursor?: string): Promise<Page<Command>>` (новые первыми; работает в любом состоянии кроме `deleted`); `getCommand(p, idOrSlug, commandId): Promise<Command>` (чужая sandbox или команда другой sandbox → `not_found`).
  - `hostPort(p, idOrSlug, port, mode: PortMode | HostPortOptions)` где `HostPortOptions = {access: PortMode; hostRewrite?: "preserve"|"localhost"; appProtocol?: "http1"|"h2c"}`; результат + `created: boolean`; те же настройки → без изменений; смена только `hostRewrite`/`appProtocol` → `UPDATE` без `auth_epoch+1`. `HostedPort` + `hostRewrite`, `appProtocol`, `blocked`, `blockReason`. `listHostedPorts(p, idOrSlug): Promise<HostedPort[]>`.
  - `rename(p, idOrSlug, slug): Promise<Sandbox>` — `validateSlug`, `deleting`/`deleted` → `invalid_state`, занятый → `slug_taken`, `hosted_ports.label` всех живых портов и `auth_epoch + 1` в той же транзакции.
  - `teamUsage(q: Queryable, teamId): Promise<{activeSandboxes: number; ramMb: number; savedSnapshots: number}>` — правила `checkQuota`.
  - `getSavedSnapshot(p, name): Promise<SavedSnapshot>` (`ready` с `name`, иначе `creating` с `pending_name`, иначе `snapshot_not_found`); `listSavedSnapshots` отдаёт ещё `failed` с `created_at > now() - 1 day`.
  - `getEnv(p, idOrSlug): Promise<SecretSets>`; `replaceEnv(p, idOrSlug, input: {env?; secrets?; secretFiles?: SecretFile[]}): Promise<{sandbox: Sandbox; sets: SecretSets}>` (переданное поле заменяет набор целиком); `patchEnv(p, idOrSlug, patch: SecretPatch): Promise<{sandbox; sets}>`; оба — `validateSecretSets` на результате, не в `deleting`/`deleted`.
  - `waitForOperation(id: string, timeoutMs: number): Promise<Operation>` — до терминального состояния (`succeeded|failed|superseded`) по `NOTIFY sbx_operations '<id>'` и запасному опросу, как `waitForSandboxState`; без проверки доступа.
  - `RouteTarget` + `teamId`, `hostRewrite`, `appProtocol`, `blocked` (`hosted_ports.blocked OR sandboxes.blocked`), `blockReason`; `SshTarget` + `teamId`, `slug`, `templateSlug`.

- [ ] **Step 1: тесты** в `s7-additions.test.ts` по одному `it` на метод: повтор `createCommandWithKey` даёт ту же строку и `replayed: true`, другое тело → `idempotency_key_reused`, параллельные 5 вызовов с одним ключом → одна строка `commands`; `rename` меняет label порта `old-3000` → `new-3000` и `auth_epoch` +1, `NOTIFY sbx_routes` приходит со старым и новым slug; `hostPort` с `{access:"token", hostRewrite:"localhost"}` и повтор теми же → `created:false`, без токена; `getSavedSnapshot` для `creating`; `listSavedSnapshots` показывает `failed` вчерашний-час-назад и не показывает двухдневный; `patchEnv` с `{secrets:{A:null}}` удаляет ключ; `waitForOperation` возвращается по UPDATE в `succeeded` раньше таймаута; `teamUsage`. `static.test.ts`: значения по умолчанию новых полей.
- [ ] **Step 2: FAIL.** **Step 3: реализация.** **Step 4:** `pnpm --filter @sbx/core --filter @sbx/config --filter @sbx/worker test` — PASS (старые тесты S6 не ломаются).
- [ ] **Step 5: commit** `core: S7 additions (command idempotency, ports options, rename, env, usage, snapshots, waitForOperation)`.

### Task 4: `PgIdentityStore`, миграции `0300`/`0301`, контрактный набор

**Files:**
- Create: `db/migrations/0300_identity_standin.sql`, `db/migrations/0301_port_auth_codes.sql`, `packages/auth/src/pg-store.ts`, `packages/auth/src/seed.ts`, `packages/auth/src/environments.ts`, `packages/auth/test/contract.ts`, `packages/auth/src/testing.ts` (экспорт `"./testing"`)
- Test: `packages/auth/test/pg-store.test.ts`, `packages/auth/test/environments.test.ts`

**Interfaces:**
- 0300: схема `identity`: `users(id uuid pk, email citext-подобный text unique (lower), name, active bool, is_operator bool, idp_subject text unique null, default_team_id uuid, created_at)`, `teams(id uuid pk, name, created_at)`, `memberships(user_id, team_id, role check owner|member, pk(user_id,team_id))`, `api_keys(id uuid pk, kind text default 'team', sandbox_id uuid null, team_id, name, secret_hash text unique, prefix, last4, scopes text[], created_by uuid null, created_via, created_at, expires_at not null, last_used_at, revoked_at, revoked_by uuid, revoked_by_key uuid)`, `ssh_keys(id, user_id, name, public_key, fingerprint unique, type, created_at, last_used_at)`, `environments(id uuid pk, team_id, name, is_default bool, revision int, key_version, nonce, ciphertext, repositories jsonb, exclude_owner_secrets bool, created_at, updated_at, updated_by uuid, unique(team_id,name))` + частичный уникальный индекс одной default на команду. Триггеры `NOTIFY sbx_identity '<table>:<id>'` на `users`, `memberships`, `api_keys`, `ssh_keys`.
- 0301: `runtime.port_auth_codes` ровно по §12.2 + индекс по `created_at`.
- `class PgIdentityStore implements IdentityStore` — `constructor(opts: {pool: pg.Pool; operatorGroups: string[]})`. `resolveSession`: поиск по `idp_subject = user`, иначе по email (тогда привязать `idp_subject`); нет — создать пользователя (`name` из `name ?? preferredUsername`) и личную команду `"<email>'s team"` с ролью `owner`; `is_operator` = пересечение `groups` и `operatorGroups` (обновляется при каждом вызове); `active = false` → `IdentityError("user_disabled")`.
- `seedIdentity(pool, yamlText)` — идемпотентный upsert из YAML: `users[{id, email, name?, active?, teams: {<teamId>: owner|member}}]`, `teams[{id, name}]`, `apiKeys[{id, teamId, name, sha256, scopes|preset, expiresAt}]`. Схема YAML — zod strict.
- `interface EnvironmentStore` + `PgEnvironmentStore(pool, keys: KeyRing)`: `list(teamId)`, `get(teamId, idOrName)`, `getDefault(teamId)`, `create(teamId, input, byUserId|null)`, `patch(teamId, idOrName, patch, by)`, `delete(teamId, idOrName)`; запись — `{id, teamId, name, isDefault, revision, sets: SecretSets, repositories, excludeOwnerSecrets, createdAt, updatedAt, updatedBy}`; шифрование `keys.encryptFor("environment", id, sets)`; `name_taken` при дубле.
- `runIdentityStoreContract(name: string, make: () => Promise<IdentityStore & {seedUser…}>)` — экспортируемый набор `describe` для S8.

- [ ] **Step 1: тесты.** Контракт: JIT по `sub` создаёт пользователя и личную команду, второй вызов с тем же `sub` и новым email — тот же пользователь; деактивированный → `user_disabled`; `findApiKeyByHash` находит, отозванный возвращается с `revokedAt` (решение о 401 — в api); `addSshKey` с занятым fingerprint → `fingerprint_taken`; `membership` чужой команды → `null`; `listApiKeys` отдаёт `createdBy.member=false` после удаления участника. Триггер: `LISTEN sbx_identity` получает `api_keys:<id>` при revoke. Seed дважды — одни и те же строки. Environments: create/patch (merge, `null` удаляет)/default единственная/шифротекст не содержит значения.
- [ ] **Step 2–4: FAIL → реализация → PASS.**
- [ ] **Step 5: commit** `auth: Postgres identity store stand-in, seed, environments, contract suite`.

### Task 5: `apps/api` — каркас: конфиг, ошибки, Request-Id, listener-ы, meta, OpenAPI

**Files:**
- Create: `apps/api/{package.json,tsconfig.json,vitest.config.ts}`, `src/settings.ts`, `src/deps.ts`, `src/app.ts`, `src/http/{errors,request-id,body-limit,logger,metrics}.ts`, `src/routes/meta.ts`, `src/openapi/{registry,document}.ts`, `src/testing/index.ts` (экспорт `"./testing"`), `scripts/openapi.ts`, `openapi/v1.json`
- Test: `apps/api/test/{errors,meta,openapi-drift}.test.ts`, `apps/api/test/helpers/{harness,conformance}.ts`

**Interfaces:**
- `loadSettings(env: NodeJS.ProcessEnv): Settings` (zod): `SBX_API_PUBLIC_PORT=8080`, `SBX_API_PROXIED_PORT=8081`, `SBX_API_INTERNAL_PORT=8082`, `SBX_API_METRICS_PORT=9090`, `DATABASE_URL`, `SBX_CONFIG_FILE`, `SBX_DATA_KEYS_FILE`, `SBX_API_CURSOR_KEY` (≥ 32 байт base64), `SBX_API_SERVICE_TOKENS_FILE`, `SBX_IDENTITY_FILE?`, `SBX_OPERATOR_GROUPS` (csv), `SBX_OIDC_ISSUER?`, `SBX_OIDC_DISCOVERY_URL?`, `SBX_OIDC_JWKS_URL?` (переопределяет `jwks_uri` из discovery: в compose `api` ходит к Keycloak по `http://keycloak:8080`, а `iss` — публичный `http://localhost:8180/realms/sbx`), `SBX_OIDC_AUDIENCE=sbx-api`, `SBX_OIDC_ALLOWED_CLIENTS=sbx-cli,sbx-mcp`, `SBX_APP_ORIGIN`, `SBX_API_URL`, `SBX_APP_URL`, `SBX_SBX_DOMAIN`, `SBX_SSH_HOST=ssh.<domain>`, `SBX_SSH_PORT=22`, `SBX_SSH_HOST_KEYS_FILE?`, `SBX_SSH_LOGIN_CA_KEY_FILE?`, `SBX_API_TRUSTED_PROXY_CIDRS`, `SBX_API_RATE_RPS=20`, `SBX_API_RATE_BURST=100`, `SBX_API_RATE_STARTS_PER_MIN=30`, `SBX_API_MAX_STREAMS=100`, `SBX_MIN_CLI_VERSION`, `SBX_LATEST_CLI_VERSION`, `SBX_BUILD`, `SBX_API_PROXIED_ENABLED` (по умолчанию `true`).
- `interface ApiDeps {settings; svc: SandboxService & S7 additions; pool; config: ConfigReader; identity: IdentityStore; environments: EnvironmentStore; agent: AgentApi; keys: KeyRing; notifier: Notifier; log: pino.Logger; metrics: ApiMetrics; clock: () => number; sshCa: SshCa | null; hostKeys: string[]; oidc: OidcVerifier | null; streams: StreamRegistry; shutdown: ShutdownState}` — поля появляются по задачам; тесты собирают их через `makeTestDeps(over)` в `src/testing`.
- `createPublicApp(deps)`, `createProxiedApp(deps)`, `createInternalApp(deps)` → `OpenAPIHono`; общий `mountV1(app, deps)` вешает ресурсы. `GET /v1/openapi.json`, `GET /v1/docs` (Scalar), `GET /v1/meta` без auth на public и proxied. `/healthz`, `/readyz` (Postgres + LISTEN), `/metrics` — на `:9090` (`createOpsApp`).
- `class ApiError extends Error {status; code; retryable; details; headers?}` + фабрики; `toHttpError(e: unknown): ApiError` — таблица §5.5 для кодов core (`not_found` 404, `invalid_state` 409, `operation_in_progress` 409 r, `out_of_capacity` 503 r, `quota_exceeded` 403, `idempotency_key_reused` 409, `template_unavailable` 422, `snapshot_not_found` 404, `sandbox_not_ready` 409, `recover_rate_limited` 429 r, `validation` 400, `slug_taken` 409, `snapshot_name_taken` 409, `agent_unavailable` 503 r, `machine_state_conflict` 409 `invalid_state`, всё прочее — 500 `internal` с логом); `Retry-After` и `details.retryAfterSeconds` для 429/503. Ошибки zod (`defaultHook`) → `400 validation` с `details.issues[{path,message}]`; невалидный JSON → `400 invalid_json`; неизвестный маршрут → `404 not_found`; метод → `405`.
- Request-Id: свой `req_<ulid>` на каждый запрос; входной `Request-Id` (≤128 `[A-Za-z0-9._-]`) — в лог как `clientRequestId`.
- OpenAPI: `operationId` `<resource>.<action>`, security schemes `keycloak` (openIdConnect) и `teamKey` (bearer, `bearerFormat: "sbx_"`), глобально `[{keycloak:[]},{teamKey:[]}]`; enum-ы ответов с `x-extensible-enum`. `pnpm --filter @sbx/api openapi` пишет `openapi/v1.json` (сортированный, `\n` в конце).
- `test/helpers/conformance.ts`: `assertConforms(doc, method, path, status, contentType, body)` (ajv 2020 + formats), и `harness.request(...)` вызывает его для каждого JSON-ответа.

- [ ] **Step 1: тесты.** `errors.test.ts`: каждый код core из таблицы → статус/`retryable`; `pool_exhausted` → 500 `internal`; любой ответ (404 маршрута, 400 JSON, 500) имеет `error.code/message/retryable/details/requestId` и заголовок `Request-Id`; `Retry-After` на 503 `out_of_capacity`. `meta.test.ts`: `/v1/meta` без auth, поля §13 (`oidc.clientId === "sbx-cli"`). `openapi-drift.test.ts`: сгенерированный документ равен `openapi/v1.json`; у каждой операции есть `operationId`, `summary`, `description`; в документе нет строк `failFast`, `pool_exhausted`, `warmAvailable`.
- [ ] **Step 2–4.** **Step 5: commit** `api: skeleton, error envelope, listeners, meta, openapi generation`.

### Task 6: аутентификация и права

**Files:**
- Create: `apps/api/src/auth/{principal,public,proxied,internal,oidc,key-cache,scopes,rate-limit,identity-listener}.ts`, `apps/api/src/routes/me.ts`, `apps/api/src/testing/oidc-server.ts`
- Test: `apps/api/test/auth-{public,jwt,proxied,internal,scopes,ratelimit}.test.ts`

**Interfaces:**
- `type AuthContext = {principal: Principal; user: UserRecord | null; apiKey: ApiKeyRecord | null; teams: TeamMembership[]; tokenExpiresAt: Date | null}` в `c.var.auth`.
- Public: вырезать `X-Auth-Request-*`, `X-Forwarded-User`, `X-Forwarded-Email` до всего; `classifyBearer`; ключ: `isWellFormedApiKey` → `apiKeyHash` → `KeyCache` (положительный 30 s, отрицательный 5 s, сброс по `NOTIFY sbx_identity 'api_keys:<id>'` и `'*'`) → `revokedAt` → 401 `unauthorized`, `expiresAt` → 401 `api_key_expired`; `touchApiKey` не чаще раза в 60 s. Principal ключа: `kind:"team_key"`, `userId:null`, `role:null`, `isOperator:false`, `scopes` ключа. `Sbx-Team` у ключа: не его команда → 403 `team_forbidden`.
- `OidcVerifier` (`jose`): discovery → `jwks_uri`, `createRemoteJWKSet` (`cooldownDuration` 30 s, `cacheMaxAge` 10 min), `jwtVerify` с `issuer`, `audience`, `algorithms: ["RS256","ES256"]`, `clockTolerance: 60`; затем `typ === "Bearer"`, `azp ∈ allowedClients`, `email_verified === true`. `JWTExpired` → 401 `token_expired`; прочее → 401 `unauthorized`, `details.reason:"invalid_token"`; всегда `WWW-Authenticate: Bearer realm="sbx", error="invalid_token"`. Затем `identity.resolveSession({email, user: sub, groups, preferredUsername})`; `user_disabled` → 403 `forbidden` `details.reason:"user_disabled"`. Principal `kind:"oidc"`, `isOperator:false`, все scopes, `role` из команды.
- Proxied: `Authorization` → 400 `validation`; без `X-Auth-Request-Email` → 401; `Origin === SBX_APP_ORIGIN` для небезопасных методов и upgrade, иначе 403 `origin_forbidden`; JSON-тело только с `Content-Type: application/json` (иначе 415 → `400 validation`); команда — `Sbx-Team` или `?team=` (только `GET`/`HEAD`/upgrade; расхождение → 400), иначе `defaultTeamId`; не из списка и не оператор → 403 `team_forbidden`. Principal `kind:"session"`, `isOperator` из `SessionIdentity`.
- Internal: `Authorization: Bearer` из `SBX_API_SERVICE_TOKENS_FILE` (`{"gateway": [t1, t2]}`), сравнение `timingSafeEqual` по sha256; иначе 401.
- `requireScope(scope: Scope)` → 403 `forbidden` `details.requiredScope`; `requireHuman()` → 403 `details.reason:"user_required"`; `requireOwner()` → 403 `details.reason:"role"`.
- Rate limit (`rate-limiter-flexible` memory): principal-ключ `apiKeyId ?? userId`, 20/s burst 100 → 429 `rate_limited` с `Retry-After`; `RateLimit-Policy: "req";q=100;w=5`, `RateLimit: "req";r=<left>;t=<s>`; старты (`create`/`fork`/`resume`) 30/min на команду.
- `GET /v1/me` (§13).
- `startTestOidcServer(): Promise<{issuer; token(claims?, opts?: {alg?, kid?, expiresIn?, typ?}): Promise<string>; rotateKey(): void; deviceFlow: {approve(userCode, claims), deny(userCode)}; close()}>` — discovery, JWKS, `/protocol/openid-connect/{token,auth/device,revoke}` как у Keycloak (для задач 20–21).

- [ ] **Step 1: тесты.** `auth-public`: `X-Auth-Request-Email` без bearer → 401; ключ ок/отозван (401 через ≤1 s после `NOTIFY`)/истёк (`api_key_expired`)/повреждён CRC → 401; `sbxs_` → 401. `auth-jwt` (§16 Keycloak JWT): чужой `iss`, нет `aud`, `alg:none`, `HS256`, истёкший → `token_expired`, `typ:"ID"`/`"Refresh"`, чужой `azp`, `email_verified:false` → 401; неизвестный `kid` перечитывает JWKS один раз; первый запрос создаёт пользователя, `sub` = тот же пользователь, что proxied с `X-Auth-Request-User: sub`; деактивированный → 403 `user_disabled`; без `SBX_OIDC_ISSUER` JWT → 401. `auth-proxied`: без/с чужим `Origin` POST → 403; `Authorization` → 400; `?team=` расхождение → 400. `auth-internal`: без токена/чужой → 401, второй токен из списка принят. `auth-scopes`: `requireScope` на тестовом маршруте. `auth-ratelimit`: 101-й запрос пачкой → 429 с заголовками.
- [ ] **Step 2–4.** **Step 5: commit** `api: authentication (team keys, Keycloak JWT, oauth2-proxy, service tokens), scopes, rate limits, /me`.

### Task 7: sandboxes, operations, env, каталог, limits

**Files:**
- Create: `apps/api/src/routes/{sandboxes,operations,env,catalog,limits}.ts`, `apps/api/src/schemas/{common,sandbox,operation,env,catalog,limits}.ts`, `apps/api/src/map/{sandbox,operation}.ts`, `apps/api/src/http/{cursor,idempotency,confirm-delete,wait}.ts`
- Test: `apps/api/test/{sandboxes,operations,env,catalog-limits}.test.ts`, `apps/api/test/helpers/world.ts`

**Interfaces:**
- `toSandboxResource(s: Sandbox, ctx: {settings; template: TemplateConfig|null}): SandboxResource` — §8.1: ID через кодеки, `origin` `{kind}`/`{kind:"snapshot", snapshot, snapshotId}`/`{kind:"fork", sandboxId}` (имя снапшота — из `getSavedSnapshot` не нужно: берётся `originSnapshotId` + имя одним запросом), `error {code,message}|null`, `activeOperation` — `null` для `reprovision`, `endpoints {portUrlTemplate:"https://<slug>-{port>.<sbxDomain>", ssh:"ssh <slug>@<sshHost>"}`, `environment:null`, `excludeOwnerSecrets:false`, `createdByKey` → `key_…`, время ISO с мс. `toOperationResource(op)` — §8.4, без `request`; `error {code,message,retryable}`.
- `encodeCursor(inner: string, key): string`, `decodeCursor(s, key): string` (→ 400 `invalid_cursor`).
- `idempotencyKeyHeader(c): string | undefined` (`validateIdempotencyKey`), ответ-повтор → `Idempotency-Replayed: true` (сравнение: результат create с `operation.createdAt` раньше начала запроса).
- `requireConfirmDelete(c, resource: {id: string; aliases: string[]})` → 428 `confirmation_required` `details.reason: missing|mismatch`.
- `resolveSandboxRef(ref: string): string` — `sb_…` → UUID (неверный → 404), иначе slug как есть.
- Ручки §6 (sandboxes, operations, env) с телами §8.2, лимиты тел §5.11. create: `environment` (имя/`null`/нет) — `EnvironmentStore` → наборы environment, поверх — наборы запроса, в core передаётся без `environment`; scope `snapshots:read` при `from`, `environments:read` при явном `environment`. Повтор при активной операции того же вида (`stop`/`resume`/`recover`/`delete`) → `202` с ней (core так и делает; `operation_in_progress` другого вида и `reprovision` → 409). `idleTimeoutSeconds` < 60 → 400. `DELETE` на `deleted` → `200 {sandbox, operation: null}`. `GET ?waitFor=&waitSeconds=` (до 60): сначала `get` с principal-ом, затем `waitForState(id, waitFor ∪ {error, deleting, deleted}, …)`; `GET /operations/{id}?waitSeconds=` — `getOperation` с principal-ом, затем `waitForOperation`. `PUT /env` и `PATCH /env` → core `replaceEnv`/`patchEnv`, затем доставка агенту (`agent.updateEnv`, `agent.updateSecrets`) если `ready`; ответ `{delivered, env, secretKeys, secretFiles[{name,mode,linkPath,sizeBytes}]}`. `PATCH /sandboxes` со `slug` → `rename`. `/v1/templates`, `/v1/sizes`, `/v1/limits` — §13 без `warmAvailable`; выключенные шаблоны видит только оператор.
- `test/helpers/world.ts`: `apiWorld(pool)` — топология S6 (`createTopology` из core-тестов скопировать не нужно: импорт `@sbx/core/test/helpers/*` не экспортируется — добавить в `packages/core/package.json` `"./testing": "./test/helpers/index.ts"` с `serviceEnv`, `seedSandbox`, `uniqueSlug`), `markReady(sandboxId)`, `markState(id, state)`, `finishOperation(opId, state)`.

- [ ] **Step 1: тесты.** create `202 {sandbox, operation}` и `Idempotency-Replayed` на повторе; `failFast` → 400; list с `label=k=v` дважды, `state=deleted`, подделанный курсор → `invalid_cursor`; long-poll возвращается по `markReady` раньше `waitSeconds`; `DELETE` без заголовка → 428 `missing`, с чужим ID → 428 `mismatch`, ничего не удалено; повтор `POST /stop` во время `stop` → 202 с той же операцией; `operation_in_progress` другого вида → 409 retryable; `reprovision` активная → `activeOperation:null` и `GET /operations/<её id>` → 404; ответ никогда не содержит `request`/`bodyHash`; env: значения секретов не в ответе; `PUT /env` с секретом-маркером — маркер не встречается в захваченных логах; `idleTimeoutSeconds: 30` → 400; `/limits` без `warmAvailable`.
- [ ] **Step 2–4.** **Step 5: commit** `api: sandboxes, operations, env, catalog, limits`.

### Task 8: интерфейс агента, фейк, файловый адаптер

**Files:**
- Create: `apps/api/src/agent/{types,errors,unwired,files-http}.ts`, `apps/api/src/testing/fake-agent.ts`
- Test: `apps/api/test/fake-agent.test.ts`, `apps/api/test/agent-errors.test.ts`

**Interfaces:**
- `interface AgentApi` (поля и семантика — S3 §9–§13, offset-ы — `number`):
  `capabilities(machineId): Promise<string[]>`; `requireCapability(machineId, cap, signal?)` (бросает `AgentOutdatedError`/`AgentUnavailableError` из `@sbx/agent-client`); `start(machineId, {commandId, spec: AgentCommandSpec}, {requestId, signal?}): Promise<{command: AgentCommandInfo; created: boolean}>`; `attach(machineId, {commandId, stdoutOffset, stderrOffset, ptyOffset, tailBytes?, follow?}, signal): AsyncIterable<AgentAttachEvent>`; `sendInput(machineId, {commandId, inputSessionId, seq, data: Uint8Array, closeStdin}, signal?)`; `update(machineId, {commandId, cols, rows})`; `signal(machineId, {commandId, signal})`; `kill(machineId, {commandId, graceMs?})`; `get(machineId, commandId)`; `stat|list|makeDir|move|chmod|remove(machineId, req)`; `listPorts(machineId)`; `updateEnv(machineId, env, requestId)`; `updateSecrets(machineId, {secretEnv, secretFiles}, requestId)`; `files(machineId, path: string, init: AgentFetchInit): Promise<Response>`.
  `AgentCommandSpec {shell?: string; argv?: string[]; cwd: string; env: Record<string,string>; user: string; pty?: {cols, rows, term}; stdin: boolean; timeoutMs: number; tags}`; `AgentCommandInfo {commandId, state: "starting"|"running"|"exited", pid: number|null, exit: {status:"exited"|"killed"|"lost", code, signal, reason}|null, streams: {stdout?, stderr?, pty?: {size, availableFrom, end: number|null}}, startedAt, endedAt}`; `AgentAttachEvent = {type:"data", stream:"stdout"|"stderr"|"pty", offset, data: Uint8Array} | {type:"truncated", stream, availableFrom} | {type:"heartbeat"} | {type:"exit", status, code, signal, reason, stdoutEnd, stderrEnd, ptyEnd, endedAt} | {type:"started", command}`; `reason` — нижний регистр S3 (`none`, `signal`, `timeout`, `oom`, `pty_idle`, `reboot`, `shim_lost`, `start_failed`).
- `class AgentCallError extends Error {code: string /* S3 §11.1: path_not_found, already_exists, not_directory, is_directory, no_space, permission_denied, invalid_path, payload_too_large, cross_device, command_exited, too_many_commands, invalid_argument, not_found, checksum_mismatch, upload_offset_mismatch, upload_not_found, … */; details}`; `agentErrorToHttp(e): ApiError` — `path_not_found` 404, `permission_denied` → 403 `path_forbidden`, `not_directory`/`is_directory`/`cross_device`/`already_exists`/`command_exited` 409, `no_space` 507, `payload_too_large` 413, `invalid_path` 400, `invalid_argument` → 400 `validation`, `too_many_commands` → 409 `invalid_state` `details.reason`, `AgentUnavailableError` → 503 `agent_unavailable` retryable, `AgentOutdatedError` → 409 `agent_outdated` `details.capability`, прочее → 502 `agent_error` `details.agentCode`.
- `UnwiredAgentApi(agentClient: AgentClient)`: RPC → `AgentUnavailableError`; `files` → `agentClient.fetch(machineId, path, init)`; `capabilities` — из `tunnel.tunnel_sessions`.
- `FakeAgent implements AgentApi` (`src/testing/fake-agent.ts`): `machine(machineId)` с временным домашним каталогом; команды — настоящие `bash -lc` / argv процессы (`child_process.spawn`, `cwd` относительно дома), вывод в память с offset-ами; `pty` — тот же процесс без терминала, stdout+stderr в поток `pty`, `update` пишет размер в `ptySizes`; `Start` идемпотентен по `commandId` (счётчик `startCount(commandId)`); `attach` следует S2 §9.1 (`exit` после всего вывода, `truncated` при `offset < availableFrom`, `retention(bytes)` для теста вытеснения, `heartbeat` раз в `heartbeatMs`); `sendInput` дедуплицирует `seq`; инъекции сбоев: `failNextAttach(machineId, afterBytes, kind: "unavailable"|"reset")`, `setUnavailable(machineId, on)`, `chunkSize` (по умолчанию 64 KiB, 1 — для UTF-8 теста), `capabilities` настраиваются; файлы — `/files`, `/files/uploads/*`, `/files/archive` (через системный `tar`), `Filesystem` поверх каталога; `listPorts` — настраиваемый список.

- [ ] **Step 1: тесты фейка** (контракт S3, который обязан выполнять и реальный адаптер): `Start` дважды → `created:false`, один процесс; attach с середины; `exit` только после всего вывода; `truncated`; `failNextAttach` рвёт стрим; файлы: `Range`, `ETag`, upload чанками с неверным offset → 409 `upload_offset_mismatch` с `Sbx-Upload-Offset`, archive туда-обратно; `agent-errors.test.ts` — таблица.
- [ ] **Step 2–4.** **Step 5: commit** `api: agent interface, fake agent, files adapter over AgentClient.fetch`.

### Task 9: команды — запуск, NDJSON, attach, вывод, управление, реестр стримов

**Files:**
- Create: `apps/api/src/commands/{run,frames,utf8,collect,attach,wait-ready,registry}.ts`, `apps/api/src/routes/commands.ts`, `apps/api/src/schemas/command.ts`, `apps/api/src/map/command.ts`
- Test: `apps/api/test/commands-{start,stream,attach,control,idempotency,registry}.test.ts`, `apps/api/test/utf8.test.ts`

**Interfaces:**
- `class Utf8StreamDecoder {push(chunk: Uint8Array): {text: string; consumed: number}; flush(): string}` — держит незаконченную последовательность (≤ 3 байт); `consumed` — сколько байт ушло в `text` (для `nextOffset`); неверные байты → U+FFFD.
- `type Frame` — кадры §9.5 (`started`, `attached`, `stdout|stderr|pty`, `truncated`, `heartbeat`, `reconnect`, `exit`, `error`); `ndjsonResponse(c, frames: AsyncIterable<Frame>, headers): Response` (`application/x-ndjson`, `Cache-Control: no-store`, `X-Accel-Buffering: no`, flush на кадр).
- `waitUntilReady(deps, p, ref, signal): Promise<Sandbox>` — §9.1 шаг 2 (60 s, `sandbox_starting` retryable / `sandbox_not_ready` / 404).
- `startCommand(deps, auth, ref, body, idemKey?)` — §9.1: scope, `touchApiActivity`, готовность, capability `process.v1` (+`process.stdin`, `process.pty`), `createCommandWithKey`/`createCommand`, `agent.start` с `requestId` = UUIDv5(`principal:commands.create:key`) или новый UUID; ошибки `Start` — §9.1 «Если Start не прошёл»; `markCommandRunning`.
- `followCommand(deps, machineId, commandId, offsets, opts: {tailBytes?, follow, encoding, signal, maxDurationMs: 3_600_000, heartbeatMs: 15_000}): AsyncIterable<Frame>` — `resumableAttach` из `@sbx/agent-client` поверх `agent.attach`; `AgentUnavailableError` → кадр `error {code:"agent_unavailable", retryable:true, …offsets}`; по `exit` — `completeCommand` (статус: `TIMEOUT` → `timed_out`, `START_FAILED` → `failed_to_start`, иначе `exited|killed|lost`); `maxDurationMs` → `reconnect {reason:"max_duration"}`; shutdown → `reconnect {reason:"server_shutdown"}`.
- `collectSync(frames): SyncResult` — хвост ≤ 4 MiB на поток, `stdoutFrom`, `stdoutTruncated`.
- `StreamRegistry` — `register({userId, apiKeyId, teamId}, abort: (frame) => void): () => void`; `revoke(match)`; подписка на `NOTIFY sbx_identity` перепроверяет principal-ов (ключ отозван/истёк, участник удалён, пользователь выключен) → `error {code:"unauthorized", retryable:false}`; лимит 100 открытых на principal → 429 `rate_limited`; `closeAll(reason)` для shutdown.
- Ручки §6/§9: `POST /commands` (`sync` 200, `stream` 200 NDJSON + `Sbx-Command-Id`, `detached` 201; повтор: sync — ждёт выход той же команды, stream — с offset 0 и `replayed:true`, detached — 200), `GET /commands` (core `listCommands`, курсор HMAC), `GET /commands/{cmd}` (живые поля из `agent.get`, если `ready`), `/stream`, `/output` (заголовки `Sbx-Offset`, `Sbx-Next-Offset`, `Sbx-Available-From`, `Sbx-Stream-End`, `Sbx-Truncated`; `limit` ≤ 4 MiB), `/input` (204; без `sessionId` — новый на запрос), `/kill` (`graceMs` 10 000), `/signal` (список §9.4) — 200 `Command`. Ресурс Command — §9.6 (`streams` из агента или `stdout_bytes`/`stderr_bytes`).

- [ ] **Step 1: тесты.** `utf8.test.ts`: все разрезы 1–4-байтовых символов, неверные байты, reattach с `nextOffset` склеивает тот же текст (property-тест `fast-check`). `commands-start`: три режима, `timeoutSeconds` sync > 600 → 400, `command`+`argv` → 400, `stdin:true` без `process.stdin` → 409 `agent_outdated`, sandbox `starting` → ждёт и стартует после `markReady`, 60 s истекли → 409 `sandbox_starting` (таймаут уменьшается через deps). `commands-stream`: 3000 строк × 512 B — sha256 stdout совпадает; `failNextAttach` в середине — тот же sha256, пауза; агент недоступен дольше бюджета → последний кадр `error` retryable с offset-ами. `commands-attach`: `tailBytes`, `follow=false`, `truncated`, `/output` с `offset < availableFrom`. `commands-control`: input с повтором `seq`, kill → `killed`, signal неизвестный → 400, input завершённой → 409 `command_exited`, команда чужой sandbox → 404. `commands-idempotency` (Review Focus 1): повтор во время стрима и после — `startCount === 1`, кадр `started.replayed === true`; без ключа и `AgentUnavailableError` из `start` → 503 `retryable:false`, `details.outcome:"unknown"`, `details.commandId`. `commands-registry` (Review Focus 4): отзыв ключа → кадр `error unauthorized` ≤ 1 s.
- [ ] **Step 2–4.** **Step 5: commit** `api: commands (sync, stream, detached, attach, output, input, kill, signal) and stream registry`.

### Task 10: PTY по WebSocket

**Files:**
- Create: `apps/api/src/routes/ptys.ts`, `apps/api/src/commands/pty-socket.ts`
- Test: `apps/api/test/pty.test.ts`

**Interfaces:**
- `POST /ptys` (`Idempotency-Key`, `{cols, rows, command, cwd, env, user, term}`, capability `process.pty`) → 201 Command `mode:"pty"`; `POST /ptys/{cmd}/resize` → 204.
- `GET /ptys/{cmd}/connect?offset=&tailBytes=` — upgrade через `upgradeWebSocket` `@hono/node-server` 2.x (если нужен `bufferedAmount` — сам `ws`), subprotocol `sbx.pty.v1` обязателен. Сервер: бинарные кадры вывода, текстовые `attached {offset}` первым, `truncated`, `exit`, `error`, `reconnect {offset, reason}`. Клиент: бинарный — ввод (склейка 5 ms, `inputSessionId` на соединение, `seq` по порядку), текстовый `{type:"resize", cols, rows}`. Backpressure: `bufferedAmount > 1 MiB` — пауза чтения attach. Ping каждые 15 s. Close: 1000 после `exit`, 1012 при shutdown (после `reconnect`), 4401/4403/4404/4409/4503. Auth — тот же слой, что HTTP (на proxied — Origin и `?team=`). Регистрируется в `StreamRegistry` (отзыв → 4401).
- OpenAPI: `GET` с ответом `101` и `x-sbx-websocket: {subprotocol: "sbx.pty.v1"}`.

- [ ] **Step 1: тесты** (клиент — `ws`): эхо `cat`, resize попадает в `fake.ptySizes`, обрыв сокета и переподключение с `offset` = полученным — вывод без потерь и дублей; без subprotocol → отказ; proxied с чужим `Origin` → отказ upgrade 403; чужая команда → 4404; отзыв ключа → 4401.
- [ ] **Step 2–4.** **Step 5: commit** `api: PTY over WebSocket (sbx.pty.v1)`.

### Task 11: файлы

**Files:**
- Create: `apps/api/src/routes/files.ts`, `apps/api/src/schemas/files.ts`
- Test: `apps/api/test/files-{content,uploads,ops,archive}.test.ts`

**Interfaces:**
- Ручки §11.1. Состояние sandbox — `waitUntilReady`; capabilities `files.v1`, `files.upload.v1`, `files.archive.v1`. `GET/HEAD /files/content` → `agent.files(m, "?path=&user=", {headers: Range/If-Range})`, ответ потоком (`readBodyCapped` нигде, кроме JSON-ошибок агента), заголовки `Content-Type: application/octet-stream`, `Content-Disposition: attachment; filename*=UTF-8''<name>`, `X-Content-Type-Options: nosniff`, `ETag`, `Last-Modified`, `Accept-Ranges`, `Content-Range`; JSON-ошибки агента → `agentErrorToHttp` (`is_directory` 409, 416 → `range_not_satisfiable`). `PUT /files/content` — тело `c.req.raw.body` потоком (`duplex:"half"`, без повтора). Uploads: `POST` → `{uploadId: newPublicUlid("upload"), chunkSizeBytes: 4194304, maxChunkSizeBytes: 8388608, expiresAt: +24h}`; `PUT ?offset=&path=` — чанк до 8 MiB буферизуется (`readBodyCapped`-аналог для входа, > 8 MiB → 413), передаётся агенту буфером (повторяемо); ответ агента `409` → `upload_offset_mismatch` с `Sbx-Upload-Offset` из `parseUploadOffset`; `HEAD` → `Sbx-Upload-Offset`; `commit` → `FileInfo`, `422 checksum_mismatch`; `DELETE`. Остальное — RPC `Filesystem`. `FileInfo` §11.1 (`modifiedAt` ISO). `GET /files/list` — курсор HMAC оборачивает `page_token`. Archive: `GET` поток, `Content-Type` по `format`; `PUT` поток → `{path, entries, sizeBytes}`.

- [ ] **Step 1: тесты:** 100 MiB загрузка чанками с обрывом после 3-го чанка и докачкой через `HEAD` (sha256 совпадает); `Range: bytes=10-19` → 206 и 10 байт; `If-Range` с чужим ETag → 200 весь файл; `checksum_mismatch`; каталог → 409 `is_directory`; `../`, абсолютный путь и symlink в архиве → 400 `invalid_path`; архив каталога туда и обратно — sha256 файлов совпадают; `uploadId` другой sandbox той же команды не виден агенту этой (404 `upload_not_found`); 5 MiB `PUT /content` не держится в памяти целиком (проверка: поток читается агентом до конца запроса — фейк считает максимальный размер буфера < 1 MiB).
- [ ] **Step 2–4.** **Step 5: commit** `api: files (content, uploads, fs ops, archive)`.

### Task 12: порты, snapshots, environments

**Files:**
- Create: `apps/api/src/routes/{ports,snapshots,environments}.ts`, `apps/api/src/schemas/{port,snapshot,environment}.ts`
- Test: `apps/api/test/{ports,snapshots,environments}.test.ts`

**Interfaces:**
- Порты §11.2: `GET /ports` → `{hosted, listening, listeningObservedAt}` (`listening` — `agent.listPorts`, если `ready` и агент ответил, иначе `sandbox.listeningPorts`); `PUT /ports/{port}` → 201/200 `HostedPort` (`url`, `label`; `token`/`urlWithToken` только у выпустившего вызова); `public` при `publicPortsEnabled=false` → 403 `forbidden` `details.reason:"public_disabled"`; `rotate-token`; `DELETE` → 204; порт 22, 0, 65536 → 400; 51-й → 400.
- Snapshots §13: `POST /v1/snapshots {sandbox, name}` (`Idempotency-Key`) → 202 `{snapshot, operation}`; `GET` список/по имени; `DELETE /v1/snapshots/{name}` с `Sbx-Confirm-Delete` (`snap_…` или имя) → 204. Ресурс `{id: snap_, name: name ?? pendingName, state, sourceSandboxId, template, templateVersion, size, consistency, error, createdAt, readyAt}`.
- Environments S8 §10.2: `GET/POST /v1/environments`, `GET/PATCH/DELETE /v1/environments/{environment}`; запись — scope `environments:write` и роль `owner` у людей (`member` → 403 `details.reason:"role"`); значения секретов не отдаются.

- [ ] **Step 1: тесты:** токен в ответе один раз и не в `GET /ports`; повторный `PUT` с теми же настройками → 200 без токена; `rotate-token` меняет hash в БД; snapshot `DELETE` без заголовка → 428; create с environment по умолчанию и `environment:null`; `member` не меняет environment.
- [ ] **Step 2–4.** **Step 5: commit** `api: ports, saved snapshots, environments`.

### Task 13: SSH, SSH-ключи, API-ключи

**Files:**
- Create: `apps/api/src/routes/{ssh,ssh-keys,api-keys}.ts`, `apps/api/src/schemas/{ssh,api-key}.ts`
- Test: `apps/api/test/{ssh,ssh-keys,api-keys}.test.ts`

**Interfaces:**
- `GET /sandboxes/{sb}/ssh` (§11.3; `loginUser` из шаблона, `knownHosts` = `"<sshHost> <key>"`, `hasKeys`). `POST /sandboxes/{sb}/ssh/certificate {publicKey}` → `signUserCertificate` (`principals: [sb_…]`, `keyId: sbx:user:<usr_…>` | `sbx:key:<key_…>`, `validAfter = now − 60 s`, `validBefore = now + 10 min`) → `{certificate, principal, validAfter, validBefore, host, port, username, knownHosts}`; без `SBX_SSH_LOGIN_CA_KEY_FILE` → 500 `internal` с сообщением «SSH login CA is not configured». Состояние sandbox не проверяется.
- `/v1/ssh-keys` — только человек (`user_required`), типы §11.3, `409 ssh_key_in_use`.
- `/v1/api-keys` §13: `GET` (участник или ключ с `keys:admin`), `POST {name, scopes?|preset?, expiresInSeconds?, kind?}` (только `owner`-человек; по умолчанию 90 дней, максимум 365; `kind:"sandbox"` → 400; `sandbox-self` → 400; неизвестный scope → 400) → 201 `{apiKey, secret}`; `rotate` → 200 `{apiKey, secret}`; `DELETE /{key}` (`owner`, оператор-сессия или ключ с `keys:admin` своей команды) → 204; `DELETE /self` → 204. Отзыв/ротация шлют `NOTIFY sbx_identity` (триггер) — кэш всех подов сбрасывается. `createdVia`: `cli`, если `User-Agent` начинается с `sbx-cli/`, `dashboard` для сессии, иначе `api`.

- [ ] **Step 1: тесты** (§16 «Командные ключи», «SSH-сертификаты»): `member` и ключ не выпускают ключ (403 `role`/`user_required`); ключ работает после удаления создателя из команды и его деактивации; `owner` отзывает — следующий запрос 401; ключ с `keys:admin` отзывает чужой ключ своей команды, но не другой команды (404); секрет в ответе только `POST`/`rotate`, в `GET` — нет; сертификат: `parseUserCertificate` даёт principal `sb_…`, `keyId sbx:key:key_…`, срок 10 min; RSA 2048 → 400.
- [ ] **Step 2–4.** **Step 5: commit** `api: ssh certificates, ssh keys, team api keys`.

### Task 14: внутренние ручки gateway, события агента, SSO для портов

**Files:**
- Create: `apps/api/src/routes/internal/{routes,ssh-authorize,port-auth,agent-events}.ts`, `apps/api/src/routes/sbx-auth.ts`, `apps/api/src/agent/event-decode.ts`
- Test: `apps/api/test/internal-{routes,ssh,port-auth,events}.test.ts`

**Interfaces:**
- `GET /internal/v1/gateway/routes/{label}` → тело ровно S4 §6.1 + `kind:"port"`; `sandboxId`/`teamId` публичного формата; `authEpoch` для `sso` = `auth_epoch + ssoPolicyEpoch`; `blocked:true, blockReason:"public_disabled"` для `public` при выключенном флаге; `404 {"code":"route_not_found", "error":{…}}` (метка вне грамматики, порт не опубликован, `deleted`).
- `POST /internal/v1/gateway/ssh/authorize` — §12.1 (C6: без оператора) → `{allowed:true, actor, userId, email, sandboxId, machineId, sandboxState, loginUser, teamId}` или `{allowed:false}`; `touchSshKey`/`touchApiKey`.
- `POST /internal/v1/gateway/port-auth/exchange {code, label}` — атомарный `UPDATE … RETURNING` §12.1 → `{userId: usr_…, email, label, authEpoch}` или `400 {"code":"invalid_code", "error":{…}}`.
- `POST /internal/v1/agent-events` (`Content-Type: application/proto`, до 16 MiB) → `fromBinary(AgentEventsRequestSchema)` → `ingestAgentEvents` → `AgentEventsResponse {ackedSeq}` в том же формате, что запрос (proto или protojson).
- `GET /sbx-auth/authorize?label=&state=` (только proxied) — §7.7: метка по грамматике, маршрут `sso` и не `blocked`, политика `any|team`; код 32 байта base64url, `sha256` в `port_auth_codes` (60 s); `302` на `https://<label>.<sbxDomain>/__sbx/auth/callback?code=&state=`; иначе — минимальная HTML-страница ошибки (без внешних ресурсов) со статусом 400/403/404.

- [ ] **Step 1: тесты:** маршрут с `public` при `publicPortsEnabled=false` → `blocked`; `deleted` sandbox → 404 с верхнеуровневым `code`; ssh: сертификат с principal другой sandbox → `allowed:false`; отозванный ключ, деактивированный пользователь, не участник команды (даже оператор) → `allowed:false`; зарегистрированный ключ с несовпадающим `publicKey` → `false`; port-auth: второй обмен того же кода и чужой `label` → `invalid_code`; истёкший (сдвиг `expires_at`) → `invalid_code`; agent-events: батч из 3 событий → `ackedSeq = 3`, повтор батча — та же строка в `agent_events`; sbx-auth: метка `x-3000` с `access=token` → страница ошибки без редиректа; редирект строится из label, а не из `Host`.
- [ ] **Step 2–4.** **Step 5: commit** `api: internal gateway endpoints, agent events, port SSO authorize`.

### Task 15: процесс `api`, остановка, Dockerfile, compose с Keycloak и oauth2-proxy

**Files:**
- Create: `apps/api/src/main.ts`, `apps/api/src/server.ts`, `apps/api/src/shutdown.ts`, `apps/api/Dockerfile`, `deploy/compose/keycloak/realm-sbx.json`, `deploy/compose/secrets-init/init.sh`, `deploy/compose/config/identity.yaml`
- Modify: `deploy/compose/compose.yaml`, `deploy/compose/README.md`, `apps/worker/Dockerfile` (строки `COPY` манифестов новых пакетов), `.dockerignore` при необходимости
- Test: `apps/api/test/{shutdown,main}.test.ts`

**Interfaces:**
- `startApi(settings, deps?): Promise<{close(): Promise<void>; ports}>` — четыре `serve()`; `SIGTERM`: `/readyz` → 503, новые запросы → 503 `server_shutting_down`, `streams.closeAll("server_shutdown")` (стримы — `reconnect`, PTY — `reconnect` + 1012), sync в полёте → 503 (`retryable` только с `Idempotency-Key`, иначе `details {commandId, outcome:"running"}`), ожидание до 10 s, выход.
- Compose: сервисы `secrets-init` (alpine, один раз: генерирует в `secrets/` `service-tokens.json`, `cursor-key`, `ssh-login-ca` (ed25519, `ssh-keygen`), `ssh-host-keys.pub` (dev-ключи gateway до S4), `oauth2-proxy-client-secret`, `oauth2-proxy-cookie-secret`, `sbx-worker-client-secret`, `data-keys.json` — только если файлов ещё нет), `keycloak` (`quay.io/keycloak/keycloak:26.8.1`, `start-dev --import-realm`, БД `keycloak` в том же Postgres через init-скрипт или отдельную схему; admin из `.env`; порт `127.0.0.1:8180`; hostname `http://localhost:8180`), `oauth2-proxy` (`quay.io/oauth2-proxy/oauth2-proxy:v7.15.5`, provider `keycloak-oidc`, upstream `/api/` → `http://api:8081/` с отрезанием `/api`, `/sbx-auth/` → `api:8081`, `--upstream-timeout=660s`, `--cookie-name=__Host-sbx_session`… для http-dev — `_sbx_session` без `Secure`, порт `127.0.0.1:4180`), `api` (образ `apps/api/Dockerfile`, порты `127.0.0.1:8080`, `:8082` наружу не публикуется, `:9091→9090`, `depends_on: migrate, keycloak(healthy), secrets-init(completed)`). Realm: клиенты и сроки architecture §10; тестовый пользователь `dev@example.com` (email подтверждён) с временным паролем `SBX_DEV_PASSWORD` из `deploy/compose/.env` (по умолчанию `dev`) и required action `UPDATE_PASSWORD`; README объясняет первый вход.
- Адреса Keycloak: публичный `http://localhost:8180` (`KC_HOSTNAME`) для браузера и CLI, внутренний `http://keycloak:8080` для `api` (`SBX_OIDC_JWKS_URL`) и oauth2-proxy (`--skip-oidc-discovery` с явными `--login-url` на localhost и `--redeem-url`/`--oidc-jwks-url` на `keycloak:8080`).
- README: запуск, `sbx login --api-url http://localhost:8080`, дашборда пока нет (S8), браузерный вход проверяется через `http://localhost:4180/api/v1/me`.

- [ ] **Step 1: тесты:** `shutdown.test.ts` — Review Focus 5 (стрим получает `reconnect`, PTY — 1012, sync с ключом → 503 retryable, без ключа → `outcome:"running"`, `close()` ≤ 10 s при висящем стриме); `main.test.ts` — `startApi` поднимает 4 порта, `/readyz` 200, `/v1/meta` 200.
- [ ] **Step 2–4.**
- [ ] **Step 5: compose smoke** (вручную, вывод — в отчёт): `docker compose -f deploy/compose/compose.yaml up -d --build`; `ps -a` — `api`, `worker`, `postgres`, `keycloak`, `oauth2-proxy` healthy, `migrate`/`secrets-init` Exited (0); `curl -s localhost:8080/v1/meta`; `curl -s localhost:8180/realms/sbx/.well-known/openid-configuration`; device grant `curl -d client_id=sbx-cli localhost:8180/realms/sbx/protocol/openid-connect/auth/device` → `user_code`.
- [ ] **Step 6: commit** `api: process, graceful shutdown, Dockerfile; compose: api, keycloak, oauth2-proxy`.

### Task 16: SDK TS — генерация, транспорт, повторы, учётные данные

**Files:**
- Create: `packages/sdk-ts/{package.json,tsconfig.json,vitest.config.ts}`, `src/gen/v1.d.ts` (генерируется `openapi-typescript ../../apps/api/openapi/v1.json`), `src/{index,client,errors,retry,credentials,ids}.ts`
- Test: `packages/sdk-ts/test/{retry,credentials,client}.test.ts`

**Interfaces:**
- `class SbxError extends Error {status: number; code: string; retryable: boolean; details: Record<string, unknown>; requestId: string|null}`; `SandboxFailedError extends SbxError`.
- `interface CallOptions {signal?: AbortSignal; retryBudgetMs?: number /* default 60_000 */; idempotencyKey?: string}`.
- `interface SbxOptions {baseUrl?: string; team?: string; apiKey?: string; accessToken?: string; tokenProvider?: () => Promise<string>; fetch?: typeof fetch; userAgent?: string; env?: Record<string,string|undefined>; authCommand?: string[] /* default ["sbx","auth","token","--json"] */}`.
- `resolveCredentials(opts): Promise<{baseUrl; team?; getToken(force?: boolean): Promise<string>}>` — цепочка §7.6: явные → `SBX_API_KEY` → `SBX_ACCESS_TOKEN` → `sbx auth token --json` (`{kind, token, expiresAt, apiUrl, team}`; токен не отправляется на другой `apiUrl`; кэш до `exp − 60 s`).
- `createRawClient(opts): RawClient` — `openapi-fetch` `createClient<paths>` + middleware: `Authorization`, `Sbx-Team`, `User-Agent: sbx-sdk-ts/<version>`; `Idempotency-Key` UUIDv4 для `POST /v1/sandboxes`, `/fork`, `/commands`, `/ptys`, `/v1/snapshots`, если не задан, и тот же на все повторы; ошибки → `SbxError`; `401 token_expired` → один `getToken(true)` и повтор.
- `withRetry(fn, {method, idempotent, signal, budgetMs})` — §15.4: `GET/HEAD/PUT/DELETE` на сетевых ошибках, 502/503/504/429; `POST` — с `Idempotency-Key` или `retryable:true`; `retryable:false` — никогда; backoff 0,5 s × 2 до 8 s full jitter, `Retry-After` приоритетнее, общий бюджет `retryBudgetMs`, `signal` прерывает ожидание.
- `package.json` `scripts.gen` + тест свежести `v1.d.ts`.

- [ ] **Step 1: тесты** на поддельном `fetch`: 503 → повтор с тем же `Idempotency-Key`; `POST` без ключа и 503 `retryable:false` → без повтора; `Retry-After: 2`; бюджет 1 s исчерпан → последняя ошибка; `signal.abort()` во время backoff → `AbortError` сразу; цепочка учётных данных с подменой `sbx` (скрипт в `PATH`), чужой `apiUrl` не используется; `token_expired` → ровно один повтор; `v1.d.ts` свежий.
- [ ] **Step 2–4.** **Step 5: commit** `sdk-ts: generated types, transport, retries, credential chain`.

### Task 17: SDK TS — фасад и хелперы

**Files:**
- Create: `packages/sdk-ts/src/{sbx,sandbox,commands,ndjson,files,pty,pages}.ts`
- Test: `packages/sdk-ts/test/facade.test.ts` (против `apps/api` с `FakeAgent` и Postgres, `@sbx/api/testing`)

**Interfaces:**
- `class Sbx {constructor(opts?: SbxOptions); raw: RawClient; sandboxes: {create(input, opts?: CallOptions & {wait?: boolean; waitTimeoutMs?}): Promise<Sandbox>; get(ref, opts?); list(filter?, opts?): AsyncIterable<SandboxData>}; snapshots: {...}; me(); limits(); templates(); sizes()}`.
- `class Sandbox {data; id; slug; refresh(); waitUntilReady({timeoutMs: 300_000, signal}); waitForOperation(op); exec(cmd: string|string[], opts?: ExecOptions): Promise<ExecResult>; run(cmd, opts?): AsyncIterable<RunEvent>; start(cmd, opts?): Promise<Command>; command(id): Command; files: Files; ports: {host(port, {access, hostRewrite, appProtocol}); list(); unhost(port); rotateToken(port)}; pty(opts): Promise<Pty>; stop(); resume(); fork(); delete(); stopAndDelete()}`.
- `ExecResult {command, stdout: string, stderr: string, exitCode: number|null, stdoutTruncated, stderrTruncated}` — `exec` шлёт `mode:"stream"` и собирает хвост 4 MiB на поток. `RunEvent = {type:"stdout"|"stderr"|"pty", data: string|Uint8Array, offset} | {type:"truncated", …} | {type:"exit", status, exitCode, signal, reason}`; `heartbeat`/`reconnect`/`attached`/`started` скрыты; обрыв, 45 s без строк, `error{retryable}`, `reconnect` → `/stream` с последними offset-ами; 20 неудач подряд без новых байт → ошибка; ранний `break` не убивает команду.
- `Command.follow({from: "start"|"end"|{stdoutOffset, stderrOffset}})`, `kill()`, `signal()`, `input()`, `output(stream, offset, limit)`.
- `Files {readText, writeText, readBytes, writeBytes, stat, list, mkdir, move, chmod, remove, upload(path, src: Uint8Array|Blob|ReadableStream|string /*local path, Node*/, {chunkSize}), download(path, dest), uploadDir(localDir, path) /* tar.gz через системный tar (Node/Bun) */, downloadDir(path, localDir)}`.
- `Pty {onData(cb), write(data), resize(cols, rows), close(), exited: Promise<ExitInfo>}` — глобальный `WebSocket(url, {protocols:["sbx.pty.v1"], headers})` (undici в Node, Bun), переподключение с offset.
- Все методы принимают `CallOptions`.

- [ ] **Step 1: тесты** (один сценарий §16 «SDK»): create(wait) → exec → run с `failNextAttach` (вывод совпадает) → start + follow → files write/read/upload 20 MiB/uploadDir → ports.host → pty эхо → delete; `exec` повторяется после 503 на первом `POST` и команда запускается один раз; `signal` прерывает `waitUntilReady`.
- [ ] **Step 2–4.** **Step 5: commit** `sdk-ts: facade and helpers (wait, exec, run, follow, files, upload, pty)`.

### Task 18: chaos стрима и остановка `api`

**Files:**
- Test: `apps/api/test/chaos.test.ts`

- [ ] **Step 1: тест** (главный сценарий §16 в рамках решения 3): два экземпляра `api` (`startApi` на одной БД и одном `FakeAgent`) за тестовым балансировщиком (TCP-прокси, который можно переключить); SDK `run()` 3000 строк × 512 B в stdout и stderr; каждые 100–400 ms случайно: `failNextAttach`, обрыв соединения клиента в прокси, остановка текущего экземпляра `api` (SIGTERM-путь `close()`) и подъём нового. Итог: sha256 обоих потоков совпадает, код выхода верный, `fake.startCount === 1`.
- [ ] **Step 2: PASS** (если падает — исправлять код задач 9, 15, 17, не тест).
- [ ] **Step 3: commit** `test: stream chaos across api restarts`.

### Task 19: матрицы безопасности и конформность OpenAPI

**Files:**
- Create: `apps/api/test/security-{idor,scopes,leaks,headers}.test.ts`, `apps/api/test/helpers/route-table.ts`

- [ ] **Step 1: тесты.** `route-table.ts` — таблица всех операций из `openapi/v1.json` (`operationId` → метод, путь, требуемый scope, человек/owner, пример тела); тест проверяет, что таблица покрывает **все** операции документа. `security-scopes`: для каждой операции ключ без её scope → 403 `requiredScope`, `me/limits/templates/sizes/api-keys/self` — любой ключ. `security-idor`: для каждой операции с ресурсом в пути — ресурс команды B ключом команды A → 404, состояние B не изменилось (команда, upload, операция, снапшот, порт, ssh-key пользователя B, api-key B). `security-leaks`: маркер в env/secrets/secretFiles/секрете ключа/токене порта/bearer ищется во всех захваченных логах, в `operations.request`, `idempotency_keys.response`, `pgboss.job.data`. `security-headers`: `X-Auth-Request-*` на public игнорируются; WebSocket upgrade proxied с чужим `Origin` → отказ. Конформность: `harness` валидирует каждый JSON-ответ всех тестов `apps/api` по документу (включено с задачи 5); здесь — проверка, что у каждой операции хотя бы один ответ прошёл валидацию за прогон (счётчик в global teardown).
- [ ] **Step 2: PASS** (найденное чинится в коде).
- [ ] **Step 3: commit** `test: authz, IDOR and secret-leak matrices; OpenAPI conformance coverage`.

### Task 20: CLI — каркас, вывод, вход

**Files:**
- Create: `apps/cli/{package.json,tsconfig.json,vitest.config.ts}`, `src/{main,program,output,exit-codes,config,profile,current}.ts`, `src/auth/{store,keychain,file-store,lock,device-grant,token}.ts`, `src/commands/{login,logout,whoami,auth-token,current,version,completion,mcp}.ts`
- Test: `apps/cli/test/{output,login,auth-token,store}.test.ts`, `apps/cli/test/helpers/run-cli.ts`

**Interfaces:**
- Запуск в тестах: `runCli(args, {env, stdin, tty?: boolean}) → {code, stdout, stderr}` — `bun src/main.ts` дочерним процессом против `api` из `@sbx/api/testing` и `startTestOidcServer`.
- Вывод §14.3: `Output {json: boolean /* !isTTY || --json || SBX_OUTPUT=json, --human отменяет */; result(obj); event(name, obj) /* JSONL с полем event */; error(err) /* последняя строка stdout {"event":"error",code,message,retryable,details,requestId} в JSON, текст — в stderr; у сырых команд без --json — в stderr */}`. Коды выхода: 0, 1, 2 (аргументы), 3 (не найдено), 4 (нет прав/входа), 75 (retryable, исчерпаны повторы); `exec`/`run` — код команды (`128+n`, `124`, `125`).
- Конфиг `$XDG_CONFIG_HOME/sbx/config.json` (0600): `{current: string, profiles: {name: {apiUrl, team?, auth: "oidc"|"key", issuer?}}}`; порядок: флаги > env (`SBX_API_URL`, `SBX_API_KEY`, `SBX_TEAM`, `SBX_PROFILE`) > профиль > `/etc/sbx/config.json` (`apiUrl`).
- Хранилище: `CredentialStore {get(name), set(name, value), delete(name)}`; `KeychainStore` через `Bun.secrets` (`service:"sbx"`, `name:"<profile>@<issuer|apiUrl>"`), `FileStore` (`credentials.json`, 0600, предупреждение в stderr); выбор `--credential-store keychain|file`, `auto` — keychain, при ошибке — файл.
- Device grant §7.6: `meta.oidc` → `auth/device` → печать кода и ссылки (+ открытие браузера, кроме `--no-browser`) → опрос с `authorization_pending`/`slow_down`/`expired_token`/`access_denied` → `/v1/me`. `--key-stdin`: ключ из stdin, проверка `/v1/me`. `logout`: OIDC — `revoke` refresh; ключ — стереть, `--revoke` → `DELETE /v1/api-keys/self`.
- `getBearer(profile): Promise<{kind, token, expiresAt}>` — access до `exp − 30 s`, затем `refresh_token` под файловой блокировкой `$XDG_CONFIG_HOME/sbx/.lock` (`open(O_CREAT|O_EXCL)` + повтор, протухшая блокировка > 30 s снимается); второй процесс читает обновлённый; `invalid_grant` → «run: sbx login», код 4. `sbx auth token [--json]` → `{kind, token, expiresAt, apiUrl, team}`.
- `sbx mcp` — заглушка (решение 12).

- [ ] **Step 1: тесты:** без TTY `whoami` печатает JSON `/me`; ошибка — последняя строка `{"event":"error",…}` с `requestId`, код 4 на 401; `login` device grant с автоподтверждением в OIDC-сервере → `auth token --json` даёт тот же `sub`; два параллельных `auth token` с истёкшим access делают ровно один `refresh` (счётчик OIDC-сервера); `invalid_grant` → код 4; `--key-stdin`; `--credential-store file` → файл 0600; `SBX_API_KEY` в env приоритетнее сохранённого.
- [ ] **Step 2–4.** **Step 5: commit** `cli: skeleton, output contract, profiles, login (device grant, key-stdin), auth token`.

### Task 21: CLI — команды

**Files:**
- Create: `apps/cli/src/commands/{create,list,info,lifecycle,rm,rename,extend,label,env,exec,logs,kill,ps,shell,ssh,ssh-config,ssh-cert,ssh-keys,cp,push,port,snapshot,catalog,keys,run}.ts`, `apps/cli/scripts/build.ts`
- Test: `apps/cli/test/{lifecycle,exec,files,ports-ssh,keys,build}.test.ts`

**Interfaces:**
- Команды и флаги — таблица §14.2 без `--fail-fast`. `<sb>`: аргумент → `SBX_SANDBOX` → текущая (`$XDG_STATE_HOME/sbx/current/<SBX_SESSION | ppid-starttime>`, старше 7 дней — удалить) → `SBX_SANDBOX_ID` (UUID → `sb_…`). `create`, `fork` и команды с явным `<sb>` делают её текущей; `sbx current` без текущей → код 3.
- Ждущие (`--wait`) — JSONL `accepted`, `state`, последним `ready`/`stopped`. `rm`: подтверждение в TTY, без TTY и без `--yes` → код 2; ставит `Sbx-Confirm-Delete`. `exec`: стрим (stdout → stdout, stderr → stderr), автоматический reattach (SDK `run`), код выхода — код команды; `--json` — кадры NDJSON с `event` вместо `type`; `--detach` печатает `commandId`. `shell`: PTY в raw-режиме, `SIGWINCH` → resize, переподключение, scrollback 64 KiB. `ssh`: эфемерный ed25519 (`ssh-keygen`) в каталоге 0700 + сертификат + системный `ssh -i … -o CertificateFile=… -o UserKnownHostsFile=~/.config/sbx/known_hosts <slug>@<host> -p <port>`; файлы удаляются. `ssh-config` — блок `Host sbx-<slug>` с `Match exec "sbx ssh-cert <sb> --ensure"`; `ssh-cert --ensure` — новый сертификат, если до конца < 2 min. `cp [-r]` — `sb:path` с любой стороны; > 64 MiB — `upload`/`download` с докачкой; `-r` — архив. `push` — `git ls-files -co --exclude-standard` или весь каталог, tar.gz потоком. `keys create` — только вход Keycloak. `run` — create → push → exec → delete (кроме `--keep`).
- `scripts/build.ts`: `bun build --compile --target=bun-<os>-<arch> src/main.ts --outfile dist/sbx-<os>-<arch>` для пяти целей §14.1 + `SHA256SUMS`; `pnpm --filter @sbx/cli build` собирает только текущую платформу, `build:all` — все.

- [ ] **Step 1: тесты** (§16 «Контракт CLI»): без TTY `create --wait` → JSONL, последняя строка `ready`; `rm` без `--yes` без TTY → 2, с `--yes` → `Sbx-Confirm-Delete` пришёл (ресурс удалён); `exec -- sh -c 'echo out; echo err >&2; exit 7'` → stdout `out`, stderr `err`, код 7; `exec` с сигналом → `128+n`; `cp` туда и обратно 70 MiB (чанками) — sha256 совпадает; `cp -r`; `port --token` печатает URL с токеном; `ssh-config` содержит `Match exec`; `ssh-cert` пишет сертификат, `--ensure` второй раз его не меняет; `current` после `create`; собранный бинарник (`build`) отвечает на `sbx version`.
- [ ] **Step 2–4.** **Step 5: commit** `cli: sandbox, exec, files, ports, ssh, snapshots, keys commands; bun compile`.

### Task 22: Python SDK

**Files:**
- Create: `packages/sdk-py/{pyproject.toml,package.json,README.md,openapi-python-client.yaml}`, `packages/sdk-py/sbx_sdk/{__init__,_client,_errors,_retry,_credentials,_ndjson,sandbox,files}.py`, `packages/sdk-py/sbx_sdk/_gen/**` (генерируется, коммитится), `packages/sdk-py/tests/{conftest,test_facade,test_retry}.py`, `packages/sdk-py/tests/api_server.ts` (запуск `apps/api` с фейком и Postgres для pytest)
- Modify: `mise.toml` (`python = "3.15.2"`, `uv = "0.13.6"`), `biome.json` не трогать (Python — ruff)

**Interfaces:**
- `Sbx`/`AsyncSbx(base_url=None, team=None, api_key=None, access_token=None, token_provider=None)` — цепочка §7.6 как в TS; `sbx.sandboxes.create(..., wait=True)`, `.get`, `.list()` (итератор); `Sandbox.wait_until_ready`, `.exec`, `.run` (итератор кадров с reattach), `.start` + `Command.follow`, `.files.read_text/write_text/read_bytes/write_bytes/upload/download`, `.ports.host`, `.delete()`; `SbxError(status, code, message, retryable, details, request_id)`; политика повторов §15.4; генератор с `literal_enums: false`. `package.json` пакета: `"test": "uv run --project . pytest"`, `"lint"` не нужен (ruff внутри `test`: `uv run ruff check . && uv run pytest`).

- [ ] **Step 1: тесты** — тот же сценарий, что задача 17, без `pty` и `uploadDir` (решение 11), и повторы на 503 с тем же `Idempotency-Key`.
- [ ] **Step 2–4.** **Step 5: commit** `sdk-py: generated client and Sbx/AsyncSbx facades`.

### Task 23: документы и финальная проверка

**Files:**
- Modify: `docs/specs/s7-public-api.md` (решение 1: `failFast`/`pool_exhausted`/`warmAvailable` — «фаза 2, вне публичного контракта MVP»; решения 2–13 — короткий раздел «§23. Реализация MVP»), `docs/architecture.md` §9 (только если расходится), `deploy/compose/README.md`, `apps/api/README.md` (как запускать, переменные окружения, интерфейс `AgentApi` и что подключить после S3)

- [ ] **Step 1:** `mise exec -- pnpm install --frozen-lockfile && pnpm -r test && pnpm lint && pnpm build && pnpm -r typecheck` — всё зелёное (вывод в отчёт).
- [ ] **Step 2:** compose smoke задачи 15 заново с нуля (`down -v`, `up -d --build`).
- [ ] **Step 3:** финальное ревью всей ветки свежим субагентом (correctness + security), исправления.
- [ ] **Step 4: commit, push `s7-impl`.**
