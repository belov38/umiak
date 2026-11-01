# S1 Proxmox foundation: план реализации

> Исторический план до R1. Действующие имена и контракты — `docs/specs/rename-umiak.md`.

> **Для исполнителей:** REQUIRED SUB-SKILL: superpowers:executing-plans (или subagent-driven-development для независимых задач). Шаги — чекбоксы `- [ ]`.

**Цель:** реализовать S1 по `docs/specs/s1-proxmox-foundation.md`: подготовить `pve`, написать `sbx-node`, `packages/pve`, `sbx-bench`, получить зелёный прогон `sbx-bench s1` и записать цифры в §11 спецификации.

**Архитектура:** Go-бинарь `sbx-node` на хосте выполняет белый список LVM/DHCP/inventory-операций (JSON через stdin/stdout по SSH с forced command). TS-пакет `@sbx/pve` (PVE API через `node:https`, клиент `sbx-node` через `ssh2`, драйвер `lvmthin`, примитивы machine, аллокатор на `node:sqlite`). CLI `sbx-bench` (`apps/bench`) гоняет сценарий и печатает метрики. Runbook `infra/pve/setup.sh` запускается с Mac и выполняет шаги на хосте через `ssh pve`.

**Стек:** Go 1.27.3 (+ `github.com/pelletier/go-toml/v2`), Node 26.13.0 с нативным type stripping (TS без сборки), TypeScript 7 (`tsc --noEmit`), vitest 5, biome 2, `ssh2` 1.17.

**Спецификация:** `docs/specs/s1-proxmox-foundation.md` (источник истины). Интерфейс smbios — S2 §5.2 и §15.

## Глобальные ограничения

- VMID 500–599 (выдача 500–598, 599 — шаблон), RAM всех sandbox ≤ 8 GB, хранилище `local-lvm` (VG `pve`, pool `data`).
- Не трогать: существующие VM/LXC (100–109), `vmbr0`, шаблоны 9000/9001 и их LV.
- Все объекты на хосте помечены `boat-dev-clone S1 PoC`.
- Секреты (токен, ключ, BS/serial) — не в git, не в state, не в логах и JSON стенда.
- Пороги thin pool: create/snapshot запрещены при data > 80% или metadata > 70%.
- Freeze budget 10 s; без QGA snapshot запрещён (кроме явного `crashConsistent`).
- MAC: `02:<cluster>:<vmid 4 байта BE>`; `/cluster/nextid` не используется.
- `smbios1` и `vmgenid` из источника никогда не копируются в fork.
- `sbx-deny-public` пустой в PoC.
- Зависимости — последние стабильные (проверено 2026-10-29: `ssh2@1.17.0`, `@types/ssh2@1.15.6`, `go-toml/v2@v2.4.3`).
- Отклонение от спецификации [решение реализации]: §4 требует отдельного «да» перед firewall — master-сессия передала согласие Ильи на весь runbook, поэтому шаги идут без остановки, но строго с процедурой безопасного включения.

## Review Focus

1. **Включение firewall ломает существующих гостей.** `bridge-nf-call-iptables=1` после включения прогоняет весь мостовой трафик `vmbr0` через `PVEFW-FORWARD`, где по умолчанию `ctstate INVALID -j DROP`. В `host.fw` добавить `nf_conntrack_allow_invalid: 1` (хост по-прежнему не фильтруется) и проверить пинг гостей до/после. Проверка — в шаге `fw` runbook.
2. **SDN apply перезагружает сеть (`ifreload -a`).** Если `/etc/network/interfaces` расходится с живым состоянием, apply изменит `vmbr0`. Перед apply: `ifquery --check -a` без `[fail]`, иначе стоп. Шаг `sdn`.
3. **Частичный сбой посередине create/fork.** VM создана, а `lvcreate` или firewall упали — остаются конфиг, LV, строка аллокатора. Ожидание: ошибка наружу, machine-уровень сам вызывает delete-путь; `cleanup` добирает остальное. Тест в задаче 7.
4. **Повторная выдача VMID, пока у него остались следы.** Аллокатор должен пропускать VMID, у которого есть LV `vm-<id>-*` или VM в `/cluster/resources`, даже если в таблице его нет. Тест в задаче 5.
5. **Serial утекает в наши логи.** `sbx-node` не пишет `search` и любые поля `smbios1` в journal; стенд не пишет serial в JSON. Тесты в задачах 1 и 8.

---

### Task 1: `sbx-node` (Go, `services/node-agent`)

**Files:**
- Create: `services/node-agent/go.mod` (`go 1.27`, `toolchain go1.27.3`), `cmd/sbx-node/main.go`
- Create: `internal/config/config.go` (+ `_test.go`)
- Create: `internal/lvm/lvm.go` (интерфейс + exec-реализация через `lvs --reportformat json --units b --nosuffix`, `lvcreate`, `lvremove`, `lvmconfig`)
- Create: `internal/ops/{dispatch,guards,lv,pool,dhcp,inventory}.go` (+ `_test.go` с фейком LVM и fs)
- Create: `services/node-agent/.golangci.yml`
- Modify: `go.work` (`go work use ./services/node-agent`)

