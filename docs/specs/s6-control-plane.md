# S6. Ядро control plane: спецификация

Статус: согласовано (master-сессия от имени Ильи), 2026-10-29. Область S6 из `docs/roadmap.md`. Архитектура: `docs/architecture.md` (§3 модель данных, §6 warm pool, §10 развёртывание, §11 безопасность). Опирается на `docs/specs/s1-proxmox-foundation.md` (примитивы, аллокатор, SMBIOS §6.4, драйвер хранилища) и `docs/specs/s2-tunnel-protocol.md` (реестр, события, `agent-client`, §15).

Пометка **[решение S6]** — решение автора спеки в рамках брифа без отдельного согласования; его можно менять при планировании, если причина записана. Решения [решение S6] и правки по итогам независимого ревью тоже одобрены master-сессией. Остальное согласовано master-сессией от имени Ильи (ответы на Q1–Q7 и на открытые вопросы §21, 2026-10-29).

## 1. Зачем

S6 — TypeScript-ядро между публичным API (S7) и инфраструктурой (S1 Proxmox, S2 туннель). Оно знает, какие sandbox и machine существуют и в каком они состоянии, выполняет create / stop / resume / fork / delete надёжно при сбоях и повторах, держит warm pool и сверяет базу с реальностью Proxmox.

Что считается успехом:
1. Create из тёплого пула доходит до `ready` за секунды; холодный create работает, когда пул пуст.
2. Ни одна операция не оставляет висящих VM, LV, VMID или строк при падении пода worker на любом шаге; повтор доводит её до конца.
3. Две операции над одной sandbox никогда не выполняются одновременно; повтор запроса с тем же `Idempotency-Key` не создаёт второй sandbox.
4. RAM на ноде никогда не превышает лимит (8 GB в PoC), даже при параллельных create из нескольких подов.
5. Долгая работа агента внутри sandbox никогда не останавливается по простою.

## 2. Цели, не-цели, анти-цели

**Цели**
- Модель данных рантайма в Postgres (схема `runtime`), готовая к нескольким кластерам и нодам.
- Машины состояний Sandbox, Machine и Operation с явными переходами и инвариантами.
- `apps/worker` на pg-boss: задания операций, контроллеры (пул, health, auto-stop, reconcile, cleanup), горизонтальное масштабирование в Kubernetes.
- Warm pool с учётом RAM и версий шаблонов.
- Оркестрация через примитивы S1 и события S2.
- Хранение env и секретов sandbox в зашифрованном виде.
- Интерфейсы для S7 (сервисный слой), S4 (маршруты), S3 (RPC агента), S5 (регистрация сборок шаблонов), S8 (конфигурация).

**Не-цели (другие области)**
- Форма публичного REST API, коды HTTP, NDJSON, SDK (S7). Здесь только сервисный слой и доменные коды ошибок.
- Payload, UI, пользователи, команды, API-ключи (S8). S6 только читает конфигурацию.
- Внутренности агента (S3), gateway (S4), сборка шаблонов (S5), Windows (S9).
- Перенос sandbox между нодами, архив в PBS, периодические снапшоты, webhooks (фаза 2).

**Анти-цели (провал, даже если всё работает)**
- Machine выдана второй sandbox или вернулась в пул после того, как к ней прикоснулся арендатор.
- Секрет (env, secret-файлы, bootstrap secret) попал в логи, в данные заданий pg-boss, в `operations.request`, в снапшот или в метрики.
- Reconciler удалил что-то, что не помечено нами (не в pool `sandbox`, без тега `sbx`, вне диапазона VMID).
- Sandbox с запущенной командой или открытым PTY остановлена по простою.
- Сумма RAM на ноде превысила лимит из-за гонки двух подов.

## 3. Ограничения

- Control plane в Kubernetes: `api`, `worker`, `web`, `gateway`. Postgres один, схемы: `runtime` (S6), `tunnel` (S2), `payload` (S8), `pgboss` (очередь).
- PoC: одна нода `pve`, RAM всех sandbox и warm machine ≤ 8 GB, VMID 500–598, хранилище `local-lvm` (S1).
- Toolchain из `mise.toml` (Node 26.13.0, pnpm 12.16.1). Версии библиотек в §17 проверены 2026-10-29; при реализации перепроверить (`CLAUDE.md`).
- Раскладка репозитория по `CLAUDE.md`: TS в `apps/` и `packages/`, тесты vitest, линт biome.

## 4. Обзор

```
                 apps/api (Hono)                         apps/worker (pg-boss)
   S7 routes ──> packages/core: SandboxService     ┌──> op handlers (sandbox-op, machine-op)
   /internal/v1/agent-events ─> core.events.ingest │    controllers: pool, health, autostop,
   /internal/v1/routes, ssh ──> core.routes        │    reconcile, cleanup
                 │                                 │         │              │
                 v                                 │         v              v
           Postgres: runtime.*, tunnel.*, pgboss.* ┘   packages/pve    packages/agent-client
                 ^                                     (S1: PVE API,   (S2: gateway -> agent)
                 │ ConfigReader                          sbx-node)
           Payload Local API (payload.*)  — packages/config
```

### 4.1 Пакеты

| Путь | Что | Кто использует |
|---|---|---|
| `packages/db` | Раннер SQL-миграций из `db/migrations/` (§5.12); Drizzle-схема `runtime` и описания таблиц `tunnel` для типов и запросов; Postgres-реализация `AllocatorStore` | core, worker, api |
| `packages/core` | Доменная логика без HTTP: машины состояний (чистые функции переходов), `SandboxService`, admission и учёт RAM, идемпотентность, шифрование секретов, приём событий агента, маршруты для S4 | api, worker |
| `packages/config` | `ConfigReader`: реализация на Payload Local API и статическая (YAML) для PoC до S8 и для тестов | core, worker, api |
| `packages/pve` | S1 как есть; S6 подставляет Postgres-реализацию `AllocatorStore` (живёт в `packages/db`) | worker |
| `packages/agent-client` | S2 как есть | worker, api |
| `apps/worker` | Процесс worker: регистрация очередей pg-boss, обработчики, контроллеры, метрики, graceful shutdown | — |
| `apps/api` | S7. S6 даёт ему внутренние ручки как тонкие обёртки над `packages/core` (§14.1) | — |

Правило: `packages/core` не импортирует `packages/pve` напрямую в коде, который работает в `api`; обращения к Proxmox и к агенту в рамках операций делает только worker. `api` ходит к агенту только для команд, файлов и портов (S7) через `agent-client`.

## 5. Модель данных (схема `runtime`)

Общие правила [решение S6]:
- Первичные ключи — UUIDv7 (`uuidv7()` из Postgres 18). Исключение: `commands.id` — ULID (S2 §9.1), `machines.id` = `machineId` из S2 (UUIDv7).
- Время — `timestamptz`. Перечисления — `text` с `CHECK` (проще миграции, чем `enum`).
- У изменяемых строк с машиной состояний есть `version int` для оптимистичной блокировки. Переход состояния — всегда `UPDATE … WHERE id = $1 AND state = ANY($from) RETURNING`; ноль строк означает конфликт.
- Публичный формат id (префиксы, кодировка) решает S7 поверх UUID.

### 5.1 Топология (multi-cluster с первого дня)

```
providers(                         -- one Proxmox cluster
  id uuid pk, kind text,           -- 'proxmox'
  name text unique,
  cluster_mac_id smallint unique,  -- S1 SBX_CLUSTER_ID, byte 2 of the MAC
  vmid_min int, vmid_max int,      -- S1 SBX_VMID_RANGE
  api_url text, tls_name text,
  secret_ref text,                 -- name of the mounted Secret dir with token and CA, never the secret itself
  state text,                      -- active | draining | disabled
  created_at, updated_at)

nodes(
  id uuid pk, provider_id fk, name text,   -- 'pve'
  state text,                       -- active | cordoned | down
  ram_cap_mb int,                   -- budget for sandboxes on this node (8192 in the PoC)
  clone_concurrency int,            -- S1 limit, default 4
  node_agent_ref text,              -- sbx-node endpoint and Secret dir
  last_seen_at, created_at, updated_at,
  unique(provider_id, name))

storages(
  id uuid pk, provider_id fk, node_id fk null,  -- null for shared storage (phase 2)
  name text,                        -- 'local-lvm'
  driver text,                      -- 'lvmthin'
  data_max_pct int, meta_max_pct int,  -- S1: 80 / 70
  usage jsonb, usage_at,            -- last StorageDriver.usage()
  unique(provider_id, node_id, name))
```

Строки топологии заводятся миграцией-сидом или CLI оператора (`sbx-admin` в `apps/worker`, §15). Секреты — только файлы из Kubernetes Secret по `secret_ref` (S1 §6.1).

### 5.2 Сборки шаблонов

```
template_builds(
  id uuid pk,
  template_slug text,               -- key of the Payload Template
  version text,                     -- build version from S5
  os text,                          -- linux | windows
  provider_id fk, node_id fk, storage_id fk,  -- template LVs are node-local
  pve_vmid int,                     -- e.g. 599
  disk_layout jsonb,                -- DiskSet slots and options (S1 §6.2)
  hw jsonb,                         -- whitelisted hardware keys (S1 §6.3)
  agent_version text,
  boot_timeout_s int,               -- default 300 linux, 1200 windows
  status text,                      -- building | active | deprecated | retired
  created_at, promoted_at)
-- at most one active build per (template_slug, node_id)
unique (template_slug, node_id) where status = 'active'
```

Пишет S5 (пайплайн регистрирует сборку и переводит её в `active`). До S5 шаблон 599 заводится сидом. Переход в `active` меняет поколение пула (§9.4). `deprecated` не используется для новых machine, но существующие sandbox на нём живут: их диски свои.

### 5.3 Аллокатор (из S1 §6.5)

