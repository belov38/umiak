# S1. Proxmox foundation: спецификация

Статус: согласовано (master-сессия от имени Ильи), 2026-10-29. Реализовано на ветке `s1-impl`, результаты в §11. Архитектура: `docs/architecture.md` (§5 хранилище, §7 сеть, §10 развёртывание). Roadmap: `docs/roadmap.md`. Дополнено MVP-рекомендациями R6 (только запись в §12) (`docs/roadmap-phase2.md` §6, решения master-сессии 2026-10-29).

Пометка **[решение S1]** — решение, принятое в этой сессии без отдельного согласования с Ильёй; его можно пересмотреть при планировании, если найдётся причина.

## 1. Зачем

Это нижний слой платформы: как на Proxmox получить изолированную VM из шаблона, снять снапшот работающей VM, сделать из него fork и бесследно всё удалить. Плюс цифры: сколько это стоит по времени на реальном железе. На этом слое строятся worker (S6), шаблоны (S5) и Windows (S9).

## 2. Цели, не-цели, анти-цели

**Цели**
- Хост `pve` подготовлен для PoC: пользователь и токен с минимальными правами, pool, SDN-сеть sandbox с SNAT и DHCP, firewall.
- Драйвер хранилища `lvmthin` за интерфейсом из architecture §5.
- Примитивы machine: create из шаблона, fork из снапшота, start/stop, delete; свой аллокатор VMID и MAC.
- Исполнитель операций на ноде `sbx-node` (Go).
- Стенд `sbx-bench`: одна команда проверяет всё и печатает замеры.

**Не-цели (другие области)**
- Гостевой агент, смена идентичности внутри гостя (S3). В S1 quiesce делается через QEMU guest agent.
- Протокол туннеля и gateway (S2, S4). Из S2 в S1 приходит только интерфейс SMBIOS (§6.4).
- Машины состояний, warm pool, Postgres (S6).
- Пайплайн сборки шаблонов (S5). Шаблон 599 в S1 собирается вручную по runbook.
- Windows, кроме раскладки дисков (`efidisk0`, `tpmstate0`) в интерфейсе драйвера (S9).
- Демон `sbx-node` с mTLS (позже, тот же интерфейс).

**Анти-цели (провал, даже если всё работает)**
- Любое изменение существующих VM, LXC, `vmbr0`, шаблонов 9000/9001, их LV и сетевого доступа к хосту и гостям.
- Sandbox видит LAN, хост или другую sandbox (по IPv4 или IPv6).
- После delete остаются LV, конфиги, lease-записи или занятые VMID.
- Секреты (токен, SSH-ключ, bootstrap secret из SMBIOS) попадают в репозиторий или в наш state.

## 3. Ограничения

- Хост `pve`: Proxmox VE 9.2.21, один узел, ядро 7.0. LAN `192.168.68.0/24`, хост `192.168.68.116`, Tailscale `100.64.10.2` (`pve.tail0000.ts.net`). На хосте живые VM и LXC Ильи.
- PoC: VMID от 500 (диапазон 500–599, настраивается), RAM всех sandbox вместе не больше 8 GB, хранилище `local-lvm` (VG `pve`, thin pool `data`, QLC-диск Crucial P310).
- Шаблон 9000 (`ubuntu-2604-dev-tpl`) только читается: один thin-снапшот его диска для нашего шаблона 599.
- Инструменты через mise (`mise.toml`): Go 1.27.3, Node 26.13.0, pnpm 12.16.1. Зависимости — последние стабильные версии на момент реализации, проверять (`npm view`, `go list -m -versions`), не брать по памяти.
- В production (`docs/architecture.md` §10) `packages/pve` работает в поде `worker` в Kubernetes: токен PVE и SSH-ключ `sbx-node` приходят из Kubernetes Secret, worker ходит к `:8006` и SSH нод из сети кластера. Поэтому конфиг и секреты задаются через env и пути к файлам; `~/.config/sbx/` — только дефолт для Mac в PoC.

## 4. Подготовка хоста (runbook)

Всё ниже согласовано (Илья дал общее согласие на изменения `pve` для PoC; детали утвердила master-сессия). Выполняется под root через `ssh pve` только после согласования спецификации. Runbook оформляется как идемпотентный скрипт `infra/pve/setup.sh` с режимом `--dry-run` и шагами по отдельности; у каждого шага есть проверка и откат. Запуск runbook — часть реализации и требует явного «да» в треде реализации; перед шагом 4.4 (firewall) исполнитель останавливается и ждёт отдельного подтверждения [решение S1]. Все создаваемые объекты помечены комментарием `boat-dev-clone S1 PoC`.

### 4.1 Пользователь, токен, pool

- Пользователь `sbx@pve` (без пароля), токен `sbx@pve!poc` с `privsep=1`.
- Роль `SbxPoC`: `VM.Allocate`, `VM.Audit`, `VM.Clone`, `VM.Config.CDROM`, `VM.Config.CPU`, `VM.Config.Cloudinit`, `VM.Config.Disk`, `VM.Config.HWType`, `VM.Config.Memory`, `VM.Config.Network`, `VM.Config.Options`, `VM.PowerMgmt`, `VM.GuestAgent.Audit`, `VM.GuestAgent.FileRead`, `VM.GuestAgent.FileWrite`, `VM.GuestAgent.FileSystemMgmt`, `VM.GuestAgent.Unrestricted`, `Pool.Audit`.
- Pool `sandbox`.
- ACL (на пользователя и на токен, так как privsep):
  - `/pool/sandbox` → `SbxPoC`;
  - `/storage/local-lvm` → `PVEDatastoreUser` (`Datastore.AllocateSpace`, `Datastore.Audit`);
  - `/sdn/zones/sbx` → `PVESDNUser` (`SDN.Use`, `SDN.Audit`); если чтение IPAM требует другого пути, добавить `SDN.Audit` на него.
- Список прав окончательно подтверждает `sbx-bench preflight`: каждая операция стенда выполняется токеном, отказ в правах — красная проверка. Добавлять права только по факту отказа и записывать в этот раздел.
- Откат: `pveum user delete sbx@pve`, `pveum role delete SbxPoC`, `pveum pool delete sandbox` (после удаления VM из pool).
- Итог реализации: набора прав выше хватило, дополнительных прав не добавлялось. Ограничения токена: `tags` в `POST /qemu` даёт 403 (проверка тегов по `/vms/N` без pool), поэтому `tags=sbx` ставится вместе с дисками через `PUT config`; `vmgenid` задаёт только root, Proxmox генерирует новый сам; после удаления VM токен получает 403, а не 404.

### 4.2 dnsmasq и IPv4 forwarding

- `apt install dnsmasq`, затем `systemctl disable --now dnsmasq` (системный сервис не нужен; SDN запускает свой экземпляр на зону). Если понадобится `dhcp_release` (§6.3), пакет `dnsmasq-utils` входит в это же согласование.
- `/etc/sysctl.d/90-sbx-poc.conf`:
  ```
  # boat-dev-clone S1 PoC: IPv4 forwarding for SNAT of SDN zone "sbx". Remove this file to revert.
  net.ipv4.ip_forward = 1
  ```
  `sysctl --system`. IPv6 forwarding остаётся 0.
