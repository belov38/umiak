# R1. Переименование в Umiak

Статус: **спецификация**, 2026-11-02. Основание: решение Ильи от 2026-11-01.
Реализация — отдельная последовательная ветка; этот документ не разрешает менять стенд.

## 1. Решение и границы

Полное имя продукта — **Umiak**, машинное написание — `umiak`, префикс переменных — `UMIAK_`.
Переименовываем UI, документацию, CLI, SDK, GitHub, образы, внутренние протоколы,
службы, конфигурацию и принадлежащие платформе объекты Proxmox. `sbx` конфликтует
с Docker Sandboxes CLI; Skiff/Kayak/Dinghy отклонены. Доступность имени в реестрах
принята как исходное решение Ильи, регистрация и публикация не входят в R1.

Выбран **чистый redeploy приложения на существующем CT 590**, с новой БД, realm,
секретами и пересборкой всех четырёх шаблонов. Сам CT, его диски, адреса и Tailscale
node identity сохраняем; переименовываем его hostname и пользователя. Production нет.
In-place преобразование данных и двойной протокол увеличивают риск без пользы.
Старые sandbox и snapshots не переносим, старые ключи и сессии отзываем.
Совместимости с `sbx` CLI, env, API-ключами, заголовками, RPC и агентами нет.
Это разовое исключение из правил совместимости S2/S7/S11; будущие изменения Umiak
снова подчиняются этим правилам. `/v1` остаётся v1: rename до production не меняет
семантику ресурсов, только именованные ниже брендовые части контракта.

Не добавляем короткий CLI alias: единственная команда `umiak`. `umi`, `um` и особенно
`sbx` не устанавливаем. Эксплуатационные утилиты имеют явные имена `umiak-admin`,
`umiak-tpl`, `umiak-bench`; MCP stdio — `umiak mcp`.

## 2. Инвентаризация исходного дерева

Срез: `e349e8aa65650d9b5c33f735fd963cd6523f65b6`, до добавления R1.
Прочитаны `CLAUDE.md`, architecture, roadmap, S1–S11, dev-cp README и связанные
compose/PVE/template конфигурации и скрипты. Источник конкретного написания — код:
например, ключ имеет 43 символа тела **плюс 6 CRC**, а не только 43.
Это инвентаризация репозитория, не обследование текущего состояния `pve` или CT.
В README встречаются устаревшие сообщения «не проверено», 3 GB и старые build IDs;
они не отменяют более поздние решения roadmap и результаты S10.

### 2.1. Метод и числа

Проверены все 2444 tracked пути, включая `.github`, `.env.example`, lockfiles,
сгенерированные файлы и тесты. Для текстового содержимого — case-insensitive regex
`sbx|boat` без границ слова: он захватывает `SBX_`, `Sbx`, `sbxt1`, scope, SDK и repo.
Игнорируемые secrets, node_modules, research, локальные sdks/vendor-repos и `.git`
в числа не входят; их локальные пути проверяются отдельно перед cutover, без вывода
секретов. Бинарные fixtures проверять по манифесту архива, не строковой заменой.

| Область (непересекающиеся группы) | Файлов с совпадением | Строк | Вхождений |
|---|---:|---:|---:|
| `apps/`, `packages/`, кроме Python | 793 | 6721 | 7466 |
| `packages/sdk-py/` | 74 | 659 | 823 |
| `services/`, `libs/` (включая generated Go) | 506 | 4909 | 5903 |
| `proto/` | 14 | 41 | 53 |
| `db/` | 8 | 26 | 26 |
| `deploy/compose/` | 16 | 524 | 751 |
| `infra/dev-cp/` | 27 | 480 | 678 |
| `infra/pve/` | 4 | 220 | 319 |
| `infra/templates/` | 54 | 416 | 546 |
| `docs/` | 28 | 2159 | 3488 |
| `.github/` | 4 | 15 | 18 |
| Корень и прочее | 5 | 55 | 55 |
| **Итого** | **1533** | **16225** | **20126** |

516 tracked путей сами содержат старое имя (включая весь Python import tree).
Отдельные case-sensitive поиски пересекаются и **не суммируются**:

| Литерал | Вхождений | Файлов |
|---|---:|---:|
| `sbx` | 13300 | 1334 |
| `SBX_` | 2852 | 317 |
| `Sbx` | 2345 | 400 |
| `SBX` | 3034 | 335 |
| `boat-dev-clone` | 1280 | 468 |
| `boat` | 1442 | 475 |
| `sbxt1` | 47 | 21 |
| `@sbx/` | 1197 | 535 |
| `sbx-sdk` | 29 | 20 |
| `sbx_sdk` | 62 | 25 |

Повторяемая выгрузка совпадений и путей (исполнять на нужном срезе):

```sh
git grep -n -i -E 'sbx|boat' HEAD -- .
git grep -I -o -i -E 'sbx|boat' HEAD -- .
git ls-files | rg -i 'sbx|boat'
git grep -n -E 'SBX_|Sbx|sbxt1|sbx1|@sbx/|sbx-sdk|sbx_sdk' HEAD -- .
```

Для итоговой проверки исключения §4 задаются точными путями/строками, не широким
исключением `docs/`, generated или tests. Новая R1 сама содержит старые имена намеренно.

### 2.2. Карта по подсистемам и опасные места