```
vmid_leases(
  provider_id fk, vmid int, mac text,
  state text,                       -- reserved | active | releasing
  purpose text,                     -- machine | template
  machine_id uuid null,
  created_at, updated_at,
  primary key(provider_id, vmid), unique(provider_id, mac))
unique (machine_id) where machine_id is not null and state <> 'releasing'
```

`AllocatorStore` из `packages/pve` реализуется поверх этой таблицы. Свободный VMID выбирается так же, как в S1: меньший из диапазона, которого нет ни в таблице, ни в Proxmox, ни среди LV. Выделение идемпотентно по `machine_id`: если у machine уже есть lease не в `releasing`, возвращается он (§7.4).

### 5.4 Machines и диски

```
machines(
  id uuid pk,                       -- = machineId in smbios (S2)
  provider_id fk, node_id fk, storage_id fk,
  vmid int null, mac text null,     -- null until allocated
  template_build_id fk,             -- lineage, also for forks
  origin text,                      -- template | snapshot
  origin_snapshot_id fk null,
  pool_key text null,               -- '<template_slug>/<size_slug>' while it is a pool machine
  size_slug text, vcpu int, memory_mb int,
  sandbox_id uuid null,             -- set once, never changes (trigger)
  state text,                       -- §6.2
  power_observed text,              -- running | stopped | paused | unknown
  power_observed_at,
  unexpected_stops jsonb,           -- timestamps of recent unexpected stops (§11.3)
  provisioned_boot_id text null,    -- boot_id on which env and secrets were last delivered (§10.2)
  exec_attempt int,                 -- fencing token for machine-op handlers (§15.1)
  error_code text, error_detail text,
  created_at, warm_at, claimed_at, deleted_at, state_changed_at, version int)

disks(
  id uuid pk,
  machine_id fk null, snapshot_id fk null,   -- exactly one is set (CHECK)
  storage_id fk, slot text,         -- scsi0 | efidisk0 | tpmstate0
  volume text,                      -- LV name or volid
  size_bytes bigint, options jsonb,
  state text,                       -- active | deleting | deleted
  created_at, deleted_at)
```

Триггер запрещает менять `machines.sandbox_id`, если он уже не `null`. Это и есть правило S2 «machine не переиспользуется».

`disks` — зеркало того, что вернул драйвер (`DiskSet`, `SnapshotRef`). Reconciler сверяет его с `sbx-node lv.list`.

### 5.5 Снапшоты

```
snapshots(
  id uuid pk,
  kind text,                        -- auto | saved | fork_source  (auto is reserved, not created in phase 1)
  team_id uuid,                     -- owner
  name text null,                   -- saved only, set when ready
  pending_name text null,           -- saved only, while creating
  source_sandbox_id uuid null, source_machine_id uuid null,
  consumer_sandbox_id uuid null,    -- fork_source: the fork target
  provider_id fk, node_id fk, storage_id fk,
  template_build_id fk,             -- lineage
  hw jsonb,                         -- S1 snapshot metadata (no smbios1, vmgenid, MAC, name)
  consistency text,                 -- quiesced | crash | powered_off
  quiesce_broken bool,              -- set by the quiesce.watchdog_thawed event (§10.2)
  state text,                       -- creating | ready | failed | deleting | deleted
  created_at, ready_at, deleted_at, version int)
unique (team_id, name) where kind = 'saved' and state = 'ready'
```

### 5.6 Sandboxes

```
sandboxes(
  id uuid pk,
  slug text unique,                 -- 10 chars [a-z0-9], DNS label part, hostname sbx-<slug>
  team_id uuid, created_by uuid,    -- Payload ids
  name text null, labels jsonb,
  template_slug text, size_slug text,
  vcpu int, memory_mb int,          -- copied from the Size at create/resume time
  template_build_id fk,
  origin text,                      -- template | snapshot | fork
  origin_snapshot_id uuid null, forked_from_sandbox_id uuid null,
  provider_id fk null, node_id fk null,   -- fixed once disks exist
  machine_id uuid null,             -- current machine (1:N history via machines.sandbox_id)
  state text,                       -- §6.1
  stop_reason text null,            -- user | ttl | idle | unexpected_shutdown | retention
  health text,                      -- ok | degraded
  health_reason text null, degraded_since null,
  activity text,                    -- busy | idle | unknown
  activity_counters jsonb,          -- last {runningCommands, openPtys, tcpStreams} from the agent
  last_activity_at, last_api_call_at,
  ttl_seconds int null,             -- null = no TTL
  deadline_at null,                 -- TTL deadline
  idle_timeout_seconds int null,    -- null = no idle-stop
  last_reboot_at null, last_reboot_reason text null,
  last_recover_at null,
  error_code text null, error_message text null,
  created_at, ready_at, stopped_at, deleted_at, state_changed_at, version int)

sandbox_secrets(
  sandbox_id uuid pk,
  key_version int, nonce bytea, ciphertext bytea,  -- AES-256-GCM, §13
  updated_at)

sandbox_events(                     -- audit and outbox for later webhooks
  id uuid pk, sandbox_id, type text, -- state_changed | health_changed | operation_*
  from_state text null, to_state text null, reason text null,
  data jsonb, created_at)
```

Строка `deleted` остаётся как надгробие (для `GET` и аудита) и удаляется cleanup через 30 дней [решение S6].

### 5.7 Операции и идемпотентность

```
operations(
  id uuid pk,
  sandbox_id uuid,
  kind text,          -- create | fork | stop | resume | recover | delete | save_snapshot | reprovision
  state text,         -- pending | running | succeeded | failed | superseded
  request jsonb,      -- non-secret parameters only
  step text null,     -- last completed step
  progress jsonb,     -- step outputs (machine id, vmid, snapshot id, ...)
  attempt int,
  error_code text null, error_message text null, retryable bool null,
  requested_by uuid null,           -- principal (user or API key owner)
  parent_operation_id uuid null,    -- fork: target create -> source fork
  superseded_by uuid null,
  deadline_at,
  created_at, started_at, finished_at, version int)
-- one active operation per sandbox
unique (sandbox_id) where state in ('pending', 'running')

idempotency_keys(
  principal_id uuid, key text,      -- principal = API key or user
  scope text,                       -- 'sandboxes.create', 'sandboxes.fork', ...
  request_hash bytea,               -- sha256 of the canonical request body
  operation_id uuid, sandbox_id uuid,
  response jsonb,                   -- what the service returned the first time
  created_at, expires_at,           -- 24 h
  primary key(principal_id, scope, key))
```

### 5.8 Команды и порты

```
commands(
  id text pk,                       -- ULID, = commandId for Process/Start (S2)
  sandbox_id uuid, machine_id uuid,
  cmd text,                         -- first 64 KiB
  cwd text null, env_keys text[],   -- variable names only, values are not stored
  mode text,                        -- sync | stream | detached | pty
  timeout_seconds int null,
  status text,                      -- starting | running | exited | killed | timed_out | lost | failed_to_start
  exit_code int null, signal text null,
  stdout_bytes bigint null, stderr_bytes bigint null,
  boot_id text null,                -- boot on which it was started
  created_by uuid null, request_id text null,
  created_at, started_at, ended_at)

hosted_ports(
  id uuid pk, sandbox_id uuid, port int,
  label text,                       -- '<slug>-<port>', DNS label for *.sbx.<domain>
  mode text,                        -- token | sso | public
  token_hash bytea null,            -- sha256 of the access token (mode=token)
  auth_epoch int,                   -- bumped on token rotation, mode change, revoke
  created_at, deleted_at)
unique (sandbox_id, port) where deleted_at is null
unique (label) where deleted_at is null
```

Записи `commands` создаёт S7 (до вызова `Process/Start`), статус обновляют S7 (по стриму) и обработчик событий (§10). Терминальный статус не перезаписывается. Хранение 90 дней (cleanup).

### 5.9 События агента

```
agent_events(
  machine_id uuid, seq bigint,
  boot_id text, type text, time timestamptz,
  payload jsonb,                    -- decoded payload
  received_at, processed_at null,
  primary key(machine_id, seq))

agent_synthetic_events(
  machine_id uuid, epoch bigint, type text,  -- S2 §9.6 key
  instance_id text, time timestamptz,
  received_at, processed_at null,
  primary key(machine_id, epoch, type))
```

Хранятся 7 дней [решение S6].

### 5.10 Таблицы S2 (схема `tunnel`)

S6 пишет только `tunnel_credentials.bs_hash` (при подготовке machine) и `tunnel_credentials.retired_at` (при удалении). Читает `tunnel_sessions` (подключена ли machine, `disconnected_at`, `boot_id`, `capabilities`) и `gateway_instances` (свежесть heartbeat). SQL-миграции схемы `tunnel` пишет S2 (`s2-impl`) в общем каталоге, в диапазоне номеров 0100–0199 (§5.12); `packages/db` описывает эти таблицы в Drizzle только для типов и запросов.

### 5.11 Конфигурация из Payload (S8)

Payload владеет редактируемой конфигурацией. S6 читает её через `ConfigReader`:

```ts
interface ConfigReader {
  template(slug: string): Promise<TemplateConfig | null>
  // { slug, os, enabled, defaultSize, allowedSizes[] }
  size(slug: string): Promise<SizeConfig | null>
  // { slug, vcpu, memoryMb }  (disk size comes from the template build in phase 1)
  poolTargets(): Promise<PoolTarget[]>
  // { templateSlug, sizeSlug, providerId?, target, maxAgeHours? }
  teamQuota(teamId: string): Promise<Quota>
  // { maxActiveSandboxes, maxRamMb, maxSavedSnapshots }
  defaults(): Promise<PlatformDefaults>
  // { ttlSeconds: null, maxTtlSeconds, idleTimeoutSeconds: 900, stoppedRetentionDays: null,
  //   errorRetentionDays: 7, recoverMinIntervalSeconds: 600 }
}
```

