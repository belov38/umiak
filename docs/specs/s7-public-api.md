# S7. Публичное API v1, SDK, CLI: спецификация

Статус: согласовано (master-сессия от имени Ильи), 2026-10-29. Дополнено MVP-рекомендациями R1, R2, R4, R7, R9–R11 (`docs/roadmap-phase2.md` §6, решения master-сессии 2026-10-29). Область S7 из `docs/roadmap.md`. Архитектура: `docs/architecture.md` (§2, §9, §10, §11). Опирается на `docs/specs/s6-control-plane.md` (`SandboxService`, состояния, идемпотентность), `docs/specs/s2-tunnel-protocol.md` (§8.4 `agent-client`, §9 возобновляемость), `docs/specs/s3-guest-agent.md` (RPC агента), `docs/specs/s4-gateway.md` (внутренние ручки для gateway).

Реализация MVP — ветка `s7-impl` (план `docs/plans/s7-public-api.md`). Что сделано иначе или подробнее — §23; места в тексте ниже помечены ссылкой на §23. Тёплый пул (`failFast`, `pool_exhausted`, `warmAvailable`, `--fail-fast`) — фаза 2, вне публичного контракта MVP (решение Ильи 2026-10-29).

Решения Q1–Q4 и способ закрыть расхождения между спеками согласованы master-сессией от имени Ильи (2026-10-29). Пометка **[решение S7]** — решение автора спеки в рамках брифа; его можно менять при планировании, если причина записана. Пометка **[переопределяет S4]** / **[переопределяет S6]** — место, где S7 меняет уже согласованную спеку. Исполнители S4 и S6 обязаны учесть такие места; сводка — §20.

## 1. Зачем

S7 — внешний интерфейс платформы. Им пользуются AI-агенты (через SDK, CLI и MCP), CI и люди (CLI и дашборд S8). Он превращает HTTP-вызовы в операции S6 и RPC агента (S2/S3), отвечает за аутентификацию, права, ошибки и форму данных.

Что считается успехом:
1. Агент создаёт sandbox, запускает 40-минутную сборку и получает её вывод **байт в байт** с правильным кодом выхода, даже если за это время обрывался туннель, передеплоился gateway и перезапустился под `api`. Повтор запроса с тем же `Idempotency-Key` не запускает команду второй раз.
2. Типичный сценарий (create → ждать готовности → exec → файлы → delete) занимает 5–10 строк на TS и на Python, без ручного разбора NDJSON и без ручных повторов.
3. `umiak login` (device grant Keycloak) входит за одно подтверждение в браузере, в том числе с машины без браузера; личных долгоживущих ключей у людей нет, а выключенный в Keycloak человек теряет доступ за минуты (§7.6, §7.10).
4. Из ответа на любую ошибку клиент (и LLM) понимает, что случилось и можно ли безопасно повторить запрос.
5. OpenAPI — единственный источник правды: SDK, CLI, MCP и документация строятся из него, а ломающее изменение `v1` ловит CI.

## 2. Цели, не-цели, анти-цели

**Цели**
- `apps/api` на Hono + `@hono/zod-openapi`: публичные ресурсы v1, NDJSON-стримы, PTY по WebSocket, внутренние ручки для gateway и приёма событий агента.
- Единые конвенции: ID, ошибки, пагинация, идемпотентность, лимиты, версии.
- Аутентификация: Keycloak JWT для людей в CLI, SDK и MCP; командные API-ключи со scopes для автоматизации; браузерные вызовы через oauth2-proxy; `umiak login`; контракт с S8.
- Возобновляемый стрим от агента до клиента.
- OpenAPI 3.1, SDK TS и Python (генерация и рукописные фасады с хелперами).
- `apps/cli` (`umiak`) на Bun compile.
- Требования S11 (MCP) к API.

**Не-цели (другие области)**
- Payload, UI, создание JIT-пользователей, роли из групп IdP, коллекции ключей и SSH-ключей (S8). S7 задаёт только контракт (§17.3).
- Машины состояний, admission, операции, хранение секретов (S6).
- Gateway, публичные URL, SSH-прокси (S4). Агент (S3). MCP-сервер (S11). Рабочий стол (S10).
- Webhooks, история вывода команд вне VM, подписанные URL файлов, встроенные coding-агенты (позже, §19).

**Анти-цели (провал, даже если всё работает)**
- Команда выполнилась дважды из-за повтора, который SDK сделал сам.
- Вывод, который получил клиент после переподключения, отличается от реального хотя бы на байт, а клиент об этом не узнал (событие `truncated` не пришло).
- Значение env, секрета, секрета API-ключа, токена порта или кода входа попало в лог, метрику, ответ `GET` или URL.
- Запрос на публичный хост прошёл аутентификацию по заголовку `X-Auth-Request-*`.
- Командный ключ выпущен не `owner`-ом команды или получил права шире выбранных им scopes; принят JWT не от Keycloak realm `umiak` или не для `umiak-api`.
- `retryable: true` в ответе, после которого повтор того же запроса создаёт второй ресурс или запускает вторую команду.

## 3. Ограничения

- Toolchain из `mise.toml` (Node 26.13.0, pnpm 12.16.1, Bun 1.4.4). Для Python SDK в `mise.toml` добавляются `python` и `uv` (§18). Версии библиотек — §18, проверены 2026-10-29; при реализации перепроверить (`CLAUDE.md`).
- Раскладка по `CLAUDE.md`: `apps/api`, `apps/cli`, `packages/sdk-ts`, `packages/sdk-py`, `packages/auth`. Тесты vitest (TS) и pytest (Python), линт biome и ruff.
- Не wire-совместимо с boat (решение до S7). Семантика близка к boat (`research/03-api-sdk-surface.md`), формат свой.
- Внутренняя платформа компании: SDK и CLI не публикуются в публичные npm и PyPI (§15.5).
- PoC до S8: пользователи, команды и ключи берутся из статического YAML (§7.9).

## 4. Обзор

```
 agents / CI / CLI / SDK                     browser (dashboard S8, terminal)
   |  https://api.<domain>/v1/*                 |  https://app.<domain>/api/v1/*, /umiak-auth/*
   |  Bearer <Keycloak JWT> | umiak_... (team)    v
   |                                     +--------------+
   |                                     | oauth2-proxy |  OIDC, X-Auth-Request-Email/-User/-Groups
   |                                     +------+-------+
   v                                            v
 +----------------------------- apps/api (one process, one Deployment) --------------------------+
 | :8080 public   - Keycloak JWT or team keys, X-Auth-Request-* stripped                          |
 | :8081 proxied  - trusts oauth2-proxy headers, Origin checks, JIT user via IdentityStore (S8)   |
 | :8082 internal - service tokens: /internal/v1/agent-events, /internal/v1/gateway/*             |
 | :9090 metrics, /healthz, /readyz                                                               |
 |                                                                                                |
 |  routes (zod-openapi) -> auth/scopes -> packages/core SandboxService (S6) -> Postgres, pg-boss |
 |                                      -> @umiak/agent-client (S2) -> gateway internal -> agent    |
 +------------------------------------------------------------------------------------------------+
        ^ gateway (S4): routes, ssh/authorize, port-auth/exchange, agent-events
```

`api` не ходит в Proxmox и не выполняет операции: он ставит их через `SandboxService` (S6 §7.1), а worker их исполняет. С агентом `api` говорит напрямую только для команд, PTY, файлов, портов и env (S6 §4.1).

### 4.1 Пакеты и приложения

| Путь | Имя | Что |
|---|---|---|
| `apps/api` | `@umiak/api` | Hono-приложение, три listener-а, маршруты, zod-схемы, генерация OpenAPI в `apps/api/openapi/v1.json` (коммитится) |
| `packages/auth` | `@umiak/auth` | Формат и hash API-ключей, scopes и пресеты, интерфейс `IdentityStore` и его статическая реализация (в реализации — `PgIdentityStore`, §23.10). Используют `api` и S8 (чтобы формат ключа был один) |
| `packages/sdk-ts` | `@umiak/sdk` | Сгенерированные типы + `openapi-fetch` + фасад `Umiak` и хелперы |
| `packages/sdk-py` | `umiak-sdk` (импорт `umiak_sdk`) | Python-проект (uv); сгенерированный клиент + фасады `Umiak`/`AsyncUmiak` |
| `apps/cli` | `umiak` | CLI на `@umiak/sdk`, сборка `bun build --compile` |
| `packages/core`, `packages/db`, `packages/config` | S6 | Сервисный слой, миграции, конфигурация |
| `packages/agent-client` | S2 | Connect-клиент агента с маршрутизацией и возобновлением |

## 5. Общие конвенции

### 5.1 Хосты и пути

| Хост и путь | Listener | Кто |
|---|---|---|
| `https://api.<domain>/v1/*` | public `:8080` | SDK, CLI, MCP, CI, агенты |
| `https://app.<domain>/api/v1/*` (префикс `/api` снимает ingress) | proxied `:8081` | браузер (дашборд S8, терминал) |
| `https://app.<domain>/umiak-auth/*` | proxied `:8081` | SSO для портов (S4 §8.4) |
| `http://api.<ns>.svc:8082/internal/v1/*` | internal `:8082` | gateway |
| `GET /v1/openapi.json`, `GET /v1/docs` | public и proxied (`/v1/docs` — только public, §23.3) | без аутентификации |

Ресурсы на public и proxied listener-ах одинаковые, отличается только аутентификация (§7).

### 5.2 Формат данных

- JSON, поля `camelCase`. Время — ISO 8601 UTC с миллисекундами (`2026-10-29T12:00:00.000Z`). Длительности — `...Seconds` (целые), размеры — `...Bytes`, offset-ы — целые байты (JSON number, до 2^53).
- Успешный ответ — сам ресурс без обёртки. Ответы-действия — объект с именованными полями (`{sandbox, operation}`).
- Списки — `{ "data": [...], "nextCursor": "..." | null }`.
- Неизвестные поля в теле запроса — `400 validation` (опечатка не должна молча менять поведение, особенно в scopes). Неизвестные поля в ответе клиент обязан игнорировать: v1 только расширяется.
- `null` и отсутствие поля в ответе означают одно и то же; SDK нормализует к `null`/`None`.

### 5.3 Идентификаторы [решение Q1]

Публичный ID = префикс + 26 символов Crockford base32 в нижнем регистре от 128 бит. UUIDv7 из БД (S6) и ULID кодируются одинаково, поэтому ID сортируются по времени создания.

| Ресурс | Префикс | Источник |
|---|---|---|
| Sandbox | `sb_` | `sandboxes.id` (UUIDv7) |
| Operation | `op_` | `operations.id` |
| Command (и PTY) | `cmd_` | `commands.id` (ULID, S2 §9.1) |
| Saved snapshot | `snap_` | `snapshots.id` |
| API key (id, не секрет) | `key_` | Payload |
| SSH key | `sshk_` | Payload |
| Environment | `env_` | `environments.id` (S8 §10) |
| User / Team | `usr_` / `team_` | Payload |
| Upload | `upl_` | ULID, генерирует `api` |
| Request | `req_` | ULID на каждый запрос |

- Секрет API-ключа — единственное значение с префиксом `umiak_` (§7.2). Префикс `umiaks_` зарезервирован за секретом ключа типа `sandbox` (§7.2, в MVP не выпускается). Токен порта — `umiakp_` (S4 §8.3).
- Декодер принимает ID в любом регистре. Ошибка формата — `404 not_found` (не `400`): клиенту всё равно, «плохой» ID или несуществующий.
- В пути `{sandbox}` можно передать ID (`sb_...`) или slug. Строка с префиксом `sb_` — всегда ID, иначе — slug.

### 5.4 Slug [переопределяет S6 §5.6]

Slug — человекочитаемое имя sandbox в URL портов (`<slug>-<port>.umiak.<domain>`), в SSH (`ssh <slug>@ssh.<domain>`) и в hostname гостя (`umiak-<slug>`).

- Грамматика — S4 §4.2: `[a-z0-9]+(-[a-z0-9]+)*`, 3–40 символов, без `--`, не заканчивается на `-<цифры>` (иначе неоднозначен разбор метки), не заканчивается на зарезервированный суффикс (`-desktop`, константа общая с gateway). Зарезервированы целиком: `api`, `app`, `www`, `ssh`, `tunnel`, `admin`, `static`, `umiak`.
- По умолчанию `api` генерирует **три слова** (`quiet-otter-lamp`) из встроенного словаря примерно в 1 500 коротких (3–7 букв) нейтральных английских слов, это около 3,4 · 10⁹ сочетаний. При коллизии — до 5 новых попыток, затем добавляется четвёртое слово. (В MVP — словарь core, около 300 слов, §23.3.)
- Пользователь может задать slug при create/fork и сменить его через `PATCH` (`slug_taken` при занятом). Смена slug меняет метки всех опубликованных портов: старые URL и cookie сразу перестают работать (S4 §8.2).
- Slug занят, пока жива строка sandbox, включая надгробие `deleted` (30 дней, S6 §5.6).
- S6 §5.6 и §14.2 приведены к этой грамматике (MVP-рек. R10); колонка `text unique` подходит без изменений.

### 5.5 Ошибки

```json
{
  "error": {
    "code": "operation_in_progress",
    "message": "Sandbox quiet-otter-lamp already has a running 'resume' operation. Retry after it finishes.",
    "retryable": true,
    "details": { "operationId": "op_01jbx...", "kind": "resume" },
    "requestId": "req_01jbx..."
  }
}
```

- В каждом теле ошибки есть `code`, `message`, `retryable` и `requestId`, на любом listener-е и с любым статусом, включая `401`, `404` и ошибки до аутентификации; `details` — объект (может быть пустым). Клиент, SDK и CLI полагаются на это без проверок.
- `code` — стабильная строка `snake_case`, часть контракта v1: новые коды добавлять можно, существующие менять нельзя. HTTP-статус дублирует класс ошибки.
- `message` — по-английски, пишется для человека и LLM: что случилось и что делать дальше.
- **`retryable: true` означает, что повтор того же запроса безопасен и может пройти позже**: либо ничего не произошло, либо запрос идемпотентен (метод `GET`, естественная идемпотентность или `Idempotency-Key`). Если исход неизвестен (команда могла запуститься), ставится `retryable: false` и `details.outcome: "unknown"`.
- При `429` и `503` есть заголовок `Retry-After` (секунды) и `details.retryAfterSeconds`.
- Заголовок `Request-Id: req_...` есть в каждом ответе; клиент может прислать свой `Request-Id` (до 128 символов `[A-Za-z0-9._-]`) — он попадёт в логи рядом с нашим.

| HTTP | `code` | `retryable` | Когда |
|---|---|---|---|
| 400 | `validation` | нет | схема тела или query; `details.issues[] {path, message}` |
| 400 | `invalid_json`, `invalid_cursor`, `invalid_path` | нет | |
| 401 | `unauthorized` | нет | нет bearer, ключ неизвестен или отозван, JWT не прошёл проверку (`details.reason: "invalid_token"`, §7.10) |
| 401 | `token_expired` | нет | access token Keycloak истёк: обновить токен и повторить (§7.6) |
| 401 | `api_key_expired` | нет | |
| 403 | `forbidden` | нет | не хватает scope (`details.requiredScope`) или роли; `details.reason`: `role`, `user_required` (ручка только для человека), `user_disabled` (пользователь деактивирован, S8 §20.1) |
| 403 | `team_forbidden` | нет | `Umiak-Team` не из команд пользователя или не совпадает с командой ключа |
| 403 | `origin_forbidden` | нет | проверка Origin на proxied listener-е (§7.4) |
| 403 | `quota_exceeded` | нет | квота команды (S6 §8.5); `details {quota, limit, current}` |
| 403 | `path_forbidden` | нет | `EACCES` в файловой операции |
| 404 | `not_found` | нет | ресурса нет или он чужой (чужое не отличается от несуществующего) |
| 404 | `snapshot_not_found`, `path_not_found`, `upload_not_found` | нет | |
| 408 | `request_timeout` | да | добавлено в реализации (§23.2): чанк загрузки застыл (§23.3) |
| 409 | `invalid_state` | нет | операция недопустима в текущем состоянии; `details.state` |
| 409 | `sandbox_not_ready` | нет | sandbox не `ready` для команд, файлов, PTY; `details.state` |
| 409 | `sandbox_starting` | да | sandbox в `creating`/`starting` дольше 60 s ожидания (§8.1) |
| 409 | `operation_in_progress` | да | активна другая операция; `details {operationId, kind}` |
| 409 | `idempotency_key_reused` | нет | тот же ключ, другое тело |
| 409 | `snapshot_requires_stop` | нет | fork или saved snapshot работающей Windows-sandbox без `forceStop` (S9 §24.8); `details {reason: "windows_running", retryWith: {forceStop: true}, cli: "--force-stop"}`, сообщение подсказывает повтор с `forceStop: true` |
| 409 | `slug_taken`, `snapshot_name_taken`, `ssh_key_in_use`, `already_exists` | нет | |
| 409 | `agent_outdated` | нет | у агента нет capability; `details.capability` |
| 409 | `command_exited` | нет | input/resize для завершённой команды |
| 409 | `upload_offset_mismatch` | нет | `details.offset`, заголовок `Umiak-Upload-Offset` |
| 409 | `not_directory`, `is_directory`, `cross_device` | нет | файлы (S3 §11.1) |
| 413 | `payload_too_large` | нет | |
| 416 | `range_not_satisfiable` | нет | |
| 422 | `template_unavailable` | нет | шаблон выключен или размер не разрешён |
| 422 | `checksum_mismatch` | нет | commit загрузки |
| 428 | `confirmation_required` | нет | нет `Umiak-Confirm-Delete` или он не совпадает с удаляемым ресурсом (§5.12); `details.reason: missing \| mismatch` |
| 429 | `rate_limited` | да | §5.8 |
| 429 | `recover_rate_limited` | да | S6 §7.8 |
| 500 | `internal` | нет | |
| 502 | `agent_error` | нет | агент вернул неожиданную ошибку; `details.agentCode` |
| 503 | `agent_unavailable` | да | агента нет дольше 30 s (S2 §8.4) |
| 503 | `out_of_capacity` | да | нет RAM на ноде (S6 §8.2) |
| 503 | `pool_exhausted` | да | **фаза 2, вне публичного контракта MVP (решение Ильи 2026-10-29)**: create с `failFast`, а тёплой machine нет (§8.2); ничего не создано |
| 503 | `server_shutting_down` | да* | под `api` останавливается; *только для запросов, которые безопасно повторить (§9.4) |
| 507 | `no_space` | нет | `ENOSPC`/`EDQUOT` в госте |
| 405 | `method_not_allowed` | нет | добавлено в реализации (§23.2): путь есть, метода нет; заголовок `Allow` |
| 426 | `upgrade_required` | нет | добавлено в реализации (§23.2): `GET .../connect` без WebSocket upgrade |
| 503 | `idp_unavailable` | да | добавлено в реализации (§23.2): discovery или JWKS Keycloak недоступны, а ключей в кэше нет |
| 503 | `not_ready` | да | добавлено в реализации (§23.2): `/readyz`, `details.reasons` |

Доменные ошибки S6 (`UmiakError{code, retryable, details}`) отображаются по этой таблице; `validation` из S6 — `400`, `not_found` — `404`, и т. д. Ошибки Connect от агента — по S3 §11.1 и S2 §10.1.

### 5.6 Пагинация

- `GET` списков: `limit` (1–200, по умолчанию 50), `cursor` (непрозрачный, из `nextCursor`). Порядок фиксирован для каждого списка (по умолчанию — новые первыми).
- Курсор — base64url от JSON `{k: <ключ сортировки>, id}` с HMAC (ключ `UMIAK_API_CURSOR_KEY`), чтобы клиент не строил его сам (в реализации — обёртка над курсором core, §23.3). Подделанный — `400 invalid_cursor`. Курсор живёт, пока жив ключ.
- Для списков, которые отдаёт агент (`files/list`), курсор оборачивает `page_token` агента.

### 5.7 Идемпотентность

- Заголовок `Idempotency-Key` (1–255 печатных ASCII) принимают: `POST /sandboxes`, `POST /sandboxes/{sandbox}/fork`, `POST /sandboxes/{sandbox}/commands`, `POST /sandboxes/{sandbox}/ptys`, `POST /snapshots`.
- Хранение — таблица S6 `idempotency_keys`: `(principal, scope, key)`, hash канонического тела, 24 h. Тот же ключ и тело → сохранённый результат (тот же ресурс), заголовок `Idempotency-Replayed: true`. Другое тело → `409 idempotency_key_reused`. Параллельный дубль ждёт первого (S6 §14.1). Principal для ключа — командный API-ключ или пользователь (сессия или Keycloak JWT — один и тот же `userId`).
- Для команд ключ превращается в `commandId`; `Process/Start` агента идемпотентен по нему (S2 §9.1). Поэтому повтор `POST /commands` с тем же ключом **никогда** не запускает команду второй раз, а подключается к уже запущенной (§9.3).
- Мутирующие вызовы агента без публичного ключа получают `Umiak-Request-Id` = новый UUID на каждый HTTP-запрос (повторы внутри `agent-client` его сохраняют). С публичным ключом — UUIDv5 от `(principal, scope, key)`.
- Остальные действия естественно идемпотентны: `stop`, `recover`, `delete` при активной операции того же вида возвращают её, `resume` — если совпадает и тело (§8.2); `PUT /ports/{port}` с теми же настройками ничего не меняет; `DELETE` повторяем.
- **SDK сам генерирует `Idempotency-Key`** (UUIDv4) для всех ручек из списка, если вызывающий не передал свой, и держит его на все свои повторы.

### 5.8 Лимиты частоты

- Token bucket в памяти пода на principal (API-ключ или пользователь) [решение S7; в реализации — fixed window 100 запросов за 5 s, §23.3]: по умолчанию 20 запросов/с, burst 100; на создание (`create`, `fork`, `resume`) — 30 в минуту на команду. Открытый стрим (NDJSON или WebSocket) считается одним запросом; одновременно не больше 100 стримов на principal на под. Значения — в конфиге.
- При двух и больше подах лимит фактически умножается на число подов. Это приемлемо: от перегрузки нод защищают квоты и admission S6, а лимиты защищают сам `api`.
- Заголовки (IETF draft `RateLimit` / `RateLimit-Policy`): `RateLimit-Policy: "req";q=100;w=5`, `RateLimit: "req";r=37;t=2`. Превышение — `429 rate_limited` с `Retry-After`.
- Библиотека — `rate-limiter-flexible` (memory backend); при необходимости позже — Postgres backend той же библиотеки.