- **TS workspace:** 16 scoped пакетов: `api`, `bench`, `cli`, `mcp`,
  `template-builder`, `web`, `worker`, `agent-client`, `auth`, `config`, `core`,
  `db`, `payload`, `proto`, `pve`, `sdk`. Python wrapper — семнадцатый manifest,
  сейчас unscoped `sbx-sdk`. Корневой `package.json` называется `boat-dev-clone`.
  Меняются manifests, imports/exports, pnpm filters, scripts, Docker COPY/filter,
  lockfile, fixtures и generated clients. Подсрезы (файлы/вхождения): api 154/1087,
  cli 75/842, mcp 74/742, web 105/574, worker 90/804, builder 59/854,
  bench 15/131, auth 16/48, Payload 44/342, TS SDK 32/557.
- **Go:** пять `go.mod`: `libs/proto`, `libs/tunnel`, `services/gateway`,
  `services/guest-agent`, `services/node-agent`; `go.work`, imports, module options
  buf и Docker build paths. `cmd/sbx-{gateway,agent,node,release,agent-harness}`,
  внутренний `sbxerr`, имена пакетов/типов и test harness тоже переименовать.
- **Proto:** 12 исходных `.proto`: 6 agent, 5 tunnel, 1 testing; два YAML генерации
  также содержат имя. `proto/sbx/{agent,tunnel,testing}/v1`, Go `libs/proto/sbx`,
  TS `packages/proto/src/gen/sbx`, testpb и test/gen. Имена Connect procedures и
  type URLs меняются: мало заменить Go imports, надо перегенерировать descriptors.
  Allowlist RPC gateway и запрет доступа к Control должны совпасть с новым namespace.
- **API/SDK/CLI/MCP:** OpenAPI `apps/api/openapi/v1.json`, API schemas, generated TS
  и Python, `Sbx`/`AsyncSbx`/`SbxError`, CLI completions/help/build assets,
  User-Agent, MCP serverInfo, `mcpServers.sbx`, `mcp__sbx__*`,
  ограждение `<<<sbx-untrusted …>>>`, metrics `sbx_*`, error domain/realm strings.
  `apps/api/src/routes/sbx-auth.ts` и маршруты `/sbx-auth/*` — брендовые URL.
  HTTP headers `Sbx-*` и `X-Sbx-*` проходят через API, gateway, агент, SDK, CORS,
  trailer parsing, oauth2-proxy и moonlight-web. Проверить strip входящих заголовков
  и защиту cookie: изменение только producers ломает либо auth, либо фильтрацию.
  Сами error codes (`agent_unavailable`, `snapshot_requires_stop`, `team_forbidden`,
  `desktop_unsupported` и остальные смысловые коды) бренда не содержат, остаются.
  Public IDs из `packages/auth/src/ids.ts`: `sb_`, `op_`, `cmd_`, `snap_`, `key_`,
  `sshk_`, `env_`, `usr_`, `team_`, `upl_`, `req_`; это типы ресурсов, не `sbx`.
- **DB:** схемы `runtime`, `tunnel`, `identity`, `payload`, служебная очередь pg-boss;
  названия таблиц/колонок описывают сущности, не бренд. В SQL 8 файлов/26 вхождений:
  `0201`, `0204`, `0206`, `0300`, `0301`, `0302`, `0303`, `0401`.
  Риск — не имя БД, а LISTEN/NOTIFY `sbx_sandboxes`, `sbx_routes`, `sbx_operations`,
  `sbx_identity`, `sbx_ssh_revoke`, плюс `sbx_config` в Payload hooks/listeners.
  Две исторические Payload TS-миграции содержат по одному `sbx_config`; JSON snapshots
  и журнал применённых миграций остаются неизменными. После нового развёртывания
  нельзя оставлять SQL triggers на старых каналах при новых listeners.
- **Config/compose:** `config/sbx.yaml`, `realm-sbx.json`, identity seed,
  `oauth2-proxy.yaml`, `.env.example`, `e2e.env`, секреты и пути монтирования,
  project/network `sbx`, DB/user/password defaults, DSN/healthchecks, TLS `sbx.pem/key`,
  cookies `__Host-sbx_auth`, `__Host-sbx_state_*`, `__Host-sbx_session`.
  Образы: `sbx-{api,worker,web,mcp,gateway,oauth2-proxy,secrets-init,turn,e2e-backend}:dev`.
  Собственный TURN label `sbx.turn.entrypoint-sha256` и nft table `inet sbx_turn`.
  Смена compose project создаёт новые networks/volumes, старые сама не убирает.
- **Dev-cp:** `names.sh`, deploy/smoke/e2e, TURN firewall/cert/probes,
  CLI password files, CT login `sbx`, checkout `~/boat-dev-clone`, config/cache,
  IPSet gateway, CA trust на Mac, MagicDNS/Serve issuer/redirect/CSP/Host allowlists.
  `names.sh` ещё содержит старый relay range 49160–49200; рабочий dev range по
  S10/README — **61000–61040**. Переименование не должно вернуть старые значения.
- **PVE:** все 4 файла `infra/pve/`; реально pool зовётся **`sandbox`**, token —
  **`sbx@pve!poc`**, роли `SbxPoC`, `SbxTemplateMedia`, `SbxConsole`, а не условный
  `sbx-pool`. SDN `sbx`/`sbx0`, dnsmasq config/leases, ACL, firewall groups/IPSets,
  node-agent restricted authorized_keys command, VM names/tags, LV ownership guards,
  ISO/import names/cache. Нельзя механически заменить теги и затем запускать prune:
  старые LVs перестанут распознаваться. Сначала удалить старые ресурсы старым кодом.