- Откат: удалить файл, `sysctl -w net.ipv4.ip_forward=0`; `apt purge dnsmasq`.

### 4.3 SDN

- Zone `sbx`: type `simple`, IPAM `pve`, DHCP `dnsmasq`.
- VNet `sbx0` в зоне `sbx`, `isolate-ports=1`.
- Subnet `10.88.0.0/24`: gateway `10.88.0.1`, SNAT включён, DHCP range `10.88.0.100–10.88.0.250`, DNS для DHCP `1.1.1.1` (и `9.9.9.9`, если поле принимает список). Если DNS через DHCP не задаётся, VM получает `nameserver` через cloud-init. Sandbox не ходит на хост даже за DNS. IPv6-подсети нет.
- `pvesh set /cluster/sdn` (apply). Проверка: bridge `sbx0` поднят, правило SNAT есть, экземпляр dnsmasq для `sbx` запущен, `vmbr0` не изменился.
- Подсеть `10.88.0.0/24` выбрана, чтобы не пересекаться с LAN, Tailscale `100.64/10` и Docker `172.17/16` [решение S1].
- Откат: удалить subnet, vnet, zone, apply.

### 4.4 Firewall

Backend: обычный `pve-firewall` (iptables). `proxmox-firewall` (nftables) не включаем [решение S1].

`/etc/pve/firewall/cluster.fw` (целевое содержимое):

```
[OPTIONS]
enable: 1
policy_in: ACCEPT
policy_out: ACCEPT

[IPSET sbx-gateway] # boat-dev-clone S1 PoC: allowed tunnel endpoint(s); empty in S1

[IPSET sbx-deny] # boat-dev-clone S1 PoC: private and special ranges
10.0.0.0/8
172.16.0.0/12
192.168.0.0/16
100.64.0.0/10
169.254.0.0/16
224.0.0.0/4

[IPSET sbx-deny-public] # boat-dev-clone S1 PoC: own public egress IPs (hairpin NAT), empty in the PoC

[group sbx-egress] # boat-dev-clone S1 PoC
OUT DROP -dest +sbx-deny-public
OUT ACCEPT -dest +sbx-gateway -p tcp -dport 443
OUT DROP -dest +sbx-deny
# plus: drop all outbound IPv6 (NDP stays allowed by the ndp option)
```

`/etc/pve/nodes/pve/host.fw`:

```
[OPTIONS]
enable: 0
```

Хост не фильтруется. Защита хоста от sandbox делается правилами на NIC самих sandbox (исходящий трафик VM фильтруется до того, как попадает на хост).

Firewall каждой sandbox (через API при create/fork):
- options: `enable=1`, `policy_in=DROP`, `policy_out=ACCEPT`, `dhcp=1`, `ndp=1`, `radv=0`, `macfilter=1`, `ipfilter=1`;
- rules: `GROUP sbx-egress -i net0`.
- `ipfilter` требует, чтобы в `ipfilter-net0` был IP из IPAM (или сгенерированный IPAM IPSet гостя, если PVE его даёт). Если это окажется хрупким, в S1 допустимо оставить только `macfilter`: правила egress фильтруют по адресу назначения, и подмена источника доступа к LAN не даёт. Решение записать в раздел результатов.
- Исходящий IPv6 закрыт целиком (кроме NDP): иначе VM дотянется до link-local адреса хоста на `sbx0`, а sshd хоста слушает `::`. Точная форма правила (IPSet `::/0` или отдельное правило) на усмотрение builder, проверяется стендом.

IPSet `sbx-deny-public` — собственные публичные egress-адреса (защита от hairpin NAT до проброшенных портов и роутера). **В PoC пустой** (решение Ильи, 2026-10-29): платформа работает локально, тесты идут через Tailscale, внешний IP не используется. Заполняется при выходе в прод вместе с выбором кластера (S12).
- Список задаётся конфигом runbook (`SBX_DENY_PUBLIC_IPS`, по умолчанию пустой); обновление IPSet — отдельный шаг runbook.
- Если список не пуст, стенд проверяет изнутри VM, что TCP 22, 80, 443 на каждом его адресе закрыты.
- Если адрес ingress туннеля когда-нибудь совпадёт с адресом из этого списка, нужно точечное исключение до DROP; это решается вместе с S4/S12.

IPSet `sbx-gateway` — место для будущего адреса ingress `tunnel.<domain>:443` в Kubernetes (architecture §10). В S1 он пустой.

Dev control plane (2026-10-30): CT 590 на `pve` с compose-стеком, его LAN-адрес `192.168.68.90` добавлен в `sbx-gateway` шагом `infra/pve/setup.sh cp-gateway` (откат `revert cp-gateway`). Правило группы не менялось: sandbox достаёт до CT только tcp/443. Подробности: `infra/dev-cp/README.md`.

**Безопасное включение (главный выключатель firewall — самое рискованное изменение):**

1. Записать `host.fw` с `enable: 0`. Записать в `cluster.fw` IPSet и группу с `enable: 0`. Проверить синтаксис `pve-firewall compile`.
2. Снять «мир до»: список работающих гостей и их LAN IP (`ip neigh` на хосте по MAC из конфигов гостей).
3. Взвести автоматический откат: `systemd-run --unit=sbx-fw-rollback --on-active=5min pvesh set /cluster/firewall/options --enable 0`.
4. `pvesh set /cluster/firewall/options --enable 1`. Подождать 30 s (цикл обновления `pve-firewall`).
5. Проверить с Mac: `ssh pve true` (Tailscale), `ssh pve-lan true` (LAN), HTTPS `:8006` по обоим адресам, ping каждого работающего гостя по LAN IP из шага 2; на хосте `pve-firewall status` и отсутствие правил на tap/veth существующих гостей.
6. Только если всё зелёное: `systemctl stop sbx-fw-rollback.timer`. Иначе дождаться отката или запустить его сразу.

Ручной откат: `pvesh set /cluster/firewall/options --enable 0`; удалить группу `sbx-egress`, IPSet `sbx-deny-public`, `sbx-deny` и `sbx-gateway`; удалить `host.fw`.

Итог реализации (`infra/pve/setup.sh fw`):
- В `host.fw` добавлено `nf_conntrack_allow_invalid: 1`. После включения firewall `bridge-nf-call-iptables=1`, и весь мостовой трафик `vmbr0` идёт через `PVEFW-FORWARD`, где по умолчанию стоит `ctstate INVALID -j DROP`. Хост по-прежнему не фильтруется; правила sandbox работают как прежде.
- IPv6 закрыт IPSet `sbx-deny6` из `::/1` и `8000::/1` (`ipset hash:net` не принимает `/0`) и правилом `OUT DROP -dest +sbx-deny6` в группе.
- Mac оператора при включении был вне LAN хоста, поэтому проверки шли по Tailscale: `ssh pve`, HTTPS `:8006`, ping 7 гостей по их Tailscale-адресам (их трафик идёт через мост `vmbr0`) и ping 4 гостей с хоста. После переезда Mac в LAN проверены `ssh pve-lan`, HTTPS `:8006` по LAN IP и ping гостей 100, 102, 103, 109 из LAN — всё работает.

### 4.5 SSH-ключ для `sbx-node`

