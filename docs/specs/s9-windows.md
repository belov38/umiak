# S9. Windows: спецификация

Статус: согласовано (master-сессия), 2026-10-29; ревью исполнителем пройдено, замечания внесены. Изменение scope от Ильи (2026-10-29): в MVP только `windows` (Windows 11), Windows Server Core перенесён в фазу 2 (§22). Область S9 из `docs/roadmap.md`. Архитектура: `docs/architecture.md` (§4 агент, §5 хранилище, §6 warm pool, §8 рабочий стол, §11 безопасность). Опирается на `docs/specs/s5-linux-template.md` (пайплайн `sbx-tpl`, который здесь расширяется), `docs/specs/s3-guest-agent.md` (агент, §18 переносимость), `docs/specs/s1-proxmox-foundation.md` (`DiskSet`, snapshot с паузой vCPU), `docs/specs/s6-control-plane.md` (пул, учёт RAM, дедлайны §7.9), `docs/specs/s4-gateway.md` (§9 SSH), `docs/specs/s2-tunnel-protocol.md` (§5.2 smbios).

Решения разделов вопросов 1–4 (пул через спящий режим, секреты на Windows, содержимое образа, идентичность и процессы) согласованы с master-сессией 2026-10-29. Пометка **[S9]** — решение автора спеки в рамках согласованного; его можно менять без нового согласования, если причина записана.

## 1. Зачем и что считается успехом

Шаблон `windows` (Windows 11) даёт агентам и людям Windows-sandbox с тем же API, что у Linux: exec (PowerShell), файлы, порты, SSH, а также рабочий стол (S10). `windows-core` (Windows Server 2025 Core) — фаза 2 (§22). Windows медленно загружается, требует больше RAM, переименовывается только с перезагрузкой и не умеет tmpfs. Спека решает, как при этом сохранить свойства платформы: быстрый claim, чистый fork, отсутствие ручных шагов в сборке и честно описанные отступления.

Успех:
1. Одна команда с Mac собирает шаблон из ISO пользователя и `virtio-win`: установка, инструменты, агент, sysprep, проверка, регистрация. Человек в консоль VM не заходит: Tamper Protection Defender, «Press any key to boot from CD», OOBE обходятся автоматически.
2. Тот же реестр, версии, `promote`, откат и `gc`, что у S5.
3. Claim Windows-sandbox из пула в PoC не дольше 30 s (машина пула спит на диске и не занимает RAM, §14).
4. Fork и VM из saved snapshot получают новую идентичность (имя, `MachineGuid`, SSH host keys, пустое состояние агента) до входа пользователя и сохраняют данные пользователя, включая DPAPI.
5. Команды, PTY, файлы, порты, SSH, обновление агента работают на Windows с той же семантикой, что на Linux, кроме отступлений, перечисленных в §12.
6. У `windows` после загрузки есть разблокированная сессия `user` с helper-процессом, на которую опирается S10.

## 2. Цели, не-цели, анти-цели

**Цели:** рецепт `windows`; ветка `iso-install` в `sbx-tpl` (носители, autounattend, шаги PowerShell через QGA, sysprep, offline-этап WinPE); содержимое образа; железо; проверка; агент на Windows (служба, ConPTY, job objects, NTFS, идентичность, quiesce через VSS, секреты, обновление); хуки рабочего стола для S10; пул через спящий режим (`qm suspend --todisk`); замеры; ограничения лицензирования; изменения в S1/S2/S3/S4/S5/S6/S7.

**Не-цели:** стриминг рабочего стола и computer-use (S10); Linux-шаблон (S5); control plane целиком (S6, здесь только изменения); gateway (S4); юридические решения о лицензиях; Docker, WSL2, Hyper-V и VBS внутри гостя; Windows Server Core (фаза 2, §22), Windows 10, Server Desktop Experience и другие редакции (рецепт параметризован, но в MVP проверяется только Windows 11); stop пользовательских sandbox через спящий режим (эксперимент фазы 2, §14.6).

**Анти-цели** (провал, даже если всё работает):
- сборка требует действий человека в консоли VM или root на хосте;
- в образе есть открытый наружу сервис: RDP, WinRM, SMB-сервер, sshd не на loopback, правило firewall, разрешающее входящие;
- два клона делят имя компьютера, `MachineGuid`, SSH host keys, vTPM или состояние агента; два клона шаблона делят пароль `user` (fork сохраняет пароль источника намеренно, §11.2);
- в образе остались пароль сборки в `unattend.xml`, логи сборки, установщики или секреты сборки;
- жёсткая остановка (штатная в S6) отправляет следующую загрузку в Automatic Repair или в меню восстановления;
- пользовательский процесс видит файлы секретов прошлой загрузки или источника fork до того, как агент их стёр;
- saved snapshot (`kind=saved`) несёт файлы секретов;
- Windows Update, Defender или Store меняют машину во время жизни sandbox (перезагрузка, установка, нагрузка на CPU).

## 3. Ограничения

- Хост `pve`: Proxmox VE 9.2.21, ядро 7.0.14, CPU Intel Core Ultra 9 285HX (nested virtualization включена на хосте), `pve-edk2-firmware` 4.2026.08, `swtpm` 0.8.0. PoC: VMID 500–599, RAM всех VM платформы ≤ 8 GB, `local-lvm`, сеть `sbx0` (S1 §4.3).
- Доступ сборщика — токен `sbx@pve!poc` и `sbx-node` (S5 §3). Root SSH не используется. Новые права и операции — только из §18.1.
- ISO Windows и лицензия — ответственность пользователя (решение Ильи). Платформа даёт пайплайн, проверяет checksum и ничего не активирует сама.
- Проверено 2026-10-29 (при реализации перепроверить; в коммит идёт результат `sbx-tpl versions --update`):
  - Windows 11 26H2 — сборка 26300, GA с 2026-09-29; Evaluation Center отдаёт Windows 11 Enterprise 26H2 Evaluation (90 дней);
  - virtio-win: стабильная в fedorapeople — 0.1.302 (2026-08-27), но у неё известные проблемы (TRIM через vioscsi, обходной путь в конфиге QEMU, сообщения о регрессиях VSS). Proxmox рекомендует 0.1.271. На `pve` лежит `local:iso/virtio-win.iso` = 0.1.302 (Ильи, не используем);
  - PowerShell 7.6.9 (LTS), Git for Windows 2.56.0.windows.4, Node 26.13.0 (LTS), Python 3.15.2, Go 1.27.3, Bun 1.4.4, uv 0.13.6, gh 2.103.3;
  - Win32-OpenSSH на GitHub (10.4.0.0p1) помечен «preview, non-production»; поддерживаемый путь — встроенный OpenSSH Windows (на Windows 11 — Feature on Demand).
- Шаблон Ильи 9001 и его каталог `~/prj-other/home-server/pve/win11-template` — источник опыта (TRIM, Tamper Protection, MSIX и sysprep, сеть во время установки), но не зависимость: S9 их не трогает и не использует.

## 4. Обзор

```
 Mac (PoC)                                                  pve
 +--------------------------------------------------+
 | sbx-tpl build windows --iso local:iso/<user.iso>  |
 |  1 verify user ISO sha256 (sbx-node media.sha256) |
 |  2 fetch virtio-win <pinned>, upload once         |
 |  3 render build ISO: autounattend.xml, build/     |
 |  4 create build VM: OVMF+SB, efidisk0, tpmstate0, |--> PVE API
 |    scsi0, net0 link_down=1, 3 CD-ROMs             |
 |  5 start + sendkey (Press any key), WinPE install |
 |    -> specialize -> OOBE -> SetupComplete: QGA    |
 |  6 steps (PowerShell, scheduled task, logs by     |
 |    offset via QGA); link up after policies        |
 |  7 cleanup, sbx-agent seal, sysprep /generalize   |
 |    /oobe /shutdown                                |
 |  8 offline stage: boot WinPE from the Windows ISO |
 |    with an offline autounattend: SYSTEM hive edit |
 |    (Defender, WaaSMedic), shutdown                |
 |  9 detach media, convert to template              |
 | 10 verify: clone, specialize, checks, identity    |
 |    change reboot, hard stop, hibernate + resume   |
 | 11 manifest -> registry (ready); promote          |
 +--------------------------------------------------+
```

## 5. Рецепты

Каталог `infra/templates/windows/` в формате S5 §5. Общие файлы Windows — в `infra/templates/_windows/` (шаги, unattend-шаблоны, `files/`), рецепт ссылается на них **[S9]**, чтобы рецепт фазы 2 (§22) их переиспользовал.

```yaml
# infra/templates/windows/template.yaml
slug: windows
os: windows
extends: null
source:
  kind: iso-install
  family: client                       # client | server; ISO, edition and key come from versions.toml [iso]
  drivers: w11                         # virtio-win subfolder: w11 | 2k25
  locale: { formats: en-US, keyboard: en-US, timezone: UTC }   # UI language = the image's own
disk: { slot: scsi0, size: 96G }
hw:
  machine: pinned                      # builder pins the newest pc-q35-<x>+pve<n> at build time, recorded in hw
  cpu: host
  bios: ovmf
  ostype: win11
  scsihw: virtio-scsi-single
  agent: "enabled=1"
  vga: std                             # S10 may change
  tablet: 1                            # absolute pointer for the console and computer-use
  rng0: "source=/dev/urandom"
  efidisk0: { efitype: 4m, pre-enrolled-keys: 1, ms-cert: 2023k }
  tpmstate0: { version: v2.0 }
  cloudinit: false
build_vm: { cores: 4, memory_mb: 4096 }
steps: [00-base, reboot, network-up, 10-system, 30-toolchains, 40-coding-agents, 50-sbx-agent, 60-desktop, 90-cleanup]
seal: sysprep
offline: [defender-off, waasmedic-off]
options: { vs_buildtools: false }
pool: { mode: hibernated }             # default mode for poolTargets of this template (§14)
size_default: { vcpu: 2, memory_mb: 4096 }
boot_timeout_s: 1200
verify: windows-desktop
```

Рецепт `windows-core` — фаза 2 (§22).

Встроенные шаги сборщика: `reboot` (как в S5, но через `shutdown /r /t 0`) и `network-up` (`net0 link_down=0`, ожидание IPv4).

### 5.1 `versions.toml` (Windows)

```toml
[iso]                        # user's ISO in local:iso, see §6.1 (PoC: Ilia's retail ISO)
file = "Windows11_Client_x64_en-gb_26300_9457.iso"
sha256 = "7e3f373b...df98a5d"
edition = "Windows 11 Pro"   # /IMAGE/NAME in install.wim
product_key = "generic-pro"  # name of a public generic key in infra/templates/_windows/keys.toml; null for eval media
channel = "retail"           # retail | evaluation | volume: what verify expects from licensing (§15 item 17)

[virtio_win]                 # pinned to the version Proxmox recommends, not "stable"
version = "0.1.271"
sha256 = "..."

[tools]                      # official installers/archives, sha256 from the vendor or computed by --update
pwsh = { version = "7.6.9", sha256 = "..." }          # MSI
git = { version = "2.56.0.windows.4", sha256 = "..." } # Git-64-bit.exe
node = { version = "26.13.0", sha256 = "..." }        # MSI
python = { version = "3.15.2", sha256 = "..." }       # python.org amd64 installer
go = { version = "1.27.3", sha256 = "..." }           # MSI
bun = { version = "1.4.4", sha256 = "..." }           # zip
uv = { version = "0.13.6", sha256 = "..." }           # zip
gh = { version = "2.103.3", sha256 = "..." }          # MSI

[npm]                        # same packages as linux (S5 §6.3)

[vs_buildtools]              # only with options.vs_buildtools = true
channel = "..."
```

- `--update` для Windows дополнительно сверяет virtio-win с рекомендацией Proxmox (страница Windows VirtIO Drivers в wiki Proxmox) и предупреждает, если `stable` новее закреплённой версии. Автоматически версия virtio-win не повышается: только явное изменение файла после зелёного `verify` (§15, проверки VSS и TRIM).
- `[iso]` описывает ISO конкретной инсталляции; файл коммитится, как и остальные версии. Флаги `--iso`, `--iso-sha256`, `--edition`, `--product-key-file` переопределяют его для одной сборки, итог пишется в манифест. В git — только публичные generic-ключи Microsoft (они выбирают редакцию, но не активируют); настоящий ключ передаётся файлом и в манифест не попадает.
- **PoC:** `windows` собирается и проверяется на ISO Ильи (Windows 11 Pro 26300 retail, без активации). Политики, которые Pro не соблюдает (нулевая телеметрия, `NoLockScreen`), проверяются по результату (§15). Enterprise Evaluation — тот же рецепт с другим `[iso]`, отдельной проверки в PoC нет.

