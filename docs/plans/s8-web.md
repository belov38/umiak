# S8 Web (Payload): план реализации

> **Для исполнителей:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (по задаче на субагента, после каждой задачи — ревью свежим субагентом) и superpowers:test-driven-development. Шаги — чекбоксы `- [ ]`.

**Цель:** реализовать MVP S8 по `docs/specs/s8-web.md`: `packages/payload` (коллекции, хуки `NOTIFY`, JIT, `PayloadIdentityStore`, `PayloadConfigReader`, синхронизация с Keycloak), `apps/web` (Next.js 16 + Payload 3: `/admin`, `/cms-api`, дашборд `/app`, server actions, dev-прокси), операторские ручки C3 в `apps/api`/`packages/core`, переключение `api` и `worker` на Payload, `web` в `deploy/compose` и `infra/dev-cp`, E2E на Playwright.

**Архитектура:** Payload владеет схемой `payload` (Postgres, `@payloadcms/db-postgres`, `push: false`, миграции в `packages/payload/src/migrations`). `api`, `worker` и `web` поднимают один конфиг через `getSbxPayload()` (Local API, без Next). Хуки коллекций шлют `NOTIFY` в транзакции запроса Payload. Дашборд — клиентские страницы на `@sbx/sdk` (`baseUrl: "/api"`, тот же origin за oauth2-proxy) и TanStack Query; команды и участники — server actions на Local API.

**Стек:** Node 26.13.0 (type stripping, импорты `.ts`), TypeScript 7.0.2, vitest 5.0.5, biome 2.6.4. Проверено `npm view` 2026-10-31 (совпадает с §16 спеки): `payload`, `@payloadcms/next`, `@payloadcms/db-postgres`, `@payloadcms/ui` 3.92.1; `next` 16.4.3; `react`/`react-dom` 19.3.1; `tailwindcss`/`@tailwindcss/postcss` 4.3.3; `shadcn` 4.23.0 (CLI); `@tanstack/react-query` 5.105.0; `@xterm/xterm` 6.0.0, `@xterm/addon-fit` 0.11.0, `@xterm/addon-web-links` 0.12.0, `@xterm/addon-search` 0.16.0; `@playwright/test` 1.64.1; `zod` 4.6.7; `graphql` ^16 (peer Payload). oauth2-proxy v7.15.5, Keycloak 26.8.1, Postgres 18.6.

**Спецификация:** `docs/specs/s8-web.md` (источник истины; § ниже — из неё). Смежные: S7 §7, §17.3, §23 (что уже сделано из C1–C10), S6 §5.11, §15, S4 §6.1, §9.5, `apps/api/README.md`, `deploy/compose/README.md`, `infra/dev-cp/README.md`.

## Глобальные ограничения

- Инструменты только через mise (`mise exec -- <cmd>`). Перед добавлением зависимости — `npm view <pkg> version`; версии выше.
- Пакеты в стиле репозитория: `"exports": {".": "./src/index.ts"}`, без `enum`, `namespace`, parameter properties (type stripping); импорты с `.ts`. `apps/web` — исключение: его собирает Next (`transpilePackages` для `@sbx/*`).
- Новые пакеты: `packages/payload` (`@sbx/payload`), `apps/web` (`@sbx/web`). В корневых файлах — только свои строки.
- Миграции runtime: изменения таблиц S6 — `db/migrations/02NN_*` (следующий свободный — `0206`); новые таблицы S8 — `04NN_*` (диапазон `0400–0499` записать в `docs/roadmap.md`). Миграции схемы `payload` — только Payload (`packages/payload/src/migrations`).
- Публичные ID (`usr_`, `team_`, `key_`, `sshk_`) — только кодеки `@sbx/auth` (`encodeUuid`/`decodeUuid`) поверх UUID Payload.
- `failFast`/`pool_exhausted`/`warmAvailable` не появляются нигде: ни в UI, ни в API, ни в типах дашборда.
- Права оператора — только у браузерной сессии (`Principal.kind === "session"`); ни командный ключ, ни Keycloak JWT их не дают (C6, уже в S7). Операторские ручки C3 — `403 forbidden` для всех остальных.
- Ни одного кода «dev auth» в `apps/web/src`, `apps/api`, `packages/*`: заголовки ставит только oauth2-proxy или `apps/web/dev/auth-proxy.ts`, который не входит в образ.
- Ничего Tailscale-специфичного в `apps/` и `packages/`; адреса dev-стенда — только в `infra/dev-cp/`.
- Значения секретов (env-секреты, secret-файлы, секрет ключа после показа, токен порта после показа, `secretHash`) не попадают в ответы `web`/`/cms-api`, логи, `localStorage`, URL.
- Postgres в тестах — `@sbx/db/testing/global-setup` (как S6/S7). На `pve` и CT 590 ничего не запускать и не трогать.
- Комментарии в коде на английском. Коммиты без `Claude-Session:` и ссылок claude.ai.

## Решения исполнителя (отклонения и уточнения спеки)

