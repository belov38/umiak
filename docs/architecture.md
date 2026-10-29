# Архитектура: self-hosted платформа sandbox для AI-агентов

Статус: черновик v0.1, 2026-10-29. Источник решений: `research/07-decisions.md`. Документы в `research/` — исследование; при расхождении верен этот файл.

## 1. Цель и рамки

API-платформа, которая выдаёт AI-агентам и людям изолированные VM (sandbox) на Proxmox VE. Агенты внутри sandbox запускают команды, работают с файлами и рабочим столом.

**Типы ОС (шаблоны):**

| Шаблон | ОС | Доступ |
|---|---|---|
| `linux` | Ubuntu (cloud-init) | exec, files, SSH |
| `linux-desktop` | Ubuntu + X11/openbox + Chrome | + рабочий стол в браузере, computer-use |
| `windows` | Windows 11 (образ и лицензия пользователя) | exec (PowerShell), files, рабочий стол |
| `windows-core` | Windows Server Core | exec (PowerShell), files |

**Не входит в фазу 1:** биллинг, публичные IP у sandbox, ZFS, Ceph, встроенные coding-агенты (prompt/steer/events), AI credentials proxy, мультирегион.

## 2. Компоненты

```
 Users / agents / CI
   |  HTTPS (REST + NDJSON + WS)            browser
   v                                           |
 +---------------------------+       +---------v-----------+
 | apps/api   (Hono, Node)   |<----->| apps/web            |
 | public API, auth, keys    |       | Next.js + Payload 3 |
 +-------------+-------------+       | /admin  /app        |
               |  Postgres           +---------------------+
 +-------------v-------------+
 | apps/worker (Node)        |  warm pool, lifecycle, snapshots, auto-stop
 | pg-boss jobs              |
 +------+-------------+------+
        | PVE API     | node ops (LVM-thin, QMP)
 +------v-------------v------+         +---------------------------+
 | Proxmox node(s)           |         | services/gateway (Go)     |
 |  services/node-agent (Go) |         | - agent tunnels (WS)      |
 |  VMs: guest-agent (Go)  --+--WS---->| - HTTP *.sbx.<domain>     |
 |  SDN VNet + SNAT          |  out    | - SSH gateway             |
 +---------------------------+         | - TLS edge, L4 LB         |
                                       +---------------------------+
                                         coturn (TURN) — отдельный сервис (S10)
```

| Компонент | Язык | Ответственность |
|---|---|---|
| `apps/api` | TS, Hono + `@hono/zod-openapi`, Node 24 | Публичный REST API, OpenAPI, авторизация по API-ключам, NDJSON-стримы, WebSocket терминала. Источник OpenAPI для SDK |
| `apps/worker` | TS, pg-boss | Машины состояний sandbox и machine, warm pool, операции Proxmox, снапшоты и fork, auto-stop, очистка |
| `apps/web` | TS, Next.js + Payload 3 | `/admin`: операторы (пользователи, команды, ключи, шаблоны, размеры, квоты). `/app`: клиентский дашборд (список sandbox, терминал xterm.js, iframe рабочего стола, логи). С sandbox работает только через `apps/api` |
| `apps/cli` | TS (Bun compile) | Клиент публичного API |
| `apps/mcp` | TS | MCP-сервер поверх публичного API |
| `packages/sdk-ts`, `sdk-py` | генерация + фасады | Из OpenAPI; хелперы ожидания, стрима с переподключением, загрузки, PTY |
| `packages/auth` | TS | Формат API-ключей, scopes, интерфейс `IdentityStore` (общий для `api` и `web`) |
| `services/guest-agent` | Go | Агент внутри VM (Linux: systemd unit, Windows: служба) |
| `services/gateway` | Go | Приём туннелей агентов, HTTP-прокси портов, SSH gateway, TLS-edge для `*.sbx`, `tunnel`, `ssh` (S2, S4). TURN — отдельный coturn (S10) |
| `services/node-agent` | Go | На каждой ноде Proxmox: операции LVM-thin, QMP, метрики ноды. В PoC можно заменить на SSH-исполнитель с тем же интерфейсом |
| Postgres | — | Одна БД: схема Payload (конфигурация) + схема API (рантайм) |