- Реализация `PayloadConfigReader` — Payload Local API (`getPayload({ config })`, без Next). Кэш в процессе на 10 s; сброс по `LISTEN sbx_config`. `NOTIFY sbx_config` шлют `afterChange`-хуки коллекций Payload (обязанность S8).
- Payload-конфиг должен импортироваться из пакета без Next (обязанность S8, §16). До S8 используется `StaticConfigReader` с YAML-файлом (`SBX_CONFIG_FILE`).
- Пользователи, команды, API-ключи читает S7; S6 получает уже проверенный `Principal { userId, teamId, apiKeyId?, scopes }`.

### 5.12 Миграции (решение master-сессии, касается и S2)

- Один каталог SQL-миграций для всех схем рантайма: `db/migrations/NNNN_<name>.sql` — обычные упорядоченные SQL-файлы, без генерации на лету.
- Диапазоны номеров: **0100–0199** — схема `tunnel` (пишет `s2-impl`), **0200+** — схема `runtime` (S6). Схемы создаются своими миграциями (`CREATE SCHEMA`).
- Раннер живёт в реализации S6 (`packages/db`): применяет файлы по номеру в транзакции, ведёт таблицу применённых миграций с хешем файла и берёт advisory-блокировку, чтобы поды `api` и `worker` не запускали миграции одновременно. Изменённый уже применённый файл — ошибка.
- Drizzle-схема в TS нужна для типов и запросов и должна совпадать с SQL (тест сверяет её с живой БД после миграций).
- Go-тесты (gateway, S2) применяют те же файлы напрямую.
- Payload ведёт свои миграции для схемы `payload`; pg-boss создаёт и обновляет схему `pgboss` сам.

## 6. Машины состояний

### 6.1 Sandbox

```
            create/fork/from-snapshot
                     |
                     v
                 creating ----------(fail)----------> error
                     |                                  |  ^
                  (ready)                       resume  |  | resume fails
                     v                                  v  |
   +------------->  ready  --stop/ttl/idle-->  stopping --+--> stopped
   |                 |  ^                                         |
   |        recover  |  |                                         | resume
   |                 v  |                                         v
   |              (recover op)                                starting
   +---------------------------------------(ready)----------------+
   any non-terminal --delete--> deleting --> deleted (terminal)
```

| Состояние | Значит | Команды и файлы (S7) |
|---|---|---|
| `creating` | идёт create, fork-цель или create из снапшота | ждут готовности (S7 решает, сколько) |
| `ready` | VM работает, агент подключался и провижен | работают; при `health=degraded` — `503 agent_unavailable` по S2 |
| `stopping` | идёт shutdown | `409` |
| `stopped` | VM выключена, диски на ноде, RAM свободна | `409 sandbox_not_ready` |
| `starting` | идёт resume (или повторный старт после recover из `error`) | ждут |
| `error` | операция не удалась без автоматического пути назад, `error_code` | `409` |
| `deleting` | идёт удаление | `409` |
| `deleted` | терминально | `404` (решает S7) |

Переходы (только эти; всё остальное — `invalid_state`):

| Из | Операция / событие | В | Кто |
|---|---|---|---|
| — | create, fork (цель), create from saved | `creating` | API |
| `creating` | create завершён | `ready` | worker |
| `creating` | create провален | `error` | worker |
| `ready` | stop (пользователь, TTL, idle) | `stopping` | API / controller |
| `stopping` | VM выключена | `stopped` | worker |
| `stopping` | stop провален после дедлайна | `error` (`stop_failed`) | worker |
| `ready` | VM неожиданно выключилась, первый раз за час (§11.3) | `starting` (системный resume) | reconciler |
| `ready` | VM неожиданно выключилась второй раз за час (§11.3) | `stopped` (`unexpected_shutdown`) | reconciler |
| `stopped`; `error`, если machine `stopped` (VM и диски на месте) | resume | `starting` | API |
| `starting` | агент на связи, провижен | `ready` | worker |
| `starting` | дедлайн или ошибка | `error` (`resume_failed`) | worker |
| `ready`; `error`, если machine не `failed`/`deleting`/`deleted` | recover | `starting` | API |
| `ready`, `stopped` | fork, save_snapshot | без смены состояния (операция на источнике) | API |
| любое, кроме `deleting`/`deleted` | delete | `deleting` | API |
| `deleting` | удаление проверено | `deleted` | worker |
| `creating`, `ready`, `stopped`, `starting`, `stopping` без активной операции | VM machine пропала в Proxmox | `error` (`machine_lost`) | reconciler |

`error` с `machine_lost` терминален по смыслу: VM-конфига нет, а восстановления VM из оставшихся дисков в фазе 1 нет. Разрешён только delete. Если пропажу обнаруживает шаг активной операции, операция сама падает с тем же кодом.

`health` и `activity` — поля, а не состояния:
- `health = degraded`, если `state = ready` и агента нет дольше 60 s (§11.1). Возврат в `ok` — по событию `connected`.
- `activity = busy | idle | unknown` из счётчиков агента и вызовов API (§12). `unknown`, пока агент недоступен.

### 6.2 Machine

```
allocating -> provisioning -> booting -> warm -> claiming -> running <-> stopping/stopped/starting
                                   \                 ^
                                    \----------------/   (cold path: sandbox_id set from the start)
any -> deleting -> deleted          any -> failed -> deleting (auto)
```

| Состояние | Значит | RAM (§8.1) |
|---|---|---|
| `allocating` | строка создана как резерв RAM, VMID ещё нет | reserved |
| `provisioning` | VMID и MAC выделены, BS записан, идёт конфиг и клон дисков (S1 create/fork) | reserved |
| `booting` | VM запущена, ждём подключения агента и готовности | reserved, powered |
| `warm` | в пуле, агент на связи, готов к claim (только `pool_key` не null, `sandbox_id` null) | reserved, powered |
| `claiming` | назначена sandbox, идёт ротация MT и `System/Claim` | reserved, powered |
| `running` | работает у sandbox | reserved, powered |
| `stopping` / `starting` | переходы питания | reserved, powered |
| `stopped` | выключена, диски есть | reserved, только если ждёт resume/recover |
| `failed` | не удалась подготовка или потеряна; worker сам переводит в `deleting` (если не нужна для диагностики `error` sandbox) | powered, пока VM не остановлена |
| `deleting` | `retired_at` выставлен, идёт S1 delete с проверкой | powered, пока VM не остановлена |
| `deleted` | VMID освобождён, LV нет | — |

Machine из пула (`pool_key` не null) после claim теряет `pool_key` и больше никогда не возвращается в `warm`.

### 6.3 Operation

`pending → running → succeeded | failed | superseded`. `superseded` ставит только delete (§7.2). Повтор шага после падения worker не меняет состояния операции: она остаётся `running`, `attempt` растёт.

### 6.4 Инварианты

1. Не больше одной активной операции на sandbox (уникальный частичный индекс) и не больше одного исполнителя операции (fencing по `attempt`, §15.1).
2. `machines.sandbox_id` после установки не меняется (триггер). Machine, побывавшая в `claiming`, после неудачи удаляется, а не возвращается в пул.
3. `sandbox.state = ready` ⇒ у текущей machine `state = running`. Исключение — окно до обнаружения неожиданного выключения reconcile-ом (до 60 s, §11.3).
4. Для каждой ноды `reserved ≤ ram_cap_mb` и `powered ≤ ram_cap_mb` (§8.1): первое обеспечивает admission, второе — проверка перед каждым стартом VM. Обе под advisory-блокировкой ноды.
5. `vmid_leases.state = active` ⇔ есть machine не в `deleted`; `releasing` добирает reconciler.
6. Снапшот `ready` ⇒ все его `disks` в `active`.
7. `sandbox.node_id` не меняется после появления дисков (фаза 1: всё на одной ноде, где лежат LV).
8. `deleted` — терминально: у sandbox нет machine не в `deleted`, нет `sandbox_secrets`, нет активных `hosted_ports`. Saved snapshots переживают sandbox.
9. Секреты существуют только в `sandbox_secrets.ciphertext`, в памяти обработчика и в RPC к агенту.

## 7. Операции

### 7.1 Общий механизм

1. **API** (через `SandboxService`) в одной транзакции: проверяет состояние, квоты и admission (§8); переводит sandbox в переходное состояние; вставляет `operations` (`pending`); записывает `idempotency_keys` (для create и fork); отправляет задание pg-boss `sandbox-op {operationId}` (транзакционный `send` через адаптер Drizzle). Ответ — sandbox и операция.
2. **Worker** берёт задание. Очередь `sandbox-op` с политикой `singleton` и `singletonKey = sandboxId`: одновременно активно не больше одного задания на sandbox. Обработчик:
   - читает операцию; если она терминальна — выходит (повторная доставка);
   - если у операции есть `parent_operation_id` и родитель ещё не `succeeded` — выходит без ошибки (её поставит родитель); если родитель `failed`/`superseded` — операция `failed` (`fork_failed`);
   - переводит `pending → running` и увеличивает `attempt`; своё значение `attempt` обработчик держит как fencing token;
   - выполняет шаги по порядку, начиная после `step`. Каждый шаг идемпотентен (проверка «уже сделано?» → действие → запись `step` и `progress`). Запись шага — `UPDATE … WHERE id = $1 AND attempt = $myAttempt AND state = 'running'`; ноль строк значит, что операцию уже выполняет другой исполнитель или она вытеснена, и обработчик сразу выходит;
   - перед каждым шагом и раз в 2 s внутри долгих ожиданий (загрузка, подключение агента, RAM, shutdown) перечитывает операцию: если `superseded` или `attempt` не свой — выходит (компенсация — на delete);
   - временная ошибка — исключение, pg-boss повторяет задание с backoff; постоянная ошибка — компенсация, операция `failed`, задание завершается без исключения.