1. **Хранилище личностей — схема `payload`, данные `identity` переносятся.** Payload не умеет жить поверх таблиц S7 (свои имена столбцов, `updated_at`, служебные таблицы, `id` у членств), поэтому `identity` как бэкенд не годится. Первая миграция Payload после создания таблиц копирует `identity.teams/users/memberships/api_keys/ssh_keys` с теми же UUID (`INSERT … SELECT … ON CONFLICT DO NOTHING`, если `to_regclass('identity.users')` не `NULL`). Схема `identity` и `PgIdentityStore` остаются (контрактная фаза — отдельным релизом; `PgIdentityStore` — эталон контрактного набора в тестах `packages/auth`). Переход со stand-in — однократный шаг с остановкой `api` (старый код пишет в `identity`); дальше миграции expand/contract (§12).
2. **Environments переезжают в `runtime.environments`** (`0400_environments_runtime.sql`, §10.3): у `identity.environments` внешние ключи на `identity.teams/users`, а команды теперь в `payload`. Таблица без внешних ключей, данные копируются, `PgEnvironmentStore` (`packages/auth`) читает новую таблицу. Колонки `sandboxes.environment_*`/`exclude_owner_secrets` (S6 S1) не добавляются: остаётся решение 7 S7 (`environment: null`, `excludeOwnerSecrets: true` → `400`).
3. **`NOTIFY` — из хуков Payload** в транзакции операции (`afterChange`/`afterDelete`; сессия адаптера по `req.transactionID`; без транзакции — своя короткая). Один хелпер `notify(req, channel, payload)`. Payload-ы: `sbx_identity` — `'<collection>:<uuid>'` (у `memberships` — id членства), `sbx_ssh_revoke` — как триггеры `0302`/`0303`: `user:usr_…`, `member:team_…:usr_…`, `key:key_…`, `team:team_…`.
4. **`PayloadConfigReader` живёт в `@sbx/payload`**, а не в `packages/config`: иначе цикл `config → payload → config` (типы `ConfigReader` из `@sbx/config`). Контрактный набор `ConfigReader` — в `@sbx/config/testing`, его проходят `StaticConfigReader` и `PayloadConfigReader`.
5. **`api` и `worker` в проде берут личности и конфиг только из Payload.** `SBX_CONFIG_FILE` у `api` и `worker` больше не нужен (у `sbx-admin bootstrap` — остаётся, это топология). `SBX_IDENTITY_FILE` у `api` сохраняется: тот же YAML грузится upsert-ом в Payload (`seedPayloadIdentity`). Новые env: `PAYLOAD_SECRET` (`api`, `worker`, `web`). Тесты `api` по-прежнему собирают зависимости через `makeTestDeps` (Pg-store), отдельный тест — `buildDeps` с Payload.
6. **Миграции Payload** применяет свой скрипт `node packages/payload/src/migrate.ts` (`getSbxPayload` + `payload.db.migrate()`), а не CLI `payload migrate` (CLI грузит конфиг своим загрузчиком). В compose — одноразовый сервис `web-migrate` (образ `web`) до `api`, `worker`, `web`. `assertPayloadMigrated(payload)` — в `/readyz` `api` и `worker`, в `/healthz` `web`.
7. **ID Payload — `idType: "uuid"`.** Если адаптер 3.92.1 поддерживает `uuidv7`, берём его; иначе `uuid` (v4) и запись в §21: кодеки 128-битные, порядок по времени для ключей и команд не нужен (сортировка по `created_at`).
8. **Кэш `resolveSession` в `web`** — 30 s по `sha256(email + groups + user)`, сброс по `LISTEN sbx_identity` (одно соединение на процесс). В `api` кэш уже есть (`SessionResolver`).
9. **ctl-idp-sync:** логика — `KeycloakIdpSync` в `@sbx/payload`, провод — `apps/worker` (контроллер уже есть, регистрируется при заданном `SBX_IDP_SYNC_KEYCLOAK_URL`). Env: `SBX_IDP_SYNC_KEYCLOAK_URL` (внутренний адрес Keycloak), `SBX_IDP_SYNC_REALM` (`sbx`), `SBX_IDP_SYNC_CLIENT_ID` (`sbx-worker`), `SBX_IDP_SYNC_CLIENT_SECRET_FILE`. Тревога — метрика-счётчик `sbx_idp_sync_aborted_total{reason}` и gauge `sbx_idp_sync_aborted` (1 после отмены, 0 после удачного прохода) + `log.error`.
10. **E2E-стек** — compose-оверлей `deploy/compose/e2e.yaml`: настоящие Keycloak, oauth2-proxy, Postgres, `web`, `web-migrate`; вместо `api` и `worker` — контейнер `e2e-backend` (`apps/web/e2e/backend/main.ts`): `api` (`startApi`) с `FakeAgent` и `worker` с фейковым миром PVE (`apps/worker/test/fakes`) в одном процессе, слушает те же порты, что `api`. Gateway в E2E не нужен: маршрут `blocked` проверяется по `GET /internal/v1/gateway/routes/{label}`.
11. **Выход из системы** — ссылка `/oauth2/sign_out?rd=<Keycloak logout>`; адрес logout — env `SBX_LOGOUT_URL` у `web` (в compose задаётся).
12. **Удаление команды** в `/admin` — custom-кнопка на странице команды: проверка из браузера оператора (`/api/v1/sandboxes?allTeams=true&teamId=…&limit=1`, `/api/v1/snapshots`, `/api/v1/environments` с `Sbx-Team`) и затем `DELETE /cms-api/teams/:id`. Хук `beforeDelete` удаляет членства и отзывает ключи (§6.4).

## Review Focus

1. **Поддельные `X-Auth-Request-*` от клиента.** Ожидание: dev-прокси и oauth2-proxy их вырезают; `web` без заголовков — `401`; прямой запрос на `web:3000` из другой сети невозможен (compose: `web` только во внутренней сети с oauth2-proxy). Тест — задачи 9, 15.
2. **Server action с чужим `teamId`/`membershipId`** (команда, где пользователь `member` или не состоит). Ожидание: `{error:{code:"forbidden"}}`, ничего не меняется; так же для `acknowledgeNotice` чужой команды. Тест — задача 10 (матрица по §6.2).
3. **Гонка первых входов и смена email в IdP** (10 параллельных `resolveSession`, email занят заготовкой). Ожидание: один пользователь, одна личная команда, членства заготовки перенесены. Тест — задача 3 (контракт + свои).
4. **Keycloak отдал пустой или урезанный список** (ошибка конфигурации, обрыв посреди страниц). Ожидание: ни одной деактивации, `sbx_idp_sync_aborted`; обрыв — исключение, а не частичное применение. Тест — задача 8.
5. **Заблокированная sandbox и обходные пути** (fork, save snapshot, rename slug, `PATCH /env`, снятие и повторная публикация заблокированного порта, вызов по командному ключу). Ожидание: `403 sandbox_blocked`/`port_blocked`; stop, delete, чтение — работают. Тест — задача 7.

---

### Task 1: `packages/payload` — конфиг, коллекции, миграции

**Files:**
- Create: `packages/payload/{package.json,tsconfig.json,vitest.config.ts,README.md}`, `src/index.ts`, `src/config.ts`, `src/access.ts`, `src/collections/{users,teams,memberships,api-keys,team-notices,ssh-keys,templates,sizes,pool-targets}.ts`, `src/globals/platform-defaults.ts`, `src/instance.ts`, `src/migrate.ts`, `src/migrations/{index.ts,<ts>_initial.ts}`
- Test: `packages/payload/test/{migrations,schema,access}.test.ts`

