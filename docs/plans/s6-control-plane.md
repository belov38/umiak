# S6 Control plane: план реализации

> **Для исполнителей:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (по задаче на субагента, после каждой задачи — ревью свежим субагентом) и superpowers:test-driven-development. Шаги — чекбоксы `- [ ]`.

**Цель:** реализовать S6 по `docs/specs/s6-control-plane.md`: модель данных `runtime` с миграциями, машины состояний, сервисный слой `SandboxService` для S7, `apps/worker` на pg-boss (операции, warm pool, контроллеры), шифрование env и секретов, и локальный стек `deploy/compose`.

**Архитектура:** `packages/db` — раннер SQL-миграций из `db/migrations/`, Drizzle-схема, транзакции, `PgAllocatorStore`, тестовый Postgres. `packages/config` — `ConfigReader` (статический YAML). `packages/core` — доменная логика без HTTP и без Proxmox: состояния, admission, идемпотентность, шифрование, `SandboxService`, приём событий, маршруты; ставит задания pg-boss в своей транзакции. `apps/worker` — обработчики очередей и контроллеры; к Proxmox и агенту ходит только через порты (`NodeInfra`, `AgentPort`, `GatewayPort`), у которых есть фейки для тестов и реальные адаптеры (`@sbx/pve`, HTTP gateway).

**Стек:** Node 26.13.0 (нативный type stripping: TS без сборки, импорты с `.ts`, как `packages/pve`), TypeScript 7 (`tsc --noEmit`), vitest 5, biome 2. Библиотеки (проверено `npm view` 2026-10-29): `pg-boss` 12.38.0, `drizzle-orm` 0.45.4, `pg` 8.23.1 + `@types/pg` 8.23.1, `zod` 4.6.7, `ulid` 3.0.2, `yaml` 2.9.1, `pino` 10.4.0, `prom-client` 15.1.3, `fast-check` 4.10.2 (dev). Postgres 18.6 (`postgres:18.6-alpine`).

**Спецификация:** `docs/specs/s6-control-plane.md` (источник истины; номера § ниже — из неё). Смежные: S1 (`packages/pve`), S2 §5.2, §7, §9.6 и миграция `0100_tunnel_init.sql` из `s2-impl`, S3 §8 и §16, S4 §4.2, S7 §5.3–5.7, §7.5, §8, §20, S8 §17.2, §20.1.

## Глобальные ограничения

- Инструменты только через mise (`mise exec -- <cmd>`). Перед добавлением зависимости перепроверить последнюю стабильную версию.
- Пакеты: `@sbx/db` (`packages/db`), `@sbx/config` (`packages/config`), `@sbx/core` (`packages/core`), `@sbx/worker` (`apps/worker`). Стиль `packages/pve`: `"exports": {".": "./src/index.ts"}`, `tsconfig` с `allowImportingTsExtensions`, `erasableSyntaxOnly`, `noEmit`; скрипты `test` (`vitest run`) и `typecheck`. Сборки нет: процесс запускается `node src/main.ts`.
- `erasableSyntaxOnly`: никаких `enum`, `namespace`, parameter properties. Строковые перечисления — `as const` массивы + union-типы.
- Миграции: `db/migrations/NNNN_<name>.sql`, S6 — **0200–0299**, обычный SQL без `BEGIN/COMMIT` (раннер оборачивает файл в транзакцию). S2 — 0100–0199 (`s2-impl`), S7 — 0300–0399, S8 — 0400–0499.
- Секреты (env, secrets, secretFiles, BS, MT, токены портов) никогда не попадают в логи, `operations.request`, `idempotency_keys.response`, данные заданий pg-boss (только id), метрики. Логгер pino с `redact` по путям `*.env`, `*.secrets`, `*.secretFiles`, `*.bs`, `*.token`, `*.serial`.
- Postgres в тестах: `SBX_TEST_DATABASE_URL`, иначе global setup поднимает `postgres:18.6-alpine` через docker CLI (как в `s2-impl`); `SBX_TEST_SKIP_PG=1` — пропуск, иначе отсутствие Docker — ошибка.
- На `pve` **ничего не запускать**, пока master не разрешит. Правила хоста после разрешения: VMID 500+ (599 — шаблон, не менять), ≤ 8 GB RAM на sandbox VM, `local-lvm`, не трогать VM/LXC < 500, `vmbr0`, шаблоны 9000/9001, без изменений firewall/SDN/хоста, убрать всё за собой.
- S2-код не править. Расхождения контракта S2/S3 — в отчёт master-у.
- Комментарии в коде на английском. Без `Claude-Session:` в коммитах.

## Решения исполнителя (отклонения и уточнения спеки)

