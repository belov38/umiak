# S5. Шаблон Linux: спецификация

Статус: согласовано (master-сессия), 2026-10-29; ревью исполнителем пройдено, замечания внесены. Дополнено MVP-рекомендациями R5, R6 (`docs/roadmap-phase2.md` §6, решения master-сессии 2026-10-29). Область S5 из `docs/roadmap.md`. Архитектура: `docs/architecture.md` (§4 агент, §5 хранилище, §6 warm pool). Опирается на `docs/specs/s1-proxmox-foundation.md` (примитивы, `packages/pve`, `sbx-bench`), `docs/specs/s3-guest-agent.md` (§7.3 `seal`, §17 пакет, §20 требования к шаблону), `docs/specs/s6-control-plane.md` (§5.2 `template_builds`, §9 warm pool, §14.3 регистрация), `docs/specs/s2-tunnel-protocol.md` (§5.2 smbios, §5.4 TLS).

Решения в разделах 1–4 вопросов согласованы с master-сессией 2026-10-29. Пометка **[S5]** — решение автора спеки в рамках согласованного; его можно менять без нового согласования, если причина записана.

## 1. Зачем и что считается успехом

Шаблон `linux` — диск, из которого S1 делает thin-клон для каждой machine. От него зависят время пополнения warm pool и холодного старта, корректность идентичности fork (S3), безопасность (никаких чужих сервисов и ключей в образе) и то, что агенту и пользователю есть чем работать.

Успех:
1. Одна команда с Mac собирает шаблон из официального образа Ubuntu, проверяет его клоном и регистрирует. Человек внутри VM ничего не делает.
2. Сборка повторяема: тот же рецепт, `versions.toml`, номер базового образа и снапшот apt дают тот же набор пакетов и версий инструментов.
3. Новая сборка выкатывается в warm pool без простоя и откатывается повторным `promote`; sandbox и saved snapshots на старых сборках не затрагиваются.
4. Загрузка клона на `pve`: медиана от start до ответа QEMU guest agent ≤ 8 s, до готовности агента ≤ 10 s (`sbx-bench s5`, сравнение с 599).
5. Пайплайн тот же для `linux-desktop` (S10) и Windows (S9): меняются рецепт, источник и способ запечатывания, а не сборщик.

## 2. Цели, не-цели, анти-цели

**Цели:** рецепт `linux` v1 и его содержимое; сборщик `sbx-tpl` (TS, поверх `packages/pve`); проверка сборки; манифест и регистрация в `template_builds`; версии, выкатка, откат и сборка мусора; оптимизация загрузки и сценарий `sbx-bench s5`; переопределение URL туннеля через `smbios1`; переход с шаблона 599; список изменений в S1/S2/S3/S6.

**Не-цели:** внутренности агента (S3); примитивы Proxmox и драйвер (S1, здесь только запросы на небольшие изменения, §17); логика пула и состояний (S6); рабочий стол (S10); Windows (S9), кроме точек расширения (§16); обновление ОС в уже созданных sandbox (их диски свои; агент обновляется сам, S3 §17.4); пересборка по расписанию в CI (позже, S12).

**Анти-цели** (провал, даже если всё работает):
- в образе есть чужой или лишний сетевой сервис (tailscaled, avahi, cups, агент VMware и т.п.), открытый наружу порт или пароль/ключ для входа;
- два клона одного шаблона делят machine-id, SSH host keys, random seed, `credential.secret` systemd или состояние агента;
- в образе остались секреты сборки (ключ подписи агента, токены, логи сборки с ними);
- клон с другим MAC остаётся без сети или ждёт `wait-online` до тайм-аута;
- жёсткая остановка (штатная в S6) добавляет задержку к следующей загрузке (GRUB recordfail, fsck-запросы);
- удаление старой сборки ломает работающую sandbox, saved snapshot или fork;
- сборка зависит от шаблона 9000, от ручных действий на хосте или от root SSH.

## 3. Ограничения

- Хост `pve`: Proxmox VE 9.2.21, ядро 7.0.14, `local-lvm` (VG `pve`, thin pool `data`, QLC). PoC: VMID 500–599, RAM всех VM платформы ≤ 8 GB, сеть `sbx0` (S1 §4.3) с egress в интернет и без доступа к LAN.
- Доступ сборщика к хосту — только токен `sbx@pve!poc` через PVE API и (при необходимости) `sbx-node`. Root SSH и изменение файлов хоста сборщиком не используются. Новые права — только перечисленные в §17.1.
- Сеть `sbx0` закрыта: с Mac до гостя по IP не дойти. Поэтому сборка управляется через QEMU guest agent (QGA), а не SSH.
- Инструменты через mise. Все версии — последние стабильные на момент сборки (`sbx-tpl versions --update`, §6.3), фиксируются в `versions.toml` и манифесте.
- Проверено 2026-10-29: Ubuntu 26.04.1 LTS (`resolute`) — текущий LTS; 26.10 вышла, но не LTS. Minimal cloud image `release-20261024` (310 пакетов, 420 MB) и обычный server image `release-20261017` (678 пакетов): systemd 259.9, ядро 7.0.0-38, dracut 110, cloud-init 26.2, OpenSSH 10.2p1. Node 26.13.0 — LTS «Lithium» с 2026-10-28.

## 4. Обзор

```
 Mac (PoC) / later a Kubernetes Job
 +-------------------------------------------------------------+
 | sbx-tpl build linux                                         |
 |  1 fetch base image + SHA256SUMS(.gpg), verify, cache       |
 |  2 render seed ISO (cidata): user-data, meta-data,          |
 |    network-config, build/ (steps, files, agent package)     |
 |  3 upload image (local:import) and ISO (local:iso)  --------+--> PVE API
 |  4 allocate VMID (purpose=template), create build VM:       |
 |    scsi0 import-from image, resize 64G, ide2 = seed ISO,    |
 |    net0 in sbx0 + firewall sbx-egress                       |
 |  5 start, wait QGA; run steps as systemd units via QGA,     |
 |    stream logs by offset (file-read); reboot after base     |
 |  6 cleanup + sbx-agent seal + fstrim, poweroff              |
 |  7 detach ISO, convert to template (base-<vmid>-disk-0)     |
 |  8 verify: S1 create from template, boot, checks, hard      |
 |    stop + start, delete                                     |
 |  9 manifest -> registry (status ready); promote separately  |
 +-------------------------------------------------------------+
```

Сборка всегда идёт с чистого официального образа. Шаблон — это сама сборочная VM, превращённая в template на месте (тот же VMID).

## 5. Рецепт

Рецепт — данные в репозитории, сборщик — код. Каталог `infra/templates/<slug>/` **[S5]**:

```
infra/templates/
  keys/ubuntu-cloud-images.asc     # pinned signing key for SHA256SUMS.gpg
  linux/
    template.yaml                  # recipe: source, hw, steps, seal, verify profile
    versions.toml                  # pinned versions and checksums (§6.3)
    seed/user-data.tmpl, meta-data.tmpl, network-config
    steps/00-base.sh 10-system.sh 20-docker.sh 30-toolchains.sh
          40-coding-agents.sh 50-sbx-agent.sh 90-cleanup.sh
    files/                         # config files copied by the steps (§8)
```

`template.yaml` (форму уточняет builder):

```yaml
slug: linux
os: linux
extends: null                    # linux-desktop: extends: linux (S10)
source:
  kind: cloud-image              # S9: iso-install
  distro: ubuntu
  release: "26.04"
  flavor: minimal
disk: { slot: scsi0, size: 64G }
hw:                              # copied into the template config, S1 whitelist (§9)
  machine: q35
  cpu: host
  bios: seabios
  ostype: l26
  scsihw: virtio-scsi-single
  agent: "enabled=1"
  serial0: socket
  vga: std
  tablet: 0
  rng0: "source=/dev/urandom"
  cloudinit: false               # sandboxes get no cloud-init drive (§17.1)
build_vm: { cores: 4, memory_mb: 4096 }
steps: [00-base, reboot, 10-system, 20-docker, 30-toolchains, 40-coding-agents, 50-sbx-agent, 90-cleanup]
seal: sbx-agent                  # S9: sysprep
boot_timeout_s: 300
```

`reboot` — встроенный шаг сборщика: после обновления ядра и пакетов VM перезагружается, чтобы следующие шаги шли на новом ядре и старые ядра можно было удалить.

## 6. Базовый образ и воспроизводимость

### 6.1 Образ