**Interfaces:**
- Produces:
  - `interface SbxPayloadOptions { databaseUrl: string; secret: string; operatorGroups: string[]; appOrigin?: string; poolMax?: number }`
  - `buildSbxConfig(o: SbxPayloadOptions): Promise<SanitizedConfig>` — `db: postgresAdapter({schemaName:"payload", idType, push:false, migrationDir, prodMigrations: undefined})`, `graphQL:{disable:true}`, `routes:{api:"/cms-api", admin:"/admin"}`, `csrf:[appOrigin]`, `cookiePrefix:"__Host-payload"`, `admin.user:"users"`; без React-импортов (компоненты админки — строками путей import map из `apps/web`).
  - `getSbxPayload(o: SbxPayloadOptions): Promise<Payload>` — кэш экземпляра на процесс (по `databaseUrl`).
  - `migrateSbxPayload(p: Payload): Promise<void>`; `pendingPayloadMigrations(p): Promise<string[]>`; `assertPayloadMigrated(p): Promise<void>` (бросает со списком непрменённых; неизвестные коду применённые — допустимы).
  - `src/migrate.ts` — CLI: `DATABASE_URL`, `PAYLOAD_SECRET` → миграции, выход 0/1.
  - Коллекции/global (slug и поля — §7 спеки, буквально): `users`, `teams`, `memberships`, `api-keys`, `team-notices`, `ssh-keys`, `templates`, `sizes`, `pool-targets`, global `platform-defaults`. Многозначные — `json` или `select hasMany` без отдельных таблиц. `access`: всё `isOperatorReq(req)`; `api-keys.create` — `() => false` всем; `users.delete` — только заготовки без `lastLoginAt` и членств.
  - `isOperatorReq(req): boolean` (`req.user?.isOperator === true`).
- Миграция `<ts>_initial.ts`: схема `payload`, таблицы, сиды `platform-defaults` (S6/S7/S8 значения по умолчанию §7: `idleTimeoutSeconds 900`, `errorRetentionDays 7`, `recoverMinIntervalSeconds 600`, `maxTtlSeconds` как в `deploy/compose/config/sbx.yaml`/`StaticConfigReader` по умолчанию, `defaultTemplate "linux"`, `publicPortsEnabled true`, `ssoPortPolicy "any"`, `rateLimits {20, 100, 30}`, `defaultQuota {3, 6144, 10}`, `newSharedTeamQuota = defaultQuota`, `maxOwnedTeamsPerUser 3`, `ssoPolicyEpoch 0`), шаблон `linux` (`defaultSize "2gb"`, `allowedSizes ["2gb"]`, `capabilities ["exec","files","ssh"]`), размер `2gb` (2 vCPU, 2048 MB), цель пула `linux/2gb = 1`; копия данных `identity` (решение 1).

- [ ] **Step 1: тесты.** `migrations.test.ts`: чистая БД → `migrateSbxPayload` → `pendingPayloadMigrations` пусто, повторный запуск — без изменений; сиды на месте; с заполненной схемой `identity` (применить `db/migrations` до `0303` и вставить 2 пользователя, команду, членство, ключ, SSH-ключ) — после миграции те же UUID в `payload.*`; `assertPayloadMigrated` на пустой БД бросает. `schema.test.ts`: после `db/migrations` и миграций Payload множества имён таблиц `payload` ∩ (`runtime` ∪ `tunnel` ∪ `pgboss`) пусто; дрейф — генерация миграции по текущему конфигу (`payload.db.createMigration` с `skipEmpty`) не создаёт файла. `access.test.ts` (Local API с `overrideAccess:false` и `user` без `isOperator`): `find`/`create`/`update`/`delete` каждой коллекции и `findGlobal`/`updateGlobal` → `Forbidden`; оператор читает; `create api-keys` запрещён и оператору.
- [ ] **Step 2: прогнать — FAIL** (`mise exec -- pnpm --filter @sbx/payload test`).
- [ ] **Step 3: реализовать;** начальную миграцию сгенерировать (`payload migrate:create` или `payload.db.createMigration`), затем дописать сиды и копию `identity`. Проверить `idType` (решение 7) и `cookiePrefix`; что не сработало — записать в README пакета.
- [ ] **Step 4: PASS;** `typecheck`, `pnpm lint`.
- [ ] **Step 5: commit** `payload: config, collections, initial migration`.

### Task 2: хуки `NOTIFY` и правила коллекций

**Files:**
- Create: `packages/payload/src/notify.ts`, `src/hooks/{identity,config,routes,ssh-revoke,rules}.ts`
- Modify: коллекции и global из задачи 1
- Test: `packages/payload/test/{notify,rules}.test.ts`

**Interfaces:**
- Consumes: задача 1.
- Produces: `notify(req: PayloadRequest, channel: "sbx_identity"|"sbx_config"|"sbx_routes"|"sbx_ssh_revoke", payload: string): Promise<void>` — `pg_notify` в сессии `req.transactionID`; без транзакции — своя короткая. Ошибка бросается (запись откатывается).
- Правила (§8, §6.2, §6.4, §7): `sbx_identity` — `users`, `teams`, `memberships`, `api-keys`, `ssh-keys` (только если изменилось что-то кроме `lastUsedAt`/`lastLoginAt`/`updatedAt`); `sbx_config` — `templates`, `sizes`, `pool-targets`, `teams` (если менялась `quota` или удаление), `platform-defaults` (`'platform-defaults:global'`); `sbx_routes '*'` — изменились `publicPortsEnabled` или `ssoPortPolicy`; переход `ssoPortPolicy any→team` увеличивает `ssoPolicyEpoch` (`beforeChange`), поле read-only в админке. `sbx_ssh_revoke` — `users` стал `active:false` → `user:usr_…`; `memberships` `afterDelete` → `member:team_…:usr_…`; `api-keys` получил `revokedAt` или сменился `secretHash` у неотозванного → `key:key_…`; `teams` `afterDelete` → `team:team_…`. Правило последнего `owner` (`memberships` `beforeChange` при снятии роли, `beforeDelete`) → `APIError("last_owner", 400)`; `teams.beforeDelete` — запрет удалять личную, удаление членств и `revokedAt` всех ключей команды; `templates`: `defaultSize ∈ allowedSizes`, размеры существуют, slug неизменяем; `sizes`: slug неизменяем, удаление размера из шаблона или цели пула запрещено; `users`: удаление — только заготовки (`idpSubject` null, `lastLoginAt` null, без членств); `api-keys`: в `update` админки менять можно только `revokedAt` (ставит `revokedBy = req.user`).

