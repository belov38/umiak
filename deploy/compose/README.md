# Локальный стек (docker compose)

Сейчас в стеке:

| Сервис | Что делает | Порт на хосте (127.0.0.1) |
|---|---|---|
| `postgres` | Postgres 18: базы `sbx` и `keycloak` | 5432 |
| `secrets-init` | одноразовый: создаёт недостающие dev-секреты в `secrets/` | — |
| `migrate` | одноразовый: миграции и `sbx-admin bootstrap` (топология из `config/sbx.yaml`) | — |
| `worker` | worker S6 | 9090 (`/readyz`, `/metrics`) |
| `keycloak-db` | одноразовый: создаёт базу `keycloak`, если её нет | — |
| `keycloak` | IdP, realm `sbx` (architecture §10) | 8180 |
| `api` | публичное API v1 (S7) | 8080 (public), 9091 (`/readyz`, `/metrics`) |
| `oauth2-proxy` | браузерные сессии: `/api/*` и `/sbx-auth/*` → proxied listener `api` | 4180 |

`gateway` (S4) подключается файлом `gateway.yaml` (см. «Gateway (S4)» ниже), `web` (S8) добавится позже.
Proxmox — любой хост, доступный из контейнеров (см. «Proxmox»).

## Что нужно

- Docker с compose v2.
- Для worker: каталог `~/.config/sbx` с файлами `pve-token` (mode 600), `pve-root-ca.pem`, `sbx-node_ed25519`,
  `known_hosts` (в нём pinned ключ того адреса, по которому worker ходит на узел по SSH). Другой каталог:
  `SBX_PVE_SECRETS_DIR`.
- Proxmox, доступный из контейнеров по HTTPS (`:8006`) и SSH (`:22`). Адрес задаётся в `deploy/compose/.env`
  (см. «Proxmox»). `api`, `keycloak` и `oauth2-proxy` от Proxmox не зависят.
- Linux-хост (без Docker Desktop): контейнеры работают под другими uid, чем пользователь хоста. Файлы в
  `deploy/compose/secrets/` раздаёт владельцам сам `secrets-init` (см. «Секреты»). `~/.config/sbx/*` (mode 600)
  принадлежат пользователю хоста, а worker работает под uid 1000 (`node`). Если uid хоста не 1000, worker их не
  прочитает: запускать от пользователя с uid 1000, либо выдать права (`chown 1000` на копию каталога и указать её
  в `SBX_PVE_SECRETS_DIR`), либо задать `user: "<uid>:<gid>"` у `worker` и `migrate` в локальном override-файле.

## Proxmox

Подходит любой адрес Proxmox, доступный из контейнеров. Скопировать пример и вписать свой хост:

```sh
cp deploy/compose/.env.example deploy/compose/.env
```

- `SBX_PVE_URL`, `SBX_PVE_TLS_NAME` — адрес API Proxmox и имя в его TLS-сертификате. `migrate`
  (`sbx-admin bootstrap`) подставляет их вместо `apiUrl`/`tlsName` провайдера из `config/sbx.yaml`.
- `SBX_NODE_SSH_HOST` — адрес узла для SSH к `sbx-node`.

Без `.env` стек ждёт хост с именем `pve` (`https://pve:8006`, TLS-имя `pve`). В `.env.example` записаны
dev-значения домашней лаборатории Ильи (хост доступен с машины разработки через Tailscale).

## Секреты

Каталог `deploy/compose/secrets/` в `.gitignore`; в git нет ни одного секрета. Их создаёт `secrets-init`
(`secrets-init/init.sh`) при каждом `up`, но только недостающие: существующий секрет не меняется. Чтобы каталог
остался вашим (на Linux Docker создал бы его от root), создайте его заранее:

```sh
mkdir -p deploy/compose/secrets
```

Файлы разложены по каталогам потребителей: compose монтирует каталоги, а не файлы (файл должен существовать
до создания контейнера, а `secrets-init` пишет их позже).