3. **Дедлайн операции** (`deadline_at`, §7.9). Если он истёк, следующая попытка не делает новых шагов, а выполняет компенсацию и `failed`.
4. **`requestId` к агенту** — детерминированный UUIDv5 от `operationId:step`, поэтому повтор шага после падения пода передаёт агенту тот же id (S2 §9.2).

Повторы того же вида: `stop` при активном `stop` возвращает ту же операцию. Любая другая операция при активной — ошибка `operation_in_progress` (retryable, с id активной операции). Исключение — delete (§7.2).

### 7.2 Delete вытесняет

- Delete принимается в любом состоянии, кроме `deleting`/`deleted` (там возвращается текущая операция delete).
- В одной транзакции: активная операция → `superseded` (`superseded_by` = delete), sandbox → `deleting`, вставка операции delete, задание `sandbox-op`.
- Задание delete стоит в той же singleton-очереди и стартует, когда вытесненное задание выйдет. Вызовы S1 длятся секунды, а долгие ожидания проверяют `superseded` раз в 2 s (§7.1), поэтому delete ждёт не больше нескольких секунд.
- Delete сам убирает всё, что успела создать вытесненная операция: он работает по фактическому состоянию (все machine с этим `sandbox_id` не в `deleted`, `progress` вытесненной операции, снапшоты `fork_source` с `consumer_sandbox_id` = эта sandbox, а также снапшоты в `creating` с `source_sandbox_id` = эта sandbox), а не по плану. Готовые `fork_source` чужих целей и saved snapshots переживают delete источника.
- Шаги delete: `retire` (`tunnel_credentials.retired_at`), `stop` (S1 stop, сразу `power_observed = stopped`, чтобы освободить RAM для ждущих стартов), `destroy` (S1 `delete` с проверкой), `snapshots`, `ports` (`hosted_ports.deleted_at`, `NOTIFY sbx_routes`), `secrets` (удалить `sandbox_secrets`), `finish` (`deleted`).
- Если цель fork ещё ждёт родителя, её delete просто вытесняет `pending`-операцию: родитель увидит это и после `ready` снапшота удалит его сам, раз цель уже `deleting`.

### 7.3 Create

Вход: `template`, `size`, `name`, `labels`, `env`, `secretFiles`, `ttlSeconds`, `idleTimeoutSeconds`, `from` (saved snapshot) — форму задаёт S7.

**API (синхронно):** проверить шаблон (`enabled`, размер разрешён) и квоту команды. Затем admission (§8):
- **claim:** есть `warm` machine этой пары с активной сборкой → в той же транзакции machine → `claiming`, `sandbox_id` установлен, `sandbox.machine_id`, `node_id` заполнены;
- **cold:** иначе, если RAM хватает (с учётом вытеснения warm других пар) → новая machine `allocating` с `sandbox_id`;
- иначе → `out_of_capacity` (S7 отдаёт `503`), ничего не создано.

Sandbox `creating`, `sandbox_secrets` (зашифрованные env и файлы), операция `create`.

**Worker, шаги:**

| Шаг | Что делает | Проверка «уже сделано» |
|---|---|---|
| `provision` (только cold) | §7.4, включая проверку RAM и start | machine не в `allocating`/`provisioning` |
| `boot` (только cold) | ждать подключения и фазы агента `pool_ready` (не дольше `boot_timeout_s`) | machine подключена, фаза получена |
| `rotate_token` | `POST /v1/machines/{id}/rotate-token` на gateway (S2 §5.2) | идемпотентно само |
| `claim` | `System/Claim{reason: claim, sandboxId, hostname: sbx-<slug>, env, secretFiles, authorizedKeys}` с `requestId`; ждать ответа с фазой `ready`; записать `provisioned_boot_id` | `requestId` агента |
| `finish` | machine → `running`, sandbox → `ready`, `ready_at`, `deadline_at = now + ttl`, `sandbox_events`, `NOTIFY sbx_routes` | состояние |

Ошибки:
- Агент недоступен — временная ошибка (повтор по S2 до 30 s на вызов, затем повтор задания).
- Claim отклонён агентом или не прошёл до дедлайна: machine → `deleting` (к ней прикоснулся арендатор). Если machine была из пула, операция один раз пробует заново (admission: другой warm или cold), иначе — sandbox `error` (`create_failed`).
- Холодная подготовка не удалась: machine `failed → deleting`, sandbox `error` (`create_failed`).

`authorizedKeys` — публичные SSH-ключи пользователя (S8); если S8 их не даёт, пустой список.

**Create из saved snapshot:** всегда cold, мимо пула. Нода — нода снапшота. Шаг `provision` использует S1 `fork(snapshot)` вместо `create(template)`. `template_build_id` берётся из снапшота.

### 7.4 Подготовка machine (общий шаг для пула, cold create, fork, from-snapshot)

Durable-маркер шага — состояние machine: `allocating`/`provisioning` значат «подготовка не завершена», переход в `booting` записывается **до** вызова start. Так одинаково работают и операция sandbox, и `machine-op` пула, у которого нет строки `operations`.

1. Machine → `provisioning`.
2. Новый BS (32 байта): `tunnel_credentials(machine_id, bs_hash)` upsert. BS живёт только в памяти этого шага.
3. Захватить слот клонирования ноды (§8.3).
4. S1 `create(template, size, {smbios1})` или `fork(snapshot, size, {smbios1})`, `smbios1` по S2 §5.2 (`uuid = machineId`). VMID и MAC S1 берёт из `AllocatorStore`; реализация S6 идемпотентна по `machine_id` (§5.3). Записать в machine `vmid`, `mac`, в `disks` — `DiskSet`.
5. Освободить слот.
6. Проверка RAM перед стартом (§8.1) и в той же транзакции machine → `booting`. Только после этого — S1 `start`.

**Повтор после падения** (machine всё ещё в `provisioning`): VM ещё ни разу не запускалась, поэтому частичный результат выбрасывается. Если у machine есть lease и VM или LV с этим VMID, вызывается S1 `delete(vmid)` (он проверяет удаление и освобождает lease), затем шаги 2–6 повторяются с новым BS и, возможно, другим VMID. BS не сохраняется нигде, поэтому повтор всегда идёт с новым; после перехода в `booting` BS не меняется никогда [решение S6]. Так S6 не нужен примитив «переписать `smbios1`».

### 7.5 Stop

Причина: `user`, `ttl`, `idle`. API: sandbox → `stopping`, операция `stop`.

| Шаг | Что делает |
|---|---|
| `prepare` | Best effort, 10 s: `System/PrepareStop` (агент сбрасывает буферы и стирает секреты из tmpfs) |
| `shutdown` | S1 `shutdown(timeout 60 s)`; если VM не выключилась — S1 `stop` (жёстко) |
| `verify` | статус VM `stopped` |
| `finish` | machine → `stopped`, sandbox → `stopped`, `stopped_at`, `stop_reason`; команды этой machine в `starting`/`running` → `lost`; `NOTIFY sbx_routes` |

### 7.6 Resume

API: состояние `stopped` или `error` с machine в `stopped` (§6.1). Квота и admission (§8.2) на ноде sandbox: RAM machine (с вытеснением warm других пар; если передан `size`, считается его RAM [решение S6]); если не хватает → `out_of_capacity`. Sandbox → `starting`, операция `resume`; machine остаётся `stopped` до шага `start`.

| Шаг | Что делает |
|---|---|
| `resize` (если `size` изменился) | `PUT config` cores и memory, пока VM выключена |
| `start` | проверка RAM перед стартом (§8.1, ждать с опросом 1 s), затем S1 `start` |
| `wait_agent` | новое подключение (`tunnel_sessions` с `boot_id`, отличным от `provisioned_boot_id`) |
| `provision` | `System/Claim{reason: resume, env, secretFiles, authorizedKeys}` — секреты передаются заново (в госте их после загрузки нет, фаза `secrets: missing` у S3); записать `provisioned_boot_id` |
| `finish` | machine → `running`, sandbox → `ready`, `deadline_at = now + ttl` (TTL можно передать заново), `health=ok` |

Ошибка или дедлайн: S1 `stop` (жёстко), machine → `stopped`, sandbox → `error` (`resume_failed`). Диски целы, resume можно повторить.

### 7.7 Fork

Вход: источник в `ready` или `stopped` без активной операции; параметры цели (`name`, `labels`, `ttlSeconds`, `size`).

**API:** admission RAM для цели на ноде источника (вытеснение warm разрешено; других нод нет — LV локальны). Создаются:
- цель: sandbox `creating` (`origin = fork`, `forked_from_sandbox_id`), `sandbox_secrets` — копия env и секретов источника, перешифрованная с AAD цели; machine цели `allocating`;
- операция `fork` на источнике (`pending`) и операция `create` на цели (`pending`, `parent_operation_id` = fork). Задание ставится только для `fork`.

**Worker, операция `fork` на источнике:**
1. `snapshot`: строка `snapshots` (`kind = fork_source`, `consumer_sandbox_id` = цель, `creating`). Если источник работает — S1 `snapshot` с `QuiesceHook` от S3 (`System/Quiesce` с lease и watchdog; запасной путь — QGA fsfreeze через S1), `consistency = quiesced`. Если агент и QGA не отвечают — ошибка `quiesce_failed` (crash-consistent режим не используется по умолчанию). Если источник выключен — без freeze, `powered_off`. После thaw обработчик проверяет `quiesce_broken`: если watchdog успел разморозить ФС раньше, снапшот несогласован, операция падает с `quiesce_failed`.
2. Снапшот → `ready`. В одной транзакции: операция `fork` → `succeeded`; у операции цели `deadline_at = now + дедлайн`; задание `sandbox-op` для цели. Если цель к этому моменту уже `deleting`/`deleted`, задание не ставится, а снапшот удаляется этой же операцией.

**Worker, операция `create` на цели:** шаги `provision` (S1 `fork(snapshot)`), `boot`, `claim` (агент увидит смену `machineId` и сменит идентичность, S3), `finish` — как cold create. Затем `cleanup_source`: S1 `delete(snapshot)`, снапшот → `deleted` (thin-снимки независимы).