- [ ] **Step 1: тесты** (`LISTEN` отдельным клиентом `pg`): изменение через Local API с `req` в транзакции — уведомление приходит только после `commitTransaction`, слушатель в обработчике читает новые данные; `killTransaction` — уведомлений нет; `updateGlobal publicPortsEnabled:false` → `sbx_config` и `sbx_routes '*'`; `ssoPortPolicy any→team` → `ssoPolicyEpoch +1`; деактивация пользователя → `sbx_ssh_revoke 'user:usr_…'` (кодек); удаление членства → `member:team_…:usr_…`; отзыв ключа → `key:key_…`; `touch` (`lastUsedAt`) — без `sbx_identity`. `rules.test.ts`: последний `owner` — снять роль и удалить нельзя (`last_owner`), с двумя — можно; личную команду удалить нельзя; удаление общей команды удаляет членства и отзывает ключи; шаблон с `defaultSize` вне `allowedSizes` — ошибка валидации; смена slug шаблона/размера — ошибка; удаление размера, указанного в шаблоне, — ошибка.
- [ ] **Step 2–4: FAIL → реализация → PASS.**
- [ ] **Step 5: commit** `payload: notify hooks and collection rules`.

### Task 3: `resolveSession`, `PayloadIdentityStore`, контрактный набор

**Files:**
- Create: `packages/payload/src/identity/{headers,resolve-session,store,seed}.ts`, `src/testing.ts` (export `./testing`)
- Test: `packages/payload/test/{headers,resolve-session,identity-contract}.test.ts`

**Interfaces:**
- Consumes: задачи 1–2; `IdentityStore`, `IdentityError`, `SessionHeaders`, `runIdentityStoreContract`, `CONTRACT_OPERATOR_GROUP` из `@sbx/auth`/`@sbx/auth/testing`; `parseIdentityFile` из `@sbx/auth`.
- Produces:
  - `parseAuthHeaders(h: Headers | Record<string, string | string[] | undefined>): SessionHeaders | null` — §5.2 (email lower+trim, `null` без email; `user`; группы split `,`, trim, без пустых и дублей; `preferredUsername`).
  - `resolveSession(p: Payload, h: SessionHeaders, o: {operatorGroups: string[]; req?: PayloadRequest}): Promise<SessionIdentity>` — алгоритм §5.3 п. 1–6 буквально; ошибки `IdentityError` `subject_required`, `identity_conflict`, `user_disabled`; `lastLoginAt` не чаще 60 s, `groups`/`isOperator` — только при изменении; личная команда и `owner` в одной транзакции; гонки — уникальные индексы, проигравший перечитывает.
  - `class PayloadIdentityStore implements IdentityStore` — `constructor(o: {payload: Payload; operatorGroups: string[]})`; все методы `IdentityStore` (§17.3 + §23.10 S7: `rotateApiKey` ставит `rotatedAt`, `apiKey`, `touchSshKey`, `team`). `touchApiKey`/`touchSshKey` — прямой `UPDATE` без хуков (не шлют `NOTIFY`).
  - `seedPayloadIdentity(p: Payload, yamlText: string): Promise<SeedResult>` — тот же формат и семантика upsert, что `seedIdentity` S7.
  - `@sbx/payload/testing`: `payloadContractSubject(p: Payload): IdentityContractSubject`.

- [ ] **Step 1: тесты.** `headers.test.ts`: `"A@B.com "` → `a@b.com`; группы `"a, b,,a"` и массив `["a,b","c"]` → `["a","b","c"]`; нет email → `null`. `identity-contract.test.ts`: `runIdentityStoreContract("payload", …)`. `resolve-session.test.ts` сверх контракта: 10 параллельных первых входов → 1 пользователь, 1 команда `personal:true`; email занят заготовкой с членством при смене email у известного `sub` → членство перенесено, заготовка удалена; повторный вход с теми же группами не меняет `updatedAt` строки пользователя; снятие группы оператора → `isOperator:false`.
- [ ] **Step 2–4: FAIL → реализация → PASS.**
- [ ] **Step 5: commit** `payload: resolveSession and PayloadIdentityStore`.

### Task 4: `PayloadConfigReader` и контрактный набор `ConfigReader`

**Files:**
- Create: `packages/config/src/testing.ts` (export `./testing`), `packages/config/test/contract.ts`, `packages/payload/src/config-reader.ts`
- Modify: `packages/config/package.json`, `packages/config/test/static.test.ts`
- Test: `packages/payload/test/config-reader.test.ts`

**Interfaces:**
- Produces:
  - `@sbx/config/testing`: `runConfigReaderContract(name: string, make: (fx: ConfigFixture) => Promise<ConfigReader & {close?(): Promise<void>}>): void`; `ConfigFixture` — шаблоны (включённый и выключенный, `windows`), размеры (два, с порядком), цели пула, квота одной команды с пустым полем, `defaults`. Проверки: `template`/`size` по slug и `null`; `templates()`/`sizes()` в порядке конфигурации (`sortOrder`); `poolTargets`; `teamQuota` с подстановкой `defaultQuota` для пустых полей и нули для несуществующей команды (§7, S6 S3 — для Static: квота по умолчанию, отличие записать в контракте параметром `unknownTeamQuota: "default" | "zero"`); `defaults()` со всеми полями `PlatformDefaults`.
  - `class PayloadConfigReader implements ConfigReader` — `constructor(o: {payload: Payload; listen?: {databaseUrl: string}; ttlMs?: number /*5000*/})`, `start(): Promise<void>` (LISTEN `sbx_config`, сброс кэша по любому уведомлению и при переподключении), `close()`. `defaults()` всегда читает global без кэша (C7: `routes.lookup`), остальное — кэш.
- [ ] **Step 1: тесты:** контракт для Static (в `packages/config`) и Payload; изменение шаблона через Local API видно через `template()` ≤ 1 s после commit (LISTEN), без LISTEN — после `ttlMs`.
- [ ] **Step 2–4: FAIL → реализация → PASS.**
- [ ] **Step 5: commit** `config: ConfigReader contract; payload: PayloadConfigReader`.

### Task 5: environments в `runtime`

**Files:**
- Create: `db/migrations/0400_environments_runtime.sql`
- Modify: `packages/auth/src/environments.ts` (таблица `runtime.environments`), `packages/db/src/schema/runtime.ts` (если там перечислены таблицы), `docs/roadmap.md` (диапазон `0400–0499` — S8)
- Test: `packages/auth/test/environments.test.ts`, `packages/db/test/*` (если есть проверка списка таблиц)