## 6. Носители сборки

### 6.1 ISO пользователя

- Пользователь сам кладёт ISO в `local:iso` с исходным именем Microsoft (через веб-интерфейс Proxmox или `sbx-tpl iso upload <file>`: загрузка через PVE API тем же правом, что у S5). Сборщик его только читает и никогда не удаляет (`media.remove` его не касается, §18.1).
- Ожидаемые имена (сборщик их не требует, но `preflight` подсказывает):
  - Windows 11 Enterprise Evaluation: `*CLIENTENTERPRISEEVAL_OEMRET_x64FRE_*.iso`;
  - retail multi-edition (как у Ильи): `Windows11_Client_x64_*.iso` или `Win11_*_x64*.iso`, редакция выбирается `edition` и обычно требует generic-ключа в `product_key`.
- **Checksum.** Сборщик вызывает `sbx-node media.sha256 <file>` (новая операция только на чтение, §18.1) и сравнивает с `[iso] sha256`. Значение берётся со страницы загрузки Microsoft, если оно там опубликовано, иначе пользователь считает его у себя (`shasum -a 256`) до загрузки на хост. Несовпадение → сборка не начинается. Первая сборка с новым ISO: `--accept-iso-sha256` печатает вычисленное значение и записывает его в `versions.toml` (файл потом коммитится).
- Редакцию внутри ISO сборщик заранее не проверяет (на хосте нет `wimlib`, ставить пакеты нельзя). Неверная `edition` проявится как отсутствие ответа QGA до `install_timeout` (40 min) с подсказкой в ошибке; `--keep-on-failure` оставляет VM для консоли.

### 6.2 virtio-win

Сборщик скачивает `virtio-win-<v>.iso` из `fedorapeople.org/.../archive-virtio/virtio-win-<v>-1/` в кэш `~/.cache/sbx/images/`, проверяет sha256 из `versions.toml` и загружает один раз на версию как `local:iso/sbx-virtio-win-<v>.iso`. ISO Ильи `virtio-win.iso` не используется.

### 6.3 Build ISO

`local:iso/sbx-build-<buildId>.iso`, метка тома `SBXBUILD` (Joliet; `hdiutil` или `xorriso`, как S5 §7.2 п. 3):

```
autounattend.xml            # rendered: edition, product key, build password, driver paths
build/
  SetupComplete.cmd         # installs virtio guest tools + QGA, logs to C:\sbx-build\logs
  run-step.ps1              # step wrapper: transcript to <n>.log, exit code to <n>.exit
  steps/*.ps1, files/       # from infra/templates/_windows + recipe
  versions.toml, agent.toml
  sbx-agent-<v>-windows-amd64.tar
  ssh-user-ca.pub           # optional (--ssh-user-ca)
  sbx-unattend.xml          # sysprep answer file (§10.2)
```

Пароль сборки — случайный, генерируется на сборку, живёт только в `autounattend.xml` этого ISO и в памяти сборщика. ISO удаляется после сборки (`media.remove`). На каждом клоне пароль `user` меняется при первой загрузке (§11.2).

### 6.4 Offline ISO

`local:iso/sbx-offline-<buildId>.iso`, метка `SBXOFFL`: `autounattend.xml` только с проходом `windowsPE` (`RunSynchronous` → `offline.cmd`) и `offline.cmd` (§10.3). Удаляется после сборки.

## 7. Сборка (`iso-install`)

Этапы S5 §7.2 с отличиями:

1. **Подготовка.** Проверка пакета агента (`os/arch = windows/amd64`), ISO пользователя (§6.1), virtio-win (§6.2). Запись в реестре `building`.
2. **Носители.** Build ISO и offline ISO (§6.3, §6.4).
3. **Сборочная VM.** `POST /nodes/{node}/qemu`: железо из `hw`, `efidisk0=local-lvm:1,efitype=4m,pre-enrolled-keys=1,ms-cert=2023k`, `tpmstate0=local-lvm:1,version=v2.0` (у `windows`), `scsi0=local-lvm:<size>,discard=on,iothread=1,ssd=1`, `net0=virtio=<MAC>,bridge=sbx0,firewall=1,link_down=1`, `ide2=<user ISO>,media=cdrom`, `sata1=sbx-virtio-win-<v>.iso`, `sata2=sbx-build-<id>.iso`, `boot=order=scsi0;ide2`, `vmstatestorage=local-lvm`, `balloon=0`, теги и имя как в S5. Сеть выключена (`link_down=1`), пока шаг `00-base` не выставит политики: иначе Windows Update и обновления Store во время OOBE ломают sysprep (опыт 9001).
4. **Установка.** Start, затем `sendkey ret` раз в секунду 20 s (`PUT …/sendkey`, право `VM.Console`, §18.1): загрузчик ISO ждёт «Press any key to boot from CD». Дальше без участия: WinPE ставит драйверы `vioscsi`, `NetKVM` из virtio-win, размечает диск, ставит редакцию; specialize; OOBE по ответам; `SetupComplete.cmd` ставит `virtio-win-gt-x64.msi` и `qemu-ga-x86_64.msi`. Сборщик ждёт `agent/ping` до `install_timeout` (40 min) **[S9]**.
5. **Шаги.** Каждый шаг — scheduled task от SYSTEM, созданная и запущенная через QGA (`schtasks /create /ru SYSTEM /tr "powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:\build\run-step.ps1 -Step <n>"` и `/run`). Так шаг переживает перезапуск QGA и не упирается в его тайм-ауты (аналог transient unit в S5). `run-step.ps1` находит build ISO по метке тома, пишет лог `C:\sbx-build\logs\<n>.log` и код выхода `<n>.exit`. Сборщик раз в 2 s опрашивает `<n>.exit` и дочитывает лог через `agent/file-read` с offset (как S5). Шаги до `10-system` идут в Windows PowerShell 5.1, после установки PowerShell 7 — в `pwsh` (решает `run-step.ps1` по заголовку шага).
6. **Запечатывание.** `90-cleanup`, затем `sbx-agent seal` (§12.11), затем асинхронно через QGA `sysprep.exe /generalize /oobe /shutdown /quiet /unattend:C:\Windows\System32\Sysprep\sbx-unattend.xml`. Ожидание `stopped` до 30 min. При ошибке в манифест попадают последние строки `C:\Windows\System32\Sysprep\Panther\setuperr.log`: сборщик читает их через QGA до выключения. Если sysprep упал, VM ещё работает.
7. **Offline-этап** (§10.3): `sata2` → offline ISO (virtio-win остаётся на `sata1`), `boot=order=ide2`, start, `sendkey`, ожидание `stopped` (до 10 min). Затем `delete=ide2,sata1,sata2`, `boot=order=scsi0`, `net0 link_down=0`.
8. **Template.** `POST …/template`. Диски становятся `base-<vmid>-disk-<k>` для `efidisk0`, `scsi0`, `tpmstate0` (порядок `k` записывается в `disk_layout`). Удалить build ISO и offline ISO (`media.remove`).
9. **Проверка** (§15) и манифест (S5 §11 + поля §15.2).

Ошибка на любом этапе — как в S5 §7.2. Ожидаемая длительность: 50–80 min (установка 10–15, инструменты 15–25, очистка компонентов 10–20, sysprep 5–10).

## 8. Содержимое образа

Ниже — что должно быть в образе; конкретные ключи реестра, списки пакетов и способ записи решает исполнитель в `steps/` и `files/`. Всё проверяется профилем §15.

### 8.1 Система и службы (`00-base`)

- **Политики до сети:** Windows Update (`NoAutoUpdate=1`; серверы Windows Update не блокируются, потому что из них ставится OpenSSH FoD в `10-system`; служба `wuauserv` выключается в `90-cleanup`), Store (`AutoDownload=2`, без автообновлений приложений), consumer features и CloudContent выключены, Delivery Optimization выключен, телеметрия на минимальном уровне редакции (0 для Enterprise и Server, 1 для Pro), Error Reporting выключен, Edge без first-run и без фоновых обновлений, Copilot, Widgets, Spotlight, советы и рекомендации Start выключены, OneDrive не ставится.
- **Службы выключены** (Disabled): `wuauserv`, `UsoSvc`, `DoSvc`, `WSearch`, `SysMain`, `DiagTrack`, `dmwappushservice`, `MapsBroker`, `lfsvc`, `WerSvc`, `RemoteRegistry`, `Spooler`, `SSDPSRV`, `FDResPub`, `LanmanServer` (нет SMB-сервера и порта 445), `TermService` (RDP), `WinRM`. `WaaSMedicSvc` защищён от изменения онлайн и выключается offline-этапом (§10.3). Запланированные задачи обслуживания (дефрагментация, Compatibility Appraiser, CEIP, автоматическое обслуживание) выключены.
- **Defender полностью выключен** offline-этапом (§10.3) — службы и драйверы `WinDefend`, `WdNisSvc`, `Sense`, `WdBoot`, `WdFilter`, `WdNisDrv` с `Start=4`. Движок не запускается, поэтому Tamper Protection не возвращается (проверено Ильёй на 9001). Почему выключен: граница доверия — VM, Windows Update выключен, а сканирование заметно тормозит `npm install` и сборки.
- **Питание и загрузка:** схема High performance, сон и отключение монитора — никогда, спящий режим гостя выключен (`powercfg /h off`, нет `hiberfil.sys`), Fast Startup выключен. Для BCD: `bootstatuspolicy ignoreallfailures`, `recoveryenabled no`; WinRE выключен (`reagentc /disable`), раздела восстановления нет. Это аналог `GRUB_RECORDFAIL_TIMEOUT=0`: жёсткая остановка не должна приводить к Automatic Repair.
- **Память и секреты** (решение master, §12.8): pagefile включён фиксированного размера (2 GiB **[S9]**: commit = RAM + pagefile, а время очистки при выключении ограничено), `ClearPageFileAtShutdown=1`, дампы памяти выключены (`CrashDumpEnabled=0`). Выключены System Restore и запланированные теневые копии; службы VSS (`VSS`, `swprv`) остаются в режиме Manual: на них работает `fsfreeze` QGA (§12.10).
- **Прочее:** часовой пояс UTC, локаль и раскладка en-US, системная кодовая страница UTF-8 (ACP/OEMCP 65001), `LongPathsEnabled=1`, Developer Mode (символические ссылки без повышения), VBS и HVCI выключены (с `cpu: host` и nested virt на хосте Windows иначе включает Hyper-V под собой и замедляется). Для w32time: NTP `time.windows.com`, `MaxPosPhaseCorrection` и `MaxNegPhaseCorrection` = `0xFFFFFFFF` (большие скачки после пробуждения, §14.3).
- **Firewall включён** во всех профилях: входящие запрещены, все предустановленные разрешающие входящие правила выключены, уведомления о новых слушателях выключены (`NotifyOnListen=False`, иначе диалог «разрешить доступ» мешает computer-use). Loopback firewall не фильтрует, поэтому CONNECT агента и sshd на loopback работают. Дальнейшая защита — firewall Proxmox (`policy_in=DROP`, S1 §4.4).
- **Appx (`windows`):** удалить provisioned-пакеты, которые не нужны sandbox и ломают sysprep при обновлении (Teams, новый Outlook, Clipchamp, News, Weather, Xbox, Solitaire, Bing, Feedback Hub, Get Help, Office Hub, To Do, Copilot и т.п.; список — `files/appx-remove.txt`). Оставить Edge, Terminal, Notepad, Calculator, Paint, Snipping Tool, Photos, Store и App Installer (`winget` для пользователя). В профиле `user` до sysprep никто не входит, поэтому per-user MSIX, ломающих sysprep (`0x80073cf2`, опыт 9001), нет.

### 8.2 Пользователи и вход (`10-system`)