**Кто владеет снапшотом `fork_source`.** Пока снапшот `creating`, им владеет операция `fork` источника: при её провале или вытеснении она (или delete источника, §7.2) удаляет частично созданные LV. С момента `ready` им владеет цель: `cleanup_source`, компенсация create цели при ошибке и delete цели удаляют его. Cleanup (§15.4) трогает только `fork_source` в `ready`/`failed`, чья цель в `error`/`deleted`, или любой старше 1 h — страховка, а не основной путь.

Ошибки: провал или вытеснение операции на источнике → обработчик цели (по `parent_operation_id`, §7.1) переводит её операцию в `failed`, цель → `error` (`fork_failed`). Источник сам цель не трогает: каждая sandbox меняется только своей операцией.

Fork наследует от источника: диск, env и секреты, `template_slug`, `size` (если не передан), `labels` (если не переданы). Не наследует: TTL (берётся из запроса или из дефолта), hosted ports, историю команд.

### 7.8 Saved snapshot, recover, reprovision, update

**Save snapshot** (операция `save_snapshot` на источнике в `ready`/`stopped`): снапшот `kind = saved`, `pending_name`, тем же способом, что в fork. Когда он `ready`, в одной транзакции: старый `ready`-снапшот с этим именем → `deleting` (имя снимается), новый получает `name`. При ошибке имя остаётся за прежним снапшотом. Секретов в снапшоте нет: агент держит их только в tmpfs.

**Удаление saved snapshot** (`deleteSavedSnapshot` или замена при save): снапшот сразу → `deleting` (имя освобождается, новые create из него невозможны), задание `snapshot-op delete`. Обработчик удаляет LV только когда нет sandbox в `creating` с `origin_snapshot_id` = этот снапшот, у которых операция ещё не прошла шаг `provision`; до этого ждёт (повтор задания через 30 s). Так create из снапшота, ждущий RAM, не теряет диски.

**Recover** (`ready` или `error` с machine; не чаще раза в `recoverMinIntervalSeconds` = 600): sandbox → `starting`; шаги `reset` (S1 `stop` + `start`, жёсткий power-cycle), `wait_agent`, `provision`, `finish`. Автоматически не запускается никогда.

**Reprovision** (внутренняя, ставит обработчик событий): если sandbox `ready`, а агент сообщил о перезагрузке гостя или фазе `secrets: missing` с `boot_id`, отличным от `machines.provisioned_boot_id`, — `System/Claim{reason: resume}` и новое `provisioned_boot_id`. Не ставится, если активна другая операция (её шаг `provision` всё сделает) или если `boot_id` события уже провижен (запоздавшее событие той же загрузки, которую обработал resume или recover).

**Update** (`name`, `labels`, `ttlSeconds`, `idleTimeoutSeconds`) и **extend** (`deadline_at = now + ttl`) — без операции, обычный `UPDATE` с проверкой `version`.

### 7.9 Дедлайны операций [решение S6]

| Операция | Linux | Windows (S9 уточнит) |
|---|---|---|
| create из пула | 2 min | 5 min |
| create cold / from snapshot / fork-цель | 6 min | 20 min |
| fork (снапшот на источнике) | 2 min | 3 min |
| stop | 3 min | 5 min |
| resume, recover | 5 min | 15 min |
| save_snapshot | 5 min | 5 min |
| delete | без дедлайна: повторы с backoff до 10 min; через 30 min метрика тревоги `sbx_delete_stuck` | то же |

Время загрузки до готовности агента берётся из `template_builds.boot_timeout_s`.

## 8. Ёмкость, размещение, admission

### 8.1 Учёт RAM

RAM machine = `memory_mb` (S1: `balloon=0`, overcommit нет). Лимит — `nodes.ram_cap_mb` (8192 в PoC). На ноде считаются две величины:

- **`reserved`** — обещанная RAM: сумма по machine в `allocating`, `provisioning`, `booting`, `warm`, `claiming`, `running`, `starting`, `stopping`, плюс machine `stopped`, для которых есть `pending`/`running` операция resume или recover (место для их старта уже выдано). Machine в `failed`/`deleting` сюда **не** входят: их место отдано.
- **`powered`** — RAM VM, которые могут работать прямо сейчас: machine в `booting`, `warm`, `claiming`, `running`, `starting`, `stopping`, а также `failed`/`deleting`/`stopped`, у которых `power_observed` не `stopped`.

Инварианты: `reserved ≤ cap` (обеспечивает admission, §8.2) и `powered ≤ cap` (обеспечивает проверка перед стартом, §8.2). Обе проверки идут под `pg_advisory_xact_lock(hash(node_id))`.

### 8.2 Admission и проверка перед стартом

**Admission** — функция `admit(node, needMb, pairKey)` в `packages/core`, в транзакции API (или контроллера пула) под блокировкой ноды:
1. `reserved + need ≤ cap` → да. Резерв — сама строка machine (`allocating`) или операция resume/recover.
2. Иначе считается RAM `warm` machine **других** пар на этой ноде (сначала самые старые). Если её хватает, эти machine в той же транзакции → `deleting` (задание `machine-op delete`), `reserved` уменьшается, ответ — да.
3. Иначе — `out_of_capacity`.

Пул пополняется только из свободной RAM (без вытеснения).

**Проверка перед стартом** — в шаге, который запускает VM (§7.4 шаг 6, `start` в resume и recover), под той же блокировкой: `powered + need ≤ cap`. Если да — в той же транзакции machine переходит в `booting`/`starting` (теперь она входит в `powered`), затем вызывается S1 `start`. Если нет — ждать с опросом 1 s (проверяя `superseded`, §7.1): вытесненные machine ещё останавливаются. Delete пишет `power_observed = stopped` сразу после S1 stop, поэтому ожидание — секунды.

### 8.3 Слоты клонирования

S1 ограничивает параллельные клоны на ноде (`clone_concurrency`, дефолт 4). Клоны идут из разных очередей (пул, create, fork), поэтому лимит — общий семафор в БД [решение S6]:

```
node_clone_slots(node_id, slot int, holder text null, expires_at null, primary key(node_id, slot))
```

Захват — `UPDATE … SET holder, expires_at = now() + 2 min WHERE node_id = $1 AND (holder IS NULL OR expires_at < now()) … LIMIT 1 FOR UPDATE SKIP LOCKED`. Освобождение в `finally`; потерянный слот истекает сам.

### 8.4 Размещение (multi-node готовность)

`place(templateSlug, sizeMb)`: ноды провайдеров `active`, нода `active`, есть `active`-сборка шаблона на этой ноде, хранилище ниже порогов (S1: data 80%, metadata 70%), admission проходит. Из подходящих — с наибольшей свободной RAM [решение S6]. Fork, resume и create из saved snapshot привязаны к ноде своих дисков. В PoC нода одна.

Каждая нода получает свой экземпляр клиентов `packages/pve` (PVE API провайдера и `sbx-node` ноды) из реестра в worker по `providers`/`nodes` и файлам Secret.

### 8.5 Квоты

Проверяются для create, fork (цель) и resume в той же транзакции, что и admission, под `pg_advisory_xact_lock(hash(team_id))`. Порядок блокировок всегда: команда, затем нода. Число sandbox команды в `creating`, `ready`, `starting`, `stopping` ≤ `maxActiveSandboxes`; их суммарная RAM ≤ `maxRamMb`; saved snapshots ≤ `maxSavedSnapshots` (при save). Ошибка `quota_exceeded`. Значения задаёт S8.

## 9. Warm pool

### 9.1 Цели

`poolTargets` из `ConfigReader`: `(templateSlug, sizeSlug, target)`. PoC: `linux/2GB = 1` (2 GB из 8, остальные 6 GB — под 3 sandbox).

### 9.2 Контроллер `pool` (раз в 10 s)

Для каждой цели и каждой ноды с `active`-сборкой шаблона (в PoC нода одна, цель целиком на ней):
1. `supply` = machine с этим `pool_key` и активной сборкой в состояниях `allocating`, `provisioning`, `booting`, `warm`.
2. `supply < target`: на каждую недостающую — admission без вытеснения; если да, machine `allocating` с `pool_key` и задание `machine-op provision`. Если RAM нет — ничего (пул ждёт).
3. `supply > target`: самые старые `warm` лишние → `deleting`.
4. Старое поколение (§9.4) и устаревшие (`warm_at` старше `maxAgeHours`, дефолт 24 h [решение S6]) — заменить: сначала заказать новую (если RAM позволяет), затем удалить старую; если RAM не хватает на обе — удалить старую первой.
5. `warm` machine, у которой агент отключён дольше 60 s, → `deleting` (её дешевле заменить, чем чинить).

### 9.3 Подготовка machine пула (`machine-op provision`)

§7.4 (включая проверку RAM и start), затем ожидание подключения агента и события фазы `pool_ready` (или ответа `System/Info` с готовностью, если S3 так решит), не дольше `boot_timeout_s`. Затем machine → `warm`, `warm_at`. При ошибке или тайм-ауте — `failed → deleting`.

### 9.4 Версии шаблона

Поколение пула — `template_build_id`. Claim берёт только machine с текущей `active`-сборкой пары. Когда S5 переводит новую сборку в `active`, старые `warm` этой пары заменяются по шагу 4. Sandbox на старой сборке не трогаются.

### 9.5 Claim

Атомарен в транзакции API (§7.3):

```sql
UPDATE runtime.machines SET state = 'claiming', sandbox_id = $sandbox, pool_key = NULL, claimed_at = now()
WHERE id = (SELECT id FROM runtime.machines
            WHERE state = 'warm' AND pool_key = $pair AND template_build_id = $activeBuild AND node_id = ANY($nodes)
            ORDER BY warm_at LIMIT 1 FOR UPDATE SKIP LOCKED)
RETURNING *;
```

