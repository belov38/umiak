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
 +---------------------------+         | - TURN (coturn)           |
                                       +---------------------------+
```

| Компонент | Язык | Ответственность |
|---|---|---|
| `apps/api` | TS, Hono + `@hono/zod-openapi`, Node 24 | Публичный REST API, OpenAPI, авторизация по API-ключам, NDJSON-стримы, WebSocket терминала. Источник OpenAPI для SDK |
| `apps/worker` | TS, pg-boss | Машины состояний sandbox и machine, warm pool, операции Proxmox, снапшоты и fork, auto-stop, очистка |
| `apps/web` | TS, Next.js + Payload 3 | `/admin`: операторы (пользователи, команды, ключи, шаблоны, размеры, квоты). `/app`: клиентский дашборд (список sandbox, терминал xterm.js, iframe рабочего стола, логи). С sandbox работает только через `apps/api` |
| `apps/cli` | TS (Bun compile) | Клиент публичного API |
| `apps/mcp` | TS | MCP-сервер поверх публичного API |
| `packages/sdk-ts`, `sdk-py` | генерация | Из OpenAPI |
| `services/guest-agent` | Go | Агент внутри VM (Linux: systemd unit, Windows: служба) |
| `services/gateway` | Go | Приём туннелей агентов, HTTP-прокси портов, SSH gateway, TURN |
| `services/node-agent` | Go | На каждой ноде Proxmox: операции LVM-thin, QMP, метрики ноды. В PoC можно заменить на SSH-исполнитель с тем же интерфейсом |
| Postgres | — | Одна БД: схема Payload (конфигурация) + схема API (рантайм) |

## 3. Модель данных (рантайм, `apps/api`)

- **Sandbox** — логическая сущность для пользователя: `id`, `template`, `size`, `state`, `ttl`/auto-stop, `env`, labels, текущая `machineId`, `url`-slug.
- **Machine** — конкретная VM: `vmid`, `node`, `cluster`, MAC, IP, `vmgenid`, `state`, `poolStatus` (warm / claimed / retired).
- **Disk** — LV на ноде: принадлежность machine, `origin` (snapshot или шаблон).
- **Snapshot** — набор LV-снимков всех дисков machine на момент времени: `kind` (auto / saved / fork-source), `name` для saved.
- **Command** — процесс: `id`, `sandboxId`, `cmd`, `cwd`, `env`, `detached`, `exitCode`, `startedAt`, `endedAt`. Вывод хранит агент, позже — копия в хранилище.
- **HostedPort** — порт sandbox, опубликованный на URL: `port`, `public`/`token`.
- **ApiKey**, **User**, **Team**, **Template**, **Size**, **Quota** — в Payload, API читает через Local API.

**Состояния sandbox:** `creating → ready ↔ running → stopping → stopped → resuming → ready`. Плюс `error` и `deleting → deleted`. `fork` создаёт новый sandbox в `creating`.

## 4. Гостевой агент (Go)

Работает с правами root или SYSTEM. Устанавливается в шаблон.

- **Транспорт.** Агент сам открывает WSS к `gateway`, внутри — HTTP/2, где агент сервер. Входящих портов нет. По соединению идут RPC (exec, files) и TCP-потоки (порты, SSH, moonlight). См. ниже и S2.
- **Регистрация в пуле.** При загрузке агент сообщает о себе (VMID, vmgenid, версия) и получает статус warm.
- **Claim.** Получает env, секреты (в tmpfs или в защищённый каталог), файлы, SSH-ключи пользователя, hostname. Отвечает о готовности по фазам.
- **Exec.** sync / stream (NDJSON-события `started`, `stdout`, `stderr`, `exit`) / detached + attach по offset / kill / timeout. Linux — bash, Windows — PowerShell. PTY/ConPTY для терминала.
- **Files.** read, write (поток), list, stat, delete, mkdir, move, chmod.
- **Ports.** Список слушающих портов; проксирование входящих потоков на `localhost:port`.
- **Хуки снапшота.** `quiesce` (Docker pause, fsfreeze / VSS) и `thaw`, с watchdog авто-разморозки.
- **Смена идентичности.** Агент видит смену `machineId` в smbios или `vmgenid` (fork) и меняет hostname, machine-id и SSH host keys; на Windows — имя машины. Затем перезапускает зависимые сервисы.
- **Health.** Heartbeat, CPU/RAM/disk, признак простоя.
- **Self-update.** Подписанные бинарники.

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

## 7. Сеть

- На каждой ноде своя локальная NAT-сеть для sandbox: Proxmox SDN **Simple zone** + VNet с SNAT, DHCP и **Isolate Ports**. Подсеть может повторяться на разных нодах, как у boat (`192.168.122.0/24` на каждом хосте). Публичных IP нет.
- Межнодовая L2-сеть (VXLAN/EVPN) не нужна: VM не общаются напрямую, а control plane не ходит к ним по IP — всё идёт через исходящий туннель агента.
- Firewall: sandbox не видят друг друга (isolate ports), LAN и management-интерфейс хоста; исходящий интернет разрешён; входящего нет.
- Вместо SDN можно вручную настроить bridge без физического порта, nftables masquerade и dnsmasq. Результат тот же; SDN выбран, потому что управляется через API Proxmox.
- Весь входящий трафик идёт через туннель агента к `gateway`:
  - **HTTP:** `https://<sandbox>-<port>.sbx.<domain>` → gateway → туннель → `localhost:port`. Доступ по токену или публичный.
  - **SSH:** `ssh <sandbox>@ssh.<domain>` → gateway проверяет ключ пользователя → туннель → sshd или встроенный shell агента.
  - **Рабочий стол:** сигналинг moonlight-web через туннель; медиа WebRTC через TURN на gateway.