- Локальный `user` в группе Administrators. Его создаёт OOBE сборки (`LocalAccounts` в `autounattend.xml`) с паролем сборки. Срок действия пароля не ограничен, до sysprep в профиль никто не входит. Встроенный Administrator выключен. Других включённых локальных учётных записей нет (Guest, DefaultAccount, WDAGUtilityAccount выключены).
- Пароль `user` меняется на каждом клоне (§11.2) и хранится только в LSA secrets (`DefaultPassword` для autologon, `L$sbx_user` для агента). В файлах его нет.
- UAC включён (`EnableLUA=1`: без него не работают MSIX-приложения, в том числе Terminal), но без запросов: `ConsentPromptBehaviorAdmin=0`, `PromptOnSecureDesktop=0`.

### 8.3 SSH

- Встроенный OpenSSH Server ставит `Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0` (Feature on Demand из Windows Update; служба `wuauserv` выключается только в `90-cleanup`) **[S9]**. Win32-OpenSSH с GitHub не используется: все его релизы помечены «non-production». Если FoD недоступен, запасной вариант — флаг рецепта `openssh: github` (MSI той же сборки, что у 9001), без смены остальной схемы.
- `C:\ProgramData\ssh\sshd_config`: `ListenAddress 127.0.0.1`, `ListenAddress ::1`, `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `PubkeyAuthentication yes`, `TrustedUserCAKeys __PROGRAMDATA__/ssh/sbx_user_ca.pub`. Блок `Match Group administrators` с `administrators_authorized_keys` остаётся по умолчанию; файла нет, вход только по сертификату (S4 §9.3, принципал `user`).
- `HKLM\SOFTWARE\OpenSSH\DefaultShell` = `C:\Program Files\PowerShell\7\pwsh.exe` (S4 §13: shell по умолчанию PowerShell).
- Служба `sshd` — **Manual**: её запускает агент после проверки идентичности (§12.3). Так sshd никогда не работает со старыми host keys. Правило firewall `OpenSSH-Server-In-TCP` удаляется.
- `C:\ProgramData\sbx-agent\ssh-user-ca.pub` — ключи CA шаблона (из `--ssh-user-ca` или пустой файл); `sbx_user_ca.pub` — его копия с ACL, которого требует sshd (владелец SYSTEM, запись только SYSTEM и Administrators).
- Известное ограничение Windows OpenSSH: вход по ключу или сертификату даёт S4U-токен без сетевых учётных данных. В SSH-сессии не работают Credential Manager и DPAPI пользователя (например, хранение токена `gh` в Windows Credential Manager). Команды агента от этого не страдают (§12.5). Ограничение записывается в документацию S7.

### 8.4 PowerShell и профили

- PowerShell 7 LTS (MSI, all users, в `PATH`, без телеметрии: `POWERSHELL_TELEMETRY_OPTOUT=1` в системном env). Windows PowerShell 5.1 остаётся.
- Профили AllUsersAllHosts (`$PSHOME\profile.ps1` у pwsh 7 и у 5.1): если `SBX_ENV_APPLIED` не задан, выполнить `sbx-agent env --format pwsh` и применить результат. Так SSH-сессии получают env sandbox (§12.7). Команды агента приходят с `SBX_ENV_APPLIED=1`, поэтому профиль не перетирает их env. Кодировка консоли — UTF-8.

### 8.5 Инструменты (`30-toolchains`, `40-coding-agents`)

Правило как у S5 §8.9: каждая команда находится по имени из системного `PATH` — и у `user` в командах агента (прямой exec и `pwsh -Command`), и в SSH-сессии.

| Инструмент | Как ставится **[S9]** |
|---|---|
| Git for Windows (+ Git Bash) | официальный установщик, тихо, all users; `core.autocrlf=false`, `core.symlinks=true` на уровне system. Git Bash нужен Claude Code на Windows (`CLAUDE_CODE_GIT_BASH_PATH` в системном env) |
| PowerShell 7 | §8.4 |
| Node LTS (+ npm, npx) | MSI. Глобальный prefix npm = `C:\ProgramData\npm` (в системном `PATH`), иначе `npm -g` от SYSTEM пишет в профиль SYSTEM |
| Python 3 | установщик python.org: all users, `PrependPath`, `py` launcher; `uv`, `uvx` — zip в `C:\Program Files\uv` |
| Bun | zip → `C:\Program Files\bun` |
| Go | MSI |
| gh | MSI |
| Claude Code, Codex, OpenCode, Gemini CLI | `npm install -g <pkg>@<version>` (версии как у S5) |
| VS Build Tools (C++), Rust (MSVC) | только при `options.vs_buildtools: true` (решение master: выключено по умолчанию из-за лицензии Visual Studio и +6–8 GB) |

- Нет: Docker, WSL2, Hyper-V, JVM, Chrome (S10 решит браузер для computer-use; Edge есть в Windows 11).
- Автообновление CLI выключается там, где это настраивается системно (как S5).

### 8.6 Агент (`50-sbx-agent`)

- `sbx-agent install-package D:\build\sbx-agent-<v>-windows-amd64.tar` (§12.12) → `C:\Program Files\sbx-agent\versions\<v>\`, junction-ы `current`, `previous`, служба `sbx-agent` (§12.2), `C:\ProgramData\sbx-agent\agent.toml` (§12.1).
- Startup-скрипт компьютера в локальной групповой политике: `sbx-agent.exe early` (§12.3) и `SyncForegroundPolicy=1`, чтобы он завершался до входа.
- `qemu-guest-agent` (служба `QEMU-GA`) — автоматический запуск, запасной канал. `VSS provider` из virtio-win guest tools зарегистрирован (нужен для `fsfreeze`, §12.10).

### 8.7 Рабочий стол (`60-desktop`)

- Scheduled task `\sbx\session`: триггер «при входе `user`», `RunLevel Highest`, перезапуск при сбое раз в минуту, действие `C:\Program Files\sbx-agent\current\sbx-session.exe` (§13).
- Ключи Winlogon для autologon пишет `identity apply` (§11.2), не сборка.
- Без экрана блокировки: `NoLockScreen=1` (там, где редакция это соблюдает: Enterprise, Education, Server), `powercfg CONSOLELOCK 0` (вход при пробуждении не требуется), экранная заставка выключена. В Default User hive: `DisableLockWorkstation=1`, выключены анимация первого входа (`EnableFirstLogonAnimation=0`), privacy experience, «давайте завершим настройку» (SCOOBE), предложение PIN и Windows Hello, уведомления-советы. Профиль `user` создаётся при первом autologon из Default User.

### 8.8 Очистка (`90-cleanup`)

- Службы `wuauserv`, `UsoSvc` → Disabled (до этого они нужны FoD).
- `Dism /Online /Cleanup-Image /StartComponentCleanup /ResetBase`; удалить `C:\sbx-build`, `C:\Windows\Temp\*`, загрузки и кэши установщиков (`npm`, `pip`, `uv`, `go`), `C:\Windows\Panther\unattend*.xml` и копии ответов (в них пароль сборки); очистить журналы событий.
- Записать `C:\ProgramData\sbx-template\build.json` (манифест без проверочной части).
- `Optimize-Volume -DriveLetter C -ReTrim`: ошибка не фатальна, пока TRIM через vioscsi не исправлен (§23).
- Проверить: служб из §8.1 нет в состоянии Running/Automatic, нет файлов `authorized_keys`, нет пароля в `Panther`.

## 9. Железо шаблона

Конфиг template VM = `hw` рецепта + диски (§5). Почему так **[S9]**:
- **OVMF + Secure Boot с ключами Microsoft 2023, vTPM 2.0** — требования Windows 11, обходы проверок железа не нужны.
- **Свой vTPM у каждой machine из шаблона.** Копия `tpmstate0` шаблона дала бы всем sandbox одинаковые ключи TPM (EK, SRK) и данные владения. Поэтому S1 `create` из шаблона не клонирует `tpmstate0`, а создаёт новый (`tpmstate0=local-lvm:1,version=v2.0`, Proxmox выделяет том, swtpm инициализирует его при первом старте), и Windows на specialize видит новый TPM. Fork и VM из snapshot копируют `tpmstate0` источника вместе с дисками: это копия той же машины. `efidisk0` клонируется всегда (ключи Secure Boot и загрузочные записи).
- **BitLocker и автоматическое шифрование устройства запрещены** (`PreventDeviceEncryption=1` в specialize установки): с TPM и Secure Boot Windows 11 может включить его при установке. Это сломало бы offline-этап и sysprep и записало бы весь диск в thin pool.
- **`machine` закреплён** (сборщик берёт новейшую `pc-q35-<x>+pve<n>` на момент сборки, сейчас `pc-q35-11.0+pve2`, как у 9001): смена версии machine type меняет устройства для Windows. S1 копирует `machine` из шаблона, клоны наследуют закреплённую версию.
- **`cpu: host`** с выключенными в госте VBS и HVCI (§8.1). Эксперимент §16.3 сравнивает с `x86-64-v3`.
- **`args` не используется:** его может задать только root, а обходной путь TRIM у 9001 (`discard_granularity=65536`) требует `args`. Вместо этого закреплён virtio-win 0.1.271; после выхода драйвера с исправлением TRIM (virtio-win #1574, исправлен в коде 2026-10-15) проверка TRIM становится обязательной (§15, §23).
- `balloon=0` (S1), `rng0` (драйвер `viorng` из virtio-win), `vga: std` (S10 решит видео), `vmstatestorage=local-lvm` (для спящего режима, §14).
- Размер по умолчанию в PoC: 2 vCPU / 4 GB (минимум Windows 11). Диск thin 96 GiB.

## 10. Запечатывание

### 10.1 Порядок

`90-cleanup` → `sbx-agent seal` → `sysprep /generalize /oobe /shutdown` → offline-этап → template. Sysprep выполняется один раз на шаблон. Specialize проходит каждая machine пула при первой загрузке; это время скрывает пул (решение master, §11.1).

### 10.2 `sbx-unattend.xml` (ответы для клонов)

- `generalize`: `PersistAllDeviceInstalls=true` (драйверы virtio не переустанавливаются, specialize короче), `SkipRearm=0`.
- `specialize`: `RunSynchronous` → `"C:\Program Files\sbx-agent\current\sbx-agent.exe" identity apply --specialize` (§11.2). Имя компьютера ставит агент; если для этого нужна заглушка `ComputerName` в Shell-Setup или определённый порядок компонентов, это выбирает исполнитель. Требование проверяется §15 п. 2: machine пула становится warm с именем `SBX<12 hex>` без перезагрузок сверх тех, что делает сам setup.
- `oobeSystem`: все экраны OOBE скрыты (`HideEULAPage`, `HideOEMRegistrationScreen`, `HideOnlineAccountScreens`, `HideWirelessSetupInOOBE`, `ProtectYourPC=3`), локаль en-US, UTC. Новых учётных записей нет (`user` уже существует), autologon здесь не задаётся (его пишет агент).
- Файл лежит в `C:\Windows\System32\Sysprep\` и паролей не содержит. После первой загрузки setup сам заменяет копии ответов в `Panther`; агент удаляет `sbx-unattend.xml` на клоне в `identity apply`.

### 10.3 Offline-этап WinPE

Нужен, потому что часть настроек нельзя изменить в работающей Windows: Tamper Protection блокирует Defender, `WaaSMedicSvc` защищён. Root на хосте (как `hivex` у 9001) у сборщика нет.

- VM грузится с ISO Windows пользователя; Windows Setup находит `autounattend.xml` на offline ISO и в проходе `windowsPE` выполняет `RunSynchronous` → `offline.cmd`. Сама установка не начинается: скрипт в конце выполняет `wpeutil shutdown`.
- `offline.cmd` (cmd и `reg.exe`, PowerShell в WinPE установки нет): загрузить драйвер диска (`drvload <virtio-win>\vioscsi\w11\amd64\vioscsi.inf`: в WinPE установки драйвера virtio нет, а `DriverPaths` из `windowsPE` действуют только на саму установку); найти том с `\Windows\System32\config\SYSTEM` (буква диска заранее не известна); `reg load HKLM\OFFSYS`; для каждого `ControlSet00x` выставить `Start=4` службам из `offline` рецепта (`defender-off`: шесть служб и драйверов §8.1; `waasmedic-off`: `WaaSMedicSvc`); `reg unload`; записать `\Windows\Setup\Scripts\sbx-offline.log`; `wpeutil shutdown`.
- Сборщик ждёт `stopped` до 10 min; лог читается позже, в verify. Ошибка в WinPE видна только как тайм-аут (QGA в WinPE нет); `verify` проверяет результат (§15 п. 8).
- **Риск пропущенного «Press any key».** В порядке загрузки только `ide2`, но OVMF может перейти к записи Windows Boot Manager в `efidisk0` и загрузить запечатанный диск, и тогда specialize испортит шаблон. Защита: `sendkey` начинается сразу после start и идёт 30 s. Если за время offline-этапа отвечает QGA (а в WinPE его нет), значит загрузился диск: сборка сразу `failed`, шаблон не создаётся. Исполнитель проверяет на спайке, учитывает ли OVMF Proxmox только `bootorder` из fw_cfg; если да, риск снимается.
- Почему не скрипт PE-этапа установки (как в unattend-generator Schneegans, где установку ведёт свой скрипт: diskpart, dism, правка hive, bcdboot): offline-этап короче, не заменяет Windows Setup и годится для любых будущих offline-правок.

## 11. Первая загрузка клона и идентичность

### 11.1 Machine пула (из шаблона)

1. Specialize: `identity apply --specialize` (§11.2), без перезагрузки от агента.
2. OOBE по ответам, без экранов.
3. Обычная загрузка: startup-скрипт `sbx-agent early` (идентичность совпадает, очистка секретов), служба `sbx-agent` запускает sshd, подключается к туннелю.
4. `windows`: autologon `user` → первый вход создаёт профиль → `\sbx\session` запускает `sbx-session` → фаза `desktop: ready` (§13).
5. Фаза `pool_ready` (§12.13) → S6 переводит machine в спящий режим (§14).

### 11.2 `identity apply`

Сравнивает `machineId` из smbios с `C:\ProgramData\sbx-agent\identity.json`. При совпадении ничего не делает. Иначе (fork, VM из saved snapshot, первая загрузка после `seal`):

1. Стереть состояние агента (как S3 §7.2 п. 1) и каталог секретов (§12.8); `env` пустой; `sbx_user_ca.pub` — копия шаблонной.
2. `MachineGuid` (`HKLM\SOFTWARE\Microsoft\Cryptography`) = `machineId`.
3. SSH host keys: удалить `C:\ProgramData\ssh\ssh_host_*`, создать новые (`ssh-keygen -A` из встроенного OpenSSH), выставить ACL, которых требует sshd.
4. Имя компьютера `SBX` + последние 12 hex `machineId` в верхнем регистре (15 символов — предел NetBIOS) через `SetComputerNameExW(ComputerNamePhysicalDnsHostname)`.
5. **Только для клона шаблона** (`identity.json` нет, то есть первая загрузка после `seal`): новый случайный пароль `user` (32 символа), `L$sbx_user`, у `windows` — ещё `DefaultPassword` и ключи Winlogon (`AutoAdminLogon=1`, `DefaultUserName=user`, `DefaultDomainName=.`). Профиля `user` в этот момент ещё нет, поэтому ничего не теряется. **Fork и VM из saved snapshot пароль не меняют:** сброс пароля администратором делает недоступными данные DPAPI пользователя (Credential Manager, токены `gh`, cookies Edge), а fork — копия той же машины. LSA secret копируется вместе с диском, autologon и токены агента продолжают работать.
6. Удалить `C:\Windows\System32\Sysprep\sbx-unattend.xml`, если он ещё есть.
7. Записать `identity.json` с `resetPending` (FlushFileBuffers).
8. Если действующее имя (`ActiveComputerName`) ≠ новое и это не режим `--specialize` — перезагрузка (`InitiateShutdownW`, причина «planned»). Fork и VM из saved snapshot поэтому загружаются на одну перезагрузку дольше (решение master: +15–25 s).

SID машины не меняется: домена нет, а дубликат machine SID вне домена ни на что не влияет. Следствие для будущего KMS: fork наследует CMID (§17).

Где выполняется (один и тот же код под глобальным именованным mutex): `--specialize` в проходе specialize; `sbx-agent early` при каждой загрузке до экрана входа; служба `sbx-agent` при старте как страховка (если startup-скрипт не отработал — с той же перезагрузкой и предупреждением в лог).

### 11.3 Hostname из claim

На Windows не применяется (решение master): переименование требует перезагрузки, а claim должен занимать доли секунды. Имя остаётся `SBX<12 hex>`. Агент отвечает на claim `hostname_applied = false` и отдаёт действующее имя в `System/Info.hostname`. Значение из claim доступно командам как env `SBX_HOSTNAME`.

## 12. Агент на Windows

Тот же бинарь и протоколы, что в S3. Ниже — реализации интерфейсов S3 §18 и все отличия семантики. Что не упомянуто, работает как в S3.

### 12.1 Каталоги

| Путь | Что | Linux-аналог |
|---|---|---|
| `C:\Program Files\sbx-agent\versions\<v>\` | `sbx-agent.exe`, `sbx-session.exe`, `manifest.json`, `manifest.sig`, `trust\` | `/usr/local/lib/sbx-agent/versions/<v>/` |
| `C:\Program Files\sbx-agent\current`, `previous` | junction-ы на версии; `current` в системном `PATH` | symlink-и |
| `C:\ProgramData\sbx-agent\agent.toml` | настройки шаблона | `/etc/sbx-agent/agent.toml` |
| `C:\ProgramData\sbx-agent\state\` | `state.db`, `commands\<id>\`, `uploads\`, `identity.json`, `pending-update.json`; ACL только SYSTEM | `/var/lib/sbx-agent/` |
| `C:\ProgramData\sbx-agent\run\` | сокеты, `status.json`, lease quiesce; очищается при старте, если сменился `bootId` | `/run/sbx-agent/` (tmpfs) |
| `C:\ProgramData\sbx-agent\logs\` | `agent.log` с ротацией (10 × 10 MiB), запись асинхронная | journald |
| `C:\ProgramData\sbx\secrets\` | `files\<name>` (§12.8) | `/run/sbx/secrets/` (tmpfs) |
| `C:\ProgramData\sbx-agent\ssh-user-ca.pub`, `C:\ProgramData\ssh\sbx_user_ca.pub` | ключи SSH CA шаблона и действующие | `/etc/sbx-agent/…`, `/etc/ssh/…` |

`agent.toml` у Windows: `[user] default = "user"`, `[docker] enabled = false`, `[readiness] required = ["identity", "claim", "secrets", "desktop"]`, `[ports] exclude = [22, 135]` и `exclude_processes` (§12.9).

### 12.2 Служба (`ServiceManager`)

- `sbx-agent`, LocalSystem, Automatic (не Delayed), `ImagePath = "C:\Program Files\sbx-agent\current\sbx-agent.exe" run`, через `golang.org/x/sys/windows/svc`. Приоритет процесса `ABOVE_NORMAL` (аналог `CPUWeight`).
- Принимает `SERVICE_CONTROL_PRESHUTDOWN` (тайм-аут 15 s): завершить job-ы команд, стереть секреты (§12.8), сбросить `state.db`.
- **Failure actions** (аналог `Restart=always` + `StartLimitBurst` + `OnFailure`): restart через 1 s, restart через 1 s, затем `run command` = `previous\sbx-agent.exe rollback` (если `previous` нет — `current`); период сброса 120 s; `FailureActionsOnNonCrashFailures=1`. Самообновление: агент отвечает и завершается с ненулевым кодом без `SERVICE_STOPPED`, SCM перезапускает его уже из новой версии (S3 §17.4 п. 5). `rollback` после переключения версии выполняет `sc start sbx-agent`.
- `READY` в смысле S5 §17.3 п. 4: служба переходит в `SERVICE_RUNNING` после открытия `state.db` и восстановления shim, не дожидаясь туннеля.

### 12.3 Загрузка

0. **Пока идёт Windows Setup** (specialize и OOBE клона; `ImageState` в `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Setup\State` ≠ `IMAGE_STATE_COMPLETE`), служба и `early` ничего не делают: никакой работы с идентичностью и никаких перезагрузок, служба ждёт. Идентичность в это время ставит только `identity apply --specialize` (§11.2).
1. **`sbx-agent early`** — startup-скрипт компьютера (локальная GPO): идентичность (§11.2, при смене — перезагрузка до входа), очистка каталога секретов (§12.8), очистка `run\` при новом `bootId`, маркер `run\early.json {bootId}`. Чтобы скрипт гарантированно завершался до входа (в том числе до autologon), включается политика «Always wait for the network at computer startup and logon» (`SyncForegroundPolicy=1`): без неё Fast Logon Optimization выполняет политику компьютера асинхронно. Цена — вход ждёт сеть, DHCP в `sbx0` отвечает за секунды; замер §16.
2. **Служба** (стартует параллельно со скриптом): ждёт `early.json` текущей загрузки до 60 s, иначе выполняет те же шаги сама. До этого `Start`, `Claim` и `UpdateSecrets` не обслуживаются (`unavailable identity_not_ready`). Затем шаги S3 §6 п. 2. После готовности идентичности агент запускает `sshd` (`Start-Service`, служба Manual, §8.3).

Почему не «до сети», как на Linux: на Windows сетевой стек — драйвер, и служба не может стартовать раньше него. На Linux порядок нужен из-за DHCP DUID, выведенного из machine-id. Windows использует client id по MAC, поэтому дубля IP у fork нет. Секреты по сети недоступны: SMB-сервера нет, входящие запрещены firewall Windows и Proxmox.

Требование master «до любого пользовательского процесса» держится на порядке, а не на ACL. `user` — администратор с повышенным токеном, а обход проверки каталогов (bypass traversal) даёт доступ к файлу по полному пути, если ACL самого файла его разрешает. Порядок такой: startup-скрипт с `SyncForegroundPolicy` до входа; команды агента — только после `early.json`; Остаётся один крайний случай: задача планировщика «при запуске», которую создал сам пользователь, запускается параллельно со startup-скриптом. Она может прочитать файлы секретов только своей же sandbox (после жёсткой остановки) или источника fork (fork наследует секреты по замыслу). VM из saved snapshot файлов секретов не несёт (§18.6 п. 5). Проверка приёмки §20 п. 5: файл-секрет, оставленный жёсткой остановкой, не виден программе автозапуска сессии `user`.

### 12.4 Идентичность (`IdentitySource`)

- **smbios:** `GetSystemFirmwareTable('RSMB')`, структура type 1: `uuid`, `serial` (`sbx1:…`, S2 §5.2), `family` (`sbxt1:<url>`, S5 §14). На Windows SMBIOS читает любой процесс без привилегий (на Linux `product_serial` читает только root). BS виден всем процессам VM. Это допустимо в рамках принятой модели (граница доверия — VM, S3 §4) и записывается в S2.
- **vmgenid:** `\\.\VmGenerationCounter`, `IOCTL_VMGENCOUNTER_READ` (16 байт) → заголовок `Sbx-Vmgenid` (hex). Только информационно: fork у нас всегда холодный старт, решение о смене идентичности принимается по `machineId`.
- **bootId:** UUIDv5 от `machineId` и счётчика загрузок `BootId` (`HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management\PrefetchParameters`). Пробуждение из спящего режима Proxmox — не загрузка, `bootId` не меняется, и это верно: процессы живы. Если счётчик окажется ненадёжным, исполнитель берёт время загрузки ядра (`NtQuerySystemInformation`) с проверкой устойчивости к смене часов и записывает причину.

### 12.5 Пользователи и токены (`Credentials`)

- `user` (по умолчанию): `LogonUserW(user, ".", <пароль из L$sbx_user>, LOGON32_LOGON_INTERACTIVE)` → связанный повышенный токен (`TokenLinkedToken`). Это аналог NOPASSWD sudo из S3 §4 (решение master). Токен с паролем, поэтому у процесса работают DPAPI и Credential Manager. Профиль загружается `LoadUserProfileW` на время команды.
- `SYSTEM`: токен самой службы. Имя `root` — псевдоним `SYSTEM` для переносимости скриптов **[S9]**.
- Другие имена → `invalid_argument user_not_found` (в v1 только эти два).
- Файлы, созданные агентом, получают владельцем пользователя запроса; ACL наследуется от родителя.

### 12.6 Процессы (`Supervisor`, `PTY`)

**Shim.** `sbx-agent shim --id <id>` запускается агентом с `CREATE_BREAKAWAY_FROM_JOB | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` из каталога своей версии. SCM при остановке или перезапуске службы дочерние процессы не убивает, поэтому shim и команды переживают перезапуск и обновление агента. Каталог версии с живыми shim-ами не удаляется (Windows всё равно не даст удалить работающий exe).

- **Job — постоянный именованный объект.** Shim создаёт job `\BaseNamedObjects\Global\sbx-cmd-<id>` через `NtCreateJobObject` с `OBJ_PERMANENT` (право `SeCreatePermanentPrivilege` у SYSTEM есть; вызов ntdll без cgo). Обычный именованный объект исчезает вместе с последним handle: процессы job handle на него не держат, и после смерти shim job нельзя было бы найти. Постоянный job переживает shim и агента до перезагрузки. Агент открывает его по имени (`OpenJobObject`) для `Kill`, `SIGKILL`, `KILL_LEFTOVERS` и восстановления. Постоянство снимает `NtMakeTemporaryObject`, когда команда завершилась без leftovers или её удалили (`Remove`, retention); после перезагрузки объектов нет.
- **Ровно один запуск.** Если job с таким именем уже есть (`STATUS_OBJECT_NAME_COLLISION`), shim выходит: это аналог детерминированного имени unit-а. Маркер `shim.json` и правила повтора `Start` — как в S3 §9.2. Если `OBJ_PERMANENT` окажется недоступен, запасной путь исполнителя: агент держит дубликат handle job (`DuplicateHandle` из shim), а `shim.json` хранит pid-ы для поиска после перезапуска агента; причина записывается в §24.
- **IPC агент ↔ shim:** AF_UNIX-сокет `C:\ProgramData\sbx-agent\run\cmd\<id>.sock` (Go `net` поддерживает AF_UNIX на Windows; ACL каталога — только SYSTEM). Протокол S3 §9.6. Spec команды с env передаётся первым сообщением по сокету, а не файлом: у Windows нет tmpfs. Готовность — сообщение `Started{pid}` вместо `READY=1`.
- **Запуск:** `CreateProcessAsUserW` с атрибутами `PROC_THREAD_ATTRIBUTE_JOB_LIST` (процесс сразу в job), `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` (pipe-ы) и для PTY `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE`; `CREATE_UNICODE_ENVIRONMENT`. Без PTY — `CREATE_NO_WINDOW` (скрытая консоль, которая нужна консольным программам). Рабочий стол — служебная window station logon-сессии; с `desktop: true` — `winsta0\default` консольной сессии (§13).
- **Лимиты job:** `JOB_OBJECT_LIMIT_BREAKAWAY_OK` не ставится (потомки не уходят из job), `KILL_ON_JOB_CLOSE` не ставится: если shim упал, команда живёт, агент находит job по имени и может его убить (аналог `cgroup.kill`).
- **Leftovers:** число активных процессов job (`JOBOBJECT_BASIC_ACCOUNTING_INFORMATION.ActiveProcesses`, сообщение `JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO` через completion port). Shim не выходит, пока job непуст и pipe-ы не закрыты (как S3 §9.3).
- **Вывод:** pipe-ы → файлы `stdout`, `stderr`, `pty` (§12.9). Дочитывание при выходе — как S3; для ConPTY после выхода главного процесса — `ClosePseudoConsole` и чтение до EOF.
- **ConPTY:** `CreatePseudoConsole`, `ResizePseudoConsole`, `ClosePseudoConsole` из `golang.org/x/sys/windows`. `term` из spec не влияет на ConPTY; в env процесса ставится `TERM=xterm-256color`. Ввод и дедупликация `seq` — как S3 §9.4.

**`argv`.** `argv[0]` ищется по `PATH` и `PATHEXT` собранного env (§12.7). Командная строка собирается по правилам MSVCRT (как `syscall.EscapeArg`). `.cmd` и `.bat` (например `npm`, `npx`) запускаются через `cmd.exe /d /s /c` с безопасным экранированием; аргументы, которые нельзя безопасно передать в batch (класс BatBadBut), → `invalid_argument unsafe_batch_args`.

**`shell`.** `pwsh.exe -NoLogo -NonInteractive [-NoProfile, если login=false]` (решение master). Сам `pwsh -Command` превращает любой код выхода последней внешней программы, кроме 0 и 1, в 1. Поэтому агент передаёт скрипт пользователя с эпилогом, который сохраняет код **[S9: контракт обязателен, форма эпилога — исполнителя]**:

```powershell
$global:LASTEXITCODE = 0
<shell>
# epilogue (own line, so a trailing comment in <shell> cannot swallow it)
$__sbx_ok = $?; if ($__sbx_ok) { exit 0 } elseif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } else { exit 1 }
```

Контракт: `exit N` в скрипте → N; последняя команда успешна → 0; последняя команда — внешняя программа с ненулевым кодом → её код; последняя команда — cmdlet с ошибкой → ненулевой код (1, или код более ранней упавшей внешней программы); синтаксическая ошибка → 1. Скрипт передаётся через `-EncodedCommand` (без проблем экранирования), а если он длиннее предела командной строки — файлом `.ps1` в каталоге команды (env в нём нет) через `-File`. Проверки приёмки: `exit 7` → 7, `cmd /c exit 3` → 3, `Get-Item C:\nope` последней командой → 1, `Write-Output ok` → 0. cmd.exe — через `argv`.

**Сигналы и Kill** (решение master):

| Запрос | Без PTY | PTY |
|---|---|---|
| `SIGINT`, `SIGTERM` | `CTRL_BREAK_EVENT` группе процесса (shim подключается к консоли команды) | байт `0x03` во ввод ConPTY |
| `SIGHUP` | `unsupported_signal` | `ClosePseudoConsole` (`CTRL_CLOSE_EVENT` процессам консоли) |
| `SIGKILL` | `TerminateJobObject` | `TerminateJobObject` |
| остальные | `invalid_argument unsupported_signal` | то же |

`Kill(grace_ms)`: строка `SIGTERM`, через `grace_ms` — `TerminateJobObject`. Таймаут PTY без клиента: `ClosePseudoConsole`, через 10 s — `TerminateJobObject`.

**Exit.** `code` — код выхода процесса (`uint32`, коды NTSTATUS вроде `0xC0000005` передаются как есть), `signal` пустой. После `TerminateJobObject` — `status KILLED`, `code 1`, `reason` как в S3 (`SIGNAL`, `TIMEOUT`, `PTY_IDLE`). `reason OOM` на Windows не бывает: OOM-killer нет, лимиты памяти job в v1 не ставятся. При нехватке commit процессы получают ошибки выделения памяти.

### 12.7 Env

Порядок как в S3 §8.2, последний выигрывает. Слияние нечувствительно к регистру, каноническое имя сохраняется (`Path`).
1. `CreateEnvironmentBlock(token, FALSE)`: системные и пользовательские переменные из реестра (`Path`, `USERPROFILE`, `APPDATA`, `TEMP` …).
2. Платформенные: `SBX=1`, `SBX_SANDBOX_ID`, `SBX_PORT_DOMAIN`, `SBX_HOSTNAME`, `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`, `SBX_ENV_APPLIED=1`, `TERM` для PTY.
3. `env` из claim. 4. `secret_env`. 5. `env` из spec.

**SSH-сессии:** профиль pwsh (§8.4) вызывает `sbx-agent env --format pwsh`. CLI получает пункты 2–4 у службы через AF_UNIX-сокет `run\env.sock`: ACL — SYSTEM, Administrators и `user`; peer credentials у AF_UNIX на Windows нет, доступ решает ACL файла сокета. Сессии `cmd.exe` env sandbox не получают (документируется в S7).

**Сессия рабочего стола:** `sbx-session` пишет несекретный env claim в `HKCU\Environment` и рассылает `WM_SETTINGCHANGE`. Секреты туда не попадают.

### 12.8 Секреты (`SecretStore`)

Решение master (условия a–d), граница доверия — VM:
- **`secret_env`** — только в памяти агента и в env процессов. После перезапуска агента (сбой, обновление) значения пропадают, фаза `secrets` → `pending`, событие `readiness.changed`; S6 присылает `UpdateSecrets` заново (§18.6 п. 7). Пока `secrets: pending` при непустом `secretsDigest`, `Start` ждёт `UpdateSecrets` до 30 s, затем `unavailable secrets_pending` (retryable): команда не должна тихо запуститься без секретов.
- **`secret_files`** — `C:\ProgramData\sbx\secrets\files\<name>` с атрибутом `FILE_ATTRIBUTE_TEMPORARY`, ACL SYSTEM + `user` (режим из запроса сводится к read-only или read-write). `link_path` — symlink на файл (как S3 §8.1). ACL защищает от случайного доступа, но не от администратора; от чтения устаревших файлов защищает порядок очистки (§12.3).
- **Очистка** (перезапись нулями на месте, затем удаление):
  - (a) при каждой загрузке и при смене идентичности — в `sbx-agent early` до входа (§12.3);
  - в `System/PrepareStop` (шаг `prepare` stop S6): ответ `{secret_files_wiped: true}` подтверждает очистку, и по нему S6 снимает флаг `secret_files_on_disk` (§18.6 п. 5). Дублируется в `PRESHUTDOWN`;
  - (b) в quiesce для saved snapshot (§12.10).
- **(c)** pagefile включён с `ClearPageFileAtShutdown=1`, дампы памяти выключены (§8.1).
- **(d) Принятые риски** (по той же политике; Илья проинформирован master-сессией). Задача «при запуске», созданная пользователем, может прочитать файлы секретов до очистки (§12.3), это принято master-сессией. Кроме того, снапшот работающей VM (fork и saved) может содержать фрагменты секретов в pagefile, в свободных кластерах NTFS, в `$MFT` (маленькие файлы хранятся резидентно) и в `$LogFile`. Перезапись нулями перед удалением уменьшает, но не исключает это. Fork наследует секреты по замыслу (S3 §8.1). RAM-диск (сторонний драйвер) — возможное улучшение позже.

### 12.9 Файлы, вывод, порты

**Файлы** (S3 §11, отличия):
- Пути: `C:\…` или `C:/…`; `~` — профиль пользователя запроса. UNC и device-пути (`\\server\…`, `\\.\…`) → `invalid_argument`. Длинные пути поддерживаются (`LongPathsEnabled`). Регистр не важен.
- `FileInfo.mode` синтезируется: каталог `0755`, файл `0644`, с атрибутом read-only — без битов записи, `+0111` для расширений из `PATHEXT`. `owner` — имя учётной записи владельца (`user`, `SYSTEM`, `Administrators`), `group` пустой, `uid`/`gid` = 0. `ETag` = серийный номер тома + file index + размер + mtime.
- `Chmod`: из `mode` используется только бит записи владельца (атрибут read-only); `owner` меняет владельца; `group` игнорируется; `recursive` как в S3.
- Symlink-и и junction-ы показываются как `SYMLINK` с целью; рекурсивное удаление по ним не ходит.
- Запись: временный файл → `FlushFileBuffers` → `MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)`. Нарушение совместного доступа (файл открыт другим процессом без `FILE_SHARE_DELETE`/`FILE_SHARE_WRITE`) → `failed_precondition file_in_use` (`retryable: true`), так же в `Move` и `Remove`.

**Вывод и retention** (S3 §10): файлы вывода sparse (`FSCTL_SET_SPARSE` при создании), вытеснение — `FSCTL_SET_ZERO_DATA` с выравниванием по 64 KiB (единица освобождения sparse в NTFS, а не 4 KiB), `available_from` — начало первого выделенного диапазона (`FSCTL_QUERY_ALLOCATED_RANGES`). Shim открывает файлы с `FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE`. Перепроверка после чтения — как S3.

**Порты** (`PortScanner`): `GetExtendedTcpTable(TCP_TABLE_OWNER_PID_LISTENER)` для IPv4 и IPv6 раз в 1 s, владелец по pid (`QueryFullProcessImageNameW`, пользователь токена). Системные слушатели Windows (RPC 135 и динамические RPC 49664+ у `lsass`, `wininit`, `services`, `svchost`, `spoolsv`, `System`) не сообщаются: `[ports] exclude = [22, 135]` и `exclude_processes = ["System", "lsass.exe", "wininit.exe", "services.exe", "svchost.exe", "spoolsv.exe"]` **[S9]**. CONNECT — как S3 §12.

**Метрики:** `gopsutil`; `swap` = использование pagefile.

### 12.10 Quiesce (`Quiescer`)

На Windows FS замораживает VSS, а VSS-провайдер в госте уже есть у QEMU guest agent из virtio-win. Писать свой VSS-провайдер на Go не нужно. Поэтому для Windows `QuiesceHook` в worker составной **[S9]**:

```
freeze(): System/Quiesce{fs: false, docker: false, wipe_secret_files: kind == saved}
          -> QGA fsfreeze-freeze (VSS)