- `https://cloud-images.ubuntu.com/minimal/releases/resolute/release-<serial>/ubuntu-26.04-minimal-cloudimg-amd64.img`. Serial закреплён в `versions.toml` (`base.serial`, `base.sha256`).
- Сборщик скачивает образ, `SHA256SUMS` и `SHA256SUMS.gpg`, проверяет подпись закреплённым ключом из `infra/templates/keys/` (библиотека `openpgp`, без системного gpg) и sha256 образа. Кэш на машине сборщика: `~/.cache/sbx/images/`.
- В Proxmox образ загружается один раз на serial: `local:import/sbx-ubuntu-26.04-minimal-<serial>.qcow2` (`POST /nodes/{node}/storage/local/upload`, `content=import`, `checksum` sha256: Proxmox проверяет его сам). Если такой файл уже есть и sha256 совпадает, загрузка пропускается.
- Почему minimal: вдвое меньше пакетов, нет лишних сервисов, которые потом пришлось бы выключать. Чего не хватает (man, vim и т.п.), ставит шаг `00-base`. `unminimize` не запускается.
- Почему не 9000 и не 599: 9000 — личный dev-шаблон Ильи (пользователь `ib` с uid 1000, `tailscaled`, snapd, ufw, open-vm-tools, unattended-upgrades, три ядра). В 599 сеть привязана к MAC сборочной VM (`50-cloud-init.yaml`, `match: macaddress`), и `systemd-networkd-wait-online` ждал полные 2 минуты. Исправление 599 передано в `s1-impl` (§15).

### 6.2 Пакеты Ubuntu

- На время сборки источники apt указывают на снапшот архива: `Snapshot: <ts>` в `/etc/apt/sources.list.d/ubuntu.sources` (`snapshot.ubuntu.com`, формат `20261029T000000Z`), значение `apt.snapshot` из `versions.toml`. Тот же снапшот используется при установке `qemu-guest-agent` из `user-data`.
- В шаге `90-cleanup` источники возвращаются на обычный архив без снапшота, списки пакетов удаляются: пользователь в sandbox делает `apt update` и получает текущие пакеты.

### 6.3 `versions.toml`

Один файл на рецепт, коммитится. Пример формы:

```toml
[base]
serial = "20261024"
sha256 = "..."

[apt]
snapshot = "20261029T000000Z"

[docker]           # apt repo download.docker.com, exact versions with =
docker_ce = "5:29.x.y-1~ubuntu.26.04~resolute"
containerd_io = "..."
compose_plugin = "..."
buildx_plugin = "..."

[tools]            # tarballs with sha256 from the official checksum files
node = { version = "26.13.0", sha256 = "..." }
go = { version = "1.27.3", sha256 = "..." }
bun = { version = "1.4.4", sha256 = "..." }
uv = { version = "0.13.6", sha256 = "..." }
gh = { version = "2.103.3", sha256 = "..." }
rust = { version = "1.99.1", rustup_init_sha256 = "..." }

[chrome]           # .deb from dl.google.com by exact version, sha256 from the signed repo index
google_chrome_stable = { version = "156.0.8078.73-1", sha256 = "..." }

[npm]              # global CLIs, exact versions; npm checks integrity from the registry
"@anthropic-ai/claude-code" = "2.1.312"
"@openai/codex" = "0.165.0"
"opencode-ai" = "1.19.5"
"@google/gemini-cli" = "0.66.0"
"pnpm" = "12.16.1"

[sbx]              # our CLI (S7 §15.5): linux-x64 binary, sha256 from the release SHA256SUMS
cli = { version = "...", sha256 = "..." }
```

- `sbx-tpl versions linux --update` находит последние стабильные версии (свежий serial образа, снапшот «сейчас», последняя Node LTS, последние Go/Rust/Bun/uv/gh/Docker/Chrome, последние версии npm-пакетов, последний релиз `sbx` CLI), скачивает официальные файлы контрольных сумм и переписывает `versions.toml`. Значения выше проверены 2026-10-29 (`npm view`, Chrome — versionhistory API Google) и даны как пример; в коммит идёт результат `--update`. Пакеты Ubuntu (JDK, ffmpeg, xdotool) закреплены снапшотом apt (§6.2), отдельной строки им не нужно.
- `sbx-tpl build` использует файл как есть. `--refresh` = `versions --update` перед сборкой (обычный режим для новой сборки; файл после этого коммитится).
- Воспроизводимость: тот же рецепт, `versions.toml` и git-коммит дают тот же список пакетов (`dpkg-query`) и те же версии инструментов. Побитовой одинаковости дисков не требуется.

## 7. Сборщик `sbx-tpl` (`apps/template-builder`)

TS CLI, использует `packages/pve` (PVE API, `sbx-node`, аллокатор, примитивы machine, firewall VM). Конфигурация и секреты — те же переменные, что в S1 §6.1 (`SBX_PVE_*`, `SBX_NODE_*`, `SBX_STATE_DB`, `SBX_VMID_RANGE`).

### 7.1 Команды

| Команда | Что делает |
|---|---|
| `preflight [--node]` | только чтение: права токена (включая upload и чтение `local`, §17.1), content `import`/`iso` у `local`, свободная RAM под сборочную VM, инструмент для ISO, ключ подписи образов |
| `versions <slug> [--update]` | показать или обновить `versions.toml` (§6.3) |
| `build <slug> [--node pve] --agent-package <tar> [--sbx-cli <file>] [--api-url <url>] [--tunnel-url <wss-url>] [--ssh-user-ca <file>] [--refresh] [--keep-on-failure] [--no-verify]` | сборка (§7.2) и проверка (§10); итог — сборка в статусе `ready` |
| `verify <buildId>` | повторная проверка (§10) |
| `promote <buildId>` | сделать сборку активной (§12.2); тот же вызов для отката |
| `list [<slug>]`, `show <buildId>` | реестр и манифест |
| `gc [--dry-run]` | сборка мусора (§12.4) |
| `cleanup` | остатки неудачных сборок: VM, ISO, lease аллокатора |

Логи шагов сохраняются локально в `build-logs/<buildId>/` (в `.gitignore`).

### 7.2 Этапы `build`

1. **Подготовка.** Прочитать рецепт и `versions.toml`. Проверить пакет агента на машине сборщика кодом на TS (бинарь linux/amd64 на Mac не запустить): ed25519-подпись `manifest.sig` над `manifest.json` (`node:crypto`), sha256 файлов, `os/arch = linux/amd64`. Ключи — закреплённые публичные ключи обновлений из репозитория, те же, что вшиты в установщик агента (S3 §17.1, §17.3; путь задаёт реализация S3). Это и есть корень доверия сборки: в госте `install-package` выполняет бинарь из того же пакета, и его самопроверка ничего не добавляет. Создать запись в реестре: `status = building`, `buildId` (UUIDv7), `version` (§11), `build_memory_mb`.
2. **Образ** (§6.1): скачать, проверить, загрузить, если ещё нет.
3. **Seed ISO** (`cidata`, ISO9660 + Joliet + Rock Ridge, если инструмент умеет):
   - `meta-data`: `instance-id: <buildId>`, `local-hostname: sbx-build`;
   - `network-config`: v2, `match: {name: "en*"}`, `dhcp4: true`;
   - `user-data`: без пользователей и ключей (`users: []`, `ssh_pwauth: false`, `disable_root: true`), apt на снапшот (§6.2), `packages: [qemu-guest-agent]`, `runcmd: systemctl enable --now qemu-guest-agent`;
   - `build/`: шаги, `files/`, `versions.toml`, пакет агента, бинарник `sbx` CLI и `config.json` с `--api-url` (§8.9), `agent.toml` (с URL туннеля по умолчанию, §14), ключи SSH CA шаблона (если переданы).

   Инструмент: `xorriso` (Linux, CI) или `hdiutil makehybrid -iso -joliet` (macOS) **[S5]**. Шаги запускаются как `bash <file>`, поэтому exec-биты на ISO не нужны. Загрузка: `local:iso/sbx-seed-<buildId>.iso`.