### 5.9 Версии

- Версия в URL: `/v1`. Внутри v1 только добавления: новые ручки, поля ответа, необязательные поля запроса, значения enum (клиенты обязаны принимать неизвестные значения enum; SDK генерируются с открытыми enum, §15). Ломающее изменение — `/v2` рядом с `/v1`.
- Устаревание: заголовки `Deprecation` и `Sunset` (RFC 9745, RFC 8594) на ручке, пометка `deprecated: true` в OpenAPI.
- CI: `apps/api/openapi/v1.json` регенерируется и сравнивается с закоммиченным (расхождение — ошибка); `oasdiff breaking` против `main` (ломающее изменение — ошибка).
- `GET /v1/meta` отдаёт `minCliVersion`; CLI ниже минимума предупреждает и продолжает работать.

### 5.10 Долгие операции и ожидание

- Действия, которые запускают операцию S6 (`create`, `fork`, `stop`, `resume`, `recover`, `delete`, `snapshots`), отвечают `202` с операцией и текущим состоянием sandbox.
- **Long-poll**:
  - `GET /v1/sandboxes/{sandbox}?waitFor=ready,stopped&waitSeconds=30` (до 60 s): ответ, как только состояние входит в `waitFor` или становится `error`/`deleting`/`deleted`, иначе по таймауту — текущее состояние, `200` в обоих случаях. Реализация — `SandboxService.waitForState` (`LISTEN umiak_sandboxes`, S6 §14.1).
  - `GET /v1/operations/{operation}?waitSeconds=30` — до терминального состояния операции (`LISTEN umiak_operations`, §20.2).
- SDK-хелперы ждут через long-poll, а не частым опросом.

### 5.11 Размеры тел

| Ручка | Предел |
|---|---|
| JSON по умолчанию | 1 MiB |
| `POST /sandboxes`, `fork`, `resume`, `PUT /env` | 12 MiB (env и секреты + base64 secret-файлов, §8.3) |
| `PUT /files/content` | без предела (поток) |
| `PUT /files/archive` | без предела на тело; пределы распаковки — §11.1 |
| `PUT /files/uploads/{upload}` | 8 MiB на чанк |
| `POST /commands` | 1 MiB (сама команда до 256 KiB) |
| `POST /internal/v1/agent-events` | 16 MiB |

### 5.12 Подтверждение удаления

- `DELETE /v1/sandboxes/{sandbox}` и `DELETE /v1/snapshots/{name}` требуют заголовок `Umiak-Confirm-Delete: <id>`. Значение — ID удаляемого ресурса (`sb_...`, `snap_...`) или его slug / имя; оно должно указывать на тот же ресурс, что и путь. Нет заголовка или он указывает на другой ресурс → `428 confirmation_required`, ничего не удаляется.
- Заголовок защищает от ошибок агентов и скриптов (не тот slug, подстановка пустой переменной), а не от злоумышленника: у него и так есть `sandboxes:delete`.
- SDK (`sb.delete()`, `stopAndDelete()`, `snapshots.delete()`) ставит заголовок сам из ID уже полученного ресурса. CLI `umiak rm` ставит его после подтверждения в TTY или с `--yes`. Повтор удаления (`deleted`, §8.2) тоже требует заголовок.

## 6. Ресурсы и ручки: сводка

Права — scopes из §7.3. Фаза — §19 (P = PoC, M = MVP).

| Метод и путь | Что | Scope | S6 / агент | Фаза |
|---|---|---|---|---|
| `POST /v1/sandboxes` | create | `sandboxes:write` (+`snapshots:read` с `from`, +`environments:read` с явным `environment`; environment по умолчанию применяется без него, S8 §10.1) | `create` | P |
| `GET /v1/sandboxes` | list | `sandboxes:read` | `list` | P |
| `GET /v1/sandboxes/{sandbox}` | get, long-poll | `sandboxes:read` | `get`, `waitForState` | P |
| `PATCH /v1/sandboxes/{sandbox}` | name, slug, labels, ttl, idle | `sandboxes:write` | `update`, `rename` | P (slug — M) |
| `DELETE /v1/sandboxes/{sandbox}` | delete (заголовок `Umiak-Confirm-Delete`, §5.12) | `sandboxes:delete` | `delete` | P |
| `POST /v1/sandboxes/{sandbox}/stop` | stop | `sandboxes:write` | `stop` | M |
| `POST /v1/sandboxes/{sandbox}/resume` | resume | `sandboxes:write` | `resume` | M |
| `POST /v1/sandboxes/{sandbox}/fork` | fork | `sandboxes:write` | `fork` | M |
| `POST /v1/sandboxes/{sandbox}/recover` | recover | `sandboxes:write` | `recover` | M |
| `POST /v1/sandboxes/{sandbox}/extend` | продлить TTL | `sandboxes:write` | `extend` | M |
| `GET /v1/sandboxes/{sandbox}/env` | env и имена секретов | `sandboxes:read` | `getEnv` | M |
| `PUT /v1/sandboxes/{sandbox}/env` | заменить env/секреты | `sandboxes:write` | `updateEnv` | M |
| `GET /v1/operations/{operation}` | операция, long-poll | `sandboxes:read` | `getOperation` | P |
| `POST /v1/sandboxes/{sandbox}/commands` | sync / stream / detached | `commands:exec` | `createCommand`; `Process/Start`, `Attach` | P |
| `GET /v1/sandboxes/{sandbox}/commands` | список | `commands:read` | `listCommands` | P |
| `GET /v1/sandboxes/{sandbox}/commands/{command}` | статус | `commands:read` | `getCommand`; `Process/Get` | P |
| `GET /v1/sandboxes/{sandbox}/commands/{command}/stream` | attach NDJSON | `commands:read` | `Process/Attach` | P |
| `GET /v1/sandboxes/{sandbox}/commands/{command}/output` | кусок вывода по offset | `commands:read` | `Process/Attach{follow:false}` | P |
| `POST /v1/sandboxes/{sandbox}/commands/{command}/input` | stdin | `commands:exec` | `Process/SendInput` | P |
| `POST /v1/sandboxes/{sandbox}/commands/{command}/kill` | kill | `commands:exec` | `Process/Kill` | P |
| `POST /v1/sandboxes/{sandbox}/commands/{command}/signal` | сигнал | `commands:exec` | `Process/Signal` | P |
| `POST /v1/sandboxes/{sandbox}/ptys` | создать PTY | `commands:exec` | `createCommand`; `Process/Start{pty}` | M |
| `GET /v1/sandboxes/{sandbox}/ptys/{command}/connect` | WebSocket | `commands:exec` | `Attach`, `SendInput`, `Update` | M |
| `POST /v1/sandboxes/{sandbox}/ptys/{command}/resize` | размер окна | `commands:exec` | `Process/Update` | M |
| `GET/HEAD /v1/sandboxes/{sandbox}/files/content` | чтение, Range | `files:read` | `GET /files` | P |
| `PUT /v1/sandboxes/{sandbox}/files/content` | запись потоком | `files:write` | `PUT /files` | P |
| `POST /v1/sandboxes/{sandbox}/files/uploads` | начать загрузку | `files:write` | — | M |
| `PUT/HEAD/DELETE /v1/sandboxes/{sandbox}/files/uploads/{upload}` | чанк / offset / отмена | `files:write` | `/files/uploads/*` | M |
| `POST /v1/sandboxes/{sandbox}/files/uploads/{upload}/commit` | завершить | `files:write` | `/files/uploads/*/commit` | M |
| `GET /v1/sandboxes/{sandbox}/files/stat` | stat | `files:read` | `Filesystem/Stat` | P |
| `GET /v1/sandboxes/{sandbox}/files/list` | list | `files:read` | `Filesystem/List` | P |
| `POST /v1/sandboxes/{sandbox}/files/mkdir` | mkdir | `files:write` | `Filesystem/MakeDir` | P |
| `POST /v1/sandboxes/{sandbox}/files/move` | move | `files:write` | `Filesystem/Move` | P |
| `POST /v1/sandboxes/{sandbox}/files/chmod` | chmod/chown | `files:write` | `Filesystem/Chmod` | M |
| `GET /v1/sandboxes/{sandbox}/files/archive` | каталог одним tar-потоком | `files:read` | `GET /files/archive` | M |
| `PUT /v1/sandboxes/{sandbox}/files/archive` | распаковать tar-поток в каталог | `files:write` | `PUT /files/archive` | M |
| `DELETE /v1/sandboxes/{sandbox}/files` | удалить | `files:write` | `Filesystem/Remove` | P |
| `GET /v1/sandboxes/{sandbox}/ports` | опубликованные и слушающие | `sandboxes:read` | `listHostedPorts`, `System/ListPorts` | M |
| `PUT /v1/sandboxes/{sandbox}/ports/{port}` | опубликовать / сменить режим | `ports:write` | `hostPort` | M |
| `POST /v1/sandboxes/{sandbox}/ports/{port}/rotate-token` | новый токен | `ports:write` | `rotatePortToken` | M |
| `DELETE /v1/sandboxes/{sandbox}/ports/{port}` | снять | `ports:write` | `unhostPort` | M |
| `GET /v1/sandboxes/{sandbox}/ssh` | как подключиться | `ssh:connect` | — | M |
| `POST /v1/sandboxes/{sandbox}/ssh/certificate` | короткий SSH-сертификат (§11.3) | `ssh:connect` | — | M |
| `GET/POST /v1/ssh-keys`, `DELETE /v1/ssh-keys/{key}` | SSH-ключи пользователя (только человек, §7.10) | `ssh:connect` | `IdentityStore` (S8) | M |
| `GET /v1/snapshots`, `GET /v1/snapshots/{name}` | saved snapshots | `snapshots:read` | `listSavedSnapshots`, `getSavedSnapshot` | M |
| `POST /v1/snapshots` | сохранить | `snapshots:write` | `saveSnapshot` | M |
| `DELETE /v1/snapshots/{name}` | удалить (`Umiak-Confirm-Delete`, §5.12) | `snapshots:write` | `deleteSavedSnapshot` | M |
| `GET /v1/templates`, `GET /v1/sizes` | каталог | любой ключ | `ConfigReader`, `template_builds` | P |
| `GET /v1/api-keys` | командные ключи (§7.2) | любой участник; ключ — `keys:admin` | `IdentityStore` | M |
| `POST /v1/api-keys`, `POST /v1/api-keys/{key}/rotate` | выпуск, ротация | `owner` команды, только человек (§7.2) | `IdentityStore` | M |
| `DELETE /v1/api-keys/{key}` | отзыв | `owner`, оператор; ключ — `keys:admin` | `IdentityStore` | M |
| `DELETE /v1/api-keys/self` | ключ отзывает сам себя (`umiak logout --revoke`) | любой ключ | `IdentityStore` | M |
| `GET /v1/me` | кто я | любой | — | P |
| `GET /v1/limits` | квоты, остаток, допустимые шаблоны и размеры | любой | `usage` | M |
| `/v1/environments` (S8 §10.2) | environments команды | `environments:read` / `environments:write` | `EnvironmentService` (S8) | M |
| `GET /v1/meta` | платформа: домены, SSH host keys, версии | без auth | — | P |

## 7. Аутентификация и права [решение Q2; модель входа — решение Ильи 2026-10-29: Keycloak, offboarding вариант A]

Два вида bearer на public listener-е: **Keycloak JWT** — люди в CLI, SDK и локальном MCP (§7.6, §7.10), личных долгоживущих ключей у людей нет; **командный ключ `umiak_`** — автоматизация и CI (§7.2). Браузер — через oauth2-proxy (§7.4). IdP — Keycloak, realm `umiak` (architecture §10).

### 7.1 Три listener-а

| Listener | Принимает | Не принимает |
|---|---|---|
| public `:8080` (`api.<domain>`) | `Authorization: Bearer <access token Keycloak>` (§7.10) или `Authorization: Bearer umiak_...` (§7.2); без auth — только `/v1/meta`, `/v1/openapi.json`, `/v1/docs` | Заголовки `X-Auth-Request-*`, `X-Forwarded-User`, `X-Forwarded-Email` вырезаются до любой обработки. Cookie игнорируются |
| proxied `:8081` (`app.<domain>` через oauth2-proxy) | Заголовки oauth2-proxy `X-Auth-Request-Email` (обязателен), `-User`, `-Groups`, `-Preferred-Username` | `Authorization: Bearer` (на этом хосте не нужен, `400`). Запрос без `X-Auth-Request-Email` — `401` |
| internal `:8082` (ClusterIP) | `Authorization: Bearer <service-token>` gateway | Всё остальное |

- Заголовкам oauth2-proxy можно доверять только потому, что к `:8081` пускает лишь oauth2-proxy (NetworkPolicy S12), а на `:8080` они вырезаются. Это анти-цель №4, у неё отдельный тест (§16).
- IP клиента для логов и лимитов — из `X-Forwarded-For` только от адресов из `UMIAK_API_TRUSTED_PROXY_CIDRS` (ingress), иначе адрес соединения. (В реализации — только для лога, лимиты считаются по principal, §23.3.)

### 7.2 Командные API-ключи (`umiak_`)

- **Формат секрета:** `umiak_` + 43 символа base62 (32 случайных байта) + 6 символов base62 CRC32 от предыдущей части. CRC позволяет сканерам секретов (GitHub secret scanning с собственным паттерном, gitleaks) отличать ключ от случайной строки без обращения к серверу. Регулярное выражение для сканеров: `\bumiak_[0-9A-Za-z]{49}\b`.
- **Хранение:** только `sha256(secret)` в hex (уникальный индекс); высокая энтропия, медленный hash не нужен. Для отображения — `prefix` (первые 8 символов после `umiak_`) и `last4`. Коллекция `api-keys` в Payload (S8, поля — §17.3).
- **Проверка:** `sha256` → кэш в памяти пода (положительный 30 s, отрицательный 5 s) → `IdentityStore.findApiKeyByHash`. Сброс кэша по `LISTEN umiak_identity` (S8 шлёт `NOTIFY` при изменении ключа; `api` шлёт сам при отзыве). Отозванный ключ перестаёт работать на всех подах не позже чем через 30 s, обычно сразу.
- **Срок:** по умолчанию 90 дней, максимум 365 [решение S7]; бессрочных ключей нет. `expiresAt` прошёл — `401 api_key_expired`.
- `lastUsedAt` обновляется не чаще раза в 60 s на ключ.
- **Ключ принадлежит команде, а не человеку.** Выпускает и ротирует его `owner` команды — человек в браузерной сессии (дашборд) или с Keycloak JWT (`umiak keys create`, тот же API) (иначе `403 forbidden`, `details.reason: "role"` или `"user_required"`); ключ ключей не выпускает. Создатель записывается в `createdBy` только для аудита. Уход создателя из команды и его деактивация (S8 §20.1) ключ **не выключают**: отзывают его `owner`-ы команды, оператор (только отзыв), ключ с `keys:admin` или сам ключ (`DELETE /v1/api-keys/self`). Удаление команды отзывает все её ключи (S8 §6.4).
- Секрет показывается один раз: в ответе `POST /api-keys` и `rotate`.
- **Тип ключа** (`kind`): `team` — командный ключ, всё выше; `sandbox` — **зарезервирован, в MVP не реализуется**. Ключ `sandbox` будет привязан к одной sandbox (`sandboxId`), с секретом `umiaks_` + тот же формат (регулярное выражение для сканеров — `\bumiaks?_[0-9A-Za-z]{49}\b`), и предназначен для CLI внутри VM: видит только свою sandbox, scopes не шире пресета `sandbox-self` (§7.3) и не шире прав создателя. В MVP в схеме есть поля `kind` (всегда `team`) и `sandboxId` (всегда `null`); `POST /api-keys` с `kind: "sandbox"` → `400 validation`. Выпуск, доставка в VM и отзыв при delete sandbox — фаза 2 (S24).

### 7.3 Scopes и пресеты

Scope — пара «ресурс × действие» в форме `<resource>:<action>`. Набор scopes — часть контракта v1: новые можно добавлять, существующие не переименовываются и не расширяются по смыслу.

| Scope | Что разрешает |
|---|---|
| `sandboxes:read` | get, list, long-poll, operations, env (значения env и имена секретов), ports list |
| `sandboxes:write` | create, update, stop, resume, fork, recover, extend, `PUT /env` |
| `sandboxes:delete` | delete |
| `commands:read` | список и статус команд, attach, вывод по offset |
| `commands:exec` | запуск команд и PTY, input, kill, signal, resize |
| `files:read` / `files:write` | чтение / изменение файлов, архив каталога (§11.1) |
| `ports:write` | публикация портов, режимы, токены |
| `ssh:connect` | SSH-сертификат (§11.3), SSH-ключи пользователя и `GET /sandboxes/{sandbox}/ssh` |
| `snapshots:read` / `snapshots:write` | saved snapshots: список и create из них / сохранение и удаление |
| `environments:read` / `environments:write` | environments команды (S8 §10.2): список и значения env / создание, изменение, удаление |
| `keys:admin` | только для командных ключей: список ключей команды и их отзыв. У людей вместо scope — роль: список видят все участники, отзывают `owner` и оператор, выпускают и ротируют только `owner` (§7.2) |

`/me`, `/limits`, `/templates`, `/sizes`, `DELETE /api-keys/self` доступны любому валидному ключу.

| Пресет | Scopes |
|---|---|
| `read-only` | `sandboxes:read`, `commands:read`, `files:read`, `snapshots:read`, `environments:read` |
| `ci` | `sandboxes:read`, `sandboxes:write`, `sandboxes:delete`, `commands:read`, `commands:exec`, `files:read`, `files:write`, `ports:write`, `snapshots:read`, `environments:read` |
| `full` | все scopes |
| `sandbox-self` | зарезервирован для ключей `sandbox` (§7.2): `sandboxes:read`, `commands:read`, `commands:exec`, `files:read`, `files:write`, `ports:write` в пределах своей sandbox |

- Человек (браузерная сессия или Keycloak JWT) имеет все scopes в пределах роли (§7.5). Scopes ключа выбирает `owner` при выпуске; ключ выпускать ключи не может, поэтому правило подмножества не нужно.
- Нехватка scope — `403 forbidden`, `details.requiredScope`.
- Неизвестный scope — `400 validation`. Срок есть у каждого ключа (§7.2).
- Ограничение командного ключа конкретными sandbox, environments или labels — позже (§19); случай «одна sandbox» закрывает тип `sandbox` (§7.2).

### 7.4 Браузер: proxied listener

- `IdentityStore.resolveSession(headers)` (реализует S8): по заголовкам oauth2-proxy находит или создаёт JIT-пользователя, отдаёт пользователя, его команды с ролями и признак оператора (из групп IdP). Результат кэшируется в поде на 30 s по email; сброс по `LISTEN umiak_identity`.
- Команда запроса — заголовок `Umiak-Team: team_...`; без него — команда пользователя по умолчанию (S8). Команда не из списка пользователя — `403 team_forbidden`. Оператор может указать любую команду.
- Сессия имеет все scopes. Ограничения по ролям внутри команды — S8 (S7 передаёт роль в `Principal`).
- **CSRF.** Для небезопасных методов и для WebSocket upgrade заголовок `Origin` обязателен и равен `UMIAK_APP_ORIGIN` (`https://app.<domain>`), иначе `403 origin_forbidden`. Тела с JSON принимаются только с `Content-Type: application/json` (простая HTML-форма его не пошлёт).
- Cookie oauth2-proxy — `__Host-` на `app.<domain>` (architecture §10, S4 §14.1); `api` своих cookie не ставит.

### 7.5 Principal

`api` передаёт в `SandboxService` (S6 §5.11):

```ts
interface Principal {
  kind: "session" | "oidc" | "team_key" // browser, Keycloak JWT (§7.10), team key (§7.2)
  userId: string | null    // Payload user id; null for team keys
  teamId: string
  role: "owner" | "member" | null // team role from S8; null for team keys
  isOperator: boolean     // platform operator (IdP group, S8); browser sessions only
  apiKeyId?: string       // team keys only
  scopes: Scope[]
}
```

Доступ к sandbox: sandbox принадлежит команде; любой участник команды и любой ключ команды имеют к ней доступ в пределах scopes [решение S7, как рекомендует S4 §9.2]. Sandbox чужой команды — `404 not_found`. Проверки роли `owner` в S8 (например, `environments:write`) для командного ключа заменяются наличием scope: ключ выпускает `owner`, и scopes выбирает он. Ручки, которым нужен человек (SSH-ключи пользователя, выпуск ключей), командному ключу отвечают `403 forbidden` с `details.reason: "user_required"`.

### 7.6 `umiak login`

**Люди: OAuth 2.0 Device Authorization Grant (RFC 8628) в Keycloak** [решение Ильи 2026-10-29]. Своих страниц входа у `api` нет.
1. CLI берёт из `GET /v1/meta` блок `oidc {issuer, clientId: "umiak-cli", audience: "umiak-api"}` и вызывает `POST {issuer}/protocol/openid-connect/auth/device` (`client_id=umiak-cli`, `scope=openid`; публичный клиент, без секрета). Ответ: `device_code`, `user_code`, `verification_uri` (`{issuer}/device`), `verification_uri_complete`, `expires_in` (600), `interval` (5).
2. CLI печатает код и ссылку и, если есть браузер, открывает `verification_uri_complete` (`--no-browser` — только напечатать). Человек входит в Keycloak (или уже вошёл) и подтверждает.
3. CLI опрашивает token endpoint (`grant_type=urn:ietf:params:oauth:grant-type:device_code`), обрабатывает `authorization_pending`, `slow_down`, `expired_token`, `access_denied`. Итог — access token (5 min), refresh token, ID token (CLI его не хранит).
4. CLI вызывает `GET /v1/me` (JIT пользователя по JWT, §7.10), показывает пользователя и команду по умолчанию; `--team` или `UMIAK_TEAM` выбирают другую.