- На Mac отдельный ключ `~/.config/sbx/sbx-node_ed25519`, комментарий `boat-dev-clone S1 sbx-node`.
- На `pve` в `/root/.ssh/authorized_keys`: `restrict,command="/usr/local/bin/sbx-node --stdio" ssh-ed25519 … boat-dev-clone S1 sbx-node` (без pty, без forwarding).
- Клиент закрепляет host key `pve` (свой known_hosts-файл).
- Откат: удалить строку из `authorized_keys`, удалить `/usr/local/bin/sbx-node` и `/etc/sbx-node.toml`.

### 4.6 Шаблон 599 `sbx-ubuntu-poc`

Собирается один раз под root (шаг runbook, не токеном):

1. `lvcreate -s -kn -n vm-599-disk-0 --addtag sbx-tpl pve/base-9000-disk-0`. `qm clone` не используется, чтобы Proxmox не связал 599 с 9000; в dm-thin снимок не зависит от исходного тома.
2. `qm create 599` в pool `sandbox`: железо как у 9000 (q35, `cpu host`, `virtio-scsi-single`, `scsi0` с `discard=on,iothread=1,ssd=1`, `agent=1`, `serial0`, `vga std`), 2 vCPU / 2 GB, `net0` в `sbx0` с firewall, cloud-init диск, `ipconfig0=ip=dhcp`, `cicustom vendor=local:snippets/sbx-tpl-vendor.yaml` (новый snippet ставит и включает `qemu-guest-agent`).
3. Загрузить, дождаться ответа QGA. Внутри: `cloud-init clean --logs --machine-id`, `apt clean`, `fstrim -a`. Выключить.
4. Убрать `cicustom`, `qm template 599`. LV становится `base-599-disk-0`, тег `sbx-tpl` сохраняется.

Тег `sbx-tpl` не равен `sbx`, поэтому `sbx-node` не может удалить LV шаблона. Шаблон 9000 и его LV не изменяются. Откат: `qm destroy 599`, удалить snippet.

**Отклонение при реализации (по сигналу master о безопасности).** 9000 — личный dev-шаблон Ильи (пользователь `ib`, Tailscale, ключи, токены Claude/Codex, профиль Chrome, snapd, docker). Первая сборка 599 по шагам 2–3 загрузила его с `tailscaled` (state был пустой `{}`, узел в tailnet не вошёл, новых узлов в tailnet нет). Поэтому 599 собирается **офлайн, без загрузки** (`infra/pve/setup.sh template` + `infra/pve/template-sanitize.sh`):
1. Thin-снимок `base-9000-disk-0` → `vm-599-disk-0` (тег `sbx-tpl`); корневой раздел подключается на хосте через dm-linear (не loop), чтобы discard доходил до thin LV.
2. В chroot: purge всех пакетов `tailscale*` (`tailscale`, `tailscale-archive-keyring`) и их state; удаление пользователя `ib` с `/home/ib`, его sudoers, `/opt/agent-desktop`, всего в `/root` кроме `.bashrc`/`.profile`, crontab, логов и journal; `cloud-init clean --logs --machine-id --seed`, `/etc/machine-id` = `uninitialized` (в chroot cloud-init удаляет файл, и без него networkd не получает DHCP), удаление SSH host keys; netplan-файл с MAC сборочной VM заменён fallback-файлом `en*` + DHCP; замаскированы `systemd-networkd-wait-online`, `unattended-upgrades`, `apt-daily*.timer`. `qemu-guest-agent` в 9000 уже есть, snippet не нужен.
3. `fstrim` (33.5 GiB), затем обнуление свободных блоков ФС, в которых ещё остались данные (dm-thin освобождает только целые чанки по 64 KiB): 6297 блоков. Проверка: 64 байта из удалённого личного файла (хранятся только на хосте, не печатаются) не находятся на сыром разделе.
4. `qm create 599` без cicustom и с `ciupgrade 0`, диск, firewall, `qm template 599`.

599 — шаблон PoC; S5 заменит его чистой сборкой Ubuntu 26.04 minimal.


### 4.7 Раскладка VMID на `pve`

Решение master-сессии, 2026-10-30:

| VMID | Что |
|---|---|
| 500–589 | sandbox: диапазон аллокатора worker, `sbx-bench` и `deploy/compose` (`SBX_VMID_RANGE`, `vmidMin`/`vmidMax` в topology) |
| 590–596 | dev-инфраструктура, в выдачу не входит; CT 590 — dev control plane (`infra/dev-cp`) |
| 597–599 | шаблоны (`sbx-tpl`, `SBX_TEMPLATE_VMID_RANGE`): Linux (S5) — 597 и 599 (599 пока шаблон PoC), Windows (S9) — 598; слоты задаёт рецепт (`vmids`) |

У `sbx-node` та же раскладка: `vmidMin`/`vmidMax` 500–589 и `templateVmidMin`/`templateVmidMax` 597–599; он клонирует только из томов `base-<слот>-*` с тегом `sbx-tpl`, 590–596 не входят ни в один диапазон. Токен видит только VM своего pool, поэтому гость вне pool внутри диапазона sandbox (как CT 590 до этой раскладки) аллокатору не виден; preflight `sbx-bench` такие случаи ловит.

## 5. Как выполняются операции

| Что | Через что |
|---|---|
| Конфиг VM, start/stop/shutdown, delete, pool | PVE API (токен) |
| QEMU guest agent: ping, exec, `network-get-interfaces`, fsfreeze | PVE API (токен) |
| Firewall VM (options, rules, ipset) | PVE API (токен) |
| IPAM (чтение) | PVE API (токен) |
| `lvcreate -s`, `lvremove`, `lvs`, использование thin pool, lease-файл dnsmasq, инвентаризация хоста | `sbx-node` по SSH |
| Подготовка хоста и шаблон 599 | runbook под root, один раз |

Почему не только PVE API: на LVM-thin Proxmox делает linked clone только из template, а fork из снапшота работающей VM через API — это full clone (копирование всего диска). Почему не `qm clone` и для create: lock-контенция при параллельных клонах и гонка `/cluster/nextid` (research/05 §1.3); стенд сравнивает наш путь с `qm clone` цифрами (§7.3).

### 5.1 `sbx-node` (`services/node-agent`, Go)

- Go-модуль: `go 1.27`, `toolchain go1.27.3`. Бинарь `sbx-node`, `GOOS=linux GOARCH=amd64`, ставится в `/usr/local/bin/sbx-node` шагом runbook.
- Режим `--stdio`: один запрос на SSH-вызов (или несколько exec-каналов поверх одного SSH-соединения): JSON на stdin `{op, args, requestId}`, JSON на stdout `{ok, result | error}`, ненулевой exit code при ошибке. Каждая операция пишется в journal (`requestId`, op, аргументы, результат).
- Конфиг `/etc/sbx-node.toml`: VG (`pve`), thin pool (`data`), диапазон VMID sandbox (`500–589`), слоты шаблонов (`597–599`), VMID шаблона (`599`), имя SDN-зоны (`sbx`).
- Белый список операций:

