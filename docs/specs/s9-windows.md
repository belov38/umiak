# S9. Windows: спецификация

Статус: реализовано по плану `docs/plans/s9-windows.md` (ветка `s9-impl`); цифры с `pve` — §24.4. **Решения Ильи 2026-10-31** (меняют спеку, подробности в §24): только Windows 11; пула через спящий режим нет, спайка vTPM + `suspend --todisk` нет; create холодный — клон шаблона + sysprep specialize на первой загрузке, ≤ 5 min допустимо, 2–3 min хорошо; граница доверия — VM; секреты по §12.8; никаких Tailscale и туннельных сервисов; слот шаблона на `pve` — 598. Разделы о спящем режиме (§14, §15 п. 15, §16, §18.1 п. 4–6, §18.6 п. 1–4, `resume-hint`) помечены «не реализуется в MVP» и оставлены как материал фазы 2.

Раньше: согласовано (master-сессия), 2026-10-29; ревью исполнителем пройдено, замечания внесены. Изменение scope от Ильи (2026-10-29): в MVP только `windows` (Windows 11), Windows Server Core перенесён в фазу 2 (§22). Область S9 из `docs/roadmap.md`. Архитектура: `docs/architecture.md` (§4 агент, §5 хранилище, §6 warm pool, §8 рабочий стол, §11 безопасность). Опирается на `docs/specs/s5-linux-template.md` (пайплайн `sbx-tpl`, который здесь расширяется), `docs/specs/s3-guest-agent.md` (агент, §18 переносимость), `docs/specs/s1-proxmox-foundation.md` (`DiskSet`, snapshot с паузой vCPU), `docs/specs/s6-control-plane.md` (пул, учёт RAM, дедлайны §7.9), `docs/specs/s4-gateway.md` (§9 SSH), `docs/specs/s2-tunnel-protocol.md` (§5.2 smbios).

Решения разделов вопросов 1–4 (пул через спящий режим, секреты на Windows, содержимое образа, идентичность и процессы) согласованы с master-сессией 2026-10-29. Пометка **[S9]** — решение автора спеки в рамках согласованного; его можно менять без нового согласования, если причина записана.

## 1. Зачем и что считается успехом

Шаблон `windows` (Windows 11) даёт агентам и людям Windows-sandbox с тем же API, что у Linux: exec (PowerShell), файлы, порты, SSH, а также рабочий стол (S10). `windows-core` (Windows Server 2025 Core) — фаза 2 (§22). Windows медленно загружается, требует больше RAM, переименовывается только с перезагрузкой и не умеет tmpfs. Спека решает, как при этом сохранить свойства платформы: быстрый claim, чистый fork, отсутствие ручных шагов в сборке и честно описанные отступления.

Успех:
1. Одна команда с Mac собирает шаблон из ISO пользователя и `virtio-win`: установка, инструменты, агент, sysprep, проверка, регистрация. Человек в консоль VM не заходит: Tamper Protection Defender, «Press any key to boot from CD», OOBE обходятся автоматически.
2. Тот же реестр, версии, `promote`, откат и `gc`, что у S5.
3. Claim Windows-sandbox из пула в PoC не дольше 30 s (машина пула спит на диске и не занимает RAM, §14). *Не реализуется в MVP (решение Ильи 2026-10-31): пула Windows нет, create холодный, цель ≤ 5 min, хорошо 2–3 min (§14).*
4. Fork и VM из saved snapshot получают новую идентичность (имя, `MachineGuid`, SSH host keys, пустое состояние агента) до входа пользователя и сохраняют данные пользователя, включая DPAPI.
5. Команды, PTY, файлы, порты, SSH, обновление агента работают на Windows с той же семантикой, что на Linux, кроме отступлений, перечисленных в §12.
6. У `windows` после загрузки есть разблокированная сессия `user` с helper-процессом, на которую опирается S10. *Как сделано: autologon и сессия без блокировки есть, helper `sbx-session` и фаза `desktop` перенесены в S10 (§24.2 п. 2).*

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
 |  7 offline stage (before sysprep): WinPE of the   |
 |    Windows ISO from a one-time BCD ramdisk entry, |
 |    offline autounattend: SYSTEM hive edit         |
 |    (Defender, WaaSMedic), shutdown                |
 |  8 verify-offline: boot the disk, check the log,  |
 |    Start=4, MsMpEng; sbx-agent seal, sysprep      |
 |    /generalize /oobe /shutdown                    |
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

*Как сделано* (`infra/templates/windows/template.yaml`): нет `pool` и `size_default` (пула нет, §14); `shared: _windows`; лишний `reboot` после `40-coding-agents`, перед `50-sbx-agent` (§24.3 R11); `install_timeout_s: 2400`; `step_timeouts` (минуты на шаг: `30-toolchains` 60, `40-coding-agents` 45, `90-cleanup` 120, остальные 60); `verify: windows`; `vmids: [598]`. `vmstatestorage` сборщик не ставит.

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
4. **Установка.** Start и сразу после ответа на вызов start — `sendkey f12` четыре раза в секунду 60 s (`PUT …/sendkey`, право `VM.Console`, §18.1): загрузчик ISO ждёт «Press any key to boot from CD» около 5 s. Нажатия идут по таймеру (250 ms), не дожидаясь ответа на предыдущее: один вызов API на медленном канале идёт секунды. Отдельные отказы (`not running` до старта QEMU, `Broken pipe` монитора) нажатия не останавливают; во время нажатий сборщик не пингует QGA (пинг загружающейся VM надолго занимает воркер pvedaemon). Дальше без участия: WinPE ставит драйверы `vioscsi`, `NetKVM` из virtio-win, размечает диск, ставит редакцию; specialize; OOBE по ответам; `SetupComplete.cmd` ставит `virtio-win-gt-x64.msi` и `qemu-ga-x86_64.msi`. Сборщик ждёт `agent/ping` до `install_timeout` (40 min) **[S9]**.
5. **Шаги.** Каждый шаг — scheduled task от SYSTEM, созданная и запущенная через QGA (`schtasks /create /ru SYSTEM /tr "powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:\build\run-step.ps1 -Step <n>"` и `/run`). Так шаг переживает перезапуск QGA и не упирается в его тайм-ауты (аналог transient unit в S5). `run-step.ps1` находит build ISO по метке тома, пишет лог `C:\sbx-build\logs\<n>.log` и код выхода `<n>.exit`. Сборщик раз в 2 s одним `agent/exec` PowerShell-скрипта читает `<n>.exit` и кусок лога с offset (файлы открываются с FileShare ReadWrite|Delete). `agent/file-read` для файлов, в которые пишет гость, не используется: при тайм-ауте `guest-file-open` qemu-ga на Windows оставляет хэндл без FILE_SHARE_WRITE, и все дальнейшие записи в файл падают. `Write-Log` в `run-step.ps1` при занятом логе повторяет запись, затем копит строки в памяти; ошибка лога не меняет код выхода шага. Шаги до `10-system` идут в Windows PowerShell 5.1, после установки PowerShell 7 — в `pwsh` (решает `run-step.ps1` по заголовку шага).
6. **Offline-этап** (§10.3), после `90-cleanup` и до sysprep, на работающей Windows: `sata2` → offline ISO сменой носителя на ходу (virtio-win остаётся на `sata1`; если Proxmox отказал или оставил смену в pending — выключение, config, загрузка Windows); через QGA exec скрипт PowerShell копирует `\sources\boot.wim` и `\boot\boot.sdi` ISO пользователя в `C:\sbx-pe`, создаёт `{ramdiskoptions}` и запись `osloader` с описанием `sbx offline` (`device`/`osdevice` = `ramdisk=[C:]\sbx-pe\boot.wim,{ramdiskoptions}`, `winpe yes`) и ставит её на одну загрузку (`bcdedit /bootsequence`); код выхода каждого `bcdedit` проверяется. Затем `shutdown /r /t 0` через QGA и ожидание `stopped` (до 10 min); порядок загрузки остаётся `scsi0`. Если QGA снова отвечает с новым временем загрузки, Windows Boot Manager загрузил Windows, а не WinPE: запись ставится ещё раз, после второго раза — `failed`. Затем **verify-offline**: `sata2=none`, `boot=order=scsi0`, start, ожидание QGA; через QGA exec читаются `C:\Windows\Setup\Scripts\sbx-offline.log` (последняя строка `DONE errors <n>` — `DONE errors 0`, строк `ERROR` нет), `Start` служб offline-набора (4 или ключа нет) и процесс `MsMpEng` (не должен работать). Иначе `failed` с хвостом лога. Затем удаляются записи BCD с описанием `sbx offline` (и `{ramdiskoptions}`) и `C:\sbx-pe`; `bcdedit /enum all /v` не должен содержать `sbx offline`, иначе `failed`. Результат — в манифест (`windows.offline`) и в `build.json`. На этой загрузке работает служба агента; SMBIOS-серийника sbx у сборочной VM нет, `identity apply` пропускается, состояние агента стирает следующий `sbx-agent seal`.
7. **Запечатывание** на работающей после verify-offline VM: `sbx-agent seal` (§12.11), затем асинхронно через QGA `sysprep.exe /generalize /oobe /shutdown /quiet /unattend:C:\Windows\System32\Sysprep\sbx-unattend.xml`. Ожидание `stopped` до 30 min. При ошибке в манифест попадают последние строки `C:\Windows\System32\Sysprep\Panther\setuperr.log`: сборщик читает их через QGA до выключения. Если sysprep упал, VM ещё работает. Затем `delete=ide2,sata1,sata2`, `boot=order=scsi0`, `net0 link_down=0`.
8. **Template.** `POST …/template`. Диски становятся `base-<vmid>-disk-<k>` для `efidisk0`, `scsi0`, `tpmstate0` (порядок `k` записывается в `disk_layout`). Удалить build ISO и offline ISO (`media.remove`).
9. **Проверка** (§15) и манифест (S5 §11 + поля §15.2).

Ошибка на любом этапе — как в S5 §7.2. Ожидаемая длительность: 50–80 min (установка 10–15, инструменты 15–25, очистка компонентов 10–20, sysprep 5–10).

## 8. Содержимое образа

Ниже — что должно быть в образе; конкретные ключи реестра, списки пакетов и способ записи решает исполнитель в `steps/` и `files/`. Всё проверяется профилем §15.

### 8.1 Система и службы (`00-base`)