- **Templates/guest:** 54 из 82 файлов recipes содержат имя; installer/verify,
  shared `_windows`, early GPO, sysprep answer files, services, SCM recovery,
  LSA `L$sbx_user`, Windows named jobs/mutexes, Linux users `sbxstream`, desktop paths,
  package tar entries/signature manifests, trust bundle, runtime env `SBX=1`,
  `SBX_SANDBOX_ID`, `SBX_ENV_APPLIED`; SSH CA path. Особые случаи — Windows hostname
  ограничен 15 символами; serial `sbx1:` и family `sbxt1:` — **разные** поля SMBIOS,
  WS subprotocol — ещё третья строка. Проверить длины и границы parsers отдельно.
- **Docs/CI/root:** S1–S11, планы и результаты приёмок, architecture/roadmaps,
  README/quickstart, `CLAUDE.md`, `.gitignore`, root manifest/lockfile.
  Все 4 workflows `.github/workflows/` содержат старое имя: DB env/password,
  pnpm filters, image tags и buf baseline path. Оставить только `workflow_dispatch`.

## 3. Нормативная карта имён

Правило для собственных имён: `sbx` → `umiak`, `Sbx` → `Umiak`, `SBX` → `UMIAK`,
`boat-dev-clone` → `umiak`, включая регистронезависимые проверки и regex. Это правило
для классифицированных сущностей, не глобальный replace произвольного `boat`/`sb`.

| Вид | Было | Станет |
|---|---|---|
| Brand / repo / root package | sbx, boat-dev-clone | Umiak / `belov38/umiak` / `umiak` |
| CLI и утилиты | `sbx`, `sbx-admin`, `sbx-tpl`, `sbx-bench` | `umiak`, `umiak-admin`, `umiak-tpl`, `umiak-bench` |
| npm | `@sbx/<name>` | `@umiak/<name>` (все 16, `sdk` сохраняет suffix) |
| Python distribution / import | `sbx-sdk` / `sbx_sdk` | `umiak-sdk` / `umiak_sdk` |
| Python workspace manifest | `sbx-sdk` | `@umiak/sdk-py` (private; PyPI name отдельно) |
| SDK API | `Sbx`, `AsyncSbx`, `SbxError`, `sbx.ts`, `sbx.py` | `Umiak`, `AsyncUmiak`, `UmiakError`, `umiak.ts`, `umiak.py` |
| Go modules | `github.com/belov38/boat-dev-clone/<dir>` | `github.com/belov38/umiak/<dir>` |
| Proto source/package | `sbx.<area>.v1`, `proto/sbx/…` | `umiak.<area>.v1`, `proto/umiak/…` |
| WS subprotocol | `sbx-tunnel.v1` | `umiak-tunnel.v1` |
| SMBIOS serial / family | `sbx1:<id>:<BS>` / `sbxt1:<url>` | `umiak1:<id>:<BS>` / `umiakt1:<url>` |
| Env | `SBX_*`, `SBX=1` | `UMIAK_*`, `UMIAK=1` |
| Двойной бренд в env | `SBX_SBX_DOMAIN`, `SBX_GATEWAY_TLS_SBX_{CERT,KEY}_FILE` | `UMIAK_PREVIEW_DOMAIN`, `UMIAK_GATEWAY_TLS_PREVIEW_{CERT,KEY}_FILE` |
| HTTP headers / bootstrap scheme | `Sbx-*`, `X-Sbx-*`, `Sbx-Bootstrap` | `Umiak-*`, `X-Umiak-*`, `Umiak-Bootstrap` |
| API team key | `sbx_` + 43 base62 + 6 CRC | `umiak_` + те же 43 + 6 (полная длина 55) |
| Reserved sandbox key / port token | `sbxs_` / `sbxp_` | `umiaks_` / `umiakp_` |
| Preview DNS | `*.sbx.<domain>` | `*.umiak.<domain>` |
| Config/cache/state | `~/.config/sbx`, `~/.cache/sbx`, `~/.local/state/sbx` | соответствующие каталоги `umiak` |
| Product config | `config/sbx.yaml`, `/etc/sbx/sbx.yaml` | `config/umiak.yaml`, `/etc/umiak/umiak.yaml` |
| Realm / client audience | `sbx`, `sbx-cli`, `sbx-api`, `sbx-mcp`, `sbx-worker` | `umiak`, `umiak-cli`, `umiak-api`, `umiak-mcp`, `umiak-worker` |
| Operator group | `sbx-operators` | `umiak-operators` |
| App DB / DB role | `sbx` / `sbx` | `umiak` / `umiak` (новый случайный пароль) |
| SQL channels | `sbx_{sandboxes,routes,operations,identity,ssh_revoke,config}` | `umiak_` + прежний suffix |
| PVE user / token / pool | `sbx@pve`, `sbx@pve!poc`, `sandbox` | `umiak@pve`, `umiak@pve!dev`, `umiak` |
| PVE roles | `SbxPoC`, `SbxTemplateMedia`, `SbxConsole` | `UmiakPoC`, `UmiakTemplateMedia`, `UmiakConsole` |
| SDN zone / VNet | `sbx`, `sbx0` | `umiak`, `umiak0` |
| Firewall | `sbx-gateway`, `sbx-deny`, `sbx-deny-public`, `sbx-deny6`, `sbx-egress` | `umiak-` + прежний suffix |
| PVE VM/LV/media tags | `sbx`, `sbx-tpl`, `sbx-vm-*`, `sbx-snap-*`, `sbx-src-*`, `sbx-{seed,build,offline,virtio-win}-*` | `umiak` и соответствующие `umiak-*` |
| Node binary/config/state | `sbx-node`, `/etc/sbx-node.toml`, `/var/lib/sbx-node` | `umiak-node`, `/etc/umiak-node.toml`, `/var/lib/umiak-node` |
| Guest agent / release utility | `sbx-agent[.exe]`, `sbx-release` | `umiak-agent[.exe]`, `umiak-release` |
| Linux agent dirs / units | `/etc/sbx-agent`, `/var/lib/sbx-agent`, `/run/sbx-agent`, `sbx-{agent,identity,agent-rollback}.service`, `sbx-cmd.slice` | тот же layout с `umiak` |
| Linux runtime/desktop | `/etc/sbx`, `sbx-desktop`, `sbx-sunshine`, `sbx-moonlight-web`, `sbx-session`, `sbxstream` | те же имена с `umiak` |
| Windows agent dirs/service | `%ProgramFiles%\sbx-agent`, `%ProgramData%\sbx-agent`, SCM `sbx-agent` | соответствующие `umiak-agent` |
| Windows identity | `SBX` + 12 hex | `UMI` + прежние 12 hex (15 символов, сохраняет 48 бит suffix) |
| Windows LSA/jobs/GPO | `L$sbx_user`, `Global\sbx-*`, `sbx-early.cmd`, `sbx-unattend.xml` | `L$umiak_user`, `Global\umiak-*`, `umiak-early.cmd`, `umiak-unattend.xml` |
| SSH user CA files | `sbx_user_ca.pub` | `umiak_user_ca.pub` |
| Compose project/network/images | `sbx`, `sbx-<service>:<tag>` | `umiak`, `umiak-<service>:<tag>` |
| TURN table/label | `inet sbx_turn`, `sbx.turn.*` | `inet umiak_turn`, `umiak.turn.*` |
| Cookie / auth URL | `__Host-sbx_*`, `/sbx-auth/*` | `__Host-umiak_*`, `/umiak-auth/*` |
| TLS preview files | `sbx.pem`, `sbx.key` | `umiak.pem`, `umiak.key` |
| CT hostname/login/checkout | `sbx-dev-cp`, `sbx`, `~/boat-dev-clone` | `umiak-dev-cp`, `umiak` (uid 1000), `~/umiak` |
| MCP/config/metrics/User-Agent | `sbx`, `sbx-untrusted`, `sbx_*`, `sbx-mcp/<v>` | соответствующие `umiak`, `umiak-untrusted`, `umiak_*`, `umiak-mcp/<v>` |