- [ ] **Step 1:** тест миграции: строки `identity.environments` (с `team_id` и `updated_by`) копируются в `runtime.environments` c теми же `id`, ciphertext расшифровывается `PgEnvironmentStore`; вставка environment для команды, которой нет в `identity.teams`, работает.
- [ ] **Step 2–4:** `0400`: `CREATE TABLE runtime.environments (… как identity.environments, без REFERENCES …)`, уникальные индексы `(team_id, name)` и `(team_id) WHERE is_default`, `INSERT … SELECT` из `identity.environments`. Старую таблицу не удалять (контракт — позже). Все тесты `@sbx/auth` и `@sbx/api` (environments) — PASS.
- [ ] **Step 5: commit** `db: environments move to runtime (0400)`.

### Task 6: `api` и `worker` на Payload

**Files:**
- Modify: `apps/api/src/{settings.ts,server.ts}`, `apps/api/src/routes/ops*.ts` (readyz), `apps/api/package.json`, `apps/api/Dockerfile`, `apps/api/README.md`; `apps/worker/src/{env.ts,main.ts}`, `apps/worker/package.json`, `apps/worker/Dockerfile`
- Test: `apps/api/test/payload-deps.test.ts`, `apps/worker/test/env.test.ts`

- [ ] **Step 1: тесты.** `payload-deps.test.ts`: `buildDeps` с настоящим Postgres (миграции runtime и Payload) поднимает `PayloadIdentityStore` и `PayloadConfigReader`: `/v1/templates` отдаёт сид `linux`; `SBX_IDENTITY_FILE` с ключом → `GET /v1/me` по этому ключу `200`; без применённых миграций Payload `/readyz` → `503` с `details.reasons` содержащим `payload_migrations`. Worker: `PAYLOAD_SECRET` обязателен, `SBX_CONFIG_FILE` не нужен.
- [ ] **Step 2–4:** `api`: `PAYLOAD_SECRET` обязателен, `SBX_CONFIG_FILE` убран, identity/config — Payload, `seedPayloadIdentity` при старте; `worker`: `ConfigReader` — `PayloadConfigReader`, `assertPayloadMigrated` в readiness. Dockerfile-ы — манифест `packages/payload` в слой установки. README — новые переменные.
- [ ] **Step 5: commit** `api, worker: Payload identity and config`.

### Task 7: C3 — операторские ручки и семантика блокировки

**Files:**
- Create: `db/migrations/0206_sandbox_block_meta.sql` (`sandboxes.blocked_at timestamptz`, `blocked_by uuid`; `hosted_ports.blocked_at`, `blocked_by`; триггер `sbx_routes` уже реагирует на `blocked` — проверить)
- Modify: `packages/core/src/service/*` (`block`, `unblock`, `blockPort`, `unblockPort`, проверки `sandbox_blocked`/`port_blocked`, `list` с `allTeams`/`teamId`), `apps/api/src/routes/{sandboxes,ports}.ts`, `apps/api/src/schemas/*`, `apps/api/openapi/v1.json`, `packages/sdk-ts` (gen + фасад: `sbx.operator.listSandboxes`, `sb.block`, `sb.unblock`, `sb.ports.block`/`unblock`), `packages/sdk-py` (gen)
- Test: `packages/core/test/service-block.test.ts`, `apps/api/test/operator.test.ts`, route-table/conformance

**Interfaces:**
- Produces (HTTP, §17.1 C3): `GET /v1/sandboxes?allTeams=true[&teamId=team_…]` (ресурсы с `teamId`); `POST /v1/sandboxes/{sandbox}/block {reason:"operator"|"abuse", note?: string ≤ 500}` → Sandbox; `POST …/unblock` → Sandbox; `POST /v1/sandboxes/{sandbox}/ports/{port}/block {reason, note?}` и `/unblock` → HostedPort. В Sandbox и HostedPort — `blocked: boolean`, `blockReason: "operator"|"abuse"|null`. Все — только `principal.kind === "session" && isOperator`, иначе `403 forbidden`; оператору `Sbx-Team` для block не нужен (sandbox ищется по всем командам). Событие `sandbox_events` `blocked`/`unblocked` с `{reason, note, by}`.
- Семантика (§17.1, абзац «Семантика блокировки») буквально: заблокированная sandbox — для не-оператора `403 forbidden {details.reason:"sandbox_blocked"}` на exec/PTY/запись файлов/публикацию и смену портов/`resume`/`fork`/`recover`/`extend`/save snapshot/`PUT`/`PATCH /env`/`PATCH` sandbox; разрешены чтения, `stop`, `delete`. Порт — `403 port_blocked` на `PUT`/`rotate-token`/`DELETE` этого порта.
- [ ] **Step 1: тесты.** core: каждое запрещённое действие → `sandbox_blocked` для не-оператора и проходит у оператора; `stop`/`delete` проходят; unblock снимает сразу; `NOTIFY sbx_routes` при block/unblock. api: не-оператор (сессия), командный ключ, JWT оператора → `403` на всех пяти ручках; `allTeams` сессии оператора видит чужие команды и фильтр `teamId`; `routes.lookup` заблокированного → `blocked: true, blockReason`. OpenAPI-drift и conformance — зелёные, `oasdiff`-подобная проверка (только добавления) — сравнить пути и схемы с `main`.
- [ ] **Step 2–4: FAIL → реализация → PASS;** `pnpm --filter @sbx/sdk gen`, генерация Python, их тесты.
- [ ] **Step 5: commit** `api, core: operator blocks (S8 C3)`.

### Task 8: `ctl-idp-sync`

**Files:**
- Create: `packages/payload/src/idp-sync/{keycloak,sync}.ts`
- Modify: `apps/worker/src/{env.ts,main.ts,metrics.ts}`, `apps/worker/README.md` (если есть) 
- Test: `packages/payload/test/idp-sync.test.ts`, `apps/worker/test/idp-sync-wiring.test.ts`

**Interfaces:**
- Produces:
  - `class KeycloakAdminClient` — `constructor(o: {baseUrl: string; realm: string; clientId: string; clientSecret: string; fetch?: typeof fetch; pageSize?: number /*100*/})`; `listUsers(): Promise<{id: string; enabled: boolean}[]>` (client credentials токен, `GET /admin/realms/{realm}/users?briefRepresentation=true&first=&max=` до пустой страницы; любой не-2xx — исключение); `userExists(id): Promise<boolean>` (`404` → `false`).
  - `class KeycloakIdpSync implements IdpSync` — `constructor(o: {payload: Payload; keycloak: KeycloakAdminClient; onAbort?(r: {reason: "mass_deactivation"; wouldDeactivate: number; active: number}): void; log?})`; `run(): Promise<IdpSyncResult>` где `IdpSyncResult = {deactivated: string[]; reactivated: string[]; aborted: boolean}`.