**Interfaces:**
- Produces (протокол, потребляет задача 4): запрос `{"op": string, "args": object, "requestId": string}`, ответ `{"ok": true, "result": …}` или `{"ok": false, "error": {"code": string, "message": string}}`; exit code 0/1. Коды ошибок: `bad_request`, `forbidden`, `not_found`, `exec_failed`.
- Конфиг `/etc/sbx-node.toml`: `vg="pve"`, `thinPool="data"`, `vmidMin=500`, `vmidMax=599`, `templateVmid=599`, `sdnZone="sbx"`, `vnet="sbx0"`, `clusterId=1`, `leaseFile="/var/lib/misc/dnsmasq.sbx.leases"` (путь уточнить после шага `sdn`), `storage="local-lvm"`.
- Операции и результаты:
  - `version` → `{version, config}`.
  - `lv.snapshot {items: [{origin, name, tags: string[], activationSkip: bool}]}` → `{created: string[]}`. Атомарно: при ошибке удаляет созданное этим вызовом.
  - `lv.remove {names: string[]}` → `{removed: string[], missing: string[]}`.
  - `lv.list {tags?: string[]}` (все теги должны совпасть; без фильтра — все LV VG) → `{lvs: [{name, sizeBytes, attr, tags, origin, dataPercent}]}`.
  - `pool.usage` → `{dataPercent, metadataPercent, sizeBytes, ourLvCount, ourLvSizeBytes, ourLvUsedBytes, autoextendThreshold}`.
  - `dhcp.leases` → `{leases: [{expiry, mac, ip, hostname, clientId}]}`.
  - `dhcp.release {mac}` → `{released: bool}` (через `dhcp_release <vnet> <ip> <mac>`).
  - `inventory {sections?: string[], search?: string, since?: number}` → секции `guests` (`qm list`/`pct list` в строки), `lvs` (LV без тега `sbx`: name, size, attr), `hashes` (sha256 `/etc/pve/sdn/**`, `/etc/pve/firewall/*.fw` кроме VMID диапазона, `/etc/pve/nodes/<node>/host.fw`, `/etc/network/interfaces*`), `sysctl` (`net.ipv4.ip_forward`, `net.ipv6.conf.all.forwarding`), `sbx0` (link-local адрес хоста), `vmfiles` (существующие `/etc/pve/qemu-server/<id>.conf` и `/etc/pve/firewall/<id>.fw` для VMID диапазона), `journalReaders` (члены групп `adm`, `systemd-journal`, `wheel`), `search` (только при `search`: `{journal: bool, tasklog: bool, qemuCmdline: bool}` — подстрока в `journalctl -o cat --since @since`, файлах `/var/log/pve/tasks/**` новее `since`, `/proc/*/cmdline` процессов `kvm`).

- [ ] **Step 1: тесты guards** (`internal/ops/guards_test.go`), табличные:
  - origin разрешён: `base-599-disk-0`, `sbx-snap-abc-scsi0`, `vm-500-disk-0`, `vm-598-disk-1`; запрещён: `base-9000-disk-0`, `vm-108-disk-1`, `vm-599-disk-0` (VMID шаблона), `vm-600-disk-0`, `root`, `data`, `../x`, `vm-500-disk-0;rm`.
  - name разрешён: `vm-500-disk-0`, `sbx-snap-k3j9x2m4qa-scsi0`; запрещён: `base-599-disk-0`, `vm-599-disk-0`, `vm-108-disk-0`, `vm-500-cloudinit`, имена вне `^[a-z0-9][a-z0-9+_.-]{0,126}$`.
  - tags: обязателен `sbx`; разрешены `sbx`, `sbx-vm-<id в диапазоне>`, `sbx-snap-<id>`, `sbx-src-<id в диапазоне>`; запрещены `sbx-tpl`, произвольные.
  - mac для `dhcp.release`: `02:01:00:00:01:F4` разрешён (cluster 1, VMID 500), `02:02:00:00:01:F4` и `02:01:00:00:00:6C` (VMID 108) и `BC:24:11:…` запрещены.
- [ ] **Step 2:** `go test ./...` — FAIL (нет кода).
- [ ] **Step 3:** реализовать `guards.go`: `ValidOrigin(cfg, name) error`, `ValidTargetName(cfg, name) error`, `ValidTags(cfg, tags) error`, `ValidMAC(cfg, mac) error`.
- [ ] **Step 4: тесты dispatch и операций** с фейком `lvm.LVM`:
  - неизвестный op → `bad_request`, exit 1; битый JSON → `bad_request`.
  - `lv.snapshot` из двух items, второй падает в фейке → первый удалён, ошибка `exec_failed`, `created` не возвращается.
  - `lv.remove` LV без тега `sbx` или с `sbx-tpl` → `forbidden`, ничего не удалено (проверка до любого удаления); отсутствующее имя → в `missing`.
  - журнал (фейковый logger): для `inventory {search:"SECRET"}` запись не содержит `SECRET`; для остальных op аргументы пишутся.
  - `dhcp.leases` разбирает строку `1793300000 02:01:00:00:01:f4 10.88.0.100 sbx-500 01:02:01:00:00:01:f4`.