S1:       pause vCPU (multi-disk), lvcreate -s for scsi0, efidisk0, tpmstate0, resume
thaw():   QGA fsfreeze-thaw -> System/Thaw
```

- Агент: хуки `C:\ProgramData\sbx-agent\quiesce.d\*.ps1` с аргументом `freeze`/`thaw`, до 5 s каждый; lease и авто-снятие по `deadline` — внутренний таймер агента (watchdog-процесс не нужен: VSS сам снимает заморозку).
- `fs: true` на Windows → `failed_precondition fs_freeze_unsupported`. Capabilities: `system.quiesce.v1` и новая `system.quiesce.wipe_secrets.v1`; `docker` на Windows игнорируется.
- **Бюджет.** S1 считает 10 s от возврата `freeze()` (VSS уже держит запись) до начала `thaw()`, то есть пауза vCPU, `lvcreate` и resume. Подготовка до этого (хуки агента, очистка секретов, подготовка VSS writers в `fsfreeze-freeze`) в бюджет не входит и ограничена своим тайм-аутом: весь `freeze()` ≤ 30 s, иначе снапшот отменяется. Для Linux смысл тот же: S3 замораживает FS в конце `Quiesce`. Это уточнение S1 §6.2 (§18.1 п. 9).
- **VSS держит запись не дольше 10 s** и снимает заморозку сам. Это совпадает с бюджетом S1 и заменяет watchdog S3 §14.3. Если `fsfreeze-thaw` сообщает, что заморозка уже снята, снимок только crash-consistent, и worker поступает как при `auto_thawed` (S3 §14.3).
- **Очистка секретов для saved snapshot** (условие b): при `wipe_secret_files` агент до заморозки перезаписывает нулями и удаляет файлы секретов, `Thaw` восстанавливает их из памяти. Если какой-то файл открыт без совместного доступа на запись и удаление, агент откатывает уже стёртые и отвечает `failed_precondition secrets_in_use`. Тогда S6 требует остановить sandbox перед сохранением (§18.6 п. 5). Перезапуск агента во время lease: файлы восстанавливаются только после `UpdateSecrets` (фаза `secrets: pending`).
- Если агент не подключён, worker делает только QGA `fsfreeze` (как S1 сейчас); для `kind=saved` с файлами секретов это запрещено (`agent_unavailable`).
- `sbx-agent thaw --force` на Windows восстанавливает файлы секретов и снимает lease; FS он не трогает.

### 12.11 `seal`

S3 §7.3 для Windows: остановить службу, стереть `C:\ProgramData\sbx-agent\state` и `run`, SSH host keys, каталог секретов, вернуть шаблонные `sbx_user_ca.pub` и пустой env, остановить `sshd`. Каталог версий остаётся. `MachineGuid`, имя и пароль меняет `identity apply` на клоне.

### 12.12 Пакет и обновление

- `sbx-agent-<v>-windows-amd64.tar` (формат S3 §17.1; tar — для единообразия, Go читает его на Windows): `sbx-agent.exe` (консольная подсистема), `sbx-session.exe` (GUI-подсистема, `-H windowsgui`, без окна консоли), `manifest.json`, `manifest.sig`, `trust\`.
- Обновление — S3 §17.4: переключение junction-ов `previous`/`current` (удаление и создание; атомарности rename нет, её компенсирует `pending-update.json` и откат), перезапуск через SCM (§12.2), откат через failure action.
- **QGA-восстановление** (S3 §17.6): `sbx-agent doctor --json`; `sbx-agent logs -n 500` (последние строки `agent.log`); `Restart-Service sbx-agent`; `sbx-agent rollback [--to <v>]`; `sbx-agent install-package <path>`; `sbx-agent thaw --force`.

### 12.13 Готовность

- Фазы S3 §8.5; `docker` = `disabled`; `desktop` (только `windows`) — §13.
- `pool_ready` (S6 §9.3) для `windows` = `agent` + `identity` + `desktop`.

### 12.14 Новые CLI-подкоманды

| Подкоманда | Зачем |
|---|---|
| `early` | startup-скрипт (§12.3) |
| `identity apply [--specialize]` | §11.2 (на Linux существует, здесь режим specialize) |
| `env --format pwsh` | env для профиля SSH-сессии (§12.7) |
| `resume-hint --unix-ms <t>` | после пробуждения из спящего режима (§14.3); работает и на Linux |
| `exec --user <u> -- <argv>` | локальный запуск через тот же путь токенов и shim; для verify и QGA (только Administrators) |
| `logs -n <N>` | аналог `journalctl` |

## 13. Рабочий стол: хуки для S10

- **Autologon** `user` в консольную сессию (§11.2, §8.7); блокировки, UAC-запросов и мастеров первого входа нет.
- **`sbx-session.exe`** — helper в интерактивной сессии: служба из session 0 не может захватывать экран и посылать ввод. Запускается задачей `\sbx\session` при входе, повышенный (UIPI не мешает управлять повышенными окнами). Подключается к агенту по AF_UNIX `run\session.sock` (ACL: SYSTEM и `user`) и сообщает `Hello{session_id, user, version}` и `State{locked, input_desktop, width, height, dpi}` при каждом изменении (уведомления WTS о сессии). Принимает `ApplyEnv` (§12.7). Протокол — protobuf с префиксом длины, расширяемый: захват экрана, ввод, буфер обмена и запуск стримера добавит S10.
- **Фаза `desktop`:** `ready`, когда helper подключён, сессия активна и разблокирована, а входной рабочий стол — `Default` (не `Winlogon`). Иначе `pending`, а с ошибкой (helper падает в цикле) — `failed`.
- **`CommandSpec.desktop: true`** (новое поле proto): процесс запускается в консольной сессии (`WTSGetActiveConsoleSessionId` → `WTSQueryUserToken` → связанный повышенный токен), на `winsta0\default`, внутри job shim-а, с захватом вывода как обычно. Если сессии нет → `failed_precondition desktop_not_ready`. На Linux поле определит S10.
- Видеоадаптер, разрешение, Sunshine, cua-driver — S10.

## 14. Пул, загрузка, спящий режим

### 14.1 Почему спящий режим

В лимите PoC 8 GB работающая warm-машина Windows (4 GB) заняла бы половину RAM, а холодный create Windows — 3–5 min (specialize, OOBE, первый вход). Machine, усыплённая на диск (`qm suspend --todisk`), RAM не занимает, а просыпается за секунды с уже готовой сессией и подключаемым агентом. Решение master: пул Windows работает так; спайк в начале реализации (§21) подтверждает работу с vTPM.

### 14.2 Подготовка machine пула

S6 §9.3 (clone, start, ожидание `pool_ready` не дольше `boot_timeout_s`), затем:
1. Machine → `suspending`. S1 `hibernate(vmid)`: `POST …/status/suspend` с `todisk=1` (состояние в `vmstatestorage=local-lvm`), ожидание задачи, проверка `lock: suspended` и `vmstate` в конфиге.
2. Machine → `hibernated`: RAM не входит ни в `reserved`, ни в `powered` (§18.6).

Перед усыплением агент ничего не делает: туннель просто перестанет отвечать, gateway закроет соединение по ping (S2). Machine token (в памяти агента) после пробуждения может оказаться просроченным; агент тогда подключается с BS, как после любого обрыва.

### 14.3 Claim из спящего режима

1. API: admission RAM машины (с вытеснением warm других пар, S6 §8.2), machine → `claiming`.
2. Worker: проверка RAM перед стартом, S1 `start` (Proxmox продолжает VM с сохранённого состояния и удаляет `vmstate`).
3. `agent/ping` QGA, затем `agent/exec`: `sbx-agent resume-hint --unix-ms <время хоста>`. Агент:
   - выставляет системное время (`SetSystemTime`; у SYSTEM есть право), если расхождение больше 1 s, и запускает `w32tm /resync /force`. Без этого часы гостя отстают на время сна, и TLS к туннелю может упасть на `notBefore` свежего сертификата;
   - закрывает старое WebSocket-соединение и подключается заново сразу, не дожидаясь 15 s ping-тайм-аута;
   - пересчитывает фазы (`desktop` для `windows`).
4. Ожидание подключения (новый `epoch`) и `pool_ready`, затем `System/Claim` → `running`.

Цель: claim-to-ready ≤ 30 s (§16).

### 14.4 Цели пула в PoC (решение master)

| Пара | Цель | Режим | RAM в простое |
|---|---|---|---|
| `linux/2GB` | 1 | running | 2 GB |
| `windows/4GB` | 1 | hibernated | 0 |

Во время подготовки и при claim Windows-машина занимает RAM, как обычно, по admission S6. Место на `local-lvm`: состояние ≈ занятой RAM гостя (thin) плюс диски.

**Если спайк §21 не пройдёт:** цель `windows` = 0, create — холодный (3–5 min, в пределах дедлайна S6 20 min). Решение записывается в §24.

### 14.5 Дедлайны и тайм-ауты

Дедлайны S6 §7.9 для Windows подтверждаются без изменений: create из пула 5 min (спящий режим укладывается с запасом), cold / from snapshot / fork-цель 20 min, fork (снапшот) 3 min, stop 5 min, resume и recover 15 min, `boot_timeout_s` = 1200. `maxAgeHours` пула — 24 h, как у S6; для пары можно задать иначе.

### 14.6 Stop через спящий режим (фаза 2)

Stop пользовательской sandbox через `suspend --todisk` сохранил бы процессы, но меняет семантику S6 (команды не `LOST`, снимки дисков остановленной VM только crash-consistent, quiesce невозможен). Это эксперимент фазы 2 (решение master); в v1 stop Windows — обычное выключение.

## 15. Проверка сборки (профиль `windows-desktop`)

### 15.1 Проверки

`verify` создаёт machine из шаблона примитивом S1 (тестовый `smbios1` с `family`), загружает её (specialize), проверяет через QGA и удаляет со следами (включая LV состояния спящего режима, §18.1). Команды от `user` выполняются через `sbx-agent exec --user user` (§12.14), то есть тем же путём, что команды агента.

1. ОС: редакция и сборка = рецепт/манифест; `Get-ComputerInfo`.
2. **Specialize:** имя `SBX<12 hex>` тестового `machineId`; `MachineGuid` = `machineId`; число перезагрузок первой загрузки не больше, чем у setup без агента (по журналу событий, ID 6005/6006/1074); `sbx-unattend.xml` удалён; в `Panther` нет пароля.
3. **Сокеты:** TCP-слушатели только из allow-list рецепта: `127.0.0.1:22`, `[::1]:22`, 135 и динамические RPC 49664–49670 (`lsass`, `wininit`, `services`, `svchost`, `spoolsv`, `System`). Портов 3389, 5985, 5986, 445, 139, 5357, 7680 нет. UDP: DHCP-клиент, mDNS и LLMNR выключены.
4. **Firewall:** включён во всех профилях, входящие по умолчанию запрещены, ни одного включённого разрешающего входящего правила, `NotifyOnListen=False`.
5. **sshd:** `sshd -T` — `passwordauthentication no`, `trustedusercakeys`, оба `listenaddress`; служба работает (её запустил агент); host keys созданы в эту загрузку; `DefaultShell` = pwsh 7. Вход по сертификату с тестовым CA: `ssh -i <key> -o CertificateFile=<cert> user@127.0.0.1 "$env:SBX"` (CA подкладывается через `sbx_user_ca.pub` на время проверки).
6. **Агент:** `sbx-agent doctor --json` — версия, `identity` ready, URL туннеля из `family`, служба Running, failure actions заданы, startup-скрипт отработал (`early.json`), фазы по профилю.
7. **Пользователи и вход:** `user` в Administrators, пароль бессрочный, LSA secret есть; Administrator и Guest выключены; UAC: `EnableLUA=1`, `ConsentPromptBehaviorAdmin=0`, `PromptOnSecureDesktop=0`. `windows`: сессия `user` активна (`query user`), `LogonUI.exe` не работает, фаза `desktop` = ready.
8. **Службы и политики:** §8.1 — состояния служб, Defender (`Start=4` у шести служб и драйверов, процесса `MsMpEng` нет), `WaaSMedicSvc` `Start=4`, `sbx-offline.log` без ошибок, Fast Startup и спящий режим гостя выключены, pagefile есть и `ClearPageFileAtShutdown=1`, `CrashDumpEnabled=0`, VBS выключен (`Win32_DeviceGuard`), BitLocker выключен (`manage-bde -status`), TPM готов и отличается от шаблона (`Get-Tpm`, у `windows`), BCD `bootstatuspolicy`/`recoveryenabled`, WinRE выключен, кодовая страница 65001.
9. **Инструменты:** каждая команда §8.5 — `--version` от `user` прямым exec и через `pwsh -Command`; версии = манифест; `npm -g` пишет в `C:\ProgramData\npm`.
10. **Сеть:** IPv4 из `10.88.0.0/24`, `Resolve-DnsName example.com`, `Invoke-WebRequest https://example.com`; время синхронизировано, часовой пояс UTC.
11. **Процессы агента:** через `sbx-agent exec` и путь `shell`: коды выхода по контракту §12.6; `.cmd` из `PATH` (`npm --version`) запускается; ConPTY-сессия с `pwsh` отвечает на ввод (локальный selftest `sbx-agent selftest --pty`).
12. **VSS:** QGA `fsfreeze-freeze` → `fsfreeze-status` = frozen → `fsfreeze-thaw` за ≤ 10 s, в журнале событий нет ошибок VSS.
13. **Смена идентичности (fork-путь):** выключить VM, поменять `smbios1` (новый `machineId` и BS), загрузить. Произошла одна перезагрузка на переименование; новое имя, `MachineGuid`, host keys, пустое состояние агента, `identity.reset` в журнале; пароль `user` прежний, autologon работает, секрет, сохранённый через DPAPI до смены идентичности, читается. Время записывается.
14. **Жёсткая остановка:** S1 `stop` без shutdown, затем start; загрузка без Automatic Repair, время до готовности агента ≤ обычная загрузка + 10 s.
15. **Спящий режим** (если `pool.mode = hibernated`): S1 `hibernate`, start, `resume-hint`; агент подключён и `pool_ready`; часы расходятся с хостом < 2 s; `windows`: сессия не заблокирована. Время записывается.
16. **TRIM:** `Optimize-Volume -ReTrim`. Пока закреплённый virtio-win не содержит исправления, ошибка — предупреждение; после — красная проверка.
17. **Лицензия:** редакция, состояние лицензии, канал, оставшиеся дни (`SoftwareLicensingProduct`) → манифест (`license`). Для `channel = evaluation`: проверка ждёт до 10 min онлайн-активации ознакомительной версии на клоне; меньше 30 дней — предупреждение, меньше 7 — красная проверка (§17). Для `retail` и `volume` проверяется только совпадение редакции; неактивированная Windows — не ошибка.
18. **Остатки:** нет `C:\sbx-build`, установщиков, файлов `authorized_keys`; `C:\ProgramData\sbx-template\build.json` есть.
19. **Замеры загрузки** (§16) → `verify.boot` в манифесте.