**Хранение.** Refresh token и текущий access token — в хранилище ОС через `Bun.secrets` (macOS Keychain, libsecret, Windows Credential Manager с `persist: "local"`), запись `service: "umiak"`, `name: "<profile>@<issuer>"`. Если хранилище недоступно (Linux без secret service, контейнер), — файл `$XDG_CONFIG_HOME/umiak/credentials.json` с правами `0600` и предупреждением; `--credential-store keychain|file` выбирает явно. В `config.json` секретов нет.

**Обновление.** Access token используется до `exp − 30 s` (в реализации `exp − 90 s`, §23.7), затем `grant_type=refresh_token`. Параллельные процессы обновляют под файловой блокировкой (`$XDG_CONFIG_HOME/umiak/.lock`), второй читает уже обновлённый токен. Refresh привязан к SSO-сессии Keycloak (сроки — architecture §10): закончилась сессия, пользователь выключен или удалён — Keycloak отвечает `invalid_grant`, CLI пишет «войдите снова: `umiak login`» и выходит с кодом `4`. Значит, выключенный в Keycloak человек теряет CLI, SDK и MCP не позже чем через срок жизни access token (5 min), а после синхронизации S8 §20.1 `api` отклоняет и ещё не истёкшие токены.

**SDK и локальный MCP используют учётные данные CLI.** `umiak auth token [--json]` печатает действующий bearer текущего профиля — access token (обновляя его при необходимости) или ключ, сохранённый `--key-stdin`, — или выходит с кодом `4`. `--json` → `{kind: "oidc" | "key", token, expiresAt, apiUrl, team}`: SDK берёт `apiUrl` и `team` профиля, если они не заданы явно, и не отправит токен на другой API. Цепочка в SDK TS и Python (§15.2): явные `apiKey` / `accessToken` / `tokenProvider` → `UMIAK_API_KEY` → `UMIAK_ACCESS_TOKEN` → `umiak auth token --json` (если `umiak` есть в `PATH`); токен кэшируется в процессе до `exp − 60 s`, на `401 token_expired` SDK один раз берёт новый и повторяет запрос. Локальный MCP по stdio (S11) работает через SDK и получает то же самое. Свой refresh SDK не делает: хранилищем и обновлением владеет CLI.

**Автоматизация: `--key-stdin`.** `echo "$UMIAK_API_KEY" | umiak login --key-stdin` проверяет командный ключ через `/v1/me` и кладёт его в то же хранилище. `UMIAK_API_KEY` в env имеет приоритет над сохранённым входом. Это вход для агентов, CI и CLI внутри VM.

`umiak logout` для входа Keycloak отзывает refresh token (`POST {issuer}/protocol/openid-connect/revoke`, `token_type_hint=refresh_token`) и стирает запись; для ключа — только стирает запись, а `--revoke` ещё и вызывает `DELETE /v1/api-keys/self` (ключ общий для команды, по умолчанию его не отзываем).

### 7.7 SSO для портов (S4 §8.4)

`GET https://app.<domain>/umiak-auth/authorize?label=&state=` на proxied listener-е:
1. `label` проходит грамматику S4 §4.2; маршрут существует, `access = sso`, не `blocked` (иначе — HTML-страница ошибки, без редиректа).
2. Политика: пустить любого вошедшего пользователя платформы (как согласовано в S4). Переключатель `PlatformDefaults.ssoPortPolicy = any | team` (S8) [решение S7]; `team` пускает только участников команды sandbox и операторов.
3. Код: 32 случайных байта, в `port_auth_codes` (§12.2) — `sha256`, `label`, `userId`, `email`, `authEpoch`, срок 60 s.
4. `302` на `https://<label>.<umiak-domain>/__umiak/auth/callback?code=…&state=…`; хост строится из label, а не берётся из запроса.

Обмен кода — §12.1.

### 7.8 Внутренние вызовы

Service tokens по S2 §5.5: файл `UMIAK_API_SERVICE_TOKENS_FILE` — `{ "gateway": ["<t1>", "<t2>"] }` (принимаемые) и токен, с которым `api` сам ходит во внутренний listener gateway (`agent-client`). Сравнение constant-time.

### 7.9 PoC до S8

`IdentityStore` имеет статическую реализацию `StaticIdentityStore` (`packages/auth`) из YAML (`UMIAK_IDENTITY_FILE`): пользователи, команды, API-ключи (только `sha256`), SSH-ключи. Proxied listener в PoC выключен. (В реализации вместо неё — `PgIdentityStore` с загрузкой того же YAML, proxied listener включён, §23.10.) Без `UMIAK_OIDC_ISSUER` JWT не принимаются: Keycloak в PoC необязателен. `umiak-admin` (S6 §15.3) получает команду `api-key hash` для генерации ключа и строки YAML.

### 7.10 Keycloak JWT

- **Какой bearer.** Начинается с `umiak_` — командный ключ (§7.2); `umiaks_` зарезервирован; иначе это должен быть JWS compact (три части base64url), иначе `401 unauthorized`.
- **Проверка в `api`, без introspection на запрос:** подпись ключом из JWKS (`jwks_uri` из `{issuer}/.well-known/openid-configuration`), алгоритм из списка `RS256`, `ES256` (`none` и `HS*` — отказ); `iss` равен `UMIAK_OIDC_ISSUER` (`https://<keycloak>/realms/umiak`); `aud` содержит `umiak-api` (`UMIAK_OIDC_AUDIENCE`); `exp`, `nbf`, `iat` с допуском 60 s; claim `typ` = `Bearer` (так ID token и refresh token не пройдут); `azp` из `UMIAK_OIDC_ALLOWED_CLIENTS` (по умолчанию `umiak-cli`, `umiak-mcp` — вход в удалённый MCP через браузер, S11 §6.4); `email_verified = true`. Библиотека — `jose` (`createRemoteJWKSet`, `jwtVerify`).
- **Адреса.** `iss` сверяется с публичным `UMIAK_OIDC_ISSUER`; discovery и JWKS `api` может брать по внутреннему адресу (`UMIAK_OIDC_DISCOVERY_URL`, по умолчанию от issuer), если публичное имя Keycloak из кластера недоступно.
- **JWKS** кэшируется в поде: обновление раз в 10 min и при неизвестном `kid` (не чаще раза в 30 s). Если Keycloak недоступен, кэш ключей продолжает работать, токены проверяются офлайн.
- **Та же личность, что в браузере.** `sub` токена — тот же claim, который oauth2-proxy шлёт в `X-Auth-Request-User` (S8 §5.1). `api` вызывает `IdentityStore.resolveSession({email, user: sub, groups, preferredUsername})` из claims `email`, `sub`, `groups`, `preferred_username`: JIT, привязка к `idpSubject`, кэш 30 s — как для браузера (S8 §5.3). Деактивированный пользователь (`active: false`, в том числе по синхронизации S8 §20.1) — `403 forbidden` с `details.reason: "user_disabled"`, даже если токен не истёк.
- **Principal:** `kind: "oidc"`, все scopes в пределах роли, команда — `Umiak-Team` или команда по умолчанию (`403 team_forbidden`, как в §7.4), `isOperator: false` (права оператора только в браузере, S8 §5.5).
- **Ошибки:** токен истёк — `401 token_expired` (клиент обновляет токен и повторяет); подпись, `iss`, `aud`, `typ`, `azp`, алгоритм или формат не прошли — `401 unauthorized` с `details.reason: "invalid_token"`. Всегда заголовок `WWW-Authenticate: Bearer realm="umiak", error="invalid_token"` (RFC 6750).
- **Долгие соединения.** Стрим NDJSON и PTY WebSocket проверяют bearer при открытии и живут дольше `exp` токена или ключа; их закрывает реестр открытых соединений при деактивации пользователя, удалении из команды и отзыве ключа (S8 C9). Это принятое допущение: стримы всё равно переподключаются каждые 60 min (§9.7), а переподключение требует действующего bearer; PTY без клиента закрывается через 10 min. Выход из Keycloak (logout) без деактивации открытые соединения не закрывает.

## 8. Sandboxes и операции

### 8.1 Ресурс Sandbox

```json
{
  "id": "sb_01jbx4q3m7f8r2t6v9w0y1z2a3",
  "slug": "quiet-otter-lamp",
  "name": "ci-run-42",
  "teamId": "team_...",
  "createdBy": "usr_...",
  "createdByKey": null,
  "template": "linux",
  "templateVersion": "2026.10.29-1",
  "size": "2gb",
  "vcpu": 2,
  "memoryMb": 2048,
  "state": "ready",
  "health": "ok",
  "healthReason": null,
  "degradedSince": null,
  "activity": "busy",
  "lastActivityAt": "2026-10-29T12:03:11.000Z",
  "stopReason": null,
  "error": null,
  "origin": { "kind": "template" },
  "labels": { "session": "42" },
  "ttlSeconds": null,
  "deadlineAt": null,
  "idleTimeoutSeconds": 900,
  "activeOperation": null,
  "endpoints": {
    "portUrlTemplate": "https://quiet-otter-lamp-{port}.umiak.example.com",
    "ssh": "ssh quiet-otter-lamp@ssh.example.com"
  },
  "createdAt": "...", "readyAt": "...", "stoppedAt": null, "deletedAt": null, "updatedAt": "..."
}
```

- `state` — состояния S6 как есть: `creating`, `ready`, `stopping`, `stopped`, `starting`, `error`, `deleting`, `deleted`. «Можно работать» = `state == "ready"`; при `health == "degraded"` вызовы агента ждут до 30 s и дают `503 agent_unavailable`.
- `origin`: `{kind: "template"}` | `{kind: "snapshot", snapshot: "<name>", snapshotId}` | `{kind: "fork", sandboxId}`.
- `error`: `{code, message}` из S6 (`create_failed`, `resume_failed`, `machine_lost`, ...).
- `activeOperation` — операция (§8.4) или `null`.
- `createdBy` — пользователь (сессия или JWT) или `null`, если создал командный ключ; тогда `createdByKey: "key_..."`. То же у Command (§9.6).
- `environment` (`{id, name, revision}` или `null`) и `excludeOwnerSecrets` — S8 §10. (В MVP `environment` всегда `null`, `excludeOwnerSecrets` — `false`, §23.6.)
- Надгробие `deleted` отдаётся по `GET` 30 дней (S6 §5.6), затем `404`. В списке `deleted` только при явном `state=deleted`.

### 8.2 Ручки

**`POST /v1/sandboxes`** (`Idempotency-Key`):

```json
{
  "template": "linux",
  "size": "2gb",
  "name": "ci-run-42",
  "slug": "my-box",
  "labels": { "session": "42" },
  "env": { "NODE_ENV": "test" },
  "secrets": { "ANTHROPIC_API_KEY": "sk-..." },
  "secretFiles": [{ "name": "gcp.json", "contentBase64": "...", "mode": 288, "linkPath": "/home/user/.config/gcloud/key.json" }],
  "ttlSeconds": 3600,
  "idleTimeoutSeconds": 900,
  "from": { "snapshot": "web-stack" },
  "environment": "base",
  "excludeOwnerSecrets": false,
  "failFast": false
}
```

Все поля необязательны. `template` по умолчанию — из `PlatformDefaults` (S8; в PoC `linux`), `size` — `defaultSize` шаблона. С `from` поле `template` игнорируется (берётся из снапшота). `environment` и `excludeOwnerSecrets` — S8 §10. Ответ `202 {sandbox, operation}`.

Поле `failFast` в примере — **фаза 2, вне публичного контракта MVP (решение Ильи 2026-10-29)**: в схеме MVP его нет, `failFast` в теле — `400 validation` (неизвестное поле). `excludeOwnerSecrets: true` в MVP — `400 validation` (§23.6).

**`failFast: true`** (фаза 2, вне публичного контракта MVP, решение Ильи 2026-10-29) — только тёплый пул (S6 §7.3). Есть `warm` machine пары (шаблон, размер) — обычный claim. Нет — `503 pool_exhausted` (`retryable: true`, `Retry-After` и `details.retryAfterSeconds` — оценка пополнения пула): sandbox, операция и запись `Idempotency-Key` не создаются, повтор с тем же ключом безопасен. Холодный старт и вытеснение warm других пар не применяются. С `from` → `400 validation` (create из снапшота всегда холодный, S6 §7.3). Проверки шаблона и квоты идут раньше, поэтому `quota_exceeded` и `template_unavailable` отдаются как обычно. Сколько тёплых machine сейчас есть — `GET /v1/limits` (§13), это подсказка, а не резерв.

**`GET /v1/sandboxes`**: фильтры `state` (через запятую), `label=k=v` (можно повторять, И), `template`, `q` (префикс name или slug); новые первыми.

**`PATCH /v1/sandboxes/{sandbox}`**: `name`, `slug` (M), `labels` (полная замена), `ttlSeconds` (`deadlineAt = now + ttl`, `null` снимает TTL), `idleTimeoutSeconds`. Ответ `200 Sandbox`.

**Действия** (ответ `202 {sandbox, operation}`):
- `POST /stop`;
- `POST /resume {size?, ttlSeconds?, env?, secrets?, secretFiles?}`;
- `POST /fork {name?, slug?, labels?, ttlSeconds?, idleTimeoutSeconds?, size?, forceStop?, env?, secrets?, secretFiles?}` (`Idempotency-Key`): ответ `{sandbox: <новая>, operation: <create цели>, sourceOperation: <fork на источнике>}`. Работающая Windows-sandbox форкается только из остановленной VM (S9 §24.8): без `forceStop: true` — `409 snapshot_requires_stop` с подсказкой; с ним fork на источнике останавливает его (обычный stop: PrepareStop, стирание secret-файлов; команды, PTY и сессии прерываются), снимает снапшот (`consistency: powered_off`), запускает источник снова и только потом передаёт снапшот цели. `sourceOperation.forceStop` сообщает итог перезапуска (§8.4). Linux снимается вживую и флаг игнорирует; остановленный источник тоже;
- `POST /recover`;
- `DELETE /v1/sandboxes/{sandbox}` → `202 {sandbox, operation}`; на `deleted` → `200 {sandbox, operation: null}`.
- `POST /extend {ttlSeconds?}` → `200 Sandbox` (без операции, S6 §7.8).

**Повтор при активной операции.** Если S6 вернул `operation_in_progress`, а активная операция того же вида (`stop`, `resume`, `recover`, `delete`), `api` отвечает `202` с этой операцией. Другой вид — `409 operation_in_progress`. Для `resume` и `recover` это добавление к S6 (§20.2). `resume` возвращает активный `resume`, только если hash канонического тела совпадает (пустое тело — тоже тело; S6 §7.6); иначе `409 operation_in_progress`.

**Env и секреты на fork и resume.** `env`, `secrets`, `secretFiles` — те же правила, лимиты и шифрование, что у create (§8.3), но форма — как у `PATCH /env` (S8 C2): `env` и `secrets` — `{K: v | null}`, `secretFiles` — `{<name>: {contentBase64, mode?, linkPath?} | null}`; схема OpenAPI общая с `PATCH /env`. Наборы накладываются по ключу на унаследованные (fork — копия наборов источника, resume — наборы самой sandbox): тот же ключ — побеждает запрос, secret-файлы — по имени, `null` удаляет ключ. Лимиты проверяются на результате. У resume результат сохраняется в sandbox (как `PUT /env`), даже если resume потом не удался; у fork меняется только цель, источник не трогается.

### 8.3 Env и секреты

Три набора, с разной судьбой в госте (S3 §8.1–8.2):

| Поле API | В S3 | Где живёт в госте | Fork | Create из saved snapshot |
|---|---|---|---|---|
| `env` | `ClaimRequest.env` | `/etc/umiak/env` и `state.db` (диск) | да (S6 копирует набор источника) | нет |
| `secrets` | `secret_env` | tmpfs, заново после каждой загрузки | да (S6 перешифровывает) | нет |
| `secretFiles` | `secret_files` | tmpfs, `linkPath` — symlink на диске | да | нет |

- **Create из saved snapshot** переносит только диск источника (файлы, пакеты, история shell). Env, секреты и secret-файлы источника не переносятся: при первой загрузке агент видит новую идентичность и стирает `state.db` с claim и `/etc/umiak/env` (S3 §7.2), а наборы новой sandbox — из запроса create и environment (S8 §10), как у create из шаблона. Снапшот — образ диска, а не копия sandbox; секреты на диске не хранятся, и снапшот, которым поделились в команде, не должен раздавать чужие секреты. Решение 2026-10-31 (ветка `fix-resume-sshca`): так и задумано. Нужны наборы источника — fork или явные `env`/`secrets` в create.

- Наборы принимают create, fork и resume (§8.2), `PUT /env` и environments (S8 §10).
- Лимиты: до 100 переменных в каждом наборе; ключ `[A-Za-z_][A-Za-z0-9_]{0,127}`; значение до 32 KiB без NUL; всего до 256 KiB на набор. Префикс `UMIAK_` зарезервирован (`400 validation`), кроме переменных CLI `umiak` (§14.1): `UMIAK_API_KEY`, `UMIAK_API_URL`, `UMIAK_TEAM`, `UMIAK_PROFILE` — так CLI внутри VM получает ключ секретом sandbox (S5 §8.9). Значения с переводом строки в SSH-сессиях не видны (S3 §8.2) — это пишется в описании поля.
- `secretFiles`: до 32 файлов, каждый до 1 MiB, всего до 8 MiB (S3), имя `[A-Za-z0-9._-]{1,128}`, `mode` по умолчанию `0440`, `linkPath` — абсолютный путь.
- **`GET /env`** → `{env: {k: v}, secretKeys: [...], secretFiles: [{name, mode, linkPath, sizeBytes}]}`. Значения секретов не отдаются никогда.
- **`PATCH /env`** (S8 C2, merge: `{K: v | null}`, `null` удаляет) — есть в реализации рядом с `PUT` (§23.6).
- **`PUT /env {env?, secrets?, secretFiles?}`** — каждое переданное поле заменяет свой набор целиком, непереданное не меняется. Ответ `200 {delivered: bool}` + то же, что `GET`. Новые значения видят новые команды; уже запущенные — нет. `delivered: false` значит, что sandbox не `ready` или агент недоступен: S6 доставит набор при следующем resume/reprovision. Метод S6 `updateEnv` — добавление (§20.2).
- Значения env и секретов входят в hash идемпотентности, но нигде не сохраняются, кроме `sandbox_secrets` (S6 §13.1). Логгер `api` вырезает поля `env`, `secrets`, `secretFiles`.

### 8.4 Ресурс Operation

```json
{
  "id": "op_...", "sandboxId": "sb_...",
  "kind": "create",
  "state": "running",
  "step": "claim",
  "error": null,
  "createdAt": "...", "startedAt": "...", "finishedAt": null
}
```

`kind`: `create | fork | stop | resume | recover | delete | save_snapshot` (внутренние `reprovision` наружу не отдаются; в `activeOperation` они выглядят как `null`). `state`: `pending | running | succeeded | failed | superseded`. `error`: `{code, message, retryable}`. `step` — для отладки, значения не входят в контракт.

`forceStop` (S9 §24.8): `null`, кроме fork и save_snapshot, принятых с `forceStop: true` для работающей Windows-sandbox: `{sourceStopped, sourceRestarted, restartError}`. `sourceStopped` — источник остановлен этой операцией; `sourceRestarted` — `true` после запуска, `null` пока не дошло, `false` — запуск не удался: операция всё равно `succeeded` (снапшот цел, fork продолжается), а источник в `error` с `resume_failed` (`restartError {code, message}`), его поднимают обычным `resume`. Если операция упала до снапшота, источник запускается снова её компенсацией; гость, не выключившийся за 300 s, даёт `error {code: "shutdown_timeout", retryable: true}` без снапшота (S9 §24.9).

## 9. Команды

### 9.1 Запуск: `POST /v1/sandboxes/{sandbox}/commands`

```json
{
  "command": "npm test",
  "argv": null,
  "mode": "sync",
  "cwd": "my-app",
  "env": { "CI": "1" },
  "user": "user",
  "stdin": false,
  "timeoutSeconds": 600,
  "encoding": "utf8",
  "tags": { "step": "test" }
}
```

- Ровно одно из `command` (строка для `bash -lc`, на Windows — PowerShell, S9) или `argv` (массив, без shell).
- `mode`: `sync` (по умолчанию) | `stream` | `detached`.
- `timeoutSeconds` — таймаут **процесса**, его исполняет shim агента (статус `timed_out`). Для `sync` по умолчанию 60, максимум 600: sync-запрос всегда завершается. Для `stream` и `detached` по умолчанию `null` (без таймаута).
- `cwd` по умолчанию — домашний каталог пользователя; относительный путь — от него. `user` по умолчанию `user`; `root` разрешён (граница доверия — VM, S2 §16).
- `env` команды не сохраняется (S6 хранит только имена).
- `encoding` — как отдавать вывод: `utf8` (по умолчанию) или `base64` (§9.5).
- `Idempotency-Key` — §5.7. SDK передаёт его всегда.

**Порядок в `api`:**
1. Проверить scope и тело. `touchApiActivity`.
2. Разрешить sandbox. Если `creating`/`starting` — ждать `ready` до 60 s (`waitForState`), затем `409 sandbox_starting` (retryable). Если `stopping`/`stopped`/`error`/`deleting` — `409 sandbox_not_ready` с `details.state`; `deleted` — `404`.
3. `resolveAgentTarget` → `machineId`, capabilities. Нужны `process.v1` (и `process.stdin` при `stdin: true`), иначе `409 agent_outdated`.
4. Идемпотентность: по `Idempotency-Key` найти уже созданную команду (§9.3) или создать строку `commands` (`createCommand`, ULID, статус `starting`).
5. `Process/Start(commandId, spec)` через `agent-client` (повторы и ожидание агента до 30 s — внутри клиента). После ответа статус — `running`.
6. Дальше по `mode` (§9.2).

**Если `Start` не прошёл.** `agent-client` вернул `agent_unavailable` — значит, неизвестно, дошёл ли `Start` до агента. С `Idempotency-Key` ответ `503 agent_unavailable` (`retryable: true`, `details.commandId`): повтор с тем же ключом запустит команду не больше одного раза. Без ключа — `503 agent_unavailable` с `retryable: false`, `details {commandId, outcome: "unknown"}`; клиент может проверить `GET /commands/{commandId}`. Ошибки `invalid_argument` агента → `400 validation`; `too_many_commands` → `409 invalid_state` (`details.reason`).