| op | Что делает | Защита |
|---|---|---|
| `version` | версия бинаря и конфиг | — |
| `lv.snapshot` | пачка `lvcreate -s` (`origin`, `name`, `tags`, `activationSkip`); при ошибке удаляет созданное этим вызовом | origin только `base-<слот шаблона>-*` с тегом `sbx-tpl`, `sbx-snap-*`, `vm-<id в диапазоне>-*`; имя только `vm-<id в диапазоне>-disk-<k>` или `sbx-snap-*` |
| `lv.remove` | `lvremove` по именам | только LV с тегом `sbx` |
| `lv.list` | LV по тегам | только чтение |
| `lv.tagTemplate` (S5) | тег `sbx-tpl` на `base-<vmid>-disk-N` | только слот шаблона, конфиг VM с `template: 1` и тегом `sbx-tpl` |
| `lv.scan`, `lv.usage` (S5) | счёт паттернов на диске, заполнение LV; неактивный LV активируется на время чтения | только `base-<слот>-*` с тегом `sbx-tpl` и `vm-<id в диапазоне>-disk-N` с тегами `sbx`, `sbx-vm-<id>` |
| `pool.usage` | data% и metadata% thin pool, размер и занятость наших LV | только чтение |
| `dhcp.leases` | содержимое lease-файла dnsmasq зоны `sbx` | только чтение |
| `dhcp.release` | освободить lease по MAC (если понадобится, §6.3) | только MAC из диапазона нашего аллокатора |
| `inventory` | наличие заданной строки в journal и task log (только да/нет; сама строка не логируется), `qm list` (без VM в слотах шаблонов 597–599: сборки и шаблоны наши), `pct list`, все LV без тегов `sbx` и `sbx-tpl` и не тома слотов шаблонов (`vm-`/`base-<слот>-…`, во время сборки они ещё без тега) (имя, размер, атрибуты), хеши `/etc/pve/sdn/*`, `cluster.fw`, `host.fw`, `/etc/network/interfaces*`, значения sysctl forwarding, link-local адрес хоста на `sbx0` | только чтение |

- Тесты: unit-тесты на разбор запросов, белый список и защиту по тегам и именам (LVM за интерфейсом, в тестах фейк). Проверка `golangci-lint`.
- Позже тот же код становится демоном с тем же набором операций (S12). LVM сам блокирует метаданные VG, поэтому параллельные вызовы `sbx-node` и операции Proxmox на том же VG безопасны; имена у нас уникальны благодаря аллокатору.

## 6. `packages/pve` (TypeScript)

Пакет используется стендом в PoC и `apps/worker` в S6. Состав: клиент PVE API, клиент `sbx-node`, драйвер `lvmthin`, примитивы machine, аллокатор.

### 6.1 Конфигурация

Всё инжектируется через env и пути к файлам (в Kubernetes — Secret, смонтированный файлами). Дефолты для Mac:

| Переменная | Назначение | Дефолт PoC |
|---|---|---|
| `SBX_PVE_URL` | Proxmox API | `https://pve.tail0000.ts.net:8006` |
| `SBX_PVE_TOKEN_ID` | id токена | `sbx@pve!poc` |
| `SBX_PVE_TOKEN_SECRET_FILE` | секрет токена | `~/.config/sbx/pve-token` (права 600) |
| `SBX_PVE_CA_FILE` | CA хоста (`pve-root-ca.pem`), TLS проверяется | `~/.config/sbx/pve-root-ca.pem` |
| `SBX_PVE_TLS_NAME` | имя, по которому проверяется сертификат `:8006` | `pve` |
| `SBX_NODE_SSH_HOST`, `SBX_NODE_SSH_KEY_FILE`, `SBX_NODE_SSH_KNOWN_HOSTS` | доступ к `sbx-node` | `pve.tail0000.ts.net`, `~/.config/sbx/sbx-node_ed25519`, `~/.config/sbx/known_hosts` |
| `SBX_VMID_RANGE` | диапазон VMID sandbox | `500-589` (раскладка §4.7) |
| `SBX_TEMPLATE_VMID_RANGE` | граница слотов шаблонов (`sbx-tpl`); слоты выбирает рецепт | `597-599` |
| `SBX_CLUSTER_ID` | номер кластера для MAC (1 байт) | `1` |
| `SBX_STATE_DB` | SQLite аллокатора (PoC) | `~/.local/state/sbx/poc.db` |
| `SBX_TEMPLATE_VMID` | шаблон | `599` |

Сертификат `pveproxy` выдан CA хоста на `pve`, `pve.local`, `192.168.68.116`, имени `*.ts.net` в нём нет. Поэтому клиент подключается по `SBX_PVE_URL`, а сертификат проверяет по `SBX_PVE_CA_FILE` и имени `SBX_PVE_TLS_NAME` (SNI и проверка имени). Сертификат на хосте не меняется [решение S1]. Тот же механизм подходит worker в Kubernetes, каким бы путём он ни ходил к `:8006`.

Библиотеки (HTTP-клиент, SSH-клиент, тестовый фреймворк) выбирает builder; версии — последние стабильные на момент реализации.

### 6.2 Драйвер хранилища

Интерфейс из architecture §5, второй драйвер (ZFS, Ceph) позже по нему же:

```ts
interface StorageDriver {
  cloneFromTemplate(tpl: TemplateRef, target: VmTarget): Promise<DiskSet>
  snapshot(m: MachineRef, hook: QuiesceHook): Promise<SnapshotRef>
  cloneFromSnapshot(s: SnapshotRef, target: VmTarget): Promise<DiskSet>
  delete(ref: MachineDisksRef | SnapshotRef): Promise<void>
  usage(node: NodeRef): Promise<StorageUsage>
}

interface QuiesceHook {
  freeze(): Promise<void>
  thaw(): Promise<void>
}
```

- `DiskSet`: слоты `scsi0`, `efidisk0`, `tpmstate0` (последние два для Windows; в S1 проверяется только `scsi0`) с volid, размером и опциями диска (`discard`, `iothread`, `ssd`, `efitype`, `version` и т.п.). Cloud-init диск в `DiskSet` не входит: Proxmox создаёт его на каждую VM.
- **`cloneFromTemplate`**: для каждого диска шаблона `lvcreate -s -kn -n vm-<vmid>-disk-<k> --addtag sbx --addtag sbx-vm-<vmid> pve/base-599-disk-<k>`. Имя `vm-N-…` — чтобы Proxmox считал том принадлежащим VM N (права, purge).
- **`snapshot`** работающей machine:
  1. `hook.freeze()` (в S1: `agent/fsfreeze-freeze` через PVE API).
  2. Если дисков больше одного: пауза vCPU (`status/suspend` без `todisk`) для согласованности всех дисков.
  3. Один вызов `sbx-node lv.snapshot`: `lvcreate -s -ky -n sbx-snap-<snapId>-<slot> --addtag sbx --addtag sbx-snap-<snapId>` для всех дисков.
  4. `status/resume`, если была пауза. `hook.thaw()` в `finally`, с повторами.
  - Бюджет заморозки 10 s: если превышен, снапшот отменяется, созданные LV удаляются, ошибка. Если `thaw` не удался после повторов, machine помечается «требует внимания» (ошибка вызывающему, в PoC — красная проверка).
  - Без ответа QGA снапшот запрещён (ошибка), режим crash-consistent только явным флагом.
  - Для остановленной machine freeze и пауза пропускаются.
  - Метаданные снапшота: id, VM-источник, слоты с именами LV и опциями дисков, конфиг железа источника (без `smbios1`, `vmgenid`, `net0` MAC, `name`). Хранятся в нашем state; ключевые поля дублируются тегами LV, чтобы `cleanup` находил снапшоты без state.
  - Имена `sbx-snap-*` Proxmox не распознаёт и игнорирует.