- **Политики до сети:** Windows Update (`NoAutoUpdate=1`; серверы Windows Update не блокируются, потому что из них ставится OpenSSH FoD в `10-system`; служба `wuauserv` выключается в `90-cleanup`), Store (`AutoDownload=2`, без автообновлений приложений), consumer features и CloudContent выключены, Delivery Optimization выключен, телеметрия на минимальном уровне редакции (0 для Enterprise и Server, 1 для Pro), Error Reporting выключен, Edge без first-run и без фоновых обновлений, Copilot, Widgets, Spotlight, советы и рекомендации Start выключены, OneDrive не ставится.
- **Службы выключены** (Disabled): `wuauserv`, `UsoSvc`, `DoSvc`, `WSearch`, `SysMain`, `DiagTrack`, `dmwappushservice`, `MapsBroker`, `lfsvc`, `WerSvc`, `RemoteRegistry`, `Spooler`, `SSDPSRV`, `FDResPub`, `LanmanServer` (нет SMB-сервера и порта 445), `TermService` (RDP), `WinRM`, `CDPSvc` (порт 5040). `WaaSMedicSvc` защищён от изменения онлайн и выключается offline-этапом (§10.3). Запланированные задачи обслуживания (дефрагментация, Compatibility Appraiser, CEIP, автоматическое обслуживание) выключены.
- **Defender полностью выключен** offline-этапом (§10.3) — службы и драйверы `WinDefend`, `WdNisSvc`, `Sense`, `WdBoot`, `WdFilter`, `WdNisDrv` с `Start=4`. Движок не запускается, поэтому Tamper Protection не возвращается (проверено Ильёй на 9001). Почему выключен: граница доверия — VM, Windows Update выключен, а сканирование заметно тормозит `npm install` и сборки.
- **Питание и загрузка:** схема High performance, сон и отключение монитора — никогда, спящий режим гостя выключен (`powercfg /h off`, нет `hiberfil.sys`), Fast Startup выключен. Для BCD: `bootstatuspolicy ignoreallfailures`, `recoveryenabled no`; WinRE выключен (`reagentc /disable`), раздела восстановления нет. Это аналог `GRUB_RECORDFAIL_TIMEOUT=0`: жёсткая остановка не должна приводить к Automatic Repair.
- **Память и секреты** (решение master, §12.8): pagefile включён фиксированного размера (2 GiB **[S9]**: commit = RAM + pagefile, а время очистки при выключении ограничено), `ClearPageFileAtShutdown=1`, дампы памяти выключены (`CrashDumpEnabled=0`). Выключены System Restore и запланированные теневые копии; службы VSS (`VSS`, `swprv`) остаются в режиме Manual: на них работает `fsfreeze` QGA (§12.10).
- **Прочее:** часовой пояс UTC, локаль и раскладка en-US, системная кодовая страница UTF-8 (ACP/OEMCP 65001), `LongPathsEnabled=1`, Developer Mode (символические ссылки без повышения), VBS и HVCI выключены (с `cpu: host` и nested virt на хосте Windows иначе включает Hyper-V под собой и замедляется). Для w32time: NTP `time.windows.com`, `MaxPosPhaseCorrection` и `MaxNegPhaseCorrection` = `0xFFFFFFFF` (большие скачки после пробуждения, §14.3).
- **Firewall включён** во всех профилях: входящие запрещены, все предустановленные разрешающие входящие правила выключены, локальные правила игнорируются политикой (`AllowLocalPolicyMerge=0` в `HKLM\SOFTWARE\Policies\Microsoft\WindowsFirewall\<Profile>` для Domain/Private/Public: Setup и регистрация Appx на клоне снова включают правила), и там же `DoNotAllowExceptions=1` («shields up», в ActiveStore `AllowInboundRules=False`): разрешающие входящие правила не применяются вообще, в том числе AppX capability-правила первого входа `user`, которые лежат вне локального хранилища, уведомления о новых слушателях выключены (`NotifyOnListen=False`, иначе диалог «разрешить доступ» мешает computer-use). Loopback firewall не фильтрует, поэтому CONNECT агента и sshd на loopback работают. Дальнейшая защита — firewall Proxmox (`policy_in=DROP`, S1 §4.4).
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

- Scheduled task `\sbx\session`: триггер «при входе `user`», `RunLevel Highest`, перезапуск при сбое раз в минуту, действие `C:\Program Files\sbx-agent\current\sbx-session.exe` (§13). *Не сделано в S9: задача и helper — S10.*
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

`90-cleanup` → offline-этап (WinPE из одноразовой BCD-записи) → verify-offline (загрузка диска, проверка результата) → `sbx-agent seal` → `sysprep /generalize /oobe /shutdown` → template. Sysprep выполняется один раз на шаблон. Specialize проходит каждая machine пула при первой загрузке; это время скрывает пул (решение master, §11.1).

### 10.2 `sbx-unattend.xml` (ответы для клонов)