### 15.2 Манифест: поля Windows

К S5 §11: `windows` {`edition`, `build`, `ubr`, `family`, `isoFile`, `isoSha256`, `virtioWinVersion`, `openssh` (inbox/github и версия), `appxRemoved`, `options`}, `license` {`status`, `channel`, `daysRemaining`, `expiresAt`}, `verify.boot` (§16), `poolMode`.

## 16. Замеры

### 16.1 `sbx-bench s9`

Сценарий в `apps/bench` поверх `s5` (S5 §13.1) для Windows-сборки, N прогонов:

| Метрика | Как |
|---|---|
| `first_boot_to_agent_ready` | клон из шаблона: start → готовность агента (specialize, OOBE включены) |
| `first_boot_to_desktop_ready` | то же до `desktop: ready` (`windows`) |
| `boot_to_agent_ready` | обычная загрузка после shutdown |
| `hard_stop_restart` | после `stop` без shutdown |
| `identity_change_boot` | после смены `smbios1` (с перезагрузкой на переименование) |
| `hibernate` | длительность `suspend --todisk`, размер LV состояния |
| `resume_to_agent_ready` | start спящей → `resume-hint` → агент подключён и `pool_ready` |
| `freeze` | QGA VSS freeze → thaw |

### 16.2 Цели (оценки, проверяются; цифры пишутся в §24)