Для будущего registry выбран namespace `ghcr.io/belov38/umiak-<service>:<tag>`;
локальные compose images остаются `umiak-<service>:dev`. R1 меняет ссылки/labels,
но не публикует образы и не создаёт Docker Hub repository. Существующие image
artifacts не переименовываются: новые собираются из renamed source.

Заголовки включают `Team`, `Confirm-Delete`, `Request-Id`, `Port-Token`, `Error-Code`,
`Command-Id`, offsets, screen/cursor sizes, `Machine-Id`, `Boot-Id`,
`Agent-Instance-Id`, `Vmgenid`, `Agent-Version`, `Gateway-Instance`, `Conn-Epoch`,
`Conn-Id`, `Instance-Url`, `Lane`, `Caller` и trailers. Меняются и нижнерегистровые
варианты. `X-Sbx-Desktop-User: sbx` становится `X-Umiak-Desktop-User: umiak`.
CRC API-ключа считают по **новому** prefix + body; заменить текст в старом ключе
невозможно: в БД только hash. Ключи перевыпускаются, regex/scanners/display lengths
обновляются; reserved `umiaks_` остаётся запрещённым в MVP.

Публичные пути `/v1/*`, `/api/v1/*`, `/mcp`, `/.well-known/*`, `/oauth2/*`,
`/app`, `/admin`, health/metrics и `/v1/connect` сохраняются. Единственное URL-исключение
по бренду — `/sbx-auth/*`. RPC `/sbx.agent.v1.…` и `/sbx.tunnel.v1.…` меняются вместе
с proto, это внутренний wire API. Public `sb_` сохраняется как сокращение sandbox;
переменные `sb`, слова sandbox и snapshot не являются старым брендом.

## 4. Что сохраняем

1. **Чужие продукты:** boat.dev как оригинал/будущий внешний provider (S14), URL и
   attribution; Sunshine, moonlight-web, coturn/turnserver, `user`, SYSTEM,
   qemu-guest-agent, oauth2-proxy (включая clientId), Keycloak, PostgreSQL,
   `KC_*`, `OAUTH2_PROXY_*`, `POSTGRES_*`, `PAYLOAD_SECRET`, `DATABASE_URL`,
   `NODE_EXTRA_CA_CERTS`, upstream module names, лицензии, pinned versions/hashes.
   Собственные обёртки/units/images этих продуктов меняются, upstream identity — нет.
2. **Инфраструктура вне бренда:** `pve`, `local-lvm`, VG `pve`, thin pool `data`,
   `vmbr0`, `10.88.0.0/24`, CT 590, VMIDs, MAC allocation scheme, адреса LAN/tailnet,
   `vm-<id>-disk-N`, `base-<id>-disk-N`, исходный Windows ISO и личные VM 9000/9001.
   `keycloak` как отдельная БД/user/service сохраняется. Новые DSN используют новый
   app DB/user, не переименовывают имена схем и сущностей ради бренда.