- [ ] **Step 5:** реализовать `dispatch.go`, операции, exec-LVM (`lvcreate -s -k{y|n} -n NAME --addtag T… VG/ORIGIN`, `lvremove -y VG/NAME`), логирование в journal через `log/syslog` (тег `sbx-node`: requestId, op, args с редактированием `search`, итог).
- [ ] **Step 6:** `mise exec -- go test ./...` PASS; `mise exec -- golangci-lint run ./...` без замечаний; `GOOS=linux GOARCH=amd64 go build -o bin/sbx-node ./cmd/sbx-node`.
- [ ] **Step 7:** commit `node-agent: sbx-node with op whitelist and LV guards`.

### Task 2: runbook `infra/pve/setup.sh` и подготовка хоста

**Files:**
- Create: `infra/pve/setup.sh`, `infra/pve/snippets/sbx-tpl-vendor.yaml`, `infra/pve/sbx-node.toml`, `infra/pve/README.md` (как запускать, порядок шагов, откат)

**Interfaces:**
- Запуск с Mac: `infra/pve/setup.sh [--dry-run] <step>` и `infra/pve/setup.sh revert <step>`. Шаги: `user`, `net`, `sdn`, `node`, `fw`, `template`, `status`. Хост: `SBX_SETUP_SSH` (дефолт `pve`). `SBX_DENY_PUBLIC_IPS` (дефолт пусто).
- Produces: на Mac `~/.config/sbx/{pve-token (600), pve-root-ca.pem, sbx-node_ed25519, known_hosts}`; на хосте объекты §4.1–4.6.

- [ ] **Step 1:** написать `setup.sh`: каждый шаг = `check` (уже сделано → выход 0) → `apply` → `verify`; `--dry-run` печатает удалённый скрипт вместо выполнения. `shellcheck` чистый.
  - `user`: §4.1; секрет токена пишется только в `~/.config/sbx/pve-token` (через `pvesh create … --output-format json`, без вывода в терминал). CA: `/etc/pve/pve-root-ca.pem` → `~/.config/sbx/pve-root-ca.pem`.
  - `net`: §4.2.
  - `sdn`: §4.3; перед apply `ifquery --check -a` без `[fail]` и снимок `ip -d link show vmbr0`, после — тот же снимок совпадает.
  - `node`: §4.5; ключ генерируется, если нет; бинарь из задачи 1 копируется в `/usr/local/bin/sbx-node`, конфиг в `/etc/sbx-node.toml`; строка в `/etc/pve/priv/authorized_keys`; `ssh-keyscan -t ed25519 pve.tail0000.ts.net > ~/.config/sbx/known_hosts`; verify: `sbx-node version` через ключ.
  - `fw`: §4.4 ровно по процедуре. `host.fw`: `enable: 0` и `nf_conntrack_allow_invalid: 1` (Review Focus 1). IPv6: в группу добавить `OUT DROP -dest ::/0` (если `pve-firewall compile` не примет — IPSet `sbx-deny6` с `::/0`). Снимок «до» с Mac: `ssh pve true`, `ssh pve-lan true`, `curl --cacert ~/.config/sbx/pve-root-ca.pem` на `:8006` по Tailscale-имени и LAN IP (через `--resolve pve:8006:<ip>`), ping LAN IP каждого работающего гостя (IP из `ip neigh` по MAC из конфигов). Rollback-таймер 5 min → enable → 30 s → те же проверки + `pve-firewall status` + `iptables-save | grep -E 'tap1[0-9]{2}i|veth1[0-9]{2}i'` пусто + все гости из `qm list`/`pct list` в прежнем статусе. Всё, что было зелёным «до», должно быть зелёным «после» → `systemctl stop sbx-fw-rollback.timer`; иначе ждать отката, exit 1.
  - `template`: §4.6; ожидание QGA через `qm agent 599 ping`; внутри через `qm guest exec`; firewall 599 как у sandbox.
  - `status`: печатает состояние всех шагов.
- [ ] **Step 2:** `--dry-run` для каждого шага, прочитать вывод.
- [ ] **Step 3:** выполнить по порядку `user`, `net`, `sdn`, `node`, `fw`, `template`. Перед `fw` — повторно убедиться, что `ssh pve-lan` и ping гостей работают (база для сравнения). При любом красном `fw` — стоп и отчёт мастеру.
- [ ] **Step 4:** `setup.sh status` — всё зелёное; `qm list`/`pct list` как до начала (100, 101, 102, 103, 109, 104, 105 running).
- [ ] **Step 5:** уточнить путь lease-файла в `infra/pve/sbx-node.toml`, commit `infra: pve runbook for S1`.

### Task 3: разведка API на живом хосте (до кода machine)