Дальше worker: `rotate_token` (новый MT при claim, S2), `System/Claim`. Идентичность (`machineId`, BS в `smbios1`) у machine уже есть с момента подготовки, при claim она не меняется: machine одна на всю жизнь sandbox.

## 10. События агента

### 10.1 Приём

`POST /internal/v1/agent-events` (S2 §9.6) живёт в `apps/api` и вызывает `core.events.ingest(batch)`:
1. В одной транзакции: `INSERT … ON CONFLICT DO NOTHING` в `agent_events` или `agent_synthetic_events`; задание `machine-events {machineId}` (очередь с политикой `stately` и `singletonKey = machineId`: не больше одного ждущего и одного активного на machine).
2. Ответ `{ackedSeq}` = наибольший `seq` пачки (все строки пачки уже записаны).

### 10.2 Обработка (`machine-events`)

Обработчик читает все необработанные события machine (агентские по `seq`, синтетические по `time`) и применяет их идемпотентно, затем ставит `processed_at`. Текущее состояние подключения берётся из `tunnel_sessions`, а не из порядка событий (S2).

| Событие | Реакция S6 |
|---|---|
| `connected` (синт.) | если `health=degraded` → `ok`, `sandbox_events: recovered`; machine `booting` — отметить подключение |
| `disconnected` (синт.) | ничего сразу; правило degraded — контроллер `health` (§11.1) |
| `agent_restarted` (синт.) | запись в журнал; команды живы (S2) |
| `rebooted` (синт.) | `last_reboot_at`; команды этой machine с прошлым `boot_id` → `lost`; если sandbox `ready`, нет активной операции и новый `boot_id` (из `tunnel_sessions`) ≠ `provisioned_boot_id` → `reprovision` |
| `identity_changed` (синт.) | ожидается только при первом подключении fork-цели или VM из снапшота; иначе метрика тревоги `sbx_unexpected_identity_change` |
| `phase{pool_ready \| ready \| secrets_missing}` | `pool_ready` → machine `warm` (если ждёт); `secrets_missing` у `ready` sandbox с `boot_id` ≠ `provisioned_boot_id` → `reprovision` |
| `command.exited{commandId, status, code, signal, stdoutEnd, stderrEnd}` | терминальный статус команды, если ещё не терминальный |
| `pty.closed{commandId}` | статус команды PTY |
| `activity{runningCommands, openPtys, tcpStreams}` | счётчики, `activity`, `last_activity_at` (§12) |
| `ports.changed{listening[]}` | пока только сохраняется (для S7 `/ports`) |
| `quiesce.watchdog_thawed` | метрика тревоги; у снапшота в `creating` этой machine `quiesce_broken = true` (саму операцию не трогает: она проверит флаг после thaw, §7.7) |

Точные имена и payload событий агента задаёт S3; S6 требует набор выше (§16).

## 11. Здоровье и восстановление

### 11.1 Контроллер `health` (раз в 10 s)

Для `ready` sandbox, у machine которой `tunnel_sessions.state = disconnected` и `disconnected_at < now − 60 s` (или сессии нет, а у владельца-gateway протух heartbeat — S2 §7): `health = degraded`, `degraded_since`, `sandbox_events: degraded`. Дальше по шагам [решение S6]:
1. Проба QGA через PVE (`agent/ping`) и статус VM.
2. VM работает, QGA отвечает → `health_reason = agent_unreachable`; через 2 min в `degraded` — один раз перезапустить службу агента через QGA (`guest-exec`), не чаще раза в 10 min.
3. VM работает, QGA молчит → `vm_unresponsive`. Ничего не делаем сами: пользователь вызывает `recover`.
4. VM выключена → `health_reason = vm_stopped`, больше ничего: выключение обрабатывает только reconcile (§11.3), чтобы одно событие не посчиталось дважды.

`degraded` sandbox не останавливается и не перезагружается автоматически.

### 11.2 Контроллер `reconcile` (раз в 60 s на провайдера)

Читает: VM из `/cluster/resources` в pool `sandbox`, `sbx-node lv.list` (теги `sbx`), `vmid_leases`, `machines`, `disks`, `snapshots`. Ничего, что не в pool `sandbox`, без тега `sbx` или вне диапазона VMID, не трогает (защиты S1 дублируются в коде). Grace для «свежих» объектов — 10 min (дольше любого шага подготовки).

| Расхождение | Действие |
|---|---|
| VM в pool без строки machine (или machine `deleted`), старше grace | S1 `delete(vmid)`, метрика `orphan_vm` |
| LV `sbx-vm-N` без VM и без machine/disk; LV `sbx-snap-<id>` без снапшота в `creating`/`ready`, старше grace | `lv.remove`, метрика `orphan_lv` |
| machine не в `allocating`/`provisioning`/`deleting`/`deleted`, а VM нет, активной операции нет | machine `failed` (`lost`); sandbox этой machine → `error` (`machine_lost`) (§6.1) |
| machine `running`, VM выключена, активной операции нет | §11.3 |
| machine `stopped`, а VM работает (запустили руками) | S1 `shutdown`, метрика `power_drift` |
| `vmid_leases.releasing` | повтор проверки S1 delete, затем освобождение |
| machine `deleted`, а `tunnel_sessions` `connected` | выставить `retired_at` ещё раз, метрика |
| операция `running`/`pending` дольше дедлайна + 5 min без задания pg-boss в работе | заново поставить задание (обработчик сам выполнит компенсацию по дедлайну) |
| `pending`-операция старше 1 min без задания, без активного родителя (`parent_operation_id`) | заново поставить задание (если родитель активен, обработчик всё равно выйдет, §7.1) |

Режим `SBX_RECONCILE_DRY_RUN=1` только пишет, что сделал бы. В PoC первый запуск — в этом режиме.

### 11.3 Неожиданное выключение

VM machine в `running` выключена без нашей операции (пользователь сделал `shutdown`, гость упал). Обнаруживает только reconcile. В одной транзакции (блокировки команды и ноды): machine `running → stopped` (условный `UPDATE`, поэтому одно выключение обрабатывается один раз), `power_observed = stopped`, время добавляется в `unexpected_stops`. Затем:
- первый раз за час — системная операция `resume` (`requested_by = null`, квота не проверяется, admission как обычно), sandbox `ready → starting`. Если admission отказал — как во втором случае;
- второй раз за час — sandbox → `stopped` (`stop_reason = unexpected_shutdown`). Пользователь сам решает, делать ли resume.

## 12. Auto-stop: TTL и простой

Контроллер `autostop` (раз в 15 s):
- **TTL.** `deadline_at = (create или resume) + ttl_seconds`. При `deadline_at ≤ now` у `ready` sandbox → операция `stop` (`stop_reason = ttl`). Если TTL задан явно, он жёсткий: активность его не продлевает, продлевает только `extend` или `PATCH ttlSeconds`. **Дефолт — `null` (жёсткого TTL нет)**: главная защита от расходов — idle-stop, который считает активностью команды, PTY и TCP-потоки, поэтому долгие задачи агентов не убивает таймер по умолчанию. Boat продлевает дедлайн, пока работает prompt агента; у нас тот же эффект даёт отсутствие TTL по умолчанию.
- **Простой.** Sandbox — кандидат на остановку, если одновременно:
  - агент на связи, а последнее событие `activity` свежее (не старше 150 s, то есть пропущено не больше одного heartbeat) и показывает `runningCommands = 0`, `openPtys = 0`, `tcpStreams = 0`;
  - с момента, когда счётчики стали нулевыми, прошло `idle_timeout_seconds`;
  - с `last_api_call_at` прошло `idle_timeout_seconds`.

  Перед остановкой контроллер **проверяет живьём**: вызывает у агента `System/Activity` (без побочных эффектов, S3) и требует нули прямо сейчас. Только тогда — операция `stop` (`stop_reason = idle`). Так отставание конвейера событий не приводит к остановке занятой sandbox. Дефолт 900, `null` — без idle-stop.
- `runningCommands` включает detached-команды и любые процессы под shim (S2 §9.1), `openPtys` — PTY, живые с клиентом или без. Значит, долгая работа агента (coding-агент, сборка, `sleep` под shim) никогда не считается простоем.
- Агент недоступен (`activity = unknown`), событие `activity` устарело или живая проверка не удалась → idle-stop не срабатывает; TTL работает.
- `last_api_call_at` обновляет `api` на любом вызове по sandbox (не чаще раза в 30 s на sandbox, `UPDATE … WHERE last_api_call_at < now() − 30 s`).
- Агент шлёт `activity` при переходе любого счётчика между 0 и не-0 и раз в 60 s как heartbeat (S3, §16).

## 13. Безопасность

### 13.1 Env и секреты (решение Q7, согласовано master-сессией; Илья информирован и может пересмотреть)

- **Где хранятся.** Env и secret-файлы sandbox (из create и из PATCH, если S7 его даст) хранятся в `sandbox_secrets` в виде одного зашифрованного блоба `{env, secretFiles}`.
- **Шифрование.** AES-256-GCM через `node:crypto`, случайный 96-битный nonce на запись, AAD = `sandbox:<sandboxId>:v<keyVersion>`.
- **Ключи.** Кольцо из Kubernetes Secret, файл `SBX_DATA_KEYS_FILE`: `{"current": 2, "keys": {"1": "<base64>", "2": "<base64>"}}`. Ротация: новый ключ становится `current`, контроллер `cleanup` перешифровывает строки со старой версией, старый ключ убирается после нуля строк (метрика).
- **Доставка.** Секреты передаются агенту при каждом claim, resume, recover и reprovision (`System/Claim`). В госте они живут только в tmpfs (Linux) или в каталоге с ACL SYSTEM (Windows) и стираются при stop (S3).
- **Fork.** Наследует env и секреты источника: расшифровка и перешифровка с AAD цели. Saved snapshot секретов не несёт.
- **Delete.** Строка `sandbox_secrets` удаляется (crypto-erase для этой sandbox).
- **Утечки.** Значения не попадают в логи, `operations.request`, `idempotency_keys.response`, данные заданий pg-boss (там только id), метрики и `commands` (там только имена переменных). Логгер редактирует поля `env`, `secretFiles`, `bs`, `token`. Hash тела для `Idempotency-Key` считается от канонического тела вместе с секретами, но сам секрет не хранится.