3. **Порты:** 443 gateway; 2222 SSH; Serve 8443/10000; loopback 8080/4180/8180/8090;
   internal API 8082, proxied API 8081, gateway 7000/9190, ops 9090/9091/9092;
   Postgres 5432; TURN 3478/5349 и dev relay 61000–61040. Меняем имена, не топологию.
4. **История:** существующие SQL и Payload миграции (включая JSON snapshots), их номера,
   hashes и журнал — **не редактировать и не squash**. Новая SQL-миграция
   `0500_umiak_names.sql` (блок R1 `0500–0599`) после всех существующих заменяет тела
   notify-функций `runtime.sandboxes_notify`, `hosted_ports_notify`, `operations_notify`,
   `desktop_notify`, `identity.notify_change`, `notify_ssh_revoke` на новые каналы.
   Сохранить triggers/transactionality и payload уведомлений; найти все `pg_notify`
   в каталоге БД, а не ограничиться списком. Payload hooks/listeners меняются в коде;
   старые seed-миграции посылают старый `sbx_config` до старта listeners — допустимая
   история, не runtime compatibility. Новые миграции используют только Umiak.
5. Старые commit SHA, имена уже завершённых веток, даты и замеры приёмок не переписываем.
   В docs обновляем действующие контракты/команды; исторические отчёты явно помечаем
   как «до R1». R1 имеет приоритет при конфликте написания. Старые имена остаются
   в R1-карте и точном allowlist истории; ссылки на текущий repo переводим на новый.

## 5. Runbook чистого dev-переезда (только будущая реализация)

### 5.1. Подготовка и точка возврата

Master назначает окно простоя; один исполнитель владеет cutover. Перед действием
снять актуальный список `qm list`, `pct list`, jobs, template builds, LV tags,
SDN/firewall references и фактические порты. CT имеет **6 GiB**, sandbox budget
**8 GiB суммарно**; не увеличивать лимиты и не трогать чужие VM/LXC/`vmbr0`.
Все сборки/verify выполнять последовательно, проверяя RAM перед каждым start.

Сохранить вне git с правами 0700/0600: dump app DB и Keycloak, Payload data,
compose .env/secrets, data encryption keys, подпись обновлений, CA и trust fingerprints,
PVE ACL/token metadata, SDN/firewall configs, CT config, Serve JSON, исходный commit
и образы. Записать проверенный способ восстановления; dumps/секреты в отчёт не включать.
Экспорт конфигурации Payload — для сравнения и ручного воспроизведения: templates,
sizes, quotas, operator policy, environments. Пользователей/команды/членства и IdP subjects
**создаём заново**; runtime rows, ключи, browser sessions и старые encrypted secrets
не импортируем. Нужные dev environment values оператор задаёт заново, не массовым restore.

Отключить входящие create/доступ, завершить активные операции, остановить идп-sync и
прочие писатели после уборки. Старым стеком/агентом удалить все собственные sandbox,
saved snapshots, build clones и временные media в разрешённом диапазоне; проверить
DB ↔ qm ↔ LVs. Старые шаблоны retired, не active. Не запускать новый prune над старыми
тегами; не ослаблять ownership guards. Подготовить backup/export старых шаблонов для
отката до удаления. При нехватке диска для backup — остановиться и сообщить master,
а не увеличивать storage/лимит без решения Ильи.

### 5.2. Host, сеть и CT

1. Остановить старый compose project явным старым именем; оставить старый volume/dump
   изолированным для rollback. Новый project `umiak` не должен автоматически подхватить
   volume `sbx_*`. Не делать общий Docker prune и не удалять чужие volumes.
2. Создать роли/пользователя `umiak@pve`, token `dev`, pool `umiak` и ACL с прежними
   минимальными правами; проверить разрешённые и запрещённые операции новым токеном.
   Старый token отозвать при cutover. Установить `umiak-node`, config/state и новый
   restricted SSH key; сохранить host-key pinning, не отключать TLS/SSH verification.
3. При отсутствии старых VM пересоздать только собственные SDN zone `umiak` и VNet
   `umiak0`, с прежним subnet/SNAT/DHCP/isolate-ports; сверить dnsmasq paths/leases,
   config refs шаблонов и node-agent. Переименование включает pool `sandbox` только
   после проверки, что он исключительно наш; чужие элементы не переносить/не удалять.
4. **Каждое изменение PVE firewall/IPSets/CT firewall/SDN с риском потери доступа —
   сначала автоматический rollback на host**, с сохранёнными затронутыми конфигами.
   Таймер должен переживать SSH disconnect; для firewall окно 5 минут (cp-gateway
   допускает свой существующий 3-минутный таймер). Проверить таймер перед apply.
   Сначала создать новые IPSets `umiak-*` с тем же содержимым, затем атомарно перевести
   rule references/groups и проверить компиляцию/связность. Не удалять старый IPSet,
   пока есть references. TURN helper также адаптировать: его rollback удаляет только
   собственные tagged rules, сохраняя чужие/параллельные изменения. Не считать отключение
   datacenter firewall достаточным восстановлением SDN; snapshot сетевых configs обязателен.
5. Проверки до отмены таймера: operator SSH по LAN/tailnet, PVE API, существующие чужие
   guests доступны как до изменения; sandbox может только CT:443 и разрешённый TURN,
   не host/router/LAN/DB/ops, IPv6 deny сохранён; интернет/DNS работают.
   Отменить таймер только после всех проверок. Ошибка/потеря связи → откат.
   `/etc/nftables.conf` CT управляет только `table inet filter`, **без `flush ruleset`**,
   иначе теряются Docker chains. TURN namespace и watchdog `inet umiak_turn` сохранить.
