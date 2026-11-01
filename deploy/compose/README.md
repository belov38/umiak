# Локальный стек (docker compose)

Сейчас в стеке:

| Сервис | Что делает | Порт на хосте (127.0.0.1) |
|---|---|---|
| `postgres` | Postgres 18: базы `umiak` и `keycloak` | 5432 |
| `secrets-init` | одноразовый: создаёт недостающие dev-секреты в `secrets/` | — |
| `migrate` | одноразовый: миграции `db/migrations` и `umiak-admin bootstrap` (топология из `config/umiak.yaml`) | — |
| `web-migrate` | одноразовый (образ `web`): миграции Payload, схема `payload` (S8 §12) | — |
| `worker` | worker S6 (+ `ctl-idp-sync` S8) | 9090 (`/readyz`, `/metrics`) |
| `keycloak-db` | одноразовый: создаёт базу `keycloak`, если её нет | — |
| `keycloak` | IdP, realm `umiak` (architecture §10) | 8180 |
| `api` | публичное API v1 (S7) | 8080 (public), 9091 (`/readyz`, `/metrics`) |
| `oauth2-proxy` | браузерные сессии: `/api/*` и `/umiak-auth/*` → proxied listener `api`, остальное → `web` | 4180 |
| `web` | S8: дашборд `/app`, админка Payload `/admin`, REST Payload `/cms-api` | — (только через oauth2-proxy) |
| `mcp` | удалённый MCP-сервер (S11), `/mcp` по Streamable HTTP (см. «MCP (S11)» ниже) | 8090 (`/mcp`, метаданные), 9092 (`/readyz`, `/metrics`) |
| `gateway-secrets` | одноразовый (`gateway.yaml`): dev-секреты gateway в `secrets/gateway/` | — |
| `gateway` | S4: preview-адреса, SSH, туннели агентов (см. «Gateway (S4)» ниже) | 8443 (TLS), 2222 (SSH), 7000, 9190 |

Proxmox — любой хост, доступный из контейнеров (см. «Proxmox»).

Стек на `pve` (CT 590, доступен из sandbox VM): `infra/dev-cp/README.md`.

## Что нужно

- Docker с compose v2.
- Для worker: каталог `~/.config/umiak` с файлами `pve-token` (mode 600), `pve-root-ca.pem`, `umiak-node_ed25519`,
  `known_hosts` (в нём pinned ключ того адреса, по которому worker ходит на узел по SSH). Другой каталог:
  `UMIAK_PVE_SECRETS_DIR`.
- Proxmox, доступный из контейнеров по HTTPS (`:8006`) и SSH (`:22`). Адрес задаётся в `deploy/compose/.env`
  (см. «Proxmox»). `api`, `keycloak` и `oauth2-proxy` от Proxmox не зависят.
- Linux-хост (без Docker Desktop): контейнеры работают под другими uid, чем пользователь хоста. Файлы в
  `deploy/compose/secrets/` раздаёт владельцам сам `secrets-init` (см. «Секреты»). `~/.config/umiak/*` (mode 600)
  принадлежат пользователю хоста, а worker работает под uid 1000 (`node`). Если uid хоста не 1000, worker их не
  прочитает: запускать от пользователя с uid 1000, либо выдать права (`chown 1000` на копию каталога и указать её
  в `UMIAK_PVE_SECRETS_DIR`), либо задать `user: "<uid>:<gid>"` у `worker` и `migrate` в локальном override-файле.

## Proxmox

Подходит любой адрес Proxmox, доступный из контейнеров. Скопировать пример и вписать свой хост:

```sh
cp deploy/compose/.env.example deploy/compose/.env
```

- `UMIAK_PVE_URL`, `UMIAK_PVE_TLS_NAME` — адрес API Proxmox и имя в его TLS-сертификате. `migrate`
  (`umiak-admin bootstrap`) подставляет их вместо `apiUrl`/`tlsName` провайдера из `config/umiak.yaml`.
- `UMIAK_NODE_SSH_HOST` — адрес узла для SSH к `umiak-node`.

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
| `payload-secret` | источник копий ниже | `PAYLOAD_SECRET` конфига Payload (S8), одно значение на все сервисы |
| `web/payload-secret`, `api/payload-secret`, `worker/payload-secret` | `web`, `web-migrate`, `api`, `worker` | копии `payload-secret`; сервис читает файл при старте в `PAYLOAD_SECRET` |
| `worker/idp-sync-client-secret` | `worker` | копия `keycloak/umiak-worker-client-secret` для `ctl-idp-sync` (`UMIAK_IDP_SYNC_CLIENT_SECRET_FILE`) |
| `api/cursor-key` | `api` | `UMIAK_API_CURSOR_KEY`, HMAC-ключ курсоров |
| `api/service-tokens.json` | `api` | `UMIAK_API_SERVICE_TOKENS_FILE`: токены gateway, которые принимает internal listener |
| `api/gateway-token` | `api` | `UMIAK_API_GATEWAY_TOKEN_FILE`: токен `api` для internal listener gateway |
| `api/ssh-login-ca` | `api` | `UMIAK_SSH_LOGIN_CA_KEY_FILE`: ed25519 CA коротких SSH-сертификатов |
| `api/ssh-host-keys.pub` | `api` | `UMIAK_SSH_HOST_KEYS_FILE`: публичные host keys gateway для `/v1/meta` |
| `keycloak/oauth2-proxy-client-secret`, `keycloak/umiak-worker-client-secret` | `keycloak` | секреты клиентов realm `umiak` |
| `keycloak/admin-password` | `keycloak` | пароль администратора Keycloak, если `KEYCLOAK_ADMIN_PASSWORD` в `.env` не задан |
| `oauth2-proxy/client-secret`, `oauth2-proxy/cookie-secret` | `oauth2-proxy` | копия секрета клиента, ключ cookie (32 байта) |