## 3. Модель данных (рантайм, схема `runtime`)

Подробно: `docs/specs/s6-control-plane.md`.

- **Sandbox** — логическая сущность для пользователя: `id`, `slug` (для URL и hostname), `template`, `size`, `state`, `health`, `activity`, TTL и idle-stop, labels, текущая `machineId`. Env и секреты — в отдельной таблице, зашифрованы (AES-256-GCM).
- **Machine** — конкретная VM: `id` (= `machineId` в smbios), `vmid`, `node`, `provider` (кластер), MAC, `state` (provisioning / booting / warm / claiming / running / stopped / deleting …). Привязка к sandbox ставится один раз и не меняется; у sandbox может быть несколько machine по истории (задел на перенос).
- **Provider / Node / Storage** — топология: кластер Proxmox, нода, хранилище с драйвером. Модель рассчитана на несколько кластеров и нод, PoC — одна нода.
- **TemplateBuild** — сборка шаблона на ноде (VMID шаблона, раскладка дисков, версия агента), пишет S5.
- **Disk** — LV на ноде: принадлежит machine или снапшоту.
- **Snapshot** — набор LV-снимков всех дисков machine: `kind` (saved / fork_source; `auto` зарезервирован на фазу 2), `name` для saved.
- **Operation** — операция над sandbox (create, fork, stop, resume, recover, delete, save_snapshot); одна активная на sandbox, delete вытесняет.
- **Command** — процесс: `id`, `sandboxId`, `cmd`, `cwd`, имена переменных env, `mode`, `status`, `exitCode`, `startedAt`, `endedAt`. Вывод хранит агент, позже — копия в хранилище.
- **HostedPort** — порт sandbox, опубликованный на URL: `port`, `label`, режим `token` / `sso` / `public`.
- **User**, **Team**, **Membership** (`owner`/`member`), **ApiKey**, **SshKey**, **Template**, **Size**, квоты команд, цели warm pool, `PlatformDefaults` — в Payload (схема `payload`, `docs/specs/s8-web.md` §7); `api` и `worker` читают через Payload Local API (`IdentityStore`, `ConfigReader`, кэш 10–30 s, сброс по `NOTIFY`).
- **Environment** — именованный набор env, секретов и secret-файлов команды; хранится в `runtime` зашифрованным, как `sandbox_secrets`, управляется через `/v1/environments`; при create значения копируются в sandbox (S8 §10).

**Состояния sandbox:** `creating → ready → stopping → stopped → starting → ready`. Плюс `error` и `deleting → deleted`. `fork` создаёт новый sandbox в `creating`. Здоровье (`health: ok | degraded`, degraded — агента нет дольше 60 s) и активность (`activity: busy | idle`) — отдельные поля, а не состояния.

## 4. Гостевой агент (Go)

Подробно: `docs/specs/s3-guest-agent.md` (Linux), Windows — S9. Работает с правами root или SYSTEM. Команды по умолчанию идут от непривилегированного `user` с NOPASSWD sudo (граница доверия — VM, S2 §16). Устанавливается в шаблон.