- **`cloneFromSnapshot`**: `lvcreate -s -kn -n vm-<new>-disk-<k> --addtag sbx --addtag sbx-vm-<new>` из `sbx-snap-*`. В dm-thin снимки независимы: оригинал и снапшот удаляются в любом порядке.
- **`delete`**: `lvremove` по тегу `sbx-vm-N` или `sbx-snap-<id>`.
- **`usage`**: data% и metadata% pool, объём наших LV. Create и snapshot запрещены при data > 80% или metadata > 70% [решение S1]; автоматическое расширение pool на хосте выключено (`thin_pool_autoextend_threshold=100`).

### 6.3 Примитивы machine

- **create(template, size, opts)**:
  1. Выделить VMID и MAC (§6.5).
  2. `POST /nodes/pve/qemu` без дисков: `vmid`, `pool=sandbox`, `name=sbx-<vmid>`, `tags=sbx`; железо копируется из конфига шаблона по белому списку ключей (`machine`, `cpu`, `bios`, `ostype`, `scsihw`, `agent`, `serial0`, `vga`, `tablet`); размер по умолчанию 2 vCPU / 2 GB, `balloon=0`; `net0=virtio=<MAC>,bridge=sbx0,firewall=1`; `ide2=local-lvm:cloudinit`, `ipconfig0=ip=dhcp`, `ciuser=sbx` без ключей и пароля (в S1 доступ к гостю только через QGA); `ciupgrade=0` (дефолт Proxmox 1: cloud-init делает `apt upgrade` при первой загрузке и через ~2 минуты перезапускает `qemu-guest-agent`, который забывает PID запущенных exec); `vmgenid` новый; `smbios1` от вызывающего или новый от Proxmox (§6.4).
  3. `driver.cloneFromTemplate`.
  4. `PUT config`: подключить диски с опциями, `boot=order=scsi0`.
  5. Firewall: options и `GROUP sbx-egress` (§4.4).

  Порядок «сначала VM в pool, потом диски» обходит проблему прав: к моменту подключения тома VM уже в pool, и токен имеет `VM.Config.Disk` на неё.
- **fork(snapshot, size?, opts)**: тот же путь, диски из `cloneFromSnapshot`, железо из метаданных снапшота. Новые VMID, MAC, `vmgenid`; `smbios1` от вызывающего или новый. Из снапшота и VM-источника `smbios1` и `vmgenid` не копируются никогда.
- **start / shutdown(timeout) / stop** — через API, ожидание задачи по UPID.
- **waitReady(timeout)** — опрос `agent/ping`; IP из `agent/network-get-interfaces` (IPv4 в `10.88.0.0/24`).
- **delete(vmid)**:
  1. `status/stop` (жёсткий, sandbox одноразовая).
  2. `sbx-node dhcp.release` — до destroy, пока IP, строка ethers и lease ещё принадлежат этой VM: после destroy IP в IPAM свободен, его может занять новая VM, и dnsmasq переносит lease на её MAC.
  3. `DELETE /nodes/pve/qemu/<vmid>?purge=1&destroy-unreferenced-disks=1`, ожидание задачи.
  4. `sbx-node lv.remove` оставшихся LV с тегом `sbx-vm-<vmid>`.
  5. Проверка: конфига нет (404), firewall-файла VM нет, в IPAM нет записи с MAC, в lease-файле нет MAC; повторный `dhcp.release` удаляет строку ethers (MAC уже нет в `mac-cache.json`).
  6. Освободить VMID и MAC в аллокаторе. Только после успешной проверки; иначе запись остаётся в состоянии `releasing` и её добирает `cleanup`.
- **Проверка владельца** (дополнение S6, 2026-10-30). `start`, `stop`, `shutdown` и `delete` принимают необязательный `expectedOwner` (id владельца lease, в S6 `machineId`; у `delete` ещё `null` — VM без lease). Прямо перед действием читается lease VMID: если он не этого владельца (у `start` ещё и если он `releasing`), бросается `OwnerMismatchError` (код `owner_mismatch`, повтор не поможет) и Proxmox не трогается; delete, у которого нет ни lease владельца, ни VM, ничего не делает. Delete VMID без lease (VM-сирота) перед шагом 1 занимает VMID строкой `releasing` без владельца (`reserveForDelete`), чтобы create не взял его посреди delete; шаг 6 удаляет только строку `releasing` своего владельца (`null` для такого резерва). Без `expectedOwner` поведение прежнее. Откат create/fork выполняется под обёрткой `powerLock`, если её передал вызывающий (S6 сериализует под ней питание ноды, S6 §15.1).
- Лимит параллельных clone на ноду настраивается (дефолт 4) [решение S1]; стенд даёт данные для выбора.

### 6.4 SMBIOS (интерфейс для S2)

- `create` и `fork` принимают `smbios1` от вызывающего: минимум `uuid` и `serial`. Serial несёт base64 `machineId` и bootstrap secret, пишется с `base64=1`. Если ничего не передано, Proxmox генерирует значения.
- Идентичность machine одноразовая: VMID можно выдать снова после проверенного delete, но `smbios1` и `vmgenid` — никогда. Fork всегда получает новую идентичность.
- `smbios1` не попадает ни в метаданные снапшота, ни в state аллокатора, ни в наши логи и JSON стенда.
- Формат задаёт S2 (`docs/specs/s2-tunnel-protocol.md` §5.2): `smbios1: uuid=<machineId>,serial=<base64("sbx1:" + machineId + ":" + base64url(BS))>,base64=1`. Bootstrap secret (BS) многоразовый: действует всё время жизни machine, потому что machine token живёт только в памяти агента, и после каждого перезапуска агента или VM агент снова предъявляет BS.
- Proxmox сам пишет параметры изменения конфига в journal хоста (`pvedaemon: <user> update VM N: -memory …`, проверено на `pve`), а конфиг VM `/etc/pve/qemu-server/N.conf` читается любым, у кого есть `VM.Audit`. Значит, BS виден в journal и конфиге. Это принято (вариант A): входит в уже принятое Ильёй допущение «операторы Proxmox видят BS», у journal та же аудитория. Меры:
  - `VM.Audit` на pool `sandbox` есть только у токена платформы и root;
  - journal ноды читают только root и группа `adm` (проверяется в `preflight`);
  - стенд фиксирует, где виден serial (конфиг, journal, task log), и пишет это в §11.
- Ограничение длины serial в Proxmox/QEMU проверяет стенд (тестовое значение размером с реальный payload S2: base64 от machineId + 32 байта секрета).

### 6.5 Аллокатор VMID и MAC