На `pve`, `local-lvm`, размеры §9: `first_boot_to_desktop_ready` ≤ 4 min; `boot_to_agent_ready` ≤ 60 s; `identity_change_boot` ≤ 2 min; `hibernate` ≤ 30 s; `resume_to_agent_ready` ≤ 20 s (claim-to-ready ≤ 30 s).

### 16.3 Эксперименты

Отдельная сборка с флагом рецепта, сравнение `sbx-bench s9 --baseline`: `cpu: x86-64-v3` вместо `host`; virtio-win 0.1.302 и следующий релиз (VSS, TRIM, I/O); без `sysprep /generalize` (только для оценки выигрыша specialize; не меняет решение).

## 17. Лицензирование (только ограничения)

Решения о лицензиях — за пользователем и юристами, не за платформой (`research/05` §7.5 — справка, не консультация).
- **Ознакомительные версии:** Windows 11 Enterprise Evaluation — 90 дней (Server — §22). По истечении Windows выключается раз в час. С чего начинается отсчёт у клонов sysprep-шаблона (с установки при сборке или с онлайн-активации каждого клона после rearm при `generalize`), достоверно не известно. Пока это не измерено, правило консервативное: отсчёт идёт со сборки, шаблон из ознакомительного ISO пересобирается не реже, чем раз в 60 дней. Реализация измеряет это (`daysRemaining` у verify-клона в день сборки и у machine пула через неделю) и пишет итог в §24. Клоны активируют ознакомительную версию онлайн сами (egress `sbx0` есть). `verify` пишет `license.expiresAt`, `sbx-tpl list` показывает остаток дней, S12 добавляет тревогу за 14 дней и плановую пересборку.
- **Retail или неактивированная Windows** (как ISO Ильи, Pro): работает с ограничениями персонализации; ответственность пользователя.
- **KMS позже:** GVLK в `product_key`, адрес KMS в `agent.toml [windows] kms_host` или в claim (поле добавляется по запросу). Fork наследует CMID (SID не меняется); для KMS fork может понадобиться `slmgr /rearm` при смене идентичности — решается вместе с KMS.
- **Справочно** (`research/05` §7.5): Windows 11 в VM лицензируется на человека (VDA/E3/E5, до 4 VM на пользователя), что плохо ложится на эфемерные VM для AI-агентов; Windows Server Datacenter лицензирует ядра хоста; внешним клиентам нужен SPLA. AVMA на Proxmox не работает.
- **VS Build Tools** выключены по умолчанию (лицензия Visual Studio); включает флагом рецепта пользователь, у которого есть лицензия.