- Алгоритм (§20.1): полный обход → план; `idp_deleted` только после `userExists == false`; заготовки не трогаются; план деактиваций `n` при активных с `idpSubject` `a`: `n > 5 && n > 0.2·a` → ничего не менять, `onAbort`; иначе через Local API `active:false, deactivatedReason, deactivatedAt` (хуки шлют `NOTIFY`), реактивация только `idp_*`; для каждой команды, где пользователь участник, — `team-notices {kind:"member_deactivated", user, apiKeys:[{id,name,prefix}] неотозванные ключи команды, созданные им}`.
- [ ] **Step 1: тесты** (фейковый Keycloak — `node:http`): выключенный → `idp_disabled` и уведомление со списком его ключей в каждой его команде, ключи не отозваны; отсутствующий + `404` → `idp_deleted`; отсутствующий, но `GET /users/{id}` `200` → не трогать; деактивация оператором (`operator`) не снимается; снова включённый (`idp_disabled`) → активен; пустой список при 10 активных → `aborted`, никого не деактивировали; 6 из 20 (30%) → `aborted`; 5 из 10 → применено (не больше 5); `500` на второй странице → исключение, изменений нет. Worker: без `SBX_IDP_SYNC_KEYCLOAK_URL` контроллер не регистрируется; с ним — `ctl-idp-sync` в списке, метрика `sbx_idp_sync_aborted`.
- [ ] **Step 2–4: FAIL → реализация → PASS.**
- [ ] **Step 5: commit** `payload, worker: ctl-idp-sync`.

### Task 9: `apps/web` — каркас, аутентификация, CSRF, админка, dev-прокси

**Files:**
- Create: `apps/web/{package.json,tsconfig.json,next.config.ts,postcss.config.mjs,components.json,vitest.config.ts,Dockerfile,.dockerignore,healthcheck.js,README.md}`, `apps/web/src/payload.config.ts` (`buildSbxConfig` из env + import map админки), `src/proxy.ts`, `src/lib/{env,security-headers,session,api}.ts`, `src/app/(payload)/…` (из шаблона Payload: `admin/[[...segments]]`, `cms-api/[...slug]/route.ts`, `layout.tsx`, `importMap.js`), `src/app/healthz/route.ts`, `src/app/(app)/layout.tsx`, `src/app/(app)/app/page.tsx` (redirect на `/app/t/<defaultTeam>`), `src/app/(app)/app/t/[team]/layout.tsx` (рамка §9.3, переключатель команды, «нет доступа к команде»), `src/components/ui/*` (shadcn: button, input, dialog, table, select, tabs, badge, dropdown-menu, tooltip, sonner), `src/app/globals.css`, `dev/auth-proxy.ts`, `dev/dev.ts`
- Modify: `packages/payload/src/auth-strategy.ts` (стратегия `oauth2-proxy`: `authenticate({headers, payload})` → `resolveSession` с кэшем, решение 8), `pnpm-workspace.yaml` (если нужно), `biome.json` (игнор `.next`, `importMap.js`)
- Test: `apps/web/test/{proxy,security-headers,auth-proxy,strategy}.test.ts`

**Interfaces:**
- Produces:
  - Env `web` (`src/lib/env.ts`, zod, все ошибки сразу): `DATABASE_URL`, `PAYLOAD_SECRET`, `SBX_APP_ORIGIN`, `SBX_OPERATOR_GROUPS`, `SBX_SBX_DOMAIN`, `SBX_API_PUBLIC_URL`, `SBX_LOGOUT_URL?`.
  - `proxy.ts`: для всех путей, кроме `/healthz` и статики Next: нет `X-Auth-Request-Email` → `401` HTML «нет входа»; небезопасный метод с `Origin !== SBX_APP_ORIGIN` → `403`; заголовки `securityHeaders(env)` на ответы.
  - `securityHeaders(o: {sbxDomain: string}): Record<string,string>` — CSP `default-src 'self'; frame-ancestors 'self'; connect-src 'self'; frame-src https://*.<sbxDomain>; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'` (точный список — как потребует Payload admin и Next; записать в README), `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`.
  - `getAppSession(): Promise<AppSession>` (`src/lib/session.ts`, server-only) — `payload.auth({headers})`; `type AppSession = {user: {id: string /*usr_*/; email; name}; teams: {id: string /*team_*/; name; role; personal}[]; defaultTeamId: string; isOperator: boolean}`; деактивированный → страница `403` «учётная запись отключена», `identity_conflict` → `403` с текстом §5.3.
  - Клиентский провайдер `SbxProvider` (`src/lib/api.ts`): `new Sbx({baseUrl: "/api"})` + `QueryClient`; `useSbx(teamId)` возвращает SDK с `Sbx-Team`.
  - `dev/auth-proxy.ts` — §13 буквально (только `127.0.0.1`, вырезает `X-Auth-Request-*`, ставит из cookie `sbx_dev_identity`, `/__dev/login` с кнопками user/second user/operator, `/__dev/logout`, маршруты `/api/*`→`127.0.0.1:8081` без `/api`, `/sbx-auth/*`→`:8081`, остальное →`127.0.0.1:3001`, WebSocket upgrade). `pnpm --filter @sbx/web dev` — `next dev -p 3001` + прокси.
- [ ] **Step 1: тесты.** `proxy.test.ts`: без заголовка — `401`; `POST` с `Origin: https://evil` — `403`; без `Origin` на `POST` — `403`; `GET /healthz` без заголовков — `200`. `security-headers.test.ts`: CSP содержит `frame-ancestors 'self'` и `frame-src https://*.sbx.example.com`. `auth-proxy.test.ts`: клиентский `X-Auth-Request-Email: evil@x` вырезается, без cookie — upstream получает запрос без заголовков; WebSocket upgrade доходит до upstream; слушать `0.0.0.0` отказывается. `strategy.test.ts`: стратегия возвращает пользователя с `collection:"users"`, без заголовков — `{user:null}`.
- [ ] **Step 2–4: FAIL → реализация → PASS;** `next build` проходит (`output: "standalone"`); в `.next/standalone` нет `auth-proxy` (проверка в тесте сборки или скрипте `check:image`). `/admin` открывается за dev-прокси оператором, не-оператор видит страницу `unauthorized` Payload.
- [ ] **Step 5: commit** `web: Next.js + Payload skeleton, auth, CSRF, dev proxy`.