- State за интерфейсом `AllocatorStore`. В PoC SQLite через встроенный `node:sqlite` (файл `SBX_STATE_DB`), в S6 Postgres.
- Таблица `vmid_lease`: `cluster`, `vmid`, `mac`, `state` (`reserved` / `active` / `releasing`), `purpose` (machine, template), `created_at`, `updated_at`. Уникальность `(cluster, vmid)` и `(cluster, mac)`.
- Выделение: наименьший VMID из `SBX_VMID_RANGE`, которого нет в таблице, в `/cluster/resources` (видны только VM pool, этого достаточно для нашего диапазона) и среди LV `vm-<id>-*` (`sbx-node lv.list`/`inventory`). Вставка строки и есть блокировка: при конфликте уникальности берётся следующий. `/cluster/nextid` не используется.
- MAC детерминированный: `02:<cluster>:<vmid, 4 байта big-endian>`, например `02:01:00:00:01:F4` для кластера 1 и VMID 500. Локально администрируемый unicast, уникален в пределах кластера; L2 у нас локальная для ноды, этого достаточно.
- VMID 599 занят шаблоном (`purpose=template`), в выдачу не входит. Шаблоны S5 получают VMID через `allocateTemplate(<vmids рецепта>)` — первый свободный слот рецепта внутри `SBX_TEMPLATE_VMID_RANGE` (597–599), вне диапазона sandbox (§4.7); `SBX_TEMPLATE_VMID` не выдаётся.

## 7. Стенд `sbx-bench` (`apps/bench`, TypeScript)

Запускается с Mac через Tailscale. Использует `packages/pve`.

### 7.1 Команды

- `sbx-bench preflight` — только чтение: journal ноды не читается никем, кроме root и `adm`; токен отвечает и имеет права на каждую операцию стенда (проверяется на «пустых» вызовах, где это возможно), `sbx-node version`, `sbx0` и группы firewall на месте, `ip_forward=1`, IPv6 forwarding 0, thin pool ниже порогов, шаблон 599 существует и является template, нет хвостов прошлых прогонов (VM в pool кроме 599, LV с тегом `sbx`, строки аллокатора).
- `sbx-bench s1 [--runs 3] [--size 2g] [--parallel 1,2,4] [--clone-only 8] [--ram-cap 8g] [--no-baseline] [--keep]` — полный прогон. Таблица в stdout, JSON в `bench-results/s1-<timestamp>.json` (каталог в `.gitignore`).
- `sbx-bench cleanup` — уборка после сбоя: VM в pool `sandbox` кроме 599, LV с тегом `sbx`, строки аллокатора, lease-записи наших MAC. Шаблон 599 и LV с тегом `sbx-tpl` не трогает.

### 7.2 Сценарий `s1`

0. `preflight`. «Мир до»: `sbx-node inventory`.
1. Повторить N раз (`--runs`, дефолт 3):
   1. **Create A** с тестовым `smbios1` (случайный uuid, serial размером с payload S2). Start, `waitReady`, IP.
   2. **Сеть изнутри A** (QGA exec; TCP-проверки через `timeout 3 bash -c '</dev/tcp/<ip>/<port>'`, ping `-c1 -W2`):
      - работает: `getent hosts example.com`; `curl -fsS --max-time 10 https://example.com`;
      - не отвечает: ping и TCP 80 `192.168.68.1`; TCP 22, 80, 443 каждого адреса из `sbx-deny-public` (если список не пуст); TCP `192.168.68.116:22`, `:8006`; TCP `100.64.10.2:22`, `:8006`; TCP `10.88.0.1:22`, `:8006`, `:53`;
      - IPv6: нет глобального адреса, нет IPv6 default route; ping6 и TCP `:22` на link-local адрес хоста на `sbx0` (из `inventory`) не проходят;
      - `/sys/class/dmi/id/product_serial` и `product_uuid` совпадают с переданными.
   3. Записать `/root/marker1` (случайное содержимое), `sync`. **Snapshot** A. Записать `/root/marker2`.
   4. **Fork F** из снапшота (свой тестовый `smbios1`). Start, `waitReady`.
   5. **Проверки F**: `marker1` есть и совпадает по содержимому, `marker2` нет; VMID, MAC, `vmgenid`, `smbios1` uuid и serial отличаются от A (по конфигу и изнутри гостя); IP A и F разные; A ↔ F: ping и TCP `:22` не проходят в обе стороны.
   6. **Delete** A, F и снапшота. Проверка отсутствия следов (§6.3 delete, плюс LV `sbx-snap-<id>`).
2. **Параллелизм**: для k из `--parallel` (дефолт 1, 2, 4) k одновременных `create → start → waitReady`, затем delete всех. По умолчанию 4 × 2 GB = ровно лимит.
3. **`--clone-only 8`**: 8 одновременных create без start (RAM не тратится), затем delete. Цель — конкуренция за блокировки LVM и pmxcfs; ошибки и повторы записываются.
4. **Базовая линия** (выключается `--no-baseline`): create через `POST /qemu/599/clone` (`full=0`, `pool=sandbox`, тот же VMID из аллокатора), затем тот же config и firewall; N раз, плюс параллельно k=4 без start. Delete тем же путём.
5. «Мир после»: `sbx-node inventory`, сравнение с «миром до». Разница должна быть пустой.

Где виден serial: после create стенд ищет тестовый serial в конфиге VM (через API), в journal хоста и в task log (через `sbx-node inventory`, только факт найден/не найден, без вывода значения) и пишет итог в JSON и §11.

Защиты: перед каждым start сумма `memory` запущенных VM в pool плюс новая VM ≤ `--ram-cap`, иначе отказ. При любой красной проверке стенд всё равно убирает за собой (если не `--keep`) и выходит с ненулевым кодом.

### 7.3 Метрики

Для каждой: median, p95 (nearest-rank), min, max, число замеров. При N=3 p95 равен max; в отчёте это отмечено.

| Метрика | Что измеряется |
|---|---|
| `clone` | от вызова allocate до VM, готовой к старту (диски подключены, firewall настроен) |
| `clone_baseline` | то же через `qm clone` (API clone) |
| `boot` | от вызова start до первого успешного `agent/ping` |
| `ip` | от вызова start до IPv4 в `10.88.0.0/24` в `network-get-interfaces` |
| `snapshot` | весь snapshot |
| `freeze` | от начала freeze до конца thaw |
| `fork_clone` | от вызова fork до VM, готовой к старту |
| `fork` | от вызова fork до первого `agent/ping` в fork |
| `delete` | от вызова delete до успешной проверки отсутствия следов |
| `parallel_k` | для каждого k: общее время, время каждой VM, ошибки |
| `clone_only_8` | общее время, время каждого create, ошибки и повторы |

JSON содержит также: версию Proxmox и ядра, storage, VMID шаблона, размер VM, git-коммит, время запуска и все сырые замеры.

## 8. Структура кода

```
services/node-agent/      Go, sbx-node (go.mod: go 1.27, toolchain go1.27.3)
packages/pve/             TS: PVE client, sbx-node client, lvmthin driver, machine primitives, allocator
apps/bench/               TS: sbx-bench CLI
infra/pve/setup.sh        runbook (idempotent, --dry-run, step-by-step, revert per step)
infra/pve/snippets/       sbx-tpl-vendor.yaml
```

Тесты: unit для `sbx-node` (белый список, защита); unit для `packages/pve` с фейковыми PVE API и `sbx-node` (порядок вызовов create/fork/delete, откат snapshot при превышении бюджета, `thaw` в `finally`, аллокатор при конфликтах, fork не копирует `smbios1`/`vmgenid`). Интеграционный тест — сам стенд на `pve`.

## 9. Критерий готовности