1. **`AllocatorStore` в S1 синхронный** — Postgres-реализация так невозможна. В `packages/pve` (S6 §16 разрешает небольшие дополнения): методы `AllocatorStore` возвращают `T | Promise<T>`, методы `Allocator` — async; `VmidLease.ownerId?: string`, `AllocatorStore.findByOwner?(cluster, ownerId)`; `Allocator.allocate(ownerId?)` сначала ищет lease владельца не в `releasing`. `Machines.create/fork` принимают `ownerId`; `Machines.snapshot(vmid, {hook?, id?})` — внешний `QuiesceHook` (S3) и id снапшота; `StorageDriver.snapshot(m, hook, opts?: {id?})`. `apps/bench` и `SqliteStateStore` адаптируются. Фейки `test/fakes.ts` экспортируются как `@sbx/pve/testing`.
2. **Id снапшота в LV.** `sbx-node` принимает id снапшота `[a-z0-9]{1,32}`, поэтому id LV = UUID снапшота без дефисов (`snapshots.id` → 32 hex).
3. **Id генерируются в коде** (`uuidv7()` в `@sbx/core`), а не `DEFAULT uuidv7()`: строка `idempotency_keys` пишется первой в транзакции create и уже должна знать id sandbox и операции. DEFAULT `uuidv7()` в DDL всё равно стоит.
4. **`machines.ready_boot_id text null`** (добавление к §5.4): `boot_id`, на котором агент сообщил фазу `pool_ready`. Шаг `boot` и подготовка пула ждут `ready_boot_id = tunnel_sessions.boot_id` при `state = connected`. Так ожидание не зависит от порядка обработки событий.
5. **`machines.agent_phase text null`, `sandboxes.listening_ports jsonb null`** — последнее состояние фазы и `ports.changed` (S7 §20.2 п. 8 читает его).
6. **Таблица применённых миграций** — `public.sbx_schema_migrations(version int pk, name text, sha256 text, applied_at timestamptz)`; блокировка `pg_advisory_lock(727001)`.
7. **Транзакции** — `withTx(pool, fn)` в `@sbx/db`: `BEGIN` на `PoolClient`, Drizzle поверх того же клиента; pg-boss `send` получает `{db: {executeSql: client.query}}` и пишет задание в ту же транзакцию.
8. **Dead letter.** Обработчик `sandbox-op-dlq`: для `delete` заново ставит задание (`startAfter` 60 s) и метрику `sbx_delete_dead_letter_total` (тревога `sbx_delete_stuck` — gauge в health: delete дольше 30 min); для остальных — `failed`, `retries_exhausted` и компенсация (§15.1).
9. **Principal** — форма S7 §7.5 (`kind`, `userId | null`, `teamId`, `role`, `isOperator`, `apiKeyId?`, `scopes`). Принципал идемпотентности — `apiKeyId ?? userId`. В S6 добавлены колонки S7 §20.2 п. 9: `sandboxes.created_by_key`, `operations.requested_by_key`.
10. **Из S7 §20.2 сделано в S6 сразу** (дёшево и в наших миграциях): п. 7 (`resume`/`recover` при активной операции того же вида возвращают её; `resume` — при совпадении hash тела), п. 12 (`extend(p, id, ttlSeconds?)`), п. 13 (`NOTIFY sbx_operations`), O7 (`NOTIFY sbx_routes` с payload = slug, триггеры на `sandboxes` и `hosted_ports`). Остальное (§20.2 пп. 1–6, 8, 10–11) — S7.
11. **Slug.** Грамматика S4 §4.2 / S7 §5.4 (валидация в core). Если slug не передан, core генерирует три слова из встроенного словаря (~300 слов) с до 5 повторами, затем четыре слова; S7 может заменить словарь на свой (~1500).
12. **Агентский RPC (S3) реального адаптера нет**: `proto/sbx/agent/v1` ещё не существует. `AgentPort` — интерфейс + фейк; реальная реализация на `@sbx/agent-client` появится с S3. До этого worker в compose работает с `UnavailableAgentPort` (каждый вызов — retryable `agent_unavailable`).
13. **События агента.** core принимает уже декодированный JSON (`payload` — объект); protojson и `Any` разбирает S7. Внутренние имена — из S6 §10.2; адаптер имён S3 (`readiness.changed`, `quiesce.auto_thawed`, `identity.reset`, `claim.applied`) — `normalizeAgentEvent` в core. `activity` и `System/Activity` в S3 нет (там `idle.changed{idle, since}`) — открытый вопрос; idle-stop реализован по S6.
14. **Топология и шаблон 599** заводятся `sbx-admin bootstrap` из секции `topology` того же YAML, что `StaticConfigReader`, а не миграцией (данные окружения не место в миграциях).
15. **`ctl-idp-sync`** (S8 §17.2 S6): очередь `exclusive` раз в `SBX_IDP_SYNC_INTERVAL` (300 s) в worker вызывает подключаемый `IdpSync.run()`; логика — `@sbx/payload` (S8). Без реализации контроллер не регистрируется.
17. **Warm pool упрощён (решение Ильи через master, 2026-10-29: холодный create Linux ~12 s, пул в MVP не нужен).** Уже сделанное остаётся: claim из пула и `failFast`/`pool_exhausted` в `SandboxService.create` (Task 7), подготовка machine пула `machine-op provision` (Task 9). Контроллер `ctl-pool` (Task 11, §9.2) **не делается** — фаза 2; шов для него: `machine-op provision` и `pool_key`. Цели пула по умолчанию 0 (`StaticConfigReader` и compose). Основной путь — cold create: матрица падений и сквозные тесты Task 10 и 13 идут по нему; путь claim в Task 10 покрывается одним сценарием без настройки пула.
16. **Схема `tunnel` до слияния S2.** Тестовый хелпер после миграций применяет фикстуру `packages/db/test/fixtures/0100_tunnel_init.sql` (копия файла из `s2-impl`), только если схемы `tunnel` нет. После слияния `main` с S2 фикстура не применяется и удаляется.

## Review Focus

1. **Повтор create после падения между S1 `create` и записью `vmid` в machine.** Lease с `machine_id` есть, VM есть, в machine `vmid` null. Повтор должен найти lease по `machine_id`, удалить VM через S1 `delete`, освободить lease и подготовить заново. Тест — задача 9 (матрица падений подготовки).
2. **Двойная доставка задания и зависший исполнитель.** Два обработчика одной операции: старый на первой записи шага получает 0 строк и выходит, не делая следующих побочных эффектов. Тест — задачи 9 и 10 (fencing).
3. **Гонка admission из нескольких процессов.** 30 параллельных create при лимите на 3 machine: `reserved` и `powered` ни разу не выше лимита. Тест — задача 6 (параллельные транзакции на отдельных соединениях) и задача 13 (два процесса worker).
4. **Delete во время любой операции**, включая fork-цель, ждущую снапшот, и cold create, ждущий RAM. Ожидание: в фейке нет VM, LV, lease; снапшоты `fork_source` удалены; saved snapshots живы. Тест — задача 10.
5. **Утечка секрета.** Ни одно значение env/secrets/secretFiles не встречается в `operations.request`, `idempotency_keys.response`, `pgboss.job.data`, логах worker. Тест — задача 10 (поиск маркерной строки по дампу этих таблиц и захваченным логам).

---

### Task 1: дополнения `packages/pve` (async allocator, ownerId, hook, id снапшота)

**Files:**
- Modify: `packages/pve/src/allocator.ts`, `src/machine.ts`, `src/storage/types.ts`, `src/storage/lvmthin.ts`, `src/state-sqlite.ts`, `package.json` (`exports["./testing"] = "./test/fakes.ts"`)
- Modify: `apps/bench/src/*.ts` (await новых async-методов)
- Test: `packages/pve/test/allocator.test.ts`, `test/machine.test.ts`, `test/lvmthin.test.ts`

**Interfaces:**
- Produces: `AllocatorStore { tryInsert(l): boolean | Promise<boolean>; get(...): VmidLease | undefined | Promise<…>; list(...); setState(...); remove(...); findByOwner?(cluster: number, ownerId: string): VmidLease | undefined | Promise<…> }`; `VmidLease.ownerId?: string`; `Allocator.allocate(ownerId?: string): Promise<{vmid, mac}>`, `markActive/markReleasing/release/ensureTemplate/get/list` — async. `Machines.create(opts: {size?, smbios?, ownerId?})`, `Machines.fork(snap, {size?, smbios?, ownerId?})`, `Machines.snapshot(vmid, {crashConsistent?, hook?: QuiesceHook, id?: string})`. `StorageDriver.snapshot(m, hook, opts?: {id?: string})`.

- [ ] **Step 1: тесты** — `allocate("m1")` дважды возвращает тот же VMID; после `markReleasing` — новый; store с асинхронными методами (обёртка над Map с `await Promise.resolve()`) работает; `Machines.snapshot(vmid, {hook, id: "abc"})` вызывает `hook.freeze/thaw` и создаёт LV `sbx-snap-abc-scsi0`; `snapshot` без `hook` у работающей VM по-прежнему идёт через QGA.
- [ ] **Step 2:** прогнать, убедиться, что падают.
- [ ] **Step 3:** реализовать. `SqliteStateStore` хранит `owner_id` (миграция схемы SQLite: `ALTER TABLE … ADD COLUMN` при отсутствии) и реализует `findByOwner`.
- [ ] **Step 4:** `pnpm --filter @sbx/pve test`, `pnpm --filter @sbx/bench test`, `pnpm -r typecheck`, `pnpm lint` — зелёные.
- [ ] **Step 5:** коммит `pve: async allocator store, lease owner, external quiesce hook and snapshot id (S6 §16)`.

### Task 2: `packages/db` — миграции, схема, транзакции, тестовый Postgres

**Files:**
- Create: `db/migrations/0200_runtime_init.sql`, `db/migrations/0201_runtime_triggers.sql`
- Create: `packages/db/{package.json,tsconfig.json,vitest.config.ts}`, `src/index.ts`, `src/migrate.ts`, `src/tx.ts`, `src/schema/runtime.ts`, `src/schema/tunnel.ts`, `src/testing/{global-setup.ts,database.ts,index.ts}`, `test/fixtures/0100_tunnel_init.sql`
- Test: `packages/db/test/migrate.test.ts`, `test/schema-drift.test.ts`, `test/triggers.test.ts`