### Task 10: server actions, команда, аккаунт

**Files:**
- Create: `apps/web/src/actions/{teams,members,account,notices}.ts`, `src/lib/permissions.ts`, страницы `src/app/(app)/app/t/[team]/settings/page.tsx`, `src/app/(app)/app/teams/new/page.tsx`, `src/app/(app)/app/account/page.tsx`
- Test: `apps/web/test/{permissions,actions}.test.ts` (actions — с настоящим Postgres и Payload, без Next: функции действий принимают `ctx` с сессией)

**Interfaces:**
- Produces: действия §9.11 с сигнатурами `createTeam(name)`, `renameTeam(teamId, name)`, `inviteMember(teamId, email, role)`, `setRole(membershipId, role)`, `removeMember(membershipId)`, `leaveTeam(teamId)`, `setDefaultTeam(teamId)`, `acknowledgeNotice(noticeId)` → `Promise<{ok: true; …} | {error: {code: "forbidden"|"not_found"|"validation"|"last_owner"|"team_limit"|"already_member"; message: string}}>`. Каждое — `"use server"` обёртка над `…Impl(ctx: {payload; session: SessionIdentity}, …)`; транзакция `initTransaction`, проверка прав по `memberships` в ней, zod, Local API `overrideAccess:true` с `req`.
  - `can(session, team, action): boolean` (`src/lib/permissions.ts`) — таблица §6.2.
- Страницы: settings — имя (rename для `owner`), участники (email, имя, роль, «ещё не входил», последний вход), invite/setRole/remove/leave, квота и использование (`/v1/limits`), баннер `team-notices` с «отозвать выбранные» (вызов `DELETE /v1/api-keys/{id}` через SDK) и `acknowledgeNotice`; teams/new; account — SSH-ключи (SDK `GET/POST/DELETE /v1/ssh-keys`, ошибки `ssh_key_in_use` и тип — текстом), команда по умолчанию, профиль только чтение, «Выйти» (`/oauth2/sign_out?rd=…` + подсказка про `sbx login`).
- [ ] **Step 1: тесты.** `permissions.test.ts` — вся таблица §6.2. `actions.test.ts`: `member` → `forbidden` на rename/invite/setRole/remove чужого; не участник → `forbidden` (и для `acknowledgeNotice`); `owner` не может снять/удалить последнего `owner` (`last_owner`); приглашение в личную команду → `forbidden`; 4-я общая команда → `team_limit`; повторное приглашение → `already_member`; приглашение нового email создаёт заготовку; `leaveTeam` из команды по умолчанию → `defaultTeam` = личная; оператор может rename/invite/setRole/remove.
- [ ] **Step 2–4: FAIL → реализация → PASS.**
- [ ] **Step 5: commit** `web: team, members, account (server actions)`.

### Task 11: дашборд — sandboxes, create, snapshots, keys

**Files:**
- Create: `apps/web/src/app/(app)/app/t/[team]/{page.tsx,sandboxes/new/page.tsx,snapshots/page.tsx,keys/page.tsx}`, `src/features/{sandboxes,create,snapshots,keys}/*.tsx`, `src/lib/errors.ts` (код API → текст)
- Test: `apps/web/test/{errors,create-form}.test.ts` (логика без DOM: разбор labels/env, преобразование формы в тело `POST /v1/sandboxes`)

- [ ] Список §9.4 (опрос 5 s при видимой вкладке, `nextCursor`, фильтры, квота из `/v1/limits`, переходные состояния, замок блокировки, действия stop/resume/fork/terminal/delete с вводом slug); create §9.5 (каталог, `allowedSizes`, из снапшота, labels, env, секреты `type=password`, secret-файлы, TTL/idle, environment — список или `none`, ошибки `quota_exceeded`/`out_of_capacity`/`slug_taken`/`template_unavailable` текстом); snapshots §9.7; keys §9.8 (пресеты `read-only`/`ci`/`full`, срок 90/≤365, секрет один раз с `export SBX_API_KEY=…` и `sbx login --key-stdin`, rotate, revoke, пометка «создатель вышел/деактивирован» по `createdBy.member`/`active`, кнопки только `owner`, отозванные свёрнуты, подсказка `sbx login`).
- [ ] Тесты: `errors.test.ts` — у каждого кода §9.5 свой текст, `out_of_capacity` предлагает повтор; `create-form.test.ts` — секреты не попадают в `searchParams`, пустые строки labels/env отбрасываются, `environment: null` при «none».
- [ ] **commit** `web: sandboxes list, create, snapshots, keys`.

### Task 12: страница sandbox

**Files:**
- Create: `apps/web/src/app/(app)/app/t/[team]/sandboxes/[slug]/page.tsx`, `src/features/sandbox/{header,overview,terminal,commands,output-view,files,ports,ssh,env,desktop}.tsx`, `src/features/sandbox/live.ts` (long-poll `waitFor` + опрос 10 s)
- Test: `apps/web/test/{live,files-path}.test.ts`

- [ ] По §9.6 буквально: заголовок и кнопки (Stop/Resume/Fork/Recover/Extend/Save snapshot/Delete/rename slug), полоска операции, блок ошибки. Terminal — `sb.pty()` SDK + xterm.js 6 (`fit`, `web-links`, `search`), вкладки, переподключение к `GET /commands?mode=pty&status=running` с `tailBytes 65536`, Detach/Close, полоска «reconnecting…», коды `4409`/`4503`/`4401`. Commands — таблица, Run command (`sb.start`), вывод `cmd.follow` в xterm только чтение, stderr подсвечен, `truncated`, Download `/api/v1/…/output?stream=…&offset=…&limit=4194304&team=…`, Kill/Signal. Files — список с пагинацией, крошки, скрытые, просмотр текста ≤ 1 MiB в `<pre>`, скачивание по ссылке `?team=`, загрузка (≤ 64 MiB `PUT`, больше — `sb.files.upload` с прогрессом), mkdir/move/delete. Ports — список, publish (`token`/`sso`/`public`, `hostRewrite`), токен и `urlWithToken` один раз в диалоге, rotate, unpublish, замок, `public_disabled` — подсказка. SSH — команда, `known_hosts`, `hasKeys:false` → ссылка на аккаунт. Env — таблица, секреты `•••`, `PATCH /env` построчно, `delivered:false` → подсказка. Desktop — заглушка S10 при capability `desktop`.
- [ ] Тесты: `live.test.ts` — `waitFor` = все состояния кроме текущего, остановка цикла по `AbortSignal`; `files-path.test.ts` — крошки, `..`, ссылка скачивания кодирует путь и добавляет `team`.
- [ ] **commit** `web: sandbox page (terminal, commands, files, ports, ssh, env)`.