- `generalize`: `PersistAllDeviceInstalls=true` (драйверы virtio не переустанавливаются, specialize короче), `SkipRearm=0`.
- `specialize`: `RunSynchronous` → `"C:\Program Files\sbx-agent\current\sbx-agent.exe" identity apply --specialize` (§11.2), затем `reg.exe add` `Start=4` для `dmwappushservice` (§10.3). В Shell-Setup — заглушка `ComputerName=SBXTEMPLATE`: Setup всегда перезаписывает имя, заданное в specialize, поэтому `SBX<12 hex>` ставит агент одной перезагрузкой после setup (R16).
- `oobeSystem`: все экраны OOBE скрыты (`HideEULAPage`, `HideLocalAccountScreen`, `HideOEMRegistrationScreen`, `HideOnlineAccountScreens`, `HideWirelessSetupInOOBE`, `ProtectYourPC=3`) и пропущены (`SkipMachineOOBE`, `SkipUserOOBE`: без них OOBE останавливается на «Who's going to use this device?»), локаль en-US, UTC. Новых учётных записей нет (`user` уже существует), autologon здесь не задаётся (его пишет агент).
- `SystemLocale` нет ни в одном проходе: он переписывает кодовые страницы.
- **Скрипт первой загрузки клона.** Generalize, specialize и OOBE сбрасывают часть настроек образа. `90-cleanup` ставит `C:\Windows\Setup\Scripts\SetupComplete.cmd` (`files/SetupComplete-clone.cmd`) и `C:\ProgramData\sbx-template\firstboot.ps1` (ACL: SYSTEM и Administrators — полный доступ, Users — чтение). Setup запускает его от SYSTEM после OOBE, до первого входа: службы §8.1 (список `lib.ps1`, `CDPSvc`, `dmwappushservice`) → Disabled, ACP/OEMCP/MACCP = 65001 (действуют со следующей загрузки — перезагрузки на переименование), `reagentc /disable`, BCD `recoveryenabled no` и `bootstatuspolicy ignoreallfailures`, NetBIOS выключен, политика firewall `AllowLocalPolicyMerge=0` и `DoNotAllowExceptions=1`. Ошибки только пишутся в `C:\ProgramData\sbx-template\firstboot.log` (без секретов, последняя строка `done`), выход всегда 0. Последнее действие — `C:\ProgramData\sbx-template\firstboot.done` (время UTC), и после ошибок тоже; в образе его нет (`90-cleanup`). Агент запускается параллельно со `SetupComplete.cmd`: пока `SetupComplete.cmd` есть, а `firstboot.done` нет, он ждёт маркер (до 5 мин, потом предупреждение в журнале) перед шагом загрузки и перед перезагрузкой на переименование, иначе перезагрузка обрывает `firstboot.ps1`.
- Файл лежит в `C:\Windows\System32\Sysprep\` и паролей не содержит. После первой загрузки setup сам заменяет копии ответов в `Panther`; агент удаляет `sbx-unattend.xml` на клоне в `identity apply`.

### 10.3 Offline-этап WinPE

Нужен, потому что часть настроек нельзя изменить в работающей Windows: Tamper Protection блокирует Defender, `WaaSMedicSvc` защищён. Root на хосте (как `hivex` у 9001) у сборщика нет.

- WinPE из `boot.wim` ISO пользователя загружается один раз из ramdisk-записи BCD установленной, ещё не запечатанной Windows (§7 п. 6): Windows Boot Manager на диске запускает её детерминированно, без приглашения «Press any key» и без `sendkey`. Windows Setup в этой WinPE находит `autounattend.xml` на offline ISO и в проходе `windowsPE` выполняет `RunSynchronous` → `offline.cmd`. Файл отвечает на страницы языка, ключа и лицензии как ответы установки (`International-Core-WinPE` с `ui_language`, `UserData` с generic-ключом и `AcceptEula`), чтобы Setup не ждал ввода. Сама установка не начинается: скрипт в конце выполняет `wpeutil shutdown`.
- `offline.cmd` (cmd и `reg.exe`, PowerShell в WinPE установки нет): загрузить драйвер диска (`drvload <virtio-win>\vioscsi\w11\amd64\vioscsi.inf`: в WinPE установки драйвера virtio нет, а `DriverPaths` из `windowsPE` действуют только на саму установку); найти том с `\Windows\System32\config\SYSTEM` (буква диска заранее не известна); `reg load HKLM\OFFSYS`; для каждого `ControlSet00x` выставить `Start=4` службам из `offline` рецепта (`defender-off`: шесть служб и драйверов §8.1; `waasmedic-off`: `WaaSMedicSvc`); `reg unload`; записать `\Windows\Setup\Scripts\sbx-offline.log`; `wpeutil shutdown`.
- `dmwappushservice` в offline-набор не входит: без неё sysprep `/generalize` может зависнуть, а offline-этап идёт до sysprep. На шаблоне она Manual; на каждом клоне её выключает specialize (`sbx-unattend.xml`, `RunSynchronous` Order 2: `reg.exe add …\Services\dmwappushservice /v Start /t REG_DWORD /d 4 /f`) до первого запуска служб.
- Сборщик ждёт `stopped` до 10 min. Ошибка в WinPE видна только как тайм-аут (QGA в WinPE нет). Результат проверяется сразу, в verify-offline (§7 п. 6): лог, `Start=4`, `MsMpEng`; `verify` на клоне проверяет его ещё раз (§15 п. 8).
- **Почему не загрузка с CD (R17).** Раньше этап грузил ISO с `boot=order=ide2` и нажимал клавишу на «Press any key to boot from CD». После того как незапечатанная Windows поработала (обычный ход сборки), OVMF пропускал приглашение каждый раз (9 из 9 попыток на `pve`) и грузил диск через запись Windows Boot Manager в `efidisk0`. Одноразовая запись BCD от этого не зависит; если Windows Boot Manager её всё же проигнорирует, QGA ответит с новым временем загрузки (в WinPE его нет), и сборщик поставит запись ещё раз. Этап идёт до sysprep, поэтому загрузка диска вместо WinPE безвредна; verify-offline проверяет результат до sysprep. `VM.Console` нужен только для приглашения установки (§7 п. 4).
- Почему не скрипт PE-этапа установки (как в unattend-generator Schneegans, где установку ведёт свой скрипт: diskpart, dism, правка hive, bcdboot): offline-этап короче, не заменяет Windows Setup и годится для любых будущих offline-правок.

## 11. Первая загрузка клона и идентичность

### 11.1 Machine пула (из шаблона)

1. Specialize: `identity apply --specialize` (§11.2), без перезагрузки от агента.
2. OOBE по ответам, без экранов (`SkipMachineOOBE`, `SkipUserOOBE`); `SetupComplete.cmd` → `firstboot.ps1` (§10.2).
3. Setup перезаписал имя на `SBXTEMPLATE`: агент переименовывает machine в `SBX<12 hex>` одной перезагрузкой (§11.2 п. 8, R16).
4. Обычная загрузка: startup-скрипт `sbx-agent early` (идентичность совпадает, очистка секретов), служба `sbx-agent` запускает sshd, подключается к туннелю.
5. `windows`: autologon `user` → первый вход создаёт профиль → `\sbx\session` запускает `sbx-session` → фаза `desktop: ready` (§13). *Как сделано: только autologon и профиль; helper и фаза `desktop` — S10.*
6. Фаза `pool_ready` (§12.13) → S6 переводит machine в спящий режим (§14). *Не реализуется в MVP (решение Ильи 2026-10-31): после готовности агента — сразу claim (холодный create).*

### 11.2 `identity apply`

Сравнивает `machineId` из smbios с `C:\ProgramData\sbx-agent\identity.json`. При совпадении ничего не делает. Иначе (fork, VM из saved snapshot, первая загрузка после `seal`):

1. Стереть состояние агента (как S3 §7.2 п. 1) и каталог секретов (§12.8); `env` пустой; `sbx_user_ca.pub` — копия шаблонной.
2. `MachineGuid` (`HKLM\SOFTWARE\Microsoft\Cryptography`) = `machineId`.
3. SSH host keys: удалить `C:\ProgramData\ssh\ssh_host_*`, создать новые (`ssh-keygen -A` из встроенного OpenSSH), выставить ACL, которых требует sshd.
4. Имя компьютера `SBX` + последние 12 hex `machineId` в верхнем регистре (15 символов — предел NetBIOS) через `SetComputerNameExW(ComputerNamePhysicalDnsHostname)`.
5. **Только для клона шаблона** (`identity.json` нет, то есть первая загрузка после `seal`): новый случайный пароль `user` (32 символа), `L$sbx_user`, у `windows` — ещё `DefaultPassword` и ключи Winlogon (`AutoAdminLogon=1`, `DefaultUserName=user`, `DefaultDomainName=.`). Профиля `user` в этот момент ещё нет, поэтому ничего не теряется. **Fork и VM из saved snapshot пароль не меняют:** сброс пароля администратором делает недоступными данные DPAPI пользователя (Credential Manager, токены `gh`, cookies Edge), а fork — копия той же машины. LSA secret копируется вместе с диском, autologon и токены агента продолжают работать.
6. Удалить `C:\Windows\System32\Sysprep\sbx-unattend.xml`, если он ещё есть.
7. Записать `identity.json` с `resetPending` (FlushFileBuffers).
8. Если действующее имя (`ActiveComputerName`) ≠ новое и это не режим `--specialize` — перезагрузка (`InitiateShutdownW`, причина «planned»). Fork и VM из saved snapshot поэтому загружаются на одну перезагрузку дольше (решение master: +15–25 s). Клон шаблона тоже: Setup после specialize всегда ставит имя из ответов (`SBXTEMPLATE`), поэтому на его первой загрузке агент делает ровно одну такую перезагрузку после setup (R16, ~25 s). *s10-followups:* `identity.json` хранит `rebootBoot` — `bootId` загрузки, которая попросила перезагрузку. Пока `bootId` тот же, перезагрузка считается ещё не случившейся: каждый запуск агента в этой загрузке просит её снова (не увеличивая `renameReboots` и не упираясь в `MaxRenameReboots`), а фаза `identity` в этой загрузке готовой не становится. Раньше под нагрузкой Windows выполнял перезагрузку позже 2 min ожидания агента, агент после двух перезапусков переставал её просить, становился готовым, sandbox получал claim — и через ~4 min перезагружался под пользователем. Теперь такой create просто дольше; `MaxRenameReboots` считает только загрузки, которые действительно перезагрузились, а имя так и не применилось.

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
- **bootId:** UUIDv5 от `machineId` и счётчика загрузок `BootId` (`HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management\PrefetchParameters`). Пробуждение из спящего режима Proxmox — не загрузка, `bootId` не меняется, и это верно: процессы живы. Если счётчик окажется ненадёжным, исполнитель берёт время загрузки ядра (`NtQuerySystemInformation`) с проверкой устойчивости к смене часов и записывает причину. *Как сделано: запасной путь — случайный UUID в volatile-ключе реестра, а не время загрузки ядра (§24.2 п. 14).*

### 12.5 Пользователи и токены (`Credentials`)

- `user` (по умолчанию): `LogonUserW(user, ".", <пароль из L$sbx_user>, LOGON32_LOGON_INTERACTIVE)` → связанный повышенный токен (`TokenLinkedToken`). Это аналог NOPASSWD sudo из S3 §4 (решение master). Токен с паролем, поэтому у процесса работают DPAPI и Credential Manager. Профиль загружается `LoadUserProfileW` на время команды.
- `SYSTEM`: токен самой службы. Имя `root` — псевдоним `SYSTEM` для переносимости скриптов **[S9]**.
- Другие имена → `invalid_argument user_not_found` (в v1 только эти два).
- Файлы, созданные агентом, получают владельцем пользователя запроса; ACL наследуется от родителя.

### 12.6 Процессы (`Supervisor`, `PTY`)

**Shim.** `sbx-agent shim --id <id>` запускается агентом с `CREATE_BREAKAWAY_FROM_JOB | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` из каталога своей версии. SCM при остановке или перезапуске службы дочерние процессы не убивает, поэтому shim и команды переживают перезапуск и обновление агента. Каталог версии с живыми shim-ами не удаляется (Windows всё равно не даст удалить работающий exe).

- **Job — постоянный именованный объект.** Shim создаёт job `\BaseNamedObjects\Global\sbx-cmd-<id>` через `NtCreateJobObject` с `OBJ_PERMANENT` (право `SeCreatePermanentPrivilege` у SYSTEM есть; вызов ntdll без cgo). Обычный именованный объект исчезает вместе с последним handle: процессы job handle на него не держат, и после смерти shim job нельзя было бы найти. Постоянный job переживает shim и агента до перезагрузки. Агент открывает его по имени (`OpenJobObject`) для `Kill`, `SIGKILL`, `KILL_LEFTOVERS` и восстановления. Постоянство снимает `NtMakeTemporaryObject`, когда команда завершилась без leftovers или её удалили (`Remove`, retention); после перезагрузки объектов нет.
- **Ровно один запуск.** Если job с таким именем уже есть (`STATUS_OBJECT_NAME_COLLISION`), shim выходит: это аналог детерминированного имени unit-а. Маркер `shim.json` и правила повтора `Start` — как в S3 §9.2. Если `OBJ_PERMANENT` окажется недоступен, запасной путь исполнителя: агент держит дубликат handle job (`DuplicateHandle` из shim), а `shim.json` хранит pid-ы для поиска после перезапуска агента; причина записывается в §24.
- **IPC агент ↔ shim:** AF_UNIX-сокет `C:\ProgramData\sbx-agent\run\cmd\<id>.sock` (Go `net` поддерживает AF_UNIX на Windows; ACL каталога — только SYSTEM). Протокол S3 §9.6. Spec команды с env передаётся первым сообщением по сокету, а не файлом: у Windows нет tmpfs. Готовность — сообщение `Started{pid}` вместо `READY=1`. *Как сделано: spec идёт в stdin shim-а, готовность — строка `READY` в его stdout, протокол сокета не менялся (§24.2 п. 3); живость shim — mutex `Global\sbx-shim-<id>` (§24.2 п. 5).*
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
- **`secret_files`** — `C:\ProgramData\sbx\secrets\files\<name>` с атрибутом `FILE_ATTRIBUTE_TEMPORARY`, ACL SYSTEM + `user` (режим из запроса сводится к read-only или read-write; *как сделано: любой бит записи в `mode` → `user` read-write, иначе read-only, §24.2 п. 13*). `link_path` — symlink на файл (как S3 §8.1). ACL защищает от случайного доступа, но не от администратора; от чтения устаревших файлов защищает порядок очистки (§12.3).
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
- **VSS держит запись не дольше 10 s** и снимает заморозку сам. Это совпадает с бюджетом S1 и заменяет watchdog S3 §14.3. Если `fsfreeze-thaw` сообщает, что заморозка уже снята, снимок только crash-consistent, и worker поступает как при `auto_thawed` (S3 §14.3). `Qga.fsfreezeThaw` при ошибке читает `fsfreeze-status` и при `thawed` возвращает `{autoThawed: true}` вместо ошибки; S1 `snapshot` с QGA-хуком по умолчанию отдаёт `SnapshotRef.autoThawed`, а при любой ошибке после `lv.snapshot` удаляет LV снимка.
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
| `resume-hint --unix-ms <t>` | после пробуждения из спящего режима (§14.3); работает и на Linux. *Не реализуется в MVP (решение Ильи 2026-10-31)* |
| `exec --user <u> -- <argv>` | локальный запуск через тот же путь токенов и shim; для verify и QGA (только Administrators) |
| `logs -n <N>` | аналог `journalctl` |

*Как сделано:* ещё `call <Service/Method> [<json>|-]` (unary-вызов API по `admin.sock`, §24.2 п. 4), `selftest --pty`, `quiesce-watchdog --lease <id>`. `exec` и `call` работают через `run\admin.sock`, а не через отдельный путь.

## 13. Рабочий стол: хуки для S10

> *Как сделано (план, решение 2):* в S9 есть только autologon `user`, отсутствие блокировки и мастеров первого входа (`60-desktop`). `sbx-session.exe`, задача `\sbx\session`, `run\session.sock` и фаза `desktop` не сделаны, это S10; `readiness.required = ["identity", "claim", "secrets"]`. `CommandSpec.desktop = true` → `failed_precondition desktop_not_ready`.

- **Autologon** `user` в консольную сессию (§11.2, §8.7); блокировки, UAC-запросов и мастеров первого входа нет.
- **`sbx-session.exe`** — helper в интерактивной сессии: служба из session 0 не может захватывать экран и посылать ввод. Запускается задачей `\sbx\session` при входе, повышенный (UIPI не мешает управлять повышенными окнами). Подключается к агенту по AF_UNIX `run\session.sock` (ACL: SYSTEM и `user`) и сообщает `Hello{session_id, user, version}` и `State{locked, input_desktop, width, height, dpi}` при каждом изменении (уведомления WTS о сессии). Принимает `ApplyEnv` (§12.7). Протокол — protobuf с префиксом длины, расширяемый: захват экрана, ввод, буфер обмена и запуск стримера добавит S10.
- **Фаза `desktop`:** `ready`, когда helper подключён, сессия активна и разблокирована, а входной рабочий стол — `Default` (не `Winlogon`). Иначе `pending`, а с ошибкой (helper падает в цикле) — `failed`.
- **`CommandSpec.desktop: true`** (новое поле proto): процесс запускается в консольной сессии (`WTSGetActiveConsoleSessionId` → `WTSQueryUserToken` → связанный повышенный токен), на `winsta0\default`, внутри job shim-а, с захватом вывода как обычно. Если сессии нет → `failed_precondition desktop_not_ready`. На Linux поле определит S10.
- Видеоадаптер, разрешение, Sunshine, cua-driver — S10.

## 14. Пул, загрузка, спящий режим

> **Не реализуется в MVP (решение Ильи 2026-10-31).** Пула Windows через спящий режим нет, спайка vTPM + `suspend --todisk` (§21 п. 1) нет, `resume-hint` нет, `vmstatestorage` не ставится. **Create — холодный:** S1 `create` клонирует шаблон (со свежим vTPM, §9), первая загрузка проходит sysprep specialize и OOBE (§11.1 п. 1–3), затем claim. Цель ≤ 5 min, хорошо 2–3 min; дедлайн S6 cold create 20 min (§14.5) с запасом. Цель пула `windows` = 0. Stop Windows — обычное выключение (§14.6). Текст §14.1–14.4 оставлен как материал для фазы 2.

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
3. `agent/ping` QGA, затем `agent/exec`: `sbx-agent resume-hint --unix-ms <время хоста>` (*`resume-hint` не реализуется в MVP, решение Ильи 2026-10-31*). Агент:
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
2. **Specialize:** имя `SBX<12 hex>` тестового `machineId`; `MachineGuid` = `machineId`; число загрузок первой загрузки не больше, чем у setup без агента, плюс одна плановая перезагрузка `sbx-agent.exe` на переименование (R16; по журналу событий, ID 6005/1074); `firstboot.log` кончается `done`; `sbx-unattend.xml` удалён; в `Panther` нет пароля.
3. **Сокеты:** TCP-слушатели только из allow-list рецепта: `127.0.0.1:22`, `[::1]:22`, 135 и динамические RPC 49664–49670 (`lsass`, `wininit`, `services`, `svchost`, `spoolsv`, `System`). Портов 3389, 5985, 5986, 445, 139, 5357, 7680 нет. UDP: DHCP-клиент, mDNS и LLMNR выключены.
4. **Firewall:** включён во всех профилях, входящие по умолчанию запрещены, ни одного действующего разрешающего входящего правила: в ActiveStore `AllowInboundRules=False` во всех трёх профилях (оставшиеся разрешающие правила не применяются и только перечисляются) или нет ни одного включённого разрешающего входящего правила (при `AllowLocalPolicyMerge=0` — в `-PolicyStore ActiveStore`), `NotifyOnListen=False`.
5. **sshd:** `sshd -T` — `passwordauthentication no`, `trustedusercakeys`, оба `listenaddress`; служба работает (её запустил агент); host keys созданы в эту загрузку; `DefaultShell` = pwsh 7. Вход по сертификату с тестовым CA: `ssh -i <key> -o CertificateFile=<cert> user@127.0.0.1 "$env:SBX"` (CA подкладывается через `sbx_user_ca.pub` на время проверки).
6. **Агент:** `sbx-agent doctor --json` — версия, `identity` ready, URL туннеля из `family`, служба Running, failure actions заданы, startup-скрипт отработал (`early.json`), фазы по профилю.
7. **Пользователи и вход:** `user` в Administrators, пароль бессрочный, LSA secret есть; Administrator и Guest выключены; UAC: `EnableLUA=1`, `ConsentPromptBehaviorAdmin=0`, `PromptOnSecureDesktop=0`. `windows`: сессия `user` активна (`query user`) и не заблокирована (`WTSSessionInfoEx`), `LogonUI.exe` в этой сессии не работает (ожидание до 180 s после готовности агента), фаза `desktop` = ready.
8. **Службы и политики:** §8.1 — состояния служб, Defender (`Start=4` у шести служб и драйверов, процесса `MsMpEng` нет), `WaaSMedicSvc` `Start=4`, `sbx-offline.log` без ошибок, Fast Startup и спящий режим гостя выключены, pagefile есть и `ClearPageFileAtShutdown=1`, `CrashDumpEnabled=0`, VBS выключен (`Win32_DeviceGuard`), BitLocker выключен (`manage-bde -status`), TPM готов и отличается от шаблона (`Get-Tpm`, у `windows`), BCD `bootstatuspolicy`/`recoveryenabled`, WinRE выключен, кодовая страница 65001.
9. **Инструменты:** каждая команда §8.5 — `--version` от `user` прямым exec и через `pwsh -Command`; версии = манифест; `npm -g` пишет в `C:\ProgramData\npm`.
10. **Сеть:** IPv4 из `10.88.0.0/24`, `Resolve-DnsName example.com`, `Invoke-WebRequest https://example.com`; время синхронизировано, часовой пояс UTC.
11. **Процессы агента:** через `sbx-agent exec` и путь `shell`: коды выхода по контракту §12.6; `.cmd` из `PATH` (`npm --version`) запускается; ConPTY-сессия с `pwsh` отвечает на ввод (локальный selftest `sbx-agent selftest --pty`).
12. **VSS:** QGA `fsfreeze-freeze` → `fsfreeze-status` = frozen → `fsfreeze-thaw` за ≤ 10 s, в журнале событий нет ошибок VSS.
13. **Смена идентичности (fork-путь):** *как сделано — настоящий fork: S1 snapshot с QGA VSS-хуком → `cloneFromSnapshot`, источник выключается до старта fork из-за RAM (§24.2 п. 9). На медленном хосте (пауза vCPU + lvcreate + resume дольше ~10 s удержания VSS) снимок с `FreezeBudgetExceededError` или `autoThawed` повторяется один раз, потом берётся crash-consistent снимок со строкой `WARN vss_snapshot` (время заморозки и причина); проверки fork остаются критерием.* Выключить VM, поменять `smbios1` (новый `machineId` и BS), загрузить. Произошла одна перезагрузка на переименование; новое имя, `MachineGuid`, host keys, пустое состояние агента, `identity.reset` в журнале; пароль `user` прежний, autologon работает, секрет, сохранённый через DPAPI до смены идентичности, читается. Время записывается.
14. **Жёсткая остановка:** S1 `stop` без shutdown, затем start; загрузка без Automatic Repair, время до готовности агента ≤ обычная загрузка + 10 s.
15. *Не реализуется в MVP (решение Ильи 2026-10-31, §14).* **Спящий режим** (если `pool.mode = hibernated`): S1 `hibernate`, start, `resume-hint`; агент подключён и `pool_ready`; часы расходятся с хостом < 2 s; `windows`: сессия не заблокирована. Время записывается.
16. **TRIM:** `Optimize-Volume -ReTrim`. Пока закреплённый virtio-win не содержит исправления, ошибка — предупреждение; после — красная проверка.
17. **Лицензия:** редакция, состояние лицензии, канал, оставшиеся дни (`SoftwareLicensingProduct`) → манифест (`license`). Для `channel = evaluation`: проверка ждёт до 10 min онлайн-активации ознакомительной версии на клоне; меньше 30 дней — предупреждение, меньше 7 — красная проверка (§17). Для `retail` и `volume` проверяется только совпадение редакции; неактивированная Windows — не ошибка.
18. **Остатки:** нет `C:\sbx-build`, установщиков, файлов `authorized_keys`; `C:\ProgramData\sbx-template\build.json` есть.
19. **Замеры загрузки** (§16) → `verify.boot` в манифесте.

### 15.2 Манифест: поля Windows

К S5 §11: `windows` {`edition`, `build`, `ubr`, `family`, `isoFile`, `isoSha256`, `virtioWinVersion`, `openssh` (inbox/github и версия), `appxRemoved`, `options`, `offline` {`services` с `Start=4`, `missing` без ключа, `log`}}, `license` {`status`, `channel`, `daysRemaining`, `expiresAt`}, `verify.boot` (§16), `poolMode`.

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
| `hibernate` | длительность `suspend --todisk`, размер LV состояния. *Не реализуется в MVP (решение Ильи 2026-10-31)* |
| `resume_to_agent_ready` | start спящей → `resume-hint` → агент подключён и `pool_ready`. *Не реализуется в MVP (решение Ильи 2026-10-31)* |
| `freeze` | QGA VSS freeze → thaw |

*Как сделано* (`apps/bench/src/s9.ts`): метрики `create`, `create_to_agent_ready`, `first_boot_to_agent_ready`, `boot_to_agent_ready`, `start_to_qga`, `tunnel_connected`, `hard_stop_restart`, `freeze_ms`, `fork_snapshot_ms`, `fork_clone_ms`, `fork_start_to_agent_ready`, `fork_boot_to_agent_ready`, `fork_to_agent_ready` (определение — §24.3 R13), `fork_tunnel_connected`. `first_boot_to_desktop_ready` нет (фаза `desktop` — S10).

### 16.2 Цели (оценки, проверяются; цифры пишутся в §24)

На `pve`, `local-lvm`, размеры §9: `first_boot_to_desktop_ready` ≤ 4 min; `boot_to_agent_ready` ≤ 60 s; `identity_change_boot` ≤ 2 min; `hibernate` ≤ 30 s; `resume_to_agent_ready` ≤ 20 s (claim-to-ready ≤ 30 s). *Для MVP: `hibernate` и `resume_to_agent_ready` не измеряются; вместо claim-to-ready цель — `create_to_agent_ready` ≤ 5 min (хорошо 2–3 min).*

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

1. **Право `VM.Console`** в роль `SbxPoC` на pool `sandbox` (решение master): `sendkey` для «Press any key» при установке (offline-этапу не нужен, R17).
2. **`DiskSet` с `efidisk0` и `tpmstate0`** проверяется на деле: `snapshot`, `cloneFromSnapshot`, `delete` для трёх дисков; опции `efitype`, `pre-enrolled-keys`, `ms-cert`, `version` переносятся. `cloneFromTemplate` клонирует `scsi0` и `efidisk0`, а `tpmstate0` создаёт новым через PVE API при `create` (§9). Новый том Proxmox называет `vm-<vmid>-disk-<k>` без тега `sbx`; `delete` удаляет его через `purge` и проверяет, что `vm-<vmid>-*` не осталось. В `sbx-bench s1` — прогон с Windows-шаблоном (fork загружается, `Get-Tpm` в fork `TpmReady`).
3. **Белый список железа:** + `efidisk0`/`tpmstate0` опции, `vmstatestorage`; `machine` с версией копируется как есть.
*П. 4–6 не реализуются в MVP (решение Ильи 2026-10-31, §14).* П. 1 сделан отдельной ролью `SbxConsole` (§24.3 R4).

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

*П. 1–4 не реализуются в MVP (решение Ильи 2026-10-31, §14). Что сделано в worker и что осталось S6 — §24.5.*

1. **Состояния machine:** `suspending` (усыпляется; RAM в `reserved` и `powered`) и `hibernated` (warm на диске; RAM нигде не учитывается). `hibernated` — предложение для пула (supply считает `allocating`, `provisioning`, `booting`, `warm`, `suspending`, `hibernated`).
2. **`poolTargets.mode`:** `running | hibernated` (по умолчанию из `template.yaml pool.mode`). После `pool_ready` при `mode = hibernated` контроллер переводит machine в `suspending` → S1 `hibernate` → `hibernated`.
3. **Claim:** из `warm` (если есть) раньше, чем из `hibernated`. Claim `hibernated`: admission RAM (как resume), machine → `claiming` (в `reserved`), шаги §14.3 (start с проверкой RAM, QGA `resume-hint`, ожидание подключения), затем claim. Ошибка → `deleting`, повтор по правилам S6 §7.3.
4. **Правила пула:** §9.2 п. 5 (агент отключён > 60 s) не применяется к `suspending` и `hibernated`. `maxAgeHours` — как у warm. Reconcile ожидает у `hibernated` статус Proxmox `stopped` с `lock: suspended`; иначе → `deleting`. Delete `hibernated` — S1 `discard-suspend`, затем обычный delete (§18.1 п. 5).
5. **Saved snapshot Windows** (условие b): работающая machine — составной quiesce (§12.10) с `wipe_secret_files`; `secrets_in_use` → операция падает с `snapshot_requires_stop` (S7). Остановленная machine — разрешено, только если `machines.secret_files_on_disk = false`. Поле ставится в `true`, когда Windows-machine получила непустые `secret_files`, и в `false` по ответу `PrepareStop{secret_files_wiped: true}` перед штатным shutdown или после замены набора на пустой. Жёсткая остановка оставляет `true` → `snapshot_requires_clean_stop`. Fork этими правилами не ограничен.
6. **`QuiesceHook` для Windows** — составной (§12.10); выбор по `template_builds.os`.
7. **Повторная отправка секретов:** `UpdateSecrets` и при `readiness.changed{secrets: pending}` без смены `boot_id` (перезапуск или обновление агента на Windows), а не только после перезагрузки.
8. Hostname: для Windows поле sandbox не применяется в госте; действующее имя берётся из `System/Info`. `user` = `root` в командах маппится агентом на `SYSTEM`.
9. Дедлайны §7.9 и `boot_timeout_s` — подтверждены (§14.5).
10. **Stop Windows:** шаг `prepare` (`System/PrepareStop`, 10 s) на Windows стирает файлы секретов и отвечает `secret_files_wiped` (§12.8); тайм-аут `shutdown` для `os = windows` — 120 s вместо 60 s (очистка pagefile при выключении, §8.1), затем жёсткий `stop`, как сейчас. С 2026-11-01 — 300 s (§24.9 п. 7).

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

1. *Не делается (решение Ильи 2026-10-31): пула через спящий режим нет. Проверки OVMF `bootorder` и `OBJ_PERMANENT` идут в сборке и в тестах агента на `pve`.* **Спайк (первым, решение master):** на `pve` в диапазоне PoC — Windows 11 VM с vTPM и OVMF (можно временно, вне пайплайна), `suspend --todisk` → `start`: состояние TPM и сессии сохраняется, время усыпления и пробуждения, размер тома состояния; `discard-suspend` (прототип `sbx-node`) и удаление; заодно — загружает ли OVMF Proxmox запись Windows Boot Manager из `efidisk0`, если в `boot` только `ide2` (§10.3), и работает ли постоянный job (`OBJ_PERMANENT`, §12.6). Итог: `pool.mode` для Windows и цифры в §24. Провал → цель `windows` = 0.
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
- **Windows Boot Manager игнорирует одноразовую запись WinPE** (§10.3): грузится Windows вместо WinPE; этап идёт до sysprep, поэтому это безвредно: запись ставится ещё раз, результат проверяет verify-offline.

## 24. Результаты и решения реализации

План: `docs/plans/s9-windows.md` (раздел «Decisions taken here»). Ниже — что из реализации меняет или уточняет разделы выше.

### 24.1 Решения Ильи 2026-10-31

- Только Windows 11 (`windows`); Server Core — фаза 2 (§22).
- Пула через спящий режим нет, спайка vTPM + `suspend --todisk` нет (§14, §21 п. 1). Create — холодный: клон шаблона + sysprep specialize на первой загрузке; ≤ 5 min допустимо, 2–3 min хорошо.
- Граница доверия — VM. Секреты — по §12.8.
- Никаких Tailscale и туннельных сервисов (cloudflared, ngrok и т.п.) ни в коде, ни в образе.
- Слот шаблона на `pve` — 598 (`vmids: [598]`); 597 и 599 — Linux.

### 24.2 Решения плана и реализации

1. **Нет спящего режима** (план 1): из рецепта убраны `pool` и `size_default`; §14, §15 п. 15, метрики `hibernate`/`resume_to_agent_ready` §16, §18.1 п. 4–6, §18.6 п. 1–4 и `resume-hint` не реализованы.
2. **Helper рабочего стола — в S10** (план 2): autologon `user` делает `identity apply`; `sbx-session.exe`, `\sbx\session`, `run\session.sock` и фаза `desktop` не сделаны. `readiness.required = ["identity", "claim", "secrets"]`. `CommandSpec.desktop = true` → `failed_precondition desktop_not_ready`.
3. **Spec — в stdin shim-а, готовность — строка `READY`** в его stdout (`FAIL <текст>` или EOF — ошибка запуска), а не первое сообщение по сокету и не файл (§12.6): у Windows нет tmpfs, и нет курицы и яйца с сокетом. Протокол сокета (shimproto) не менялся.
4. **Локальный admin-сокет** `C:\ProgramData\sbx-agent\run\admin.sock` (ACL SYSTEM + Administrators) всегда отдаёт полный API агента, как `--debug-listen` на Linux. Его клиенты — `sbx-agent exec` и `sbx-agent call` (verify и QGA-восстановление). `exec` по нему не ждёт отложенных секретов, но для не-SYSTEM пользователя проверка готовности загрузки остаётся. Коды выхода `exec`: 125 — ошибка агента или CLI, 127 — `START_FAILED`. `run\env.sock` (ACL SYSTEM, Administrators, `user`) отдаёт только env для `sbx-agent env --format pwsh` (HTTP `GET /env`).
5. **Живость shim** — именованный mutex `Global\sbx-shim-<id>`, который держит shim; команда — постоянный job `Global\sbx-cmd-<id>`. `State`: mutex есть или в job есть процессы → `UnitActive`; job есть и пуст → `UnitInactive`; иначе `UnitNotFound`.
6. **Инструменты скачиваются в сборочной VM** по официальным URL из `versions.toml` и проверяются `Get-FileHash` по закреплённому sha256 (в build ISO их нет).
7. **Тесты агента на настоящей Windows:** `go test -c` для `GOOS=windows` (`services/guest-agent/test/windows/build-tests.sh`), бинарники — на ISO, подключённом к клону шаблона (R12), запуск от SYSTEM (`sbx-bench s9 agent-tests`). Job GitHub Actions на `windows-2025` (`workflow_dispatch`) — по желанию, не gate (уточнение §18.3 п. 4).
8. **Свой vTPM у каждой machine** (§9): S1 `create` из шаблона не клонирует `tpmstate0`, а добавляет `tpmstate0=<storage>:1,version=v2.0` через PVE API; fork и `cloneFromSnapshot` копируют его.
9. **Verify использует fork** для проверки смены идентичности (§15 п. 13): S1 snapshot с QGA VSS-хуком → `cloneFromSnapshot` вместо правки `smbios1`; источник выключается до старта fork (RAM). Fork готов, только когда `System/Info.hostname` — новое имя.
10. **Загрузочный диск шаблона** — `scsi0` = `base-598-disk-1` (`SLOT_ORDER` efidisk0, scsi0, tpmstate0); проверки диска в сборщике берут индекс слота из `diskLayout`, а не `disk-0`.
11. **Hostname из claim на Windows не применяется** (§11.3): `hostname_applied = false`, значение — env `SBX_HOSTNAME`.
12. **Переключение версий — junction-ы NTFS** (`FSCTL_SET_REPARSE_POINT`): временный junction, удаление старого, rename; защищено `pending-update.json`. Пропавший `current` восстанавливают `early` и `rollback` (`RepairCurrent`: `to` из `pending-update.json` → `from` → `previous`).
13. **Файлы секретов** (§12.8): на Windows содержимое `secret_files` хранится и в памяти агента (`SecretEnvInMemory`), чтобы `Thaw` после quiesce восстановил стёртые файлы; на Linux — нет. `PrepareStop`, когда файл открыт без совместного доступа, — успех с `secret_files_wiped = false` (не ошибка); стёрто всё, что можно. `mode` с любым битом записи → `user` read-write, иначе read-only (на Linux — точный `mode`). Записи Administrators в ACL нет: у `user` повышенный токен, и она дала бы запись в read-only секрет. Новый файл создаётся рядом с итоговым DACL и `FILE_ATTRIBUTE_TEMPORARY`; существующий перед заменой перезаписывается нулями на месте.
14. **Запасной `bootId`** (§12.4): если счётчик `BootId` не читается — случайный UUID в volatile-ключе `HKLM\SOFTWARE\sbx-agent\Volatile` (SYSTEM only, живёт до перезагрузки). Время загрузки ядра не подходит: оно сдвигается при установке часов.
15. **Бюджет заморозки агента зависит от ОС:** на Windows часть агента в `freeze()` (watchdog, хуки `*.ps1` до 5 s каждый, очистка секретов) ограничена 20 s, на Linux — 5 s. Из 30 s на весь `freeze()` (§12.10) 10 s остаются VSS. Lease quiesce должен быть больше 20 s (worker: 30 s). Очистка секретов — после хуков заморозки (хуки могут остановить процессы, держащие файлы); при thaw файлы восстанавливаются до хуков. Watchdog на Windows выполняет thaw-хуки, но файлы не восстанавливает (вне процесса агента нечем); `sbx-agent thaw --force` вызывает `System/Thaw` по admin-сокету.
16. **Пути:** API файлов отвергает пути без диска (`\x`, `/x`) — `invalid_argument invalid_path`, а `cwd` команды отображает `\x` на диск профиля пользователя. Буква диска приводится к верхнему регистру.
17. **`PRESHUTDOWN`** (§12.2): сначала завершает job-ы команд (`TerminateJobObject`, до 3 s), затем `PrepareStop` (очистка секретов, сброс `state.db`); всё в пределах 10 s из 15 s тайм-аута.
18. **Failure actions SCM:** restart 1 s, restart 1 s, затем `cmd.exe /d /c if exist "<previous>\sbx-agent.exe" (… rollback) else ("<current>\sbx-agent.exe" rollback)`; сброс 120 s. То есть новая версия получает два перезапуска за 120 s, после этого — откат. Любой выход по инициативе агента (обновление, откат, смена идентичности) — код 75 без `SERVICE_STOPPED`. Пропавший `current` failure actions не лечат (путь образа не разрешается), это делает `early` (п. 19).
19. **Обёртка `sbx-early.cmd`** — startup-скрипт GPO: запускает `sbx-agent early` из `current\`, иначе `previous\`, иначе новейшего `versions\<v>\`.
20. **ACL каталогов агента:** `state\` — защищённый DACL только SYSTEM, `run\` — SYSTEM + Administrators; ставятся до чтения `early.json` и открытия сокетов. `early.json` с владельцем не SYSTEM/Administrators игнорируется.
21. **Загрузка клона:** если служба видела идущий Windows Setup, после его конца она сразу делает boot step сама, без 60 s ожидания `early.json` (на первой загрузке клона startup-скрипт отработал во время Setup и ничего не сделал). Ошибка boot step → выход 75 и повтор через failure actions. Пока идентичность не готова, сокеты не открыты.
22. **Шаги сборки:** `00-base`…`90-cleanup` в `infra/templates/_windows/steps/`; `60-desktop` — только экран блокировки, первый вход и Default User hive. Шаг `10-system` ставит OpenSSH только из FoD (`openssh.source = inbox`), запасной `github` не реализован.
23. **Первая загрузка клона** (§10.2, §11.1): `SkipMachineOOBE`/`SkipUserOOBE`, заглушка `ComputerName=SBXTEMPLATE`, без `SystemLocale`; `SetupComplete.cmd` клона запускает `firstboot.ps1`, который возвращает то, что сбросил sysprep (службы, кодовые страницы, BCD, WinRE, NetBIOS, политика firewall). Проверено на клоне 26H2: OOBE проходит, autologon `user` работает; ACP применяется только после перезагрузки на переименование.
24. **Путь с файлом вместо каталога в середине:** NTFS отвечает `ERROR_PATH_NOT_FOUND`, а Go определяет `syscall.ENOTDIR` как тот же код, поэтому на Windows это `not_found path_not_found`, если файловый сервис не увидел файл на пути сам (тогда `failed_precondition not_directory`, как на Linux).
25. **Гранулярность обрезки вывода на Windows — 64 KiB** (sparse-файлы NTFS освобождают место блоками по 64 KiB); `available_from` всегда кратен 64 KiB, на Linux — 4 KiB.

### 24.3 Решения координатора (R1–R17)

| | Решение | Что меняет |
|---|---|---|
| R1 | Task 10 раньше Task 9 | порядок работ |
| R2 | 30 s ожидания отложенных секретов в `Start` — только Windows (`PendingSecretsWait`: Linux 0, Windows 30 s) | §18.3 п. 5: на Linux не включено |
| R3 | два параллельных трека (Go и TS) | порядок работ |
| R4 | `setup.sh console` — отдельная роль `SbxConsole` (`VM.Console` на `/pool/sandbox`), а не право в `SbxPoC` | §18.1 п. 1 |
| R5 | слот шаблона Windows — 598, только после удаления старого 598 в `s5-fix`; 597 не трогать | §24.1 |
| R6 | эпилог pwsh отделён от скрипта пустой строкой (`\n\n`): завершающий backtick не съедает его | §12.6 |
| R7 | shim сам заново разрешает программу и строит `BatchCommandLine`, передаёт разрешённый путь как application name; файл длинного скрипта pwsh читаем пользователем команды | §12.6 |
| R8 | `offline.cmd` всегда кончается `wpeutil shutdown`; ошибки — `DONE errors <n>` в `sbx-offline.log`, их судит verify (§15 п. 8) | §10.3 |
| R9 | ОС-независимый код сервера shim перенесён в файл `linux \|\| windows` без изменений | структура кода |
| R10 | `DoSvc` остаётся Manual до `90-cleanup` (FoD качается через Delivery Optimization), выключается там вместе с `wuauserv`, `UsoSvc` | §8.1, §8.8 (итоговый образ не меняется) |
| R11 | вторая перезагрузка после `40-coding-agents`, перед `50-sbx-agent`: DISM `ResetBase` в `90-cleanup` падает при отложенных операциях CBS, а перезагрузка после `50` запустила бы агент и `identity apply` на сборочной VM | §5 `steps` |
| R12 | `agent-tests` подключает тестовые бинарники ISO-образом (`sbx-build-agenttests-<ts>.iso`, `ide2`), а не копирует по QGA | §24.2 п. 7 |
| R13 | `fork_to_agent_ready` = длительность snapshot + (`cloneFromSnapshot` → start → готовность с новым именем); выключение источника между ними не входит; обе части в отчёте | §16 |
| R14 | `env --format pwsh`: значения с управляющими символами (или не UTF-8) — `$env:K = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('<b64>'))`, остальные — `$env:K = '<v>'` с удвоенными `'`; `profile.ps1` принимает ровно эти две формы | §8.4, §12.7 |
| R15 | offline-этап до sysprep (сборка 9 загрузила запечатанный диск): загрузка диска вместо WinPE выключается и повторяется (до 3 попыток), результат проверяется загрузкой диска до sysprep (verify-offline); `dmwappushservice` выключает specialize клона, а не offline-этап | §7 п. 6–7, §10.1, §10.3, §15.2 |
| R16 | одна перезагрузка агента на переименование на первой загрузке клона (запасной вариант §23): Setup перезаписывает имя из specialize во всех опробованных вариантах; цена ошибки ~25 s на create | §10.2, §11.1, §11.2 п. 8, §15.1 п. 2 |
| R17 | offline-этап грузит WinPE не с CD, а из одноразовой ramdisk-записи BCD (`bcdedit /bootsequence`) установленной, ещё не запечатанной Windows: после работы Windows OVMF пропускал «Press any key» 9 раз из 9; запись и `C:\sbx-pe` удаляет verify-offline; нажатия клавиш остаются только у установки; заменяет загрузку с CD и повторы R15 | §7 п. 4, 6, §10.1, §10.3, §18.1 п. 1, §23 |