### 9.2 Режимы

**`sync`** → `200`:

```json
{
  "command": { "...": "Command resource, §9.6" },
  "stdout": "...", "stderr": "...",
  "stdoutTruncated": false, "stderrTruncated": false,
  "stdoutFrom": 0, "stderrFrom": 0
}
```

`api` читает `Attach` до `exit` и собирает вывод. В ответ идёт **хвост** не больше 4 MiB на поток [решение S7]: обычно ошибка видна в конце. `stdoutFrom` — offset начала отданного куска; если `stdoutTruncated`, начало читается через `/output` (§9.4). Если HTTP-клиент отключился раньше, команда продолжает работать (её таймаут не больше 600 s).

**Тишина в sync** [решение S7]. До выхода процесса sync-ответ ничего не шлёт, а прокси по пути (ingress, oauth2-proxy, корпоративные прокси клиента) могут оборвать молчащее соединение. Поэтому:
- S12 ставит таймауты чтения ingress и `--upstream-timeout` oauth2-proxy не меньше 660 s (§17.6);
- SDK, CLI и MCP **не используют** долгий raw sync: хелпер `exec()` шлёт `mode: stream` и сам собирает результат в ту же форму, что у sync (`run` без итерации). Raw `mode: sync` остаётся для curl и простых клиентов, его описание в OpenAPI предупреждает о прокси.

**`stream`** → `200`, `Content-Type: application/x-ndjson`, заголовки `Umiak-Command-Id`, `Cache-Control: no-store`, `X-Accel-Buffering: no`. Кадры — §9.5. Статус `200` фиксируется только после успешного `Start`; всё, что случилось позже, приходит кадрами.

**`detached`** → `201 Command` сразу после `Start`. Вывод — через `/stream` или `/output`.

### 9.3 Повтор с `Idempotency-Key`

Ключ сопоставлен с `commandId` (scope `commands.create`, S6 `idempotency_keys`). Повтор с тем же телом:
- `sync` — подключается к той же команде и ждёт её выхода (если вывод ещё на агенте — тот же результат);
- `stream` — стрим той же команды с offset 0, в кадре `started` поле `replayed: true`;
- `detached` — `200 Command`.

Так SDK может повторить любой `POST /commands` после обрыва сети, `503` или остановки пода `api`, и команда запустится один раз.

### 9.4 Attach, вывод, управление

- **`GET .../commands/{command}/stream?stdoutOffset=&stderrOffset=&ptyOffset=&tailBytes=&follow=true&encoding=utf8`** — NDJSON, первый кадр `attached`. `tailBytes` начинает каждый поток с `max(availableFrom, size − tailBytes)`. `follow=false` отдаёт имеющееся и закрывает стрим (`exit`, если команда завершена).
- **`GET .../commands/{command}/output?stream=stdout&offset=0&limit=1048576`** — сырые байты одного потока (`application/octet-stream`, `limit` до 4 MiB), заголовки `Umiak-Offset`, `Umiak-Next-Offset`, `Umiak-Available-From`, `Umiak-Stream-End` (только если поток закончен). Если `offset < availableFrom`, чтение начинается с `availableFrom` и заголовок `Umiak-Truncated: true`. Это ручка для опроса без стримов (MCP, простые скрипты).
- **`POST .../input {data, encoding: "utf8"|"base64", closeStdin?, sessionId?, seq?}`** → `204`. С `sessionId` + `seq` повтор дедуплицируется агентом (S2 §9.3); без них `api` использует новый `sessionId` на запрос. Для PTY `closeStdin` не применяется (EOF — байт `^D`).
- **`POST .../kill {graceMs?}`** (по умолчанию 10 000) → `200 Command`. **`POST .../signal {signal}`** (`SIGINT`, `SIGTERM`, `SIGKILL`, `SIGHUP`, `SIGUSR1`, `SIGUSR2`, `SIGQUIT`) → `200 Command`. Оба идемпотентны.
- **`GET .../commands/{command}`** → `Command`; если sandbox `ready`, живые поля (`pid`, размеры потоков) из `Process/Get`, иначе из БД.
- **`GET .../commands?status=running&mode=&limit=&cursor=`** → список из `commands` (S6, хранится 90 дней), работает и при остановленной sandbox. Вывод остановленной sandbox недоступен (он в VM) — `409 sandbox_not_ready`.

### 9.5 NDJSON-кадры

Один JSON-объект на строку, `\n`, flush после каждого кадра.

| `type` | Поля | Когда |
|---|---|---|
| `started` | `commandId`, `pid`, `encoding`, `replayed?` | первый кадр в `mode: stream` |
| `attached` | `commandId`, `stdoutOffset`, `stderrOffset`, `ptyOffset?`, `encoding` | первый кадр в `/stream` |
| `stdout` / `stderr` / `pty` | `offset`, `nextOffset`, `data` | вывод |
| `truncated` | `stream`, `availableFrom` | запрошенный offset вытеснен retention-ом агента (S3 §10) |
| `heartbeat` | — | после 15 s тишины |
| `reconnect` | `stdoutOffset`, `stderrOffset`, `ptyOffset?`, `reason: "max_duration" \| "server_shutdown"` | последний кадр; клиент сразу открывает `/stream` с этими offset-ами |
| `exit` | `status`, `exitCode`, `signal`, `reason`, `stdoutOffset`, `stderrOffset`, `ptyOffset?` | последний кадр; приходит только после всего вывода до этих offset-ов |
| `error` | `code`, `message`, `retryable`, `requestId`, `stdoutOffset`, `stderrOffset`, `ptyOffset?` | последний кадр; при `retryable` клиент открывает `/stream` с этими offset-ами |

- `status` в `exit`: `exited | killed | timed_out | lost | failed_to_start` (S6 §5.8; S3 `reason TIMEOUT` → `timed_out`, `START_FAILED` → `failed_to_start`). `reason` — значение S3 в нижнем регистре (`none`, `signal`, `timeout`, `oom`, `pty_idle`, `reboot`, `shim_lost`, `start_failed`).
- **Кодировка.** `base64`: `data` — base64 ровно байтов `[offset, nextOffset)`. `utf8`: `api` декодирует каждый поток потоковым декодером UTF-8; незаконченная многобайтовая последовательность в конце куска (до 3 байт) придерживается до следующего куска, поэтому `nextOffset` всегда стоит на границе символа и повторный attach с `nextOffset` не рвёт символ. Некорректные байты заменяются на U+FFFD, а offset-ы считаются по исходным байтам. Для бинарного вывода — `base64`.
- Пустые куски не отправляются. `offset` кадра равен `nextOffset` предыдущего кадра того же потока, кроме места после `truncated`.

### 9.6 Ресурс Command

```json
{
  "id": "cmd_01jbx...", "sandboxId": "sb_...",
  "mode": "stream",
  "command": "npm test", "argv": null,
  "cwd": "/home/user/my-app", "user": "user",
  "envKeys": ["CI"], "tags": { "step": "test" },
  "timeoutSeconds": 600,
  "status": "running",
  "exitCode": null, "signal": null, "reason": null,
  "pid": 4242,
  "streams": {
    "stdout": { "sizeBytes": 18234, "availableFromBytes": 0, "endBytes": null },
    "stderr": { "sizeBytes": 120, "availableFromBytes": 0, "endBytes": null }
  },
  "createdBy": "usr_...",
  "createdAt": "...", "startedAt": "...", "endedAt": null
}
```

`mode`: `sync | stream | detached | pty`. `status`: `starting | running | exited | killed | timed_out | lost | failed_to_start`. Терминальный статус в БД пишет `api` по кадру `exit` (`completeCommand`) или обработчик событий S6 по `command.exited` — кто раньше.

### 9.7 Возобновляемость от агента до клиента

Три участка, у каждого своя защита:

1. **Агент → `api`.** `api` читает `Process/Attach` через `resumableAttach` из `@umiak/agent-client` (S2 §9.1): обрыв туннеля, `421` при drain gateway, перезапуск агента — повторный attach с ожидаемого offset; вызывающий видит паузу. Если агента нет дольше 30 s, `api` отдаёт клиенту кадр `error` с `code: agent_unavailable`, `retryable: true` и offset-ами.
2. **`api` → клиент.** Offset-ы в каждом кадре данных, `heartbeat` каждые 15 s тишины. SDK считает соединение мёртвым после 45 s без строк и заново открывает `/stream` с последними offset-ами. Стрим живёт не дольше 60 min, затем `reconnect` [решение S7] — это ограничивает долгоживущие соединения через ingress и даёт балансировку между подами.
3. **Под `api` останавливается.** По SIGTERM под перестаёт принимать новые запросы (readiness → false), всем открытым стримам шлёт `reconnect` (`reason: server_shutdown`), PTY-сокетам — управляющий кадр `reconnect` и close `1012`, ждёт до 10 s и выходит. Sync-запросы в полёте получают `503 server_shutting_down`: `retryable: true` только с `Idempotency-Key` (повтор подключится к той же команде), без ключа — `retryable: false`, `details {commandId, outcome: "running"}`. `terminationGracePeriodSeconds: 30`.

Итог для клиента: старт ровно один раз (с ключом), вывод байт в байт по offset-ам (или явный `truncated`), `exit` только после всего вывода.

## 10. PTY (терминал)

### 10.1 Создание

`POST /v1/sandboxes/{sandbox}/ptys` (`Idempotency-Key`):

```json
{ "cols": 120, "rows": 32, "command": null, "cwd": null, "env": {}, "user": "user", "term": "xterm-256color" }
```

`command: null` — login shell пользователя. Ответ `201 Command` (`mode: pty`; повтор с тем же ключом — `200` и `Idempotency-Replayed: true`, §23.4). Нужна capability `process.pty`. PTY без подключённого клиента закрывается агентом через 10 min (S2 §9.3, `reason: pty_idle`).

### 10.2 WebSocket

`GET /v1/sandboxes/{sandbox}/ptys/{command}/connect?offset=&tailBytes=` с upgrade, subprotocol `umiak.pty.v1`.

- Аутентификация: `Authorization: Bearer` (CLI, SDK на Node/Bun/Python) или сессия oauth2-proxy (браузер, с проверкой Origin, §7.4). Браузерный `WebSocket` не умеет ставить заголовки, поэтому из браузера PTY доступен только через `app.<domain>`.
- **Сервер → клиент:**
  - бинарный кадр — подряд идущие байты вывода PTY;
  - текстовый кадр — JSON: `{"type":"attached","offset":N}` (первым), `{"type":"truncated","availableFrom":N}`, `{"type":"exit",...}` (как NDJSON), `{"type":"error","code","message","retryable","details","requestId"}`, `{"type":"reconnect","offset":N,"reason"}`.
  - Клиент считает offset сам: `attached.offset` (или `availableFrom` после `truncated`) плюс число полученных байтов.
- **Клиент → сервер:** бинарный кадр — ввод; текстовый — `{"type":"resize","cols":N,"rows":N}`.
- **Ввод.** `api` назначает `inputSessionId` на каждое WebSocket-соединение и нумерует `seq`; повторы `api` → агент дедуплицируются (S2 §9.3). Байты, которые клиент отправил в момент обрыва WebSocket, могут потеряться: нажатие клавиши теряется, но не повторяется дважды. Склейка нажатий за 5 ms.
- **Backpressure.** Если `bufferedAmount` сокета больше 1 MiB, `api` перестаёт читать `Attach` (поток агента ждёт по flow control HTTP/2).
- **Закрытие:** `1000` после `exit`; `1012` при остановке пода (перед ним кадр `reconnect`); `4401` не авторизован, `4403` нет прав, `4404` нет команды, `4409` sandbox не `ready`, `4503` агент недоступен (переподключиться позже). В реализации ещё `1008`, `1011` и `4416` (§23.4). WebSocket ping от `api` каждые 15 s.
- Клиент (SDK, CLI) переподключается сам с текущим offset; scrollback после переподключения — `tailBytes` (CLI: 64 KiB).
- `POST .../ptys/{command}/resize {cols, rows}` — то же без WebSocket. PTY-вывод также читается NDJSON-ручкой `/commands/{command}/stream?ptyOffset=`, а ввод — `/input`; так PTY доступен клиентам без WebSocket.

## 11. Файлы, порты, SSH

### 11.1 Файлы

Пути: абсолютные или относительные от домашнего каталога `user` (S3 §11.1). Query `user` (по умолчанию `user`) задаёт, от чьего имени разрешаются пути и кто владелец новых файлов. Ограничений на каталоги нет: граница доверия — VM.

- **`GET /files/content?path=`** — байты файла, проксируются потоком от агента (`/files` через gateway, без буферизации). `Range` (один диапазон), `If-Range`, `ETag`, `Last-Modified`, `Accept-Ranges`; `HEAD` тоже. Всегда `Content-Type: application/octet-stream`, `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`: файл из sandbox не должен исполняться в браузере на `app.<domain>`. Каталог — `409 is_directory`.
- **`PUT /files/content?path=&mode=&makeParents=true&overwrite=true`** — тело потоком любого размера, атомарная запись (S3 §11.2). Ответ `200 FileInfo`. Не возобновляется; для файлов больше 64 MiB SDK и CLI используют загрузку чанками.
- **Возобновляемая загрузка:**
  1. `POST /files/uploads {path}` → `{uploadId: "upl_...", chunkSizeBytes: 4194304, maxChunkSizeBytes: 8388608, expiresAt}`. `api` ничего не сохраняет: `uploadId` — новый ULID, временный файл живёт у агента 24 h.
  2. `PUT /files/uploads/{upload}?offset=N` — чанк до 8 MiB; `offset` должен равняться текущему размеру, иначе `409 upload_offset_mismatch` с `Umiak-Upload-Offset`. Ответ `{offset}`. В первом чанке `api` передаёт агенту `path` из `POST` как подсказку (S3 §11.3), поэтому клиент шлёт его и в `PUT` (`?path=`).
  3. `HEAD /files/uploads/{upload}` → `Umiak-Upload-Offset`; `404 upload_not_found`. (Неизвестный или чужой `uploadId` в `PUT` с `offset > 0` — `409 upload_offset_mismatch` с offset `0`, §23.5.)
  4. `POST /files/uploads/{upload}/commit {path, sha256?, mode?, owner?, overwrite?, makeParents?}` → `FileInfo`; идемпотентен по `uploadId` (S3). Несовпадение `sha256` — `422 checksum_mismatch`.
  5. `DELETE /files/uploads/{upload}` — отмена.
  `api` буферизует чанк в памяти (до 8 MiB), чтобы `agent-client` мог повторить его при обрыве туннеля.
- **`GET /files/stat?path=&noFollow=false`**, **`GET /files/list?path=&depth=1&includeHidden=true&limit=&cursor=`**, **`POST /files/mkdir {path, parents?, mode?}`**, **`POST /files/move {from, to, overwrite?}`**, **`POST /files/chmod {path, mode?, owner?, group?, recursive?}`**, **`DELETE /files?path=&recursive=false`** → `200 {existed}`.
- **Архив каталога** (агент — S3 §11.2, правила путей и ошибок — те же, что у остальных ручек `/files`):
  - **`GET /files/archive?path=&format=tar|tar.gz`** — каталог `path` одним потоком tar (по умолчанию `tar`, POSIX pax), проксируется от агента без буферизации; `Content-Type: application/x-tar` или `application/gzip`, `Content-Disposition: attachment`. Имена в архиве — относительно `path`. Не каталог → `409 not_directory`. Без `Range` и без докачки; ошибка посреди потока обрывает ответ без завершающих блоков tar, и клиент видит неполный архив.
  - **`PUT /files/archive?path=&format=tar|tar.gz&overwrite=true&makeParents=true`** (по умолчанию `format=tar`) — тело потоком, распаковка в каталог `path` → `200 {path, entries, sizeBytes}`. Владелец — пользователь `user` запроса, uid/gid из архива игнорируются. Пределы (агент, S3 §11.2): до 200 000 записей, до 16 GiB распакованных данных, путь записи до 4 096 байт, иначе `413 payload_too_large`. Запись с абсолютным путём или `..`, hardlink на путь вне архива и спецфайлы (устройства, FIFO) — `400 invalid_path`. Symlink-и создаются как есть, но распаковка не проходит через symlink внутри `path` (ни из архива, ни уже лежащий на диске; такая запись — `400 invalid_path`), поэтому запись не выходит за `path`. Распаковка не атомарна: при ошибке записанное остаётся (`details.entriesWritten`); кому нужна атомарность, распаковывает в новый каталог и делает `move`. Не возобновляется: SDK повторяет весь архив (с `overwrite=true` повтор безопасен).
- `FileInfo`: `{path, name, type: "file"|"dir"|"symlink"|"other", sizeBytes, mode, owner, group, uid, gid, modifiedAt, symlinkTarget}`.
- Capabilities `files.v1`, для загрузок `files.upload.v1`, для архива `files.archive.v1`. Состояние sandbox — как у команд (§9.1, шаг 2).
- Ошибки агента — по S3 §11.1 и таблице §5.5.
- Не в v1: наблюдение за каталогом, поиск, подписанные URL (§19).

### 11.2 Порты

- **`GET /ports`** → `{hosted: [HostedPort], listening: [{port, addresses, process, user}], listeningObservedAt}`. `listening` — живой `System/ListPorts`, если sandbox `ready`; иначе последний `ports.changed` (S6 §10.2).
- **`PUT /ports/{port}`** `{access?: "token"|"sso"|"public", hostRewrite?: "preserve"|"localhost", appProtocol?: "http1"|"h2c"}`; по умолчанию `token`, `preserve`, `http1` (S4 §8.1). Ответ `201` (новый) или `200`:

```json
{
  "port": 3000,
  "label": "quiet-otter-lamp-3000",
  "url": "https://quiet-otter-lamp-3000.umiak.example.com",
  "access": "token",
  "hostRewrite": "preserve",
  "appProtocol": "http1",
  "blocked": false,
  "blockReason": null,
  "createdAt": "...",
  "token": "umiakp_...",
  "urlWithToken": "https://quiet-otter-lamp-3000.umiak.example.com/?_token=umiakp_..."
}
```

  `token` и `urlWithToken` есть только когда токен выпущен этим вызовом: новый порт в режиме `token` или переход в `token`. S6 хранит только hash, поэтому повторный `PUT` токен не возвращает — потерянный токен заменяется через `rotate-token`. Любая смена режима поднимает `authEpoch` (S4 §8.2).
- **`POST /ports/{port}/rotate-token`** → `{token, urlWithToken}`; старый токен и cookie перестают действовать сразу.
- **`DELETE /ports/{port}`** → `204`.
- Проверки: порт 1–65535; не `22` и не из списка зарезервированных платформой (конфиг, общий с gateway); не больше 50 портов на sandbox (S4); `public` запрещён, если оператор выключил его глобально (`403 forbidden`, `details.reason: "public_disabled"`).
- Публиковать можно в любом состоянии, кроме `deleting`/`deleted`: gateway сам покажет страницу «остановлена» (S4 §6.3).

### 11.3 SSH

- **SSH-ключи пользователя** (уровень пользователя, не команды): `GET /v1/ssh-keys`, `POST /v1/ssh-keys {name, publicKey}` → `201 {id: "sshk_...", name, fingerprint: "SHA256:...", type, createdAt, lastUsedAt}`, `DELETE /v1/ssh-keys/{key}`. Типы: `ssh-ed25519`, `ecdsa-sha2-nistp256/384/521`, `ssh-rsa` не короче 3072 бит; сертификаты не принимаются. Отпечаток уникален во всей платформе (`409 ssh_key_in_use`): по нему gateway однозначно находит пользователя. Хранение — коллекция S8 (§17.3).
- **`GET /v1/sandboxes/{sandbox}/ssh`** → `{host: "ssh.example.com", port: 22, username: "quiet-otter-lamp", loginUser: "user", command: "ssh quiet-otter-lamp@ssh.example.com", knownHosts: ["ssh.example.com ssh-ed25519 AAAA...", "ssh.example.com ecdsa-sha2-nistp256 AAAA..."], hasKeys: true}`; `hasKeys` — есть ли у человека зарегистрированные SSH-ключи (у командного ключа всегда `false`). `knownHosts` — host keys gateway из конфига (`UMIAK_SSH_HOST_KEYS_FILE`, только публичные), одинаковые для всех sandbox (S4 §9.2).
- **`POST /v1/sandboxes/{sandbox}/ssh/certificate {publicKey}`** (`ssh:connect`; человек с JWT или сессией и командный ключ) → `{certificate, principal, validAfter, validBefore, host, port, username, knownHosts}` [решение Ильи 2026-10-29: короткие сертификаты на ту же личность]. `api` подписывает **SSH login CA** (ed25519, закрытый ключ только у `api`: `UMIAK_SSH_LOGIN_CA_KEY_FILE`; публичный — у gateway, S4 §9.2) сертификат пользователя: `ValidPrincipals: [<sb_… id sandbox>]`, `KeyId: umiak:user:<usr_…>` или `umiak:key:<key_…>`, `ValidAfter` = сейчас − 60 s, `ValidBefore` = сейчас + 10 min (проверяется только при входе, сессия живёт дольше), случайный serial, расширения `permit-pty`, `permit-port-forwarding`, `permit-agent-forwarding`, `permit-X11-forwarding`, `permit-user-rc`. Типы ключа — как у SSH-ключей выше. Состояние sandbox не проверяется (остановленную sandbox gateway объясняет сам, S4 §9.3). Это основной путь для CLI и единственный для командных ключей; зарегистрированные SSH-ключи остаются для людей с обычным `ssh`.
- Право входа проверяет `ssh/authorize` (§12.1) на каждом подключении, поэтому деактивация пользователя, удаление из команды и отзыв ключа действуют сразу, а не по истечении сертификата.

## 12. Внутренние ручки и свои таблицы

### 12.1 Internal listener

Все — с service token gateway (§7.8).