| Файл | Кто читает | Что это |
|---|---|---|
| `data-keys.json` | источник копий ниже | ключи данных S6 (формат: `config/data-keys.example.json`) |
| `api/data-keys.json`, `worker/data-keys.json` | `api`, `worker` | копии `data-keys.json` |
| `api/cursor-key` | `api` | `SBX_API_CURSOR_KEY`, HMAC-ключ курсоров |
| `api/service-tokens.json` | `api` | `SBX_API_SERVICE_TOKENS_FILE`: токены gateway, которые принимает internal listener |
| `api/gateway-token` | `api` | `SBX_API_GATEWAY_TOKEN_FILE`: токен `api` для internal listener gateway |
| `api/ssh-login-ca` | `api` | `SBX_SSH_LOGIN_CA_KEY_FILE`: ed25519 CA коротких SSH-сертификатов |
| `api/ssh-host-keys.pub` | `api` | `SBX_SSH_HOST_KEYS_FILE`: публичные host keys gateway для `/v1/meta` |
| `keycloak/oauth2-proxy-client-secret`, `keycloak/sbx-worker-client-secret` | `keycloak` | секреты клиентов realm `sbx` |
| `oauth2-proxy/client-secret`, `oauth2-proxy/cookie-secret` | `oauth2-proxy` | копия секрета клиента, ключ cookie (32 байта) |

- Пока gateway нет, `service-tokens.json`, `gateway-token`, `ssh-login-ca` и `ssh-host-keys.pub` — свои
  dev-значения. Когда в `secrets/gateway/` есть файлы `gateway-secrets` (S4), `secrets-init` берёт их оттуда и
  переписывает при расхождении: `gateway/api-token` → `{"gateway": [...]}`, `gateway/service-tokens.json` →
  `api[0]`, `gateway/ssh_login_ca`, `gateway/ssh_host_*_key.pub`.
- Копии (`api/data-keys.json`, `worker/data-keys.json`, `oauth2-proxy/client-secret`) тоже переписываются из
  источника.
- Пересоздать секрет: удалить файл и выполнить `up -d`. После этого пересоздать его потребителей
  (`up -d --force-recreate api oauth2-proxy ...`). Секреты клиентов Keycloak попадают в realm только при его
  импорте (первый старт): после их смены нужен чистый Keycloak (см. «Keycloak»).
- `data-keys.json` прежних запусков (созданный вручную по старой инструкции) остаётся на месте и используется.

## Запуск

```sh
cp deploy/compose/.env.example deploy/compose/.env   # один раз; вписать свой Proxmox
mkdir -p deploy/compose/secrets                       # один раз
docker compose -f deploy/compose/compose.yaml up -d --build
docker compose -f deploy/compose/compose.yaml ps -a
# secrets-init, keycloak-db, migrate: Exited (0)
# postgres, keycloak, api, oauth2-proxy, worker: healthy
curl -s http://localhost:8080/v1/meta                                     # api: oidc.issuer = Keycloak
curl -s http://localhost:9091/readyz                                      # api: {"ready":true,...}
curl -s http://localhost:8180/realms/sbx/.well-known/openid-configuration # Keycloak
curl -s -d client_id=sbx-cli http://localhost:8180/realms/sbx/protocol/openid-connect/auth/device  # user_code
curl -i http://127.0.0.1:9090/readyz                                      # worker
```

Первый старт Keycloak занимает 20–40 секунд; `api` и `oauth2-proxy` ждут, пока он станет healthy.

Состояние пула и узлов (sbx-admin внутри контейнера):

```sh
docker compose -f deploy/compose/compose.yaml exec worker node apps/worker/src/admin/main.ts pool status
docker compose -f deploy/compose/compose.yaml exec worker node apps/worker/src/admin/main.ts reconcile --dry-run
```

Логи и psql:

```sh
docker compose -f deploy/compose/compose.yaml logs -f api worker
docker compose -f deploy/compose/compose.yaml exec postgres psql -U sbx -d sbx
```

Остановка. `-v` удаляет том с базами (`sbx` и `keycloak`):