### 13.2 Учётные данные machine

- BS генерируется в шаге подготовки (§7.4), в БД только `sha256` (S2). После первого старта VM не меняется.
- `retired_at` ставится первым шагом delete, до остановки VM: gateway закрывает туннель и отвечает `403`.
- MT ротируется при claim (`rotate-token`). При resume ротация не нужна: MT жил только в памяти агента, после загрузки агент снова предъявляет BS.

### 13.3 Прочее

- Worker — единственный компонент с токеном PVE и SSH-ключом `sbx-node` (Kubernetes Secret, S1 §6.1). `api` их не получает.
- Внутренние ручки `api` (`/internal/v1/*`) — только с service token (S2 §5.5) и только из сети кластера (NetworkPolicy, S12).
- Reconciler и cleanup удаляют только помеченное нами (§11.2).

## 14. Интерфейсы, которые S6 даёт другим областям

### 14.1 S7 (публичное API): `SandboxService` в `packages/core`

```ts
interface SandboxService {
  create(p: Principal, input: CreateInput, idemKey?: string): Promise<{ sandbox: Sandbox; operation: Operation }>
  get(p: Principal, id: string): Promise<Sandbox>
  list(p: Principal, filter: ListFilter, cursor?: string): Promise<Page<Sandbox>>
  update(p: Principal, id: string, patch: UpdateInput): Promise<Sandbox>   // name, labels, ttl, idle timeout
  extend(p: Principal, id: string): Promise<Sandbox>
  stop(p: Principal, id: string): Promise<Operation>
  resume(p: Principal, id: string, input: ResumeInput): Promise<Operation>
  fork(p: Principal, id: string, input: ForkInput, idemKey?: string): Promise<{ sandbox: Sandbox; operation: Operation }>
  recover(p: Principal, id: string): Promise<Operation>
  delete(p: Principal, id: string): Promise<Operation>
  saveSnapshot(p: Principal, id: string, name: string): Promise<Operation>
  deleteSavedSnapshot(p: Principal, name: string): Promise<void>
  listSavedSnapshots(p: Principal): Promise<SavedSnapshot[]>
  getOperation(p: Principal, id: string): Promise<Operation>
  waitForState(id: string, states: SandboxState[], timeoutMs: number): Promise<Sandbox> // LISTEN sbx_sandboxes
  // commands, files, ports
  resolveAgentTarget(p: Principal, id: string): Promise<{ machineId: string; capabilities: string[] }> // throws sandbox_not_ready
  createCommand(p: Principal, id: string, spec: CommandSpec): Promise<Command>   // row before Process/Start
  completeCommand(commandId: string, result: CommandResult): Promise<void>
  touchApiActivity(id: string): Promise<void>
  hostPort(p: Principal, id: string, port: number, mode: PortMode): Promise<{ hostedPort: HostedPort; token?: string }>
  unhostPort(p: Principal, id: string, port: number): Promise<void>
  rotatePortToken(p: Principal, id: string, port: number): Promise<{ token: string }>
}
```

Доменные ошибки (`SbxError{code, retryable, details}`), которые S7 отображает в HTTP: `not_found`, `invalid_state` (с текущим `state`), `operation_in_progress` (retryable, `operationId`), `out_of_capacity` (retryable, `retryAfterSeconds`), `quota_exceeded`, `idempotency_key_reused` (тот же ключ, другое тело), `template_unavailable`, `snapshot_not_found`, `sandbox_not_ready`, `recover_rate_limited`, `validation`.

Идемпотентность: тот же `(principal, scope, key)` с тем же hash тела → сохранённый ответ (та же sandbox и операция); с другим hash → `idempotency_key_reused`; параллельный дубль ждёт коммита первого (уникальный ключ в транзакции). Срок 24 h. Повтор без ключа создаёт новую sandbox.

`NOTIFY sbx_sandboxes '<sandboxId>'` шлёт триггер при смене `state` или `health`, для long-poll в S7 и дашборда S8.

### 14.2 S4 (gateway): маршруты и SSH

- `core.routes.lookup(label)` и ручка `GET /internal/v1/routes/{label}` в `api` → `{sandboxId, machineId, port, mode, tokenHash, authEpoch, state}`. `state` — состояние sandbox: gateway сам решает, что показать для не-`ready` (страница «остановлена» и т.п.). Метка — `<slug>-<port>`; `slug` только `[a-z0-9]`, поэтому номер порта — всё после последнего `-`.
- `NOTIFY sbx_routes '<label>'` при изменении `hosted_ports`; при смене `state` или `machine_id` sandbox — по одному уведомлению на каждую её метку (триггеры).
- `POST /internal/v1/ssh/authorize {sandbox, user, publicKeyFingerprint}` → `{allowed, machineId, state}`. S6 даёт разрешение sandbox и её состояние; проверка ключа против ключей пользователя и прав на sandbox — S7/S8 (ключи и доступы в Payload).
- Обмен SSO-кода для режима `sso` — S7/S8, не S6.

Автоматический resume при обращении к URL остановленной sandbox в фазе 1 не делается.

### 14.3 S5: регистрация сборок

S5 пишет `template_builds` (через `sbx-admin template register|promote` или прямую вставку в миграции): `template_slug`, `version`, `node`, `pve_vmid`, `disk_layout`, `hw`, `agent_version`, `boot_timeout_s`; затем `promote` (старая `active` → `deprecated`). Пул обновится сам (§9.4).

### 14.4 S8: что S6 ждёт от Payload

См. §16.

## 15. Worker

### 15.1 Очереди pg-boss [решение S6 по параметрам]

| Очередь | Политика | Ключ | Данные | Параметры |
|---|---|---|---|---|
| `sandbox-op` | `singleton` | `sandboxId` | `{operationId}` | `heartbeatSeconds 30`, `expireInSeconds 3600`, `retryLimit 20`, `retryBackoff`, `retryDelay 2`, `retryDelayMax 120`, dead letter `sandbox-op-dlq` |
| `machine-op` | `singleton` | `machineId` | `{machineId, action: provision \| delete}` | как выше |
| `snapshot-op` | `singleton` | `snapshotId` | `{snapshotId, action: delete}` | как выше |
| `machine-events` | `stately` | `machineId` | `{machineId}` | `retryLimit 10`, `retryBackoff` |
| `ctl-pool`, `ctl-health`, `ctl-autostop`, `ctl-reconcile`, `ctl-cleanup` | `exclusive` | — | `{}` | см. ниже |

- Задание операции — только триггер; источник правды — строка `operations`. Повторная доставка безопасна (§7.1).
- **Fencing.** Singleton и heartbeat pg-boss не защищают от зависшего пода, который потерял связь с БД, но ещё ходит в Proxmox: задание вернётся, и исполнителей станет два. Поэтому каждый обработчик при старте увеличивает счётчик (`operations.attempt`, `machines.exec_attempt` для `machine-op`) и пишет каждый шаг условно по своему значению (§7.1). Старый исполнитель на первой же записи получает ноль строк и выходит. Его вызов Proxmox в полёте безвреден: шаги идемпотентны, аллокатор выдаёт одной machine один lease (§5.3), а частичная подготовка выбрасывается при повторе (§7.4).
- Задание в dead letter означает исчерпанные повторы: операция → `failed` с `error_code = retries_exhausted` и компенсацией, метрика тревоги. Для delete dead letter не используется: `retryLimit` без предела, alert по `sbx_delete_stuck`.
- **Контроллеры.** Каждый контроллер — очередь `exclusive` (не больше одного ждущего или активного задания во всём кластере). Задание в конце ставит себя снова с `startAfter` (10 s пул и health, 15 s autostop, 60 s reconcile, 10 min cleanup). Страховка — cron pg-boss раз в минуту на каждую очередь (`exclusive` отбрасывает дубль). Выбор лидера не нужен.
- **Heartbeat.** Долгие шаги (ожидание загрузки, shutdown) идут в заданиях с `heartbeatSeconds 30`. Если под умер, задание вернётся через ~30 s, и шаги продолжатся с последнего записанного.

### 15.2 Масштабирование и завершение

- Deployment `worker`, 2 реплики в production, 1 в PoC. pg-boss работает в multi-master режиме.
- `localConcurrency` на под: `sandbox-op` 16, `machine-op` 8, `snapshot-op` 4, `machine-events` 8, контроллеры 1. Общая нагрузка на Proxmox ограничена слотами клонирования (§8.3), а не числом подов.
- SIGTERM: `boss.stop({ graceful: true, timeout: 60_000 })`, `terminationGracePeriodSeconds: 90`. Незавершённые задания вернутся по heartbeat; шаги идемпотентны.
- Readiness: pg-boss запущен и Postgres отвечает. Liveness: цикл событий не завис.
- Пул соединений: `pg` Pool на под, 20 соединений (pg-boss и Drizzle делят один пул через адаптер) [решение S6].

### 15.3 `sbx-admin`

CLI в `apps/worker` (тот же образ): `providers add`, `nodes add|cordon|uncordon`, `template register|promote`, `pool status`, `reconcile --dry-run`, `op retry <id>`, `machine delete <id>`. Нужен в PoC до S8.

### 15.4 Cleanup (раз в 10 min)