### 24.4 Результаты на `pve`

| Что | Значение |
|---|---|
| Длительность сборки (`sbx-tpl build windows`, без verify / с verify) | ≈ 27 min / 34.7 min (сборка `20261031.9`; verify отдельно 7.5 min) |
| Размер шаблона в thin pool (`base-598-disk-*`) | 16.6 GiB занято из 96 GiB (`diskUsedGiB`) |
| Способ установки OpenSSH (FoD inbox, версия) | FoD inbox, `OpenSSH_9.5p2 for Windows` |
| Счётчик `BootId` (надёжен / запасной путь) | надёжен: читается на клоне (`PrefetchParameters\BootId`), volatile-ключ агента не создаётся |
| Перезагрузки на первой загрузке клона (specialize, §15 п. 2) | 3 загрузки после seal: 2 от Setup (sysprep, winlogon) + 1 переименование агентом (R16) |
| Create: `create_to_agent_ready` (медиана / p95) | S1 create ≈ 2 s; start → агент готов: медиана 111.0 s, максимум 127.2 s (7 замеров: 5 попыток bench + 2 verify) |
| Fork: `fork_to_agent_ready` (медиана / p95; snapshot + clone→ready) | start fork → агент готов под новым именем: 44.6 / 45.8 / 47.7 s (3 verify); snapshot ≈ 2–4 s; bench `--runs 3` не завершён (зависание thaw, §24.5) |
| `freeze_ms` (QGA VSS freeze → thaw) | 544 / 614 / 1100 ms (окно pause + `lvcreate` в snapshot, 3 verify) |
| `first_boot_to_agent_ready` / `boot_to_agent_ready` | медиана 111.0 s / 16.5–21.3 s; после hard stop 14.0–16.9 s (медиана 15.2 s) |