- **Транспорт.** Агент сам открывает WSS к `gateway`, внутри — HTTP/2, где агент сервер. Входящих портов нет. По соединению идут RPC (exec, files) и TCP-потоки (порты, SSH, moonlight). См. ниже и S2.
- **Регистрация в пуле.** При загрузке агент подключается к gateway и сообщает о себе (machineId, bootId, vmgenid, версия); VMID ему не известен. Machine становится warm.
- **Claim.** Получает env, секреты (в tmpfs без swap или в защищённый каталог; после каждой перезагрузки control plane присылает их заново), файлы-секреты, публичный ключ SSH CA gateway (`TrustedUserCAKeys`; ключи пользователя проверяет gateway, S4 §9), hostname. Отвечает о готовности по фазам.
- **Exec.** sync / stream (NDJSON-события `started`, `stdout`, `stderr`, `exit`) / detached + attach по offset / kill / timeout. Linux — bash, Windows — PowerShell. PTY/ConPTY для терминала. Каждая команда работает в своём systemd unit-е под shim, который пишет её вывод в файлы.
- **Files.** read, write (поток), list, stat, delete, mkdir, move, chmod.
- **Ports.** Список слушающих портов; проксирование входящих потоков на `localhost:port` (127.0.0.1, затем ::1, затем адреса интерфейсов).
- **Хуки снапшота.** `quiesce` (Docker pause, fsfreeze / VSS) и `thaw`, с watchdog авто-разморозки. QEMU guest agent fsfreeze — запасной путь, когда агента нет.
- **Смена идентичности.** При загрузке, до старта сети, агент видит смену `machineId` в smbios (fork, VM из saved snapshot) и меняет hostname, machine-id и SSH host keys, стирает своё состояние; на Windows — имя машины. На Linux vmgenid из userspace не читается, поэтому признак — только `machineId`; на Windows используется и vmgenid.
- **Health.** Heartbeat, CPU/RAM/disk, признак простоя.
- **Self-update.** Подписанный ed25519 пакет (бинарник + бандл tunnel CA) приходит через туннель; неудачная версия откатывается сама.

Образец API процессов и файлов — E2B `envd` (Go, Apache-2.0).

### Туннель и обрывы связи

Подробно: `docs/specs/s2-tunnel-protocol.md`. Принцип: **состояние живёт в агенте, а не в соединении.** Обрыв туннеля — штатная ситуация, данные при нём не теряются.

- **Транспорт.** Агент открывает `wss://tunnel.<domain>/v1/connect` (443). Внутри WebSocket роли развёрнуты: агент — HTTP/2-сервер, gateway — HTTP/2-клиент (как Cloudflare Tunnel). HTTP/2 даёт мультиплексирование, flow control, PING и CONNECT для TCP-потоков. RPC агента — Connect-RPC из одного proto для Go и TS. Gateway для RPC — reverse proxy и тела не разбирает. Транспорт спрятан за интерфейсом: можно подставить userspace WireGuard.
- **Аутентификация.** Bootstrap secret (BS) в `smbios1` VM, на диск гостя не попадает. Машинный токен (MT) живёт только в памяти агента, перевыпускается при claim и раз в 24 h. Fork и снапшоты не уносят учётные данные. Gateway предъявляет сертификат от приватного tunnel CA, и агент проверяет его по закреплённому CA.
- **Обнаружение обрыва.** WebSocket ping от агента каждые 5 s, соединение мёртво через 15 s; h2 PING со стороны gateway; TCP keepalive.
- **Переподключение.** Backoff 0.25 s → 10 s с full jitter. Одно активное соединение на machine, новое получает `epoch+1`. Сочетание `connId`, `agentInstanceId`, `bootId` и `machineId` отличает обрыв от перезапуска агента, перезагрузки и fork.
- **Процессы не зависят от соединения.** Каждая команда работает под shim (Linux: systemd scope; Windows: job object), который пишет вывод в файлы с монотонными байтовыми offset-ами и переживает перезапуск агента.
- **Возобновляемые стримы.** `agent-client` в API сам продолжает attach по `commandId` и offset, клиент видит паузу. `exit` приходит только после всего вывода. PTY живёт 10 минут без клиента.
- **Идемпотентность.** `commandId` создаёт control plane, и он же служит ключом `Start`. Мутирующие unary-вызовы несут `Sbx-Request-Id`, агент хранит ответы на диске 24 h. Файлы докачиваются через `Range` и чанки с offset.
- **Поведение API во время обрыва.** Вызов ждёт агента до 30 s, затем `503 agent_unavailable` с `retryable: true`. Sandbox `degraded`, если агента нет дольше 60 s.
- **Несколько gateway.** Реестр `machineId → gatewayInstance` в Postgres (`tunnel_sessions`, `gateway_instances`, `NOTIFY`), Redis не нужен. При деплое пода gateway `preStop` вызывает у агентов `Control/Drain`. Агенты переподключаются по схеме make-before-break, старый под отвечает `421 machine_moved`, стримы продолжаются по offset.
- **События агента.** Durable-журнал с `seq` на агенте; gateway доставляет его в `api` at-least-once.
- **Что рвётся.** Сырые TCP-потоки (SSH, WebSocket приложения, HTTP в полёте) при обрыве закрываются. Их возобновление — фаза 2.
- **Запасной канал без сети.** QEMU guest agent через Proxmox (virtio-serial): проверить состояние, прочитать лог агента, перезапустить агента. Дальше — `recover`: перезагрузка VM.