- `secrets-init` стартует после `gateway-secrets` (S4, `depends_on` с `service_completed_successfully`), поэтому
  `service-tokens.json`, `gateway-token`, `ssh-login-ca` и `ssh-host-keys.pub` берутся из `secrets/gateway/` и
  переписываются при расхождении: `gateway/api-token` → `{"gateway": [...]}`, `gateway/service-tokens.json` →
  `api[0]`, `gateway/ssh_login_ca`, `gateway/ssh_host_*_key.pub`. Стек без `gateway-secrets` не поднимется
  (`depends_on`); `init.sh` создаёт свои dev-значения только для файлов, которых нет в `secrets/gateway/`
  (например при запуске `secrets-init` отдельно, с `--no-deps`).
- Копии (`api/data-keys.json`, `worker/data-keys.json`, `*/payload-secret`, `worker/idp-sync-client-secret`,
  `oauth2-proxy/client-secret`) тоже переписываются из источника.
- Пересоздать секрет: удалить файл и выполнить `up -d`. После этого пересоздать его потребителей
  (`up -d --force-recreate api oauth2-proxy ...`). На Linux файлы принадлежат root и uid потребителей
  (`secrets-init` пишет их от root): удалять через `sudo rm` или из контейнера —
  `docker compose -f deploy/compose/compose.yaml run --rm --no-deps --entrypoint rm secrets-init /secrets/<файл>`. Секреты клиентов Keycloak попадают в realm только при его
  импорте (первый старт): после их смены нужен чистый Keycloak (см. «Keycloak»).
- `data-keys.json` прежних запусков (созданный вручную по старой инструкции) остаётся на месте и используется.

## Запуск

```sh
cp deploy/compose/.env.example deploy/compose/.env   # один раз; вписать свой Proxmox
mkdir -p deploy/compose/secrets                       # один раз
docker compose -f deploy/compose/compose.yaml up -d --build
docker compose -f deploy/compose/compose.yaml ps -a
# gateway-secrets, secrets-init, keycloak-db, migrate, web-migrate: Exited (0)
# postgres, keycloak, api, oauth2-proxy, gateway, worker, web, mcp: healthy
curl -s http://localhost:8080/v1/meta                                     # api: oidc.issuer = Keycloak
curl -s http://localhost:9091/readyz                                      # api: {"ready":true,...}
curl -s http://localhost:8180/realms/umiak/.well-known/openid-configuration # Keycloak
curl -s -d client_id=umiak-cli http://localhost:8180/realms/umiak/protocol/openid-connect/auth/device  # user_code
curl -i http://127.0.0.1:9090/readyz                                      # worker
```

Первый старт Keycloak занимает 20–40 секунд; `api` и `oauth2-proxy` ждут, пока он станет healthy. Порядок
одноразовых: `migrate` → `web-migrate` → `api`, `worker`, `web`. Образ `web` (Next.js build) собирается
несколько минут.

Состояние пула и узлов (umiak-admin внутри контейнера):

```sh
docker compose -f deploy/compose/compose.yaml exec worker node apps/worker/src/admin/main.ts pool status
docker compose -f deploy/compose/compose.yaml exec worker node apps/worker/src/admin/main.ts reconcile --dry-run
```

Логи и psql:

```sh
docker compose -f deploy/compose/compose.yaml logs -f api worker
docker compose -f deploy/compose/compose.yaml exec postgres psql -U umiak -d umiak
```

Остановка. `-v` удаляет том с базами (`umiak` и `keycloak`):

```sh
docker compose -f deploy/compose/compose.yaml down        # данные сохраняются
docker compose -f deploy/compose/compose.yaml down -v     # чистый старт
```

`api` по SIGTERM закрывает стримы (`reconnect`), PTY (1012) и выходит за 10 s (`stop_grace_period: 30s`).

## Первый вход

**Администратор Keycloak.** http://localhost:8180/admin, логин `KEYCLOAK_ADMIN` из `.env` (по умолчанию
`admin`). Пароль — `KEYCLOAK_ADMIN_PASSWORD` из `.env`, а если он не задан, его генерирует `secrets-init`:

```sh
docker compose -f deploy/compose/compose.yaml exec keycloak cat /run/umiak-secrets/admin-password
# или на хосте: deploy/compose/secrets/keycloak/admin-password
```

Учётка создаётся только при первом старте Keycloak; смена значений потом на неё не влияет. Realm `umiak`.

**Дашборд.** http://localhost:4180/ → вход Keycloak → `/app` → личная команда пользователя
(`/app/t/team_…`). Пользователь и личная команда создаются при первом входе (одинаково в `web` и `api`).
Выход (меню пользователя → Sign out): `/oauth2/sign_out?rd=<UMIAK_LOGOUT_URL>` — oauth2-proxy удаляет cookie,
Keycloak показывает страницу выхода и возвращает на http://localhost:4180/app (`/` у `web` тоже ведёт на `/app`).