`sbx-bench s1` на `pve` проходит все проверки:
1. Create из шаблона 599: VMID ≥ 500 на `local-lvm` в `sbx0`, IP по DHCP; изнутри VM работают DNS и HTTPS, а `192.168.68.1`, хост (LAN, Tailscale, адрес на `sbx0`, порты управления), IPv6-путь к хосту и другая sandbox недоступны.
2. Snapshot работающей VM с quiesce через QGA fsfreeze и fork: у fork новые VMID, MAC, `vmgenid`, SMBIOS; fork загружается; `marker1` есть, `marker2` нет.
3. Delete оригинала, fork и снапшота не оставляет следов: конфигов VM, thin LV, записей IPAM и lease, строк аллокатора. Стенд проверяет это сам.
4. Замеры: clone, boot, snapshot (с freeze), fork, delete — N раз (дефолт 3), median и p95; параллельный запуск 1/2/4 в пределах 8 GB; `--clone-only 8`; базовая линия `qm clone`.
5. Сравнение «мира до» и «мира после» (`qm list`, `pct list`, LV вне нашего pool, конфиги SDN/firewall/сети) пустое.

Цифры записываются в §11.

## 10. Допущения о других областях

- **S2 (туннель):** агент аутентифицируется по `smbios1` serial (формат S2 §5.2, BS многоразовый на всё время жизни machine). IPSet `sbx-gateway` получит адрес ingress `tunnel.<domain>:443`.
- **S3 (guest agent):** даёт свою реализацию `QuiesceHook` (Docker pause, fsfreeze, watchdog авто-разморозки) вместо QGA fsfreeze. Смена идентичности после fork (hostname, machine-id, SSH host keys) — его работа; в S1 fork сохраняет machine-id источника.
- **S5 (шаблоны):** пайплайн сборки заменит ручной шаблон 599; шаблон должен содержать qemu-guest-agent и очищенный machine-id.
- **S6 (worker):** использует `packages/pve` как есть, подставляет Postgres-реализацию `AllocatorStore`, управляет лимитами параллелизма на ноду. Секреты из Kubernetes Secret через те же переменные (§6.1).
- **S9 (Windows):** слоты `efidisk0` и `tpmstate0` уже в `DiskSet`, пауза vCPU для согласованности нескольких дисков уже в `snapshot`. VSS через свой `QuiesceHook`. Согласованность записи swtpm в `tpmstate0` при снапшоте проверить там.
- **S12 (эксплуатация):** `sbx-node` как демон с mTLS, несколько нод.

## 11. Результаты

Прогон `sbx-bench s1` (дефолты: 3 прогона, 2 vCPU / 2 GB, параллельно 1/2/4, `--clone-only 8`, базовая линия) 2026-10-29 04:41–04:47 UTC, коммит `ef2809c`. Proxmox VE 9.2.21, ядро 7.0.14-25-pve, `local-lvm` (VG `pve`, thin pool `data`, чанк 64 KiB, Crucial P310 QLC), шаблон 599 (офлайн-очищенный снимок 9000, см. §4.6). **126/126 проверок зелёные**, сравнение «мира до» и «мира после» пустое. JSON: `bench-results/s1-2026-10-29T04-41-38-016Z.json` (не в git).

### Метрики, секунды

p95 считается по nearest-rank; при n = 3 он равен max.

| Метрика | n | median | p95 | min | max |
|---|---|---|---|---|---|
| `clone` (allocate → готова к старту) | 3 | 1.27 | 1.45 | 1.25 | 1.45 |
| `clone_baseline` (`POST /qemu/599/clone`, тот же config и firewall) | 3 | 1.32 | 1.32 | 1.28 | 1.32 |
| `boot` (start → первый `agent/ping`) | 3 | 11.04 | 11.14 | 10.99 | 11.14 |
| `ip` (start → IPv4 в `10.88.0.0/24`) | 3 | 11.24 | 11.34 | 11.10 | 11.34 |
| `snapshot` (весь, с QGA fsfreeze) | 3 | 1.08 | 1.08 | 0.98 | 1.08 |
| `freeze` (начало freeze → конец thaw) | 3 | 0.69 | 0.69 | 0.68 | 0.69 |
| `fork_clone` (fork → готова к старту) | 3 | 1.20 | 1.47 | 1.16 | 1.47 |
| `fork` (fork → первый `agent/ping`) | 3 | 11.74 | 12.50 | 11.33 | 12.50 |
| `delete` (до проверки отсутствия следов) | 6 | 1.95 | 1.98 | 1.94 | 1.98 |

`clone` ~1.3 s складывается из `POST /qemu` с ожиданием задачи, `lvcreate -s` через `sbx-node`, `PUT config`, firewall (options, rule, ipset) и чтения IPAM. Загрузка ~11 s — это Ubuntu-шаблон с первым запуском cloud-init; QGA отвечает раньше, чем завершается `cloud-final`.

### Параллелизм и конкуренция

| Пакет | Всего, s | На VM: median / max, s | Ошибки | Повторы API |
|---|---|---|---|---|
| k = 1, create → start → ready | 12.63 | 12.63 / 12.63 | 0 | 0 |
| k = 2 | 14.32 | 14.07 / 14.32 | 0 | 0 |
| k = 4 (4 × 2 GB = лимит 8 GB) | 15.89 | 15.46 / 15.89 | 0 | 0 |
| `--clone-only 8` (без start) | 3.00 | 2.25 / 3.00 | 0 | 0 |
| базовая линия `qm clone`, k = 4 без start | 2.44 | 2.06 / 2.44 | 0 | 0 |

- 8 одновременных create не дали ни одной ошибки и ни одного повтора из-за блокировок (`can't lock file`): LVM сериализует свои метаданные, наши имена уникальны, `/cluster/nextid` не используется. Время одного create растёт с 1.3 s до 2.2–3.0 s.
- **Дефолт лимита параллельных clone на ноду оставлен 4** [решение S1 подтверждено]: при 4 загрузка одной VM растёт на ~25% (12.6 → 15.5 s), при 8 одновременных clone без загрузки конкуренции за блокировки нет. Стенд сам лимит не применяет, чтобы мерить конкуренцию.
- **Сравнение с `qm clone`:** на этой версии Proxmox linked clone через API почти так же быстр (1.32 s против 1.27 s) и без ошибок при k = 4. Наш путь нужен не ради скорости clone, а ради fork: из снапшота работающей VM API делает только full clone, а `cloneFromSnapshot` занимает 1.2 s. Конкуренцию `qm clone` при k = 8 стенд не мерил.

### Решения по пунктам «проверить при реализации» (§12)