## 18. Изменения в соседних областях

Вносят исполнители этих областей; согласование — с master-сессией.

### 18.1 S1 (`packages/pve`, `sbx-node`, runbook)

1. **Право `VM.Console`** в роль `SbxPoC` на pool `sandbox` (решение master): `sendkey` для «Press any key» при сборке и offline-этапе.
2. **`DiskSet` с `efidisk0` и `tpmstate0`** проверяется на деле: `snapshot`, `cloneFromSnapshot`, `delete` для трёх дисков; опции `efitype`, `pre-enrolled-keys`, `ms-cert`, `version` переносятся. `cloneFromTemplate` клонирует `scsi0` и `efidisk0`, а `tpmstate0` создаёт новым через PVE API при `create` (§9). Новый том Proxmox называет `vm-<vmid>-disk-<k>` без тега `sbx`; `delete` удаляет его через `purge` и проверяет, что `vm-<vmid>-*` не осталось. В `sbx-bench s1` — прогон с Windows-шаблоном (fork загружается, `Get-Tpm` в fork `TpmReady`).
3. **Белый список железа:** + `efidisk0`/`tpmstate0` опции, `vmstatestorage`; `machine` с версией копируется как есть.
4. **`hibernate(vmid)`:** `POST status/suspend todisk=1`, ожидание задачи, проверка `lock: suspended`. Права есть: `VM.PowerMgmt`, `VM.Config.Disk`, `Datastore.AllocateSpace` на `local-lvm` (проверено в `PVE/API2/Qemu.pm`). `start` спящей VM — обычный `start`.
5. **`sbx-node vm.discard-suspend <vmid>`** (решение master): для VM из диапазона, в pool `sandbox`, с тегом `sbx` и `lock: suspended` — `qm unlock`, удалить ключ `vmstate` и его том (`pvesm free`). Без этого VM со спящим состоянием не удалить: `skiplock` разрешён только root. `delete` вызывает её первой, если VM в `lock: suspended`.
6. **Проверка `delete`:** кроме LV с тегом `sbx-vm-<vmid>` — нет LV `vm-<vmid>-state-*` (том состояния создаёт Proxmox, тега `sbx` у него нет).
7. **`sbx-node`:** `media.sha256 <file>` (только чтение, только `/var/lib/vz/template/iso/*.iso`, без `..` и symlink-ов, кэш по имени, размеру и mtime); шаблоны `media.remove` дополняются `sbx-build-*.iso`, `sbx-offline-*.iso`, `sbx-virtio-win-*.iso`.
8. `waitReady` и `network-get-interfaces` работают с Windows QGA без изменений (проверяется стендом).
9. **Бюджет заморозки** в `snapshot` считается от возврата `hook.freeze()` до вызова `hook.thaw()` (10 s); на сам `freeze()` — отдельный тайм-аут 30 s (§12.10).

### 18.2 S2

- `Sbx-Boot-Id` на Windows — §12.4; `Sbx-Vmgenid` — hex из `\\.\VmGenerationCounter`.
- На Windows smbios (с BS) читает любой процесс VM; принято в рамках модели «граница доверия — VM» (S2 §16).

### 18.3 S3 (агент)

1. Реализации §18 S3 для Windows по §12; таблица переносимости S3 §18 обновляется: IPC агент ↔ shim — AF_UNIX на обеих ОС; `Quiescer` на Windows — только хуки и очистка секретов, FS — QGA VSS; `SecretStore` — §12.8.
2. Proto (только добавления): `CommandSpec.desktop`, `ClaimResponse.hostname_applied`, `QuiesceRequest.wipe_secret_files`; коды ошибок `unsupported_signal`, `unsafe_batch_args`, `file_in_use`, `secrets_in_use`, `secrets_pending`, `fs_freeze_unsupported`, `desktop_not_ready`; capability `system.quiesce.wipe_secrets.v1`.
3. Подкоманды §12.14; `resume-hint` и на Linux (закрыть соединение, переподключиться, синхронизировать часы).
4. CI: кроме кросс-компиляции — интеграционные тесты на Windows-раннере GitHub Actions (Server 2025): служба и failure actions, shim и job objects (переживает перезапуск службы), ConPTY, sparse-файлы и вытеснение, AF_UNIX, `LogonUser` с тестовым локальным пользователем, файлы и коды ошибок, порты.
5. `Start` при `secrets: pending` с непустым `secretsDigest` ждёт до 30 s (§12.8). На Linux это тоже полезно после перезагрузки; решает реализация S3.

### 18.4 S4

`loginUser` для Windows-шаблонов — `user`; sshd встроенный, shell по умолчанию pwsh 7, env sandbox — через профиль (§8.4, §12.7). S4 ничего менять не нужно; ограничение S4U-токена (§8.3) — в документацию.

### 18.5 S5 (`sbx-tpl`)

1. `source.kind: iso-install`, `seal: sysprep`, `offline: [...]`, встроенные шаги `network-up` и `reboot` для Windows, исполнитель шагов через scheduled task и `run-step.ps1` (§7).
2. Носители §6; `iso upload`; `--iso`, `--iso-sha256`, `--accept-iso-sha256`, `--edition`, `--product-key-file`; `install_timeout`.
3. Профили проверки §15, манифест §15.2, `sbx-bench s9`.
4. `gc`: ISO `sbx-virtio-win-*` удаляется, если на версию не ссылается ни одна не-`retired` сборка; `sbx-build-*` и `sbx-offline-*` — как `sbx-seed-*`. ISO пользователя не трогает никогда.
5. Admission при сборке (S5 §7.2 п. 4) учитывает `build_vm.memory_mb` 4096.