## 8. Рабочий стол и computer-use

- Linux и Windows: Sunshine (захват экрана, кодирование) + moonlight-web (WebRTC в браузер). Стример запускается по требованию.
- URL рабочего стола с коротким токеном, встраивается в iframe дашборда.
- Computer-use: cua-driver (MIT) в пользовательской сессии гостя. API платформы проксирует screenshot, click, type и т.п. через агента; MCP-обёртка в `apps/mcp`.
- Windows: autologon пользователя-агента, отключённый lock screen и UAC-промпты в шаблоне; cua-driver и Sunshine стартуют при входе.

## 9. Публичное API (v1, кратко)

`/v1/sandboxes` (create, get, list, update, delete), `/stop`, `/resume`, `/fork`, `/commands` (sync, stream, detached, attach, kill), `/files`, `/ports`, `/desktop`, `/snapshots` (saved), `/templates`, `/api-keys`, `/me`. Семантика как у boat (`research/03-api-sdk-surface.md`), формат свой. OpenAPI генерируется из zod-схем.

## 10. Развёртывание и аутентификация

**Control plane работает в Kubernetes:** `api`, `worker`, `web`, `gateway`, `mcp`. Postgres — в кластере (оператор) или внешний. Proxmox-ноды, VM и `sbx-node` остаются вне Kubernetes.

**Пользователи (браузер) — через oauth2-proxy.**
- `web` (`/admin`, `/app`) и браузерные вызовы API закрыты oauth2-proxy.
- Пользователь создаётся при первом входе (JIT) из заголовков oauth2-proxy: `X-Auth-Request-Email`, `-User`, `-Groups`. Это кастомная auth-стратегия Payload; API читает того же пользователя.
- Роли берутся из групп IdP: например, группа администраторов → оператор платформы.
- Заголовкам доверяем только от oauth2-proxy. Прямой доступ к подам закрыт NetworkPolicy, oauth2-proxy работает как sidecar или единственный upstream.

**Программный доступ (CLI, SDK, MCP, AI-агенты) — API-ключи.**
- Ключ создаёт JIT-пользователь в дашборде. `sbx login` в CLI открывает браузер (через oauth2-proxy) и получает ключ.
- Маршруты `/v1/*` с `Authorization: Bearer sbx_...` идут мимо OIDC-проверки oauth2-proxy (отдельный host `api.<domain>` или `skip_auth_routes`), ключ проверяет `api`.

**Мимо oauth2-proxy (своя аутентификация):**
- `tunnel.<domain>`: туннели агентов (WSS, bootstrap secret / machine token, см. S2). Ingress с длинными таймаутами для WebSocket.
- Внутренний listener gateway (ClusterIP) для вызовов `api` и `worker`, авторизация сервисными токенами.
- `*.sbx.<domain>`: публичные URL портов. Режимы доступа: `token` (как у boat), `sso` (через oauth2-proxy, только сотрудники компании), `public`.

**Деплой gateway.** Rolling update: `preStop` запускает drain (S2), `terminationGracePeriodSeconds` покрывает переезд агентов и закрытие TCP-потоков.

**Сеть.** `worker` ходит из кластера к Proxmox API (`:8006`) и к `sbx-node` по SSH (секреты в Kubernetes Secret). Sandbox-сеть разрешает исходящее соединение только к адресу ingress `tunnel.<domain>:443` (IPSet `sbx-gateway`). TURN (UDP) для рабочего стола — отдельный сервис с UDP LoadBalancer или hostNetwork (S10).

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
- Домен для `*.sbx.<domain>` и TLS (внутренний CA или Let's Encrypt через DNS-01).
- Kubernetes: какой кластер и ingress controller; какой IdP за oauth2-proxy и какая группа даёт роль оператора.
- SSH в госте: системный sshd через туннель или встроенный SSH-сервер в агенте.
