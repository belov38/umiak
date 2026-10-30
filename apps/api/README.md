# @sbx/api

Публичное API v1 (S7): Hono + `@hono/zod-openapi` на Node. Спецификация — `docs/specs/s7-public-api.md`, отличия
реализации — её §23. Маршруты вызывают `SandboxService` (`packages/core`, S6) и агента через интерфейс `AgentApi`.

## Запуск

Сам `api` не собирается: `node src/main.ts` (type stripping). `@sbx/proto` и `@sbx/agent-client` в рантайме
берутся из `dist`, их надо собрать один раз и после изменений:

```sh
mise exec -- pnpm --filter "@sbx/agent-client..." run build   # или mise exec -- pnpm build
mise exec -- node apps/api/src/main.ts                         # переменные окружения — ниже
```

В docker compose это сервис `api` (`deploy/compose/README.md`), образ — `apps/api/Dockerfile`. Неверное
окружение — выход с кодом `1` и список всех ошибок. Битый файл (конфиг, ключи, токены, CA) роняет старт до
первого подключения к Postgres. SIGTERM/SIGINT: readiness → false, стримам — кадр `reconnect`, PTY — `1012`,
sync-командам — `503 server_shutting_down`, выход не позже чем через 10 s; второй сигнал — выход `1` сразу.

## Listener-ы

| Порт (env) | По умолчанию | Кто | Аутентификация |
|---|---|---|---|
| `SBX_API_PUBLIC_PORT` | 8080 | SDK, CLI, MCP, CI | Keycloak JWT или командный ключ `sbx_`; `X-Auth-Request-*` вырезаются |
| `SBX_API_PROXIED_PORT` | 8081 | браузер через oauth2-proxy | заголовки oauth2-proxy, проверка `Origin`; `SBX_API_PROXIED_ENABLED=0` — не запускать |
| `SBX_API_INTERNAL_PORT` | 8082 | gateway (S4) | service token |
| `SBX_API_METRICS_PORT` | 9090 | Prometheus, пробы | нет: `/healthz`, `/readyz`, `/metrics` |

`/readyz` готов, когда работают Postgres и `LISTEN sbx_identity` и процесс не останавливается; иначе `503 not_ready`
с `details.reasons` (`postgres`, `identity_listener`, `shutting_down`).
OpenAPI — `GET /v1/openapi.json`, документация — `GET /v1/docs` (без аутентификации; docs — только на public:
страница грузит Scalar с jsDelivr, закреплённый с SRI).

**Ingress перед public и proxied должен ограничивать частоту запросов по IP клиента.** Лимиты `api` считаются по
principal, то есть после аутентификации; до неё каждый запрос с `Bearer sbx_…` — поиск ключа (кэш 30 s / 5 s на
неизвестный хеш, дальше Postgres), каждый JWT — проверка подписи. Тела запросов до аутентификации не читаются,
ограниченные тела должны прийти за 60 s; чанк загрузки — без общего срока, но не дольше 30 s без новых байт
(`408 request_timeout`, retryable).

## Переменные окружения

Источник правды — `src/settings.ts`. Пустая строка считается «не задано».