```sh
docker compose -f deploy/compose/compose.yaml down        # данные сохраняются
docker compose -f deploy/compose/compose.yaml down -v     # чистый старт
```

`api` по SIGTERM закрывает стримы (`reconnect`), PTY (1012) и выходит за 10 s (`stop_grace_period: 30s`).

## Первый вход

**Администратор Keycloak.** http://localhost:8180/admin, логин и пароль — `KEYCLOAK_ADMIN` /
`KEYCLOAK_ADMIN_PASSWORD` из `.env` (по умолчанию `admin` / `admin`). Учётка создаётся только при первом старте
Keycloak; смена значений в `.env` потом на неё не влияет. Realm `sbx`.

**Тестовый пользователь.** В realm `sbx` уже есть `dev@example.com` (email подтверждён) с временным паролем
`SBX_DEV_PASSWORD` из `.env` (по умолчанию `dev`). При первом входе Keycloak попросит задать новый пароль.
Новые пользователи заводятся в админке Keycloak (Users → Add user); для API у них должен быть отмечен
Email verified, иначе `api` отклонит их токен. Оператор платформы — член группы `sbx-operators`
(`SBX_OPERATOR_GROUPS`); права оператора действуют только в браузерной сессии.

**Браузер.** Дашборда пока нет (S8). Вход проверяется через API за oauth2-proxy:
http://localhost:4180/api/v1/me → страница входа Keycloak → JSON с пользователем, его личной командой и
`"auth": {"kind": "session"}`. Пользователь и личная команда создаются при первом входе.

**CLI.** `sbx` (S7, задача 17) входит через Device Authorization Grant:

```sh
sbx login --api-url http://localhost:8080
```

CLI печатает код и ссылку http://localhost:8180/realms/sbx/device; войти тем же пользователем и подтвердить.
Тот же `sub` даёт того же пользователя, что и в браузере. Токен доступа живёт 5 минут, сессия — 24 часа без
активности и не больше 7 дней.

**Командный ключ для автоматизации.** Выпускает `owner` команды: `POST /v1/api-keys` с токеном человека
(`sbx keys create`), либо ключ из `config/identity.yaml` (по sha256).

## Keycloak

- Realm `sbx` импортируется из `keycloak/realm-sbx.json` только при первом старте (существующий realm не
  трогается). Клиенты: `oauth2-proxy`, `sbx-cli`, `sbx-mcp`, `sbx-api`, `sbx-worker`; scope `groups`; сроки — по
  architecture §10. Секреты клиентов подставляются из `secrets/keycloak/` через переменные окружения
  (`${SBX_OAUTH2_PROXY_CLIENT_SECRET}`, `${SBX_WORKER_CLIENT_SECRET}`, `${SBX_DEV_PASSWORD}` в файле realm).
- Адреса: браузер и CLI ходят на публичный http://localhost:8180 (`KC_HOSTNAME`, он же `iss` токенов); `api` и
  `oauth2-proxy` — на http://keycloak:8080 внутри сети (`SBX_OIDC_DISCOVERY_URL`, `SBX_OIDC_JWKS_URL`, redeem и
  JWKS у oauth2-proxy). Другой порт хоста: `KEYCLOAK_PORT` в `.env` (меняет и issuer).
- Применить изменённый `realm-sbx.json` (или новые секреты клиентов): удалить базу Keycloak и перезапустить.

  ```sh
  docker compose -f deploy/compose/compose.yaml stop keycloak
  docker compose -f deploy/compose/compose.yaml exec postgres dropdb -U sbx keycloak
  docker compose -f deploy/compose/compose.yaml up -d
  ```

## oauth2-proxy

Конфигурация — `oauth2-proxy/oauth2-proxy.yaml` (alpha config: провайдер `keycloak-oidc`, маршруты, заголовки)
и флаги в `compose.yaml` (cookie). `/api/*` идёт на `api:8081` без префикса `/api`, `/sbx-auth/*` — как есть;
таймаут upstream 660 s. В запрос к `api` добавляются `X-Auth-Request-User` (`sub`), `-Email`, `-Groups`,
`-Preferred-Username`; такие же заголовки от клиента вырезаются. Cookie `_sbx_session` без `Secure` и без
префикса `__Host-`: стек работает по http на localhost (в проде — `__Host-sbx_session`). Сессия обновляется каждые
5 минут (`--cookie-refresh=5m`).