**Interfaces:**
- Produces:
  - `migrate(pool: pg.Pool, opts?: {dir?: string; log?: (msg: string) => void}): Promise<{applied: string[]}>` — по номеру, файл в транзакции, advisory-блокировка, sha256; изменённый применённый файл → `MigrationChecksumError`.
  - `missingMigrations(pool, dir?): Promise<string[]>` — известные коду, но не применённые (для readiness; более новые неизвестные допустимы).
  - `MIGRATIONS_DIR` — абсолютный путь к `db/migrations` (через `import.meta.url`), переопределяется `SBX_MIGRATIONS_DIR`.
  - `createPool(url: string, max = 20): pg.Pool`; `type Db = NodePgDatabase<typeof schema>`; `interface Tx { db: Db; client: pg.PoolClient }`; `withTx<T>(pool, fn: (tx: Tx) => Promise<T>): Promise<T>` (rollback при исключении); `dbOf(pool): Db`.
  - `schema` — все таблицы `runtime` (§5.1–5.9, §8.3) и `tunnel` (`gateway_instances`, `tunnel_sessions`, `tunnel_credentials`), camelCase-поля.
  - `@sbx/db/testing`: `globalSetup` (vitest, provide `sbxPgAdminDsn`), `createTestDatabase(): Promise<{url, pool, db, drop()}>` — отдельная БД на файл тестов из шаблона `sbx_tmpl`, который мигрируется один раз (с фикстурой tunnel, решение 16).

DDL (решения поверх §5): все колонки из §5 с `NOT NULL`, где значение всегда есть; `CHECK` на перечисления; FK внутри `runtime`; на `tunnel` FK нет. Дополнительно: `machines.ready_boot_id`, `machines.agent_phase`, `sandboxes.listening_ports`, `sandboxes.created_by_key`, `operations.requested_by_key`, `snapshots.lv_id text` (32 hex). Индексы: `operations(sandbox_id) WHERE state IN ('pending','running')` unique; `machines(node_id, state)`; `machines(pool_key, state)`; `machines(sandbox_id)`; `sandboxes(team_id, created_at desc)`; `agent_events(machine_id) WHERE processed_at IS NULL`; частичные уникальные из §5. `node_clone_slots` из §8.3.

Триггеры (`0201`): запрет смены `machines.sandbox_id` с не-`null`; `NOTIFY sbx_sandboxes '<id>'` при смене `state`/`health`; `NOTIFY sbx_routes '<slug>'` при смене `state`, `machine_id`, `slug` у sandbox (для slug — старый и новый) и любом изменении `hosted_ports`; `NOTIFY sbx_operations '<id>'` при переходе операции в `succeeded|failed|superseded`.

- [ ] **Step 1: тесты** — `migrate` применяет 0200/0201 и второй вызов ничего не делает; изменённый файл → `MigrationChecksumError`; два параллельных `migrate` не падают (блокировка); `missingMigrations` пуст после migrate; drift-тест: для каждой Drizzle-таблицы набор колонок, тип (`information_schema.columns.udt_name`) и nullability совпадают с живой БД; триггер `sandbox_id` отклоняет смену; `LISTEN sbx_routes` получает старый и новый slug при rename; `sbx_sandboxes` — при смене `state`.
- [ ] **Step 2:** прогнать — падают.
- [ ] **Step 3:** реализовать SQL, раннер, схему, хелперы.
- [ ] **Step 4:** `pnpm --filter @sbx/db test`, typecheck, lint.
- [ ] **Step 5:** коммит `db: runtime schema migrations, runner, drizzle schema and test postgres`.

### Task 3: `PgAllocatorStore`

**Files:** Create `packages/db/src/allocator-store.ts`; Test `packages/db/test/allocator-store.test.ts`

**Interfaces:**
- Consumes: Task 1 `AllocatorStore`; Task 2 `vmid_leases`.
- Produces: `class PgAllocatorStore implements AllocatorStore { constructor(pool: pg.Pool, providerId: string) }`. Аргумент `cluster` S1 игнорируется (один store на провайдера). `tryInsert` — `INSERT … ON CONFLICT DO NOTHING`, конфликт по `(provider_id, vmid)`, `mac` или `machine_id` → `false`. `ownerId` ↔ `machine_id`.

- [ ] **Step 1: тесты** — реальный `Allocator` поверх store: два параллельных `allocate()` разных владельцев дают разные VMID; `allocate("m")` дважды — один VMID; 20 параллельных `allocate` из двух пулов соединений — без дублей; `release` удаляет строку; lease шаблона (`purpose = template`) не выдаётся.
- [ ] **Step 2–4:** fail → реализовать → pass (`pnpm --filter @sbx/db test`).
- [ ] **Step 5:** коммит `db: postgres allocator store`.

### Task 4: `packages/config` — `ConfigReader` и `StaticConfigReader`

**Files:** Create `packages/config/{package.json,tsconfig.json,vitest.config.ts}`, `src/index.ts`, `src/types.ts`, `src/static.ts`; Test `packages/config/test/static.test.ts`, fixture `test/fixtures/poc.yaml`

**Interfaces:**
- Produces: типы `TemplateConfig {slug, os: "linux"|"windows", enabled, defaultSize, allowedSizes: string[]}`, `SizeConfig {slug, vcpu, memoryMb}`, `PoolTarget {templateSlug, sizeSlug, providerId?, target, maxAgeHours?}`, `Quota {maxActiveSandboxes, maxRamMb, maxSavedSnapshots}`, `PlatformDefaults {ttlSeconds: number|null, maxTtlSeconds, idleTimeoutSeconds: number|null, stoppedRetentionDays: number|null, errorRetentionDays, recoverMinIntervalSeconds, defaultTemplate}`, `interface ConfigReader` (§5.11). `StaticConfigReader.fromFile(path)`, `StaticConfigReader.fromObject(obj)`; `topology(): TopologyConfig` (решение 14: `providers[{name, clusterMacId, vmidMin, vmidMax, apiUrl, tlsName, secretRef, nodes[{name, ramCapMb, cloneConcurrency, nodeAgentRef, storages[{name, driver, dataMaxPct, metaMaxPct}]}]}]`, `templateBuilds[{templateSlug, version, os, node, storage, pveVmid, bootTimeoutS, agentVersion, diskLayout, hw}]`). Валидация zod; неизвестная команда → `quotas.default`. Дефолты §5.11 и PoC-квота S8 (3, 6144, 10).

- [ ] **Step 1: тесты** — разбор `poc.yaml`; неверный YAML → ошибка с путём поля; `defaultSize ∉ allowedSizes` → ошибка; `teamQuota("unknown")` = default.
- [ ] **Step 2–4:** fail → реализовать → pass.
- [ ] **Step 5:** коммит `config: ConfigReader and static YAML reader`.

### Task 5: `packages/core` — чистые модули

**Files:** Create `packages/core/{package.json,tsconfig.json,vitest.config.ts}`, `src/errors.ts`, `src/ids.ts`, `src/slug.ts`, `src/slug-words.ts`, `src/label.ts`, `src/canonical.ts`, `src/secrets.ts`, `src/states.ts`, `src/principal.ts`, `src/index.ts`; Test `test/{errors,ids,slug,label,canonical,secrets,states}.test.ts`