**Тестовый пользователь.** В realm `umiak` уже есть `dev@example.com` (email подтверждён) с временным паролем
`UMIAK_DEV_PASSWORD` из `.env` (по умолчанию `dev`). При первом входе Keycloak попросит задать новый пароль.
Новые пользователи заводятся в админке Keycloak (Users → Add user); для API у них должен быть отмечен
Email verified, иначе `api` отклонит их токен.

**Оператор.** Оператор платформы — член группы `umiak-operators` (`UMIAK_OPERATOR_GROUPS` у `api` и `web`); права
оператора действуют только в браузерной сессии. `dev@example.com` в realm обычный пользователь (так проверяется
и путь не-оператора: `/admin` — 403 «Operators only» из proxy `web`, `/app/operator` — 403). Сделать его
оператором: админка Keycloak → realm `umiak` → Users → `dev@example.com` → Groups → Join group → `umiak-operators`.
Группа приходит в cookie oauth2-proxy при входе, поэтому затем выйти и войти снова (или подождать обновления
сессии, `--cookie-refresh=5m`). После этого открываются `/admin` и `/app/operator`.

**API в браузере.** http://localhost:4180/api/v1/me → JSON с пользователем, его личной командой и
`"auth": {"kind": "session"}`.

**CLI.** `umiak` (`apps/cli`) входит через Device Authorization Grant. Бинарник для своей платформы собирает
`mise exec -- pnpm --filter @umiak/cli build` (`apps/cli/dist/umiak-<os>-<arch>`), из исходников —
`mise exec -- pnpm --filter @umiak/cli umiak <команда>`.

```sh
umiak login --api-url http://localhost:8080
```

CLI печатает код и ссылку http://localhost:8180/realms/umiak/device; войти тем же пользователем и подтвердить.
Тот же `sub` даёт того же пользователя, что и в браузере. Токен доступа живёт 5 минут, сессия — 24 часа без
активности и не больше 7 дней.

**Командный ключ для автоматизации.** Выпускает `owner` команды: `POST /v1/api-keys` с токеном человека
(`umiak keys create`), либо ключ из `config/identity.yaml` (по sha256).

## Keycloak

- Realm `umiak` импортируется из `keycloak/realm-umiak.json` только при первом старте (существующий realm не
  трогается). Клиенты: `oauth2-proxy`, `umiak-cli`, `umiak-mcp`, `umiak-api`, `umiak-worker`; scope `groups`; сроки — по
  architecture §10. Секреты клиентов подставляются из `secrets/keycloak/` через переменные окружения
  (`${UMIAK_OAUTH2_PROXY_CLIENT_SECRET}`, `${UMIAK_WORKER_CLIENT_SECRET}`, `${UMIAK_DEV_PASSWORD}` в файле realm).