- **`ipfilter`: оставлен включённым.** С `ipfilter=1` и пустым `ipfilter-net0` весь IPv4 гостя, кроме DHCP, дропается; PVE создаёт IPSet `guest-ipam-<vmid>`, но в ipfilter его не подставляет. IP выдаётся IPAM уже при `POST /qemu`, поэтому create после firewall-опций читает IP из IPAM и кладёт его в ipset `ipfilter-net0` до start. Стенд проверяет DNS и HTTPS из A и F.
- **Lease при delete.** Proxmox не удаляет ни lease в файле dnsmasq, ни строку `MAC,IP` в `/etc/dnsmasq.d/sbx/ethers`: `PVE::Network::SDN::Dhcp::remove_mapping` нигде не вызывается, а `del_ip_mapping` в плагине dnsmasq не реализован. Строки без MAC в IPAM PVE выбрасывает только при следующем старте любой VM. Поэтому delete вызывает `sbx-node dhcp.release` до destroy и ещё раз при проверке после него: `dhcp_release` и удаление строки ethers под `flock` (как PVE), только для нашего MAC и только если его уже нет в `mac-cache.json`, затем `reload dnsmasq@sbx`. IPAM и mac-cache Proxmox чистит сам.
- **Продление lease через firewall.** Диапазон subnet создаётся как `infinite`: lease бессрочный, продления нет. Кроме того, в `tapN-OUT` правило `-p udp --sport 68 --dport 67` стоит до ipfilter и до `GROUP-sbx-egress-OUT`, ответ `--sport 67 --dport 68` в `tapN-IN` — до группы. Опция `dhcp=1` так же пропускает DHCPv6-клиента (546 → 547); IPv6-диапазона у dnsmasq нет.
- **`isolate-ports` с firewall-bridge.** У порта `fwprNp0` в `sbx0` стоит `isolated on`. Стенд проверяет ping и TCP 22 A ↔ F в обе стороны с позитивным контролем (sshd слушает локально в A и F).
- **Разные IP у A и F:** да, IPAM привязывает IP к MAC (проверка в каждом прогоне).
- **Длина `smbios1`.** Предел PVE — 512 символов на всю строку (`value may only be 512 characters long`), то есть serial до ~340 байт в сыром виде. Payload S2 — 85 байт (116 base64, 174 символа на строку). Serial в 300 байт виден в госте целиком.
- **Где виден serial** (тестовое значение размером с payload S2; ищется base64 и сырой вид): конфиг VM через API — да; journal хоста — нет (serial передаётся в `POST /qemu`, а pvedaemon пишет параметры только для `update VM`); task log — нет; **командная строка QEMU — да**, в сыром виде (`/proc/<pid>/cmdline` на хосте читается любым локальным пользователем). Это та же аудитория «операторы хоста», что принята в §6.4; на хосте нет непривилегированных пользователей с login shell (проверено). Для production (S12) это стоит учесть.
- **Журнал ноды** читают только root и `adm` (группы `adm`, `systemd-journal`, `wheel` пусты; проверяется в preflight).

### Шаблон 599 и Tailscale

См. §4.6: 599 собран офлайн из очищенного снимка 9000 (Tailscale удалён, пользователь `ib` и его данные удалены, освобождённые блоки отброшены и проверены на сыром разделе). Стенд в каждой sandbox проверяет, что нет процесса `tailscaled` и интерфейса `tailscale0`. 599 — шаблон PoC; S5 заменяет его чистой сборкой Ubuntu 26.04 minimal.

### Отклонения от спецификации

- Runbook выполнен без остановки перед firewall: master передал согласие Ильи на весь runbook (§4). Процедура безопасного включения соблюдена; при регрессии скрипт сразу выключает firewall, таймер остаётся страховкой.
- §4.2: применяется `sysctl -p` только своего файла, а не `sysctl --system` (чтобы не переприменять чужие значения). `dnsmasq-utils` ставится сразу (нужен `dhcp_release`).
- §4.3: SDN apply (`ifreload -a`) сбросил `mcast_hash_max` у `vmbr0` с 4096 до 512 (дефолт ifupdown2). Значение возвращено, шаг `sdn` сохраняет и восстанавливает его.
- §4.4: `nf_conntrack_allow_invalid: 1` в `host.fw`; IPv6 закрыт через `::/1` + `8000::/1`.
- §4.6: шаблон собирается офлайн, без загрузки и без snippet.
- §5.1: `dhcp.release` удаляет и строку ethers; `inventory search` принимает только строку формы serial S2 (иначе restricted-ключ стал бы оракулом по journal, task log и cmdline); `lv.snapshot` принимает `vm-*` как origin только с тегами `sbx` и `sbx-vm-N`; секция `lvs` в inventory не включает LV с тегом `sbx-tpl` (наш шаблон), JSON-файлы PVE хешируются в каноническом виде (Proxmox пишет их со случайным порядком ключей).
- §6.3: `tags=sbx` ставится через `PUT config`, `vmgenid` не передаётся (Proxmox генерирует сам); при любой ошибке create откатывается через delete.
- §7.2: базовая линия реализована в пакете (`Machines.createViaQmClone`), чтобы использовать тот же firewall-шаг.

## 12. Риски и что проверить при реализации

- Удаляет ли Proxmox lease dnsmasq при удалении VM (иначе `dhcp.release`).
- Продление DHCP lease через firewall sandbox (`dhcp=1` должен стоять раньше DROP на RFC1918). Прогон короче половины срока lease, поэтому стенд это не ловит: проверить вручную на одной VM с коротким сроком lease или по правилам iptables.
- `isolate-ports` вместе с firewall-bridge (`fwbr`/`fwpr`) у VM с `firewall=1`. Изоляция A ↔ F продублирована DROP на `10.0.0.0/8`, стенд проверяет итог.
- `ipfilter` с адресом из DHCP/IPAM (§4.4).
- Разные IP у A и F при одинаковом machine-id (DHCP client-id). Ожидается, что да: IPAM привязывает IP к MAC. Стенд проверяет.
- QLC-диск `local-lvm` занижает цифры при долгой записи; для функционального PoC нормально, в отчёте указать storage.
- Длина `smbios1` serial.
- Исходящий трафик sandbox выходит в интернет с домашнего публичного IP Ильи. Для PoC это принято; политика egress для production — в S12/фазе 2.
- **Запись ethers при параллельных start (риск для S6).** Proxmox (`PVE::Network::SDN::Dhcp::Dnsmasq::add_ip_mapping`) берёт `flock` на сам файл `ethers`, пишет `ethers.tmp` и делает `rename` поверх. Ожидающий writer может получить lock на уже заменённом inode, и тогда два writer работают одновременно: в эмуляции с двумя конкурентными writer Proxmox терялось ~47% добавлений. `mac-cache.json` читается вне lock. Потерянная статическая привязка даёт VM динамический IP не из IPAM, и `ipfilter` её блокирует. `sbx-node` проверяет inode перед своим `rename` и своё изменение после него (`hostfs.ReplaceLocked`), но запись Proxmox, попавшая между проверкой и нашим `rename`, теряется. **S6 сериализует start и delete на ноде** (как минимум шаги, которые пишут ethers). Порядок delete: stop → `dhcp.release` → destroy → проверка следов; release идёт до destroy, пока IP ещё принадлежит VM.
- **`cpu host` и вложенный KVM** (MVP-рек. R6, решение master 2026-10-29). Вложенная виртуализация в MVP не гарантируется: `/dev/kvm` в госте есть, только если на хосте `kvm_intel`/`kvm_amd` загружен с `nested=1` (проверить на `pve`: `cat /sys/module/kvm_*/parameters/nested`); runbook и код S1 это не меняют, шаблон S5 только даёт доступ (S5 §8.6, §10 п. 19). `cpu host` остаётся, пока нода одна. Живая миграция между нодами с разными CPU с `cpu host` невозможна: для такого кластера нужна именованная модель CPU (например, `x86-64-v3`) в шаблоне — решение S12 / фазы 2.