### Task 13: environments и раздел «Оператор»

**Files:**
- Create: `apps/web/src/app/(app)/app/t/[team]/environments/page.tsx`, `src/features/environments/*`, `src/app/(app)/app/operator/page.tsx` (сервер: `isOperator` сессии, иначе `403`; список команд из Payload → клиенту), `src/features/operator/*`, `apps/web/src/admin/delete-team-button.tsx` (решение 12)
- Test: `apps/web/test/operator-page.test.ts` (сервер-гард без Next: функция `requireOperator(session)`)

- [ ] Environments §10 (список, создать/изменить/удалить — только `owner`, значения секретов не показываются, `isDefault`, репозитории, `excludeOwnerSecrets`); Operator §9.10 (все sandbox `allTeams`, фильтры команда/состояние/q, колонка команды, Block/Unblock с причиной и заметкой, порты, Stop, Delete с `Sbx-Team` команды sandbox, переход на страницу sandbox, ссылка `/admin`). Кнопка удаления команды в `/admin` (решение 12).
- [ ] **commit** `web: environments, operator section, admin team delete`.

### Task 14: compose и dev-cp

**Files:**
- Modify: `deploy/compose/compose.yaml` (`web-migrate`, `web`; сеть `web-internal` с `internal: true`, в ней только `web` и oauth2-proxy (+ Postgres для `web`); `api`/`worker` — `PAYLOAD_SECRET`, `depends_on web-migrate`, без `SBX_CONFIG_FILE`), `deploy/compose/oauth2-proxy/oauth2-proxy.yaml` (upstream `/` → `http://web:3000`, `/api/` → `api:8081`), `deploy/compose/secrets-init/init.sh` (`payload-secret`), `deploy/compose/README.md`, `infra/dev-cp/{compose.dev-cp.yaml,README.md}` (маршруты: oauth2-proxy `/` → web, `/api` → api; `SBX_GATEWAY_COOKIE_CROSS_SITE=true` для превью), worker env `SBX_IDP_SYNC_*`
- Test: `docker compose -f deploy/compose/compose.yaml config -q`; ручной smoke ниже

- [ ] `docker compose up -d --build` локально (не CT 590): вход через Keycloak (`dev@example.com`) → `/app` → личная команда; `/api/v1/me` 200; `/admin` — `403`-страница для не-оператора. Порт `web` наружу не опубликован, из контейнера в сети `sbx` (не `web-internal`) `web:3000` недоступен.
- [ ] **commit** `compose: web behind oauth2-proxy, web-migrate; dev-cp routes`.

### Task 15: E2E (Playwright) и безопасность

**Files:**
- Create: `apps/web/e2e/{playwright.config.ts,global-setup.ts,fixtures.ts}`, `apps/web/e2e/backend/{main.ts,Dockerfile}`, `deploy/compose/e2e.yaml`, `apps/web/e2e/*.spec.ts`, `deploy/compose/keycloak/realm-sbx-e2e.json` (если нужны тестовые пользователи: `alice`, `bob`, `op` в группе `sbx-operators`, подтверждённые email, без смены пароля)
- Modify: `apps/web/package.json` (`test:e2e`)

- [ ] Сценарии §15 E2E, которые выполнимы с фейками: вход новым пользователем → личная команда → create → `ready` → терминал (эхо, resize, перезагрузка и переподключение без потери вывода); команда: запуск, живой вывод, kill; файлы: загрузка (≥ 100 MiB чанками — под флагом `SBX_E2E_LARGE=1`, по умолчанию 70 MiB), скачивание, просмотр, rename, delete; порт: `token` один раз, rotate, `public` при выключенном переключателе (через `/admin`) — понятная ошибка; API-ключ: создать → `GET /v1/me` с ним на public listener → отозвать → `401`; owner приглашает → второй входит и видит sandbox; `member` без кнопок и прямой server action → `forbidden`; оператор блокирует чужую sandbox → `routes.lookup` `blocked`, владелец получает `sandbox_blocked` на exec; не-оператор — `403` на `/app/operator`, `/admin`, `allTeams`; отзыв ключа при открытом стриме → `error unauthorized`; Keycloak: выключить пользователя через Admin API → прогон `ctl-idp-sync` (ручка запуска в `e2e-backend`) → `active:false`, owner видит уведомление со списком ключей, ключи работают; пустой ответ Keycloak (подмена через флаг backend) → `aborted`, никто не выключен.
- [ ] Безопасность: запрос к oauth2-proxy с поддельными `X-Auth-Request-Email`/`-User`/`-Groups` до входа — редирект на вход; после входа подделанные `X-Auth-Request-Groups: sbx-operators` не дают `/app/operator`; server action и `POST /cms-api/users` с `Origin: http://evil` → `403`; ни один ответ E2E (перехват всех ответов страницы) не содержит `secretHash`, значений секретов, токенов портов после диалога; контейнер `web` не содержит `auth-proxy` (`docker run … find /app -name 'auth-proxy*'` пусто).
- [ ] **commit** `web: e2e and security tests`.

### Task 16: документы и финальная проверка

**Files:**
- Modify: `docs/specs/s8-web.md` (новый §21 «Реализация MVP (`s8-impl`)»: решения 1–12 и всё, что вышло иначе), `docs/roadmap.md` (статус S8, диапазон `0400–0499`), `docs/architecture.md` (§17.6 спеки), `apps/web/README.md`, `packages/payload/README.md`, `apps/api/README.md`, `deploy/compose/README.md`

- [ ] `mise exec -- pnpm -r test`, `pnpm lint`, `pnpm typecheck`, `pnpm build` (в том числе `next build`) — зелёные; E2E — зелёный локально.
- [ ] Ревью всей ветки свежим субагентом, исправления.
- [ ] **commit** `docs: S8 implementation notes`; `git push origin s8-impl`.