**Interfaces:**
- Produces:
  - `class SbxError extends Error {code: ErrorCode; retryable: boolean; details: Record<string, unknown>}`; `ErrorCode` — коды §14.1 плюс `slug_taken`, `snapshot_name_taken`, `agent_unavailable`, `retries_exhausted`; фабрики `notFound()`, `invalidState(state)`, `operationInProgress(op)`, `outOfCapacity(retryAfterSeconds)`, `poolExhausted(retryAfterSeconds)`, `quotaExceeded(quota, limit, current)`, `validation(issues)`.
  - `uuidv7(): string`; `uuidv5(name: string, namespace = SBX_NAMESPACE): string`; `stepRequestId(operationId, step): string` (UUIDv5 от `"<operationId>:<step>"`, §7.1 п. 4).
  - `validateSlug(s): void` (S4 §4.2: `[a-z0-9]+(-[a-z0-9]+)*`, 3–40, не `-<цифры>` в конце, не зарезервированный суффикс `-desktop`, не из `api, app, www, ssh, tunnel, admin, static, sbx`); `generateSlug(words = 3, rnd?): string`; `RESERVED_SLUG_SUFFIXES`, `RESERVED_SLUGS`.
  - `parseLabel(label): {slug, port} | null`; `portLabel(slug, port)`.
  - `canonicalJson(v): string` (ключи отсортированы, `undefined` выброшен), `requestHash(scope, body): Buffer` (sha256 от `scope + "\n" + canonicalJson(body)`).
  - `interface SecretSets {env: Record<string,string>; secrets: Record<string,string>; secretFiles: SecretFile[]}`, `SecretFile {name, contentBase64, mode?, linkPath?}`, `SecretPatch {env?: Record<string,string|null>; secrets?: …; secretFiles?: Record<string, Omit<SecretFile,"name"> | null>}`; `applySecretPatch(base, patch): SecretSets`; `validateSecretSets(s): void` (лимиты S7 §8.3, `SBX_` кроме `SBX_API_KEY|SBX_API_URL|SBX_TEAM|SBX_PROFILE`); `class KeyRing {static fromFile(path); static fromObject({current, keys}); encrypt(sandboxId, sets): {keyVersion, nonce, ciphertext}; decrypt(sandboxId, row): SecretSets; currentVersion}` — AES-256-GCM, nonce 12 байт, тег в конце ciphertext, AAD `sandbox:<id>:v<ver>`; `encryptFor(aadPrefix, id, …)` для environments S8.
  - `states.ts`: `SANDBOX_STATES`, `MACHINE_STATES`, `OPERATION_STATES`, типы; `sandboxNext(from: SandboxState, ev: SandboxEvent): SandboxState` (бросает `invalid_state`), `machineNext(from, ev)`, `operationNext(from, ev)`; события — имена строк таблицы §6.1 (`create`, `create_done`, `create_failed`, `stop`, `stop_done`, `stop_failed`, `unexpected_stop_first`, `unexpected_stop_repeat`, `resume`, `resume_done`, `resume_failed`, `recover`, `delete`, `delete_done`, `machine_lost`) с условиями (`resume` из `error` только при `machineState = stopped`; `recover` из `error` при machine не `failed|deleting|deleted`); `RESERVED_MACHINE_STATES`, `POWERED_MACHINE_STATES` (§8.1).
  - `Principal` (S7 §7.5), `idempotencyPrincipal(p): string`.

- [ ] **Step 1: тесты** — по каждой таблице переходов: все разрешённые пары дают нужное состояние, все прочие пары `(state, event)` → `invalid_state`; property-тест fast-check: случайные последовательности событий из `ready` никогда не выводят из `deleted`, `deleted` терминально; `machine.sandbox_id`-инвариант «из `claiming` назад в `warm` нельзя»; slug: `quiet-otter-lamp` ок, `ab`, `a--b`, `box-123`, `x-desktop`, `api`, 41 символ — ошибка, `generateSlug()` проходит `validateSlug` 1000 раз; `parseLabel("my-box-5173")` = `{slug:"my-box", port:5173}`, `"box-0"`/`"box-65536"` → null; шифрование: roundtrip; другая AAD (чужой sandbox) → ошибка; ротация: запись под v1 читается при current=2; `applySecretPatch` с `null` удаляет ключ, файл по имени заменяется; 101 переменная, `SBX_FOO`, 33-й файл → `validation`; `canonicalJson({b:1,a:{d:1,c:2}})` = `{"a":{"c":2,"d":1},"b":1}`; `stepRequestId` детерминирован и отличается для разных шагов.
- [ ] **Step 2–4:** fail → реализовать → pass.
- [ ] **Step 5:** коммит `core: errors, ids, slug, secrets crypto, state machines`.

### Task 6: `packages/core` — ёмкость, квоты, слоты, размещение

**Files:** Create `packages/core/src/capacity.ts`, `src/clone-slots.ts`, `src/placement.ts`, `src/locks.ts`; Test `test/capacity.test.ts`, `test/clone-slots.test.ts`, `test/placement.test.ts`

**Interfaces:**
- Consumes: Task 2 `withTx`, `Tx`; Task 5 errors.
- Produces:
  - `lockTeam(tx, teamId)`, `lockNode(tx, nodeId)` — `pg_advisory_xact_lock(hashtextextended('team:'||id, 0))` / `'node:'`; порядок всегда команда → нода.
  - `nodeRam(tx, nodeId): Promise<{capMb, reservedMb, poweredMb}>` — ровно определения §8.1.
  - `admit(tx, {nodeId, needMb, pairKey: string | null, evict: boolean}): Promise<{ok: true; evicted: string[]} | {ok: false}>` — §8.2; вытесняемые machine (`warm`, `pool_key <> pairKey`, старые первыми) → `deleting` + задание `machine-op {machineId, action: "delete"}` через `JobSender` (Task 7 `jobs`; до него — параметр `onEvict(machineIds)`).
  - `tryPoweredStart(tx, {machineId, toState: "booting" | "starting"}): Promise<boolean>` — под `lockNode`: `powered + need ≤ cap` → переход machine (условный `UPDATE … WHERE state = ANY(from)`) и `true`.
  - `checkQuota(tx, teamId, quota, {addSandboxes, addRamMb}): void` — `quota_exceeded`.
  - `acquireCloneSlot(pool, nodeId, holder, ttlMs = 120_000): Promise<number | null>`, `releaseCloneSlot(pool, nodeId, slot, holder)`, `ensureCloneSlots(tx, nodeId, n)`.
  - `place(tx, {templateSlug, needMb}): Promise<{nodeId, storageId, templateBuildId}[]>` — кандидаты §8.4 в порядке убывания свободной RAM.

- [ ] **Step 1: тесты** — `reserved/powered` для каждой комбинации состояний (таблица §8.1, включая `stopped` с активным resume и `failed` с `power_observed = running`); `admit` без вытеснения отказывает при нехватке; с вытеснением выбирает warm других пар, старые первыми, свою пару не трогает; **конкурентность**: 30 параллельных транзакций (каждая на своём соединении: `lockNode` → `admit` → insert machine `allocating` 2048 MB) при cap 6144 → ровно 3 успеха, после каждой транзакции `reserved ≤ cap`; `tryPoweredStart` не превышает cap при 10 параллельных; квота: 4-я sandbox при `maxActiveSandboxes = 3` → `quota_exceeded`; слоты: 5 параллельных захватов при `clone_concurrency = 4` → 4 слота и `null`; просроченный слот захватывается снова.
- [ ] **Step 2–4:** fail → реализовать → pass.
- [ ] **Step 5:** коммит `core: RAM admission, quotas, clone slots, placement`.

### Task 7: `SandboxService` — create, delete, чтение; задания; идемпотентность