Ручные вызовы токеном (`curl` с CA), результаты — в раздел «Находки» в конце этого плана. От них зависят задачи 6–7.

- [ ] **Step 1:** создать VM 598 токеном по §6.3 (POST без дисков, `lv.snapshot` через `sbx-node`, PUT config с `scsi0`, firewall). Записать: какие права потребовались сверх §4.1 (добавить в runbook и §4.1 спецификации), когда IP появляется в IPAM (после POST или после start), как читать IPAM токеном (`GET /cluster/sdn/ipams/pve/status` или другой путь).
- [ ] **Step 2:** `ipfilter=1`: заполнить `ipfilter-net0` адресом из IPAM до start, запустить, проверить DHCP и интернет. Если хрупко — режим `macfilter` only, решение в §11.
- [ ] **Step 3:** длина serial: PUT `smbios1` с serial 85, 256, 512, 1024 байт (base64=1) на остановленной VM, затем start и `product_serial` через QGA. Записать предел.
- [ ] **Step 4:** delete 598 (`purge=1&destroy-unreferenced-disks=1`): остаются ли lease в `dhcp.leases`, запись IPAM, `vm-598-cloudinit`, `/etc/pve/firewall/598.fw`. Если lease остаётся — нужен `dhcp.release` (и `dnsmasq-utils` в шаге `net`).
- [ ] **Step 5:** продление lease через firewall: `iptables-save` для `tap598i0-OUT`/`-IN` (порядок правила `dhcp` относительно группы), `isolate-ports` на `fwpr598p0` (`bridge -d link show`).
- [ ] **Step 6:** commit находок.

### Task 4: `@sbx/pve` — конфиг, PVE API, клиент `sbx-node`

**Files:**
- Create: `packages/pve/{package.json,tsconfig.json,vitest.config.ts}`, `src/index.ts`, `src/config.ts`, `src/pve-api.ts`, `src/node-client.ts`, `src/errors.ts`, тесты `test/config.test.ts`, `test/pve-api.test.ts`, `test/node-client.test.ts`
- Modify: корневой `.gitignore` (`bench-results/`)

**Interfaces:**
- `package.json`: `"name": "@sbx/pve"`, `"type": "module"`, `"exports": {".": "./src/index.ts"}`, scripts `test` (vitest run), `typecheck` (`tsc --noEmit`). Импорты с `.ts`; tsconfig: extends base, `allowImportingTsExtensions`, `noEmit`, `erasableSyntaxOnly` (Node запускает TS напрямую).
- `loadConfig(env = process.env): Config` — поля §6.1 (`pveUrl`, `tokenId`, `tokenSecretFile`, `caFile`, `tlsName`, `nodeSshHost`, `nodeSshKeyFile`, `nodeSshKnownHosts`, `vmidRange: {min, max}`, `clusterId`, `stateDb`, `templateVmid`, плюс `node: "pve"`, `storage: "local-lvm"`, `vnet: "sbx0"`); `~` раскрывается. Секрет читается лениво `readTokenSecret(cfg)`, права файла должны быть 600.
- `class PveApi { constructor(opts: {url, tokenId, tokenSecret, ca, tlsName}); get<T>(path, params?); post<T>(path, params?); put<T>(path, params?); delete<T>(path, params?); waitTask(node, upid, {timeoutMs}): Promise<void> }`. `node:https` с `ca` и `servername: tlsName`; тело `application/x-www-form-urlencoded`; ответ `.data`. Ошибка `PveApiError {status, message, errors}`. Повтор до 5 раз с backoff на ответах с `can't lock file` или 503.
- `interface NodeOps { call<T>(op: string, args?: object): Promise<T>; close(): void }`; `class SshNodeOps implements NodeOps` — одно SSH-соединение `ssh2`, exec-канал на вызов, JSON в stdin, проверка host key по нашему `known_hosts` (`hostVerifier`, сравнение base64 ключа). `NodeOpsError {code, message}`. `requestId` = `crypto.randomUUID()`.

- [ ] **Step 1:** тесты: `loadConfig` с пустым env даёт дефолты §6.1; `SBX_VMID_RANGE=500-598` → `{min:500,max:598}`, `500-700` при шаблоне 599 внутри → ошибка; `PveApi` против локального HTTPS-сервера с самоподписанным CA и сертификатом на `pve`: заголовок `Authorization: PVEAPIToken=sbx@pve!poc=<secret>`, form-тело, `data` разворачивается, 500 `can't lock file` повторяется и затем проходит, имя `pve` проверяется (сертификат на другое имя → ошибка); `waitTask` возвращает при `exitstatus: OK`, бросает с текстом при ином; `parseKnownHosts` + `hostVerifier` (верный ключ → true, другой → false).
- [ ] **Step 2:** FAIL → реализация → `pnpm --filter @sbx/pve test` PASS, `typecheck`, `pnpm lint`.
- [ ] **Step 3:** commit `pve: config, API client, sbx-node client`.

### Task 5: аллокатор VMID/MAC