### 24.5 Контракты для соседних областей

Исторический список приёмки; актуальные решения follow-ups, включая замену QGA/VSS на crash fallback, — §24.7; snapshot Windows только из остановленной VM (заменяет crash fallback) — §24.8.

- **S6.** Сделано в worker (S9 Task 4): тайм-аут shutdown для `os = windows` — 120 s; составной quiesce-хук (агент `fs: false`, `wipe_secret_files` для `kind = saved`, затем QGA VSS); результат `PrepareStop{secret_files_wiped}` пишется в прогресс stop. Осталось S6:
  - `machines.secret_files_on_disk` и правила saved snapshot (§18.6 п. 5): `secrets_in_use` → `snapshot_requires_stop`, остановленная machine с `true` → `snapshot_requires_clean_stop`;
  - saved snapshot с `auto_thawed` выбрасывать: истёкший lease между `Quiesce` агента и QGA `fsfreeze` восстанавливает файлы секретов до VSS;
  - для Windows всегда отправлять `fs: false` (по умолчанию `fs` = true → `fs_freeze_unsupported`);
  - `lease_ms` quiesce больше 20 s (§24.2 п. 15);
  - повторная отправка `UpdateSecrets` при `readiness.changed{secrets: pending}` без смены `boot_id` (§18.6 п. 7) — в S9 не делалась.
  - `stop` сразу после `shutdown` + `start` может упасть с `can't lock file ... got timeout`: qmeventd до 30 s держит lock VM, пока ждёт выхода старого QEMU (видно на `pve`). Worker считает это временной ошибкой (`TRANSIENT_4XX_RE`) и повторяет; повторы должны покрывать 30 s. Snapshot в этом окне ждёт lock внутри бюджета заморозки и падает по `freeze took … (budget …)`; worker должен повторять и это (или не снимать snapshot раньше 35 s после start, `VM_LOCK_AFTER_RESTART_MS`). `retryOnVmLock` из `@sbx/pve` — готовый повтор для stop и snapshot.
  - **Открыто:** S1 snapshot работающей Windows-machine (QGA VSS freeze → pause → `lvcreate` → resume → thaw) примерно в половине попыток подвешивает thaw в qemu-ga: гость остаётся замороженным (12 min без записей на диск, `agent.log` и журналы Windows пусты), сокет QGA занят до hard stop (`ThawFailedError`). Видно в bench (snapshot через 35 s после рестарта, 3 из 3) и вручную (3 из 6); fork-snapshot verify прошёл во всех трёх прогонах, ручная последовательность `qm` + `lvcreate` на свежей загрузке — тоже. Нагрузка хоста, разогрев (freeze + thaw заранее) и время после загрузки причину не объясняют; она в qemu-ga/VSS Windows и не найдена. После hard stop NTFS целая, записи гостя после freeze потеряны. Защита S6 реализована в `s9-fix`: ограниченное ожидание thaw и hard stop при `ThawFailedError` (§24.6); первопричина остаётся открытой.