- `idempotency_keys` старше `expires_at`; `agent_events` и синтетические старше 7 дней; `commands` старше 90 дней; надгробия `deleted` sandbox старше 30 дней; `sandbox_events` старше 90 дней.
- Страховка для `fork_source` (основной путь — §7.7): снапшоты в `ready`/`failed`, чья цель в `error`/`deleted`, и любые `fork_source` старше 1 h → удалить.
- Sandbox `error` без machine и без дисков старше `errorRetentionDays` (7) → delete.
- Если задан `stoppedRetentionDays` — sandbox в `stopped` дольше этого срока → delete (`stop_reason` сохраняется в событиях как `retention`). По умолчанию выключено.
- Перешифровка `sandbox_secrets` со старой версией ключа.
- Задания pg-boss чистит сам pg-boss (`deleteAfterSeconds` 7 дней).

## 16. Допущения о других областях

- **S1.** `packages/pve` как в спеке S1: `create`/`fork` принимают `smbios1`, `snapshot` принимает `QuiesceHook`, `delete` с проверкой и освобождением lease, `AllocatorStore` подменяемый, `usage()`, `start`/`shutdown`/`stop`, QGA `ping`. Небольшие дополнения, которые S6 добавляет в `packages/pve` сам, согласовав с `s1-impl`:
  - `AllocatorStore.allocate` получает `ownerId` (= `machineId`), чтобы реализация S6 была идемпотентной по machine (§5.3);
  - `configure(vmid, {cores, memory})` для resize выключенной VM (§7.6);
  - чтение статуса одной VM и пакетное чтение всех VM pool (`/cluster/resources`) для reconcile;
  - `lv.list` по тегам наружу (для reconcile);
  - QGA `exec` через PVE API (перезапуск агента, §11.1);
  - фабрика клиентов на (провайдер, нода) вместо глобальной конфигурации из env (§8.4); env S1 остаётся для `apps/bench`.
- **S2.** Таблицы `tunnel.*`, `POST /v1/machines/{id}/rotate-token` на внутреннем listener-е gateway, синтетические события, `agent-client` с повторами и ожиданием до 30 s.
- **S3.** RPC (имена — S3):
  - `System/Claim{reason: claim | resume | recover, sandboxId, hostname, env, secretFiles, authorizedKeys}` — идемпотентен по `requestId`, отвечает после применения (или стримит фазы, итог `ready`);
  - `System/PrepareStop` — best effort;
  - `System/Quiesce` с lease и watchdog и `Thaw` — реализация `QuiesceHook`;
  - `System/Info` — версия, capabilities, фаза готовности;
  - `System/Activity` — текущие `{runningCommands, openPtys, tcpStreams}`, `NO_SIDE_EFFECTS` (живая проверка перед idle-stop, §12);
  - события: `phase{pool_ready | ready | secrets_missing}`, `command.exited`, `pty.closed`, `activity{runningCommands, openPtys, tcpStreams}` (на переходах 0 ↔ не-0 и раз в 60 s), `ports.changed`, `quiesce.watchdog_thawed`;
  - смена идентичности при новом `machineId` (fork, VM из снапшота).
- **S4.** Использует §14.2. Счётчик `tcpStreams` даёт агент (он сервер CONNECT), gateway ничего для activity не шлёт.
- **S5.** Регистрирует сборки (§14.3). Шаблон содержит агента и qemu-guest-agent.
- **S7.** Строит HTTP поверх `SandboxService`; создаёт `commands` до `Process/Start`; вызывает `touchApiActivity`; выставляет внутренние ручки §10.1 и §14.2; формат id и ошибок.
- **S8.** Коллекции: Templates (`slug`, `os`, `enabled`, `defaultSize`, `allowedSizes`), Sizes (`slug`, `vcpu`, `memoryMb`), PoolTargets, Quotas (на команду), PlatformDefaults (глобальная настройка); `afterChange`-хуки шлют `NOTIFY sbx_config`; Payload-конфиг экспортируется пакетом без Next, чтобы `api` и `worker` вызывали `getPayload`. Публичные SSH-ключи пользователя для `authorizedKeys`.
- **S9.** Дедлайны Windows (§7.9), `boot_timeout_s`, VSS как `QuiesceHook`.
- **S12.** Deployment `worker` (2 реплики, grace 90 s), Secret с ключами данных (`SBX_DATA_KEYS_FILE`), Secret PVE и `sbx-node`, NetworkPolicy для `/internal/v1/*`, Postgres 18.

## 17. Библиотеки

Версии проверены 2026-10-29 (`npm view`); при реализации перепроверить и взять последние стабильные.

| Назначение | Библиотека | Версия |
|---|---|---|
| Очередь заданий | `pg-boss` | 12.38.0 |
| ORM (типы и запросы) | `drizzle-orm` | 0.45.4 (та же линия, что у `@payloadcms/db-postgres` 3.92.1); `drizzle-kit` 0.31.11 — по желанию исполнителя только как помощник для генерации SQL, источник правды — файлы в `db/migrations/` |
| Драйвер Postgres | `pg` | 8.23.1 (общий для pg-boss и Drizzle) |
| Payload Local API | `payload` | 3.92.1 |
| Валидация | `zod` | 4.6.7 |
| Postgres | — | 18.6 (19 ещё RC, GA планируется 2026-11-19) |
| ULID для `commandId` | `ulid` | 3.0.2 |

Отвергнуто: `graphile-worker` 0.18.0. Он хорош, но в нём нет глобального лимита параллельности по группе, нет политик `singleton`/`stately`/`exclusive` из коробки и транзакционной отправки через Drizzle-адаптер, а архитектура уже предполагает pg-boss. Kysely (0.29.7) не берём, чтобы не держать второй слой запросов рядом с Drizzle Payload.

## 18. Тесты и приёмка

**Unit (vitest):**
- таблицы переходов Sandbox, Machine, Operation: каждый недопустимый переход отклоняется; инварианты §6.4 проверяются property-тестами на случайных последовательностях событий;
- admission и вытеснение, слоты клонирования, идемпотентность (тот же и другой hash), шифрование (AAD, ротация ключей), разбор метки маршрута.

**Интеграционные** (реальный Postgres 18 в контейнере, pg-boss, фейки S1 `packages/pve` и `agent-client`/gateway):
- **Матрица падений.** Для каждой операции и каждого шага: падение после побочного эффекта, до записи `step`. Повтор доводит до конца, в фейке Proxmox нет лишних VM и LV, нет висящих lease.
- **Конкурентность.** Два процесса worker, 30 параллельных create при лимите RAM на 3 machine: не больше 3 приняты, остальные `out_of_capacity`; `reserved` и `powered` (§8.1) ни разу не превысили лимит (проверка после каждой транзакции). То же с вытеснением warm. Параллельные create одной команды не превышают квоту. Delete во время create, cold create, fork (в том числе пока цель ждёт снапшот). Двойной `Idempotency-Key`.
- **Fencing.** Два исполнителя одной операции (второй стартует по истечении heartbeat первого): первый выходит на первой записи шага, в фейке Proxmox одна VM и один lease.
- **Пул.** Заполнение до цели, замена при новой сборке, вытеснение warm другой пары под create, удаление warm при отключённом агенте.
- **События.** Дубли и перестановки событий, `rebooted` переводит команды в `lost`, degraded через 60 s и обратно.
- **Auto-stop.** Idle не срабатывает при `runningCommands > 0`, при открытом PTY, при `tcpStreams > 0`, при свежем вызове API и при недоступном агенте; TTL срабатывает всегда.
- **Reconcile.** Внедрённые сироты (VM, LV, lease `releasing`) убираются; чужие объекты (VM вне pool, LV без тега) не трогаются.

**E2E на `pve`** (после S3, S4, S5): сценарий `sbx-bench s6` в `apps/bench`:
- пул заполняется;
- create из пула → exec → stop → resume → exec;
- fork работающей sandbox: маркер-файл на месте, идентичность новая;
- save snapshot → create из него;
- cold create при пустом пуле;
- delete всего;
- внедрённая сирота убирается reconcile;
- «мир до» и «мир после» совпадают (S1 `inventory`).

Замеры: claim-to-ready, cold create, stop, resume, fork, save snapshot (median и p95).

**Критерий готовности S6:** проходят unit и интеграционные тесты; сценарий E2E на `pve` проходит в пределах 8 GB, после него не остаётся следов.

## 19. Этапы реализации

План пишется отдельно (`docs/plans/s6-*.md`). Рекомендуемый порядок:
1. **PoC:** `packages/db`, `packages/core` (состояния, admission, идемпотентность, шифрование), `packages/config` (static), worker с `sandbox-op`/`machine-op`, create (claim + cold), delete, пул, приём событий, health, reconcile (dry-run, потом включить).
2. **MVP:** stop/resume, fork, saved snapshots, recover, auto-stop, cleanup, `PayloadConfigReader` (после S8), ручки для S4.

## 20. Оставлено исполнителю

- Раскладка файлов внутри пакетов, генерация id (`uuidv7()` в БД или в коде), формат канонического тела для hash идемпотентности.
- Тестовая инфраструктура Postgres (testcontainers, сервис CI или PGlite для unit, если pg-boss и Drizzle работают с ней одинаково).
- Библиотеки логов и метрик (`pino`, `prom-client` или OTel SDK) — последние стабильные; список метрик: размер пула по паре и состоянию, длительность и исход операций по виду, причины ошибок, занятая RAM и лимит по ноде, действия reconcile, число `degraded`, глубина очередей pg-boss, отставание обработки событий, `sbx_delete_stuck`.

## 21. Ответы на открытые вопросы (master-сессия, 2026-10-29)

1. **TTL.** Явно заданный TTL остаётся жёстким, но дефолт — `ttlSeconds = null`. Основная защита от расходов — idle-stop 900 s (§12).
2. **Хранение остановленных sandbox.** В PoC лимита по умолчанию нет (`stoppedRetentionDays` выключен).
3. **Запуск остановленной sandbox при обращении к её URL** — фаза 2.

Остаётся на фазу 2: перенос sandbox между нодами и архив остановленных в PBS потребуют новой machine у той же sandbox; модель 1:N это уже допускает.