**`POST /internal/v1/agent-events`** — тело `AgentEventsRequest` (protojson, план `s2-impl`; в реализации — binary protobuf, §23.3), вызывает `core.events.ingest`, ответ `{ackedSeq}` (S6 §10.1). Тонкая обёртка.

**`GET /internal/v1/gateway/routes/{label}`** [переопределяет S6 §14.2: путь из S4] — ответ ровно по S4 §6.1:

```json
{
  "label": "quiet-otter-lamp-5173", "sandboxId": "sb_...", "slug": "quiet-otter-lamp", "port": 5173,
  "machineId": "0192..." , "sandboxState": "ready",
  "access": "token", "tokenHash": "<hex>", "authEpoch": 7,
  "blocked": false, "blockReason": null,
  "hostRewrite": "preserve", "appProtocol": "http1", "teamId": "team_..."
}
```

- `sandboxState` — состояние S6 как есть [переопределяет S4 §6.3]: gateway получает только `creating`, `ready`, `stopping`, `stopped`, `starting`, `error`, `deleting`, `deleted`. Значений `running` и `resuming` не бывает. Соответствие для gateway: `ready` → проксировать; `creating`, `starting` → `503 sandbox_starting`; `stopping`, `stopped` → `503 sandbox_stopped`; `deleting`, `deleted` → `404 route_not_found`; `error` и неизвестное → `503 sandbox_unavailable`.
- `blocked`: порт или sandbox заблокированы оператором (S8) или `access = public` при выключенном `public` (`blockReason: "public_disabled"`).
- `404 {"code": "route_not_found"}` — нет sandbox со slug, порт не опубликован, sandbox `deleted`, метка вне грамматики или с зарезервированным суффиксом.
- ID в этом ответе — публичного формата (`sb_`, `team_`), `machineId` — UUID (S2).

**`POST /internal/v1/gateway/ssh/authorize`** [переопределяет S6 §14.2: путь и форма из S4 §9.2] — `{sandbox, publicKey, fingerprint}` (зарегистрированный ключ) или `{sandbox, certificate: {keyId, serial, principal, validBefore}}` (сертификат, подпись и срок которого gateway уже проверил, S4 §9.2):
1. Ключ: найти SSH-ключ по `fingerprint`, проверить, что `publicKey` совпадает с сохранённым. Сертификат: разобрать `keyId` (`umiak:user:<id>` или `umiak:key:<id>`); `principal` равен ID sandbox из запроса.
2. Пользователь (`umiak:user`, зарегистрированный ключ): активен и участник команды sandbox (S8 C6, без исключения для оператора). Командный ключ (`umiak:key`): не отозван, не истёк, его команда — команда sandbox, есть scope `ssh:connect`.
3. Sandbox существует и не `deleted`.
→ `200 {allowed: true, actor: {kind: "user", userId, email} | {kind: "team_key", apiKeyId}, userId, email, sandboxId, machineId, sandboxState, loginUser}` (`userId` и `email` — `null` у командного ключа) или `200 {allowed: false}` (без причины: gateway её не показывает). `loginUser` — из шаблона (S8 `Template.loginUser`, по умолчанию `user`). Обновить `lastUsedAt` ключа (не чаще раза в 60 s).

**`POST /internal/v1/gateway/port-auth/exchange`** `{code, label}` — атомарно: `UPDATE port_auth_codes SET used_at = now() WHERE code_hash = $1 AND label = $2 AND used_at IS NULL AND expires_at > now() RETURNING user_id, email, auth_epoch`. Ответ `{userId, email, label, authEpoch}` или `400 {"code": "invalid_code"}`.

### 12.2 Таблицы S7

Схема `runtime`, миграции в `db/migrations/` с номерами **0300–0399** [переопределяет S6 §5.12: диапазон S6 — 0200–0299]:

```
port_auth_codes(
  code_hash bytea pk,           -- sha256 of the 32-byte code
  label text, user_id text, email text, auth_epoch int,
  expires_at timestamptz,       -- now() + 60 s
  used_at timestamptz null, created_at timestamptz)
```

Cleanup S6 (§15.4 S6) удаляет строки старше суток; S7 добавляет в него эту таблицу. Таблицы `cli_logins` нет: вход CLI — device grant Keycloak (§7.6).

## 13. Каталог, аккаунт, снапшоты, ключи

- **`GET /v1/templates`** → `{data: [{slug, name, os, enabled, defaultSize, allowedSizes, loginUser, capabilities: ["exec","files","ssh","desktop"], version}]}`. `version` — активная сборка (S6 `template_builds`). Выключенные шаблоны видят только операторы.
- **`GET /v1/sizes`** → `{data: [{slug, vcpu, memoryMb}]}`.
- **`GET /v1/me`** → `{user: {id, email, name} | null, team: {id, name, role}, teams: [{id, name, role}], isOperator, auth: {kind: "session" | "oidc" | "team_key", apiKeyId?, scopes, expiresAt?, createdBy?}}`. У командного ключа `user: null`, `teams` — только его команда, `role: null`.
- **`GET /v1/limits`** → `{quota: {maxActiveSandboxes, maxRamMb, maxSavedSnapshots}, usage: {activeSandboxes, ramMb, savedSnapshots}, remaining: {activeSandboxes, ramMb, savedSnapshots}, canCreate, templates: [{slug, enabled, defaultSize, sizes: [{slug, vcpu, memoryMb, allowed, reason, warmAvailable}]}], rateLimits: {requestsPerSecond, burst, startsPerMinute}}`. Для команды запроса; `usage` и `remaining` считаются по правилам квот S6 §8.5.
  - `canCreate` — можно ли сейчас создать sandbox хотя бы одного допустимого размера.
  - `sizes` — все размеры из `allowedSizes` шаблона; `allowed: false` с `reason`: `template_disabled`, `quota_active_sandboxes`, `quota_ram`. Выключенные шаблоны видят только операторы (как в `/templates`).
  - `warmAvailable` — **фаза 2, вне публичного контракта MVP (решение Ильи 2026-10-29)**, в ответе MVP поля нет: число `warm` machine пары сейчас (подсказка для `failFast`, §8.2; не резерв). Ёмкость нод (`out_of_capacity`) заранее не обещается.
  - `usage` и счётчики пула — метод S6 (добавление, §20.2; счётчики пула — фаза 2).
- **`GET /v1/meta`** (без auth) → `{apiVersion: "v1", build, appUrl, apiUrl, umiakDomain, oidc: {issuer, clientId: "umiak-cli", audience: "umiak-api"}, ssh: {host, port, hostKeys}, minCliVersion, latestCliVersion}`.
- **Saved snapshots** (адресуются по имени внутри команды; имя `^[a-z0-9][a-z0-9-]{0,62}$`):
  - `POST /v1/snapshots {sandbox, name, forceStop?}` (`Idempotency-Key`) → `202 {snapshot, operation}`. Существующий снапшот с тем же именем заменяется, когда новый станет `ready` (S6 §7.8). Работающая Windows-sandbox сохраняется только из остановленной VM: без `forceStop: true` — `409 snapshot_requires_stop` (сообщение «Windows snapshots are saved from a stopped VM; …»), с ним — stop → snapshot → start, как у fork (§8.2, S9 §24.8). Linux и остановленный источник флаг игнорируют.
  - `GET /v1/snapshots` → список, включая `creating` (их `name` — ожидаемое имя) и `failed` за последние сутки; `GET /v1/snapshots/{name}` → ready-снапшот или создающийся с этим именем.
  - `DELETE /v1/snapshots/{name}` → `204` (S6 сразу освобождает имя).
  - Ресурс: `{id: "snap_...", name, state: "creating"|"ready"|"failed"|"deleting", sourceSandboxId, template, templateVersion, size, consistency: "quiesced"|"powered_off"|"crash", error, createdAt, readyAt}`. Linux, снятый вживую, — `quiesced`; источник, остановленный штатным выключением (`clean_stop`), и любой Windows — `powered_off`. Linux, остановленный без штатного выключения (hard stop, падение VM), — `crash` (S6 §7.9, S9 §24.9). Windows без штатного выключения не снимается: `409 snapshot_requires_clean_stop`.
  - Create из снапшота — `POST /v1/sandboxes {from: {snapshot: name}}`.
- **API-ключи:**
  - `GET /v1/api-keys` — все ключи команды запроса; видят все участники и ключ с `keys:admin`;
  - `POST /v1/api-keys {name, scopes? | preset?, expiresInSeconds?, kind?}` → `201 {apiKey, secret}` — только `owner`-человек (§7.2); `expiresInSeconds` по умолчанию 90 дней, максимум 365; `kind` — только `team` (по умолчанию), пресет `sandbox-self` командным ключам не выдаётся;
  - `POST /v1/api-keys/{key}/rotate` → `200 {apiKey, secret}` — только `owner`-человек: новый секрет, старый перестаёт работать сразу;
  - `DELETE /v1/api-keys/{key}` → `204` (`owner`, оператор или ключ с `keys:admin`); `DELETE /v1/api-keys/self` → `204`.
  - Ресурс: `{id: "key_...", kind: "team", sandboxId: null, teamId, name, prefix, last4, scopes, createdBy: {id, email, active, member}, createdVia: "api"|"cli"|"dashboard", createdAt, expiresAt, lastUsedAt, revokedAt}`; `createdBy.active` и `member` показывают, что создатель деактивирован или вышел из команды (ключ при этом работает, S8 §9.8); `kind: "sandbox"` зарезервирован (§7.2).

## 14. CLI `umiak`

### 14.1 Сборка и конфигурация