- **S7.** Документация семантики Windows и коды ошибок §18.7, в том числе `desktop_not_ready` (пока на любой `desktop: true`), `secrets_in_use`, `fs_freeze_unsupported`; `hostname_applied = false`; `exec`/`call` — локальные инструменты, не API.
- **S10.** Не сделано в S9: `sbx-session.exe`, задача `\sbx\session`, `run\session.sock`, фаза `desktop` (и `desktop` в `readiness.required`), запуск команд с `CommandSpec.desktop` в консольной сессии (§13). Есть: autologon `user`, без блокировки и мастеров первого входа.


### 24.6 Исправления приёмки S9 (`s9-fix`, 2026-11-01 NZ / 2026-10-31 UTC)

Решения и поведение:

1. **Resumable upload / NTFS ACL.** На Windows commit всегда копирует содержимое в `writeTemp` рядом с целью, затем атомарно размещает файл. Rename из SYSTEM-only `state\uploads` больше не переносит его DACL. Исходный handle закрывается **до** удаления upload-файла: иначе Windows оставляет исходник и ломает восстановление результата после потерянного ответа. Unix сохраняет быстрый rename; cross-device copy также закрывает handle до unlink. Цена на Windows — дополнительное копирование содержимого при commit.
2. **Обновление / NTFS ACL.** Подписанный пакет по-прежнему распаковывается и проверяется в защищённом staging. На Windows проверенное дерево копируется во временный каталог непосредственно под `VersionsDir`, затем переименовывается в версию: файлы и вложенный `trust` наследуют разрешения versions. Непроверенные файлы не публикуются в versions. Цена — одно дополнительное копирование небольшого пакета.
3. `composeHooks.thaw()` отмечает отмену **до** ожидания хуков. Завершившийся поздно agent freeze повторно освобождается, VSS freeze после отмены не запускается.
4. Saved Windows snapshot требует объявленную capability `system.quiesce.wipe_secrets.v1`. Подключённый агент без неё даёт постоянный `quiesce_failed` с названием capability до snapshot / freeze. Недоступный агент остаётся временной ошибкой; QGA-only fallback для saved Windows отсутствует.
5. Замена секрета удерживает старый handle с DELETE до завершения rename. При неудаче обнулённый старый файл удаляется через delete-on-close, ошибка замены возвращается явно (не маскируется как «секрет оставлен в использовании»). Новые секреты по-прежнему не flush-ятся, старые перед заменой обнуляются и flush-ятся.
6. Глобальный `sbx-bench cleanup` требует явного `--all-sandbox-resources` и без него отказывает до действий cleanup. Это **глобальный**, а не run-scoped режим; использовать его при параллельных работах нельзя. Сообщение прерывания verify рекомендует удалять только VMIDs и snapshot своего прогона, явно предупреждая о глобальном флаге.
7. **Thaw safety.** S1 ограничивает каждую попытку thaw 10 s, по умолчанию 3 попытки и задержки 500 ms (до 31.5 s ожидания thaw; отдельно действуют тайм-ауты удаления LVs / PVE stop). После `ThawFailedError` worker под общим power lock проверяет исходного владельца lease и hard-stop-ит VM; recycled VMID другого владельца не останавливается. Операция получает постоянный `quiesce_failed` с сообщением hard-stopped / start again normally; если stop не удался, сообщение содержит обе ошибки. LVs неудачного snapshot удаляются S1. Fake-PVE тест проверяет stopped и успешный последующий обычный start; отдельный S1 тест проверяет никогда не возвращающий thaw и отсутствие snapshot LVs.

Проверка на настоящем Windows-клоне **570** из read-only **598 / 20261031.9**:

- RED: `TestUploadInheritsTargetACL` и `TestInstallInheritsVersionsACL` на старом коде оба упали с DACL, содержащим только SYSTEM. GREEN: все **19/19** Windows test binaries прошли, в том числе эти регрессии, потерянный commit-result и `TestReplaceFailureRemovesZeroedSecret`.
- Собранный исправленный агент установлен подписанным `install-package` как `0.1.0+s9-fix.1` на клоне; шаблон не менялся. HTTP `PUT /files/uploads/s9fix?offset=0&user=user`, затем commit в `C:\Users\user\sbxt\up.txt` — 200 / 200. `icacls` файла: SYSTEM, Administrators и **user:(I)(F)**. Версия и бинарник: **BUILTIN\Users:(I)(RX)**. `exec --user user` читает `upload-readable`, manifest версии и запускает `current\sbx-agent.exe env --format pwsh`.
- После claim с `S9_ACL=verified` команда `exec --user user -- pwsh -Command ...` с обычным профилем печатает `verified`; `env --format pwsh` содержит `S9_ACL`, `SBX_HOSTNAME` и `SBX_SANDBOX_ID`. Тем самым проверен и путь профиля после переключения версии.
- Полный Windows-прогон выявил две переносимые ошибки старых тестов: проверка Unix mode 0644 для SSH CA на Windows и замена fake `/proc/net/tcp` через обычный `os.Rename`, конфликтующий с reader handle. Тесты исправлены: Unix mode проверяется только на Unix, fixture использует `os.Root.Rename` (POSIX rename semantics на Windows).

**Расследование thaw (пункт 8), первопричина не устранена.** На клоне включён verbose QEMU-GA в `C:\Program Files\Qemu-ga\qemu-ga.log` (изменение только клона). QGA сообщает **109.1.0**; VirtIO SCSI / net / serial / RNG — **100.100.104.27100** (носитель 0.1.271). До freeze VSS и `QEMU Guest Agent VSS Provider` — Manual / Stopped, writers Stable / No error; по одним этим состояниям нельзя доказать незавершённый запуск. VSS Application events: только **8224, shutting down due to idle timeout**; событий crash QEMU-GA от SCM в проверке нет.

Повтор: hard stop 12:40:40 UTC → start 12:40:41 → agent ready 12:40:56. Snapshot примерно через 53 s после start вновь дал **ThawFailedError за 27.927 s**; вызван hard stop, затем обычный start восстановил QGA и sbx-agent. Лог содержит `guest-fsfreeze-freeze`, затем `disabling logging due to filesystem freeze` (12:41:34); записи thaw в файле нет, потому что logging выключен при freeze. Собранный после восстановления verbose-лог содержит GLib `gspawn-win32.c:681 (might_be_console_process): should not be reached` и `error sending error response: Input/output error`; также наблюдался потерянный exec-status. Это отдельные наблюдения, **не доказанная причина VSS hang**. Verbose `prepare/check` создаёт сотни MB за минуты; читать лог нужно ограниченными byte ranges, обычный tail может не догонять растущий файл. В production verbose не включён.