6. CT 590 не пересоздавать: root-сессией переименовать Unix login/group `sbx` в `umiak`,
   home в `/home/umiak`, сохраняя uid/gid 1000, ownership и docker group. Проверить новый
   SSH до закрытия root-сессии. Новый checkout `/home/umiak/umiak`, secrets/config с
   правильными владельцами; не оставлять активный сервис со старым home/working directory.
   Переименовать CT hostname и Tailscale hostname в `umiak-dev-cp`, operator — `umiak`;
   сохраняется node identity/IP, повторный `tailscale up` без необходимости не нужен.

### 5.3. CA, имена, данные и запуск

- Новое имя Serve — `umiak-dev-cp.<текущий-tailnet>.ts.net`; проверить фактическое
  MagicDNS/CertDomains, не допускать автоматического suffix из-за дубликата имени.
  Новый preview — `*.umiak.100-64-10-7.sslip.io`; tunnel остаётся
  `tunnel.192-168-68-90.sslip.io`, TURN — `turn.<tunnel-host>`. Адреса перепроверить.
- Старый CA ограничен `tunnel.<LAN>` и **`sbx.<tailnet-IP>`**. Нельзя просто перенести
  `ca.pem` в новый каталог: создать новый CA в `~/.config/umiak/dev-ca` с CN/O Umiak,
  ограничениями `tunnel.<LAN>` и `umiak.<tailnet-IP>`, затем новые tunnel/preview/TURN
  leaf certs. TURN остаётся дочерним именем tunnel namespace. Срок leaf и renewal
  сохранить по текущему коду; не расширять доверие на произвольные домены.
  Установить новый CA на Mac через trust helper (системный диалог возможен); проверить
  SAN/constraints/chain и отказ для чужого имени. Старый trust убрать по fingerprint
  после приёмки, не массово по приблизительному CN. Новые пакеты агента пинят только новый CA.
- Создать свежие app DB/user `umiak`, отдельную `keycloak` DB, realm `umiak` из нового
  `realm-umiak.json`. Import не обновляет существующий realm, поэтому не пытаться
  переименовать его поверх старой БД. Запустить SQL migrations включая 0500,
  затем Payload migrations, затем bootstrap topology; seed новых каталогов/политик,
  pools пустые. До регистрации verified builds новые create отключены.
- Ротировать app/Keycloak passwords, client secrets, service/cookie/cursor/data keys,
  TURN REST secret, SSH CA/host keys. Не переносить активные токены; update-signing key
  можно безопасно скопировать в новый путь (бренд не причина менять ключ), public keys
  recipes сверить. Если архив старого стенда восстанавливается, ему нужны его старые data keys.
- Обновить issuer `/realms/umiak`, audiences/azp, worker sync realm/client, группы,
  oauth2-proxy redirects/logout/whitelist, MCP PRM и Host/Origin allowlists, CSP,
  gateway auth URL `/umiak-auth/authorize`, TLS paths, SSH host pins клиентов.
  Внутри compose Keycloak по-прежнему доступен по `http://keycloak:8080`, public
  issuer использует Serve; CT containers не обязаны достигать внешнего Serve URL.
- Serve конфигурацию сохранить для отката, затем reset/rebuild mappings 8443
  `/`, `/v1`, `/mcp`, `/.well-known/oauth-protected-resource/mcp` и 10000 `/`.
  443 **не отдавать Serve**, он нужен gateway previews. Проверить новый LE сертификат,
  login/logout/device flow/MCP OAuth, отсутствие старых issuer/redirects.
- Dev users создать заново (`dev-users.sh` после rename), operator membership назначить
  новой группе, выполнить JIT в Payload, выпустить новые командные API-ключи. CLI profiles
  создать через `umiak login`, не копировать credentials из `~/.config/sbx`.

### 5.4. Четыре шаблона и отсутствие окна совместимости

Пересобрать с новыми signed agent packages/CA: **linux 597 → linux-desktop 596 →
windows-desktop 595 → windows 598**. Для desktop Windows предварительно собрать
pinned patched moonlight-web как сейчас. Зависимости `extends` recipes проверять;
каждый build использует свой точный VMID range. 599 не использовать как запасной
новый active build: старый PoC не отвечает контракту R1, снять его с регистрации;
если он принадлежит платформе, архивировать/retire старым инструментом, не затрагивая
исходные 9000/9001. Финальное размещение — ровно четыре слота, заданные Ильёй.

Перед пересборкой слота проверить отсутствие его потребителей и backup; не смешивать
старые/новые LV tags. Версии/build IDs новые; после verify обновить topology и активные
build references в Payload/runtime. Проверить внутри Linux все units/paths/SSH CA,
в Windows SCM, recovery commands, junctions current/previous, startup GPO, LSA, named
jobs/mutexes, seal/identity reset и reboot-before-ready. Новый Windows hostname —
`UMI` + последние 12 hex machineId, не `UMIAK` + 12 (превысило бы 15).

Старый агент использует `sbx-tunnel.v1`, `sbx1`/`sbxt1` и старый CA; новый gateway их
не принимает. На cutover старых runtime VM уже нет. Обновление старых агентов через
туннель не требуется; старые snapshots не регистрируем, resume старого диска запрещён.
Отдельные отрицательные тесты подтверждают отказ старого handshake/SMBIOS без fallback.

### 5.5. Завершение и откат