## 5. Хранилище: драйвер `lvmthin`

Интерфейс драйвера: `cloneFromTemplate`, `snapshot`, `cloneFromSnapshot`, `delete`, `usage`. Второй драйвер (ZFS или Ceph) — позже, по тому же интерфейсу.

- **Шаблон** — LV-диски шаблонной VM (`base-*`): `scsi0`, `efidisk0`, `tpmstate0`.
- **Новая machine** = thin snapshot каждого диска шаблона, активированный как записываемый, + конфиг VM с новым VMID и MAC. Делается через `node-agent`, а не `qm clone`, чтобы избежать блокировок и гонок Proxmox.
- **Snapshot работающей machine:** `guest-agent quiesce` → `lvcreate -s` для всех дисков → `thaw`. Длительность заморозки — секунды.
- **Fork** = snapshot + новая machine из этих LV. Thin-снимки не зависят от оригинала, его можно удалить.
- **Stop** = shutdown VM, LV остаются на ноде. **Resume** = старт той же VM.
- **Saved snapshot / пользовательский шаблон** = именованный snapshot, из которого создаются новые sandbox.
- **Ограничение фазы 1:** всё на одной ноде, где лежат LV. Перенос и архив — позже, через Proxmox Backup Server.

## 6. Warm pool

- Для каждой пары (шаблон, размер) держим N загруженных machine в статусе warm. Агент подключён, ОС готова.
- **Create** = claim warm machine (миллисекунды + provisioning через агент) → `ready`. Если пул пуст — холодный старт: клон шаблона и загрузка, Linux ~15–30 s, Windows ~40–90 s.
- Пул пополняется в фоне с ограничением параллельных клонов на ноду и storage.
- Fork и resume идут мимо пула: у них свои диски.
- Учёт RAM на ноде: работающие + warm + загружающиеся machine ≤ лимита ноды (8 GB в PoC). Пул пополняется только из свободной RAM. Create или resume при нехватке вытесняет warm machine других пар (шаблон, размер), иначе — `503 out_of_capacity`.
- Identity machine (`machineId`, bootstrap secret в smbios) задаётся при подготовке machine для пула; при claim worker ротирует machine token и передаёт агенту env, секреты и SSH-ключи.
- Новая сборка шаблона меняет поколение пула: старые warm machine заменяются, sandbox на старой сборке не трогаются.
- Подробно: `docs/specs/s6-control-plane.md` §9.

## 7. Сеть

- На каждой ноде своя локальная NAT-сеть для sandbox: Proxmox SDN **Simple zone** + VNet с SNAT, DHCP и **Isolate Ports**. Подсеть может повторяться на разных нодах, как у boat (`192.168.122.0/24` на каждом хосте). Публичных IP нет.
- Межнодовая L2-сеть (VXLAN/EVPN) не нужна: VM не общаются напрямую, а control plane не ходит к ним по IP — всё идёт через исходящий туннель агента.
- Firewall: sandbox не видят друг друга (isolate ports), LAN и management-интерфейс хоста; исходящий интернет разрешён; входящего нет.
- Вместо SDN можно вручную настроить bridge без физического порта, nftables masquerade и dnsmasq. Результат тот же; SDN выбран, потому что управляется через API Proxmox.
- Весь входящий трафик идёт через туннель агента к `gateway`:
  - **HTTP:** `https://<slug>-<port>.sbx.<domain>` → любой под gateway → туннель (локально или через под-владелец) → `localhost:port`. Режимы доступа `token`, `sso`, `public`. Подробно: `docs/specs/s4-gateway.md`.
  - **SSH:** `ssh <sandbox>@ssh.<domain>` → gateway терминирует SSH и проверяет ключ пользователя через `api` → туннель → системный sshd VM на `127.0.0.1:22` с короткоживущим сертификатом от SSH CA gateway (`TrustedUserCAKeys`). Ключи пользователей в VM не копируются.
  - **Рабочий стол:** сигналинг moonlight-web через туннель (`<slug>-desktop.sbx`); медиа WebRTC через отдельный TURN (coturn, S10).