**Files:** Create `packages/core/src/jobs.ts`, `src/queues.ts`, `src/idempotency.ts`, `src/rows.ts` (маппинг строк в доменные типы), `src/notifier.ts`, `src/service/index.ts`, `src/service/create.ts`, `src/service/delete.ts`, `src/service/read.ts`, `src/deadlines.ts`; Test `test/service-create.test.ts`, `test/service-delete.test.ts`, `test/service-read.test.ts`, `test/idempotency.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 4, 5, 6.
- Produces:
  - `QUEUES` — имена и опции §15.1 (`sandbox-op`, `sandbox-op-dlq`, `machine-op`, `snapshot-op`, `machine-events`, `ctl-pool`, `ctl-health`, `ctl-autostop`, `ctl-reconcile`, `ctl-cleanup`, `ctl-idp-sync`); `ensureQueues(boss: PgBoss)`.
  - `interface JobSender { send(tx: Tx, queue: QueueName, data: Record<string, unknown>, opts?: {singletonKey?: string; startAfter?: number}): Promise<void> }`; `PgBossJobSender(boss)` (транзакционный `send` через `db`); `RecordingJobSender` для тестов (`sent: {queue, data, opts}[]`).
  - `Notifier` — одно LISTEN-соединение, `subscribe(channel, fn): () => void`, переподключение.
  - `operationDeadline(kind, os, {fromPool}): number | null` (ms; §7.9).
  - `class SandboxServiceImpl implements SandboxService` — `constructor(deps: {pool; config: ConfigReader; keys: KeyRing; jobs: JobSender; notifier?: Notifier})`. Интерфейс §14.1 с `Principal` S7 §7.5 и `extend(p, id, ttlSeconds?)`. Доменные типы `Sandbox`, `Operation`, `SavedSnapshot`, `Command`, `HostedPort`, `Page<T> {data, nextCursor: string | null}` — camelCase-поля строк (`rows.ts`). Входы: `CreateInput {template?, size?, name?, slug?, labels?, env?, secrets?, secretFiles?: SecretFile[], ttlSeconds?, idleTimeoutSeconds?, from?: {snapshot: string}, failFast?}`.
  - `create` (§7.3): шаблон и размер из `ConfigReader` (`template_unavailable`), квота, `place`, claim (§9.5 SQL) → иначе cold (`admit` с вытеснением) → иначе `out_of_capacity` (`retryAfterSeconds: 30`); `failFast`: только claim, иначе `pool_exhausted` (`retryAfterSeconds: 60`) с откатом всего; `failFast` + `from` → `validation`; `from` — saved snapshot команды в `ready` (`snapshot_not_found`), нода снапшота, всегда cold. В одной транзакции: `idempotency_keys` (первым), sandbox `creating`, `sandbox_secrets`, machine (`claiming` или `allocating`), операция `create` (`pending`, `request` без секретов, `deadline_at`), `sandbox_events`, задание `sandbox-op {operationId}` с `singletonKey = sandboxId`. Коллизия slug: сгенерированный — повтор (до 5 → 4 слова), переданный — `slug_taken`.
  - `delete` (§7.2): любое кроме `deleting/deleted` (там — текущая операция delete); активная → `superseded`, `superseded_by`; sandbox → `deleting`; операция `delete` без дедлайна; задание.
  - `get`, `list(p, {state?: SandboxState[], labels?: Record<string,string>, template?, q?, limit?}, cursor?)` (новые первыми, курсор base64url `{c: createdAt, id}`, `deleted` только при явном фильтре), `update`, `extend`, `getOperation`, `waitForState`. Чужая команда → `not_found`.

- [ ] **Step 1: тесты** (реальный Postgres, `RecordingJobSender`, `StaticConfigReader`) — create при наличии `warm` machine пары → machine `claiming`, `sandbox_id`, `pool_key` null, задание одно, `data = {operationId}`; без warm → machine `allocating` с `sandbox_id`; RAM нет → `out_of_capacity` и в БД ничего нового; вытеснение warm другой пары → она `deleting` и задание `machine-op delete`; `failFast` без warm → `pool_exhausted`, нет строк sandbox/секретов/операции/ключа и заданий; `failFast` + `from` → `validation`; квота; выключенный шаблон и неразрешённый размер → `template_unavailable`; идемпотентность: тот же ключ и тело → та же sandbox и операция; другое тело → `idempotency_key_reused`; два параллельных create с одним ключом → одна sandbox; `operations.request` и `idempotency_keys.response` не содержат маркер секрета; delete во время `create` → create `superseded`, sandbox `deleting`, задание delete; повторный delete → та же операция; list фильтры и курсор; чужая команда → `not_found`.
- [ ] **Step 2–4:** fail → реализовать → pass.
- [ ] **Step 5:** коммит `core: SandboxService create, delete, reads, idempotency and jobs`.

### Task 8: `SandboxService` — stop, resume, fork, recover, снапшоты, команды, порты, события, маршруты

**Files:** Create `packages/core/src/service/{lifecycle.ts,fork.ts,snapshots.ts,commands.ts,ports.ts}`, `src/events/ingest.ts`, `src/events/normalize.ts`, `src/routes.ts`; Test `test/service-lifecycle.test.ts`, `test/service-fork.test.ts`, `test/service-snapshots.test.ts`, `test/service-commands-ports.test.ts`, `test/events-ingest.test.ts`, `test/routes.test.ts`

**Interfaces:**
- Consumes: Task 7 (`SandboxServiceImpl`, `JobSender`, `QUEUES`, `rows`).
- Produces:
  - `stop` (§7.5; при активном `stop` — он же), `resume(p, id, {size?, ttlSeconds?, env?, secrets?, secretFiles?: SecretPatch})` (§7.6: состояние, квота, `admit` на ноде sandbox с RAM нового размера, наложение секретов в той же транзакции; `request = {size, ttlSeconds, bodyHash}`; активный resume с тем же hash → он же), `recover` (§7.8, `recover_rate_limited` по `last_recover_at` и `recoverMinIntervalSeconds`; активный recover → он же), `fork(p, id, ForkInput, idemKey?)` → `{sandbox, operation, sourceOperation}` (§7.7: цель `creating`, секреты источника + патч, AAD цели, machine цели `allocating` на ноде источника, `admit` с вытеснением, fork-операция на источнике `pending` с заданием, create цели `pending` без задания с `parent_operation_id`; наследование `template_slug`, `size`, `labels`, `exclude_owner_secrets`), `saveSnapshot(p, id, name, idemKey?)`, `deleteSavedSnapshot`, `listSavedSnapshots`.
  - `resolveAgentTarget` (`sandbox_not_ready`, если не `ready`; capabilities из `tunnel_sessions`), `createCommand` (ULID, `starting`, первые 64 KiB `cmd`, `env_keys`), `completeCommand` (терминальный не перезаписывается), `touchApiActivity` (`UPDATE … WHERE last_api_call_at IS NULL OR < now() - 30 s`), `hostPort(p, id, port, mode)` (порт 22 и зарезервированные → `validation`; `token` → `sbxp_` + 32 байта base64url, хранится sha256), `unhostPort`, `rotatePortToken` (`auth_epoch + 1`).
  - `normalizeAgentEvent(e): AgentEvent | null` (решение 13), `ingestAgentEvents(pool, jobs, batch: {machineId, events: {seq, bootId, type, time, payload}[], synthetic: {epoch, type, instanceId, time}[]}): Promise<{ackedSeq: number | null}>` — §10.1, задание `machine-events {machineId}` (`singletonKey = machineId`).
  - `routes.lookup(label)` → `{sandboxId, slug, machineId, port, mode, tokenHash, authEpoch, state} | null`; `sshTarget(sandboxIdOrSlug)` → `{sandboxId, machineId, state} | null`.

- [ ] **Step 1: тесты** — stop из `ready` → `stopping` и операция; второй stop → та же операция; resume из `stopped`, из `error` с machine `stopped`, из `error` с machine `failed` → `invalid_state`; resume с `env {A: null, B: "2"}` сохраняет слитый блоб в той же транзакции, что и операция; при `out_of_capacity` транзакция откатывается целиком и блоб прежний («результат остаётся, даже если resume не удался» относится к ошибке исполнения в worker); повтор resume с тем же телом → та же операция, с другим → `operation_in_progress`; fork: цель `creating`, её секреты = источник ⊕ патч (расшифровка ключом цели), источник не изменился; fork-операция с заданием, create цели без задания; fork источника в `stopping` → `invalid_state`; recover чаще 600 s → `recover_rate_limited`; saveSnapshot при `maxSavedSnapshots` → `quota_exceeded`; deleteSavedSnapshot → снапшот `deleting`, имя свободно, задание `snapshot-op`; ingest: дубль seq не вставляется, `ackedSeq` = max, одно задание `machine-events`; синтетические дедуплицируются по `(machineId, epoch, type)`; `routes.lookup("my-box-5173")`; createCommand/completeCommand; hostPort token хранит только hash.
- [ ] **Step 2–4:** fail → реализовать → pass.
- [ ] **Step 5:** коммит `core: lifecycle, fork, snapshots, commands, ports, agent events, routes`.

### Task 9: `apps/worker` — порты, фейки, движок шагов, подготовка machine, `machine-op`, `snapshot-op`

**Files:** Create `apps/worker/{package.json,tsconfig.json,vitest.config.ts}`, `src/ports.ts`, `src/context.ts`, `src/steps.ts`, `src/machine-prep.ts`, `src/handlers/machine-op.ts`, `src/handlers/snapshot-op.ts`, `src/wait.ts`; `test/fakes/{infra.ts,agent.ts,gateway.ts,crash.ts,world.ts}`; Test `test/machine-prep.test.ts`, `test/machine-op.test.ts`, `test/snapshot-op.test.ts`, `test/fencing.test.ts`

**Interfaces:**
- Consumes: Tasks 1–8.
- Produces:
  - `ports.ts`:
    - `interface NodeInfra { create(p: {machineId; templateVmid: number; size: {vcpu; memoryMb}; smbios: {uuid; serial}}): Promise<{vmid; mac; disks: InfraDisk[]}>; fork(p: {machineId; snapshot: InfraSnapshotRef; size?; smbios}): Promise<…>; start(vmid); shutdown(vmid, timeoutS): Promise<"stopped" | "timeout">; stop(vmid); status(vmid): Promise<"running" | "stopped" | "paused" | "missing">; configure(vmid, {vcpu, memoryMb}); delete(vmid): Promise<void>; leaseOf(machineId): Promise<{vmid; mac} | undefined>; snapshot(vmid, {lvId: string; hook?: QuiesceHook}): Promise<{disks: InfraDisk[]; hw: Record<string,string>; consistency: "quiesced" | "powered_off"}>; deleteSnapshot(ref: InfraSnapshotRef): Promise<void>; listVms(): Promise<{vmid; status; pool?; tags: string[]}[]>; listLvs(): Promise<{name; tags: string[]}[]>; removeLvs(names: string[]); qgaPing(vmid): Promise<boolean>; qgaExec(vmid, argv: string[]): Promise<{exitCode}>; vmidRange: {min; max}; templateVmids: number[] }`; `InfraDisk {slot, volume, sizeBytes?, options}`; `InfraSnapshotRef {lvId, sourceVmid, disks, hw}`.
    - `interface InfraRegistry { forNode(nodeId: string): Promise<NodeInfra> }`.
    - `interface AgentPort { claim(machineId, req: ClaimRequest, requestId): Promise<void>; updateEnv(machineId, env, requestId); updateSecrets(machineId, {secretEnv, secretFiles}, requestId); prepareStop(machineId): Promise<void>; quiesceHook(machineId, leaseMs): QuiesceHook; activity(machineId): Promise<{runningCommands; openPtys; tcpStreams}> }` (перезапуск агента — `NodeInfra.qgaExec`); ошибки: `AgentUnavailable` (retryable), `AgentRejected` (permanent).
    - `interface GatewayPort { rotateToken(machineId): Promise<void> }`.
  - `context.ts`: `interface WorkerCtx { pool; db; jobs: JobSender; config: ConfigReader; keys: KeyRing; infra: InfraRegistry; agent: AgentPort; gateway: GatewayPort; timing: Timing; log: pino.Logger; metrics: Metrics }`; `Timing {pollMs: 1000; supersedeCheckMs: 2000; ramWaitPollMs: 1000; agentConnectTimeoutMs?: …}` — тесты подставляют миллисекунды.
  - `steps.ts`: `class Fenced { static begin(ctx, operationId): Promise<Fenced | null> }` (`pending → running`, `attempt + 1`; терминальная → `null`; родитель не `succeeded` → `null` либо `failed fork_failed`), `recordStep(step, progress?)` (0 строк → `throw new FencedOut()`), `check()` (перечитать: `superseded` или чужой `attempt` → `FencedOut`), `finish(state, error?)`; `runSteps(fenced, steps: {name; skipIf?; run}[])`; `class MachineFence` — то же для `machines.exec_attempt`.
  - `waitUntil(ctx, fence, cond: () => Promise<T | undefined>, {timeoutMs, pollMs}): Promise<T>` — проверяет `fence.check()` раз в `supersedeCheckMs`.
  - `machine-prep.ts`: `prepareMachine(ctx, fence, machineId, source: {kind: "template"} | {kind: "snapshot"; snapshotId}): Promise<void>` — §7.4 целиком (повтор из `provisioning`: `leaseOf(machineId)` → `delete(vmid)`; новый BS 32 байта → `tunnel.tunnel_credentials` upsert `bs_hash = sha256(bs)`, `retired_at = null`; слот клонирования; `create/fork` со `smbios {uuid: machineId, serial: s2SerialPayload(machineId, bs)}`; запись `vmid`, `mac`, `disks`; `tryPoweredStart` с ожиданием; `start`). `waitBooted(ctx, fence, machineId, timeoutMs)` — `ready_boot_id = tunnel_sessions.boot_id` и `connected`.
  - `handlers/machine-op.ts`: `handleMachineOp(ctx, {machineId, action: "provision" | "delete"})` — provision §9.3 (ошибка/тайм-аут → `failed → deleting` + задание delete); delete: `retired_at`, `stop` и `power_observed = stopped`, S1 `delete`, `disks.state = deleted`, machine `deleted`, lease освобождён.
  - `handlers/snapshot-op.ts`: `handleSnapshotOp(ctx, {snapshotId, action: "delete"})` — §7.8 (ждёт creates из снапшота до шага `provision`: бросает retryable `SnapshotInUse` с `startAfter` 30 s).
  - Фейки: `FakeInfra` (in-memory VM и LV на ноду; VMID через реальный `Allocator` + `PgAllocatorStore`; `start` «загружает» VM: через `FakeAgentWorld` вставляет/обновляет `tunnel_sessions` с новым `boot_id` и вызывает `ingestAgentEvents` с `connected` и `phase pool_ready`); `FakeAgent` (запись вызовов, настраиваемые ответы: отказ claim, недоступность, счётчики activity); `FakeGateway`; `crashAfter(target, method, nth)` — прокси, который после n-го успешного вызова метода бросает `SimulatedCrash` (имитация гибели пода после побочного эффекта).

- [ ] **Step 1: тесты** — подготовка из шаблона: machine `booting` → (событие) → `warm`, в фейке одна VM и active lease; **матрица падений подготовки**: `crashAfter` для каждого из `create`, `start` и после записи `booting`; повтор `handleMachineOp` доводит до `warm`, в фейке ровно одна VM, нет лишних LV и lease; BS повтора отличается, после `booting` не меняется; тайм-аут загрузки → machine `deleting` → `deleted`, VM и lease нет; **fencing**: исполнитель A блокируется внутри `create` (deferred), B стартует (attempt+1) и доводит до конца, A после разблокировки получает `FencedOut` на записи шага и не вызывает `start`; в фейке одна VM; delete machine: `retired_at` выставлен до `stop`; snapshot-op ждёт create из снапшота до шага provision.
- [ ] **Step 2–4:** fail → реализовать → pass.
- [ ] **Step 5:** коммит `worker: ports, fakes, fenced step engine, machine preparation and machine/snapshot ops`.

### Task 10: `sandbox-op` — create, delete, stop, resume, recover, reprovision, fork, save_snapshot

**Files:** Create `apps/worker/src/handlers/sandbox-op.ts`, `src/ops/{create.ts,delete.ts,stop.ts,resume.ts,recover.ts,reprovision.ts,fork.ts,save-snapshot.ts,compensate.ts,claim.ts}`, `src/handlers/dlq.ts`; Test `test/ops-create.test.ts`, `test/ops-delete.test.ts`, `test/ops-stop-resume.test.ts`, `test/ops-fork.test.ts`, `test/ops-snapshot.test.ts`, `test/crash-matrix.test.ts`, `test/secret-leak.test.ts`

**Interfaces:**
- Consumes: Task 9 (`Fenced`, `runSteps`, `prepareMachine`, `waitBooted`, порты), Tasks 7–8.
- Produces: `handleSandboxOp(ctx, {operationId}): Promise<void>` — диспетчер по `kind`; дедлайн истёк → `compensate(kind)` и `failed`; временная ошибка → исключение (pg-boss повторит); постоянная → компенсация, `failed`. `handleSandboxOpDeadLetter(ctx, {operationId})` (решение 8). Шаги и проверки «уже сделано» — ровно таблицы §7.3, §7.5, §7.6, §7.7, §7.8, §7.2; `requestId` агенту — `stepRequestId(operationId, step)`; `ClaimRequest {reason, sandboxId, hostname: "sbx-" + slug, env, secretEnv, secretFiles, authorizedKeys: []}`. Повтор claim из пула после отказа агента — один раз (`progress.claimRetried`), с `failFast` — только warm. Fork-цель после `finish` — `cleanup_source`. Снапшот fork/save: строка `snapshots` `creating` до вызова S1, `lv_id` = id без дефисов, `quiesce_broken` после thaw → `quiesce_failed`.

- [ ] **Step 1: тесты** (фейки Task 9, обработчик вызывается напрямую) — create из пула: `rotate_token` → `claim` → `finish`, sandbox `ready`, machine `running`, `provisioned_boot_id`; cold create; create из saved snapshot; claim отклонён агентом → machine `deleting`, повтор с другой warm, второй отказ → `error create_failed`; stop: `prepare` best effort (агент недоступен — всё равно `stopped`), команды `running` → `lost`; resume: секреты доставлены `updateEnv` + `updateSecrets`, `provisioned_boot_id` = новый boot; resume с `size` → `configure`; ошибка resume → machine `stopped`, sandbox `error resume_failed`; recover: `stop`+`start`; reprovision; fork работающей: `quiesceHook` агента вызван, цель `ready`, снапшот удалён `cleanup_source`; fork выключенной → `powered_off`; `quiesce_broken` → fork `failed`, цель `error fork_failed`; delete во время fork-цели, ждущей родителя → снапшот удалён родителем; save_snapshot заменяет одноимённый; **матрица падений**: для каждой операции и каждого шага `crashAfter` на побочном эффекте шага, затем повтор — итог тот же, что без падения, в фейке нет лишних VM/LV/lease; **delete во время** create (claim и cold), resume, fork — всё убрано; дедлайн истёк → компенсация; DLQ create → `failed retries_exhausted`, machine удаляется; **утечка секрета**: маркер секрета отсутствует в `operations`, `idempotency_keys`, `pgboss.job`, захваченных логах.
- [ ] **Step 2–4:** fail → реализовать → pass.
- [ ] **Step 5:** коммит `worker: sandbox operations with compensation and crash matrix`.

### Task 11: `machine-events` и контроллеры pool, health, autostop, cleanup, idp-sync

**Files:** Create `apps/worker/src/handlers/machine-events.ts`, `src/controllers/{pool.ts,health.ts,autostop.ts,cleanup.ts,idp-sync.ts,index.ts}`; Test `test/machine-events.test.ts`, `test/ctl-pool.test.ts`, `test/ctl-health.test.ts`, `test/ctl-autostop.test.ts`, `test/ctl-cleanup.test.ts`

**Interfaces:**
- Consumes: Tasks 7–10.
- Produces: `handleMachineEvents(ctx, {machineId})` — таблица §10.2 (агентские по `seq`, синтетические по `time`, затем `processed_at`); `phase pool_ready` → `ready_boot_id`, `agent_phase`, machine пула `booting → warm`, `warm_at`. `runPool(ctx)` (§9.2 пп. 1–5, provision через задание `machine-op`), `runHealth(ctx)` (§11.1), `runAutostop(ctx)` (§12, живая проверка `agent.activity`), `runCleanup(ctx)` (§15.4, включая перешифровку секретов старой версией ключа), `runIdpSync(ctx, sync: IdpSync)`; `interface IdpSync { run(): Promise<void> }`. `CONTROLLERS` — `{queue, intervalMs, run}`; самоперепостановка `startAfter` и cron раз в минуту — в Task 13.

- [ ] **Step 1: тесты** — события: дубли и перестановки не меняют итог; `rebooted` → команды прошлого boot `lost`, reprovision ставится при `boot_id ≠ provisioned_boot_id` и без активной операции, не ставится для уже провиженного `boot_id`; `connected` снимает `degraded`; `quiesce.watchdog_thawed` → `quiesce_broken` у снапшота в `creating`; пул: заполнение до target, лишние warm → `deleting`, новая active-сборка → замена старых (при нехватке RAM — сначала удалить старую), warm с агентом, отключённым > 60 s → `deleting`, без RAM — ничего; health: disconnected > 60 s → `degraded` (+ `health_reason` по QGA и статусу VM), через 2 min — один `qgaExec` перезапуска не чаще раза в 10 min; autostop: idle не срабатывает при `runningCommands > 0`, `openPtys > 0`, `tcpStreams > 0`, свежем `last_api_call_at`, устаревшем `activity`, недоступном агенте, ненулевой живой проверке; срабатывает при всех нулях; TTL срабатывает всегда; cleanup: просроченные ключи, события > 7 дней, надгробия > 30 дней, `fork_source` > 1 h, перешифровка v1 → v2.
- [ ] **Step 2–4:** fail → реализовать → pass.
- [ ] **Step 5:** коммит `worker: agent events processing and pool, health, autostop, cleanup controllers`.

### Task 12: контроллер `reconcile`

**Files:** Create `apps/worker/src/controllers/reconcile.ts`; Test `test/ctl-reconcile.test.ts`

**Interfaces:**
- Produces: `runReconcile(ctx, {dryRun: boolean}): Promise<ReconcileAction[]>` — таблица §11.2 и §11.3; `ReconcileAction {kind: "orphan_vm" | "orphan_lv" | "machine_lost" | "unexpected_stop" | "power_drift" | "lease_release" | "retire_again" | "requeue_op"; target; applied: boolean}`. Защиты: только VM с pool `sandbox` и тегом `sbx`, VMID в диапазоне провайдера, не шаблон; LV только с тегом `sbx`; grace 10 min.

- [ ] **Step 1: тесты** — сирота VM (старше grace) удаляется, моложе — нет; VM вне pool и LV без тега не трогаются; lease `releasing` добирается; machine `running` + VM `stopped` → первый раз системный resume (`requested_by` null), второй раз за час → sandbox `stopped unexpected_shutdown`; machine без VM → `failed`, sandbox `error machine_lost`; machine `stopped` + VM `running` → `shutdown`; зависшая операция без задания → задание снова; `dryRun` ничего не меняет и возвращает те же действия.
- [ ] **Step 2–4:** fail → реализовать → pass.
- [ ] **Step 5:** коммит `worker: reconcile controller with dry run`.

### Task 13: реальные адаптеры, процесс worker, `sbx-admin`, сквозные тесты pg-boss

**Files:** Create `apps/worker/src/adapters/{pve-infra.ts,gateway-http.ts,agent-unavailable.ts}`, `src/main.ts`, `src/boss.ts`, `src/http.ts` (`/healthz`, `/readyz`, `/metrics`), `src/metrics.ts`, `src/log.ts`, `src/env.ts`, `src/admin/{main.ts,commands.ts}`; Test `test/pve-infra.test.ts`, `test/boss-e2e.test.ts`, `test/admin.test.ts`

**Interfaces:**
- Produces:
  - `PveInfraRegistry(pool, {secretsDir, env})` — по `providers`/`nodes` строит `Machines` из `@sbx/pve` (`PveApi`, `SshNodeOps`, `LvmThinDriver`, `Allocator` с `PgAllocatorStore`, in-memory `SnapshotStore`) на ноду; `NodeInfra` поверх. Файлы секретов: `secret_ref` → каталог с `pve-token`, `pve-root-ca.pem`, `sbx-node_ed25519`, `known_hosts` (как `~/.config/sbx/`).
  - `HttpGatewayPort(pool, serviceToken)` — `POST <internal_url>/v1/machines/{id}/rotate-token` (instance из `tunnel_sessions` ⨝ `gateway_instances`).
  - `startWorker(env): Promise<{stop(): Promise<void>}>` — миграции при старте (`SBX_MIGRATE_ON_START`, по умолчанию `1`), `PgBoss` на общем `pg.Pool` (20), `ensureQueues`, `work` с `localConcurrency` §15.2, контроллеры (`exclusive`, самоперепостановка `startAfter`, `schedule` раз в минуту), `SIGTERM` → `boss.stop({graceful: true, timeout: 60_000})`. Env: `DATABASE_URL`, `SBX_CONFIG_FILE`, `SBX_DATA_KEYS_FILE`, `SBX_SECRETS_DIR`, `SBX_GATEWAY_SERVICE_TOKEN_FILE`, `SBX_RECONCILE_DRY_RUN` (по умолчанию `1`), `SBX_HTTP_PORT` (9090), `SBX_IDP_SYNC_INTERVAL`, `SBX_LOG_LEVEL`.
  - Метрики §20 (prom-client): `sbx_pool_machines{pair,state}`, `sbx_operation_duration_seconds{kind,outcome}`, `sbx_operation_errors_total{kind,code}`, `sbx_node_ram_mb{node,kind}`, `sbx_reconcile_actions_total{kind,applied}`, `sbx_degraded_sandboxes`, `sbx_queue_depth{queue}`, `sbx_event_lag_seconds`, `sbx_delete_stuck`, `sbx_unexpected_identity_change_total`, `sbx_quiesce_watchdog_thawed_total`.
  - `sbx-admin` (`node src/admin/main.ts`): `bootstrap` (топология и сборки из YAML, идемпотентно), `providers add`, `nodes add|cordon|uncordon`, `template register|promote`, `pool status`, `reconcile --dry-run`, `op retry <id>`, `machine delete <id>`, `migrate`.

- [ ] **Step 1: тесты** — `pve-infra` поверх `@sbx/pve/testing` (`FakePve`, `FakeNode`): create/start/status/snapshot/delete проходят и lease в Postgres; `boss-e2e`: два экземпляра `startWorker` (фейковые порты через параметр) на одной БД, 10 create + delete доходят до конца, двойная доставка (ручной `boss.send` того же `operationId`) безвредна, контроллер `exclusive` не исполняется параллельно; убийство экземпляра посреди операции (`stop` без graceful) — второй доводит после истечения heartbeat (heartbeat 10 s в тесте); `sbx-admin bootstrap` дважды — без дублей; `/readyz` 503 до миграций.
- [ ] **Step 2–4:** fail → реализовать → pass.
- [ ] **Step 5:** коммит `worker: process wiring, pve and gateway adapters, sbx-admin, pg-boss e2e`.

### Task 14: `deploy/compose`

**Files:** Create `deploy/compose/compose.yaml`, `deploy/compose/README.md`, `deploy/compose/config/sbx.yaml`, `deploy/compose/config/data-keys.example.json`, `apps/worker/Dockerfile`, `.dockerignore`

**Interfaces:**
- Produces: сервисы `postgres` (`postgres:18.6-alpine`, volume, healthcheck), `migrate` (образ worker, `sbx-admin migrate && sbx-admin bootstrap`, `restart: "no"`), `worker` (`depends_on: migrate: service_completed_successfully`). Образ worker: `node:26.13.0-*-slim`, `pnpm install --frozen-lockfile --prod --filter @sbx/worker...`, `CMD ["node", "apps/worker/src/main.ts"]`. Конфиг pve: `~/.config/sbx` монтируется read-only в `/run/secrets/sbx` (`SBX_SECRETS_DIR`). Ключи данных: `deploy/compose/secrets/data-keys.json` создаётся командой из README (`openssl rand -base64 32`), каталог `secrets/` в `.gitignore`. Цель пула в `sbx.yaml` — `0` по умолчанию (не создавать VM на `pve` без явного решения), `SBX_RECONCILE_DRY_RUN=1`. Общая сеть и `x-` якоря для будущих `api`, `gateway`, `web`, `keycloak`, `oauth2-proxy`.

- [ ] **Step 1:** `docker compose -f deploy/compose/compose.yaml config` валиден.
- [ ] **Step 2:** `docker compose up -d --build`; `migrate` завершается с кодом 0; `worker` `/readyz` → 200; `sbx-admin pool status` работает в контейнере; `docker compose down -v`.
- [ ] **Step 3:** коммит `deploy: docker compose stack with postgres and worker`.

### Task 15: слияние S2, финальная проверка

- [ ] **Step 1:** когда `s2-impl` в `main`: `git merge main`; удалить фикстуру tunnel (решение 16); сверить Drizzle `tunnel.*` с `0100_tunnel_init.sql` (drift-тест); `HttpGatewayPort` — через `PgRegistry` из `@sbx/agent-client`, если удобнее; расхождения контракта — в отчёт.
- [ ] **Step 2:** `pnpm -r test`, `pnpm lint`, `pnpm build`, `pnpm -r typecheck` — зелёные; `docker compose up` для нашей части.
- [ ] **Step 3:** обновить статус S6 в `docs/roadmap.md` («реализация в ветке `s6-impl`»), коммит, `git push -u origin s6-impl`.
- [ ] **Step 4 (после разрешения master-а):** E2E на `pve` по §18 в пределах правил хоста — отдельно, когда появятся S3/S4/S5 и разрешение.