- `apps/cli` на `@umiak/sdk`, разбор аргументов — `commander`. Сборка `bun build --compile --target=bun-<os>-<arch>` для `linux-x64`, `linux-arm64`, `darwin-arm64`, `darwin-x64`, `windows-x64`. Бинарники и `SHA256SUMS` — в GitHub Releases (§15.5).
- Конфиг `$XDG_CONFIG_HOME/umiak/config.json` (по умолчанию `~/.config/umiak/`, Windows — `%APPDATA%\umiak\`), права `0600`: профили `{name: {apiUrl, team, auth: "oidc" | "key"}}`, текущий профиль; секреты (токены Keycloak, командный ключ) — в хранилище ОС или `credentials.json` (§7.6). Порядок: флаги > env (`UMIAK_API_URL`, `UMIAK_API_KEY`, `UMIAK_TEAM`, `UMIAK_PROFILE`) > профиль > системный `/etc/umiak/config.json` (только `apiUrl`; его кладёт шаблон, S5 §8.9).
- Кэш `known_hosts` для SSH — `~/.config/umiak/known_hosts`, обновляется из `/v1/meta`.

### 14.2 Команды

| Команда | Что делает |
|---|---|
| `umiak login [--no-browser] [--key-stdin] [--api-url] [--credential-store]`, `logout [--revoke]`, `whoami`, `auth token [--json]` | §7.6; `whoami` = `/me`; `auth token` — для SDK и MCP |
| `umiak create [--template] [--size] [--name] [--slug] [--label k=v] [--env K=V] [--secret K=V] [--env-file f] [--ttl] [--idle] [--from snap] [--fail-fast] [--wait]` | create; `--wait` ждёт `ready` и печатает его; `--fail-fast` — §8.2, **фаза 2, вне публичного контракта MVP (решение Ильи 2026-10-29)**, в CLI MVP флага нет |
| `umiak list [--state] [--label]`, `umiak info <sb>` | |
| `umiak stop\|resume\|recover <sb> [--wait]`, `umiak fork <sb> [--name] [--force-stop] [--wait]`, `umiak rm <sb>... [--yes]` | `resume` и `fork` принимают `--env K=V`, `--secret K=V`, `--env-file f` (§8.2); `fork --force-stop` и `snapshot save --force-stop` шлют `forceStop: true` (работающая Windows, S9 §24.8); на `409 snapshot_requires_stop` CLI печатает сообщение API и подсказку `use --force-stop`; `rm` спрашивает подтверждение в TTY без `--yes` и шлёт `Umiak-Confirm-Delete` (§5.12); без TTY и без `--yes` — ошибка аргументов |
| `umiak current [<sb> \| --clear]` | печатает текущую sandbox этого shell; с `<sb>` — делает её текущей |
| `umiak rename <sb> <slug>`, `umiak extend <sb> [--ttl]`, `umiak label <sb> k=v...` | |
| `umiak env <sb> [--set K=V] [--secret K=V] [--unset K]` | `GET`/`PUT /env` (в реализации `GET`/`PATCH /env`: флаги — merge, §23.7) |
| `umiak exec <sb> [--cwd] [--env] [--user] [--timeout] [--detach] [--stdin] -- <cmd...>` | по умолчанию — стрим вывода живьём (stdout в stdout, stderr в stderr), код выхода `umiak` = код команды. Автоматический reattach. `--detach` печатает `commandId` |
| `umiak logs <sb> <cmd> [-f] [--tail N]`, `umiak kill <sb> <cmd> [--signal]`, `umiak ps <sb>` | attach, kill, список команд (`--tail` — байты на поток, §23.7); `logs -f` ждёт конца команды и выходит с её кодом, как `exec`; `logs` без `-f` выходит с `0` |
| `umiak shell <sb> [-- <cmd>]` | PTY по WebSocket в raw-режиме TTY; размер по `SIGWINCH`; переподключение само |
| `umiak ssh <sb> [-- ssh args]`, `umiak ssh-config <sb>` | `ssh`: эфемерный ed25519 в каталоге `0700`, сертификат `POST /ssh/certificate` (§11.3), системный `ssh` с `-i`, `CertificateFile` и `-o UserKnownHostsFile=<кэш>` к `<slug>@ssh.<domain>`; файлы удаляются после выхода. `ssh-config` печатает блок `Host` с `Match exec "umiak ssh-cert <sb> --ensure"` (в реализации `Match originalhost <alias> exec ...`, §23.7), чтобы обычный `ssh` и VS Code Remote-SSH сами получали свежий сертификат. Работает и с командным ключом |
| `umiak ssh-cert <sb> [--ensure]` | выпускает или обновляет сертификат для `ssh-config` (новый, если до конца срока меньше 2 min) |
| `umiak ssh-keys list\|add [file]\|rm` | по умолчанию `~/.ssh/id_ed25519.pub` |
| `umiak cp [-r] <src> <dst>` | `sb:path` с любой стороны; файлы больше 64 MiB — загрузка чанками с докачкой, скачивание — с `Range`; `-r` — каталог через `/files/archive` (§11.1) |
| `umiak push [dir] <sb>:<path>` | в git-репозитории — файлы из `git ls-files -co --exclude-standard`, иначе весь каталог; tar.gz потоком в `PUT /files/archive` |
| `umiak port <sb> <port> [--public\|--sso\|--token]`, `umiak ports <sb>`, `umiak unport <sb> <port>`, `umiak port-token <sb> <port>` | печатает URL (с токеном, если выпущен) |
| `umiak snapshot save <sb> <name> [--force-stop] [--wait]`, `snapshot list\|rm` | `--force-stop` — как у `fork`; `save --wait` ждёт, пока снапшот станет `ready` (лимит `--wait-timeout`, по умолчанию 5 min), и печатает его; ошибка сохранения — код `1`, таймаут ожидания или временная ошибка (`retryable`) — `75` |
| `umiak templates`, `umiak sizes`, `umiak limits` | |
| `umiak keys list\|create [--preset] [--scope]...\|rotate\|rm` | командные ключи; `create`, `rotate` — только `owner` с входом Keycloak |
| `umiak run [create flags] [--push dir] [--keep] -- <cmd...>` | create → push → exec → delete; код выхода — код команды |
| `umiak mcp [--toolsets] [--read-only] [--sandbox]` | MCP-сервер по stdio на учётных данных CLI (S11 §6.1); в S7 — заглушка, §23.1 |
| `umiak completion bash\|zsh\|fish\|powershell`, `umiak version` | |

Флаги и команды сверх таблицы, закрытый stdout (код `141`), `--cacert` — §23.7.

`<sb>` — ID или slug. Если не указан, берётся `UMIAK_SANDBOX`, затем текущая sandbox shell, затем (внутри VM) `UMIAK_SANDBOX_ID` из env платформы (S3 §8.2; там UUID из S6, CLI сам переводит его в `sb_…`, §5.3).

**Текущая sandbox** [MVP-рек. R1]. `create`, `fork` и любая команда с явным `<sb>` делают эту sandbox текущей для shell. Ключ shell — `UMIAK_SESSION`, если задан, иначе PID родительского процесса и время его старта; состояние — `$XDG_STATE_HOME/umiak/current/<key>` (на Windows — `%LOCALAPPDATA%\umiak\`), старше 7 дней удаляется. `umiak current` печатает `{sandbox}` (ресурс §8.1) или выходит с кодом `3`, если текущей нет или она удалена.

### 14.3 Вывод и коды выхода

- **JSON, когда stdout не TTY** [MVP-рек. R1]. В TTY — таблицы и строки для человека; если stdout не TTY — JSON, как с `--json`. `--json` (или `UMIAK_OUTPUT=json`) включает JSON и в TTY, `--human` (`UMIAK_OUTPUT=human`) — текст и без TTY. (Команды с сырым выводом переключает в NDJSON только явный `--json`, не `UMIAK_OUTPUT`, §23.7.) Исключение — команды, чей stdout — это данные: `exec`, `run`, `logs`, `shell`, `ssh`, `cp`/`push` в stdout пишут сырой вывод при любом stdout (`umiak exec sb -- cat f > out` пишет байты файла); для `exec`, `run`, `logs` с явным `--json` — кадры NDJSON как в API.
- **Форма JSON.** Обычные команды — одна JSON-структура (ресурс API как есть). Ждущие команды (`create --wait`, `fork --wait`, `resume --wait`, `recover --wait`, `stop --wait`) — JSON Lines: `{"event":"accepted","sandbox":{...},"operation":{...}}`, `{"event":"state",...}` при смене состояния, последним — `{"event":"ready","sandbox":{...}}` (у `stop --wait` — `{"event":"stopped",...}`). `snapshot save --wait` — так же: `{"event":"accepted","snapshot":{...},"operation":{...}}`, последним — `{"event":"ready","snapshot":{...}}` (у снапшота нет промежуточных состояний, строк `state` нет). Поле-дискриминатор строк JSONL у CLI всегда `event`: кадры API (§9.5) в `exec`/`run`/`logs --json` печатаются с `event` вместо `type`.
- **Ошибка — последняя строка stdout** в режиме JSON: `{"event":"error","code","message","retryable","details","requestId"}` (поля из §5.5; ошибка CLI без ответа API — те же поля, `requestId: null`), у любой команды, в том числе после строк JSONL. Текст для человека — в stderr. У команд с сырым выводом (`exec`, `run`, `logs`, `cp`, `push`) без явного `--json` stdout занят данными, поэтому эта строка идёт в stderr.
- Коды выхода (одинаковы в TTY и в JSON): `0` — успех; `1` — ошибка API или CLI; `2` — ошибка аргументов; `3` — не найдено; `4` — нет прав или нет входа; `75` — временная ошибка (retryable, исчерпаны повторы); для `exec`/`run`/`logs -f` — код команды (`128 + n` для сигнала, `124` для `timed_out`, `125` для `lost`/`failed_to_start`).

## 15. OpenAPI и SDK [решение Q4]

### 15.1 OpenAPI

- Маршруты описываются через `createRoute` из `@hono/zod-openapi`; zod-схемы — источник правды для валидации и документа. OpenAPI 3.1.
- `operationId` — `<resource>.<action>` (`sandboxes.create`, `commands.attach`); у каждой операции `summary` и `description`, написанные для человека и LLM (их использует S11).
- NDJSON-ручки: `content: application/x-ndjson` со схемой кадра (`oneOf` с `discriminator: type`). WebSocket в OpenAPI 3.1 не описывается: ручка `connect` описана как `GET` с ответом `101` и расширением `x-umiak-websocket: {subprotocol: "umiak.pty.v1"}`, протокол — в документации.
- **Security schemes:** `keycloak` — `type: openIdConnect`, `openIdConnectUrl: {issuer}/.well-known/openid-configuration` (Keycloak JWT, §7.10); `teamKey` — `type: http`, `scheme: bearer`, `bearerFormat: "umiak_"` (§7.2). Глобально `security: [{keycloak: []}, {teamKey: []}]`; ручки только для человека (SSH-ключи, выпуск и ротация ключей) — `[{keycloak: []}]`; `/v1/meta`, `/v1/openapi.json`, `/v1/docs` — `security: []`. Браузерная сессия (proxied listener) в документе не описывается: она для дашборда того же origin.
- Enum ответов помечены `x-extensible-enum`; генераторы настроены так, чтобы неизвестное значение не роняло клиент (§15.2, §15.3).
- `pnpm --filter @umiak/api openapi` пишет `apps/api/openapi/v1.json` (коммитится). CI: регенерация без расхождений, `oasdiff breaking` против `main`.
- Документация — `GET /v1/docs` (Scalar) по тому же документу; только public listener, версия закреплена с SRI (§23.3).

### 15.2 TypeScript: `@umiak/sdk`

- `openapi-typescript` генерирует `src/gen/v1.d.ts` (коммитится, CI проверяет свежесть); транспорт — `openapi-fetch`. Работает на Node ≥ 22, Bun, Deno и в браузере (без PTY через Bearer, §10.2).
- Фасад:

```ts
const umiak = new Umiak({ baseUrl: "https://api.example.com", team?: "team_..." }) // credentials: apiKey | accessToken | tokenProvider, else chain §7.6

const sb = await umiak.sandboxes.create({ template: "linux", secrets: { TOKEN: "..." } }, { wait: true })
const r = await sb.exec("npm test", { cwd: "app", timeoutSeconds: 600 })        // sync result
for await (const ev of sb.run("npm run build")) { /* stdout/stderr/exit, auto-reattach */ }
const cmd = await sb.start("python3 -m http.server 8000")                     // detached
for await (const ev of cmd.follow({ from: "start" })) { /* ... */ }
await sb.files.writeText("notes.txt", "hi"); const s = await sb.files.readText("notes.txt")
await sb.files.upload("big.tar", fileOrStream)                                // chunked, resumable
const port = await sb.ports.host(8000, { access: "public" })
const pty = await sb.pty({ cols: 120, rows: 32 }); pty.onData(b => ...); pty.write("ls\n"); pty.resize(100, 30)
for await (const s of umiak.sandboxes.list({ label: { session: "42" } })) { /* all pages */ }
await sb.delete()
```

- Низкоуровневый клиент (`umiak.raw`) — сам `openapi-fetch` со всеми операциями.
- Учётные данные — цепочка §7.6 (явные параметры → `UMIAK_API_KEY` → `UMIAK_ACCESS_TOKEN` → `umiak auth token --json`); на `401 token_expired` SDK один раз берёт новый токен и повторяет запрос.
- Ошибки — класс `UmiakError {status, code, message, retryable, details, requestId}`.
- Каждый метод фасада и `umiak.raw` принимает `signal: AbortSignal` (прерывает запрос, long-poll, чтение стрима и повторы) и `retryBudgetMs` (общий срок повторов на этот вызов вместо 60 s, §15.4). Нужно MCP для срока вызова инструмента (S11 §7.5).

### 15.3 Python: `umiak-sdk`

- `openapi-python-client` генерирует `umiak_sdk/_gen` (httpx + attrs, sync и async), конфиг генератора с `literal_enums: false` и разбором неизвестных значений; сгенерированное коммитится. Python ≥ 3.11. Проект на uv (`pyproject.toml`), тесты pytest, линт ruff.
- Фасады `Umiak` и `AsyncUmiak` с теми же методами в `snake_case` (`sb.exec`, `sb.run`, `cmd.follow`, `sb.files.read_text`, `sb.files.upload`, `sb.pty`, `umiak.sandboxes.list` как итератор). NDJSON — `httpx` `stream()` + `iter_lines()`; PTY — `websockets` (sync и asyncio API).
- `UmiakError` с теми же полями.
- В реализации MVP: без `pty` и `upload_dir`/`download_dir`; вместо `signal` — `timeout` и `retry_budget`; синхронный фасад генерируется из асинхронного (§23.8).

### 15.4 Хелперы и политика повторов (одинаковы в TS и Python)

| Хелпер | Что делает | Отличие от boat (`research/03` §5) |
|---|---|---|
| `waitUntilReady(timeout=300 s)` | long-poll `GET ?waitFor=ready`; ошибка `SandboxFailedError`, если `error`/`deleting`/`deleted`/`stopped` | long-poll вместо опроса раз в 2 s |
| `waitForOperation(op)` | long-poll операции | у boat нет |
| `exec(cmd, opts)` | `mode: stream` с `Idempotency-Key`, вывод собирается в результат формы sync (хвост 4 MiB на поток); reattach и повторы как у `run` | boat повторяет sync без ключа и может запустить дважды; молчащий sync рвут прокси |
| `run(cmd, opts)` | `mode: stream`, итератор кадров `stdout/stderr/exit`; при обрыве или `error{retryable}` — reattach с offset-ами; `heartbeat`/`reconnect`/`attached` скрыты; ранний выход из цикла команду не убивает | boat: stream не возобновляется, долгие — через detached |
| `start(cmd)` + `follow(from)` | detached + attach с автопереподключением (45 s без строк = обрыв) | как `run_command` + `follow_command` у boat, но с повтором `start` по ключу |
| `readText`/`writeText`, `readBytes`/`writeBytes` | `/files/content` | у boat через JSON с base64 до 5 MiB |
| `upload(path, src)`, `download(path, dest)` | чанки 4 MiB с докачкой по `HEAD`; скачивание с `Range` и `If-Range` | у boat signed URL без докачки |
| `uploadDir(local, path)`, `downloadDir(path, local)` | каталог одним tar-потоком через `/files/archive` | у boat только в CLI |
| `pty(opts)` | WebSocket с автопереподключением по offset | у boat нет |
| `stopAndDelete()` | delete с `Umiak-Confirm-Delete` (§5.12; stop не нужен) | |
| `sandboxes.list()` | итератор по всем страницам | |

**Политика повторов транспорта SDK** [решение S7]:
- Повторяются: `GET`/`HEAD`/`PUT`/`DELETE` на сетевых ошибках, `502`, `503`, `504`, `429`; `POST` — только если у запроса есть `Idempotency-Key` (SDK ставит его сам для ручек из §5.7) или в ответе `retryable: true`. Исключение (**фаза 2, вне публичного контракта MVP, решение Ильи 2026-10-29**) — `503 pool_exhausted`: SDK и CLI его не повторяют, а сразу отдают вызывающему (иначе `failFast` теряет смысл; CLI выходит с кодом `75`).
- Backoff: 0,5 s × 2 до 8 s с full jitter, `Retry-After` имеет приоритет, всего до 60 s (настраивается). `retryable: false` не повторяется никогда.
- Стримы (`run`, `follow`, PTY) переподключаются с offset-ами без общего лимита времени, пока есть прогресс; 20 подряд неудачных попыток без новых байтов — ошибка.

### 15.5 Распространение

- В монорепо `apps/web` (S8), `apps/mcp` (S11), `apps/cli` используют `@umiak/sdk` как workspace-пакет.
- Релиз по тегу `sdk-v<semver>` / `cli-v<semver>` (GitHub Actions в приватном репозитории): в GitHub Releases кладутся wheel и sdist `umiak-sdk`, `npm pack`-архив `@umiak/sdk`, бинарники CLI и `SHA256SUMS`. Установка: `pip install <url wheel>` / `npm install <url tgz>` с токеном GitHub, CLI — скачивание бинарника. GitHub Packages (npm под scope владельца) — по необходимости позже.
- Версия SDK независима от версии API; SDK поддерживает весь `/v1`.

## 16. Тесты и приёмка

**Unit (vitest, pytest):**
- кодек ID (UUID ↔ `sb_...`, ULID ↔ `cmd_...`), парсер и генератор slug (грамматика S4, суффиксы, зарезервированные), формат и CRC ключа, разбор bearer (ключ или JWT, §7.10);
- матрица «ручка × scope»: каждая ручка из §6 отклоняет ключ без нужного scope;
- таблица ошибок S6/агента → HTTP (§5.5);
- UTF-8-декодер кадров: разрезы внутри многобайтовых символов, некорректные байты, reattach с `nextOffset` даёт тот же текст;
- курсоры (HMAC, подделка), канонизация тела для идемпотентности.

**Интеграционные** (Postgres 18, `packages/core` S6 с фейком worker, настоящие gateway-библиотека и туннель из `tunnelharness` `s2-impl`).

(В реализации Go-фейка нет: тесты идут на TS-фейке `FakeAgent` с настоящими процессами, решение 3, §23.9.) Двойник `umiak.testing.v1.Process` из S2 для этих тестов не годится: у него нет `pty_offset`, `SendInput`, `Kill`, `Get`, `Filesystem`, `/files/*` и `ListPorts`. Поэтому [решение S7, по прецеденту S6 §16]: исполнитель S7 добавляет в Go фейковый агент `umiak.agent.v1` (`libs/tunnel/tunneltest/agentv1fake`) и флаг `tunnelharness -agent fake-v1`, согласуя это с `s2-impl` (добавление, существующие тесты S2 не трогает). Фейк:
- запускает настоящие дочерние процессы и пишет их вывод в файлы с offset-ами;
- реализует `Process` (включая PTY через `creack/pty`, `SendInput`, `Update`, `Kill`, `Get`, `Attach` с `tail_bytes`/`follow`), `Filesystem` и `/files/*` поверх временного каталога, `System/ListPorts`;
- соблюдает контракты S2 §9 и S3 §9–§11: идемпотентность `Start`, `Umiak-Request-Id`, `exit` после всего вывода, `truncated`.
Сгенерированный TS-код `umiak.agent.v1` берётся из `proto/umiak/agent/v1` (S3). Если `s3-impl` ещё не положил proto, S7 начинает с протокола из S3 §9–§13 и сверяется при слиянии. Поведение настоящего агента проверяет E2E на `pve`.

Сценарии:
- **Chaos стрима (главный).** SDK `run()` команды на 3000 строк × 512 B; каждые 100–400 ms случайный сбой: обрыв туннеля, drain gateway, перезапуск агента, **остановка процесса `api`** (второй экземпляр `api` подхватывает). sha256 stdout и stderr совпадают с ожидаемыми, код выхода верный, `Start` агента выполнен один раз.
- **Идемпотентность команд.** Повтор `POST /commands` с тем же ключом после обрыва в каждой точке (до `Start`, после `Start` до ответа, в середине стрима) — одна команда у агента.
- **Безопасность:** `X-Auth-Request-Email` на public listener-е игнорируется; запрос на proxied без `Origin` или с чужим `Origin` — `403`; WebSocket upgrade с чужим `Origin` — отказ; код `port-auth` второй раз и с чужим `label` — `invalid_code`; секреты не попадают в логи (перехват логгера в тестах create, `PUT /env`, `POST /api-keys`).
- **Keycloak JWT** (тестовый Keycloak 26.8 в контейнере или подписанные тестовым JWKS токены): чужой `iss`, нет `aud=umiak-api`, `alg: none` и `HS256`, истёкший (`token_expired`), ID token и refresh token вместо access token, чужой `azp` → `401`; неизвестный `kid` → JWKS перечитывается один раз; первый запрос с JWT создаёт пользователя так же, как браузер, и `sub` совпадает с `X-Auth-Request-User`; деактивированный пользователь с живым токеном → `403 user_disabled`; device grant: `umiak login` → `umiak auth token` → SDK использует тот же токен; выключенный в Keycloak пользователь не обновляет токен.
- **Командные ключи:** `member` и ключ не могут выпустить ключ (`403`); ключ работает после удаления создателя из команды и после его деактивации; `owner` отзывает ключ; ключ не вызывает человеческие ручки (`user_required`).
- **SSH-сертификаты:** сертификат от чужого CA, истёкший, с principal другой sandbox, по отозванному ключу или деактивированному пользователю → вход отклонён; `KeyId` в журнале sshd VM (S4 §9.3).
- **Файлы:** загрузка 100 MiB с обрывом в середине и докачкой через `HEAD`; `Range` и `If-Range`; `checksum_mismatch`; архив каталога туда и обратно (sha256 файлов совпадают), отказ на `..`, абсолютном пути и записи через symlink, пределы `413`.
- **Контракт CLI и ошибок:** без TTY CLI печатает JSON, `create --wait` даёт JSONL с последней строкой `ready`, ошибка — последняя строка `{"event":"error",…}`; у любой ошибки API есть `retryable` и `requestId`; `DELETE` без `Umiak-Confirm-Delete` или с чужим ID — `428`, ничего не удалено; `failFast` при пустом пуле — `503 pool_exhausted`, в БД нет новой sandbox, операции и ключа идемпотентности (**фаза 2, вне публичного контракта MVP, решение Ильи 2026-10-29**; в MVP тесты проверяют, что этих слов нет в OpenAPI, а `failFast` в теле — `400 validation`).
- **PTY:** эхо, resize, обрыв WebSocket и переподключение с offset без потерь вывода; закрытие `1012` при остановке пода.
- **Long-poll:** `waitFor=ready` возвращается по `NOTIFY` до таймаута.
- **Контракт:** запросы и ответы всех интеграционных тестов валидируются по `openapi/v1.json`.

**SDK:** тесты TS и Python против поднятого `api` с фейками (один набор сценариев: create/wait/exec/run/follow/files/upload/pty/errors), включая повторы на `503` и reattach.

**E2E на `pve`** (после S3–S6): сценарий `umiak-bench s7` в `apps/bench` через CLI: `login --key-stdin` → `create --wait` → `exec` стрим 10 min с перезапуском пода `api` и агента посреди → `cp` 200 MiB туда и обратно с обрывом → `port --public` и `--token` через gateway (curl) → `ssh` → `shell` → `snapshot save` → `create --from` → `rm`. Замеры: create-to-ready через API, задержка первого байта `exec`, p99 эха PTY.

**Критерий готовности S7:** unit, интеграционные и SDK-тесты проходят; OpenAPI без расхождений и без ломающих изменений; E2E на `pve` проходит, после него нет следов (S1 `inventory`).

## 17. Интерфейсы и требования к другим областям

### 17.1 S2 (`@umiak/agent-client`, `s2-impl`)

- **Маршрутизирующий HTTP-`fetch`** (передано в `s2-impl` master-сессией): `AgentClient.fetch(machineId, path, init)` к `/v1/machines/{id}/files/*` внутреннего listener-а gateway с теми же правилами, что у Connect-транспорта: поиск экземпляра, `421` → другой экземпляр, `503 agent_unavailable` и ошибки соединения → ожидание до 30 s. Повтор возможен, пока тело запроса не начало отправляться или если тело — буфер (чанки загрузки); потоковое тело (`PUT /files/content`) после начала отправки не повторяется. Ответ — потоковый, без буферизации.
- `resumableAttach` (S2 план, Task 11) используется как есть, вместе с `pty_offset` (S3).

### 17.2 S3

Отдельных требований нет: используются `Process` (§9), `Filesystem` и `/files/*` (§11.1, включая `/files/archive` с capability `files.archive.v1`), `System/ListPorts`, `UpdateEnv`/`UpdateSecrets` (через S6), capabilities из S3 §13.

### 17.3 S8 (Payload)

`IdentityStore` (интерфейс в `packages/auth`, реализация на Payload Local API — S8; добавления реализации — §23.10):

```ts
interface IdentityStore {
  resolveSession(h: { email: string; user?: string; groups: string[]; preferredUsername?: string }): Promise<SessionIdentity> // JIT upsert
  findApiKeyByHash(sha256Hex: string): Promise<ApiKeyRecord | null>
  createApiKey(input: NewApiKey): Promise<ApiKeyRecord>          // secretHash computed by packages/auth
  revokeApiKey(id: string, by: { userId?: string; apiKeyId?: string }): Promise<void> // revokedBy / revokedByKey
  listApiKeys(q: { teamId: string }): Promise<ApiKeyRecord[]>       // team keys, with creator status
  touchApiKey(id: string): Promise<void>
  listSshKeys(userId: string): Promise<SshKeyRecord[]>
  addSshKey(input: NewSshKey): Promise<SshKeyRecord>             // unique fingerprint
  removeSshKey(userId: string, id: string): Promise<void>
  findSshKeyByFingerprint(fp: string): Promise<SshKeyRecord | null>
  membership(userId: string, teamId: string): Promise<{ role: "owner" | "member" } | null>
  user(userId: string): Promise<UserRecord | null>               // active flag, isOperator
}
```

- **ID в Payload — UUID** (`idType: 'uuid'` адаптера Postgres): S6 хранит `team_id`, `created_by`, `principal_id` как `uuid`, а кодеки `usr_`/`team_`/`key_`/`sshk_` (§5.3) рассчитаны на 128 бит. Это требование к S8.
- Коллекции: `users` (email, name, active, isOperator из групп IdP, defaultTeam), `teams`, `memberships` (user, team, role), `api-keys` (`name`, `team`, `createdBy` (аудит, на работу ключа не влияет, §7.2), `kind` (`team`; `sandbox` зарезервирован, §7.2), `sandbox` (uuid, null), `secretHash` unique, `prefix`, `last4`, `scopes[]` (имена §7.3), `expiresAt` (обязателен), `revokedAt`, `lastUsedAt`, `createdVia`), `ssh-keys` (`user`, `name`, `publicKey`, `fingerprint` unique, `type`, `lastUsedAt`).
- `Template`: + `loginUser` (по умолчанию `user`), `capabilities`. `PlatformDefaults`: + `defaultTemplate`, `publicPortsEnabled`, `ssoPortPolicy (any | team)`, лимиты частоты. Блокировки портов и sandbox оператором — поля, которые читает `routes.lookup`.
- `afterChange`-хуки коллекций `users`, `memberships`, `api-keys`, `ssh-keys` шлют `NOTIFY umiak_identity '<collection>:<id>'`.
- Ключи создаются только через `packages/auth` (формат §7.2). UI ключей в дашборде вызывает API S7, а не пишет в коллекцию напрямую.
- Дашборд работает через `@umiak/sdk` на `app.<domain>/api/v1` (тот же origin, cookie oauth2-proxy), команда — заголовок `Umiak-Team`.

### 17.4 S4

- Пути и формы внутренних ручек — §12.1 (S4 §6.1, §8.4, §9.2). Вход по SSH-сертификату (S7 §11.3, S4 §9.2) и разрыв сессий `NOTIFY umiak_ssh_revoke` (S4 §9.5) согласованы с S4 решением Ильи 2026-10-29.
- **[переопределяет S4 §6.3]** `sandboxState` — состояния S6; gateway обрабатывает `starting` как `creating`. Значения `running` и `resuming` не приходят.
- `sandboxId` и `teamId` в ответах — публичный формат (`sb_...`, `team_...`), а не `umiak_...`, как в примере S4.
- Slug — грамматика S4 §4.2, генерирует S7 (§5.4). Список зарезервированных суффиксов и портов — общая константа (`packages/auth` экспортирует его и для Go как JSON-файл в `docs/`/конфиге; исполнители договариваются о месте).

### 17.5 S11 (MCP): что нужно от API

- **Инструменты** строятся поверх `@umiak/sdk`: create (с `failFast` — **фаза 2, вне публичного контракта MVP, решение Ильи 2026-10-29**)/list/get/stop/resume/fork/delete (с `Umiak-Confirm-Delete`, §5.12), `limits`, `exec` (sync с таймаутом, хвост вывода, `commandId`), `start` + чтение вывода по offset (`/output` — для опроса без стримов), `kill`, файлы (read text с ограничением размера, write, list, stat, mkdir, move, delete), порты (host, list), snapshots, templates/sizes.
- **Описания:** `summary`/`description` операций и полей в OpenAPI пишутся так, чтобы из них получались описания инструментов (§15.1).
- **Безопасные повторы:** `Idempotency-Key` для create/fork/commands, чтобы повтор вызова инструмента не создавал второй ресурс и не запускал команду дважды.
- **Ответы для LLM:** ошибки с понятным `message` и `retryable`; большие выводы — с флагами усечения и offset-ами, а не огромными телами; `waitFor` long-poll вместо опроса.
- **Аутентификация:** MCP по stdio — цепочка SDK (§7.6): вход человека через `umiak auth token` или командный ключ `UMIAK_API_KEY`; удалённый MCP по HTTP — решает S11 (вероятно, OAuth через Keycloak с `aud=umiak-api`). Ключи с ограничением по sandbox — позже (§19), если S11 их попросит.
- Чего нет в v1 и может понадобиться S11: скриншоты и computer-use (S10), поиск по файлам (через exec).
- Решено в S11 (`docs/specs/s11-mcp.md`): новых ручек MCP не нужно; удалённый MCP принимает те же bearer и проверяет их через `GET /v1/me`; добавлен клиент Keycloak `umiak-mcp` (§7.10) и команда `umiak mcp` (§14.2).

### 17.6 S12

- Ingress: `api.<domain>` → `:8080`; `app.<domain>` пути `/api/*` (с отрезанием `/api`), `/umiak-auth/*` → oauth2-proxy → `:8081`. Поддержка WebSocket upgrade на обоих хостах; буферизация ответа выключена для `application/x-ndjson`; таймаут чтения ingress и `--upstream-timeout` oauth2-proxy ≥ 660 s (sync-команды до 600 s молчат, §9.2; стримы покрывают heartbeat каждые 15 s); тело запроса без предела для `/files/*`, 16 MiB для остального.
- NetworkPolicy: `:8081` — только от oauth2-proxy; `:8082` — только от gateway; `:9090` — от Prometheus.
- Deployment `api`: 2 реплики, `terminationGracePeriodSeconds: 30`, readiness `/readyz` (Postgres, Payload, `LISTEN`-соединения).
- Secrets: service tokens (`UMIAK_API_SERVICE_TOKENS_FILE`), `UMIAK_API_CURSOR_KEY`, ключи данных S6 (`UMIAK_DATA_KEYS_FILE`), публичные SSH host keys gateway, закрытый ключ SSH login CA (`UMIAK_SSH_LOGIN_CA_KEY_FILE`, §11.3).
- Keycloak (realm `umiak`, клиенты и сроки — architecture §10): `UMIAK_OIDC_ISSUER`, `UMIAK_OIDC_AUDIENCE=umiak-api`, `UMIAK_OIDC_ALLOWED_CLIENTS=umiak-cli,umiak-mcp`; `api` ходит к Keycloak только за discovery и JWKS.

## 18. Библиотеки и инструменты

Проверено 2026-10-29 (`npm view`, PyPI, релизы GitHub); при реализации перепроверить и взять последние стабильные.

| Назначение | Библиотека | Версия |
|---|---|---|
| HTTP-фреймворк | `hono` | 4.13.14 |
| Маршруты + OpenAPI из zod | `@hono/zod-openapi` (peer `zod ^4`, `hono >=4.10`) | 1.6.3 |
| Валидация | `zod` | 4.6.7 |
| Node-адаптер; встроенный `upgradeWebSocket` поверх `ws` | `@hono/node-server` | 2.1.5 |
| WebSocket | `ws` / `@types/ws` | 8.22.0 / 8.18.2 |
| Документация API | `@scalar/hono-api-reference` | 0.12.16 |
| Лимиты частоты | `rate-limiter-flexible` | 11.2.3 |
| Логи / метрики | `pino` / `prom-client` | 10.4.0 / 15.1.3 |
| Проверка JWT Keycloak | `jose` | 6.2.13 |
| CLI: хранилище ОС | `Bun.secrets` (Bun ≥ 1.3) | Bun из `mise.toml` |
| IdP | Keycloak (S12) / oauth2-proxy | 26.8.1 / v7.15.5 |
| ULID | `ulid` | 3.0.2 |
| Агент | `@umiak/agent-client` (S2: `@connectrpc/connect`, `-node` 2.3.0) | workspace |
| TS SDK: типы / клиент | `openapi-typescript` / `openapi-fetch` | 7.13.0 / 0.17.0 |
| CLI: аргументы | `commander` | 15.0.0 |
| CLI: сборка | Bun (`mise.toml`) | 1.4.4 |
| Python SDK: генератор | `openapi-python-client` | 0.29.1 |
| Python SDK: HTTP / модели / WebSocket | `httpx` / `attrs` / `websockets` | 0.28.1 / 26.1.0 / 17.3 |
| Python: toolchain | `python` / `uv` в `mise.toml` | 3.15.2 / 0.13.6 |
| Python: тесты, линт | `pytest` / `ruff` | 9.2.0 / 0.17.3 |
| Сравнение OpenAPI в CI | `oasdiff` (Go, через mise) | v1.35.0 |

Отвергнуто:
- `@hono/node-ws` 1.3.1 — требует `@hono/node-server ^1.19`; в 2.x WebSocket встроен. Если понадобится прямой доступ к `bufferedAmount`, используется `ws` под адаптером.
- `@hey-api/openapi-ts` 0.99 (версии 0.x часто ломают генерируемый код), `orval` (ориентирован на react-query), `openapi-generator` 7.26 (Java; Python-клиент только синхронный на urllib3). Stainless, Speakeasy, Fern — платные.
- tus для загрузок: пришлось бы переводить протокол в чанки агента; свой протокол один в один повторяет S3 и проще.
- SSE вместо NDJSON: id событий и `Last-Event-ID` не нужны, offset-ы и так дают возобновление, а NDJSON проще читать из `fetch` и `httpx`.

## 19. Фазы [решение Q3]

| Фаза | Что входит |
|---|---|
| **PoC** | Public и internal listener-ы; `StaticIdentityStore` и ключи из YAML; create/get/list/patch (без slug)/delete, operations, long-poll; команды: sync, stream, detached, attach, output, input, kill, signal, list; файлы: content (чтение с `Range`, запись потоком), stat, list, mkdir, move, delete; templates, sizes, `/me`, `/meta`; `agent-events`; ошибки, пагинация, идемпотентность, лимиты; OpenAPI + CI; CLI: `login --key-stdin`, `create`, `list`, `info`, `rm`, `exec`, `logs`, `kill`, `cp` (без докачки) |
| **MVP** | stop/resume/fork/recover/extend; rename slug; `GET`/`PUT /env`; PTY по WebSocket; загрузка чанками; chmod; порты и режимы доступа, ручки gateway (routes, port-auth, SSO authorize); SSH-ключи, `/ssh`, `ssh/authorize`; saved snapshots; API-ключи; proxied listener (реализация `IdentityStore` на Payload — S8); `umiak login` (device grant Keycloak), проверка JWT, командные ключи, SSH-сертификаты; `/limits`; SDK TS и Python с хелперами; полный CLI; релизы. По MVP-рекомендациям: архив каталога (`/files/archive`), `failFast` (перенесён в фазу 2, решение Ильи 2026-10-29), env и секреты на fork и resume, `Umiak-Confirm-Delete`, scopes «ресурс × действие», контракт вывода CLI и `umiak current` |
| **Граница с S8** | MVP S7 считается готовым против `StaticIdentityStore` (с сессиями из заголовков для теста proxied listener-а) и `StaticConfigReader`, расширенного полями из §17.3 (`loginUser`, `capabilities`, `defaultTemplate`, `publicPortsEnabled`, `ssoPortPolicy`). Реализация `IdentityStore` и этих полей на Payload — работа S8; S7 её не ждёт |
| **Позже** | Подписанные URL файлов; история вывода команд вне VM; webhooks; `ps`; desktop и computer-use (S10); ключи типа `sandbox` (§7.2) и командные ключи с ограничением по sandbox, environments или labels (S24); программный доступ к `sso`-портам (S4 §17); self-update CLI; публикация в GitHub Packages |

## 20. Сводка изменений в других спеках

### 20.1 Переопределения (исполнители S4 и S6 обязаны учесть)

| # | Где | Было | Стало |
|---|---|---|---|
| O1 | S6 §14.2, §4 (схема) | `/internal/v1/routes/{label}`, `/internal/v1/ssh/authorize` | `/internal/v1/gateway/routes/{label}`, `/internal/v1/gateway/ssh/authorize`, `/internal/v1/gateway/port-auth/exchange` (пути S4) |
| O2 | S6 §14.2 | `ssh/authorize {sandbox, user, publicKeyFingerprint}` → `{allowed, machineId, state}` | форма S4 §9.2: `{sandbox, publicKey, fingerprint}` или `{sandbox, certificate: {keyId, serial, principal, validBefore}}` → `{allowed, actor, userId, email, sandboxId, machineId, sandboxState, loginUser}` (§12.1) |
| O3 | S4 §6.3 | `sandboxState` может быть `running`, `resuming` | только состояния S6; `starting` обрабатывается как `creating` (§12.1) |
| O4 | S4 §6.1 (пример) | `sandboxId: "umiak_..."` | `sb_...`; `teamId: "team_..."` |
| O5 | S6 §5.6 | slug — 10 символов `[a-z0-9]` | грамматика S4 §4.2, по умолчанию три слова, генерирует S7 (§5.4) |
| O6 | S6 §5.12 | `runtime` — 0200+ | S6 — 0200–0299, S7 — 0300–0399 |
| O7 | S6 §14.2 | `NOTIFY umiak_routes '<label>'`, по одному на метку | payload — **slug** (S4 §6.2): gateway выкидывает все записи со slug; `'*'` очищает весь кэш. Триггеры на `sandboxes` и `hosted_ports` — в миграциях S6 (0200–0299): смена `state`, `machine_id`, slug (два уведомления: старый и новый), любое изменение строки `hosted_ports` (режим, токен, блокировка). `'*'` шлёт hook S8 при смене `publicPortsEnabled` |

### 20.2 Добавления к S6 (`packages/core`)

**Кто делает** [решение S7, по прецеденту S6 §16 с `packages/pve`]: исполнитель S7 сам вносит эти небольшие добавления в `packages/core` и `db/migrations` (диапазон S6 для изменений таблиц S6), согласуя их с треком `s6-impl`. До появления `packages/core` S7 пишет против интерфейса `SandboxService` с фейком; интерфейс из S6 §14.1 вместе с этим списком считается замороженным.

1. `updateEnv(p, id, {env?, secrets?, secretFiles?})` → `{delivered}` и `getEnv(p, id)`; блоб `sandbox_secrets` хранит три набора (`env`, `secrets` → S3 `secret_env`, `secretFiles`); create и fork принимают `secrets` отдельно от `env`.
2. `createCommand(p, id, spec, idemKey?)` — по ключу возвращает существующую команду (scope `commands.create`); в `commands` добавить `user`, `tags jsonb`, `argv jsonb null`. `listCommands`, `getCommand`.
3. `hostPort(p, id, port, {access, hostRewrite, appProtocol})`; в `hosted_ports` — `host_rewrite`, `app_protocol`, `blocked`, `block_reason`; `listHostedPorts`; блокировка sandbox оператором. `routes.lookup` отдаёт поля S4 §6.1.
4. `rename(p, id, slug)` — меняет `hosted_ports.label` всех портов, `authEpoch+1`, `NOTIFY umiak_routes` со старым и новым slug.
5. `usage(teamId)` для `/limits` и число `warm` machine по парам (шаблон, размер) (число `warm` — фаза 2).
6. `listSavedSnapshots` отдаёт и `creating` (по `pending_name`), и `failed` за сутки; `getSavedSnapshot(p, name)`.
7. `resume` и `recover` при активной операции того же вида возвращают её (как `stop`).
8. Последний снимок `ports.changed` по sandbox (`listeningPorts(id)`).
9. `Principal` с `kind`, `role` и `isOperator` (§7.5); `userId` может быть `null` (командный ключ): тогда `sandboxes.created_by`, `commands.created_by` и `operations.requested_by` — `null`, а в новые колонки `created_by_key` / `requested_by_key uuid null` пишется ключ (у системных операций S6 обе колонки `null`); `idempotency_keys.principal_id` — id ключа (как раньше).
10. Cleanup удаляет `port_auth_codes` старше суток.
11. Общий для `api` и `core` механизм идемпотентности по scope (`sandboxes.create`, `sandboxes.fork`, `commands.create`, `snapshots.create`); `saveSnapshot` принимает `idemKey`. В hash входит и sandbox из пути.
12. `extend(p, id, ttlSeconds?)`.
13. `NOTIFY umiak_operations '<operationId>'` при переходе операции в терминальное состояние (триггер) — для `GET /operations/{id}?waitSeconds` (`save_snapshot` и fork на источнике не меняют `state` sandbox, поэтому `umiak_sandboxes` их не покрывает).

Что из списка сделано и чем дополнено — §23.11.

MVP-рекомендации R2 и R11 (2026-10-29) внесены прямо в S6 и делаются в `s6-impl`, а не этим списком: `failFast` и `pool_exhausted` (S6 §7.3, §14.1), env и секреты на fork и resume (S6 §7.6, §7.7).

### 20.3 Добавления к S2

`AgentClient.fetch` — §17.1 (передано в `s2-impl`).

### 20.4 `docs/architecture.md`

§9 переписан коротко по этой спеке (ресурсы, ID, ошибки, листенеры, SDK и CLI); §2 — `packages/sdk-ts`, `packages/sdk-py`, `packages/auth`.

## 21. Оставлено исполнителю

- Раскладка файлов в `apps/api`, `packages/auth`, SDK и CLI; генерация словаря slug (источник слов, фильтр).
- Каноническая форма тела для hash идемпотентности (совместно с S6).
- Вёрстка страниц ошибок SSO (минимальный HTML без внешних ресурсов).
- Значения лимитов частоты по результатам нагрузочного теста.
- Где лежит общий список зарезервированных суффиксов slug и портов для TS и Go.
- Метрики (минимум): запросы по маршруту, методу и статусу; длительность; открытые стримы и WebSocket; reattach по участку; вызовы агента по методу и исходу; отказы аутентификации по причине; `429`.

## 22. Ответы на открытые вопросы (master-сессия, 2026-10-29)

- **SSO-порты:** по умолчанию пускается любой вошедший пользователь платформы; переключатель `ssoPortPolicy = team` остаётся (§7.7).
- **Срок ключей:** 90 дней по умолчанию, 365 максимум, бессрочных нет (§7.2).
- **Keycloak и offboarding** (решение Ильи, 2026-10-29): IdP — Keycloak; люди в CLI, SDK и MCP — device grant и JWT (§7.6, §7.10), без личных долгоживущих ключей; автоматизация — командные ключи (§7.2); деактивация — синхронизация с Keycloak (S8 §20.1).
- **Роли в команде** (`owner`/`member`): решает S8; до этого действует допущение §7.5 (любой участник команды имеет доступ к её sandbox в пределах scopes).

## 23. Реализация MVP (`s7-impl`)

> Исторический отчёт до R1; действующие имена — `docs/specs/rename-umiak.md`.

Добавлено после реализации (ветка `s7-impl`, 2026-10-30). Здесь записано, что сделано иначе или подробнее, чем в разделах выше; такие места выше помечены ссылкой на §23. «Решение N» — список «Решения исполнителя» в `docs/plans/s7-public-api.md`; остальное решено по ходу реализации. Разделы 1–22 остаются историей согласования.

### 23.1 Не вошло в MVP

- **Тёплый пул** (решение 1, решение Ильи 2026-10-29): `failFast`, `pool_exhausted`, `warmAvailable`, `--fail-fast` — фаза 2, вне публичного контракта MVP. В схеме create поля нет: `failFast` в теле — `400 validation` (неизвестное поле). `warmAvailable` в `/limits` нет. Если core всё же бросит `pool_exhausted`, ответ — `500 internal`.
- **`sbx mcp`** — заглушка: печатает «implemented by S11» и выходит с кодом `1` (решение 12).
- **Рабочий стол** (S10 §13): scope `desktop` и ручки добавит S10. `routes.lookup` отдаёт `kind: "port"`; метки `<slug>-desktop` пока `404 route_not_found` (решение 9).
- **S8:** C3 (операторские ручки блокировок; колонки `blocked`/`block_reason` уже есть), `PayloadIdentityStore`, `PayloadConfigReader`.
- Списки `/v1/snapshots` и `/v1/environments` — одна страница, без `limit`/`cursor`.
- Зарезервированные порты — только `22` (константа в `api`); общий список с gateway и S10 — позже.
- **Python SDK:** без `pty` и `upload_dir`/`download_dir` (решение 11).
- **Go-фейк агента** `agentv1fake` и `tunnelharness -agent fake-v1` (§16) не делались (решение 3): тесты идут на TS-фейке `FakeAgent`, chaos стрима — на уровне `api` и SDK (обрывы attach у фейка, обрывы соединений, остановка процесса `api`, второй экземпляр). Chaos через туннель — после подключения агента S3 (§23.9).

### 23.2 Коды ошибок

Добавлены (v1 разрешает новые коды):

| HTTP | `code` | `retryable` | Когда |
|---|---|---|---|
| 405 | `method_not_allowed` | нет | путь есть, метода нет; заголовок `Allow`, `details.allow` |
| 408 | `request_timeout` | да | `PUT /files/uploads/{upload}`: обработчик ждёт байты чанка 30 s, а их нет (`details.idleTimeoutSeconds`), или чанк идёт дольше 10 min от первого чтения (`details.timeoutSeconds`) (§23.3); `Connection: close`. Агенту ничего не ушло, `offset` защищает повтор: SDK продолжает с offset из `HEAD` |
| 426 | `upgrade_required` | нет | `GET .../ptys/{command}/connect` без WebSocket upgrade |
| 503 | `idp_unavailable` | да | discovery или JWKS Keycloak недоступны, а ключей в кэше нет. Не `401`, чтобы CLI не уходил в повторный вход |
| 503 | `not_ready` | да | `/readyz`: `details.reasons`, `Retry-After`; тот же конверт ошибки, что на остальных listener-ах |

Уточнения существующих кодов:
- `409 invalid_state` с `details.reason: "machine_replaced"` — команда запущена на прежней machine (после reprovision); вызовы агента к ней не идут. Повтор с ключом для такой завершённой команды — тоже `409 machine_replaced`, а не сохранённый результат.
- `409 invalid_state` с `details.agentCode` — прочие `failed_precondition` агента, а не `502 agent_error`.
- `403 forbidden` с `details.reason: "identity_conflict"` — email уже привязан к другому `sub` (S8 §5.3); `401 unauthorized` — IdP не прислал `sub`. Это коды `IdentityError` `identity_conflict` и `subject_required` (§23.10).

Коды SDK (не приходят от API, `SbxError.status = 0`): `network_error` (запрос не дошёл или соединение оборвалось), `unexpected_response` (ответ без конверта, например страница прокси), `no_credentials` (CLI — код выхода `4`), `no_api_url`, `auth_command_failed`, `token_provider_failed`, `wait_timeout`, `unsupported_runtime` (хелпер только для Node/Bun), `pty_input_overflow` (ввод PTY во время переподключения больше 1 MiB; ничего не отброшено, вызывающий повторяет позже). Ошибки внутри стрима (кадр `error`, close PTY) — тоже `SbxError` со статусом `0`.

### 23.3 HTTP

- **Лимиты** (§5.8): fixed window — `SBX_API_RATE_BURST` запросов за `burst / SBX_API_RATE_RPS` секунд на principal (по умолчанию 100 за 5 s, ровно `RateLimit-Policy: "req";q=100;w=5`), а не token bucket. Заголовки — как в §5.8. Старты (create, fork, resume) — `SBX_API_RATE_STARTS_PER_MIN` (30) в минуту на команду; повторы с тем же `Idempotency-Key` тоже считаются. Стримов — до `SBX_API_MAX_STREAMS` (100) на principal; sync-команды есть в реестре стримов (для отзыва и остановки), но в этот лимит не входят.
- **`503 server_shutting_down`** — с `Connection: close` и `Retry-After: 1`.
- **Тела запросов** (§5.11) до аутентификации не читаются: лимит считается в потоке, который читает сам обработчик (после аутентификации); превышение — `413` по ходу чтения. Ограниченное тело (всё, кроме `PUT /files/content|archive` и чанков загрузки) должно прийти за 60 s, иначе `400 validation` (`path: body`). У чанка `PUT /files/uploads/{upload}` (до 8 MiB) общего срока нет: медленный, но непрерывный клиент (4 MiB за 60 s — это ~0,55 Mbit/s) иначе не загрузил бы ни одного чанка; вместо него таймаут простоя — 30 s без новых байт, пока обработчик их ждёт (время ожидания готовности sandbox не считается), → `408 request_timeout`, `retryable: true` (§23.2). Чтобы клиент не держал чанк открытым по байту в 29 s, у чанка есть и потолок — 10 min от первого чтения тела (тот же `408`, `details.timeoutSeconds: 600`); 8 MiB за 10 min — это ~0,11 Mbit/s. У `PUT /files/content|archive` срока нет, общего `requestTimeout` у сервера тоже (ограничен только `headersTimeout`). Ingress перед `api` должен ограничивать частоту запросов по IP: поиск ключа до аутентификации идёт на каждый запрос (`apps/api/README.md`).
- **`GET /v1/docs`** — только на public listener-е: на proxied (origin с cookie oauth2-proxy) — `404`, сторонний скрипт там не выполняется (§15.1). Страница грузит Scalar фиксированной версии (`@scalar/api-reference@1.76.3`, `standalone.js`) с jsDelivr с SRI (`integrity`, `crossorigin`), без inline-скриптов, с CSP `default-src 'none'; script-src <этот файл>; style-src 'unsafe-inline'; connect-src 'self'; …`. Self-hosting из `node_modules` не сделан: пакет тянет Vue и ~30 зависимостей (+2700 строк lockfile, build-скрипты) ради одного файла.
- Страница ошибки `/sbx-auth/authorize` с `429`/`503` ставит `Retry-After`, как JSON-ошибки.
- `POST /v1/sandboxes` с `environment` в виде голого UUID — `404 not_found`, как ручки `/v1/environments/{environment}` (UUID — не имя; id — только `env_…`).
- Ошибка разбора `SBX_API_SERVICE_TOKENS_FILE` не цитирует содержимое файла (сообщение `JSON.parse` содержит начало ввода — токен). JWKS Keycloak, недоступный до первой удачной загрузки ключей, не включает 30-секундную паузу: следующий запрос снова идёт в Keycloak.
- **Курсоры** (§5.6): `base64url(JSON {c: <курсор core>}) + "." + HMAC-SHA256(SBX_API_CURSOR_KEY)`, усечённый до 16 байт; подделка — `400 invalid_cursor` (решение 5).
- **Slug** (§5.4): словарь core, около 300 слов (2,7 · 10⁷ сочетаний из трёх, затем четыре слова); словарь на 1 500 слов — позже (решение 6).
- **IP клиента** (§7.1): `X-Forwarded-For` берётся только от адресов из `SBX_API_TRUSTED_PROXY_CIDRS` (справа налево, до первого недоверенного адреса) и идёт только в поле `clientIp` лога запроса; лимиты считаются по principal. Заголовки личности, кроме заголовков oauth2-proxy на proxied listener-е, не доверяются нигде (например `Tailscale-User-*` перед `api`); на это есть тесты, как для `X-Auth-Request-*` на public.
- **`POST /commands`** `200` бывает `application/json` (sync) и `application/x-ndjson` (stream). `GET /commands/{command}` может сам записать терминальный статус в БД по ответу агента.
- **`agent-events`** (§12.1): тело — binary protobuf `AgentEventsRequest` (`@sbx/proto`), а не protojson (решение 4). Payload `Any` разбирается реестром типов: сообщения S3 (`sbx.agent.v1`, `events.proto` и `common.proto`) и JSON-совместимые (`Struct`/`Value`/`ListValue`) — в protojson с нулевыми полями (код выхода `0`, ноль команд — данные); неизвестные и битые сохраняются как `{"@type": typeUrl}` (иначе gateway повторял бы пакет вечно). `normalizeAgentEvent` (core) переводит `CommandExited.reason` так же, как attach: `TIMEOUT` → `timed_out`, `START_FAILED` → `failed_to_start`; у PTY-команды `pty_end` идёт в `stdout_bytes`.
- **Размер потока после выхода.** На Linux процессы, оставшиеся после выхода команды, могут писать в её поток дальше `end` (S3 §10): `size` файла растёт, `end` — нет, attach агента байты за `end` не отдаёт. Поэтому у завершённой команды `api` везде считает размер потока как `min(size, end)`: `sizeBytes` ресурса Command (`endBytes` — как есть), проверка смещений `/stream`, PTY и `/output` (смещение в `(end, size]` → `416`), `tailBytes` (отсчёт от `end`), граница `/output` (`Sbx-Stream-End`). Раньше `tailBytes` у такой команды начинался за `end`, и стрим переоткрывал attach до отказа.
- **`GET .../stream`** со смещением больше размера потока → `416 range_not_satisfiable` (`details.stream`, `details.size`), как `/output`; ненулевое смещение потока, которого у команды нет (`ptyOffset` у не-PTY, `stdoutOffset`/`stderrOffset` у PTY), → `400 validation`. Раньше такой стрим завершённой команды переоткрывал attach до отказа и заканчивался `agent_unavailable`.
- **`POST .../input`**: `seq` — от `1` (схема `minimum: 1`): shim отбрасывает `seq <= last`, у новой сессии `last = 0`, так что `seq: 0` никогда бы не применился.
- **`outputTruncated`** (proto `output_truncated`): `"disk_full"`, если агент потерял вывод из-за полного диска (концы потоков считают только записанные байты), иначе `null`. Есть в кадре `exit`, в ресурсе Command и в `command` ответа sync. Строка, а не boolean, как в proto: причина может добавиться.
- **Хранимые `outputTruncated` и `reason` команды** (миграция `0304_command_output.sql`, колонки `runtime.commands.output_truncated` и `reason`; таблица S6, но миграция в диапазоне S7 по решению master, см. `docs/roadmap.md`). Пишутся при завершении команды (`completeCommand`: кадр `exit` стрима и sync, ответ `Process/Get` у `GET /commands/{command}`, события `command.exited` и `pty.closed` в worker) и событием S3 `output.truncated` (на любом статусе). У завершённой команды статус и `reason` не меняются, а `output_truncated` дописывается, если его ещё не было (агент может узнать о потере вывода позже). `reason` — значение S3 в нижнем регистре (`EXIT_REASON_UNSPECIFIED` — `null`, и в `api`, и в worker); `failCommandStart` пишет `start_failed`. Команды, которые платформа сама пометила `lost` (решение R32): `reboot` — только когда платформа знает, что гость перезагрузился (сменился boot id, событие `rebooted`); после stop, при пропавшей или неожиданно остановленной VM — `null` (причина неизвестна). Ресурс Command берёт живые значения агента, пока sandbox `ready`, иначе сохранённые; у завершённой строки сохранённый `reason` важнее значения агента (агент только заполняет пустой). `outputTruncated` от агента, который нельзя сохранить (пустой, длиннее 64 символов, с управляющими символами), не отдаётся ни в `GET`, ни в ответе sync. Если `reason` не известен, он выводится из статуса (`exited` → `none`, `killed` → `signal`, …; у `lost` — `null`). CHECK на `reason` добавлен `NOT VALID` и проверен отдельным `VALIDATE`.
- **`GET /commands/{command}`** и `/output` спрашивают агента (`Process/Get`) с бюджетом 5 s: `GET` по истечении отдаёт строку из БД, `/output` — `503 agent_unavailable` (retryable).

### 23.4 PTY

- Повтор `POST /ptys` с тем же ключом и телом — `200` (не `201`), та же команда, `Idempotency-Replayed: true`.
- Close сверх §10.2: `1008` — некорректный управляющий кадр (перед ним кадр `error` с `code: validation`), `1011` — неожиданная ошибка сервера (переподключиться с backoff), `4416` — `offset` за концом вывода PTY (перед ним кадр `error` с `code: range_not_satisfiable`, `retryable: false`, `details {stream: "pty", size}`), как `416` у `/stream` (§23.3); проверяется до attach, SDK и CLI не переподключаются. `tailBytes` важнее `offset` и за конец не выходит. Неизвестные `type` текстовых кадров игнорируются.
- У PTY нет 60-минутного `max_duration` (он у NDJSON-стримов, §9.7): терминал открыт, пока им пользуются. Закрывают остановка пода (`1012`) и отзыв доступа (`4401`).
- Отказы до upgrade (`400`, `401`, `403`, `426`, `429`, `503`) приходят обычным HTTP-ответом с конвертом ошибки.

### 23.5 Файлы

- Неизвестный или чужой `uploadId` в `PUT /files/uploads/{upload}` с `offset > 0` → `409 upload_offset_mismatch` с `details.offset: 0` и `Sbx-Upload-Offset: 0`, а не `404`. `api` загрузки не хранит: их id живут у агента своей machine (§11.1). Чужая загрузка от несуществующей не отличается.

### 23.6 Sandbox, env, environments

- **Environments** (S8 C1): CRUD `/v1/environments` и применение при create (наборы environment, поверх — наборы запроса). Hash идемпотентности create считается по телу клиента, а environment разрешается после захвата ключа: повтор с тем же ключом после правки environment отдаёт сохранённый результат.
- В ресурсе Sandbox `environment` всегда `null`, `excludeOwnerSecrets` — `false`: колонок для них в S6 нет (решение 7). `excludeOwnerSecrets: true` в create → `400 validation`, пока поле не хранится.
- **`PATCH /v1/sandboxes/{sandbox}/env`** (S8 C2): merge, `{K: v | null}`, `null` удаляет; рядом с `PUT /env`.
- Остальное из S8 C1–C10, что сделано здесь: C4 (`?team=` на proxied для `GET`/`HEAD`/WebSocket), C6 (`isOperator` только у сессии; `ssh/authorize` без исключения для оператора), C7 (`routes.lookup` читает `publicPortsEnabled`/`ssoPortPolicy`/`ssoPolicyEpoch` из `ConfigReader` без кэша; `authEpoch` sso-порта = `auth_epoch + ssoPolicyEpoch`), C8 (`user_disabled`), C9 (реестр открытых стримов и PTY, закрытие по `NOTIFY sbx_identity`), C10 (JWT Keycloak, `/meta.oidc`) (решение 8).

### 23.7 CLI

- `sbx env` шлёт `PATCH /env` (`--set`, `--secret`, `--unset` — merge), а не `PUT`: `PUT` заменил бы набор целиком.
- `logs --tail N` — байты на поток (`tailBytes`), не строки.
- `ssh-config` печатает `Match originalhost <alias> exec "sbx ssh-cert <sb> --ensure"`: голый `Match exec` запускал бы `sbx` на каждое ssh-подключение к любому хосту. Строки сертификата стоят внутри `Match`. `SBX_API_KEY` из env в `Match exec` не переносится — нужен профиль. `sbx ssh` добавляет `-o IdentitiesOnly=yes`.
- Закрытый stdout (`sbx exec … | head -1`) → выход с кодом `141`; `exec`, `run` и `shell` при этом убивают удалённую команду.
- Команды с сырым выводом (`exec`, `run`, `logs`) переключает в NDJSON-кадры только явный `--json`; `SBX_OUTPUT=json` — нет: скрипт с перенаправлением вывода должен получать байты.
- Access token обновляется в `exp − 90 s`, а не `exp − 30 s`: SDK считает токен устаревшим в `exp − 60 s`, и токен из `sbx auth token` не должен устаревать сразу.
- `--cacert <file>` / `SBX_CA_FILE` — частный CA для API, Keycloak и WebSocket PTY; доверие — встроенные корни Node/Bun плюс этот файл (хранилище сертификатов ОС не используется).
- `exec`, `run`: SIGTERM и SIGHUP — как Ctrl-C: поток бросается, `run` удаляет sandbox (без `--keep`), выход `143`/`129` (Ctrl-C — `130`); удалённая команда `exec` продолжает работать. Не доставленный Ctrl-C (`signal` не дошёл) — предупреждение в stderr.
- Ошибка разбора аргументов команд с сырым выводом (`exec`, `run`, `logs`, `cp`, …) идёт только в stderr и в JSON-режиме: команда известна до разбора её флагов, stdout (данные) остаётся пустым.
- `sbx rm a b` в JSON-режиме печатает один документ — массив ответов `{sandbox, operation}` (для одной sandbox — объект, как раньше).
- `exec --stdin` шлёт `seq` с `1` (shim отбрасывает `seq <= last`, §23.3).
- `SBX_RETRY_BUDGET_MS` — бюджет повторов SDK для команд CLI.
- `snapshot rm` спрашивает подтверждение, как `rm` (`--yes` без TTY).
- `login --key-stdin`: ключ — единственная непустая строка stdin (пробелы и `\r` по краям срезаются); вторая непустая строка или ключ с неверным форматом или CRC (§7.2) — ошибка аргументов (код `2`) до любого запроса; сообщение ключ не цитирует.
- `login` печатает JSONL: `device_code` (только device grant), затем `logged_in {profile, apiUrl, me}`. Профиль хранит `credentialStore` — где лежат секреты.
- `exec sb -- 'npm test'` (один аргумент) идёт через `bash -lc`, `exec sb -- npm test` (несколько) — argv без shell.
- Флаги и команды сверх §14.2: `--wait-timeout` у ждущих команд; `create --environment <name>` / `--no-environment`; `exec --tag k=v`; `kill --grace`; `ps --status`, `--limit`; `list --template`, `--q`, `--limit`; `label --unset`; `keys create --expires`; `run --cwd`, `--user`, `--timeout`; `run --push` по умолчанию работает в `~/<имя каталога>`; `shell --attach <cmd>`; `port --host-rewrite`, `--app-protocol`; `ssh-keys add --name`, `ssh-keys rm` по имени или отпечатку; `cp` с `:path` (текущая sandbox) и `-` (stdin/stdout); `sbx env-sets list|show|create|set|unset|rm` (environments, §23.6); алиас `ls` у `list`, `snapshot list`, `keys list` и `env-sets list`.

### 23.8 SDK

- **TS:** raw-клиент бросает `SbxError` на любой не-2xx (а не возвращает `{error}` openapi-fetch). `tokenProvider` получает `{force}` (после `401 token_expired` — `force: true`). SDK шлёт `Idempotency-Key` и на commit загрузки (`<uploadId>`) и на `input` с `sessionId` + `seq` (`<sessionId>:<seq>`), чтобы транспорт мог их повторять; `api` на этих ручках заголовок игнорирует, идемпотентность у них своя. Отказ PTY до upgrade WebSocket-клиент видит как `1006` и считает неудачной попыткой.
- **Таймауты TS:** ответ (заголовки) — 60 s на попытку (`CallOptions.timeoutMs`, `0` — выключить), дальше `network_error` и повтор по обычным правилам; для бинарных и потоковых тел (загрузки) срока нет. Старт команды и PTY — 75 s (`api` ждёт готовности sandbox до 60 s). Тело ответа без данных 60 s (не меньше `streamIdleTimeoutMs`) — `network_error`. Как у Python (`httpx.Timeout(60, connect=10)`; старт команды — `read` 75 s до заголовков, дальше idle-лимит потока).
- **Редиректы** не следуют ни TS (`redirect: "manual"`), ни Python (`follow_redirects=False`): `3xx` — `SbxError`.
- **`download` в путь** пишет `<dest>.tmp` и переименовывает в конце: неудачная загрузка оставляет прежний `dest` (TS и Python).
- **`ExecResult`** (TS и Python) + `stdoutFrom`/`stderrFrom` (смещение первого байта хвоста) и `outputTruncated`; `ExitEvent` + `outputTruncated` (§23.3). Python: `Command.wait(timeout=)` и `follow(timeout=)` — `wait_timeout` (команда продолжает работать). TS `Pty.onTruncated(cb)` — потеря вывода терминала (`availableFrom`). `readText` (TS) не срезает BOM, как Python.
- **URL API в SDK:** `baseUrl`, `SBX_API_URL`, затем `apiUrl` профиля из `sbx auth token`; системный `/etc/sbx/config.json` SDK не читает (это делает CLI). Внутри sandbox с одним `SBX_API_KEY` нужен и `SBX_API_URL` (или `baseUrl`).
- **Python:** фасад написан один раз (`sbx_sdk/_async/`), синхронный (`sbx_sdk/_sync/`) генерирует `scripts/gen.py`, свежесть проверяют тесты, как у `_gen`. `AbortSignal` нет: ожидания принимают `timeout`, вызовы — `retry_budget` (секунды); отмена — средствами asyncio. Неизвестное значение открытого enum — член `UNKNOWN`. Без `pty`, `upload_dir`/`download_dir` (§23.1).

### 23.9 Агент

- RPC агента — интерфейс `AgentApi` (`apps/api/src/agent/types.ts`): `capabilities`, `requireCapability`, `start`, `attach`, `sendInput`, `update`, `signal`, `kill`, `get`, `stat`, `list`, `makeDir`, `move`, `chmod`, `remove`, `listPorts`, `updateEnv`, `updateSecrets`, `files`.
- В тестах — `FakeAgent` (`@sbx/api/testing`): настоящие дочерние процессы, PTY без терминала, файлы во временном каталоге.
- В процессе `api` — `ConnectAgentApi` (`apps/api/src/agent/connect.ts`): клиенты `proto/sbx/agent/v1` поверх `AgentClient.transport` (S2), `/files/*` — через `AgentClient.fetch`, capabilities — из `tunnel.tunnel_sessions`; правила адаптера — `apps/api/README.md` (раздел «Wiring S3»). Без `SBX_API_GATEWAY_TOKEN_FILE` все вызовы — `503 agent_unavailable`. Интеграционные тесты `api` против настоящего агента (gateway S2 и агент S3 в одном процессе, `services/guest-agent/cmd/sbx-agent-harness`) — `apps/api/test/agent-real.test.ts`. FakeAgent выровнен с ним: `timeout_ms` — SIGTERM, через 10 s SIGKILL (как shim).
- **Коды настоящего агента** (`services/guest-agent/internal/errs`), таблица — doc-комментарий `agentErrorToHttp`: `user_not_found` → `400 validation` (у `Start` строка команды — `failed_to_start`); `shim_outdated`, `unimplemented` → `409 agent_outdated` (`details.agentCode`); `command_running` → `409 invalid_state`; `not_claimed` → `409 sandbox_not_ready`; `request_id_reused` → `409 idempotency_key_reused` (requestId выводится из ключа). Connect `Unavailable` с любым detail (`quiesced`, `shim_unavailable`, `store_busy`, `identity_not_ready`) — агент недоступен: `503 agent_unavailable`, у `Start`/`signal`/`input` без сессии и файловых `mkdir`/`move`/`chmod`/`delete` — исход неизвестен (`details.outcome: "unknown"` без ключа), а не `502`. `DeadlineExceeded` — так же: у мутаций исход неизвестен, у чтений `503` retryable.
- **Исход `Process/Start`.** Строку команды переводит в `failed_to_start` только отказ, который агент даёт до запуска процесса (S3 §9.2, `internal/process/start.go`, перехватчик claim): `invalid_argument`, `user_not_found`, `already_exists`, `too_many_commands`, `not_claimed`, `failed_precondition`, `shim_outdated`, `unimplemented` (и `AgentOutdatedError`); `request_id_reused` тоже считается отказом, но от `Start` настоящий агент его не шлёт: `Start` исключён из кэша request id агента (`internal/reqcache`), он идемпотентен по `commandId`. Повтор с ключом (строка уже есть) шлёт агенту spec из сохранённой строки (`user` — сохранённый, а не текущий `loginUser` шаблона), а `already_exists` на таком повторе — не отказ: `api` читает команду агента (`Process/Get`) и подключается к ней; если прочитать не удалось — исход неизвестен. `internal` агент шлёт и после запуска (ошибка хранилища в `markRunning`, ошибка systemd в `settle`), поэтому `internal`, Connect `Unknown` и любой незнакомый код — исход неизвестен, как у недоступного агента (§9.1): `503 agent_unavailable`, строка остаётся `starting`; с ключом — `retryable: true`, `details.commandId` (повтор с тем же ключом не запустит процесс второй раз), без ключа — `retryable: false`, `details {commandId, outcome: "unknown"}`.
- **`Process/Signal` может прийти дважды.** `AgentClient` (S2) повторяет унарные вызовы на уровне транспорта (обрыв туннеля, `421`, недоступный агент) с тем же `Sbx-Request-Id`, полагаясь на кэш ответов агента; но кэш агента (S3, `internal/reqcache`) пропускает методы с `idempotency_level = IDEMPOTENT`, а `Signal` помечен так. Если `Signal` дошёл до агента, а ответ потерялся, повтор доставит сигнал ещё раз. Для `SIGTERM`/`SIGKILL`/`SIGINT` это безвредно, для счётных сигналов (например `SIGUSR1` с обработчиком-счётчиком) — нет. Известное ограничение MVP, `api` его не обходит; исправлять в S2 (не повторять `Signal` после отправки) или в S3 (снять `IDEMPOTENT` с `Signal` или кэшировать его ответ по request id).
- **`user` по умолчанию** (§9.1): если запрос (`POST /commands`, `POST /ptys`) не задаёт `user`, команда идёт от `loginUser` шаблона sandbox (тот же пользователь, что в `GET /ssh`), а если шаблона нет в конфиге — от `user` (у шаблонов по умолчанию `loginUser: user`). Значение явно пишется в строку команды и в spec агента, так что ресурс Command показывает настоящего пользователя, а не пустую строку.
- Capability `system.activity.v1` — в списке `AGENT_CAPABILITIES` (как у настоящего агента). `FakeAgent` считает код выхода по сигналу по таблице Linux (`SIGUSR1` = 10 → `138`), а не по ОС хоста.

### 23.10 Личности и конфиг до S8

- `IdentityStore` — `PgIdentityStore` (`packages/auth`) вместо `StaticIdentityStore` (§7.9, решение 2): схема `identity` (миграции `0300_identity_standin.sql`, `0302_ssh_revoke_notify.sql`), загрузка `SBX_IDENTITY_FILE` при каждом старте (только upsert), JIT-пользователь с личной командой, выпуск ключей через API. Proxied listener включён. S8 заменит её на `PayloadIdentityStore`; общий контрактный набор тестов — `@sbx/auth/testing`.
- `NOTIFY sbx_identity '<collection>:<id>'` шлют триггеры `0300`; коллекции `users`, `memberships` (id `<userId>:<teamId>`, для потребителей непрозрачен), `api-keys`, `ssh-keys` — имена S8.
- `NOTIFY sbx_ssh_revoke` (S4 §9.5) шлют триггеры `0302` в транзакции изменения, кто бы его ни делал: `user:usr_…` (деактивация, удаление), `member:team_…:usr_…`, `key:key_…`, `team:team_…`. S8 шлёт те же payload-ы из hooks.
- `IdentityError` дополнен кодами `identity_conflict` (→ `403`) и `subject_required` (→ `401`); реализация S8 обязана выдавать их же (контрактные тесты).
- **Добавления к `IdentityStore`** сверх §17.3 (контрактные тесты `@sbx/auth/testing`, S8 обязана реализовать): `rotateApiKey(id, {secretHash, prefix, last4})` (отозванный или неизвестный — `not_found`; ставит `rotatedAt`); `apiKey(id)` — ключ по id, отозванный и истёкший тоже, `null` для неизвестного (вместо перебора `listApiKeys`); `touchSshKey(id)`; `team(teamId)` → `{id, name} | null`; `SessionHeaders.name` (имя из IdP). `ApiKeyRecord` + `rotatedAt: Date | null`.
- **Ротация ключа** режет SSH: `UPDATE OF secret_hash` живого ключа шлёт `NOTIFY sbx_ssh_revoke 'key:<key_…>'` (миграция `0303_api_key_rotation.sql`, колонка `identity.api_keys.rotated_at`), а `ssh/authorize` (вход и `recheck`) отказывает login-сертификату ключа, выданному до ротации (`validBefore − 10 min < rotatedAt`; без читаемого `validBefore` — отказ). S8 шлёт тот же payload из hook-а и хранит `rotatedAt`.
- Environments живут там же (`identity.environments`, интерфейс `EnvironmentStore`).
- `ConfigReader` дополнен методами `templates()` и `sizes()`: `/templates`, `/sizes` и `/limits` строятся по каталогу конфига. `PayloadConfigReader` (S8) обязан их реализовать.

### 23.11 Добавления к S6 (§20.2)

Сделаны в `packages/core`, `packages/config`, `apps/worker` и миграциях `0204_s7_core_additions.sql`, `0205_sandboxes_updated_at.sql` (диапазон S6):
- п. 1 — `getEnv`, `replaceEnv`, `patchEnv` (вместо одного `updateEnv`), с проверкой лимитов на результате;
- п. 2 — `createCommandWithKey`, `markCommandRunning`, `listCommands`, `getCommand`; в `commands` — `user`, `tags`, `argv`, `pid`, `created_by_key` (`0204`);
- п. 3 — `hostPort(p, id, port, {access, hostRewrite, appProtocol})` с семантикой `PUT` (непереданные опции — по умолчанию; смена только опций не поднимает `authEpoch`), `listHostedPorts`; в `hosted_ports` — `host_rewrite`, `app_protocol`, `blocked`, `block_reason`; в `sandboxes` — `blocked`, `block_reason`, и `NOTIFY sbx_routes` при смене блокировки (`0204`); `RouteTarget`/`SshTarget` с полями S4;
- п. 4 — `rename`: метки портов, `authEpoch + 1`; под старой меткой остаётся отозванная строка, чтобы epoch той же метки не повторился;
- п. 5 — `teamUsage` (без счётчика `warm`, §23.1);
- п. 6 — `getSavedSnapshot`, `listSavedSnapshots` с `creating` и `failed` за сутки;
- п. 9 — `Principal` с `kind`, `role`, `isOperator`;
- п. 10 — cleanup worker удаляет `port_auth_codes` старше суток (таблица — `0301`);
- п. 11 — `claimIdempotencyKey` хранит `response` (у команд — `{commandId}`); create принимает `{hashBody, resolveSets}`;
- `updatedAt` ресурса Sandbox — колонка `sandboxes.updated_at` с триггером (`0205`);
- `failCommandStart(commandId)` — `starting` → `failed_to_start` одним условным UPDATE (первый пишущий выигрывает); `waitForState(..., signal)` — отмена ожидания (снимает LISTEN и опрос);
- `parseLabel` принимает `<slug>-desktop` (`kind: desktop`) для S4; `TemplateConfig` + `name`, `loginUser`, `capabilities`; `PlatformDefaults` + `publicPortsEnabled`, `ssoPortPolicy`, `ssoPolicyEpoch`.

Пункты 7, 8, 12 и 13 уже были в S6. Номера `0204`–`0205` заняты S7 в диапазоне runtime (`0200–0299`: S6 и изменения таблиц runtime из S7, диапазоны — в `docs/roadmap.md`). Колонки `reason` и `output_truncated` в `commands` — исключение, `0304` (§23.3).

### 23.12 Локальный стек

`deploy/compose` (решение 13): Keycloak 26.8.1 с realm `sbx` из `keycloak/realm-sbx.json` (клиенты `oauth2-proxy`, `sbx-cli`, `sbx-api`, `sbx-mcp`, `sbx-worker`), oauth2-proxy (alpha config), одноразовые `secrets-init` и `keycloak-db`, `api`, gateway S4 через `include`. Порты на хосте фиксированы (8080, 9091, 8180, 4180). В dev realm `verifyEmail` выключен, тестовый пользователь подтверждён; `api` по-прежнему требует `email_verified`. Автотеста с настоящим Keycloak (решение 13: smoke под `SBX_KEYCLOAK_TEST=1`) нет: тесты аутентификации идут на собственном OIDC-сервере (`@sbx/api/testing`), realm, вход через oauth2-proxy и device grant `sbx-cli` проверены ручным smoke-тестом compose. Подключение S7 к dev control plane (CT 590, `infra/dev-cp`) на CT не запускалось — проверено только локально; что проверить — `infra/dev-cp/README.md`. `SBX_SSH_PORT` по умолчанию следует за `GATEWAY_SSH_PORT`; смена `SBX_SBX_DOMAIN`/`SBX_SSH_HOST` требует того же значения в override gateway (`SBX_GATEWAY_SBX_DOMAIN`, `SBX_GATEWAY_SSH_HOST`). Capabilities шаблона в конфиге — закрытый набор `exec`, `files`, `ssh`, `desktop` (опечатка — ошибка загрузки). Описания в OpenAPI не ссылаются на разделы спецификаций. Подробно — `deploy/compose/README.md`, запуск `api` без Docker и переменные — `apps/api/README.md`.
