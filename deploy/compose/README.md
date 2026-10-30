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
| `gateway-secrets` | одноразовый (`gateway.yaml`): dev-секреты gateway в `secrets/gateway/` | — |
| `gateway` | S4: preview-адреса, SSH, туннели агентов (см. «Gateway (S4)» ниже) | 8443 (TLS), 2222 (SSH), 7000, 9190 |

`web` (S8) добавится позже.
Proxmox — любой хост, доступный из контейнеров (см. «Proxmox»).

Стек на `pve` (CT 590, доступен из sandbox VM): `infra/dev-cp/README.md`.

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
| `keycloak/admin-password` | `keycloak` | пароль администратора Keycloak, если `KEYCLOAK_ADMIN_PASSWORD` в `.env` не задан |
| `oauth2-proxy/client-secret`, `oauth2-proxy/cookie-secret` | `oauth2-proxy` | копия секрета клиента, ключ cookie (32 байта) |

- `secrets-init` стартует после `gateway-secrets` (S4), поэтому `service-tokens.json`, `gateway-token`,
  `ssh-login-ca` и `ssh-host-keys.pub` берутся из `secrets/gateway/` и переписываются при расхождении (если
  `gateway-secrets` убрать из стека, `secrets-init` создаёт свои dev-значения): `gateway/api-token` → `{"gateway": [...]}`, `gateway/service-tokens.json` →
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
# gateway-secrets, secrets-init, keycloak-db, migrate: Exited (0)
# postgres, keycloak, api, oauth2-proxy, gateway, worker: healthy
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

**Администратор Keycloak.** http://localhost:8180/admin, логин `KEYCLOAK_ADMIN` из `.env` (по умолчанию
`admin`). Пароль — `KEYCLOAK_ADMIN_PASSWORD` из `.env`, а если он не задан, его генерирует `secrets-init`:

```sh
docker compose -f deploy/compose/compose.yaml exec keycloak cat /run/sbx-secrets/admin-password
# или на хосте: deploy/compose/secrets/keycloak/admin-password
```

Учётка создаётся только при первом старте Keycloak; смена значений потом на неё не влияет. Realm `sbx`.

**Тестовый пользователь.** В realm `sbx` уже есть `dev@example.com` (email подтверждён) с временным паролем
`SBX_DEV_PASSWORD` из `.env` (по умолчанию `dev`). При первом входе Keycloak попросит задать новый пароль.
Новые пользователи заводятся в админке Keycloak (Users → Add user); для API у них должен быть отмечен
Email verified, иначе `api` отклонит их токен. Оператор платформы — член группы `sbx-operators`
(`SBX_OPERATOR_GROUPS`); права оператора действуют только в браузерной сессии.

**Браузер.** Дашборда пока нет (S8). Вход проверяется через API за oauth2-proxy:
http://localhost:4180/api/v1/me → страница входа Keycloak → JSON с пользователем, его личной командой и
`"auth": {"kind": "session"}`. Пользователь и личная команда создаются при первом входе.