## Gateway (S4)

`gateway.yaml` и `services/gateway` живут в ветке `s4-impl`. После слияния S4 и S7:

1. Раскомментировать `include: [gateway.yaml]` в начале `compose.yaml`.
2. Раскомментировать `depends_on: gateway-secrets` у `secrets-init`: тогда `secrets-init` возьмёт токены, SSH
   login CA и host keys из `secrets/gateway/`.
3. В `deploy/compose/.env`: `SBX_GATEWAY_API_URL=http://api:8082`.
4. `up -d --build`, затем `up -d --force-recreate api gateway`.

Подробности gateway — `README.gateway.md` (ветка `s4-impl`).

## Настройки

- `config/sbx.yaml` — шаблоны, размеры, квоты и топология (узел `pve`, хранилище `local-lvm`, сборка шаблона
  599). Worker и `api` читают конфиг один раз при старте, а `up -d` не пересоздаёт контейнер, если в
  `compose.yaml` ничего не поменялось. Поэтому после правки:

  ```sh
  docker compose -f deploy/compose/compose.yaml up -d --force-recreate worker api
  ```

  Если менялись топология или сборки шаблонов (их в базу загружает `bootstrap`), пересоздать и `migrate`:
  `... up -d --force-recreate migrate worker api` (bootstrap идемпотентен). То же для правок
  `deploy/compose/.env` и файлов секретов.
- `config/identity.yaml` — файл личностей `api` (`SBX_IDENTITY_FILE`): команды, пользователи, командные ключи по
  sha256. Загружается при каждом старте `api` (только upsert). В dev пуст: люди появляются при первом входе.
- `deploy/compose/.env` (git-ignored, пример — `.env.example`): Proxmox (`SBX_PVE_URL`, `SBX_PVE_TLS_NAME`,
  `SBX_NODE_SSH_HOST`, `SBX_PVE_TOKEN_ID`, `SBX_PVE_SECRETS_DIR`), `SBX_RECONCILE_DRY_RUN`, Keycloak
  (`KEYCLOAK_ADMIN`, `KEYCLOAK_ADMIN_PASSWORD`, `SBX_DEV_PASSWORD`), порты (`API_PORT`, `API_METRICS_PORT`,
  `KEYCLOAK_PORT`, `OAUTH2_PROXY_PORT`), `SBX_SSH_HOST`/`SBX_SSH_PORT` для `/v1/meta`, `SBX_API_LOG_LEVEL`.
- Учётные данные Postgres `sbx/sbx/sbx` — только для разработки; порт опубликован на `127.0.0.1:5432`.
- `SBX_DB_POOL_MAX` (по умолчанию 30) — размер пула соединений worker. Блокировка питания (`power:<nodeId>`, S6 §15.1) держит по одному соединению на ноду в каждом процессе и под ней берёт ещё одно, плюс соединения pg-boss и операций. Значение должно с запасом превышать число нод.

## Что worker и api делают сами, а чего нет

- Reconcile работает в dry-run (`SBX_RECONCILE_DRY_RUN=1`): читает список VM на Proxmox (только чтение) и логирует, что сделал бы.
- Целевые размеры пулов в `sbx.yaml` равны 0 (`pools: []`, решение 17), поэтому worker сам не создаёт VM.
- Пока нет агента (S3) и gateway (S4), создание sandbox не может дойти до `ready`: агентский порт недоступен, а без `SBX_GATEWAY_SERVICE_TOKEN_FILE` ротация токена падает по таймауту. Worker при этом предупреждает об этом в логе при старте.
- RPC агента в `api` отвечают `503 agent_unavailable`, пока не подключён S3 (решение 3 плана S7); файлы идут через gateway.
- Схему `tunnel` создаёт миграция S2 `db/migrations/0100_tunnel_init.sql` (её применяет `migrate` вместе с миграциями S6). Том, созданный раньше временной фикстурой схемы `tunnel` (до этой миграции), с ней несовместим: пересоздать его `down -v`, затем `up -d --build`.
- С `SBX_GATEWAY_SERVICE_TOKEN_FILE` worker находит gateway, который держит туннель machine, через `PgRegistry` из `@sbx/agent-client` (своё небольшое подключение к Postgres и LISTEN `tunnel_sessions`) и вызывает на нём `rotate-token`.