При сбое остановить новый стек и новые VMs, восстановить host configs/old node binary,
CA, Serve, старые app/IdP dumps и secrets **одним согласованным комплектом**;
не подключать новый worker к старой БД и наоборот. Для восстановленных template backups
вернуть старые tags/refs. Возврат удалённых dev sandbox не обещаем: они очищены до cutover.

После полной приёмки удалить только подтверждённые собственные старые роли/ACL/pool,
SDN/firewall objects/references, restricted key, packages, networks, images, volumes,
неактивные certs/trust и локальные credentials. Зашифрованный rollback архив сохранить
на 7 дней вне git, затем удалить отдельной операцией. Ни одной команды удаления
в составной shell-команде; удаление каждого ресурса отдельным проверяемым шагом.

## 6. Последовательные стадии реализации и зелёный main

Один implementation thread, одна ветка, никаких параллельных редакторов общих файлов.
Стадии — checkpoints внутри ветки, не разрешение сливать неработающие половины rename.
Main до финальной приёмки остаётся старым согласованным стеком; master сливает один
полностью проверенный набор. Проверки CI остаются manual dispatch. Никакого временного
старого протокола ради промежуточных коммитов.

| Этап | Результат | Проверка перед следующим этапом |
|---|---|---|
| R1.0 | Зафиксированы baseline, инвентарь/исключения, окно, backup/restore runbook; остановлены конкурирующие реализации | Чистое дерево, baseline local checks; все необходимые credentials доступны без логирования; места/лимитов хватает |
| R1.1 | Атомарный source rename: manifests/lockfiles, пять Go modules, proto namespace + regeneration, API/SDK/CLI/MCP/env/headers/cookies/SQL channels + 0500, security guards/tests | Полный локальный gate ниже; новый wire проходит, старый отвергается; fresh DB + upgrade history test; generated drift отсутствует |
| R1.2 | Compose/Docker/CI, recipes/install/verify, PVE/dev-cp scripts, UI/docs/quickstart согласованы с картой | Полный gate повторно; compose base + dev/desktop/e2e config; сборка всех образов, Linux/Windows packages; dry-run скриптов без SSH к стенду |
| R1.3 | Переезд dev-стенда по §5, новая сеть/IdP/CA/данные, четыре verified templates | Firewall с timer; template verify каждого recipe; smoke и проверки TLS/ACL/ownership, readiness всех сервисов |
| R1.4 | Полная приёмка снаружи и из VM, уборка старых объектов, актуальные build IDs/документация | `e2e.sh` **20/20**, оба `e2e-desktop`, TURN и probes ниже; независимая приёмка master |
| R1.5 | Master сливает зелёную ветку; GitHub rename и перепривязка инструментов | Новый clone/module resolution, remotes/worktrees/T3/dispatch проверены; финальный audit старого имени |

### 6.1. Локальный gate

Все инструменты через `mise exec --`, версии из `mise.toml`, без обновления зависимостей
попутно. `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm lint`,
`pnpm typecheck`, `pnpm test`; lockfiles регенерировать штатными pnpm/uv и затем
проверить frozen/locked install. Python — `uv run --locked ruff check .`,
`ruff format --check .`, `pytest` в `packages/sdk-py` (с префиксом `uv run --locked`).

Для каждого из пяти Go-модулей: `go build ./...`, `go vet ./...`,
`go test -race ./...`, `golangci-lint run ./...`; отдельно Linux integration-tag
и `services/guest-agent/test/linux/run.sh`, Windows amd64/arm64 cross-build
применимых модулей. Windows-native agent tests — runner/стенд, cross-build их не заменяет.
Postgres-backed тесты должны действительно выполняться с новой test DSN, не skip.

В `proto/`: `buf lint`, обе генерации (обычная и `buf.gen.test.yaml`), нулевой diff
после повторной генерации. Breaking-check относительно старого `main` **ожидаемо**
видит удаление namespace. Не отключать его навсегда и не делать silent skip из-за
смены `proto/sbx` на `proto/umiak`: проверить diff как разрешённый rename, обновить
baseline guard workflows, после merge проверять `buf breaking` относительно нового main.
Field numbers/semantics не меняются. Генераторы OpenAPI/TS/Python запустить из
package scripts; сравнить public paths/operationIds, кроме объявленного auth path,
проверить Python `_async` → `_sync` генерацию, новые imports и сборку wheel.

Контрактные тесты: новые key CRC/длины, старый bearer rejected, headers/CORS/trailers,
stripping подложенных заголовков/cookies, новые proto procedure/type URLs и Control
deny, SMBIOS max length с более длинным prefix, package signature/install/self-update,
Windows 15-char hostname; SQL triggers шлют новые NOTIFY и listeners инвалидируют
кэши маршрутов/identity/config/SSH revocation. Прогнать migrations на пустой БД и на
копии старой схемы (для проверяемости цепочки, не как способ переноса стенда), проверить
catalog function bodies и отсутствие активного `sbx_*` NOTIFY. Старые миграции checksum-identical.

Compose config валидировать для base, gateway, dev-cp, desktop и e2e overlays с
необходимыми fixture env; не печатать resolved secrets. Собрать все девять собственных
образов; smoke version/health, CLI compile для поддержанных платформ S7, `umiak mcp`
initialize/tools/list, npm pack и wheel import `Umiak`/`AsyncUmiak`.

### 6.2. Стендовая приёмка

- Каждый из четырёх recipe: штатный `umiak-tpl verify` и соответствующий
  `infra/templates/<recipe>/verify.*`, все проверки без FAIL; имена/службы/агент/CA
  проверяются в запечённом образе. Для desktop — `verify-desktop.ts <buildId>`;
  Windows-native agent tests через bench S9. Снять новые версии и численность проверок,
  не копировать старые 97/100/112 из исторических отчётов.