## 8. Рабочий стол и computer-use

- Linux и Windows: Sunshine (захват экрана, кодирование) + moonlight-web (WebRTC в браузер). Стример запускается по требованию.
- URL рабочего стола с коротким токеном, встраивается в iframe дашборда.
- Computer-use: cua-driver (MIT) в пользовательской сессии гостя. API платформы проксирует screenshot, click, type и т.п. через агента; MCP-обёртка в `apps/mcp`.
- Windows: autologon пользователя-агента, отключённый lock screen и UAC-промпты в шаблоне; cua-driver и Sunshine стартуют при входе.

## 9. Публичное API (v1, кратко)

Подробно: `docs/specs/s7-public-api.md`.

- `/v1/sandboxes` (create, get с long-poll, list, update, delete, `stop`, `resume`, `fork`, `recover`, `extend`, `env`), `/v1/operations`, `/commands` (sync, NDJSON-стрим, detached, attach по offset, output, input, kill), `/ptys` (WebSocket), `/files` (Range, запись потоком, загрузка чанками, list/stat/mkdir/move/chmod/delete), `/ports`, `/ssh`, `/v1/ssh-keys`, `/v1/snapshots` (saved), `/v1/templates`, `/v1/sizes`, `/v1/api-keys`, `/v1/me`, `/v1/limits`, `/v1/meta`. Семантика как у boat (`research/03-api-sdk-surface.md`), формат свой, не wire-совместим.
- ID с префиксами (`sb_`, `op_`, `cmd_`, `snap_`, `key_`), в пути можно передать slug. Ресурсы без обёртки, списки `{data, nextCursor}`, ошибки `{error: {code, message, retryable, details, requestId}}`. `Idempotency-Key` для create, fork и команд: повтор не запускает команду дважды.
- Три listener-а `api`: публичный (только API-ключи), за oauth2-proxy (браузер, проверка Origin), внутренний (gateway, service tokens).
- OpenAPI генерируется из zod-схем; SDK TS (`openapi-typescript` + `openapi-fetch`) и Python (`openapi-python-client`) с рукописными хелперами; CLI `sbx` на TS SDK через Bun compile.

## 10. Развёртывание и аутентификация

**Control plane работает в Kubernetes:** `api`, `worker`, `web`, `gateway`, `mcp`. Postgres — в кластере (оператор) или внешний. Proxmox-ноды, VM и `sbx-node` остаются вне Kubernetes.

**Пользователи (браузер) — через oauth2-proxy.**
- `web` (`/admin`, `/app`) и браузерные вызовы API закрыты oauth2-proxy.
- Пользователь создаётся при первом входе (JIT) из заголовков oauth2-proxy: `X-Auth-Request-Email`, `-User`, `-Groups`. Это кастомная auth-стратегия Payload; API читает того же пользователя.
- Роли берутся из групп IdP: группа из `SBX_OPERATOR_GROUPS` → оператор платформы. Права оператора действуют только в браузерной сессии, не по API-ключу. Команды и роли `owner`/`member` — в Payload, при первом входе создаётся личная команда (S8 §6).
- Заголовкам доверяем только от oauth2-proxy. Прямой доступ к подам закрыт NetworkPolicy. oauth2-proxy работает в upstream-режиме и маршрутизирует `app.<domain>`: `/api/*` (без `/api`), `/cli/*`, `/sbx-auth/*` → `api :8081`, остальное → `web` (S8 §5.1).

**Программный доступ (CLI, SDK, MCP, AI-агенты) — API-ключи.**
- Ключ создаёт JIT-пользователь в дашборде. `sbx login` в CLI открывает браузер (через oauth2-proxy) и получает ключ.
- Маршруты `/v1/*` с `Authorization: Bearer sbx_...` идут мимо OIDC-проверки oauth2-proxy (отдельный host `api.<domain>` или `skip_auth_routes`), ключ проверяет `api`.