## Smoke-тест реального адаптера Proxmox

`apps/worker/test/pve-smoke.test.ts` гоняет `PveInfraRegistry` против хоста `pve`: create/start/shutdown,
snapshot и fork, два параллельных старта (power lock), reconcile в dry-run, затем удаляет всё созданное
и сравнивает inventory sbx-node «до» и «после». Без `SBX_PVE_SMOKE=1` тест пропускается, так что
`pnpm -r test` остаётся офлайн. Топология берётся из `config/sbx.yaml` (через `sbx-admin bootstrap`)
в свежей тестовой базе (локальный docker Postgres из global setup).

```sh
SBX_PVE_SMOKE=1 mise exec -- pnpm --filter @sbx/worker exec vitest run test/pve-smoke.test.ts
```

- Секреты: `~/.config/sbx` (или `SBX_SECRETS_DIR`); SSH-хост sbx-node: `SBX_NODE_SSH_HOST` (по умолчанию — dev-адрес из `.env.example`).
- Создаёт VM только в диапазоне 500–598 из шаблона 599, по 2 vCPU / 2 GB, не больше двух одновременно запущенных.
  Перед запуском в этом диапазоне не должно быть VM: тест проверяет это в начале.
- Идёт около 90 секунд, большая часть уходит на `shutdown` (гостю шаблона не хватает 60 с, дальше идёт `stop`).

## Как добавить сервис

1. Добавить блок в `services:` в `compose.yaml`; взять `<<: *service-defaults` (логирование и сеть `sbx`) и `<<: *db-env` для `DATABASE_URL`.
2. Если сервису нужна схема БД, поставить `depends_on: migrate: condition: service_completed_successfully`.
3. Секреты генерировать в `secrets-init/init.sh` в свой каталог `deploy/compose/secrets/<сервис>/` (git-ignored) и монтировать каталог, а не файл; в git — только `*.example`. Сервис ставит `depends_on: secrets-init: condition: service_completed_successfully`.
4. Образ собирать из корня репозитория (`context: ../..`, `dockerfile: apps/<name>/Dockerfile`); `.dockerignore` лежит в корне.
5. Новый пакет workspace (`packages/<name>` или `apps/<name>`) — добавить строку `COPY <dir>/package.json <dir>/` в блок манифестов стадии `base` **во всех** Dockerfile (`apps/worker/Dockerfile`, `apps/api/Dockerfile`), иначе `pnpm install --frozen-lockfile` не совпадёт с lockfile. Если пакет входит в зависимости сервиса, добавить и `COPY <dir>/src <dir>/src`; если он собирается в `dist` (как `@sbx/proto` и `@sbx/agent-client`), собрать его в стадии `build` и скопировать `dist` в итоговый образ.

## Запуск worker и api без Docker

Пакеты S6 и S7 запускаются из исходников (`node src/main.ts`), а `@sbx/proto` и `@sbx/agent-client` в рантайме берутся из `dist`. Перед первым запуском и после их изменений собрать:

```sh
mise exec -- pnpm build        # или только нужное: pnpm --filter "@sbx/agent-client..." run build
mise exec -- pnpm --filter @sbx/worker start
mise exec -- node apps/api/src/main.ts   # переменные окружения — apps/api/src/settings.ts
```

Тесты (`vitest`) и `typecheck` от этого не зависят: vitest берёт исходники по условию `source`, а `typecheck` сам собирает `dist`.