4. **Сборочная VM.** VMID из аллокатора с `purpose=template` (§17.1). `POST /nodes/{node}/qemu`: `name=sbx-tpl-<slug>-<version с дефисами>`, `pool=sandbox`, `tags=sbx-tpl` (по этому тегу уборка S1 и reconcile S6 не трогают сборочные VM и шаблоны, §17.1 п. 8, §17.4 п. 6), железо из `hw` рецепта, `cores`/`memory` из `build_vm`, `balloon=0`, `scsi0=local-lvm:0,import-from=local:import/<image>,discard=on,iothread=1,ssd=1`, `ide2=local:iso/sbx-seed-<buildId>.iso,media=cdrom`, `net0=virtio=<MAC>,bridge=sbx0,firewall=1`, `boot=order=scsi0`, `description` с buildId и git-коммитом. Затем `PUT resize scsi0 64G` и firewall как у sandbox (S1 §4.4). Перед стартом — проверка RAM: в PoC до S6 как в `sbx-bench` (сумма `memory` работающих VM pool + сборочная ≤ `--ram-cap`, дефолт 8 GB); при S6 — учёт строки `building` в admission (§17.4).
5. **Первая загрузка.** Start, ожидание `agent/ping` (до 10 min: cloud-init ставит QGA). cloud-init в этой загрузке расширяет корневой раздел до 64 GiB (`growpart`).
6. **Шаги.** Каждый шаг выполняется в госте как transient unit: `systemd-run --unit=sbx-build-<n> --property=... bash /mnt/seed/build/steps/<n>.sh` (ISO монтируется в `/mnt/seed` первым вызовом). Вывод — в `/var/log/sbx-build/<n>.log`. Сборщик опрашивает `systemctl show -p ActiveState,Result,ExecMainStatus` (через `agent/exec`) и дочитывает лог через `agent/file-read` с `offset` и `count` (параметры есть в PVE 9.2, проверено `pvesh usage`) раз в 2 s, печатая его в консоль. Так длинный шаг не упирается в тайм-ауты QGA exec. Шаг `reboot`: `agent/exec systemctl reboot` (у `agent/shutdown` нет режима reboot, а `status/reboot` — это выключение и новый запуск QEMU), ожидание нового `boot_id` и `agent/ping`. Шаги пишутся идемпотентно, но повтор сборки после сбоя — всегда новая сборка с нуля (сборка одноразовая) **[S5]**.
7. **Запечатывание.** `90-cleanup.sh` (§8.10), затем `sbx-agent seal` (S3 §7.3) последним вызовом, затем `fstrim -av`, `sync`, `agent/shutdown` (poweroff), ожидание `stopped`. После `seal` VM не загружается до превращения в template.
8. **Template.** `PUT config` `delete=ide2`, `POST /nodes/{node}/qemu/{vmid}/template`. Диск становится `base-<vmid>-disk-0`. Удалить ISO через `sbx-node media.remove` (§17.1 п. 3).
9. **Проверка** (§10), если не `--no-verify`. Успех → манифест (§11) в реестр, `status = ready`.

**Ошибка на любом этапе:** status `failed` (этап, шаг, последние 200 строк лога в манифесте). Если нет `--keep-on-failure`: `stop`, `DELETE /qemu/{vmid}?purge=1&destroy-unreferenced-disks=1`, удалить ISO (`sbx-node media.remove`), освободить VMID. Базовый образ в `local:import` остаётся (кэш).

Ожидаемая длительность: 10–20 min, в основном apt, Docker и инструменты.

## 8. Содержимое образа

Требования S3 §20 выполняются полностью; ниже — как. Где сказано «маскировать», сервис нельзя только отключить: после запечатывания первая загрузка не должна его вернуть.

### 8.1 Пакеты и ядро (`00-base`)

- `apt full-upgrade` из снапшота, одно ядро `linux-image-virtual` (generic flavour); после `reboot` все ядра, кроме работающего, удаляются.
- Ставится: `build-essential`, `pkg-config`, `libssl-dev`, `git`, `git-lfs`, `curl`, `wget`, `ca-certificates`, `gnupg`, `jq`, `ripgrep`, `fd-find` (+ symlink `fd`), `tmux`, `vim`, `nano`, `less`, `man-db`, `htop`, `rsync`, `unzip`, `zip`, `xz-utils`, `zstd`, `file`, `tree`, `sqlite3`, `make`, `cmake`, `openssh-server`, `openssh-client`, `sudo`, `bash-completion`, `python3`, `python3-venv`, `python3-pip`, `python3-dev`, `openjdk-25-jdk-headless` (текущий LTS в `resolute`), `ffmpeg`, `xdotool`, `qemu-guest-agent`, `chrony`, `iproute2`, `iputils-ping`, `dnsutils`, `netcat-openbsd`, `lsof`, `strace`.
- Удаляется (purge), если есть в образе: `snapd`, `apport`, `unattended-upgrades`, `ubuntu-pro-client`, `update-notifier-common`, `landscape-common`, `pollinate`, `fwupd`, `modemmanager`, `multipath-tools`, `open-iscsi`, `udisks2`, `lxd-installer`, `ufw`, `open-vm-tools`, `rsyslog`, `sysstat`, `avahi-daemon`, `cups*`, `tailscale`.
- Маскируется: `apt-daily.timer`, `apt-daily-upgrade.timer`, `motd-news.timer`, `man-db.timer`, `e2scrub_all.timer`, `systemd-oomd.service` (если есть; OOM — только ядро, политика `oom_score_adj` у S3). Остаются: `fstrim.timer` (thin pool возвращает место), `logrotate.timer`, `systemd-tmpfiles-clean.timer`, `cron`, `chrony`.

### 8.2 Пользователи и вход (`10-system`)

- Пользователь `user`: uid/gid 1000, shell `/bin/bash`, группы `sudo`, `docker` (добавляется в `20-docker`) и `kvm` (§8.6), пароль заблокирован, `/etc/sudoers.d/90-sbx-user` `user ALL=(ALL) NOPASSWD:ALL` (0440, проверка `visudo -c`), `loginctl enable-linger user`. Пользователя `ubuntu` и других пользователей с uid ≥ 1000 нет. Пароль root заблокирован.
- `authorized_keys` нет ни у кого.
- Локаль `C.UTF-8`, часовой пояс `UTC`.

### 8.3 sshd и PAM