**Files:** `packages/pve/src/allocator.ts`, `src/state-sqlite.ts`, `test/allocator.test.ts`

**Interfaces:**
- `macFor(clusterId: number, vmid: number): string` — верхний регистр, `macFor(1, 500) === "02:01:00:00:01:F4"`.
- `type LeaseState = "reserved" | "active" | "releasing"`; `interface VmidLease {cluster, vmid, mac, state, purpose: "machine" | "template", createdAt, updatedAt}`.
- `interface AllocatorStore { tryInsert(l: VmidLease): boolean; get(cluster, vmid); list(cluster): VmidLease[]; setState(cluster, vmid, s): void; remove(cluster, vmid): void }` и `interface SnapshotStore { putSnapshot(s: SnapshotRef); getSnapshot(id); listSnapshots(); removeSnapshot(id) }`.
- `class SqliteStateStore implements AllocatorStore, SnapshotStore` (`node:sqlite` `DatabaseSync`; таблицы `vmid_lease` с `UNIQUE(cluster, vmid)`, `UNIQUE(cluster, mac)`, и `snapshot(id PK, source_vmid, meta_json, created_at)`; путь `:memory:` для тестов).
- `class Allocator { constructor({store, clusterId, range, templateVmid, occupied: () => Promise<Set<number>>}); ensureTemplate(): void; allocate(purpose?): Promise<{vmid, mac}>; markActive(vmid); markReleasing(vmid); release(vmid) }`. `occupied` = VMID из `/cluster/resources` ∪ VMID из LV `vm-<id>-*` (собирает machine-слой).

- [ ] **Step 1:** тесты: первый allocate → 500/`02:01:00:00:01:F4`; 500 в таблице → 501; 501 в `occupied` (LV остался) → 502; `tryInsert` возвращает false (имитация гонки: фейковый store отклоняет первую вставку) → берётся следующий; диапазон исчерпан → ошибка `vmid_exhausted`; 599 (шаблон) не выдаётся даже при диапазоне 500–599; `release` удаляет строку, VMID выдаётся снова; запись в `releasing` VMID занимает.
- [ ] **Step 2:** FAIL → реализация → PASS → commit `pve: VMID/MAC allocator on node:sqlite`.

### Task 6: драйвер `lvmthin`

**Files:** `packages/pve/src/storage/types.ts`, `src/storage/lvmthin.ts`, `src/storage/disks.ts`, `test/lvmthin.test.ts`, `test/fakes.ts` (фейк `NodeOps` с журналом вызовов)

**Interfaces:**
- Типы как в спецификации §6.2: `StorageDriver`, `QuiesceHook`. `type DiskSlot = "efidisk0" | "scsi0" | "tpmstate0"`; `interface Disk {slot, volid, lv, sizeBytes?, options: Record<string,string>}`; `type DiskSet = Disk[]` (порядок слотов `efidisk0, scsi0, tpmstate0`); `TemplateRef {vmid, node, disks}`, `VmTarget {vmid, node}`, `MachineRef {vmid, node, disks, running: boolean}`, `MachineDisksRef {kind: "machine", vmid, node}`, `SnapshotRef {kind: "snapshot", id, node, sourceVmid, disks, hardware: Record<string,string>, createdAt}`, `NodeRef {node}`, `StorageUsage {dataPercent, metadataPercent, ourLvCount, ourLvUsedBytes}`.
- `parseDiskSet(config: Record<string,string>, storage): DiskSet` и `formatDisk(d: Disk): string` (`local-lvm:vm-500-disk-0,discard=on,iothread=1,ssd=1`; `size` не пишется).
- `class LvmThinDriver implements StorageDriver { constructor({node: NodeOps, vcpu: {suspend(vmid), resume(vmid)}, storage, freezeBudgetMs = 10000, maxDataPercent = 80, maxMetadataPercent = 70, thawRetries = 3, newSnapshotId?: () => string}) }`.
- Ошибки: `StorageFullError`, `FreezeBudgetExceededError`, `ThawFailedError` (machine требует внимания).

- [ ] **Step 1:** тесты (фейк фиксирует порядок вызовов):
  - `cloneFromTemplate` шаблона со `scsi0` (`base-599-disk-0`) → `pool.usage`, затем `lv.snapshot` `{origin:"base-599-disk-0", name:"vm-500-disk-0", tags:["sbx","sbx-vm-500"], activationSkip:false}`; возвращает `volid "local-lvm:vm-500-disk-0"` с опциями шаблона. Шаблон Windows с тремя слотами → `disk-0..2` по порядку слотов.
  - pool data 81% или metadata 71% → `StorageFullError`, `lv.snapshot` не вызывался.
  - `snapshot` running с 1 диском: `freeze` → `lv.snapshot` (`sbx-snap-<id>-scsi0`, tags `sbx`,`sbx-snap-<id>`,`sbx-src-500`, `activationSkip:true`) → `thaw`; `suspend` не вызывался. С 2 дисками: `freeze → suspend → lv.snapshot → resume → thaw`.
  - `lv.snapshot` падает → `thaw` всё равно вызван (и `resume`, если была пауза).
  - freeze+snapshot дольше budget (фейковые часы) → `lv.remove` созданных, `FreezeBudgetExceededError`, `thaw` вызван.
  - `thaw` падает 3 раза → `ThawFailedError`; падает 2 раза, затем ок → успех.
  - остановленная machine → ни `freeze`, ни `suspend`.
  - `cloneFromSnapshot` → origin `sbx-snap-<id>-scsi0`, name `vm-501-disk-0`, tags `sbx`,`sbx-vm-501`.
  - `delete({kind:"machine", vmid:500})` → `lv.list {tags:["sbx-vm-500"]}` → `lv.remove` этих имён; `delete(snapshotRef)` → по `sbx-snap-<id>`.