- Адреса: браузер и CLI ходят на публичный адрес Keycloak (`UMIAK_KEYCLOAK_URL` → `KC_HOSTNAME`, по умолчанию
  http://localhost:8180; issuer `<адрес>/realms/umiak` — `iss` токенов); `api` и `oauth2-proxy` — на
  http://keycloak:8080 внутри сети (`UMIAK_OIDC_DISCOVERY_URL`, `UMIAK_OIDC_JWKS_URL`, redeem и JWKS у oauth2-proxy).
  `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true`: backchannel-адреса берутся из адреса запроса, а `iss` остаётся публичным.
- Redirect URI и web origin клиента `oauth2-proxy` подставляются при импорте из `${UMIAK_OAUTH2_PROXY_REDIRECT_URL}`
  и `${UMIAK_APP_ORIGIN}` (см. «Публичные адреса»).
- Применить изменённый `realm-umiak.json` (или новые секреты клиентов): удалить базу Keycloak и перезапустить.

  ```sh
  docker compose -f deploy/compose/compose.yaml stop keycloak
  docker compose -f deploy/compose/compose.yaml exec postgres dropdb -U umiak keycloak
  docker compose -f deploy/compose/compose.yaml up -d
  ```

## oauth2-proxy

Конфигурация — `oauth2-proxy/oauth2-proxy.yaml` (alpha config: провайдер `keycloak-oidc`, маршруты, заголовки;
адрес входа и issuer — из `${UMIAK_OIDC_ISSUER}`, oauth2-proxy подставляет переменные окружения в этот файл),
флаги в `compose.yaml` и переменные `OAUTH2_PROXY_*` (redirect URL, cookie, `reverse_proxy`). Настройки
конкретной установки — переменные, а не флаги: флаг нельзя переопределить override-файлом compose. `/api/*` идёт на `api:8081` без префикса `/api`, `/umiak-auth/*` — как есть;
таймаут upstream 660 s. В запрос к `api` добавляются `X-Auth-Request-User` (`sub`), `-Email`, `-Groups`,
`-Preferred-Username`; такие же заголовки от клиента вырезаются. Им можно доверять, потому что `:8081` не
опубликован на хосте; внутри сети `umiak` его видит любой контейнер (для dev допустимо, в проде закрывает
NetworkPolicy S12). Cookie `_umiak_session` без `Secure` и без
префикса `__Host-`: стек работает по http на localhost (за TLS — `__Host-umiak_session` и `Secure`, см. «Публичные
адреса»). Сессия обновляется каждые
5 минут (`--cookie-refresh=5m`) и живёт не больше 12 часов (`--cookie-expire=12h`, S8 §5.1), затем — новый вход.
Роли Keycloak, которые провайдер `keycloak-oidc` добавляет в `X-Auth-Request-Groups` как `role:<имя>`, `web` и
`api` отбрасывают: в JWT CLI их нет, а `users.groups` должен совпадать при входе из браузера и из CLI.

## web (S8)

`web` (образ `apps/web/Dockerfile`, `umiak-web:dev`) — Next.js + Payload; переменные — `apps/web/README.md`
(«Environment»). `web-migrate` — тот же образ с `node packages/payload/src/migrate.ts`: применяет миграции схемы
`payload` (в первой — платформенные значения по умолчанию, шаблон `linux` и размер `2gb`, как в
`config/umiak.yaml`, и копия личностей S7 из схемы `identity`, если она есть). `api`, `worker` и `web` стартуют
после него; `/readyz` `api` и `worker` и `/healthz` `web` не готовы, пока не применены все миграции Payload.

Первый запуск S8 на существующем томе (там уже есть схема `identity` от S7): сначала соберите образы, затем
остановите `api` и `worker`, затем поднимите стек. Иначе `api` до S8 продолжит писать в `identity`, пока
`web-migrate` копирует её в `payload`, и эти строки потеряются. Дальше шаг не нужен.

```sh
docker compose -f deploy/compose/compose.yaml build
docker compose -f deploy/compose/compose.yaml stop api worker
docker compose -f deploy/compose/compose.yaml up -d
```

- `api` и `worker` берут личности и конфиг (шаблоны, размеры, квоты, platform defaults) только из Payload:
  `UMIAK_CONFIG_FILE` у них больше нет, `config/umiak.yaml` читает только `migrate` (`bootstrap`: топология и сборки
  шаблонов). Шаблоны и размеры меняются в `/admin` (оператор), а не в `umiak.yaml`. `config/identity.yaml` `api`
  по-прежнему загружает при старте (upsert в Payload).
- `PAYLOAD_SECRET` — один на `web`, `web-migrate`, `api` и `worker` (`secrets/*/payload-secret`, см. «Секреты»).
- Сеть. `web` доверяет заголовкам `X-Auth-Request-*`, поэтому до `:3000` должен доходить только oauth2-proxy.
  `web` подключён только к сети `web-internal` (`internal: true`: без выхода наружу и без публикации портов), в
  которой кроме него только `oauth2-proxy` и `postgres` (`web` нужна база). Все остальные сервисы — только в сети
  `umiak`: из них имя `web` не резолвится, а адрес `web` в `web-internal` недоступен. Порт `web` на хосте не
  опубликован. Проверка:

  ```sh
  docker run --rm --network umiak_umiak busybox:1.38.0-musl wget -T 3 -qO- http://web:3000/healthz        # bad address 'web'
  ip=$(docker inspect -f '{{(index .NetworkSettings.Networks "umiak_web-internal").IPAddress}}' umiak-web-1)
  docker run --rm --network umiak_umiak busybox:1.38.0-musl wget -T 3 -qO- "http://$ip:3000/healthz"   # timeout
  docker compose -f deploy/compose/compose.yaml exec oauth2-proxy /bin/busybox wget -qO- http://web:3000/healthz  # ok
  ```

- База: `web` (как и `web-migrate`, `api`, `worker`) ходит в Postgres под общим суперпользователем `umiak` из
  `*db-env`. Отдельные роли Postgres из S8 §12 (у `web` — только схема `payload`, без `INSERT` в `api_keys`/`ssh_keys`)
  — работа S12.
- Postgres: `max_connections=200` (`api` ~36 соединений, `worker` ~37, `web` ~11, плюс Keycloak и одноразовые).
- `worker` включает `ctl-idp-sync` (S8 §20.1): раз в 5 минут читает пользователей realm `umiak` через Admin API
  Keycloak (`http://keycloak:8080`, клиент `umiak-worker` с ролью `view-users`) и деактивирует в Payload тех, кто
  отключён или удалён в Keycloak. `worker` не ждёт Keycloak: на свежем стеке первый проход может упасть
  (`idp sync failed … fetch failed`, Keycloak ещё стартует), следующий — через 5 минут
  (`umiak_idp_sync_total{result="ok"}` на `:9090/metrics`).
- Выход: `UMIAK_LOGOUT_URL` (по умолчанию `<UMIAK_KEYCLOAK_URL>/realms/umiak/protocol/openid-connect/logout?client_id=oauth2-proxy&post_logout_redirect_uri=<UMIAK_APP_ORIGIN>/app`).
  oauth2-proxy пропускает `rd` только на хосты из `whitelist_domains`, поэтому в нём и адрес Keycloak
  (`UMIAK_OAUTH2_PROXY_WHITELIST_KEYCLOAK`); realm разрешает клиенту `oauth2-proxy` post-logout redirect
  `<UMIAK_APP_ORIGIN>/*`.
- Логи: `docker compose -f deploy/compose/compose.yaml logs -f web web-migrate`.

## E2E-стек дашборда (S8 §15)

`e2e.yaml` — оверлей для Playwright-тестов `apps/web/e2e` (решение 10 плана S8): настоящие `postgres`, `keycloak`,
`oauth2-proxy`, `web`, `web-migrate`, `migrate`, но без Proxmox, gateway и гостя. `api` и `worker` выключены
(профили), вместо них один `e2e-backend` (`apps/web/e2e/backend`, образ `umiak-e2e-backend:dev`): код `api` и
`worker` в одном процессе на Payload, с фейковым агентом (`apps/api/src/testing`) и фейковым миром PVE
(`apps/worker/test/fakes`). В сети `umiak` у него алиас `api`, поэтому маршруты oauth2-proxy те же. Тестовая ручка
управления (проход `ctl-idp-sync`, «пустой» Keycloak, `routes.lookup`, что получил фейковый гость) — только на
`127.0.0.1:19099`, в продовом коде её нет.

```sh
pnpm --filter @umiak/web test:e2e          # up --build --wait, playwright, down -v
UMIAK_E2E_KEEP=1 pnpm --filter @umiak/web test:e2e   # стек остаётся; повтор: cd apps/web && pnpm exec playwright test -c e2e
docker compose --env-file deploy/compose/e2e.env -f deploy/compose/compose.yaml -f deploy/compose/e2e.yaml down -v
```

- Проект `umiak-e2e` (свои тома), порты на хосте из `e2e.env` (`14180` приложение, `18180` Keycloak, `18080` публичный
  API, `15432` Postgres, `19099` ручка): можно держать рядом с dev-стеком. `e2e.env` передаётся `--env-file`, так что
  `deploy/compose/.env` dev-стека не подмешивается. Каталог `secrets/` общий с dev-стеком.
- Тестовых пользователей (`alice`, `bob`, `op` в `umiak-operators`, `dave`, пять «filler») global setup создаёт через
  Admin API Keycloak (пароль администратора — `KEYCLOAK_ADMIN_PASSWORD` из `e2e.env`), с суффиксом прогона: повторный
  прогон на живом стеке не сталкивается с прошлым.
- `e2e-backend` поднимает `ram_cap_mb` узла из `config/umiak.yaml` (фейковые VM ничего не стоят).

## Gateway (S4)

`compose.yaml` включает `gateway.yaml` (`include`), так что `up -d --build` поднимает `gateway-secrets` и
`gateway`. Gateway ходит во внутренний listener `api` (`UMIAK_GATEWAY_API_URL=http://api:8082`, токены
согласует `secrets-init`). Подробности, порты и доверие dev CA — `README.gateway.md`.

Что работает локально, без VM:

- Поиск маршрутов: `curl -sk --connect-to x-3000.umiak.localhost:443:127.0.0.1:8443 https://x-3000.umiak.localhost/`
  доходит до `api` и отвечает `404 route_not_found`. Для существующей machine с опубликованным портом
  маршрут находится так же.
- SSH-авторизация через `api`: gateway слушает `ssh.localhost:2222`, проверяет ключ или login-сертификат
  (подписан CA из `secrets/gateway/ssh_login_ca`, его выдаёт `api`) вызовом `api`. `/v1/meta` отдаёт
  `ssh.localhost:2222` и host keys gateway, `umiak ssh` берёт их оттуда. Домен портов — `umiak.localhost`.
- Реестр gateway в Postgres, внутренний listener (worker вызывает `rotate-token`), метрики на 9190.

Чего без реальной VM нет: туннеля агента (`umiak-guest-agent` внутри VM подключается к `tunnel.localhost`), поэтому
нет проксирования preview-трафика и SSH-сессий в VM, нет RPC агента и файлов, а sandbox не доходит до `ready`.
Для этого нужна VM на Proxmox с шаблоном, в котором есть агент.

Проверка:

```sh
docker compose -f deploy/compose/compose.yaml ps -a   # gateway, api, keycloak, oauth2-proxy, postgres: healthy
curl -sk --connect-to x-3000.umiak.localhost:443:127.0.0.1:8443 https://x-3000.umiak.localhost/   # 404 route_not_found
```

Стек без `api`: `UMIAK_GATEWAY_API_URL=none` в `deploy/compose/.env`.

## Публичные адреса

По умолчанию стек живёт на фиксированных портах localhost. За TLS-прокси (ingress, Tailscale Serve и т. п.)
публичные адреса задаются в `deploy/compose/.env`: они записаны в realm, oauth2-proxy и `/v1/meta`. Зависимые
значения (issuer, redirect URL, адрес SSO gateway) по умолчанию выводятся из `UMIAK_KEYCLOAK_URL` и
`UMIAK_APP_ORIGIN`, так что обычно хватает `UMIAK_API_PUBLIC_URL`, `UMIAK_APP_ORIGIN`, `UMIAK_KEYCLOAK_URL`,
`UMIAK_OAUTH2_PROXY_WHITELIST_DOMAIN`, настроек cookie и прокси.

| Переменная | По умолчанию | Куда идёт |
|---|---|---|
| `UMIAK_API_PUBLIC_URL` | `http://localhost:8080` | `api` `UMIAK_API_URL` (`/v1/meta` `apiUrl`), `web` (подсказки CLI и SDK) |
| `UMIAK_MCP_PUBLIC_URL` | `http://localhost:8090/mcp` | `mcp` `UMIAK_MCP_PUBLIC_URL`: адрес, по которому клиенты MCP ходят на сервер; его host — единственный допустимый `Host` (плюс `UMIAK_MCP_ALLOWED_HOSTS`), а сам адрес — `resource` в метаданных защищённого ресурса |
| `UMIAK_APP_ORIGIN` | `http://localhost:4180` | `api` `UMIAK_APP_URL` и `UMIAK_APP_ORIGIN` (Origin для небезопасных методов на proxied listener); `web` `UMIAK_APP_ORIGIN`; web origin и post-logout redirect клиента `oauth2-proxy` в realm |
| `UMIAK_KEYCLOAK_URL` | `http://localhost:8180` | Keycloak `KC_HOSTNAME` |
| `UMIAK_OIDC_ISSUER` | `<UMIAK_KEYCLOAK_URL>/realms/umiak` | `api` и oauth2-proxy (issuer, адрес входа) |
| `UMIAK_OAUTH2_PROXY_REDIRECT_URL` | `<UMIAK_APP_ORIGIN>/oauth2/callback` | oauth2-proxy `redirect_url`, redirect URI клиента в realm |
| `UMIAK_OAUTH2_PROXY_WHITELIST_DOMAIN` | `localhost:4180` | oauth2-proxy `whitelist_domains` — host:port из `UMIAK_APP_ORIGIN`; задаётся отдельно (compose не умеет отрезать схему) |
| `UMIAK_OAUTH2_PROXY_WHITELIST_KEYCLOAK` | `localhost:8180` | второй элемент `whitelist_domains` — host:port из `UMIAK_KEYCLOAK_URL` (переход на страницу выхода Keycloak) |
| `UMIAK_LOGOUT_URL` | `<UMIAK_KEYCLOAK_URL>/realms/umiak/protocol/openid-connect/logout?client_id=oauth2-proxy&post_logout_redirect_uri=<UMIAK_APP_ORIGIN>/app` | `web`: куда oauth2-proxy отправляет после выхода |
| `UMIAK_GATEWAY_AUTH_URL` | `<UMIAK_APP_ORIGIN>/umiak-auth/authorize` | gateway: куда отправлять браузер для порта в режиме `sso` |
| `UMIAK_KEYCLOAK_PROXY_HEADERS` | пусто | Keycloak `KC_PROXY_HEADERS`: за TLS-прокси `xforwarded` (или `forwarded`) |
| `UMIAK_KEYCLOAK_PROXY_TRUSTED_ADDRESSES` | пусто | Keycloak `KC_PROXY_TRUSTED_ADDRESSES`: адреса прокси (CIDR через запятую) |
| `UMIAK_OAUTH2_PROXY_COOKIE_NAME` | `_umiak_session` | имя cookie сессии; за TLS — `__Host-umiak_session` |
| `UMIAK_OAUTH2_PROXY_COOKIE_SECURE` | `false` | `true` за TLS (обязательно для `__Host-`) |
| `UMIAK_OAUTH2_PROXY_REVERSE_PROXY` | `false` | `true`, если перед oauth2-proxy стоит прокси с `X-Forwarded-*` |
| `UMIAK_PREVIEW_DOMAIN` | `umiak.localhost` | `api` `/v1/meta` `umiakDomain` (домен портов), `web` (CSP `frame-src`). У gateway — свой `UMIAK_GATEWAY_UMIAK_DOMAIN` в `gateway.yaml`: при смене нужен и override gateway с тем же значением |
| `UMIAK_SSH_HOST`, `UMIAK_SSH_PORT` | `ssh.localhost`, `${GATEWAY_SSH_PORT:-2222}` | `/v1/meta` `ssh` и `umiak ssh`. Хост gateway — свой `UMIAK_GATEWAY_SSH_HOST` в `gateway.yaml`: при смене `UMIAK_SSH_HOST` нужен и override gateway; порт по умолчанию следует за опубликованным `GATEWAY_SSH_PORT` |
| `UMIAK_API_TRUSTED_PROXY_CIDRS` | пусто | `X-Forwarded-For` идёт в `clientIp` лога `api` только от этих адресов, иначе адрес соединения |

- Realm импортируется только в пустой Keycloak: после смены `UMIAK_APP_ORIGIN` или `UMIAK_OAUTH2_PROXY_REDIRECT_URL`
  нужен чистый Keycloak (см. «Keycloak»).
- `api` никогда не верит заголовкам `Tailscale-User-*`, `X-Auth-Request-*` и `X-Forwarded-User/Email` на public
  listener-е: там личность — только `Authorization: Bearer`. `X-Forwarded-For` от `UMIAK_API_TRUSTED_PROXY_CIDRS`
  идёт только в `clientIp` лога.
- Пример такой раскладки — dev control plane на CT 590 (`infra/dev-cp/compose.dev-cp.yaml`).
- CLI с частным CA: `umiak --cacert <file>` или `UMIAK_CA_FILE` (к встроенным корням Node/Bun, хранилище ОС не
  используется; действует и на Keycloak, и на WebSocket `umiak shell`). Для dev control plane не нужно: у Tailscale Serve сертификат Let's Encrypt.

## Настройки

- `config/umiak.yaml` — топология (узел `pve`, хранилище `local-lvm`) и сборки шаблона 599 и 597 из S5; их в базу
  загружает `umiak-admin bootstrap` в `migrate`. Шаблоны, размеры, квоты и пулы `api` и `worker` берут из Payload
  (S8; правятся в `/admin`), секции `templates`/`sizes`/`quotas`/`pools` файла они не читают (начальные значения
  Payload совпадают с ними; пулы — коллекция `pool-targets` в `/admin`). После правки топологии или сборок
  достаточно перезапустить `migrate` (bootstrap идемпотентен, `api` и `worker` читают их из базы):

  ```sh
  docker compose -f deploy/compose/compose.yaml up -d --force-recreate migrate
  ```

  Правки `deploy/compose/.env` и файлов секретов: пересоздать их потребителей (`up -d --force-recreate <сервисы>`).
- `config/identity.yaml` — файл личностей `api` (`UMIAK_IDENTITY_FILE`): команды, пользователи, командные ключи по
  sha256. Загружается при каждом старте `api` (только upsert). В dev пуст: люди появляются при первом входе.
- `deploy/compose/.env` (git-ignored, пример — `.env.example`): Proxmox (`UMIAK_PVE_URL`, `UMIAK_PVE_TLS_NAME`,
  `UMIAK_NODE_SSH_HOST`, `UMIAK_PVE_TOKEN_ID`, `UMIAK_PVE_SECRETS_DIR`), `UMIAK_RECONCILE_DRY_RUN`, Keycloak
  (`KEYCLOAK_ADMIN`, `KEYCLOAK_ADMIN_PASSWORD`, `UMIAK_DEV_PASSWORD`), публичные адреса (см. «Публичные адреса»),
  `UMIAK_GATEWAY_API_URL`, `UMIAK_API_LOG_LEVEL`.
- Порты на хосте фиксированы: 8080 (api), 9091 (ops api), 8090 (mcp), 9092 (ops mcp), 8180 (Keycloak), 4180 (oauth2-proxy), плюс 5432
  и 9090. Публичные адреса по умолчанию указывают на них (`http://localhost:8180`, `http://localhost:4180`);
  другой порт — это другие публичные адреса, их надо задать вместе (см. «Публичные адреса»).
- Учётные данные Postgres `umiak/umiak/umiak` — только для разработки; порт опубликован на `127.0.0.1:5432`.
- `UMIAK_DB_POOL_MAX` (по умолчанию 30) — размер пула соединений worker. Блокировка питания (`power:<nodeId>`, S6 §15.1) держит по одному соединению на ноду в каждом процессе и под ней берёт ещё одно, плюс соединения pg-boss и операций. Значение должно с запасом превышать число нод.

## Что worker и api делают сами, а чего нет

- Reconcile работает в dry-run (`UMIAK_RECONCILE_DRY_RUN=1`): читает список VM на Proxmox (только чтение) и логирует, что сделал бы.
- Целевых размеров пулов нет (коллекция `pool-targets` Payload пуста, как `pools: []` в `umiak.yaml`, решение 17), поэтому worker сам не создаёт VM.
- Gateway (S4) в стеке и worker получает `UMIAK_GATEWAY_SERVICE_TOKEN_FILE` из `gateway.yaml`, но без VM с агентом (S3) туннеля нет: агентский порт недоступен, и создание sandbox не доходит до `ready`.
- RPC агента в `api` отвечают `503 agent_unavailable`, пока не подключён `ConnectAgentApi` (S3 уже в `main`, подключение — по команде master-сессии; решение 3 плана S7, `apps/api/README.md`); файлы идут через gateway.
- Схему `tunnel` создаёт миграция S2 `db/migrations/0100_tunnel_init.sql` (её применяет `migrate` вместе с миграциями S6). Том, созданный раньше временной фикстурой схемы `tunnel` (до этой миграции), с ней несовместим: пересоздать его `down -v`, затем `up -d --build`.
- С `UMIAK_GATEWAY_SERVICE_TOKEN_FILE` worker находит gateway, который держит туннель machine, через `PgRegistry` из `@umiak/agent-client` (своё небольшое подключение к Postgres и LISTEN `tunnel_sessions`) и вызывает на нём `rotate-token`.
- `UMIAK_PORT_DOMAIN` (домен опубликованных портов, например `umiak.example.com`) и `UMIAK_SSH_USER_CA_KEYS_FILE` (файл с публичными ключами SSH user CA, по одному в строке) worker передаёт агенту в каждом Claim (`port_domain`, `ssh_user_ca_keys`); ключи CA он, кроме того, отправляет `System/UpdateSshCa` при каждом resume, recover и reprovision. `gateway.yaml` задаёт `UMIAK_SSH_USER_CA_KEYS_FILE` = `ssh_user_ca.pub` gateway: без него sshd в VM не примет вход gateway и SSH не работает. Worker читает файл при старте: после смены CA перезапустите worker, и существующие sandbox получат новые ключи при следующем resume (для работающих — после stop/resume).

## Smoke-тест реального адаптера Proxmox

`apps/worker/test/pve-smoke.test.ts` гоняет `PveInfraRegistry` против хоста `pve`: create/start/shutdown,
snapshot и fork, два параллельных старта (power lock), reconcile в dry-run, затем удаляет всё созданное
и сравнивает inventory umiak-node «до» и «после». Без `UMIAK_PVE_SMOKE=1` тест пропускается, так что
`pnpm -r test` остаётся офлайн. Топология берётся из `config/umiak.yaml` (через `umiak-admin bootstrap`)
в свежей тестовой базе (локальный docker Postgres из global setup).

```sh
UMIAK_PVE_SMOKE=1 mise exec -- pnpm --filter @umiak/worker exec vitest run test/pve-smoke.test.ts
```

- Секреты: `~/.config/umiak` (или `UMIAK_SECRETS_DIR`); SSH-хост umiak-node: `UMIAK_NODE_SSH_HOST` (по умолчанию — dev-адрес из `.env.example`).
- Создаёт VM только в диапазоне 500–589 (590–596 — dev-инфраструктура, 597–599 — шаблоны) из шаблона 599, по 2 vCPU / 2 GB, не больше двух одновременно запущенных.
  Перед запуском в этом диапазоне не должно быть VM: тест проверяет это в начале.
- Идёт около 90 секунд, большая часть уходит на `shutdown` (гостю шаблона не хватает 60 с, дальше идёт `stop`).

## MCP (S11)

Сервис `mcp` (образ `umiak-mcp:dev`, `apps/mcp/Dockerfile`) отдаёт публичное API как инструменты MCP по Streamable HTTP. Состояния и секретов у него нет: он проверяет bearer вызовом `GET /v1/me` в `api` (`http://api:8080`) и передаёт тот же bearer во всех вызовах SDK, так что права решает `api`.

```sh
curl -s http://localhost:9092/readyz                                      # mcp: {"ready":true,...}
curl -si -X POST http://localhost:8090/mcp -H 'content-type: application/json' -d '{}'
# 401 с WWW-Authenticate: Bearer resource_metadata="http://localhost:8090/.well-known/oauth-protected-resource/mcp"
curl -s http://localhost:8090/.well-known/oauth-protected-resource/mcp    # authorization_servers: [issuer Keycloak]
```

Подключение клиентов (Claude Code, Codex, OpenCode, Gemini CLI, Inspector) — `apps/mcp/README.md`. Коротко: командный ключ `umiak_…` (`umiak keys create`) в `Authorization: Bearer`, или вход через браузер клиентом Keycloak `umiak-mcp` (публичный, authorization code + PKCE, redirect `http://127.0.0.1:33418/*`, `http://localhost:33418/*` и `http://127.0.0.1:19876/*` для OpenCode, он уже есть в realm).

- Проверка `Host`: допустимы host и hostname из `UMIAK_MCP_PUBLIC_URL` (по умолчанию `localhost:8090`) и значения `UMIAK_MCP_ALLOWED_HOSTS` через запятую (по умолчанию в стеке `127.0.0.1:8090`). Другой `Host` — `421`. Запрос с `Origin` отклоняется (`403`), пока origin не в `UMIAK_MCP_ALLOWED_ORIGINS` (в стеке пусто: клиенты MCP — не браузеры).
- За TLS-прокси задайте `UMIAK_MCP_PUBLIC_URL` (`https://…/mcp`); прокси отдаёт сервису `/mcp` и `/.well-known/oauth-protected-resource/mcp` (у `api.<домен>` в проде — те же пути, S11 §6.2). Пример — `infra/dev-cp/README.md`, «S11 MCP behind Tailscale Serve».
- Логи: `UMIAK_MCP_LOG_LEVEL` (по умолчанию `info`). Остановка по SIGTERM за 25 s (`stop_grace_period: 30s`).

## Как добавить сервис

1. Добавить блок в `services:` в `compose.yaml`; взять `<<: *service-defaults` (логирование и сеть `umiak`) и `<<: *db-env` для `DATABASE_URL`.
2. Если сервису нужна схема БД, поставить `depends_on: migrate: condition: service_completed_successfully`.
3. Секреты генерировать в `secrets-init/init.sh` в свой каталог `deploy/compose/secrets/<сервис>/` (git-ignored) и монтировать каталог, а не файл; в git — только `*.example`. Сервис ставит `depends_on: secrets-init: condition: service_completed_successfully`.
4. Образ собирать из корня репозитория (`context: ../..`, `dockerfile: apps/<name>/Dockerfile`); `.dockerignore` лежит в корне.
5. Новый пакет workspace (`packages/<name>` или `apps/<name>`) — добавить строку `COPY <dir>/package.json <dir>/` в блок манифестов стадии `base` **во всех** Dockerfile (`apps/worker/Dockerfile`, `apps/api/Dockerfile`), иначе `pnpm install --frozen-lockfile` не совпадёт с lockfile. Если пакет входит в зависимости сервиса, добавить и `COPY <dir>/src <dir>/src`; если он собирается в `dist` (как `@umiak/proto` и `@umiak/agent-client`), собрать его в стадии `build` и скопировать `dist` в итоговый образ.
   Новый Dockerfile для пакета workspace копирует в стадии `base` вместе с `package.json`, `pnpm-lock.yaml` и `pnpm-workspace.yaml` ещё и корневой `.pnpmfile.cjs` (хук `readPackage` для `openapi-typescript`): без него `pnpm install --frozen-lockfile` не сходится с checksum pnpmfile в lockfile.

## Запуск worker и api без Docker

Пакеты S6 и S7 запускаются из исходников (`node src/main.ts`), а `@umiak/proto` и `@umiak/agent-client` в рантайме берутся из `dist`. Перед первым запуском и после их изменений собрать:

```sh
mise exec -- pnpm build        # или только нужное: pnpm --filter "@umiak/agent-client..." run build
mise exec -- pnpm --filter @umiak/worker start
mise exec -- node apps/api/src/main.ts   # переменные окружения — apps/api/src/settings.ts
```

Тесты (`vitest`) и `typecheck` от этого не зависят: vitest берёт исходники по условию `source`, а `typecheck` сам собирает `dist`.