- `/etc/ssh/sshd_config.d/10-sbx.conf`: `ListenAddress 127.0.0.1`, `ListenAddress ::1`, `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `PermitRootLogin prohibit-password`, `TrustedUserCAKeys /etc/ssh/sbx_user_ca.pub`. `AuthorizedKeysFile` остаётся по умолчанию: файлов `authorized_keys` в образе нет, вход только по сертификату **[S5]**.
- В Ubuntu 26.04 sshd запускается через `ssh.socket`, и генератор берёт `ListenAddress` из конфига. Проверка §10 смотрит фактические слушающие сокеты, а не только конфиг.
- `/etc/sbx-agent/ssh-user-ca.pub` — ключи SSH CA из `--ssh-user-ca` или пустой файл; `/etc/ssh/sbx_user_ca.pub` — его копия (S3 §5).
- `/etc/pam.d/sshd`: две строки `pam_env` из S3 §8.2; `/etc/sbx/env` создаётся пустым.
- Host keys удаляет `seal`; новые создаёт `sbx-identity` при первой загрузке (S3 §7.2). Генерация ключей Ubuntu при старте sshd (`sshd-keygen`) не должна опередить `sbx-identity`: порядок задаёт unit S3 (`Before=ssh.service ssh.socket`).

### 8.4 Сеть, DNS, время

- `/etc/netplan/10-sbx.yaml`: ethernet `en` с `match: {name: "en*"}`, `dhcp4: true`, `dhcp6: false`, `accept-ra: false`. Файл `50-cloud-init.yaml` удаляется. Привязки к MAC нет нигде.
- `systemd-networkd-wait-online`: drop-in `ExecStart=… --any --timeout=15`.
- `systemd-resolved`: DNS из DHCP (S1 §4.3 раздаёт `1.1.1.1`), `/etc/systemd/resolved.conf.d/10-sbx.conf` `FallbackDNS=1.1.1.1 9.9.9.9`. Это нужно, потому что у sandbox больше нет диска cloud-init с `nameserver` (§17.1).
- `chrony` по умолчанию.

### 8.5 Загрузка: GRUB, ядро, initrd

- `/etc/default/grub.d/90-sbx.cfg` (после `50-cloudimg-settings.cfg` из образа):
  ```
  GRUB_TIMEOUT=0
  GRUB_TIMEOUT_STYLE=hidden
  GRUB_RECORDFAIL_TIMEOUT=0
  GRUB_DISABLE_OS_PROBER=true
  GRUB_CMDLINE_LINUX_DEFAULT="console=tty1 console=ttyS0,115200n8 systemd.machine_id=firmware quiet loglevel=3"
  ```
  Затем `update-grub`. `GRUB_RECORDFAIL_TIMEOUT=0` обязателен: S6 штатно останавливает VM жёстко, а по умолчанию Ubuntu после незавершённой загрузки ждёт в меню GRUB. Дополнительно `grub-editenv /boot/grub/grubenv unset recordfail` в `90-cleanup`. Проверка — §10 п. 16.
- `systemd.machine_id=firmware` (systemd 259 ≥ 257, S3 §20): machine-id = `product_uuid` = `machineId` с PID 1.
- initrd — dracut по умолчанию, загрузка всегда через initrd с `root=UUID=` (так грузится 599 на образе 26.04). Если в образе есть `/etc/default/grub.d/40-force-partuuid.cfg` (`GRUB_FORCE_PARTUUID`: попытка загрузки без initrd с откатом через `initrdfail` в grubenv), шаг `10-system` его удаляет и проверяет, что `grub.cfg` не содержит `initrdfail`: жёсткая остановка во время первой загрузки не должна переключать следующую на другой путь. Уменьшение initrd и загрузка без него — эксперименты §13.3, не требование.

### 8.6 Ядро и лимиты

- `/etc/sysctl.d/90-sbx.conf`:
  - `kernel.apparmor_restrict_unprivileged_userns = 0` — непривилегированные user namespaces нужны песочницам coding-агентов (bubblewrap) и rootless-инструментам; граница доверия — VM (S3 §4);
  - `fs.inotify.max_user_watches = 524288`, `fs.inotify.max_user_instances = 1024` — dev-серверы и сборщики следят за файлами.
- `/etc/systemd/system.conf.d/90-sbx.conf`: `DefaultLimitNOFILE=65536:524288` **[S5]**.
- **KVM в госте — best-effort, не гарантия платформы в MVP** (MVP-рек. R6). `/dev/kvm` появляется, только если хост пробрасывает виртуализацию: `cpu: host` (§9) передаёт флаг `vmx`/`svm`, если на хосте модуль `kvm_intel`/`kvm_amd` загружен с `nested=1` (runbook S1 его не меняет, S1 §12). Шаблон ничего не включает сам: модули KVM есть в ядре `linux-image-virtual`, udev отдаёт `/dev/kvm` группе `kvm`, `user` в ней состоит (§8.2). Есть ли KVM в сборке, пишет проверка §10 п. 19; API это не обещает.
- Swap нет: ни раздела, ни файла, ни zram (`systemd-zram-generator` не ставится). Проверка в `90-cleanup` и в §10.

### 8.7 journald

`/etc/systemd/journald.conf.d/90-sbx.conf`: `Storage=persistent`, `SystemMaxUse=256M`, `RuntimeMaxUse=64M`.

### 8.8 Docker (`20-docker`)

- Docker CE, `containerd.io`, `docker-compose-plugin`, `docker-buildx-plugin` из `download.docker.com` (`resolute stable`), версии из `versions.toml`.
- `/etc/docker/daemon.json`: `{"log-driver": "local"}`; userland-proxy по умолчанию (S3 §20); image store по умолчанию (containerd snapshotter в Docker 29). Образы заранее не скачиваются.
- `docker.service` включён: фаза `docker` у агента его ждёт (S3 §8.5). Socket-активация — эксперимент §13.3.

### 8.9 Инструменты и coding-агенты (`30-toolchains`, `40-coding-agents`)

Правило: каждая команда инструмента находится по имени из стандартного `PATH` Ubuntu (`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`) для `user` — и при прямом exec (argv, S3 §8.2 собирает env без shell), и в `bash -lc`. Для root — по возможности.

| Инструмент | Как ставится **[S5]** |
|---|---|
| Node LTS (+ npm, npx) | официальный tarball → `/usr/local`; corepack в Node ≥ 25 не входит и не ставится |
| Bun | официальный zip → `/usr/local/bin/bun` (+ `bunx`) |
| Go | официальный tarball → `/usr/local/go`, symlink `go`, `gofmt` в `/usr/local/bin` |
| Rust | `rustup-init` от имени `user` (`~/.rustup`, `~/.cargo`), toolchain из `versions.toml`, компоненты `rustfmt`, `clippy`; symlink-и прокси (`cargo`, `rustc`, `rustup`, `rustfmt`, `cargo-clippy`, `clippy-driver`) в `/usr/local/bin` |
| Python 3 | системный (`python3`, `venv`, `pip`); `uv`, `uvx` → `/usr/local/bin` |
| gh | официальный tarball → `/usr/local/bin/gh` |
| Claude Code, Codex, OpenCode, Gemini CLI, pnpm | `npm install -g <pkg>@<version>` от root (`/usr/local/lib/node_modules`, bin в `/usr/local/bin`) |
| Java (OpenJDK 25 LTS: `java`, `javac`, `jar`) | apt `openjdk-25-jdk-headless` в `00-base` |
| ffmpeg, xdotool | apt в `00-base`; `xdotool` работает только при X-дисплее (S10 или свой Xvfb пользователя) |
| Google Chrome (`google-chrome`, `google-chrome-stable`) | `.deb` из `dl.google.com` по точной версии из `versions.toml` (sha256 сверяется), `apt install ./<deb>` в `30-toolchains`; для headless-запусков агентов и Playwright/Puppeteer. Песочница Chrome работает от `user` благодаря user namespaces (§8.6). Источник apt Google, который ставит пакет, остаётся: пользователь обновляет Chrome сам |
| `sbx` CLI (S7 §14) | бинарник из `--sbx-cli` (linux-x64 релиз S7 §15.5, sha256 = `versions.toml`) → `/usr/local/bin/sbx` в `40-coding-agents`; `/etc/sbx/config.json` `{"apiUrl": "<--api-url>"}` (S7 §14.1). Ключа в образе нет: пользователь передаёт командный ключ (S7 §7.2) секретом sandbox `SBX_API_KEY`; ключ типа `sandbox` в VM — фаза 2 (S7 §7.2). Внутри VM sandbox по умолчанию — `SBX_SANDBOX_ID` (S3 §8.2). Пока у S7 нет релиза, `--sbx-cli` необязателен, в манифесте `tools.sbx = null` |

- Версии и sha256 — из `versions.toml`, итоговые версии (`--version` каждого) — в манифесте.
- Автообновление CLI агентов в sandbox выключено там, где это настраивается системно (например, managed settings Claude Code); версии обновляются новой сборкой шаблона **[S5]**. Пользователь может обновить их сам через `sudo`.
- Кэши (`npm`, `go build`, `rustup` downloads, `uv`, `pip`) чистятся в `90-cleanup`.
- Набор доведён до паритета с boat по MVP-рек. R5 (`docs/roadmap-phase2.md` §6): Node+pnpm, Python+uv, Go, Rust, Java, Docker+Compose+buildx, gh, rg, jq, Chrome, ffmpeg, xdotool, CLI coding-агентов и `sbx`. В `linux` не входит: рабочий стол (X-сервер, оконный менеджер, Sunshine — S10), Scala/Kotlin/Gradle/Maven, Deno, Ruby, PHP, .NET, R, Android, GitHub Actions runner; их пользователь ставит сам через `sudo`.
- Env по умолчанию шаблон не добавляет: `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` и остальной платформенный env ставит агент (S3 §8.2).

### 8.10 Агент (`50-sbx-agent`) и очистка (`90-cleanup`)

`50-sbx-agent`:
- `sbx-agent install-package /mnt/seed/build/sbx-agent-<v>-linux-amd64.tar` (S3 §17.1): проверка подписи, раскладка в `versions/<v>`, symlink-и `current`, `/usr/local/bin/sbx-agent`.
- `/etc/sbx-agent/agent.toml` (S3 §5) из шаблона рецепта: `[tunnel] url` — URL туннеля по умолчанию (`--tunnel-url`, §14), `[user] default = "user"`, `[docker] enabled = true`, остальное — дефолты S3.
- Unit-ы S3 §17.2 и §7.2 (`sbx-identity.service`, `sbx-agent.service`, `sbx-agent-rollback.service`, `sbx-cmd.slice`) включены.
- `qemu-guest-agent` включён (запасной канал S1/S3).

`90-cleanup` (до `seal`):
- источники apt → обычный архив (§6.2), `apt clean`, `rm -rf /var/lib/apt/lists/*`;
- `cloud-init clean --logs --seed`, `touch /etc/cloud/cloud-init.disabled`, удалить `/etc/netplan/50-cloud-init.yaml` и `/etc/ssh/sshd_config.d/50-cloud-init.conf`; пакет cloud-init остаётся, но выключен (S3 §20) **[S5]**;
- удалить: `/var/lib/systemd/random-seed`, `/var/lib/systemd/credential.secret`, `/var/log/sbx-build`, `/var/log/*` (содержимое, структура каталогов остаётся), `journalctl --rotate --vacuum-time=1s`, `/tmp/*`, `/var/tmp/*`, историю shell у root и `user`, кэши инструментов;
- записать `/etc/sbx-template/build.json` — манифест без проверочной части (§11);
- проверить: swap нет, ядро одно, пакетов из «удаляется» нет, `authorized_keys` нет.

`seal` (S3 §7.3) стирает состояние агента, host keys и `/etc/machine-id` (пустой файл, а не `uninitialized`: так первая загрузка клона не считается first boot systemd и не применяет presets, которые могли бы включить отключённое; проверка §10 п. 13).

## 9. Железо шаблона

Конфиг template VM = `hw` рецепта (§5) + `scsi0` (64 GiB, `discard=on,iothread=1,ssd=1`). Почему так **[S5]**:
- SeaBIOS: Linux-шаблону не нужен UEFI, а прошивка OVMF загружается дольше. Образ Ubuntu поддерживает оба способа загрузки (раздел BIOS boot есть).
- `rng0` (virtio-rng): у свежего клона сразу есть энтропия для `ssh-keygen` в `sbx-identity`.
- `tablet: 0`: USB-планшет headless-VM не нужен.
- `vga: std` оставлен для консоли оператора; `serial0` — для xterm.js и логов загрузки.
- Диска cloud-init у шаблона и у sandbox нет (`cloudinit: false`, §17.1).
- `cpu: host`: гостю видны все флаги CPU хоста (AVX-512, `vmx`/`svm` для вложенного KVM, §8.6), и это лучшая производительность. Цена — живая миграция возможна только между нодами с одинаковым CPU. В PoC нода одна, поэтому `cpu: host` остаётся; для кластера со смешанными CPU нужна именованная модель (например, `x86-64-v3`) — решение S12 / фазы 2 (S1 §12).

`disk_layout` и `hw` (ключи из белого списка S1 + `rng0`) записываются в манифест и в `template_builds`.

## 10. Проверка сборки

`verify` создаёт machine из шаблона примитивом S1 `create` (размер 2 vCPU / 2 GB, тестовый `smbios1`: случайный `uuid`, serial формата S2 с тестовым BS, `family` с тестовым URL туннеля, §14), загружает её, выполняет проверки через QGA и удаляет её с проверкой отсутствия следов (S1 §6.3). Любая красная проверка → сборка `failed` (при вызове из `build`) или ненулевой код (при отдельном `verify`).

1. ОС: `26.04`, ядро одно, `systemctl --version` ≥ 257.
2. `/proc/cmdline` содержит `systemd.machine_id=firmware`; `/etc/machine-id` = `product_uuid` без дефисов.
3. Swap: `swapon --show` пуст, в `fstab` нет swap, zram нет.
4. Слушающие сокеты (`ss -tulpn`):
   - TCP: только `127.0.0.1:22` и `[::1]:22` (владелец `systemd` через `ssh.socket` или `sshd`), resolved на `127.0.0.53:53` и `127.0.0.54:53`. Ни одного TCP-сокета на `0.0.0.0`, `::` или адресе интерфейса.
   - UDP: resolved на `127.0.0.53`/`127.0.0.54`, chronyd на loopback (`323`), DHCP-клиент `systemd-networkd` на `<ip>%en*:68`. Других нет.
5. `sshd -T`: `passwordauthentication no`, `trustedusercakeys /etc/ssh/sbx_user_ca.pub`, оба `listenaddress`. SSH host keys есть и созданы при этой загрузке.
6. `/etc/pam.d/sshd` содержит строки S3 §8.2; `/etc/sbx/env` существует.
7. cloud-init: `cloud-init status` = disabled; `50-cloud-init.yaml` нет; netplan матчит `en*`; IPv4 из `10.88.0.0/24`.
8. Пользователи: `user` uid 1000 в группах `sudo` и `docker`; `sudo -n true` от `user` работает; linger включён; `ubuntu` нет; других uid ≥ 1000 нет; пароли root и `user` заблокированы; файлов `authorized_keys` нет.
9. Агент: `sbx-agent doctor --json` — версия = манифест, `identity` ready с `machineId` из тестового smbios, эффективный URL туннеля = тестовый из `family` (источник `smbios`), unit-ы `sbx-identity` и `sbx-agent` активны. Подключение к туннелю не проверяется: gateway в verify может не быть, и агент обязан быть `active` без него (§17.3 п. 4).
10. Docker: `docker info` и `docker run --rm hello-world` (образ из интернета через egress `sbx0`).
11. Инструменты: каждая команда из §8.9 — `--version` (для Go — `go version`; для `gofmt`, `bunx`, `uvx`, `npx` — только `command -v`) от `user` прямым exec и через `bash -lc`; версии = манифест.
12. Сеть: `getent hosts example.com`, `curl -fsS https://example.com`; `systemd-networkd-wait-online` уложился в 15 s.
13. systemd: `is-system-running` = `running`; нет failed unit-ов; нет активных job; сервисы из «маскируется» и «удаляется» (§8.1) не активны и не включены.
14. Остатки: нет `/var/log/sbx-build`, `/var/lib/cloud/instances/*`, истории shell; `/etc/sbx-template/build.json` есть.
15. sysctl из §8.6 действуют; `unshare -Ur true` от `user` проходит.
16. **Жёсткая остановка:** S1 `stop` (без shutdown), затем start. Время до `agent/ping` не больше времени первой загрузки + 3 s; в `grubenv` нет `recordfail` или он не даёт ожидания (`GRUB_RECORDFAIL_TIMEOUT=0` в `grub.cfg`).
17. Диск: размер корня ≈ 64 GiB; `fstrim -v /` работает.
18. Замеры загрузки (первая загрузка и загрузка после жёсткой остановки): метрики §13.1 пишутся в манифест (`verify.boot`).
19. **KVM (best-effort, не валит сборку):** если в `/proc/cpuinfo` есть `vmx` или `svm`, `/dev/kvm` существует и `user` открывает его на чтение и запись; результат — `verify.kvm` (`available` / `unavailable` с причиной) в манифесте.

## 11. Версия, манифест, реестр

- **Версия:** `<YYYYMMDD>.<n>` (UTC-дата начала сборки, `n` — порядковый номер за день для slug). Имя VM: `sbx-tpl-<slug>-<YYYYMMDD>-<n>`. `buildId` — UUIDv7 = `template_builds.id`.
- **Манифест** (`build.json`) **[S5: состав, формат JSON]**: `buildId`, `templateSlug`, `version`, `os`, `status`, `node`, `storage`, `pveVmid`, `gitCommit`, `recipeDigest` (sha256 каталога рецепта), `base` (distro, release, flavor, serial, sha256), `apt.snapshot`, `kernel`, `systemd`, `packages` (`dpkg-query` имя → версия), `tools` (имя → `--version`), `agentVersion`, `defaultTunnelUrl`, `hw`, `diskLayout`, `bootTimeoutS`, `buildMemoryMb`, `startedAt`, `finishedAt`, `verify` (результаты проверок, `boot`), `error` (при `failed`).
- Копия без `verify` лежит в образе (`/etc/sbx-template/build.json`).
- **Реестр** — интерфейс `TemplateRegistry` (`create`, `update`, `get`, `list`, `promote`, `retire`):
  - до реализации S6: SQLite в `SBX_STATE_DB` (тот же файл, что у аллокатора S1), таблица с колонками `template_builds` S6;
  - с S6: Postgres через `packages/db` (S6 §14.3: `sbx-admin template register|promote` или прямые вызовы того же кода).
  - переход: `sbx-tpl registry migrate --to postgres` переносит строки сборок и их lease (`purpose=template`) из SQLite в Postgres. Выполняется до первого запуска reconcile S6 на этой ноде; до этого reconcile защищён тегом `sbx-tpl` (§17.4 п. 6).
- `sbx-bench` и S3-стенд берут VMID шаблона из активной сборки (`sbx-tpl show --active linux --field pveVmid`) или из `SBX_TEMPLATE_VMID`.

## 12. Выкатка, откат, сборка мусора

### 12.1 Статусы

`building → ready → active → deprecated → retired`; из `building` — `failed`. `ready` (проверена, но не активна) и `failed` добавлены к статусам S6 §5.2 **[S5]**.

| Статус | Новые machine | VM и LV шаблона |
|---|---|---|
| `building` | нет | сборочная VM |
| `ready` | нет | есть |
| `active` | да (пул и cold create) | есть |
| `deprecated` | нет | есть (откат возможен) |
| `retired` | нет | удалены, строка остаётся для истории (`template_build_id` у machine и snapshots) |
| `failed` | нет | удалены (или оставлены при `--keep-on-failure` до `cleanup`) |

### 12.2 Promote и откат

- `promote <buildId>`: сборка в `ready` или `deprecated`, её VM существует и является template. В одной транзакции: текущая `active` для `(slug, node)` → `deprecated` (`deprecated_at`), эта → `active` (`promoted_at`). Пул заменяет warm-машины сам (S6 §9.2 шаг 4, §9.4); sandbox на старой сборке не трогаются.
- Откат = `promote` предыдущей `deprecated` сборки. Повторная проверка не нужна: сборка уже проверена, а её диск неизменен (template только читается).
- Сборка активна на ноде: при нескольких нодах (фаза 2) сборка выполняется для каждой ноды (`--node`), `promote` — тоже по ноде. Перенос готового образа между нодами — фаза 2.

### 12.3 Почему удаление шаблона безопасно

В dm-thin клон шаблона (`lvcreate -s`, S1 §6.2) и снапшоты machine независимы от исходного тома, а Proxmox не считает наши `vm-N-disk-K` связанными клонами (у них нет имени вида `base-X/vm-N`). Поэтому `DELETE /qemu/<vmid>` шаблона не задевает работающие и остановленные sandbox, fork и saved snapshots. Место освобождают только блоки, которые больше никто не использует. Проверяется приёмкой (§19, п. 4).

### 12.4 `gc`

Для каждой пары `(slug, node)`:
- остаются `active` и две последние `deprecated` (по `deprecated_at`);
- остальные `deprecated` удаляются, если `deprecated_at` старше 7 дней и нет machine с этим `template_build_id` в `allocating`, `provisioning`, `booting`, `warm` (новые клоны из `deprecated` не начинаются: пул и cold create берут только `active`). Удаление: `DELETE /nodes/{node}/qemu/{vmid}?purge=1`, проверка отсутствия LV `base-<vmid>-*`, освобождение VMID в аллокаторе, статус `retired`, `retired_at`;
- `failed` с остатками → как `cleanup`;
- базовые образы в `local:import/sbx-*`, на которые не ссылается ни одна не-`retired` сборка, удаляются; ISO `sbx-seed-*` старше 1 дня — тоже. Оба удаления — через `sbx-node media.remove` (§17.1 п. 3).

В PoC до S6 аллокатор не знает `template_build_id` machine. Поэтому `gc` удаляет сборку, только если в аллокаторе нет lease в `reserved` (клон в процессе) и в pool `sandbox` нет VM в создании (lock `clone`/`create` в конфиге); работающие machine старой сборки удалению не мешают (§12.3). В PoC `gc` запускается вручную. С S6 — тот же код в контроллере worker или в CronJob (выбор S6/S12); проверка «нет machine» — запрос к `runtime.machines`.

### 12.5 Пересборка

В PoC вручную (`sbx-tpl build linux --refresh`, затем `promote`). Позже — раз в неделю в CI или Kubernetes Job (S12) тем же CLI; promote после зелёной проверки можно автоматизировать там же.

## 13. Время загрузки

### 13.1 Метрики и `sbx-bench s5`

Новый сценарий `sbx-bench s5 --build <buildId> [--baseline 599] [--runs 5]` в `apps/bench`. Для каждой сборки N раз: S1 `create` → start → замеры → hard stop → start → замеры → delete.

| Метрика | Как |
|---|---|
| `start_to_qga` | от вызова start до первого `agent/ping` (как `boot` в S1) |
| `start_to_ip` | до IPv4 в `network-get-interfaces` |
| `start_to_agent_ready` | хостовое время старта ядра (`t_ping − uptime` в момент ping) + монотонная метка готовности агента: фазы `agent` и `identity` ready, плюс `docker` ready (из `sbx-agent doctor --json`, §17.3); пока меток нет — `ActiveEnterTimestampMonotonic` unit-ов `sbx-agent` и `docker` |
| `kernel`, `initrd`, `userspace` | `systemd-analyze` |
| `critical_chain` | `systemd-analyze critical-chain sbx-agent.service` |
| `blame_top10` | `systemd-analyze blame` |
| `hard_stop_restart` | `start_to_qga` после `stop` без shutdown |

Отчёт: median, p95, min, max; таблица сравнения с baseline (599 или другая сборка). JSON в `bench-results/s5-<ts>.json`. Когда появятся S4 и S6, сценарий добавляет `start_to_tunnel` (подключение агента по данным gateway).

### 13.2 Цели

На `pve`, `local-lvm`, 2 vCPU / 2 GB: медиана `start_to_qga` ≤ 8 s, `start_to_agent_ready` ≤ 10 s; `hard_stop_restart` не больше обычной загрузки + 3 s. Не хуже 599 ни по одной метрике. Цифры пишутся в §20.

### 13.3 Обязательные меры и эксперименты

Обязательные (в рецепте с первой сборки): GRUB без ожидания и без recordfail (§8.5), удалённые и замаскированные сервисы (§8.1), `wait-online --any --timeout=15`, cloud-init выключен, нет диска cloud-init у sandbox (§17.1), SeaBIOS, `boot: order=scsi0`.

Эксперименты (каждый — отдельная сборка с флагом рецепта, сравнение `sbx-bench s5 --baseline`; принимается, если медиана `start_to_agent_ready` улучшается не меньше чем на 300 ms и проверка §10 зелёная):
1. dracut `hostonly` с минимальным набором модулей (virtio, scsi, ext4).
2. Загрузка без initrd (`root=PARTUUID=`), если virtio-scsi и ext4 в ядре встроены.
3. Ядро `linux-kvm` вместо generic (нужны модули Docker: overlay, br_netfilter, veth, nf_tables).
4. `docker.socket` вместо раннего `docker.service`.
5. `sbx-agent.service` без `After=network-online.target` (агент сам повторяет подключение) — изменение S3, только если `wait-online` окажется на критическом пути.
6. `vga: none` / только serial.

## 14. URL туннеля: значение по умолчанию и переопределение через `smbios1`

Решение master-сессии: URL зашивается в образ только как значение по умолчанию, worker может переопределить его для каждой VM. Тогда одна сборка годится для dev и prod.

- **По умолчанию:** `agent.toml [tunnel] url` из `--tunnel-url` при сборке (в манифесте `defaultTunnelUrl`).
- **Переопределение:** поле `family` в `smbios1`: `family=<base64("sbxt1:" + url)>` при общем флаге `base64=1` (S2 §5.2). Агент читает `/sys/class/dmi/id/product_family`; при префиксе `sbxt1:` и корректном URL (`wss://`, непустой host, ≤ 200 байт) использует его, иначе — значение из `agent.toml` с предупреждением в лог. `doctor --json` показывает эффективный URL и источник.
- **Проверено в исходниках Proxmox 9.2 (`PVE/QemuServer.pm`):** `smbios1` принимает `uuid`, `serial`, `manufacturer`, `product`, `version`, `sku`, `family`, `base64`; при `base64=1` все поля, кроме `uuid`, передаются в QEMU декодированными (запятые экранируются). Вся строка `smbios1` — не больше **512 символов**. Сейчас занято около 175: `uuid=<36>` (41), `,serial=<base64 от 85 байт>` (124), `,base64=1` (9). Остаётся около 335 символов, то есть `,family=` и до ~245 байт URL до base64. Лимит 200 байт для URL оставляет запас. Длину и чтение `product_family` проверяет стенд (§19, п. 3).
- `product_family` в sysfs доступен всем пользователям VM (в отличие от `product_serial`). URL — не секрет, это допустимо.
- `sku` не используется и остаётся резервом.
- **Одна сборка — один бандл tunnel CA** (решение master-сессии, 2026-10-29). Агент доверяет только бандлу tunnel CA из своего пакета (S2 §5.4); переопределение меняет адрес, но не доверие. Общего бандла dev + prod нет. Одна сборка обслуживает несколько инсталляций, только если у них один и тот же tunnel CA (например, несколько окружений одной инсталляции); в этих пределах переопределение через `family` и полезно.

## 15. Шаблон 599 и переход

- 599 (`sbx-ubuntu-poc`) — шаблон стенда S1: thin-снимок 9000 с `qemu-guest-agent`, собран runbook-ом S1 §4.6. Он наследует от 9000 пользователя `ib` (uid 1000, конфликт с `user` из S3), `tailscaled`, snapd и сеть, привязанную к MAC. Master-сессия передала исправление в `s1-impl` (2026-10-29).
- S5 от 599 и 9000 не зависит.
- Пока первой сборки S5 нет, S1-стенд работает на 599. После первой `active` сборки `linux`: `sbx-bench s1`, стенд S3 и E2E S6 используют её (`SBX_TEMPLATE_VMID` из реестра, §11).
- 599 остаётся как baseline для `sbx-bench s5 --baseline 599`, пока цели §13.2 не подтверждены и цифры не записаны. Затем удаляется шагом `infra/pve/setup.sh revert template` (S1). VMID 599 возвращается в аллокатор.

## 16. Расширяемость (S9, S10)

Сборщик знает этапы, рецепт задаёт содержимое:

| Точка | `linux` | `linux-desktop` (S10) | Windows (S9) |
|---|---|---|---|
| `source.kind` | `cloud-image` | `cloud-image` | `iso-install`: ISO пользователя (лицензия) в `local:iso`, `autounattend` на втором ISO, `virtio-win.iso` |
| носитель сборки | seed ISO `cidata` | то же | ISO `autounattend` + каталог `build/` |
| исполнитель шагов | `bash` через QGA | то же | PowerShell через QGA (virtio-win) |
| `extends` | — | `linux`: шаги `linux` + свои; сборка тоже с чистого образа, а не поверх LV `linux` | — |
| запечатывание | `sbx-agent seal` | то же | `sbx-agent seal` + `sysprep /generalize /oobe /shutdown` |
| железо | SeaBIOS, `scsi0` | то же + видео по решению S10 | OVMF, `efidisk0`, `tpmstate0` (слоты уже есть в S1 `DiskSet`) |
| проверка | §10 | §10 + рабочий стол | свой профиль |

Реестр, версии, promote, gc и `sbx-bench s5` общие. `boot_timeout_s` из рецепта (Windows — 1200, S6 §5.2).

## 17. Изменения в соседних областях

Согласовано master-сессией; вносят исполнители этих областей (`s1-impl`, реализация S3, S6).

### 17.1 S1 (`packages/pve`, `sbx-node`, runbook)

1. **VMID шаблонов из аллокатора.** `allocate("template")` вместо зашитого 599; `ensureTemplate` резервирует VMID всех зарегистрированных сборок. `SBX_TEMPLATE_VMID` остаётся переопределением для стенда.
2. **`sbx-node lv.snapshot`:** origin `base-<любой VMID диапазона>-*` вместо `base-<templateVmid>-*` (префикс `base-` бывает только у дисков template). Имя `vm-<id>-disk-*` запрещено, если у `<id>` есть LV `base-<id>-*`. Параметр `templateVmid` в `/etc/sbx-node.toml` убирается.
3. **Права и файлы на `local`.**
   - Роль `SbxTemplateMedia` (`Datastore.AllocateTemplate`, `Datastore.Audit`) на `/storage/local` для `sbx@pve` и токена: загрузка образов и ISO (`upload`), `import-from` и подключение ISO (проверено в `PVE/API2/Storage/Status.pm` и `PVE/Storage.pm`).
   - Удаление через API (`DELETE …/content/<volid>`) требует `Datastore.Allocate` (проверено в `PVE/API2/Storage/Content.pm`). Это право позволяет менять само хранилище и удалять ISO и бэкапы Ильи, поэтому его не даём. Вместо этого — операции `sbx-node`: `media.list` (только чтение) и `media.remove` — удаление только файлов `/var/lib/vz/template/iso/sbx-seed-*.iso` и `/var/lib/vz/import/sbx-*.{qcow2,img,raw}`, имя проверяется по шаблону, без `..` и symlink-ов.
   - Content `import` у `local` включён (на `pve` уже есть). Если его нет, включает runbook S1 (изменение `storage.cfg`, шаг с подтверждением), а не сборщик.
4. **Без cloud-init у sandbox.** Если у шаблона `hw.cloudinit = false`, `create` не добавляет `ide2=…:cloudinit`, `ipconfig0`, `ciuser`. `fork` идёт за источником: `snapshot` пишет в hardware снапшота метку `sbx-cloudinit` (`0`/`1`, есть ли у источника cloud-init-диск), и fork из sandbox такого шаблона cloud-init не получает. Для 599 и снапшотов без метки поведение прежнее.
5. **Белый список железа** + `rng0`.
6. **`smbios1`:** `create`/`fork` принимают `family` (§14) вместе с `uuid` и `serial`; проверка длины всей строки ≤ 512.
7. Функция настройки firewall VM (S1 §4.4) экспортируется для сборочной VM.
8. **Уборка не трогает шаблоны.** `sbx-bench cleanup` и `preflight` пропускают VM с тегом `sbx-tpl` (сборки и шаблоны), lease с `purpose=template` и не считают их хвостами; вместо «кроме 599» — «кроме `sbx-tpl`».

### 17.2 S2

Формат `family` в `smbios1` (§14) — дополнение к S2 §5.2: `sbxt1:<url>`, необязательное поле.

### 17.3 S3 (агент)

1. Чтение `product_family`, приоритет `smbios > agent.toml`, проверка URL (§14).
2. `doctor --json`: эффективный URL туннеля и его источник; монотонные метки перехода фаз готовности в `ready` (для `sbx-bench s5`, §13.1).
3. Закреплённые публичные ключи обновлений лежат в репозитории файлом, который читает и сборщик (§7.2 п. 1).
4. `sbx-agent.service` (`Type=notify`) отправляет `READY=1` после открытия `state.db` и восстановления shim, **не дожидаясь** туннеля: без gateway (сборка, verify, обрыв) unit должен быть `active`, а не в цикле перезапусков с откатом.

### 17.4 S6 (control plane)

1. `template_builds`: статусы `building | ready | active | deprecated | retired | failed`; колонки `manifest jsonb`, `build_memory_mb int`, `verified_at`, `deprecated_at`, `retired_at`; уникальность `active` по `(template_slug, node_id)` прежняя.
2. Admission (§8.1): RAM сборки в `building` на её ноде входит в `reserved` и `powered`.
3. Worker пишет `family` в `smbios1` (§7.4 шаг 4), если в конфигурации инсталляции задан URL туннеля (`SBX_TUNNEL_URL`); иначе поле не ставится.
4. `boot_timeout_s` и `hw` (с `cloudinit: false`) берутся из сборки и передаются в S1.
5. `gc` (§12.4): S6 решает, где он работает (контроллер или CronJob S12).
6. **Reconcile не трогает шаблоны.** VM с тегом `sbx-tpl` или `template: 1` reconcile не удаляет никогда; если для неё нет строки `template_builds`, он только сообщает (метрика, лог). Lease с `purpose=template` не считаются сиротами.

## 18. Структура кода

```
apps/template-builder/        TS: sbx-tpl CLI (recipe loader, image fetch/verify, seed ISO,
                              build stages, QGA step runner, verify, registry, gc)
infra/templates/keys/         pinned Ubuntu cloud image signing key
infra/templates/linux/        recipe: template.yaml, versions.toml, seed/, steps/, files/
apps/bench/                   + scenario s5 (§13.1)
packages/pve/                 + changes §17.1 (by s1-impl)
```

Библиотеки (проверено 2026-10-29 через `npm view`, при реализации перепроверить): `openpgp` 6.3.2 (подпись `SHA256SUMS.gpg`), `smol-toml` 1.9.1, `yaml` 2.9.1, `zod` 4.6.7 (схемы рецепта и манифеста), `commander` 15.0.0 или то, что уже выбрано в `apps/bench`. Packer (1.16.2, плагин proxmox 1.2.4) рассмотрен и отвергнут: ему нужен SSH до гостя в закрытой `sbx0`, он не ставит наши теги и не знает аллокатор, лицензия BUSL.

Тесты (vitest):
- unit: разбор и проверка рецепта и `versions.toml`, проверка подписи и sha256 (тестовый ключ), сборка `user-data`/`network-config`, порядок вызовов PVE API в `build` и откат при ошибке (фейк `packages/pve`), запуск шага через QGA с дочитыванием лога по offset (фейк QGA), правила `gc` (таблица случаев), формат и длина `smbios1` с `family`;
- shellcheck для `steps/*.sh`;
- интеграция — сама сборка и `verify` на `pve`, плюс `sbx-bench s5`.

## 19. Приёмка

На `pve`:
1. `sbx-tpl preflight` зелёный; `sbx-tpl build linux --refresh --agent-package <tar> --sbx-cli <bin> --api-url <url> --tunnel-url <url>` проходит от официального образа без ручных действий; сборка `ready`, все проверки §10 зелёные.
2. Повторная сборка с тем же `versions.toml` и коммитом даёт тот же `packages` и `tools` в манифесте.
3. `smbios1` с `family` максимальной разрешённой длины (URL 200 байт) принимается Proxmox; агент видит URL; строка длиннее 512 символов отклоняется сборщиком до вызова API.
4. **GC безопасен:** machine A из сборки X работает, saved snapshot (или S1 snapshot) A есть; `promote` сборки Y; `gc` с принудительным порогом удаляет X; A продолжает работать, перезагружается, fork из снапшота A загружается; LV `base-<X>-*` нет, VMID X освобождён.
5. `promote` Y → откат `promote` X (до удаления) → пул S6 (если есть) или стенд использует X.
6. `sbx-bench s5 --baseline 599`: цели §13.2 выполнены; `hard_stop_restart` в пределах; цифры записаны в §20.
7. Неудачная сборка (шаг, который падает намеренно, флаг теста) не оставляет VM, ISO и lease; с `--keep-on-failure` оставляет, `cleanup` убирает.
8. S1 `inventory` «мир до» и «мир после» сборки и `gc` отличаются только VM и LV новой сборки и удалёнными сборками.

## 20. Результаты

Реализация 2026-10-30, ветка `s5-impl`; план `docs/plans/s5-linux-template.md`. Сборки на `pve` (Proxmox VE 9.2.21).

### 20.1 Цифры

**Сборка** `linux` (`sbx-tpl build linux`, Mac → `pve`): 10–14 min от официального образа до готового шаблона, плюс 5–6 min `verify`. Базовый образ `release-20261024` грузится в `local:import` один раз на serial (420 MB). Образ: 658 пакетов, ядро `7.0.0-42-generic`, systemd 259.9, 39 команд инструментов (§8.9, `sbx` пока нет). Занято в thin pool: см. §20.4.

**Воспроизводимость (§19 п. 2):** две сборки с одним `versions.toml` (20261030.10 и .11) дали одинаковые `packages` (658) и `tools` (39).

**`verify` (§10):** 97 проверок PASS, 0 FAIL (сборка .15), включая агента (`doctor`, версия, identity, URL туннеля из `smbios`), подключение агента клона к dev-gateway (`tunnel_connected`, CT 590, `--connect-url`), Docker `hello-world`, скан диска шаблона и клона на секреты сборки (§20.2 п. 6), жёсткую остановку (≤ первой загрузки + 3 s), fork с новыми machine-id, hostname, host keys, IP, random seed и состоянием агента. KVM в госте: `available` (на `pve` `kvm_intel nested=Y`).

**`sbx-bench s5 --template 598 --baseline 599 --runs 5`** (сборка .15; 2 vCPU / 2 GB, `local-lvm`), ms, медиана (p95):

| Метрика | S5 (598) | 599 |
|---|---|---|
| `start_to_qga` | 9094 (9174) | 11605 (14142) |
| `start_to_ip` | 9296 (9379) | 11811 (14249) |
| `start_to_agent_ready` | 8955 (9074) | — (агента нет) |
| kernel / initrd / userspace | 466 / 1940 / 3103 | 851 / 2123 / 6087 |
| `hard_stop_restart` | 8886 (9070) | 10024 (14707) |

Сборка .11 (597) дала те же цифры (`start_to_qga` 9013, `start_to_agent_ready` 8821). Шаблон S5 не хуже 599 ни по одной метрике. Цель §13.2 `start_to_agent_ready` ≤ 10 s выполнена; `start_to_qga` ≤ 8 s **не выполнена** (9.1 s): kernel + initrd + userspace ≈ 5.3 s, остальное — SeaBIOS и запуск QEMU. Решение Ильи «время создания не оптимизируем» (`docs/roadmap.md`) делает эту цель необязательной для MVP; эксперименты §13.3 не проводились.

**`sbx-bench s1`:** против шаблона 597 — 126/126 (clone 1.0 s, boot 9.9 s, fork 11.2 s; baseline `qm clone` из шаблона тоже проходит); против 598 — 125/126 (clone 1.0 s, fork 13.5 s), единственный FAIL — «мир до/после»: первый клон нового шаблона активирует его LV (`attr`), повторный прогон его не даёт.

**Неудачная сборка (§19 п. 7):** `--fail-step 20-docker` — откат удалил VM, seed и lease, на хосте остался только кэш базового образа; `--fail-step 00-base --keep-on-failure` — VM, seed и lease остались, `sbx-tpl cleanup` их убрал, шаблон не тронут.

### 20.2 Отклонения от спецификации

1. **Seed — диск, а не CD** (§7.2 п. 3–4, §7.2 п. 8). Первая загрузка cloud-образа идёт без initrd (`GRUB_FORCE_PARTUUID`); драйверы CD (AHCI, `sr_mod`) — модули и появляются после того, как cloud-init ищет seed, и cloud-init выключается. Seed (тот же ISO 9660 `cidata`) грузится в `local:import/sbx-seed-<buildId>.raw` и подключается как `scsi1` (`import-from`); virtio-scsi и sd встроены в ядро. Дополнительно у сборочной VM `smbios1 serial=ds=nocloud`. Перед `template` диск удаляется (`unlink force=1`), `smbios1` снимается.
2. **ISO только через `xorriso`** (§7.2 п. 3, §21). `hdiutil` сокращает имена с точками и длиннее 30 символов (`sudoers.d` → `sudoersd`). На Mac: `brew install xorriso`.
3. **Реестр — файлы JSON** (§11). S6 уже есть, SQLite-реестр не делался: манифесты в `~/.local/state/sbx/templates/<buildId>.json` (`SBX_TEMPLATE_REGISTRY`), номер версии — эксклюзивный claim-файл. Регистрация для worker — `topology.templateBuilds` в `deploy/compose/config/sbx.yaml` (или `sbx-admin template register`, строку печатает `build`). `promote` — `sbx-admin template promote` (S6), `gc` — S6/S12 (§17.4 п. 5). `sbx-tpl retire <buildId>` помечает `ready`-сборку `retired`; если VM шаблона этой сборки ещё есть, нужен `--delete-vm` (удаляет VM и освобождает lease слота). `show --active ... --field pveVmid` реализован как `show --active-vmid <slug>` (новейшая `ready` сборка).
4. **VMID шаблонов** — `SBX_TEMPLATE_VMID_RANGE` (по умолчанию 597–598, сверху вниз), раскладка `pve` в S1 §4.7. Два слота: перед третьей сборкой старую нужно удалить.
5. **URL туннеля по умолчанию пуст** (§14). `agent.toml` без `[tunnel] url`, если не задан `--tunnel-url`; worker пишет `smbios1.family` из `SBX_TUNNEL_URL` (§17.4 п. 3 сделан в этой ветке). Tunnel CA — параметр сборки пакета агента (`infra/templates/agent-package.sh --tunnel-ca`); dev-сборка использует dev CA gateway CT 590.
6. **Скан на секреты — на хосте** (§10). Новая операция `sbx-node lv.scan` (только `base-<слот>-*` с тегом `sbx-tpl` и `vm-<id>-disk-N` диапазона sandbox с тегами `sbx`, `sbx-vm-<id>`; паттерны через stdin SSH, в журнал `sbx-node` не пишутся) сканирует диск шаблона и диск клона после загрузки. Паттерны: ключ подписи обновлений (PEM и seed в base64/hex), секрет токена PVE, ключи `sbx-node` и dev CA, BS клона.
7. **`wait-online`** (§8.4, §10 п. 12). netplan 26.04 включает `systemd-networkd-wait-online` только для интерфейсов с известным именем; с `match: {name: "en*"}` unit пропускается по условию, `network-online.target` достигается сразу. Проверка принимает это (плюс `network-online.target active`) или ожидание ≤ 15 s.
8. **`sbx-bench s5`** принимает `--template <vmid>` вместо `--build <buildId>`.
9. **Запечатывание** (§7.2 п. 7) дополнено: остановка `systemd-random-seed` и удаление `random-seed`, `credential.secret` перед `seal` (иначе ExecStop сохраняет seed при poweroff); после `seal` пересобирается initrd (`update-initramfs -u -k all`: dracut кладёт в него `/etc/machine-id` и `/etc/hostname`, иначе ранняя загрузка каждого клона шла под machine-id и hostname сборочной VM), journald переводится в `/run` и `/var/log/journal/*` удаляется; zero-fill свободного места, `sync`, `fstrim`; сборка падает, если `base-<vmid>-disk-0` занят больше чем на 40%. Firewall сборочной VM снимается перед `template` (иначе `qm clone` копирует ipset).
10. **apt.** Источники на время сборки — снапшот; `snapshot.ubuntu.com` отвечал 503 около 30 min: cloud-init повторяет установку `qemu-guest-agent`, шаги используют `apt-get update --error-on=any` с повторами.
11. **Docker** держится `apt-mark hold` только во время сборки; в шаблоне снят.

### 20.3 Права и изменения хоста, добавленные по факту

- Роль `SbxTemplateMedia` (`Datastore.AllocateTemplate`, `Datastore.Audit`) на `/storage/local` (`infra/pve/setup.sh media`). `Datastore.Allocate` не выдаётся; проверка шага это проверяет.
- `sbx-node`: диапазон sandbox 500–589 и слоты шаблонов 597–599 (`templateVmidMin`/`templateVmidMax`); клон только из `base-<слот>-*` с тегом `sbx-tpl`, запрет `vm-<id>-disk-*` поверх шаблона; операции `media.list`, `media.remove`, `lv.tagTemplate` (тег `sbx-tpl` на дисках шаблона слота; builder вызывает её перед `lv.usage`), `lv.scan`, `lv.usage` (заполнение LV; неактивный LV активируется на время чтения, только после проверки тегов). Развёртывание: `setup.sh node`.

### 20.4 Шаблон

Активная сборка в `deploy/compose/config/sbx.yaml`: `linux` **20261030.15**, VMID **598**, агент `0.1.0+20261030.2fb34a1` (tunnel CA — dev CA gateway CT 590). `verify`: 97 PASS, 0 FAIL (с проверками random seed, `credential.secret`, состояния агента и сканом на хосте). Занято в thin pool: **7.3 GiB** (11.4% от 64 GiB; `sbx-node lv.usage`). Предыдущая сборка .11 занимала 95%: zero-fill не возвращался в пул, потому что `rm` и `fstrim` шли без commit журнала ext4; теперь `rm; sync; fstrim`, и сборка падает при заполнении больше 40%.

## 21. Открытые вопросы и риски

- ~~Общий tunnel CA для dev и prod~~ (§14). Решено master-сессией: общего бандла dev + prod нет, правило «одна сборка — один бандл tunnel CA».
- ISO-инструмент на Mac: `hdiutil` не пишет Rock Ridge; шаги запускаются через `bash`, поэтому это не важно, но длинные имена файлов проверить (Joliet).
- Загрузка образа с Mac через Tailscale (~420 MB) — раз на serial; если медленно, позже `download-url` на ноде (требует `Sys.Modify` на ноде, сейчас не берём).
- В Ubuntu 26.04 sshd через `ssh.socket` и генератор: проверить, что `ListenAddress` из `sshd_config.d` действительно даёт только loopback (проверка §10 п. 4).
- Автообновление CLI агентов: какие из них настраиваются системно — проверить при реализации; где нельзя, оставить как есть и записать.
- Google держит в `dl.google.com` только свежие версии Chrome: повторная сборка со старым `versions.toml` может не найти `.deb`. Тогда сборка падает на шаге `30-toolchains`, и нужен `--refresh`.
- Размер образа вырастет из-за Chrome, JDK и ffmpeg (оценка +1 GB в thin pool); на время загрузки это не влияет (сервисов они не добавляют), проверка — `sbx-bench s5`.
- `systemd.machine_id=firmware` с пустым `/etc/machine-id`: убедиться, что systemd не считает загрузку first boot и machine-id записывается на диск (`systemd-machine-id-commit`), проверка §10 п. 2 и 13.