- [ ] **Step 2:** FAIL → реализация → PASS → commit `pve: lvmthin storage driver`.

### Task 7: примитивы machine

**Files:** `packages/pve/src/machine.ts`, `src/smbios.ts`, `src/qga.ts`, `test/machine.test.ts`, `test/smbios.test.ts`, фейк PVE API в `test/fakes.ts`

**Interfaces:**
- `interface Smbios {uuid: string; serial: string}` (serial — сырой payload); `formatSmbios1(s): string` → `uuid=<uuid>,serial=<base64(serial)>,base64=1`. `s2SerialPayload(machineId, bs: Uint8Array) = "sbx1:" + machineId + ":" + base64url(bs)`.
- `interface MachineSize {cores: number; memoryMb: number}` (дефолт 2 / 2048).
- `class Machines { constructor({api: PveApi-подобный, node: NodeOps, driver: StorageDriver, allocator: Allocator, snapshots: SnapshotStore, cfg: Config, cloneConcurrency = 4, ipfilter: boolean}) }`:
  - `create(opts: {size?, smbios?}): Promise<MachineInfo>`; `fork(snap: SnapshotRef, opts: {size?, smbios?}): Promise<MachineInfo>`; `MachineInfo {vmid, mac, node, disks}`.
  - `start(vmid)`, `shutdown(vmid, timeoutS)`, `stop(vmid)` — через задачу UPID.
  - `waitReady(vmid, {timeoutMs, startedAt}): Promise<{pingAt: number, ipAt: number, ip: string, ifname: string}>` — `agent/ping` до успеха, затем `agent/network-get-interfaces` до IPv4 в `10.88.0.0/24`.
  - `snapshot(vmid, {crashConsistent?: boolean}): Promise<SnapshotRef>` — QGA ping обязателен для running, иначе `QgaUnavailableError`; хук `QgaQuiesceHook` (`agent/fsfreeze-freeze`/`fsfreeze-thaw`); `hardware` из конфига без `smbios1`, `vmgenid`, `net0`, `name`, дисков и `ide2`; сохраняется в `SnapshotStore`.
  - `delete(vmid)`: `markReleasing` → `status/stop` (если существует и running) → `DELETE ?purge=1&destroy-unreferenced-disks=1` → `driver.delete` → `verifyGone(vmid, mac)` (config 404; `inventory {sections:["vmfiles"]}` пуст для vmid; IPAM без mac; lease без mac, иначе `dhcp.release` и повторная проверка) → `allocator.release`. Ошибка проверки → `TracesRemainError`, строка остаётся `releasing`.
  - `deleteSnapshot(ref)`: `driver.delete(ref)` → `lv.list` пуст → `snapshots.removeSnapshot`.
  - `qga.exec(vmid, cmd: string[], {timeoutMs, input?}): Promise<{exitCode, stdout, stderr}>` — `agent/exec` + опрос `exec-status`.
- Порядок create (§6.3): allocate → `POST /nodes/pve/qemu` (ключи шаблона по белому списку `machine, cpu, bios, ostype, scsihw, agent, serial0, vga, tablet`; `cores`, `memory`, `balloon=0`, `net0=virtio=<MAC>,bridge=sbx0,firewall=1`, `ide2=local-lvm:cloudinit`, `ipconfig0=ip=dhcp`, `ciuser=sbx`, `vmgenid=1`, `tags=sbx`, `pool=sandbox`, `name=sbx-<vmid>`, `smbios1` если передан) → `driver.cloneFromTemplate` → `PUT config` (диски + `boot=order=scsi0`) → firewall (`PUT …/firewall/options` §4.4; `POST …/firewall/rules type=group action=sbx-egress iface=net0 enable=1`; при `ipfilter` — ipset `ipfilter-net0` с IP из IPAM, по находкам задачи 3) → `markActive`. При ошибке после POST — `delete(vmid)` и проброс исходной ошибки. Семафор `cloneConcurrency` вокруг create/fork.