Надёжный readiness predicate / retry pattern не найден: объявлять `quiesce_ready` только из agent-ready, состояния Manual-служб или Stable writers оснований нет. Митигирующее изменение VSS не внесено, успешный `sbx-bench s9 --runs 3` не заявляется. Остаётся защита пункта 7; расследование проведено в пределах лимита 2 h, без перестройки шаблона или изменений хоста.

Проверки: workspace build, typecheck, Biome; TS suites последовательно (worker 381 + 5 skipped, PVE 192, bench 44); Python SDK 77; Go race/vet/golangci-lint всех модулей, Linux cross-build; Windows build/vet/lint всех применимых модулей (node-agent Linux-only). Первоначальный параллельный API suite имел teardown-flake `terminating connection due to administrator command`; последовательный API прогон — 1008 passed.

Итоговая очистка `pve`: VM 570 удалена, allocator snapshots своего прогона пусты; оба ISO (`sbx-build-agenttests-20261031123309.iso`, `sbx-build-s9-fix.iso`) удалены. Проверки `qm list`, `lvs -o lv_name,lv_tags` и `pvesm list local --content iso` подтвердили отсутствие моих VM/LVs/ISO и любых `sbx-snap-*` LVs. VM 596 другого потока оставлена без изменений.

### 24.7 S9 follow-ups (2026-11-01 NZ)

**Решение по snapshot: Windows использует crash-consistent fallback без QGA/VSS.**
*Заменено §24.8: fork и saved snapshot Windows снимаются только из остановленной VM; crash fallback из публичного пути убран.*
`Machines.snapshot` по `ostype=win*` по умолчанию не вызывает QGA freeze/thaw;
многодисковый snapshot по-прежнему делает pause → LVM snapshots → resume.
Новые метаданные содержат `consistency=crash` (остановленная VM — `powered_off`).
Worker явно выбирает тот же режим. Saved snapshot требует доступный агент с
`system.quiesce.wipe_secrets.v1`: `Quiesce{fs:false,wipe_secret_files:true}` →
snapshot → agent Thaw, **без второго QGA-хука**. Watchdog/auto-thaw агента
по-прежнему делает saved snapshot недействительным: иначе секреты могли
восстановиться до копирования. Это не application-consistent/VSS backup;
приложения восстанавливаются как после потери питания. Linux не меняется.
`crashConsistent:false` в S1 оставлен для явных диагностических опытов;
worker его для Windows не использует. Защита bounded thaw / hard stop остаётся.

**Наблюдения на отдельном клоне 580 шаблона 598:**

- QGA/provider `109.1.0`, командная строка `qemu-ga.exe -d --retry-path`.
  Provider зарегистрирован; службы QEMU-GA, VSS и provider работали после
  успешных циклов. В Application есть VSS 8194: System Writer,
  `IVssWriterCallback`, `0x80070005`; он встречается и при успешных snapshot.
- 10 ручных циклов QGA freeze → pause → snapshot трёх LV → resume → thaw
  прошли; затем 10 последовательных snapshot через настоящий S1 тоже прошли.
  После hard stop/start первый S1 snapshot воспроизвёл `ThawFailedError`.
  В опыте нет sbx-agent quiesce: коллизия составных хуков не обязательна.
- На **этом клоне**, без изменения 598, установлен актуальный на момент опыта
  MSI из `https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/latest-qemu-ga/qemu-ga-x86_64.msi`.
  SHA-256 `19dcf8abc30f70c2eb6e87282601fd0476e4e0b19936f63d9c80be30db0796ed`,
  размер 11909632 bytes; MSI install exit 0, QGA/provider стали `110.2.3`.
  10 S1 snapshot прошли, но **первый после hard stop/start снова завис**.
  Обновление QGA само по себе не является исправлением.
- Трасса нового QGA: freeze POST 13:50:17.896–13:50:22.443 UTC (4.547 s),
  pause/LVM/resume до 13:50:23.305 (0.862 s); первый thaw начат сразу затем
  и не ответил. Следующие thaw/status дали `QEMU guest agent is not running`.
  Интервал от начала freeze до thaw 5.409 s; одной гипотезы превышения
  10 s VSS hold window недостаточно. PVE suspend/resume без includestate
  вызывает QMP stop/cont и не запускает второй VSS requestor.