- `infra/dev-cp/e2e.sh` **20/20** с новым CLI и обоими SDK: device login, lifecycle,
  exec/PTY, файлы, preview token/sso, SSH, fork/snapshot, idle-stop, delete; после
  теста не осталось VM/LV/rows. Не заменять несколько SDK шагов mock-тестами.
- Linux: `infra/dev-cp/e2e-desktop.sh`; Windows: тот же скрипт с
  `UMIAK_E2E_TEMPLATE=windows-desktop`. На каждом — настоящий baked agent (без
  диагностического agent-package override), websocket и relay-only WebRTC, кадры
  реально меняются, MCP computer tools, fork credentials, stop/resume, старые cookie
  отвергаются, cleanup. Последовательно, с остановкой источника перед fork.
- На обоих desktop: `UMIAK_DESKTOP_TURN_TRANSPORTS=udp,tcp,tls`; один long-idle прогон
  на каждом OS с `UMIAK_DESKTOP_IDLE_HOLD_MS=1800000`, естественное закрытие viewer
  и idle-stop без API keepalive. `desktop-block-probe.ts` и `desktop-cache-probe.ts`.
- `infra/dev-cp/verify-turn.py` с `UMIAK_TURN_PROBE_GUARD=1`: UDP/TCP/TLS, expiry Refresh,
  peer restrictions/relay filter, fail-closed при потере table/address и восстановление,
  reload CT nftables не ломает Docker/TURN. Из гостя TCP/TLS TURN остаётся закрыт,
  разрешён только предусмотренный UDP 3478.
- Реальный browser login/logout, admin gate новой operator group, preview iframe/CSP,
  CLI profile/config perms, удалённый MCP OAuth + новый API key, PRM/issuer/audience,
  User-Agent/metrics с новым именем. Повторный deploy идемпотентен, старый realm/CA/agent
  не принимаются. Итоговый grep имеет только объяснённые исключения §4/R1.

Это требования к исполнителю, **в spec-thread эти проверки на стенде не запускаются**.

## 7. GitHub, worktrees и T3

GitHub rename `belov38/boat-dev-clone` → `belov38/umiak` выполняет master **после merge
реализации и приёмки**, когда больше нет работающих веток со старыми module imports.
Rename не должен быть способом обойти красные проверки. Репозиторий остаётся private;
не резервируем/не публикуем пакеты и домены попутно.

1. Закрыть/согласовать оставшиеся PR и worktrees; сохранить список веток, remotes и
   `git worktree list --porcelain`. Repo rename — metadata операция GitHub, файлы
   локально сама не перемещает. После rename каждому clone задать origin
   `https://github.com/belov38/umiak.git` (или эквивалент SSH), проверить fetch/push,
   branch upstream. Worktrees одного clone обычно делят remote config, отдельные
   clones обновляются отдельно. Не рассчитывать на redirect старого repo как контракт.
2. Go paths уже новые в реализации: go.mod, go imports, buf go_package/module options,
   Dockerfiles. Проверить в **fresh clone с новым Go cache**, что workspace не скрывает
   запросы к старым модулям; приватный доступ/GOPRIVATE настраивать на точный новый
   namespace с существующими credentials. Не добавлять постоянные replace на старый repo.
3. Проверить Actions manual workflows, secrets/variables/environments, external
   allowlists/webhooks/integrations, release assets/ссылки, image labels/source URLs,
   badges и install snippets. Обновить references, которые хранят URL строкой.
   Проверить repo-scoped package permissions, если они уже есть. Новый registry scope
   не появляется от rename repo; публикация не нужна для локальной сборки R1.
4. T3 project display name и project path обновить штатной настройкой T3 после закрытия
   активных worktree threads. Не переименовывать живой
   `/Users/ib/.t3/worktrees/boat-dev-clone/...` вручную: Git worktree metadata и
   привязка T3 расходятся. Предпочтительно создать project на новом canonical checkout
   `umiak` и новые worktrees средствами T3, старые оставить как закрытую историю.
   Если canonical checkout перемещается средствами Git, проверить `git worktree list`,
   `.git` pointers и при необходимости `git worktree repair`, затем перепривязать T3.
   Проверить открытие нового thread, cwd, git status/fetch и task commands.
5. Удалённый checkout CT меняется в R1.3 независимо от локального T3 path; обе формы
   проверяются отдельно. Исторические ссылки на commit/PR допустимы как история,
   действующие remotes и инструкции используют только новый URL.

## 8. Критерий завершения и вопросы

Завершено, когда main содержит согласованный rename, стенд работает только с Umiak,
все четыре шаблона rebuilt/verified, gate §6 зелёный, repo/remotes/T3 перепривязаны,
а остатки старого имени объяснены точным allowlist. Master получает commit/build IDs,
итоги тестов, состояние rollback timer (не активен после успешной проверки) и список
удалённых собственных объектов; секретов в отчёте нет.

**Открытых вопросов к Илье нет.** Технические решения приняты в этой спецификации.
Регистрация доменов, публичная публикация, правовая проверка торговой марки и увеличение
host limits вне R1; доступность имени не является юридическим заключением. Если для
backup/build реально не хватает текущего диска/RAM, это отдельный блокер master → Илья,
а не разрешение изменить лимиты. В этой ветке изменяются только R1 и строка roadmap;
реализация/деплой/rename GitHub выполняются после review master отдельным заданием.