- [ ] **Step 1:** тесты: `formatSmbios1({uuid:"u", serial:"sbx1:x"})` = `uuid=u,serial=c2J4MTp4,base64=1`; порядок вызовов create; POST содержит `pool=sandbox`, `vmgenid=1`, MAC из аллокатора, не содержит `smbios1` при отсутствии opts и не содержит ключей вне белого списка (например `sshkeys`, `ciuser` шаблона); fork: POST содержит `hardware` снапшота, но ни `smbios1`, ни `vmgenid` источника (`vmgenid=1`), диски из `cloneFromSnapshot`; падение firewall-шага → вызван delete-путь, строка аллокатора удалена, исходная ошибка проброшена; delete: строка `releasing` до проверки, удалена после; lease остался → `dhcp.release` вызван; IPAM всё ещё с MAC → `TracesRemainError`, строка `releasing`; snapshot без QGA → `QgaUnavailableError`, с `crashConsistent` → проходит без freeze; семафор: 6 параллельных create при лимите 4 → одновременно не больше 4 в фейке.
- [ ] **Step 2:** FAIL → реализация → PASS, typecheck, lint → commit `pve: machine primitives (create, fork, snapshot, delete)`.

### Task 8: `sbx-bench` (`apps/bench`)

**Files:** `apps/bench/{package.json,tsconfig.json}`, `src/main.ts` (`#!/usr/bin/env node`, `parseArgs`), `src/context.ts` (сборка зависимостей из `loadConfig`), `src/preflight.ts`, `src/s1.ts`, `src/checks.ts` (сетевые проверки изнутри VM), `src/cleanup.ts`, `src/world.ts` (diff inventory), `src/stats.ts`, `src/report.ts`, тесты `test/stats.test.ts`, `test/world.test.ts`, `test/report.test.ts`

**Interfaces:**
- Запуск: `mise exec -- node apps/bench/src/main.ts <preflight|s1|cleanup> [flags]`; в `apps/bench/package.json` `"bin": {"sbx-bench": "./src/main.ts"}`.
- `summarize(xs: number[]): {n, median, p95, min, max}` — p95 nearest-rank (`xs[ceil(0.95n)-1]` после сортировки), median для чётного n — среднее двух.
- `diffWorld(before, after): string[]` — человекочитаемые различия; секция `search` не сравнивается.
- `class RamGuard {constructor(api, capMb); assertCanStart(memoryMb)}` — сумма `maxmem` running VM в pool `sandbox` + новая ≤ cap.
- Проверка = `{name, ok, detail}`; любой `ok:false` → итоговый exit 1. Всё, что пишется в JSON и stdout, проходит через `redact()`, которая вырезает тестовые serial/uuid.

- [ ] **Step 1:** тесты `summarize([1,2,3])` = `{n:3, median:2, p95:3, min:1, max:3}`; `summarize([4,1,3,2])` median 2.5, p95 4; `diffWorld` находит изменённый хеш, новую VM в `guests`, новый LV и игнорирует `search`; `redact` убирает serial из вложенного объекта.
- [ ] **Step 2:** FAIL → реализация stats/world/report → PASS.
- [ ] **Step 3:** `preflight` по §7.1: journalReaders пусты; токен: `GET /version`, `/pools/sandbox`, `/cluster/sdn/vnets` (или путь из задачи 3), `/nodes/pve/qemu/599/config`, IPAM; `sbx-node version`; `sbx0` в vnets и `sbx-egress` в группах (через `GET /cluster/firewall/groups`, если токен видит, иначе `inventory hashes`); sysctl `ip_forward=1`, IPv6 forwarding 0; `pool.usage` ниже порогов и `autoextendThreshold=100`; 599 существует и `template=1`; хвосты: VM в pool кроме 599, `lv.list {tags:["sbx"]}` пуст, строки аллокатора (кроме template) и снапшоты пусты.
- [ ] **Step 4:** `s1` по §7.2 (шаги 0–5, флаги §7.1, метрики §7.3, JSON в `bench-results/s1-<ISO>.json` с версией PVE/ядра, storage, шаблоном, размером, `git rev-parse HEAD`, сырыми замерами). Сетевые проверки — `qga.exec` с `bash -c`, по одной проверке на вызов, каждая с ожидаемым результатом; позитивный контроль для изоляции A↔F: внутри F `</dev/tcp/127.0.0.1/22` проходит. IPv6 — по интерфейсу `ifname` из `waitReady`. Где виден serial: config через API (`smbios1` содержит base64 serial), `inventory {sections:["search"], search, since}`; итог `{config, journal, tasklog, qemuCmdline}` в JSON без значения. Параллелизм и clone-only: `Promise.allSettled`, ошибки и повторы (счётчик повторов из `PveApi`) пишутся. Baseline: `POST /nodes/pve/qemu/599/clone {newid, full:0, pool:"sandbox", name}` → тот же config и firewall → delete тем же путём.
- [ ] **Step 5:** `cleanup` по §7.1: VM в pool кроме 599 → `machines.delete`; `lv.list {tags:["sbx"]}` → `lv.remove`; lease наших MAC → `dhcp.release`; строки аллокатора и снапшотов → удалить; итоговая сводка.
- [ ] **Step 6:** typecheck, lint, commit `bench: sbx-bench preflight, s1, cleanup`.