**Первопричина внутри Windows/QGA/VSS остаётся открытой.** Не доказано,
что виноват VSS 8194, VirtIO serial/SCSI, либо ожидание VSS async completion.
Следующий эксперимент для возврата application-consistent режима: на отдельном
клоне с 110.2.3 собрать thread stacks QGA и VSS provider при hang (WinDbg/WPR),
параллельно сырой virtio-serial request/response и QMP timeline; отдельно
сравнить freeze/thaw без pause и с pause после hard restart. В upstream
`requester_thaw` сигналит event, затем без ограничения ждёт `IVssAsync::Wait`;
нужно определить, вошёл ли зависший поток туда и где стоит provider.
Источники: [QGA protocol](https://www.qemu.org/docs/master/interop/qemu-ga-ref.html),
[upstream requester](https://github.com/qemu/qemu/blob/master/qga/vss-win32/requester.cpp).
Режим без writers в публичном QGA RPC не предусмотрен; не подменяем его
недокументированными registry-настройками. Рецепт QGA не меняем: новая версия
не устранила hang, **перестройка 598 для этого fallback не требуется**.

**Контракты и мелкие исправления.** Миграция runtime `0207` консервативно
отмечает существующие Windows machines с арендатором как потенциально dirty.
Непустые secret files отмечаются до RPC; clean PrepareStop/успешная пустая
замена очищают флаг. Running saved с dirty flag → `snapshot_requires_stop`,
stopped dirty → `snapshot_requires_clean_stop`; fork не ограничен этим флагом.
Это консервативное уточнение §18.6 п.5: live сохранение с файлами требует
сначала clean stop. Доставка секретов повторяется при reconnect/restart и
same-boot `secrets:pending`, с durable поколениями для pending во время другой
операции; stop/snapshot повторяют lock qmeventd с новым fencing и свежим hook.
Подробности и тестовые контракты — S6.

Payload data migration `20261101_000000_windows_template` добавляет отсутствующие
`windows`/`4gb` на существующих установках, не затирая настройки оператора;
сборка 598 уже регистрируется из compose YAML отдельно. Деплоя в CT 590 нет.
CLI refresh regression воспроизведён forced GC: слабая ссылка Request на
AbortController могла теряться. HTTP send держит Request и ждёт исходный abort
напрямую, timeout и lock release проверяются в отдельном GC-процессе.
`sbx-agent call … -` снимает ведущий UTF-8 BOM; typed `user_not_found` в exec
даёт 127 (остальные RPC ошибки 125), API S7 сохраняет 400 validation.
Upload copy-commit хранит durable identity anchor рядом с целью, распознаёт
повтор по inode, а не совпадению байтов; cleanup после durable commit best effort.
Copy fallback требует hardlinks (в частности NTFS), обычный Unix rename сохранён.

**Проверка fallback:** на исходном 598 (QGA 109.1.0), VM 570,
10 последовательных snapshot работающей VM 13:56:57–13:57:11 UTC,
все `consistency=crash`, pause/snapshot/resume 543–862 ms; после каждой
попытки snapshot LVs удалены. Серия выполнена на первом boot A второго
bench-прогона: она добавляет паузы в его create-to-ready, поэтому эти
времена нельзя считать чистым сравнением производительности.

**Локальные проверки ветки.** `mise exec -- pnpm --workspace-concurrency=1 -r
--if-present build`, serial `typecheck`, `pnpm lint` прошли. Полный serial
workspace test: 4342 TS passed, 6 skipped; Python SDK 77 passed. После
добавления покрытия stop-inside-delete повторный worker: 397 passed,
5 skipped; PVE: 195 passed; bench unit: 44 passed. Все пять Go-модулей:
`go test -race ./...`, `go vet ./...`, `golangci-lint run` — exit 0.
Для guest-agent собраны 19 Windows test binaries (GOOS=windows/amd64);
исполнение новых Windows regression tests на госте здесь не заявляется.

**Итог bench и уборки:** `sbx-bench s9 --template 598 --runs 3` через
`runS9` с дополнительным host guard перед каждым start завершён с exit 0,
3/3 runs (14:06:35 UTC). Диапазон этого прогона — 570–579, отдельный
локальный allocator state; CT 590/tunnel registrar не использовался.
Все три fork загрузились с новой идентичностью и hostname. Snapshot total /
pause-window: 1040/815, 1745/1067, 791/562 ms. Это проверка **fallback**,
а не успешного VSS thaw; в шаблоне остался QGA 109.1.0.
Итоговые `qm list`, `lvs -o lv_name,lv_tags`, `pvesm list local --content iso`
подтвердили отсутствие VM 570/571/580, snapshot LVs и временного
`s9-followups-qga.iso`. Ресурсы параллельного S10 не менялись.
Дальше: независимая приёмка master и деплой с обеими миграциями. Исправления
sbx-agent нужно доставить существующим гостям через обновление либо будущую
сборку шаблона; перестройки 598 в этой ветке не было и для crash fallback
она не требуется.

### 24.8 Fork и saved snapshot Windows только из остановленной VM (`win-force-stop`, 2026-11-01 NZ)

**Решение Ильи.** QGA/VSS thaw зависает (§24.5–§24.7), а crash-consistent снимок работающей VM (§24.7) теряет или обнуляет недавние записи из кэша гостя. Поэтому fork и saved snapshot Windows делаются только из остановленной VM; crash fallback из публичного пути убран. Значение `consistency = crash` осталось в схеме для старых снапшотов и для Linux после hard stop (§24.9); Windows-снапшотов с ним платформа не создаёт.

**Контракт.**

- Работающая (`ready`) Windows-sandbox: `POST /v1/sandboxes/{sandbox}/fork` и `POST /v1/snapshots` без `forceStop: true` → `409`, ничего не создано:

  ```json
  {"error": {"code": "snapshot_requires_stop",
    "message": "Windows sandboxes are forked from a stopped VM; stop it first or retry with forceStop: true (CLI --force-stop), which stops the sandbox, takes the snapshot and starts it again",
    "retryable": false,
    "details": {"reason": "windows_running", "retryWith": {"forceStop": true}, "cli": "--force-stop"},
    "requestId": "req_..."}}
  ```

  У save сообщение начинается с «Windows snapshots are saved from a stopped VM; …». CLI печатает сообщение и `hint: use --force-stop …`; MCP (`force_stop` у `sandbox_fork` и `snapshot_save`) — подсказку «retry with force_stop: true …»; SDK отдают `SbxError` с `code` и `details`; web показывает подтверждение и шлёт флаг (S8 §9.7).
- `forceStop: true`: worker в той же операции fork / save_snapshot делает stop (PrepareStop со стиранием secret-файлов, shutdown до 300 s без hard stop; тайм-аут → `shutdown_timeout`, снапшота нет, источник запускается снова, §24.9), снапшот остановленной VM (`powered_off`), запуск источника (с `retryOnVmLock` для lock qmeventd), ожидание агента на новой загрузке и повторную доставку env/секретов, затем продолжает fork (передача снапшота цели). Шаги, прогресс, RAM и дедлайны — S6 §7.8, §7.9, §8.1. Операция отдаёт `forceStop {sourceStopped, sourceRestarted, restartError}` (S7 §8.4).
- Неудачный перезапуск источника после снапшота fork не роняет (ни ошибка, ни истёкший дедлайн): источник `error` / `resume_failed`, machine `stopped`, снапшот цел; поднимается обычным resume. Временные ошибки перезапуска повторяются. Провал до снапшота компенсируется, компенсация запускает источник.
- Остановленная Windows — без флага, как раньше. Linux — без изменений (live quiesced); `forceStop` принимается и игнорируется (в операцию не пишется).

**Живая проверка на `pve`** (2026-10-31 23:06–23:12 UTC, opt-in тест `apps/worker/test/pve-force-stop.test.ts`, `SBX_PVE_FORCE_STOP=1`). Настоящие операции worker (cold create, fork с `forceStop`, stop, create цели fork, delete) через настоящий адаптер PVE; клон шаблона **598**, VMID 580/581, одна 4 GB VM за раз (проверка `qm list` перед каждым стартом; параллельно работала VM S10). Агентский порт — `ConnectAgentPort` с транспортом через QGA (`sbx-agent call` на admin-сокет агента), сессии туннеля эмулирует опрос `System/Info` по QGA: gateway и туннель не нужны, CT 590 не трогался.

| Шаг | Время |
|---|---|
| Cold create источника → ready | 128.5 s |
| fork без флага | `409 snapshot_requires_stop` (тело выше), VM продолжает работать |
| Запись 20 000 байт в `C:\sbx-force-stop.txt` (`WriteAllText`, без flush) → сразу forced fork | — |
| Forced fork, вся операция | 79.8 s |
| · PrepareStop + shutdown (clean, `secretFilesWiped: true`) | ≈ 61 s (shutdown 60.2 s) |
| · snapshot остановленной VM (`powered_off`) | 0.73 s |
| · S1 start | 1.2 s |
| · start → агент готов на новой загрузке, provision | ≈ 16 s |
| Source после операции | `ready`, machine `running`, новый boot id, имя прежнее `SBX83E1650251FA` |
| Create цели fork (clone из снапшота → start → агент → claim) | 61.8 s; fork загрузился как `SBX7B666382CEC3` |
| Файл в fork | SHA-256 совпал (`ecbdbf07…a9c8c`), запись цела |

Перед стартом цели источник останавливался обычным stop (22.7 s) только ради правила одной 4 GB VM. Уборка: обе VM удалены через delete worker, снапшот fork_source удалён `snapshot-op`; `qm list` (нет 580–589), `lvs` (нет `vm-58x-*` и `sbx-snap-*` прогона), лизы прогона — 0. В первом из шести прогонов cold create источника упал сразу после подключения сессии; лог ошибки тогда не печатался, в следующих прогонах тот же шаг проходил. Остальные неудачи прогонов — ошибки самого харнесса (лимит `input-data` QGA 65 536 символов, stdin PowerShell через QGA без EOF, квота RAM команды теста).

### 24.9 Исправления приёмки `win-force-stop` (`win-force-stop-fix`, 2026-11-01 NZ)

Решения master-сессии по находкам независимой приёмки (следуют решению Ильи: crash-consistent снапшотов Windows нет).

1. **Shutdown timeout не даёт crash-снапшот с меткой `powered_off`.** Бюджет graceful shutdown — `SHUTDOWN_TIMEOUT_S` (`apps/worker/src/ops/stop.ts`): Windows 300 s, Linux 60 s, и для обычного stop, и для forced (п. 7); у forced своё переопределение `timing.forceStopShutdownTimeoutS`. Тайм-аут → операция `failed`, `shutdown_timeout`, `retryable: true`, сообщение «the guest did not shut down cleanly within N s; nothing was snapshotted, the sandbox is started again». Hard stop делает компенсация (machine в `stopping`), затем запускает источник. Обычный stop после бюджета по-прежнему делает hard stop (без `clean_stop`).
2. **Снапшот после hard stop не бывает `powered_off` ни на одном пути.** Новый `machines.clean_stop` (миграция `0208`, триггер сброса) — S6 §7.8. Остановленная Windows без чистого выключения → `snapshot_requires_clean_stop`; Linux → `consistency = crash`. Пути, где это срабатывает: stop с hard stop после тайм-аута или в `stop_verify`, machine после неудачного resume / restart (компенсация hard-stop-ит), VM, остановленная reconcile после ручного запуска, упавшая VM.
3. **Перезапуск после снапшота не роняет операцию.** Бюджет перезапуска = max(дедлайн resume, `boot_timeout_s` + 5 min) (для шаблона 598 с 1200 s — 25 min). После `progress.snapshotTaken` дедлайн больше не применяется: истёкший дедлайн во время `restart_agent` ведёт к успешному fork, а при неудаче перезапуска — к `sourceRestarted: false`, снапшот не удаляется.
4. **Временные ошибки перезапуска повторяются** (любая ошибка не `retryable: false`, включая `ECONNRESET` и lock qmeventd) с паузой 5 s до продлённого дедлайна; только потом источник → `error`.
5. **S1 без молчаливого crash.** `Machines.snapshot` работающей Windows без явного `crashConsistent` (с hook или без) → `SnapshotModeRequiredError` (worker: `snapshot_requires_stop`, permanent). Worker всегда передаёт `crashConsistent: false`. Bench S9 явно передаёт `true` (замер crash fallback), проверка шаблона Windows (`template-builder`) — `false` для попыток VSS (как задумано и как ждут её тесты; после 4c55eba7 она молча получала crash), затем явный `true` для fallback с WARN.
6. **MCP `sandbox_fork`** после ожидания перечитывает `sourceOperation` forced fork и, как `snapshot_save`, пишет «the copy is made, but the source sandbox did not start again after the forced stop (code: message); call sandbox_resume on the source».


7. **Обычный stop Windows: shutdown 300 s** (было 120 s), Linux 60 s без изменений. Дедлайн stop Windows 5 → 7 min (300 s shutdown + PrepareStop 10 s, повторы VM lock, verify); forced fork/save Windows соответственно 10 / 12 min до снапшота. 120 s в §18.6 п. 10 и §24.5 этим заменены.
8. **Shutdown, не взявший VM lock, больше не считается тайм-аутом гостя.** Наблюдение live-прогона (00:21:27 UTC): обычный stop сразу после hard stop + start (компенсация сценария тайм-аута) шёл «shutdown 10.3 s, затем stop 4.2 s». Журнал задач PVE: `qmshutdown` упал через 10 s с `can't lock file '/var/lock/qemu-server/lock-580.conf' - got timeout` (lock держал qmeventd после hard stop в 00:21:10), гость ACPI-запрос не получал; адаптер увидел `running` и вернул `timeout`, stop сделал hard stop. Метка была честной (`shutdown: hard`, `clean_stop = false`), но hard stop — лишний; в forced-пути то же дало бы ложный `shutdown_timeout`. Теперь `PveNodeInfra.shutdown` повторяет такую задачу (`retryOnVmLock`, 5 попыток по 10 s, fence перепроверяется в паузах и под power lock) и возвращает `timeout` только при настоящем тайм-ауте гостя; исчерпанные повторы — временная ошибка, задание повторяется. `clean_stop`: чистый shutdown после повтора → `true`, hard stop (тайм-аут гостя или VM, ещё работающая в `stop_verify`) → `false`.
9. **Не проверено вживую:** template-builder (проверка шаблона Windows) теперь действительно пробует VSS с freeze budget и retry, затем явный crash fallback с WARN (п. 5). Проверить при следующей пересборке шаблона Windows.

**Живая проверка на `pve`** (2026-11-01 00:18–00:22 UTC, тот же opt-in тест `apps/worker/test/pve-force-stop.test.ts`, клон шаблона 598, VMID 580/581, одна 4 GB VM за раз; параллельно работала VM 500 S10). Cold create источника 114.8 s; fork без флага — `409 snapshot_requires_stop`; forced fork 48.4 s: shutdown гостя **28.7 s** (clean, бюджет 300 s), snapshot 0.68 s (`powered_off`), start 1.2 s, агент и provision ≈ 17 s, `sourceRestarted: true`. Сценарий тайм-аута: forced save с бюджетом shutdown 5 s → `failed shutdown_timeout`, `retryable: true`, 22.4 s; снапшот `failed`, `consistency` null, LV с его тегом нет; компенсация: hard stop 0.35 s, start 0.9 s, источник `ready`, machine `running`. Цель fork загрузилась за 44.3 s под новым именем, SHA-256 незафлашенного файла совпал. Уборка через delete worker: VM в 580–589 нет, лиз 0, `sbx-snap-*` LV нет.

Linux: forceStop и отказ без флага для Linux покрыты только юнит-тестами (fake PVE: `ops-force-stop.test.ts`, «Linux ignores forceStop», «Linux after a hard stop … crash»); живой Linux-fork не запускался: в шаблоне 597 старый агент (`sbx-agent: unknown command "call"`), шаблоны не пересобирались.

**Живая проверка обычного stop** (2026-11-01 00:38–00:42 UTC, тот же opt-in тест, `-t "plain stop"`, клон 598, VMID 580/581, одна 4 GB VM за раз; параллельно работала VM 595 S10). Cold create 108.7 s; обычный stop 13.6 s: shutdown гостя **13.2 s**, clean, hard stop 0, `secretFilesWiped: true`, machine `stopped`, `clean_stop = true`. Fork без флага из остановленной: 409 нет, операция 1.3 s, снапшот `powered_off` 0.89 s, источник остаётся `stopped`; цель fork загрузилась за 59.7 s. Уборка: VM в 580–589 нет, лиз 0, `sbx-snap-*` LV нет.

### 24.10 Пересборка 598 с исправлением `rebootBoot` (`win598-rebuild`, 2026-11-02 NZ)

Шаблон `windows` в 598 пересобран с агентом из `main` (`767aace0`, исправление §11.2 `rebootBoot` из `s10-followups`). Процедура как у `windows-desktop 20261101.6`, без изменений: `infra/templates/agent-package.sh --tunnel-ca ~/.config/sbx/dev-ca/ca.pem --os windows`; старая сборка снимается до новой (слот один): `sbx-tpl retire <buildId> --delete-vm --force` с `SBX_TEMPLATE_VMID_RANGE=598-598`; `sbx-tpl build windows --agent-package <tar> --connect-url wss://tunnel.192-168-68-90.sslip.io/v1/connect --dev-cp-ssh sbx@192.168.68.90`; версия и агент — в `deploy/compose/config/sbx.yaml`, затем `infra/dev-cp/deploy.sh`.

- Сборка `windows 20261101.1` (`01a19869-15ea-7719-80ee-cb771e00e973`), агент `0.1.0+20261101.767aace0`; 2395 s со встроенным verify, 16.8 GiB в thin pool; нагрузка `pve` 8–20. Verify: 101 PASS, 0 FAIL, 5 INFO. VSS-снимок verify прошёл штатно (freeze → thaw 4.1 s), зависания thaw (§24.7, roadmap) не было. Первая загрузка клона 112 s, смена идентичности 37.7 s, ровно одна перезагрузка переименования. Сборка `20261031.9` — `retired`, VM удалена; `sbx-tpl cleanup` — нечего чистить.
- Live на CT 590 (CLI, `e2e@example.com`): create `windows` → ready за 111.5 s. Перезагрузка переименования (1074 от `sbx-agent.exe`) за 26 s до ready, после claim перезагрузок нет: у источника 12 min (до остановки forced fork), у fork 7 min после ready (`LastBootUpTime` тот же, новых 1074 нет). Forced fork (`--force-stop`) — ready за 75.9 s: файл источника на месте, своё имя, одна перезагрузка переименования до ready; источник перезапущен (1074 от `qemu-ga.exe`) и ready.
- Квота dev-команды `e2e@example.com` — 6144 MB (по умолчанию в Payload), а forced fork Windows 4gb держит две VM по 4 GB: `quota_exceeded` ещё до снапшота. Для проверки команде временно ставилось `quota_max_ram_mb = 8192`, потом снова NULL. Для стенда это ожидаемо (отказ сразу, до остановки источника).
- После деплоя ветки: `infra/dev-cp/e2e.sh` 20/20; Windows `e2e-desktop` (`windows-desktop 20261101.6`) — 44 проверки, 0 сбоев, create 133.7 s. После уборки VM 500–589 нет.