**Мимо oauth2-proxy (своя аутентификация):**
- `tunnel.<domain>`: туннели агентов (WSS, bootstrap secret / machine token, см. S2).
- Внутренний listener gateway (ClusterIP) для вызовов `api` и `worker`, авторизация сервисными токенами.
- `*.sbx.<domain>`: публичные URL портов. Режимы доступа: `token` (как у boat), `sso` (вход через oauth2-proxy на основном домене и одноразовый код, cookie IdP на sbx не попадает), `public`.
- `ssh.<domain>`: SSH gateway, ключи пользователей проверяет `api`.

**Edge gateway.** `tunnel.<domain>`, `*.sbx.<domain>` и `ssh.<domain>` идут не через ingress, а через отдельный L4 LoadBalancer Service `gateway-edge` (443 и 22; IP клиента — PROXY protocol v2 или `externalTrafficPolicy: Local`). TLS терминирует сам gateway: wildcard `*.sbx` от cert-manager (DNS-01), `tunnel` — от tunnel CA. Запасной режим «за ingress» поддерживается (S4 §5). Все cookie платформы на основном домене — host-only с префиксом `__Host-`, иначе код в sandbox может их подбросить (S4 §14.1).

**Деплой gateway.** Rolling update: `preStop` запускает drain (S2, S4 §10). HTTP-потоки живут до 2 min, SSH-сессии до 15 min с предупреждением, `terminationGracePeriodSeconds: 960`.

**Сеть.** `worker` ходит из кластера к Proxmox API (`:8006`) и к `sbx-node` по SSH (секреты в Kubernetes Secret). Sandbox-сеть разрешает исходящее соединение только к адресу `gateway-edge` (`tunnel.<domain>:443`, IPSet `sbx-gateway`). TURN (UDP) для рабочего стола — отдельный сервис с UDP LoadBalancer или hostNetwork (S10).

## 11. Безопасность

- API-ключи со scope, хранятся хешами в Payload.
- У каждой machine свой bootstrap secret в `smbios1` и машинный токен для туннеля только в памяти агента; токен перевыпускается при claim. Machine не переиспользуется между sandbox (S2).
- Секреты в госте в tmpfs (Linux) или в каталоге с ACL только для SYSTEM (Windows); стираются при stop.
- Proxmox: отдельный пользователь и API-токен с правами только на pool `sandbox` и нужные хранилища.

## 12. Фазы

| Фаза | Содержание |
|---|---|
| **PoC** (homelab `pve`) | Шаблон `linux`, guest-agent v0 (туннель, exec, files), gateway (туннели, HTTP-порты), worker (claim из warm pool, create, delete), драйвер lvmthin (clone из шаблона, snapshot, fork), минимальный API и CLI. Замеры: claim-to-ready, холодный старт, fork |
| **MVP** | + `windows`, `windows-core`, `linux-desktop`; stop/resume, saved snapshots, SSH gateway, рабочий стол, Payload admin/dashboard, API-ключи, auto-stop, SDK TS/Python, MCP |
| **Фаза 2** | Несколько нод и кластеров, PBS-архив и перенос, computer-use API, история команд вне VM, встроенные coding-агенты, egress-политики, OTel, webhooks |

## 13. Открытые вопросы

- Ресурсы под PoC на `pve`: RAM, диапазон VMID, согласие на изменения хоста (пользователь и токен, SDN, pool).
- Домен для `*.sbx`: по умолчанию `sbx.<domain>`; отдельный регистрируемый домен — выбор Ильи, можно позже (S4 §14.1). TLS: wildcard через cert-manager DNS-01 (S4 §5).
- Kubernetes: какой кластер и ingress controller; какой IdP за oauth2-proxy и какая группа даёт роль оператора.
- ~~SSH в госте: системный sshd или встроенный SSH-сервер в агенте.~~ Решено в S4: системный sshd на loopback с сертификатами от SSH CA gateway.