### Task 9: прогон на `pve`, исправления, результаты

- [ ] **Step 1:** `sbx-bench preflight` — все зелёные (права — добавлять только по факту отказа, записывая в §4.1 спецификации и runbook).
- [ ] **Step 2:** `sbx-bench s1 --runs 1 --parallel 1 --no-baseline` до зелёного; затем полный `sbx-bench s1` (дефолты: 3 прогона, 1/2/4, clone-only 8, baseline). Каждый баг — через superpowers:systematic-debugging, тест на баг в соответствующей задаче.
- [ ] **Step 3:** намеренный сбой (`--keep` и прерывание) → `sbx-bench cleanup` → `preflight` без хвостов; diff мира пуст.
- [ ] **Step 4:** ручные проверки §12: lease renewal (правила `iptables-save` для tap-цепочек и/или VM с коротким lease), isolate-ports с fwbr, ipfilter, lease при delete, длина serial.
- [ ] **Step 5:** заполнить §11 спецификации: таблица метрик (median/p95/min/max/n), parallel 1/2/4, clone-only 8, baseline, решения по `ipfilter`, lease, лимиту clone на ноду, где виден serial, предел длины serial, отклонения. Обновить roadmap (S1 — реализовано, ветка `s1-impl`).
- [ ] **Step 6:** superpowers:verification-before-completion: `go test`, `golangci-lint`, `pnpm test`, `pnpm typecheck`, `pnpm lint`, `preflight` зелёный, `setup.sh status` зелёный, гости Ильи в прежнем статусе. Commit, `git push -u origin s1-impl`.

## Находки (заполняется в задаче 3)

Проверено токеном `sbx@pve!poc` на VM 598 (2026-10-29):

- **Права.** Набора §4.1 хватило для create, PUT config с готовым томом, firewall, ipset, start/stop, QGA exec, delete и чтения IPAM (`GET /cluster/sdn/ipams/pve/status`, достаточно `PVESDNUser` на `/sdn/zones/sbx`). Ограничения: `tags` в `POST /qemu` даёт `403 /vms/N VM.Config.Options` в воркере (проверка тегов идёт по `/vms/N` без pool) — `tags=sbx` ставится отдельным `PUT config` вместе с дисками. `vmgenid` задавать может только root; Proxmox сам генерирует новый `vmgenid` и `smbios1.uuid` при create. После удаления VM токен получает `403`, а не `404` (VM вне pool) — отсутствие конфига проверять через `sbx-node inventory vmfiles` и `/cluster/resources`.
- **IPAM.** IP выделяется при `POST /qemu` (до start), MAC → IP по `mac-cache.json`. При delete запись IPAM и mac-cache удаляются.
- **ipfilter.** С `ipfilter=1` и пустым `ipfilter-net0` весь IPv4 гостя, кроме DHCP, дропается. PVE создаёт IPSet `guest-ipam-<vmid>`, но в ipfilter его не подставляет. Рабочая схема: после create прочитать IP из IPAM и записать его в ipset `ipfilter-net0` VM до start. Проверено: DHCP, DNS, HTTPS работают.
- **DHCP lease.** Диапазон `infinite`: lease бессрочный, продление не нужно. Правило `-p udp --sport 68 --dport 67` в `tapN-OUT` стоит до `GROUP-sbx-egress-OUT` (и до ipfilter), ответ `--sport 67 --dport 68` в `tapN-IN` до группы.
- **Lease при delete.** Proxmox не удаляет ни lease (файл dnsmasq), ни строку `MAC,IP` в `/etc/dnsmasq.d/sbx/ethers`: `PVE::Network::SDN::Dhcp::remove_mapping` нигде не вызывается, а `del_ip_mapping` в плагине dnsmasq не реализован. Строки ethers без MAC в mac-cache PVE выкидывает только при следующем `add_ip_mapping` (старт любой VM). Нужен `sbx-node dhcp.release`: `dhcp_release` + удаление строки ethers под `flock` (как PVE) только для MAC, которого нет в mac-cache, и `reload dnsmasq@sbx`.
- **smbios1.** Предел PVE — 512 символов на всю строку (`value may only be 512 characters long`): serial до ~340 байт в сыром виде. Payload S2 — 85 байт (116 base64, 174 символа на строку). 300-байтный serial виден в госте целиком.
- **QGA exec.** Вывод `exec-status` содержит управляющие символы; парсить терпимо к ним.
- **Шаблон 599 (срочная правка по сигналу master).** 9000 — личный dev-шаблон Ильи (Tailscale, ключи, токены, Chrome-профиль, Claude/Codex). Первая сборка 599 загружала его с `tailscaled` (state пустой `{}`, в tailnet не вошёл: новых узлов нет). 599 пересобран офлайн (`infra/pve/template-sanitize.sh`, chroot на хосте, без загрузки). `cloud-init clean --machine-id` в chroot удаляет `/etc/machine-id` — без файла networkd не поднимает DHCP; пишем `uninitialized`.