| Переменная | По умолчанию | Что |
|---|---|---|
| `DATABASE_URL` | обязательна | Postgres (`postgres://…`) |
| `SBX_CONFIG_FILE` | обязательна | YAML конфига S6 (шаблоны, размеры, квоты, `defaults`) |
| `SBX_DATA_KEYS_FILE` | обязательна | ключи данных S6 (формат `deploy/compose/config/data-keys.example.json`) |
| `SBX_API_CURSOR_KEY` | обязательна | base64, не меньше 32 байт: HMAC курсоров |
| `SBX_API_SERVICE_TOKENS_FILE` | обязательна | JSON `{"gateway": ["<t1>", "<t2>"]}`: токены, которые принимает internal listener |
| `SBX_API_GATEWAY_TOKEN_FILE` | — | токен `api` для internal listener gateway (одна строка). Без него RPC агента и `/files/*` — `503 agent_unavailable` |
| `SBX_IDENTITY_FILE` | — | YAML личностей: `teams`, `users`, `apiKeys` по sha256 (формат — `packages/auth/src/seed.ts`); upsert при каждом старте |
| `SBX_OPERATOR_GROUPS` | — | группы IdP операторов, через запятую |
| `SBX_OIDC_ISSUER` | — | issuer Keycloak (`https://<keycloak>/realms/sbx`); без него JWT не принимаются, `/v1/meta` `oidc: null` |
| `SBX_OIDC_DISCOVERY_URL` | `<issuer>/.well-known/openid-configuration` | discovery по внутреннему адресу |
| `SBX_OIDC_JWKS_URL` | `jwks_uri` из discovery | JWKS по внутреннему адресу |
| `SBX_OIDC_AUDIENCE` | `sbx-api` | обязательный `aud` |
| `SBX_OIDC_ALLOWED_CLIENTS` | `sbx-cli,sbx-mcp` | допустимые `azp` |
| `SBX_API_URL` | обязательна | публичный адрес API (`/v1/meta` `apiUrl`) |
| `SBX_APP_URL` | обязательна | адрес дашборда (`/v1/meta` `appUrl`) |
| `SBX_APP_ORIGIN` | origin `SBX_APP_URL` | `Origin`, который принимает proxied listener |
| `SBX_SBX_DOMAIN` | обязательна | домен портов (`<slug>-<port>.<domain>`) |
| `SBX_SSH_HOST`, `SBX_SSH_PORT` | `ssh.<SBX_SBX_DOMAIN>`, `22` | SSH gateway для `/v1/meta` и `/ssh` |
| `SBX_SSH_HOST_KEYS_FILE` | — | публичные host keys gateway, по одному в строке |
| `SBX_SSH_LOGIN_CA_KEY_FILE` | — | закрытый ed25519 SSH login CA без пароля (PKCS#8 PEM или OpenSSH); без него `ssh/certificate` недоступен |
| `SBX_API_TRUSTED_PROXY_CIDRS` | — | CIDR через запятую: от них `X-Forwarded-For` идёт в `clientIp` лога |
| `SBX_API_RATE_RPS`, `SBX_API_RATE_BURST` | `20`, `100` | лимит запросов на principal: `burst` за `burst/rps` s |
| `SBX_API_RATE_STARTS_PER_MIN` | `30` | create, fork, resume в минуту на команду |
| `SBX_API_MAX_STREAMS` | `100` | открытых стримов и PTY на principal на процесс |
| `SBX_MIN_CLI_VERSION`, `SBX_LATEST_CLI_VERSION` | — | `/v1/meta` |
| `SBX_BUILD` | `dev` | `/v1/meta` `build` |
| `SBX_LOG_LEVEL` | `info` | pino: `fatal` … `trace`, `silent` |
| порты listener-ов | см. выше | `0` — любой свободный (тесты) |

## Внутренние ручки для gateway (S4)

Все — на internal listener-е с `Authorization: Bearer <токен из SBX_API_SERVICE_TOKENS_FILE>`. Ошибки кладут
`code` и на верхний уровень тела (`{"code": "route_not_found", "error": {...}}`).

| Ручка | Что |
|---|---|
| `GET /internal/v1/gateway/routes/{label}` | маршрут порта (S4 §6.1, spec §12.1), `kind: "port"`; нет маршрута — `404 route_not_found` |
| `POST /internal/v1/gateway/ssh/authorize` | вход по SSH-ключу или login-сертификату; `recheck: true` — только проверка личности |
| `POST /internal/v1/gateway/port-auth/exchange` | одноразовый код SSO порта → `{userId, email, label, authEpoch}` или `400 invalid_code` |
| `POST /internal/v1/agent-events` | binary protobuf `AgentEventsRequest` → `{ackedSeq}` |

Изменения маршрутов gateway узнаёт по `NOTIFY sbx_routes '<slug>'`, разрывы SSH-сессий — по
`NOTIFY sbx_ssh_revoke` (триггеры миграций `0204` и `0302`).

## Агент: `AgentApi`

`src/agent/types.ts` — всё, что `api` делает с агентом: `capabilities`, `requireCapability`, `start`, `attach`,
`sendInput`, `update`, `signal`, `kill`, `get`, `stat`, `list`, `makeDir`, `move`, `chmod`, `remove`, `listPorts`,
`updateEnv`, `updateSecrets`, `files` (HTTP `/files*` агента). Ошибки — `AgentUnavailableError`, `AgentOutdatedError`
(`@sbx/agent-client`) и `AgentCallError` (`src/agent/errors.ts`); отображение в HTTP — `src/agent/errors.ts`.

- Тесты — `FakeAgent` из `@sbx/api/testing`: настоящие процессы, PTY без терминала, файлы во временном каталоге.
- Процесс `api` — `ConnectAgentApi` (`src/agent/connect.ts`): RPC — клиенты `sbx.agent.v1` (`@sbx/proto/agent/v1`)
  поверх `AgentClient.transport(machineId)` (поиск gateway, `421`, ожидание агента до 30 s), `files` — через
  `AgentClient.fetch`, capabilities — из `tunnel.tunnel_sessions`. Без `SBX_API_GATEWAY_TOKEN_FILE` все вызовы —
  `503 agent_unavailable`. `attach` — один поток `Process/Attach`; переподключение — `resumableAttach` в
  `src/commands/attach.ts`.
- Ошибки — по таблице в doc-комментарии `agentErrorToHttp` (`src/agent/errors.ts`): Connect
  `Unavailable`/`Canceled`/`DeadlineExceeded` остаются `ConnectError` (с любым detail), остальное —
  `AgentCallError(<код ErrorDetail>)`, без detail — имя кода Connect (`failed_precondition`). Мутации без
  идемпотентного ключа (`Start` без ключа, `input` без сессии, `signal`, файловые `mkdir`/`move`/`chmod`/`delete`)
  при неизвестном исходе — `503 agent_unavailable`, `retryable: false`, `details.outcome: "unknown"`
  (`agentMutationErrorToHttp`).
- Интеграционные тесты против настоящего агента — `test/agent-real.test.ts`: Go-программа
  `services/guest-agent/cmd/sbx-agent-harness` (собирается в global setup через `mise exec -- go build`) поднимает
  в одном процессе gateway S2 и агента S3 с фейковыми зависимостями ОС; команды — процессы хоста под текущим
  пользователем. Без `go` тесты пропускаются с причиной в выводе. Ограничения (нет cgroups, пользователя `user`,
  claim) — в заголовке файла.
- Не сделано: chaos стрима через туннель (spec §16) и E2E `sbx-bench s7` на `pve`.

### Wiring S3: адаптер proto ↔ `AgentApi`

- Enum-ы: `*_UNSPECIFIED` — не значение. `CommandState`/`ExitStatus`/`ExitReason`/`Stream` без префикса в нижнем
  регистре (`EXIT_REASON_PTY_IDLE` → `pty_idle`); `UNSPECIFIED` у `ExitReason` → `none`, у `ExitStatus` при
  заданном `exit` → ошибка адаптера (не угадывать), у `Stream` — событие пропустить.
- Нули proto → `null` в `AgentApi`: `pid = 0` → `null`, `signal = ""` → `null`, пустой `output_truncated` →
  `null`, отсутствующий `exit` → `null`, `Timestamp` не задан → `null`, `StreamInfo.end` не задан → `null`.
  `ExitInfo.code` — число всегда (0 — настоящий код).
- `uint64` (смещения, размеры) приходят `bigint`: перевод в `number` только после проверки
  `<= Number.MAX_SAFE_INTEGER`, иначе ошибка адаптера (не обрезать). Обратно — `BigInt(n)`.
- `CommandInfo.streams` — список `StreamInfo` с полем `stream`; в `AgentApi` — объект по имени потока, только
  потоки команды (у PTY — один `pty`).
- `Sbx-Request-Id` (S2 §9.2) ставить на мутирующих вызовах: `Start` (`requestId` из `opts`, UUIDv5 ключа
  идемпотентности), `MakeDir`/`Move`/`Chmod`/`Remove`, `UpdateEnv`/`UpdateSecrets`. Ответ `request_id_reused`
  значит другой запрос под тем же id → `409 idempotency_key_reused` (у `Start` его не бывает: агент
  проверяет `Start` по `commandId`, не по request id).
- `SendInput.seq` начинается с 1: shim отбрасывает `seq <= last`, у новой сессии `last = 0`.
- Ошибки `Start`: `failed_to_start` — только у отказов до запуска процесса (`invalid_argument`, `user_not_found`,
  `already_exists`, `too_many_commands`, `not_claimed`, `failed_precondition`, `shim_outdated`, `unimplemented`).
  `request_id_reused` от `Start` не приходит: `Start` исключён из кэша request id агента (идемпотентен по
  `commandId`). Повтор с ключом шлёт spec сохранённой строки; `already_exists` на повторе — подключиться к
  команде агента (`Process/Get`), а не отказ. `internal` агент шлёт и после запуска процесса, поэтому
  `internal`, `unknown` и незнакомые коды — исход неизвестен (`503`, строка остаётся `starting`;
  `commands/run.ts`).
- `StreamInfo.size` — размер файла потока; после выхода оставшиеся процессы могут писать дальше `end`
  (S3 §10). Смещения, `tailBytes` и `sizeBytes` считать от `streamSize()` = `min(size, end)`.
- Известное ограничение: `AgentClient` (S2) повторяет унарные вызовы с тем же `Sbx-Request-Id`, а кэш ответов
  агента (S3) пропускает `IDEMPOTENT`-методы, среди них `Signal`. Потерянный ответ — сигнал доставлен дважды
  (безвредно для `TERM`/`KILL`/`INT`, не для счётных сигналов). Исправлять в S2 или S3 (S7 §23.9).

## OpenAPI

`openapi/v1.json` генерируется из zod-схем и коммитится:

```sh
mise exec -- pnpm --filter @sbx/api openapi
```

Тест `openapi-drift` падает, если документ устарел. После изменения схем — перегенерировать и SDK
(`packages/sdk-ts`, `packages/sdk-py`).

## Тесты

```sh
mise exec -- pnpm --filter @sbx/api test        # vitest; Postgres — docker-контейнер из global setup
mise exec -- pnpm --filter @sbx/api typecheck
```

- Postgres: без Docker — `SBX_TEST_DATABASE_URL`; `SBX_TEST_SKIP_PG=1` пропускает тесты с базой.
- Запросы и ответы интеграционных тестов проверяются по `openapi/v1.json` (conformance).
- Keycloak в тестах — свой OIDC-сервер с JWKS и device grant (`startTestOidcServer` из `@sbx/api/testing`);
  настоящий Keycloak проверяется smoke-проверкой compose (`deploy/compose/README.md`).