### 18.6 S6 (control plane)

1. **Состояния machine:** `suspending` (усыпляется; RAM в `reserved` и `powered`) и `hibernated` (warm на диске; RAM нигде не учитывается). `hibernated` — предложение для пула (supply считает `allocating`, `provisioning`, `booting`, `warm`, `suspending`, `hibernated`).
2. **`poolTargets.mode`:** `running | hibernated` (по умолчанию из `template.yaml pool.mode`). После `pool_ready` при `mode = hibernated` контроллер переводит machine в `suspending` → S1 `hibernate` → `hibernated`.
3. **Claim:** из `warm` (если есть) раньше, чем из `hibernated`. Claim `hibernated`: admission RAM (как resume), machine → `claiming` (в `reserved`), шаги §14.3 (start с проверкой RAM, QGA `resume-hint`, ожидание подключения), затем claim. Ошибка → `deleting`, повтор по правилам S6 §7.3.
4. **Правила пула:** §9.2 п. 5 (агент отключён > 60 s) не применяется к `suspending` и `hibernated`. `maxAgeHours` — как у warm. Reconcile ожидает у `hibernated` статус Proxmox `stopped` с `lock: suspended`; иначе → `deleting`. Delete `hibernated` — S1 `discard-suspend`, затем обычный delete (§18.1 п. 5).
5. **Saved snapshot Windows** (условие b): работающая machine — составной quiesce (§12.10) с `wipe_secret_files`; `secrets_in_use` → операция падает с `snapshot_requires_stop` (S7). Остановленная machine — разрешено, только если `machines.secret_files_on_disk = false`. Поле ставится в `true`, когда Windows-machine получила непустые `secret_files`, и в `false` по ответу `PrepareStop{secret_files_wiped: true}` перед штатным shutdown или после замены набора на пустой. Жёсткая остановка оставляет `true` → `snapshot_requires_clean_stop`. Fork этими правилами не ограничен.
6. **`QuiesceHook` для Windows** — составной (§12.10); выбор по `template_builds.os`.
7. **Повторная отправка секретов:** `UpdateSecrets` и при `readiness.changed{secrets: pending}` без смены `boot_id` (перезапуск или обновление агента на Windows), а не только после перезагрузки.
8. Hostname: для Windows поле sandbox не применяется в госте; действующее имя берётся из `System/Info`. `user` = `root` в командах маппится агентом на `SYSTEM`.
9. Дедлайны §7.9 и `boot_timeout_s` — подтверждены (§14.5).
10. **Stop Windows:** шаг `prepare` (`System/PrepareStop`, 10 s) на Windows стирает файлы секретов и отвечает `secret_files_wiped` (§12.8); тайм-аут `shutdown` для `os = windows` — 120 s вместо 60 s (очистка pagefile при выключении, §8.1), затем жёсткий `stop`, как сейчас.

### 18.7 S7

Документация семантики Windows: `shell` = `pwsh -Command`; сигналы (§12.6); `mode`/`owner` файлов (§12.9); SSH-сессии получают env только в PowerShell; S4U-ограничение SSH; hostname не применяется. Поле `desktop` в командах (после S10 — и для Linux). Новые коды ошибок: `unsupported_signal`, `unsafe_batch_args`, `file_in_use`, `secrets_pending`, `snapshot_requires_stop`, `snapshot_requires_clean_stop`, `desktop_not_ready`.

### 18.8 S8

`poolTargets` получает поле `mode` (§18.6 п. 2).

## 19. Структура кода

```
infra/templates/_windows/     shared: autounattend.xml.tmpl, sbx-unattend.xml, offline/,
                              SetupComplete.cmd, run-step.ps1, steps/*.ps1, files/
infra/templates/windows/      template.yaml, versions.toml
apps/template-builder/        + iso-install path, media, sysprep/offline stages, windows verify
apps/bench/                   + scenario s9
services/guest-agent/         + *_windows.go implementations, cmd sbx-session
packages/pve/, services/node-agent/   + §18.1
```

Тесты: unit — рендер `autounattend.xml` и `sbx-unattend.xml` (схема, нет пароля в `sbx-unattend.xml`), порядок вызовов `iso-install` и откат (фейк PVE), offline-этап, правила `gc` для ISO; PSScriptAnalyzer для `steps/*.ps1`; агент — §18.3 п. 4; интеграция — сборка и `verify` на `pve`, `sbx-bench s9`.

## 20. Приёмка

На `pve`:
1. `sbx-tpl preflight` зелёный (включая `VM.Console`, `media.sha256`, ISO пользователя и его sha256). `sbx-tpl build windows --agent-package <tar> --tunnel-url <url>` проходит без ручных действий; сборка `ready`, проверки §15 зелёные.
2. Повторная сборка с тем же `versions.toml` и коммитом даёт ту же редакцию и сборку ОС, те же `tools` и версию virtio-win в манифесте.
3. Неудачная сборка (намеренно падающий шаг, неверная `edition`, ISO с неверным sha256) не оставляет VM, ISO `sbx-build-*` и `sbx-offline-*`, lease; ISO пользователя не тронут.
4. **Пул:** с целями §14.4 в пределах 8 GB одновременно работают Linux warm, спящая Windows-машина и Linux-sandbox; claim `windows` из спящей machine ≤ 30 s, сессия `user` разблокирована, `desktop: ready`; `reserved` и `powered` не превышают лимит (метрики S6). Удаление спящей machine не оставляет LV `vm-<vmid>-*`.
5. **Секреты:** `secret_files` и `secret_env` видны командам; после `PrepareStop` файлов нет; файл, оставленный жёсткой остановкой, не виден программе автозапуска сессии `user` и стирается до готовности агента; saved snapshot работающей machine (файлы не заняты) не содержит файлов секретов (поиск по LV снапшота); при занятом файле saved snapshot отклоняется с `snapshot_requires_stop`.
6. **Fork:** fork работающей Windows-sandbox загружается с новой идентичностью (§15 п. 13), данные `user` и DPAPI сохранены, исходная machine не затронута, VSS-снимок согласован (файл, записанный до снапшота, есть).
7. **Агент:** приёмка S3 §21 п. 1–13 на Windows с отличиями §12: команды переживают перезапуск службы и самообновление; `Kill` после убитого shim работает; retention на sparse-файлах; ConPTY с resize; коды выхода `shell` по контракту §12.6; `unsupported_signal`; `file_in_use`; порты и CONNECT; SSH по сертификату через gateway S4 с env sandbox в pwsh.
8. `sbx-bench s9`: цифры §16 записаны в §24; цели §16.2 выполнены или отклонение объяснено.
9. S1 `inventory` «мир до» и «мир после» сборки, `verify` и `gc` отличаются только VM и LV сборок.

## 21. Порядок реализации

1. **Спайк (первым, решение master):** на `pve` в диапазоне PoC — Windows 11 VM с vTPM и OVMF (можно временно, вне пайплайна), `suspend --todisk` → `start`: состояние TPM и сессии сохраняется, время усыпления и пробуждения, размер тома состояния; `discard-suspend` (прототип `sbx-node`) и удаление; заодно — загружает ли OVMF Proxmox запись Windows Boot Manager из `efidisk0`, если в `boot` только `ide2` (§10.3), и работает ли постоянный job (`OBJ_PERMANENT`, §12.6). Итог: `pool.mode` для Windows и цифры в §24. Провал → цель `windows` = 0.
2. S1 §18.1 (права, `DiskSet` с тремя дисками, `hibernate`, `discard-suspend`, `media.sha256`).
3. Агент на Windows (§12) с CI на Windows-раннере.
4. `sbx-tpl` `iso-install` и рецепт `windows` (ISO Ильи есть на `pve`).
5. `verify`, `sbx-bench s9`, цифры.
6. S6 §18.6 (пул через спящий режим, правила saved snapshot) — в реализации S6.

## 22. Фаза 2: Windows Server Core

Решение Ильи 2026-10-29: в MVP только `windows` («win11 пойдёт пока, сервер не нужен»). Шаблон `windows-core` и его цель пула (`windows-core/2GB`) отложены; ISO от Ильи не нужен. Ниже — уже принятые решения, чтобы вернуться к ним без нового brainstorm:
- **Источник:** Windows Server 2025 Datacenter Evaluation (180 дней; последний GA LTSC на 2026-10-29, vNext — preview). Пользователь кладёт ISO в `local:iso` с исходным именем вида `*SERVER_EVAL_x64FRE_*.iso`; sha256 записывается в `versions.toml`, проверка — `sbx-node media.sha256` (§6.1).
- **`versions.toml [iso]`:** `edition = "Windows Server 2025 Datacenter Evaluation"` (это Core; у Desktop Experience суффикс `(Desktop Experience)`), `product_key = null`, `channel = "evaluation"`.
- **Правило пересборки:** не реже, чем раз в 150 дней, пока не измерено, с чего у клонов идёт отсчёт (§17).
- **Рецепт (намётки):** `family: server`, `drivers: 2k25`, без `tpmstate0`, `tablet: 0`, без шага `60-desktop` и фазы `desktop`; Defender удаляется `Uninstall-WindowsFeature Windows-Defender`; `offline: [waasmedic-off]`; OpenSSH Server встроен в ОС; WinRM выключен; тот же набор инструментов; 2 vCPU / 2 GB, диск 64 GiB, pagefile 1 GiB; профиль проверки `windows-server`; `pool_ready` = `agent` + `identity`.
- Общий код (`_windows`, агент, `iso-install`, спящий пул) пишется так, чтобы рецепт Server добавлялся без изменений пайплайна.

## 23. Открытые вопросы и риски

- **TRIM:** virtio-win 0.1.271 и 0.1.302 без исправления #1574; `discard_granularity` через `args` недоступен без root. Пока исправления нет, место освобождается удалением LV (sandbox одноразовые), шаблон чуть крупнее. После выхода драйвера с исправлением — новая закреплённая версия и обязательная проверка §15 п. 16.
- **vTPM и спящий режим:** работает ли `suspend --todisk` с `tpmstate0` в Proxmox 9.2 — спайк §21.
- **Порядок specialize:** даст ли `RunSynchronous` в specialize имя `SBX…` без лишней перезагрузки — проверка §15 п. 2, запасной путь — перезагрузка от агента.
- **Счётчик `BootId`** как основа `bootId` (§12.4).
- **OpenSSH FoD на Windows 11** требует Windows Update во время сборки; при сбоях — `openssh: github`.
- **Политики, которые Pro не соблюдает** (`NoLockScreen`, нулевая телеметрия): на ISO Ильи (Pro) экран блокировки обходится autologon и `CONSOLELOCK 0`; проверка §15 п. 7 смотрит на результат.
- **Commit limit:** 4 GB RAM + pagefile на тонком диске; тяжёлые сборки упираются в RAM размера, а не в OOM-killer.
- **Остатки секретов** в pagefile и метаданных NTFS — принятый риск §12.8 (d).
- **Задача «при запуске», созданная пользователем,** может прочитать файлы секретов своей sandbox (после жёсткой остановки) или источника fork до очистки в `early`. Это принятый риск (master, 2026-10-29): fork наследует секреты по замыслу, `user` — администратор внутри VM, граница доверия — VM (§12.3). Проверка приёмки §20 п. 5 остаётся.
- **Ознакомительный срок** шаблона (§17): с чего идёт отсчёт у клонов, измеряет реализация; до этого — пересборка не реже, чем раз в 60 дней (Windows 11 Evaluation).
- **`SyncForegroundPolicy`** задерживает вход до появления сети; цена измеряется в `first_boot_to_desktop_ready` и `boot_to_agent_ready`.
- **Пропущенный «Press any key»** на offline-этапе может загрузить запечатанный диск (§10.3); защита — немедленный `failed`.

## 24. Результаты

Заполняется после реализации: итог спайка §21 (включая проверку OVMF `bootorder`), таблица `sbx-bench s9`, принятые эксперименты §16.3, длительность сборки, размер шаблона в thin pool, выбранный способ установки OpenSSH, итог по `BootId` и specialize.