**CLI.** `sbx` (`apps/cli`) входит через Device Authorization Grant. Бинарник для своей платформы собирает
`mise exec -- pnpm --filter @sbx/cli build` (`apps/cli/dist/sbx-<os>-<arch>`), из исходников —
`mise exec -- pnpm --filter @sbx/cli sbx <команда>`.

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
- Адреса: браузер и CLI ходят на публичный адрес Keycloak (`SBX_KEYCLOAK_URL` → `KC_HOSTNAME`, по умолчанию
  http://localhost:8180; issuer `<адрес>/realms/sbx` — `iss` токенов); `api` и `oauth2-proxy` — на
  http://keycloak:8080 внутри сети (`SBX_OIDC_DISCOVERY_URL`, `SBX_OIDC_JWKS_URL`, redeem и JWKS у oauth2-proxy).
  `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true`: backchannel-адреса берутся из адреса запроса, а `iss` остаётся публичным.
- Redirect URI и web origin клиента `oauth2-proxy` подставляются при импорте из `${SBX_OAUTH2_PROXY_REDIRECT_URL}`
  и `${SBX_APP_ORIGIN}` (см. «Публичные адреса»).
- Применить изменённый `realm-sbx.json` (или новые секреты клиентов): удалить базу Keycloak и перезапустить.

  ```sh
  docker compose -f deploy/compose/compose.yaml stop keycloak
  docker compose -f deploy/compose/compose.yaml exec postgres dropdb -U sbx keycloak
  docker compose -f deploy/compose/compose.yaml up -d
  ```

## oauth2-proxy

Конфигурация — `oauth2-proxy/oauth2-proxy.yaml` (alpha config: провайдер `keycloak-oidc`, маршруты, заголовки;
адрес входа и issuer — из `${SBX_OIDC_ISSUER}`, oauth2-proxy подставляет переменные окружения в этот файл),
флаги в `compose.yaml` и переменные `OAUTH2_PROXY_*` (redirect URL, cookie, `reverse_proxy`). Настройки
конкретной установки — переменные, а не флаги: флаг нельзя переопределить override-файлом compose. `/api/*` идёт на `api:8081` без префикса `/api`, `/sbx-auth/*` — как есть;
таймаут upstream 660 s. В запрос к `api` добавляются `X-Auth-Request-User` (`sub`), `-Email`, `-Groups`,
`-Preferred-Username`; такие же заголовки от клиента вырезаются. Им можно доверять, потому что `:8081` не
опубликован на хосте; внутри сети `sbx` его видит любой контейнер (для dev допустимо, в проде закрывает
NetworkPolicy S12). Cookie `_sbx_session` без `Secure` и без
префикса `__Host-`: стек работает по http на localhost (за TLS — `__Host-sbx_session` и `Secure`, см. «Публичные
адреса»). Сессия обновляется каждые
5 минут (`--cookie-refresh=5m`).

## Gateway (S4)

`compose.yaml` включает `gateway.yaml` (`include`), так что `up -d --build` поднимает `gateway-secrets` и
`gateway`. Gateway ходит во внутренний listener `api` (`SBX_GATEWAY_API_URL=http://api:8082`, токены
согласует `secrets-init`). Подробности, порты и доверие dev CA — `README.gateway.md`.

Что работает локально, без VM:

- Поиск маршрутов: `curl -sk --connect-to x-3000.sbx.localhost:443:127.0.0.1:8443 https://x-3000.sbx.localhost/`
  доходит до `api` и отвечает `404 route_not_found`. Для существующей machine с опубликованным портом
  маршрут находится так же.
- SSH-авторизация через `api`: gateway слушает `ssh.localhost:2222`, проверяет ключ или login-сертификат
  (подписан CA из `secrets/gateway/ssh_login_ca`, его выдаёт `api`) вызовом `api`. `/v1/meta` отдаёт
  `ssh.localhost:2222` и host keys gateway, `sbx ssh` берёт их оттуда. Домен портов — `sbx.localhost`.
- Реестр gateway в Postgres, внутренний listener (worker вызывает `rotate-token`), метрики на 9190.

Чего без реальной VM нет: туннеля агента (`sbx-guest-agent` внутри VM подключается к `tunnel.localhost`), поэтому
нет проксирования preview-трафика и SSH-сессий в VM, нет RPC агента и файлов, а sandbox не доходит до `ready`.
Для этого нужна VM на Proxmox с шаблоном, в котором есть агент.

Проверка:

```sh
docker compose -f deploy/compose/compose.yaml ps -a   # gateway, api, keycloak, oauth2-proxy, postgres: healthy
curl -sk --connect-to x-3000.sbx.localhost:443:127.0.0.1:8443 https://x-3000.sbx.localhost/   # 404 route_not_found
```

Стек без `api`: `SBX_GATEWAY_API_URL=none` в `deploy/compose/.env`.

## Публичные адреса

По умолчанию стек живёт на фиксированных портах localhost. За TLS-прокси (ingress, Tailscale Serve и т. п.)
публичные адреса задаются в `deploy/compose/.env`: они записаны в realm, oauth2-proxy и `/v1/meta`. Зависимые
значения (issuer, redirect URL, адрес SSO gateway) по умолчанию выводятся из `SBX_KEYCLOAK_URL` и
`SBX_APP_ORIGIN`, так что обычно хватает `SBX_API_PUBLIC_URL`, `SBX_APP_ORIGIN`, `SBX_KEYCLOAK_URL`,
`SBX_OAUTH2_PROXY_WHITELIST_DOMAIN`, настроек cookie и прокси.

| Переменная | По умолчанию | Куда идёт |
|---|---|---|
| `SBX_API_PUBLIC_URL` | `http://localhost:8080` | `api` `SBX_API_URL` (`/v1/meta` `apiUrl`) |
| `SBX_APP_ORIGIN` | `http://localhost:4180` | `api` `SBX_APP_URL` и `SBX_APP_ORIGIN` (Origin для небезопасных методов на proxied listener); web origin и post-logout redirect клиента `oauth2-proxy` в realm |
| `SBX_KEYCLOAK_URL` | `http://localhost:8180` | Keycloak `KC_HOSTNAME` |
| `SBX_OIDC_ISSUER` | `<SBX_KEYCLOAK_URL>/realms/sbx` | `api` и oauth2-proxy (issuer, адрес входа) |
| `SBX_OAUTH2_PROXY_REDIRECT_URL` | `<SBX_APP_ORIGIN>/oauth2/callback` | oauth2-proxy `redirect_url`, redirect URI клиента в realm |
| `SBX_OAUTH2_PROXY_WHITELIST_DOMAIN` | `localhost:4180` | oauth2-proxy `whitelist_domains` — host:port из `SBX_APP_ORIGIN`; задаётся отдельно (compose не умеет отрезать схему) |
| `SBX_GATEWAY_AUTH_URL` | `<SBX_APP_ORIGIN>/sbx-auth/authorize` | gateway: куда отправлять браузер для порта в режиме `sso` |
| `SBX_KEYCLOAK_PROXY_HEADERS` | пусто | Keycloak `KC_PROXY_HEADERS`: за TLS-прокси `xforwarded` (или `forwarded`) |
| `SBX_KEYCLOAK_PROXY_TRUSTED_ADDRESSES` | пусто | Keycloak `KC_PROXY_TRUSTED_ADDRESSES`: адреса прокси (CIDR через запятую) |
| `SBX_OAUTH2_PROXY_COOKIE_NAME` | `_sbx_session` | имя cookie сессии; за TLS — `__Host-sbx_session` |
| `SBX_OAUTH2_PROXY_COOKIE_SECURE` | `false` | `true` за TLS (обязательно для `__Host-`) |
| `SBX_OAUTH2_PROXY_REVERSE_PROXY` | `false` | `true`, если перед oauth2-proxy стоит прокси с `X-Forwarded-*` |
| `SBX_SBX_DOMAIN` | `sbx.localhost` | `api` `/v1/meta` `sbxDomain` (домен портов; у gateway — свой `SBX_GATEWAY_SBX_DOMAIN`) |
| `SBX_SSH_HOST`, `SBX_SSH_PORT` | `ssh.localhost`, `2222` | `/v1/meta` `ssh` и `sbx ssh` |
| `SBX_API_TRUSTED_PROXY_CIDRS` | пусто | `X-Forwarded-For` идёт в `clientIp` лога `api` только от этих адресов, иначе адрес соединения |

- Realm импортируется только в пустой Keycloak: после смены `SBX_APP_ORIGIN` или `SBX_OAUTH2_PROXY_REDIRECT_URL`
  нужен чистый Keycloak (см. «Keycloak»).
- `api` никогда не верит заголовкам `Tailscale-User-*`, `X-Auth-Request-*` и `X-Forwarded-User/Email` на public
  listener-е: там личность — только `Authorization: Bearer`. `X-Forwarded-For` от `SBX_API_TRUSTED_PROXY_CIDRS`
  идёт только в `clientIp` лога.
- Пример такой раскладки — dev control plane на CT 590 (`infra/dev-cp/compose.dev-cp.yaml`).
- CLI с частным CA: `sbx --cacert <file>` или `SBX_CA_FILE` (добавляется к системным корням; действует и на
  Keycloak, и на WebSocket `sbx shell`). Для dev control plane не нужно: у Tailscale Serve сертификат Let's Encrypt.

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
  (`KEYCLOAK_ADMIN`, `KEYCLOAK_ADMIN_PASSWORD`, `SBX_DEV_PASSWORD`), публичные адреса (см. «Публичные адреса»),
  `SBX_GATEWAY_API_URL`, `SBX_API_LOG_LEVEL`.
- Порты на хосте фиксированы: 8080 (api), 9091 (ops api), 8180 (Keycloak), 4180 (oauth2-proxy), плюс 5432
  и 9090. Публичные адреса по умолчанию указывают на них (`http://localhost:8180`, `http://localhost:4180`);
  другой порт — это другие публичные адреса, их надо задать вместе (см. «Публичные адреса»).
- Учётные данные Postgres `sbx/sbx/sbx` — только для разработки; порт опубликован на `127.0.0.1:5432`.
- `SBX_DB_POOL_MAX` (по умолчанию 30) — размер пула соединений worker. Блокировка питания (`power:<nodeId>`, S6 §15.1) держит по одному соединению на ноду в каждом процессе и под ней берёт ещё одно, плюс соединения pg-boss и операций. Значение должно с запасом превышать число нод.

## Что worker и api делают сами, а чего нет

- Reconcile работает в dry-run (`SBX_RECONCILE_DRY_RUN=1`): читает список VM на Proxmox (только чтение) и логирует, что сделал бы.
- Целевые размеры пулов в `sbx.yaml` равны 0 (`pools: []`, решение 17), поэтому worker сам не создаёт VM.
- Gateway (S4) в стеке и worker получает `SBX_GATEWAY_SERVICE_TOKEN_FILE` из `gateway.yaml`, но без VM с агентом (S3) туннеля нет: агентский порт недоступен, и создание sandbox не доходит до `ready`.
- RPC агента в `api` отвечают `503 agent_unavailable`, пока не подключён `ConnectAgentApi` (S3 уже в `main`, подключение — по команде master-сессии; решение 3 плана S7, `apps/api/README.md`); файлы идут через gateway.
- Схему `tunnel` создаёт миграция S2 `db/migrations/0100_tunnel_init.sql` (её применяет `migrate` вместе с миграциями S6). Том, созданный раньше временной фикстурой схемы `tunnel` (до этой миграции), с ней несовместим: пересоздать его `down -v`, затем `up -d --build`.
- С `SBX_GATEWAY_SERVICE_TOKEN_FILE` worker находит gateway, который держит туннель machine, через `PgRegistry` из `@sbx/agent-client` (своё небольшое подключение к Postgres и LISTEN `tunnel_sessions`) и вызывает на нём `rotate-token`.
- `SBX_PORT_DOMAIN` (домен опубликованных портов, например `sbx.example.com`) и `SBX_SSH_USER_CA_KEYS_FILE` (файл с публичными ключами SSH user CA, по одному в строке) необязательны: worker передаёт их агенту в каждом Claim (`port_domain`, `ssh_user_ca_keys`). Без них поля пустые.

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
   Новый Dockerfile для пакета workspace копирует в стадии `base` вместе с `package.json`, `pnpm-lock.yaml` и `pnpm-workspace.yaml` ещё и корневой `.pnpmfile.cjs` (хук `readPackage` для `openapi-typescript`): без него `pnpm install --frozen-lockfile` не сходится с checksum pnpmfile в lockfile.

## Запуск worker и api без Docker

Пакеты S6 и S7 запускаются из исходников (`node src/main.ts`), а `@sbx/proto` и `@sbx/agent-client` в рантайме берутся из `dist`. Перед первым запуском и после их изменений собрать:

```sh
mise exec -- pnpm build        # или только нужное: pnpm --filter "@sbx/agent-client..." run build
mise exec -- pnpm --filter @sbx/worker start
mise exec -- node apps/api/src/main.ts   # переменные окружения — apps/api/src/settings.ts
```

Тесты (`vitest`) и `typecheck` от этого не зависят: vitest берёт исходники по условию `source`, а `typecheck` сам собирает `dist`.
