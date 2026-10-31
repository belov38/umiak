# S10. Рабочий стол и computer-use: спецификация

Статус: согласовано master-сессией 2026-10-29 (решения Ильи уточнены 2026-10-31, §26). Область S10 из `docs/roadmap.md`. Архитектура: `docs/architecture.md` (§7, §8, §10). Опирается на S2 (туннель), S3 (агент), S4 (gateway), S5 (шаблон Linux), S6 (control plane), S7 (публичное API), S8 (дашборд), S9 (Windows). Граница с фазой 2 — S29 «рабочий стол v2» в `docs/roadmap-phase2.md`.

Пометка **[S10]** — решение автора спеки в рамках брифа master-сессии; его можно менять без нового согласования, если причина записана. Пометка **[исполнитель]** — деталь, которую исполнитель выбирает сам по результатам спайков и тестов. Решения master и открытые вопросы — §26.

## 1. Зачем и что считается успехом

AI-агентам и людям нужен графический рабочий стол в sandbox: проверить веб-приложение в настоящем браузере, отладить Electron, пройти GUI-мастер, посмотреть, что делает агент. У sandbox нет публичного IP, поэтому весь путь до экрана идёт через платформу.

Сценарии по приоритету:

1. **Агент управляет экраном через API.** Агент вне VM (через MCP S11 или SDK) делает скриншот, кликает, печатает, читает буфер обмена. Ему не нужен ни стрим, ни браузер.
2. **Человек смотрит и вмешивается.** Пользователь открывает вкладку Desktop в дашборде и видит рабочий стол в iframe. Задержка низкая, мышь и клавиатура работают. Агент в это время продолжает действовать через API.
3. **Ссылка для другого инструмента.** Сервер интеграции получает по API одноразовую ссылку и встраивает поток в своё приложение (как у boat).
4. **Коллега открывает рабочий стол по постоянной ссылке** в режиме `sso`.
5. **Windows.** Всё то же на шаблоне `windows` (у boat Windows нет).

Успех:
- `linux-desktop` и `windows` дают одинаковые API рабочего стола и computer-use;
- поток идёт без публичных IP у sandbox; dev-адреса и транспорт доступа к стенду задаются только в `infra/dev-cp/`;
- холодный create `linux-desktop` допускает до ~1 min, Windows — до 5 min (§15);
- платформа ничего не форкает: Sunshine, moonlight-web и coturn ставятся из upstream-релизов без изменений.

## 2. Цели, не-цели, анти-цели

**Цели:**
- шаблон `linux-desktop` как вариант сборки S5;
- рабочий стол Windows на шаблоне S9;
- стрим в браузер для дашборда и API-клиентов через gateway S4: WebRTC через TURN и запасной транспорт WebSocket;
- примитивы computer-use (скриншот, мышь, клавиатура, буфер обмена) в агенте и в публичном API S7, чтобы S11 обернул их в MCP;
- доступ к потоку в режимах `token`, `sso`, `public`;
- размеры и admission RAM при холодном создании.

**Не-цели** (фаза 2, S29, если не сказано иначе):
- поток только браузера с профилями Chrome (`boat browser`);
- запись в mp4;
- noVNC как запасной путь;
- обои, `overlay=0`, `theme`;
- дерево доступности, список окон, запуск приложений через API (это умеет cua-driver, API к нему — S29);
- буфер обмена с картинками;
- смена разрешения экрана через API;
- ограничение числа одновременных зрителей и режим «только просмотр» (в MVP зрителей может быть несколько, §8.4);
- аппаратное кодирование (GPU Intel Arc на `pve`, SR-IOV);
- регистрация MCP `computer` в harness внутри VM (S15).

**Анти-цели** (провал, даже если формально работает):
- TURN становится открытым relay: через него можно слать трафик куда-то, кроме другого конца нашего же потока;
- у sandbox появляется входящий адрес или проброшенный порт;
- ссылка на рабочий стол или cookie попадает в логи, Referer или в код в sandbox;
- зритель, у которого отозвали доступ, продолжает управлять экраном;
- пользователь без права на exec получает рабочий стол (рабочий стол даёт полный контроль над `user`, у которого sudo);
- форк стримера, который нужно сопровождать;
- скриншот через API зависит от того, открыт ли стрим.

## 3. Ограничения

- Публичных IP у sandbox нет. Продукт не зависит от Tailscale; настройки dev-доступа находятся только в `infra/dev-cp/`. Внешние туннельные/relay-сервисы (cloudflared, ngrok, trycloudflare) запрещены; TURN self-hosted.
- Control plane работает в Kubernetes за oauth2-proxy.
- Граница доверия — VM (S2 §16). Всё, что внутри VM, может читать данные стримера своей VM.
- Windows Server Core не входит в MVP.
- GPU в VM нет: захват и кодирование на CPU (x264).
- Хост `pve`: VMID от 500, не больше 8 GB RAM на все VM sandbox, `local-lvm`, не трогать существующие VM, LXC, `vmbr0`, шаблоны 9000/9001; firewall меняется только с таймером отката (S1 §4.4).
- Последние стабильные версии всех зависимостей (§23).

## 4. Выбор стека

### 4.1 Сравнение

Проверено 2026-10-29 по релизам на GitHub и документации.

| Стек | Linux | Windows | Транспорт | Задержка и качество | Лицензия | Что строить нам |
|---|---|---|---|---|---|---|
| **Sunshine + moonlight-web** | да | да | WebRTC (нужен TURN), запасной WebSocket — встроен | лучшая: видеокодек H.264, 30–60 fps, адаптивный битрейт, FEC | GPL-3.0 (оба) | Упаковка, автоматический pairing, TURN, подстановка заголовка пользователя в gateway. Форк не нужен: в v3 есть `ice_server_script`, `forwarded_header`, WebSocket-транспорт |
| KasmVNC 1.5.2 | да | **нет** | WebSocket через gateway | хорошая для статичного экрана, хуже для видео | GPL-2.0 | Мало на Linux, но Windows нужен второй стек |
| Selkies 2.1.0 | да | **нет** | WebSocket по умолчанию, WebRTC опционально | хорошая (GStreamer, x264) | MPL-2.0 | Мало на Linux, Windows — второй стек |
| noVNC 1.7.0 + VNC-сервер (x11vnc 0.9.17, TigerVNC 1.16.2; на Windows TightVNC/UltraVNC) | да | да | WebSocket через gateway, TURN не нужен | худшая: растровые обновления, без звука, тяжело на видео | noVNC MPL-2.0, серверы GPL-2.0 | Меньше всего. Это запасной путь S29 |
| Guacamole 1.6.0 (guacd + JS-клиент): VNC на Linux, RDP на Windows | да | да (RDP) | TCP через туннель, TURN не нужен | средняя | Apache-2.0 | guacd в кластере, проброс TCP до VM. На Windows RDP забирает консольную сессию, и при отключении RDP экран для computer-use пропадает. RDP-хоста нет в Home |
| neko 3.2.0 | да | нет | WebRTC | хорошая | Apache-2.0 | Рассчитан на Docker, Windows нет |

### 4.2 Решение [S10]

**Sunshine + moonlight-web на обеих ОС.** Это решение уже записано в архитектуре (§8) и подтверждено сравнением:
- один стек на Linux и Windows: одна схема pairing, авторизации, TURN и приёмки;
- лучшая задержка и устойчивость к потерям;
- moonlight-web v3 закрывает наши нужды конфигурацией, без форка (boat держит свой форк — мы этого избегаем, анти-цель);
- запасной транспорт WebSocket встроен (`dataTransport: auto`: сначала WebRTC 15 s, затем WebSocket). Для сетей без UDP поток идёт через gateway и туннель, TURN не нужен.

GPL-3.0 у двух компонентов разрешена Ильёй (§17, §26). Кодирование x264 использует CPU (§15).

**Computer-use — собственные примитивы агента, а не прокси к cua-driver** [S10]. Это меняет формулировку architecture §8. Причины:
- cua-driver развивается очень быстро: релизы `cua-driver-rs` 0.30–0.38 вышли за месяц, и все помечены prerelease. Контракт публичного API v1 не должен зависеть от его схем;
- четыре примитива (скриншот, мышь, клавиатура, буфер) — небольшой объём кода. На Windows для них уже есть место в helper `sbx-session` (S9 §13);
- скриншот через API работает и без стримера.

cua-driver всё равно ставится в шаблоны (§6.3, §7) как MCP-сервер для агентов внутри VM: дерево доступности, работа с окнами в фоне. Его регистрация в harness — S15, API поверх него — S29.

## 5. Обзор

```
 browser: dashboard iframe / API client page
   | HTTPS + WSS: https://<slug>-desktop.sbx.<domain>         | browser: UDP/TCP 3478, TLS 443
   v                                                          v
 gateway (S4): label "<slug>-desktop", access,         coturn "turn.<domain>"
   open redirect, X-Sbx-Desktop-User                   relays only between its own allocations
   |  tunnel CONNECT 127.0.0.1:47800 (S2)                     ^
   v                                                          | UDP 3478 egress via node SNAT
 VM ----------------------------------------------------------+-- (IPSet sbx-turn)
 |  sbx-agent (root / SYSTEM): Desktop service, streamer manager, TURN config
 |    |-- moonlight-web 127.0.0.1:47800  (WebRTC relay candidates or WebSocket media)
 |    |      | GameStream over loopback
 |    |   Sunshine 127.0.0.1:47989  (x11 / ddx capture, x264)
 |    |-- sbx-session (in user session): screenshot, input, clipboard
 |  Linux: LightDM autologin -> Xorg :0 (dummy, 1920x1080) -> openbox, tint2, Chrome
 |  Windows: autologon console session (S9) -> Edge
 |  cua-driver (user service) for in-VM agents (S15)
```

Пути данных:
- **Computer-use API:** клиент → `api` (`/v1/sandboxes/{sb}/desktop/*`) → туннель → агент `Desktop` → `sbx-session` → экран. Стример не участвует.
- **Стрим, WebRTC:** браузер загружает страницу viewer-а и сигналинг через gateway. Медиа и ввод идут по WebRTC; обе стороны ходят через TURN.
- **Стрим, WebSocket:** то же, но медиа идёт WebSocket-ом через gateway и туннель.

## 6. Шаблон `linux-desktop`

### 6.1 Рецепт

Вариант сборки S5 (§16 S5): `extends: linux`. Сборка идёт с чистого образа, шаги `linux` плюс свой шаг `60-desktop`.

```yaml
# infra/templates/linux-desktop/template.yaml
slug: linux-desktop
os: linux
extends: linux                   # inherits source, disk, hw, steps of linux; lists below override
hw:
  vga: std                       # operator console only; the desktop uses the Xorg dummy driver
  tablet: 0
steps: [00-base, reboot, 10-system, 20-docker, 30-toolchains, 40-coding-agents, 50-sbx-agent, 60-desktop, 90-cleanup]
vmids: [595, 596]               # own template slots; never 597/598/599
# Default size 4gb, allowed 4gb/8gb: runtime seeds/config, not S5 recipe keys.
boot_timeout_s: 300
verify: linux-desktop
```

Как `extends` сливает поля, решает сборщик S5 **[исполнитель]**. Обязательно одно: `linux-desktop` собирается из тех же закреплённых версий `linux` (`versions.toml` наследуется, свой файл добавляет только пакеты рабочего стола).

### 6.2 Почему так [S10]

- **X11, а не Wayland.** Для X11 есть XTEST и проверенные инструменты ввода и буфера; cua-driver на Linux тестируется на реальном Xorg; Chrome работает. Захват `x11` в Sunshine самый затратный по CPU, но на 1080p30 это приемлемо (§15.2). Wayland (labwc или sway + захват `wlr`) — эксперимент фазы 2.
- **Xorg с драйвером `dummy`**, а не устройство VM: разрешение не зависит от `vga` Proxmox, захват идёт из памяти X-сервера. Так делает boat для browser view. Xvfb отвергнут: Sunshine и cua-driver проверены на Xorg.
- **LightDM с autologin** `user`, а не свой unit с `xinit`. LightDM открывает настоящую logind-сессию на seat0. Она даёт `XDG_RUNTIME_DIR`, D-Bus сессии, uaccess к `/dev/uinput` для ввода Sunshine и PAM, через который приходит env sandbox (S3 §8.2). Так же устроен boat. Исполнитель может заменить LightDM своим unit-ом, если проверки §6.6 проходят.
- **openbox + tint2**, а не XFCE: в простое на 200–300 MB меньше RAM. Нужен минимум, на котором человек найдёт терминал и браузер.

### 6.3 Содержимое (`60-desktop`)

Пакеты Ubuntu (из снапшота apt, S5 §6.2):
- `xserver-xorg-core`, `xserver-xorg-video-dummy`, `xserver-xorg-input-libinput` (виртуальные устройства uinput от Sunshine), `x11-xserver-utils`, `dbus-x11`;
- `lightdm` без greeter-а с UI (`lightdm-gtk-greeter` не ставится; autologin обходится без greeter-а — проверить, иначе минимальный greeter);
- `openbox`, `tint2`, `xfce4-terminal`, `pcmanfm`;
- шрифты: `fonts-noto-core`, `fonts-noto-cjk`, `fonts-noto-color-emoji`, `fonts-dejavu-core`;
- `at-spi2-core` (дерево доступности для cua-driver и браузера);
- `pipewire`, `pipewire-pulse`, `wireplumber` — звук в стриме, best effort (§8.5);
- `xdotool`, `xclip`, `scrot` — для людей и агентов в VM; агент на них не опирается.

Не из Ubuntu (версии и sha256 в `versions.toml`, §23):
- **Google Chrome stable** — `.deb` из репозитория Google (решение архитектуры §1). Репозиторий Google остаётся в источниках apt, автообновления нет (S5 их выключает). Managed policy в `/etc/opt/chrome/policies/managed/sbx.json`: без first run, без проверки браузера по умолчанию, без промо-вкладок, без отчётов. Chrome — браузер по умолчанию (`xdg-settings`, `update-alternatives`);
- **Sunshine** — `sunshine_<v>-1+ubuntu26.04_amd64.deb` из релиза LizardByte;
- **moonlight-web** — `moonlight-web-x86_64-unknown-linux-gnu.tar.gz` из релиза, в `/opt/sbx-desktop/moonlight-web/<v>/`;
- **cua-driver** — `cua-driver-rs-<v>-linux-x86_64-binary.tar.gz`, подпись sigstore проверяется при сборке, в `/opt/sbx-desktop/cua-driver/<v>/`. Расширение `cua-perception` (AGPL) не ставится.

Конфигурация:
- `/etc/X11/xorg.conf.d/10-sbx-dummy.conf`: драйвер `dummy`, `VideoRam 256000`, режим `1920x1080` (modeline из `cvt 1920 1080 60`), 24 bit, DPI 96.
- `/etc/lightdm/lightdm.conf.d/50-sbx.conf`: `autologin-user=user`, `autologin-session=sbx`, `xserver-command=X -nolisten tcp -dpms -s 0`.
- Сессия `sbx` (`/usr/share/xsessions/sbx.desktop` → `/usr/local/lib/sbx-desktop/session`): импортирует `DISPLAY`, `XAUTHORITY`, `DBUS_SESSION_BUS_ADDRESS` в менеджер пользователя (`systemctl --user import-environment`, `dbus-update-activation-environment --systemd`), запускает user-unit-ы `sbx-session.service` и `cua-driver.service`, затем `exec openbox-session`.
- Без экрана блокировки, заставки и DPMS: `light-locker` и `xscreensaver` не ставятся, `xset s off -dpms` в autostart openbox.
- `/etc/pam.d/lightdm-autologin` содержит те же две строки `pam_env`, что `sshd` (S3 §8.2): сессия получает env и секреты sandbox.
- `uinput`: модуль в `/etc/modules-load.d/sbx-uinput.conf`, правило udev из пакета Sunshine (uaccess для активной сессии).
- `OOMScoreAdjust=-500` для Xorg и LightDM (drop-in): при нехватке памяти ядро убивает сначала приложения пользователя, а не экран.
- `agent.toml`: `[readiness] required = ["identity", "claim", "secrets", "docker", "desktop"]`, `[desktop] enabled = true`, `[ports] exclude` дополняется портами стримера (§8.1).

### 6.4 Сессия и claim

Сессию рабочего стола агент запускает и перезапускает сам (`systemctl start|restart lightdm`). `lightdm.service` не включён в `graphical.target` [S10].

| Момент | Что делает агент | Зачем |
|---|---|---|
| холодная загрузка до claim | дождаться идентичности и claim | пул в MVP отсутствует |
| первый claim этой идентичности (S6 `System/Claim{reason: claim}`) | после шагов S3 §8.1 перезапустить сессию | PAM сессии должен прочитать env и секреты claim. Пользовательских программ на рабочем столе ещё нет, терять нечего |
| загрузка после claim (resume, recover, reprovision) | запустить сессию, когда секреты для текущей загрузки применены (фаза `secrets` = `ready` при новом `bootId`) | сессия получает секреты. До этого `desktop: pending` |
| смена env или секретов у работающей sandbox в той же загрузке | сессию не трогать | как у запущенных команд (S3 §8.1): новый env видят новые процессы агента. Документируется в S7 |

Триггер — внутреннее состояние агента (первый claim идентичности; секреты применены для текущего `bootId`), а не имя RPC. Поэтому правило не зависит от того, доставляет control plane секреты после загрузки через `System/Claim{reason: resume}` (S6 §7.6) или через `UpdateSecrets` (S3 §8.1).

Перезапуск сессии — не дольше 3 s (замер §20). `desktop: pending` на это время. Sandbox становится `ready`, когда готова и фаза `desktop` (readiness `required`).

Программы рабочего стола не переживают stop, resume и fork, как у boat. Профиль Chrome лежит на диске и сохраняется.

### 6.5 Env

- **Все команды и SSH-сессии** на шаблоне с рабочим столом получают в платформенный env (S3 §8.2, п. 2) `DISPLAY=:0` и `XAUTHORITY=/home/user/.Xauthority`. Тогда `google-chrome https://…` из `exec` открывает окно на рабочем столе. Пишется и в `/etc/sbx/env` для SSH.
- **`CommandSpec.desktop: true`** (поле S9 §13) на Linux: агент проверяет, что фаза `desktop` = `ready` (иначе `failed_precondition desktop_not_ready`), и добавляет env графической сессии: `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/<uid>/bus`, `XDG_SESSION_TYPE=x11`, `XDG_CURRENT_DESKTOP=openbox`. Процесс по-прежнему запускается в своём unit-е под shim (S3 §9.3).
- На шаблоне без рабочего стола `desktop: true` → `failed_precondition desktop_unsupported`.

### 6.6 Проверка сборки (`verify: linux-desktop`)

Все проверки S5 §10, кроме п. 4, плюс:

1. Проверка S5 §10 п. 4 (слушающие сокеты) со списком для рабочего стола: при остановленном стримере новых TCP-сокетов нет; Xorg слушает только unix-сокет.
2. После загрузки до claim: LightDM не стартует, `desktop: pending`. После claim и применения secrets текущего boot: LightDM активен, `user` в сессии `x11` на seat0 (`loginctl`), openbox работает, разрешение 1920×1080 (`xrandr`), фаза `desktop` = `ready`. Это уточнение согласует проверку с §6.4 и отсутствием pool в MVP.
3. `sbx-agent doctor --desktop --json`: скриншот через `sbx-session` — PNG 1920×1080, не одноцветный (на рабочем столе есть панель tint2).
4. Ввод: агент двигает курсор и кликает (позиция курсора совпадает); `type` печатает строку с не-ASCII символами в `xfce4-terminal`, и она совпадает; буфер: `SetClipboard` → `xclip -o` из сессии выдаёт тот же текст, и обратно.
5. Стример: `Desktop/Open` запускает Sunshine и moonlight-web, pairing проходит, ответ содержит `hostId` и `appId`; при этом Sunshine и moonlight-web слушают только `127.0.0.1`. `Desktop/StopStreamer` их останавливает.
6. Версии `google-chrome --version`, `sunshine --version`, moonlight-web, cua-driver совпадают с манифестом. `cua-driver` user-unit активен, его socket отвечает на `get_screen_size`.
7. Перезапуск сессии (как при claim) укладывается в 3 s; после него фаза `desktop` снова `ready`.
8. Swap нет (S5), `uinput` загружен, `/dev/uinput` доступен сессии `user`.

## 7. Рабочий стол Windows

Шаблон `windows` (S9) уже даёт autologon `user`, разблокированную консольную сессию, helper `sbx-session` и фазу `desktop` (S9 §13). S10 добавляет в шаг `60-desktop`:

- **Sunshine** — `Sunshine-Windows-AMD64-installer.msi`, тихая установка. Служба `SunshineService` — тип запуска Manual. Служба upstream сама запускает `sunshine.exe` в активной консольной сессии; агент стартует и останавливает её через SCM. Конфиг — §8.2.
- **moonlight-web** — `moonlight-web-x86_64-pc-windows-gnu.zip` в `C:\Program Files\sbx-desktop\moonlight-web\<v>\`. Агент регистрирует службу `sbx-moonlight-web` (Manual, виртуальная учётная запись `NT SERVICE\sbx-moonlight-web`). Рабочий стол ей не нужен: она только пересылает поток Sunshine.
- **cua-driver** — `cua-driver-rs-<v>-windows-x86_64.zip`; запускает `sbx-session` в сессии `user`.
- **Браузер — Edge**, который есть в Windows 11 [S10]. Chrome на Windows не ставится. Политики Edge: `HideFirstRunExperience=1`, без предложений входа и синхронизации.
- **Видеоадаптер** — по спайку W (§19.2). Кандидаты по порядку: `vga: std` (Microsoft Basic Display Adapter), `vga: virtio` с драйвером `viogpudo` из закреплённого virtio-win, IddCx-драйвер виртуального дисплея (Virtual Display Driver, MIT, или SudoVDA). Критерий: захват `ddx` Sunshine и скриншот `sbx-session` дают 1920×1080 без чёрного экрана после пробуждения из спящего режима. Победитель записывается в `hw.vga` рецепта и в §24.
- **Разрешение:** `sbx-session` при старте выставляет 1920×1080, 96 DPI (`ChangeDisplaySettingsExW`), если адаптер это позволяет.
- **Звук** — best effort: `audio0: device=ich9-intel-hda,driver=none`, если спайк покажет, что без него Sunshine не начинает поток. Иначе `stream_audio = disabled`.
- `agent.toml`: `[ports] exclude` дополняется портами стримера (§8.1). `[readiness]` — как в S9.
- Профиль проверки `windows-desktop` (S9 §15) дополняется проверками §6.6 п. 3–6 в варианте Windows.

Ограничения Windows, которые наследуются из S9: hostname из claim не применяется; рабочий стол — это консольная сессия `user`; UAC без запросов (`PromptOnSecureDesktop=0`), поэтому захват защищённого рабочего стола не нужен.

## 8. Стример в госте

### 8.1 Процессы и порты

| Процесс | Linux | Windows | Слушает |
|---|---|---|---|
| Sunshine | user-unit пользователя `user` из пакета (`app-dev.lizardbyte.app.Sunshine.service`) | `SunshineService` → `sunshine.exe` в консольной сессии | `127.0.0.1`: TCP 47984, 47989, 47990 (веб-UI), 48010; UDP 47998–48000, 48002, 48010 |
| moonlight-web | system unit `sbx-moonlight-web.service`, пользователь `sbxstream` (системный, без shell) | служба `sbx-moonlight-web` | `127.0.0.1:47800` TCP; UDP — эфемерные порты для WebRTC |

Порты TCP `47800`, `47984`, `47989`, `47990`, `48010` входят в общий список зарезервированных портов платформы (S4 §4.2, S7 §11.2): опубликовать их как обычный порт нельзя. Они же — в `[ports] exclude` агента.

### 8.2 Конфигурация

Sunshine (`sunshine.conf`, кладёт шаблон; креды веб-UI задаёт агент):

```ini
bind_address = 127.0.0.1
origin_web_ui_allowed = pc
upnp = disabled
capture = x11            # Windows: ddx
encoder = software
sw_preset = superfast
sw_tune = zerolatency
stream_audio = enabled   # see 8.5
min_log_level = info
```

moonlight-web (`config.json`): шаблон получает его командой `web-server config generate` при сборке и правит ключи ниже. Писать файл с нуля нельзя: у части полей (`first_login_create_admin`, `first_login_assign_global_hosts`) нет значений по умолчанию, и неполный файл не загрузится.

```json
{
  "web_server": {
    "bind_address": "127.0.0.1:47800",
    "first_login_create_admin": true,
    "first_login_assign_global_hosts": false,
    "forwarded_header": {
      "username_header": "X-Sbx-Desktop-User",
      "auto_create_missing_user": false
    }
  },
  "webrtc": {
    "ice_servers": [],
    "ice_server_script": "/usr/local/lib/sbx-desktop/ice-servers"
  }
}
```

- Стандартные STUN-серверы Google выключены (`--disable-default-webrtc-ice-servers`): никаких внешних STUN, только наш TURN.
- `ice-servers` — маленький исполняемый файл (на Windows `ice-servers.cmd`), который печатает JSON из файла агента `desktop/ice-servers.json` (§9.3). moonlight-web запускает его при каждом старте потока и отдаёт тот же список браузеру. Поэтому свежие креды TURN не требуют перезапуска moonlight-web.
- `webrtc.port_range` не задаётся: VM ходит к TURN исходящими пакетами, входящих портов у неё нет.

### 8.3 Pairing и пользователи moonlight-web

Состояние стримера (`/var/lib/sbx-agent/desktop/` на Linux, `ProgramData\sbx-agent\desktop\` на Windows; доступ root/SYSTEM) содержит:
- логин и пароль веб-UI Sunshine (32 случайных байта);
- пароль администратора moonlight-web;
- идентификаторы `hostId` и `appId` после pairing.

Агент генерирует их сам и проводит pairing при первом запуске стримера после смены идентичности (S3 §7, S9 §11):
1. Задать креды Sunshine (`sunshine --creds`), запустить Sunshine и moonlight-web.
2. Через HTTP API moonlight-web (как администратор): создать роль `viewer` и пользователя `sbx` с этой ролью, добавить хост `localhost`, начать pairing и получить PIN.
3. Передать PIN в Sunshine через API веб-UI: `POST https://127.0.0.1:47990/api/pin` с basic auth, CSRF-токеном и `pairing_id`, как требует текущая версия.
4. Прочитать `hostId` и `appId` приложения `Desktop`.

Права роли `viewer`: `allow_add_hosts = false`; только H.264; без HDR; `maximum_bitrate_kbps = 20000`; оба транспорта разрешены.

Смена идентичности стирает это состояние, а также `sunshine_state.json` и данные moonlight-web: fork и VM из snapshot не уносят креды стримера источника. Pairing выполняется лениво при первом открытии для каждой новой идентичности, включая create и fork (несколько секунд).

Точные вызовы API moonlight-web v3 и Sunshine фиксирует спайк L **[исполнитель]**.

### 8.4 Запуск по требованию

- Стример не работает, пока рабочий стол не открывают. Скриншот и ввод через API идут мимо него.
- `Desktop/Open` (§11.1) запускает Sunshine и moonlight-web, если они не запущены, ждёт готовности (до 20 s) и возвращает `{hostId, appId}`.
- Агент останавливает стример через 15 min без активного потока [S10]. Так он не тратит CPU и RAM.
- **Идёт ли поток.** Агенту нужен признак `streaming` (идёт хотя бы один поток): для простоя (§11.4) и для остановки по таймеру. Готового источника upstream нет: moonlight-web v3 — один процесс без отдельного процесса на поток, а API Sunshine отдаёт только список сопряжённых клиентов. Кандидаты по порядку **[исполнитель, спайк L]**:
  1. строки подключения и отключения клиента в логе Sunshine;
  2. подключённые UDP-сокеты moonlight-web к управляющему порту Sunshine (`127.0.0.1:47999`);
  3. запасной признак, который работает на обеих ОС: CPU процесса Sunshine выше 2% в среднем за 30 s (без потока Sunshine не кодирует и почти не тратит CPU).

  Число потоков агент сообщает, если источник его даёт; иначе только `streaming`. При смене признака агент шлёт событие `desktop.streaming_changed{streaming, count?}` (§11.4).
- **Несколько зрителей** [S10]. Sunshine подключает второго клиента к уже запущенному приложению, moonlight-web тоже допускает несколько потоков. Каждый зритель — отдельное кодирование x264, то есть ещё 0.7–1.5 vCPU, и каждый может управлять экраном. В MVP число зрителей не ограничиваем: надёжно посчитать потоки в момент старта нечем (см. выше), а `Open` при выдаче ссылки не должен обрывать того, кто уже смотрит. Ограничение и режим «только просмотр» — S29. CPU двух зрителей замеряет спайк L.
- **Завершение потоков.** `Desktop/EndStreams` обрывает все активные потоки: перезапуск Sunshine и moonlight-web. Так отзыв доступа действует и на поток через TURN, мимо gateway (§10.5).

### 8.5 Профиль потока

- Экран 1920×1080. Viewer запрашивает 1920×1080, 30 fps, 8 Mbit/s, H.264 [S10]. API-клиент может попросить 60 fps и до 20 Mbit/s (параметры ссылки, §13.2).
- 30 fps по умолчанию, потому что x264 на CPU: 60 fps примерно вдвое дороже (замер §20). CPU sandbox нужен и самому агенту в VM.
- Звук — best effort, не входит в приёмку. На Linux Sunshine сам создаёт виртуальный sink в PipeWire. На Windows — §7.

## 9. Транспорт и TURN

### 9.1 Как устанавливается поток

1. Страница viewer-а (`stream.html`) и сигналинг WebRTC идут по HTTPS через gateway и туннель к moonlight-web.
2. moonlight-web и браузер получают одинаковый список ICE-серверов — только наш TURN.
3. Адрес VM в `sbx0` браузеру недоступен, а TURN запрещает relay ко всем адресам, кроме своих (§9.2). Поэтому в PoC и в корпоративной сети ICE сходится на паре relay ↔ relay. VM ходит к TURN по UDP: WebRTC-стек moonlight-web (webrtc-rs) собирает relay-кандидаты только через UDP. Браузер может ходить к TURN по UDP, TCP или TLS 443.
4. **Прямой путь в продакшене.** Если у браузера публичный адрес (например, сотрудник вне VPN), ICE может собрать прямую пару «VM через SNAT ноды ↔ браузер»: исходящий UDP в интернет sandbox разрешён (S1). Это допустимо [S10]: у sandbox по-прежнему нет входящего адреса, это обычный исходящий трафик VM. Отзыв доступа такой поток тоже обрывает (`EndStreams` в VM, §10.5). Гарантированный путь — TURN.
5. Если WebRTC не соединился за 15 s (например, у браузера закрыт UDP, а TCP/TLS к TURN тоже не проходит), viewer сам переключается на WebSocket: медиа идёт через gateway и туннель.

Почему WebRTC через TURN основной путь, а не только WebSocket [S10]:
- меньше задержка и устойчивость к потерям (UDP, FEC, без head-of-line blocking);
- 8–20 Mbit/s на зрителя не идут через туннель агента, где их делили бы с RPC и файлами, и не нагружают gateway;
- деплой gateway не рвёт поток: после старта WebRTC gateway в пути не участвует.

### 9.2 coturn: размещение и конфигурация

- **Где.** В Kubernetes рядом с gateway, но не в процессе gateway (S4 §13). Основной вариант — Deployment с `hostNetwork: true` на выделенной ноде (метка `sbx.io/turn=true`), `external-ip` = IP этой ноды. Тогда relay ↔ relay остаётся внутри одного хоста, и наружу нужен только порт 3478 (и 443 для TLS). Запасной вариант — Service `LoadBalancer` с UDP; тогда S12 проверяет relay ↔ relay через VIP. Выбор — S12, проверка — §20.
- **Имя:** `turn.<domain>` → IP TURN. Сертификат для `turns:` выпускает cert-manager (как `*.sbx`).
- **Порты:** `3478/udp`, `3478/tcp`, TLS на `443/tcp` (у TURN свой IP, поэтому 443 не конфликтует с `gateway-edge`). Порты relay — диапазон 49152–65535 на хосте TURN, наружу их открывать не нужно.
- **Sandbox → TURN.** VM ходит к TURN исходящими UDP-пакетами на 3478 через SNAT ноды. В firewall S1 нужен IPSet `sbx-turn` с адресом TURN и правило в группе `sbx-egress` перед запретами (TCP не нужен: VM использует TURN только по UDP, п. 3 §9.1):

```
[IPSET sbx-turn] # boat-dev-clone S10: TURN server address(es)
OUT ACCEPT -dest +sbx-turn -p udp -dport 3478
```

  Изменение firewall — шагом runbook S1 с таймером отката (S1 §4.4).
- **Конфигурация** (`turnserver.conf`, суть; точные ключи исполнитель сверяет с 4.18):

```ini
listening-port=3478
tls-listening-port=443
external-ip=<turn ip>
realm=turn.<domain>
fingerprint
use-auth-secret
static-auth-secret=<from Secret>
# Not an open relay: relay only between allocations of this server.
denied-peer-ip=0.0.0.0-255.255.255.255
denied-peer-ip=::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
allowed-peer-ip=<turn ip>
no-tcp-relay
no-multicast-peers
no-cli
no-software-attribute
user-quota=4
max-bps=3000000          # bytes per second per session, ~24 Mbit/s
total-quota=400
prometheus
```

- **Почему так.** Пиры, которых TURN пускает, — только его собственные relay-адреса. Поэтому утёкшие креды не превращают TURN в прокси наружу (анти-цель). Пары ICE, где TURN должен слать на host- или srflx-кандидат другой стороны, сразу получают отказ `CreatePermission`, и ICE выбирает relay ↔ relay (или прямой путь из п. 4 §9.1, если он есть). Relay от TURN к адресу браузера не поддерживается.

### 9.3 Креды TURN

- Схема TURN REST API: `username = "<unix-expiry>:<sandboxId>"`, `credential = base64(HMAC-SHA1(secret, username))`. Секрет — в Kubernetes Secret, его читают только `worker` и coturn. В VM и в `api` секрета нет. **Это переопределяет S4 §13**, где креды выдавал `api` вместе с URL: креды нужны стримеру в VM при каждом старте потока, а не только при выдаче ссылки, и в режимах `sso`/`public` ссылку через API никто не запрашивает.
- Срок — 24 h [S10]. Worker выдаёт креды через `Desktop/Configure` (§11.1):
  - в шаге `claim` (S6 §7.3) после `System/Claim`;
  - в шаге `provision` после каждой загрузки (resume, recover, reprovision — S6 §7.6, §7.8), сразу после доставки секретов;
  - контроллер `desktop-turn` раз в 10 min продлевает креды у `ready` sandbox с рабочим столом, если им больше 12 h.
- Агент пишет их в `desktop/ice-servers.json` (`[{urls: [...], username, credential}]`). URL-ы — из конфига `SBX_TURN_URLS`: `turn:turn.<domain>:3478?transport=udp`, `turn:turn.<domain>:3478?transport=tcp`, `turns:turn.<domain>:443?transport=tcp`.
- Те же креды получает браузер зрителя. Это допустимо: TURN не relay наружу (§9.2), и у кредов есть квота.
- Поток живёт не дольше срока кредов, которые были в момент его старта. На практике это не меньше 12 h; затем viewer переподключается. Проверяет ли coturn срок при `Refresh` существующего allocation, записывает спайк L.
- Ротация `static-auth-secret` — S12. Если coturn 4.18 принимает только один секрет из файла, ротация идёт с коротким окном, когда новые потоки не стартуют.

### 9.4 WebSocket через gateway

- Транспорт `websocket` moonlight-web — HTTP-апгрейд на `/api/host/stream/web_socket` того же хоста. Gateway проксирует его как любой WebSocket (S4 §7.3). Для `VideoDecoder` браузеру нужен secure context — HTTPS есть.
- Трафик 8–20 Mbit/s на зрителя идёт через gateway и туннель агента. Деплой gateway закрывает такой поток через 2 min (S4 §10.2), и viewer переподключается.
- Параметр ссылки `transport=websocket` принудительно включает этот путь: для сетей без UDP и для отладки.

## 10. Gateway: хост `<slug>-desktop`

### 10.1 Маршрут

Суффикс `-desktop` уже зарезервирован (S4 §4.2). Ответ `GET /internal/v1/gateway/routes/{label}` для метки `<slug>-desktop` получает новое поле `kind` (для портов — `"port"`):

```json
{
  "label": "quiet-otter-lamp-desktop",
  "kind": "desktop",
  "sandboxId": "sb_...", "slug": "quiet-otter-lamp",
  "port": 47800,
  "machineId": "0192...", "sandboxState": "ready",
  "access": "token" | "sso" | "public",
  "tokenHash": null,
  "authEpoch": 3,
  "blocked": false, "blockReason": null,
  "hostRewrite": "localhost", "appProtocol": "http1", "teamId": "team_..."
}
```

- `404 route_not_found`, если у шаблона sandbox нет capability `desktop`.
- `blocked: true, blockReason: "public_disabled"`, если `access = public`, а оператор не разрешил публичный рабочий стол (§10.4).
- `NOTIFY sbx_routes '<slug>'` — триггер на `sandbox_desktops` (§13.5), как для портов.

### 10.2 Доступ

| Режим | Как входит браузер | По умолчанию |
|---|---|---|
| `token` | одноразовый **билет** из `POST /v1/sandboxes/{sb}/desktop/links` (§13.2) | да |
| `sso` | вход через oauth2-proxy, как у портов (S4 §8.4), но пускаются **только участники команды sandbox и операторы** | — |
| `public` | без авторизации; только если оператор включил `PlatformDefaults.publicDesktopEnabled` (по умолчанию `false`) | — |

Билет принимается во всех режимах, кроме `public` (там он не нужен). Так дашборд работает одинаково при любом режиме.

**Билет** [S10]:
- `sbxd_` + 32 случайных байта (base64url). В `api` хранится SHA-256.
- Срок 10 min. Одноразовый. Привязан к `(sandboxId, label, userId, authEpoch)`.
- Передаётся в query `_ticket`: gateway видит только query, фрагмент URL ему недоступен.

Порядок проверки на `<slug>-desktop` (вместо S4 §8.3):
1. Валидная cookie `__Host-sbx_auth` для этого label с `m: "d"` и текущим `authEpoch` → пропустить. `_ticket`, если он есть, вырезается без обмена.
2. `_ticket` в query → `POST /internal/v1/gateway/desktop-auth/exchange {ticket, label}`. Верный → cookie, `302` на тот же URL без `_ticket`, `Referrer-Policy: no-referrer`. Неверный или использованный → `401 token_invalid` (счётчик ошибок авторизации S4 §11).
3. `sso` → поток S4 §8.4. `api` проверяет политику для `kind = desktop` (команда или оператор), а не `ssoPortPolicy`.
4. `public` → пропустить.
5. Иначе `401 auth_required`, страница «нужна ссылка на рабочий стол».

**Cookie** — та же `__Host-sbx_auth` (S4 §8.2): `m: "d"`, срок 12 h, атрибуты `Secure; HttpOnly; Path=/; SameSite=None; Partitioned`. `SameSite=None; Partitioned` нужен, чтобы поток работал в iframe чужого сайта (сценарий 3). В iframe дашборда (тот же сайт) cookie работает в любом браузере; в iframe чужого сайта — там, где есть CHIPS (Chrome, Firefox, Edge). Safari в чужом iframe не поддерживается.

**Защита от CSRF** при `SameSite=None`: на метках `kind = desktop` gateway требует `Origin` = `https://<label>.<sbx-domain>` у всех запросов, кроме `GET`/`HEAD`, и у WebSocket upgrade. Иначе `403 origin_forbidden`.

**Без пропуска CORS preflight.** Правило S4 §8.5 (preflight проходит без авторизации) на метках `kind = desktop` **не действует**: `OPTIONS` требует авторизации, как любой запрос. Viewer moonlight-web живёт на том же origin, CORS ему не нужен. Причина: `OPTIONS /api/host/stream/webrtc` у moonlight-web отвечает заголовками `Link` с ICE-серверами, то есть с кредами TURN, любому запросу с заголовком пользователя (§10.4).

### 10.3 Открытие: `GET /`

Gateway сам обрабатывает `GET /` на метке `desktop` после авторизации (страница со списком хостов moonlight-web не используется):
1. `POST /internal/v1/gateway/desktop/open {label}` → `api` вызывает агент `Desktop/Open` (§11.1), ответ `{hostId, appId}`.
2. `302` на `/stream.html?hostId=<h>&appId=<a>` плюс разрешённые параметры из исходного query: `fps`, `bitrate`, `dataTransport`, `language`. Остальные отбрасываются.
3. Стример не успел запуститься за 20 s → `503 desktop_starting` (страница с автообновлением через 5 s). Фаза `desktop` не `ready` → тоже `503 desktop_starting`.

Ссылка из API имеет вид `https://<slug>-desktop.sbx.<domain>/?_ticket=…&fps=30`. Шаги 2 из §10.2 и §10.3 сливаются в один редирект: обмен билета, затем `Open`, затем `302` на `stream.html` с cookie.

### 10.4 Заголовки и прочее

- В запрос к moonlight-web gateway ставит `X-Sbx-Desktop-User: sbx` (имя заголовка и значение — конфиг gateway) **только после успешной авторизации** по §10.2. Запрос без авторизации до moonlight-web не доходит вообще. Входящий заголовок с этим именем вырезается вместе со всеми `X-Sbx-*` (S4 §7.4). Остальные правила вырезания S4 §7.4 действуют.
- `hostRewrite: localhost`: moonlight-web видит `Host: localhost:47800`.
- Глобальный выключатель `publicDesktopEnabled` — в S8 `PlatformDefaults`, отдельно от `publicPortsEnabled`. Его смена шлёт `NOTIFY sbx_routes '*'`.
- Страницы ошибок, лимиты, логи — как у портов. В access log `access=desktop`.
- Лимит запросов по метке (S4 §11) действует, но статические файлы viewer-а загружаются один раз, поэтому в него не упираются.

### 10.5 Отзыв доступа

`authEpoch` рабочего стола растёт:
- при смене режима доступа;
- при `DELETE /desktop/streams` (§13.2);
- при stop sandbox;
- при блокировке оператором;
- при отзыве доступа у человека или ключа (ниже).

Вместе с этим `api` вызывает `Desktop/EndStreams`, если sandbox `ready`. Cookie сразу перестают действовать, а активный поток (в том числе через TURN, мимо gateway) обрывается в VM. После resume нужна новая ссылка; в режиме `sso` браузер проходит вход заново сам.

**Отзыв доступа у человека или ключа.** `api` уже ведёт реестр открытых стримов по principal и закрывает их по `NOTIFY sbx_identity` (изменение S8 C9). Тот же обработчик для рабочего стола [S10]:

| Событие | Какие sandbox | Действие |
|---|---|---|
| отзыв или истечение API-ключа | sandbox, для которых этим ключом выпущены билеты за последние 12 h (`desktop_tickets.api_key_id`) | `authEpoch+1`, `EndStreams` |
| удаление участника из команды, деактивация пользователя | sandbox, для которых этот пользователь получал билеты за 12 h, и все sandbox команды в режиме `sso` | `authEpoch+1`, `EndStreams` |

12 h — срок cookie: более старый билет уже не может держать cookie. Зритель, который открыл ссылку, выданную другим человеком, теряет доступ вместе с тем, кто её выдал. Это намеренно: ссылка — это делегирование доступа выдавшего.

## 11. Агент

### 11.1 Сервис `sbx.agent.v1.Desktop`

Новый Connect-сервис, `proto/sbx/agent/v1/desktop.proto`:

| Метод | Что | Идемпотентность |
|---|---|---|
| `Status` | фаза `desktop`, размер экрана, позиция курсора, стример (`running`, `streaming`, `stream_count` если известно), версии Sunshine, moonlight-web, cua-driver | `NO_SIDE_EFFECTS` |
| `Configure{ice_servers}` | креды TURN (§9.3) в `desktop/ice-servers.json` | `Sbx-Request-Id` |
| `Open` | запустить стример по требованию, pairing при необходимости (§8.3), ответ `{host_id, app_id}` | `IDEMPOTENT` |
| `StopStreamer` | остановить Sunshine и moonlight-web | `IDEMPOTENT` |
| `EndStreams` | оборвать активные потоки (§8.4) | `IDEMPOTENT` |
| `Screenshot{format, quality, max_width, max_height, region, cursor}` | изображение и размеры (§12.1) | `NO_SIDE_EFFECTS` |
| `Act{actions, coordinate_space}` | последовательность действий ввода (§12.2) | `Sbx-Request-Id` |
| `GetClipboard` / `SetClipboard{text}` | текст буфера обмена (§12.3) | `NO_SIDE_EFFECTS` / `Sbx-Request-Id` |

- Скриншот возвращается в теле ответа (`bytes`). Для этого сервиса лимит сообщения Connect — 32 MiB **[исполнитель: проверить, что `libs/tunnel` его пропускает]**.
- Ввод сериализуется: на machine одновременно выполняется один `Act`. Остальные ждут до 10 s, затем `resource_exhausted desktop_busy`.
- Capabilities (S2 §10.2): `desktop.v1`, `desktop.stream.v1`, `desktop.input.v1`, `desktop.clipboard.v1`. Если их нет у агента, `api` отвечает `409 agent_outdated`.
- Коды `ErrorDetail.code`: `desktop_unsupported`, `desktop_not_ready`, `desktop_busy`, `streamer_failed`, `action_failed`, `invalid_action`, `clipboard_unavailable`.

### 11.2 `sbx-session` на Linux

S9 ввёл `sbx-session` — helper в интерактивной сессии Windows. S10 делает его общим для обеих ОС [S10]: один протокол, одна логика в агенте, ОС-зависимый код в helper-е.

- Бинарник `sbx-session` в пакете агента (`versions/<v>/sbx-session` на Linux). Запускается user-unit-ом `sbx-session.service` пользователя `user` из скрипта сессии (§6.3), `Restart=always`.
- Подключается к агенту по unix-сокету `/run/sbx-session/session.sock`: каталог `0750 root:user`, сокет `0660 root:user`. Не внутри `/run/sbx-agent`: тот каталог `0700 root` (S3 §5), и `user` до сокета не дошёл бы. Протокол S9 §13 (protobuf с префиксом длины, `proto/sbx/session/v1/session.proto`) дополняется сообщениями `Capture`, `Input`, `ClipboardGet`, `ClipboardSet` и ответами на них.
- **Фаза `desktop` на Linux** = `ready`, когда helper подключён, X-сервер отвечает, а helper сообщил `State{width, height}`. Для Windows — как в S9 §13.
- Реализация на Linux **[исполнитель]**:
  - скриншот — `GetImage` (или MIT-SHM) по X11 из Go (`github.com/jezek/xgb`);
  - мышь и клавиши — XTEST;
  - печать произвольного Unicode — временная перепривязка свободного keycode на нужный keysym, как в xdotool, или вызов `xdotool type` из helper-а;
  - буфер — helper сам владеет selection `CLIPBOARD` (он живёт всю сессию, поэтому `xclip` не нужен).
- **На Windows** helper использует GDI `BitBlt` или DXGI Desktop Duplication (выбор по спайку W), `SendInput` с `MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK` и `KEYEVENTF_UNICODE` для текста, Win32 clipboard (`CF_UNICODETEXT`).
- Агент перекодирует сырой кадр от helper-а в PNG или JPEG и масштабирует (`golang.org/x/image/draw`, CatmullRom). Helper отдаёт несжатый BGRA по сокету: так кодек один на обе ОС.

### 11.3 Супервизор стримера

- Linux: `systemctl start|stop sbx-moonlight-web.service` и `systemctl --user -M user@ start|stop sunshine.service` через D-Bus.
- Windows: SCM (`ServiceManager`, S3 §18).
- Агент следит за процессами и перезапускает упавший стример не чаще раза в 10 s. После 5 падений подряд `Open` отвечает `streamer_failed`.

### 11.4 События и простой

- Новое событие журнала `desktop.streaming_changed{streaming, count?}` (§8.4).
- Счётчик **`desktopStreams`** (1, если идёт поток и число неизвестно) добавляется в оба места, откуда S6 берёт простой (S6 §12): в payload события `activity` и в ответ `System/Activity`, который S6 вызывает живьём перед idle-stop. При `desktopStreams > 0` sandbox `busy`, и idle-stop её не останавливает. Без этого зритель через TURN был бы невидим: TCP-потоков через туннель у WebRTC-потока нет.
- Агентский признак простоя (S3 §13) тоже считает активный поток занятостью.
- Вызовы computer-use API обновляют `last_api_call_at` как любые вызовы API (S6 `touchApiActivity`).

## 12. Примитивы computer-use

Семантика одинакова на Linux и Windows. Координаты — пиксели экрана, начало в левом верхнем углу.

### 12.1 Скриншот

- `format`: `png` (по умолчанию) или `jpeg` (`quality` 1–100, по умолчанию 80).
- `max_width`, `max_height`: уменьшить с сохранением пропорций (не увеличивает). Для LLM удобно 1280×720 или 1024×768.
- `region {x, y, width, height}`: вырезать прямоугольник до масштабирования.
- `cursor`: дорисовать курсор (по умолчанию `true`).
- Ответ: изображение, `screen {width, height}`, `image {width, height}`, `scale` (= image / screen по ширине), позиция курсора.

### 12.2 Действия (`Act`)

Список выполняется по порядку и останавливается на первой ошибке. Ответ: `completed` (число выполненных действий), позиция курсора, размер экрана. При ошибке — `action_failed` с индексом действия; выполненные до него действия не откатываются.

| `type` | Поля | Что делает |
|---|---|---|
| `move` | `x, y` | переместить курсор |
| `click` | `x?, y?, button = left\|right\|middle, count = 1..3, modifiers?` | переместить (если заданы координаты) и кликнуть; `count: 2` — двойной клик |
| `mouse_down`, `mouse_up` | `x?, y?, button` | нажать или отпустить кнопку |
| `scroll` | `x?, y?, dx, dy` | прокрутка в «щелчках» колеса; `dy > 0` — вниз |
| `drag` | `path [{x, y}, …]` (≥ 2 точек), `button = left` | нажать в первой точке, провести по точкам, отпустить в последней |
| `key` | `keys ["ctrl", "shift", "t"]` | аккорд: нажать по порядку, отпустить в обратном |
| `key_down`, `key_up` | `key` | для удержания |
| `type` | `text` (до 10 000 символов), `delay_ms = 5` (0–100) | напечатать Unicode-текст как ввод с клавиатуры |
| `wait` | `ms` (до 10 000) | пауза |

- `coordinate_space {width, height}` в запросе: координаты даны в пространстве уменьшенного скриншота, агент пересчитывает их в экранные. Так LLM передаёт координаты с картинки 1280×720 без пересчёта.
- Координаты вне экрана → `invalid_action` до выполнения первого действия (весь список проверяется заранее).
- Пределы: до 100 действий в запросе, суммарно до 60 s.
- **Имена клавиш** — фиксированный словарь в proto, нижний регистр: модификаторы `ctrl`, `alt`, `shift`, `meta` (Super/Win); `enter`, `tab`, `escape`, `backspace`, `delete`, `insert`, `space`, `up`, `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown`, `f1`…`f24`, `capslock`, `printscreen`, `menu`; одиночные печатные символы (`a`, `1`, `/`). Неизвестное имя → `invalid_action`.
- Модификаторы `click` — тот же словарь.

### 12.3 Буфер обмена

- Только текст UTF-8, до 1 MiB. Картинки — S29.
- `GetClipboard` без текста в буфере → пустая строка, `has_text: false`.
- В потоке moonlight-web браузер передаёт вставленный текст как ввод. Это отдельный путь, API буфера от него не зависит.

## 13. Публичное API (добавления к S7)

### 13.1 Права

Новый scope **`desktop`**: ссылки, режим доступа, завершение потоков, скриншот, действия, буфер. Входит в пресет `full`, не входит в `read-only` и `ci`. `GET /desktop` (статус) доступен с `sandboxes:read`.

Обоснование: рабочий стол даёт полный контроль над сессией `user` (у него sudo), то есть по силе равен `exec`. Отдельный scope позволяет выдать ключ на exec без экрана и наоборот.

### 13.2 Ручки

| Метод и путь | Что | Scope |
|---|---|---|
| `GET /v1/sandboxes/{sandbox}/desktop` | статус: `{state: "ready"\|"starting"\|"unavailable", reason, screen, cursor, access, url, streamer: {running, streaming}}` | `sandboxes:read` |
| `POST /v1/sandboxes/{sandbox}/desktop/links` | одноразовая ссылка; тело `{fps?: 30\|60, bitrateKbps?: 1000..20000, transport?: "auto"\|"webrtc"\|"websocket"}` → `201 {url, expiresAt}` | `desktop` |
| `PUT /v1/sandboxes/{sandbox}/desktop/access` | `{access: "token"\|"sso"\|"public"}` → `{access, url}` | `desktop` |
| `DELETE /v1/sandboxes/{sandbox}/desktop/streams` | оборвать потоки и сбросить cookie (`authEpoch+1`) → `204` | `desktop` |
| `GET /v1/sandboxes/{sandbox}/desktop/screenshot` | query: `format`, `quality`, `maxWidth`, `maxHeight`, `x`, `y`, `width`, `height`, `cursor` → `200 image/png\|image/jpeg` | `desktop` |
| `POST /v1/sandboxes/{sandbox}/desktop/actions` | `{actions: [...], coordinateSpace?: {width, height}, screenshot?: {format, quality, maxWidth, maxHeight}}` → `200 {completed, cursor, screen, screenshot?}`; `Idempotency-Key` | `desktop` |
| `GET /v1/sandboxes/{sandbox}/desktop/clipboard` | `{text, hasText}` | `desktop` |
| `PUT /v1/sandboxes/{sandbox}/desktop/clipboard` | `{text}` → `204` | `desktop` |

- **Ссылка** строится как `https://<slug>-desktop.<sbx-domain>/?_ticket=<t>&fps=<n>…` (§10.3). Это секрет, как URL с токеном порта. В списках и `GET` она не возвращается. `POST /links` заранее вызывает `Desktop/Open` в фоне, чтобы стример был готов к открытию.
- **Скриншот** — байты изображения с заголовками `Sbx-Screen-Width`, `Sbx-Screen-Height`, `Sbx-Image-Width`, `Sbx-Image-Height`, `Sbx-Cursor-X`, `Sbx-Cursor-Y`, `Cache-Control: no-store`. В ответе `actions` с `screenshot` — JSON `{contentType, width, height, data: <base64>}`: это скриншот после действий одним вызовом, как нужно MCP.
- **Ошибки** (дополнение к S7 §5.5):

| HTTP | `code` | `retryable` | Когда |
|---|---|---|---|
| 422 | `desktop_unsupported` | нет | у шаблона нет capability `desktop` |
| 409 | `desktop_not_ready` | да | sandbox `ready`, но фаза `desktop` ещё не `ready` (перезапуск сессии, пробуждение); `Retry-After: 2` |
| 409 | `desktop_busy` | да | другой `Act` выполняется дольше 10 s |
| 400 | `invalid_action` | нет | `details {index, reason}` |
| 422 | `action_failed` | нет | действие не выполнилось; `details {index, completed}` |
| 503 | `streamer_unavailable` | да | стример не запустился |
| 403 | `forbidden` | нет | `public` при выключенном `publicDesktopEnabled` (`details.reason: "public_disabled"`) |

- Состояние sandbox — как для команд (S7 §9.1): не `ready` → `409 sandbox_not_ready`.
- Ресурс Sandbox (S7 §8.1): `endpoints.desktop = "https://<slug>-desktop.<sbx-domain>/"` у шаблонов с capability `desktop` (без билета).

### 13.3 Внутренние ручки (internal listener, service token gateway)

- `POST /internal/v1/gateway/desktop-auth/exchange {ticket, label}` → `{label, authEpoch, userId}` или `400 {"code": "invalid_ticket"}`. Атомарно, как обмен кода SSO (S7 §12.1): `UPDATE desktop_tickets SET used_at = now() WHERE ticket_hash = $1 AND label = $2 AND used_at IS NULL AND expires_at > now() AND auth_epoch = <текущий> RETURNING …`.
- `POST /internal/v1/gateway/desktop/open {label}` → `Desktop/Open` у агента → `{hostId, appId}`; `409 desktop_not_ready`, `503 streamer_unavailable`. Обновляет `last_api_call_at`.
- `GET /sbx-auth/authorize` (S7 §7.7) для меток `kind = desktop` проверяет, что пользователь — участник команды sandbox или оператор.

### 13.4 Поведение при жизненном цикле

| Событие | Рабочий стол |
|---|---|
| create (шаблон с `desktop`) | строка `sandbox_desktops` с `access = token`, `authEpoch = 1` |
| stop | `authEpoch+1`; поток обрывается вместе с VM |
| resume | креды TURN заново (§9.3); нужна новая ссылка |
| fork | новая sandbox, новый slug и новая строка `access = token`. Режим доступа источника не наследуется |
| delete | строка удаляется вместе с sandbox, маршрут даёт `404` |

### 13.5 Таблицы

Схема `runtime`, миграции S10 в `db/migrations/` с номерами **0401–0499** (0400 занята S8 environments) [S10, по прецеденту S7]:

```
sandbox_desktops(
  sandbox_id uuid pk,             -- runtime.sandboxes
  access text,                    -- token | sso | public
  auth_epoch int,
  blocked bool, block_reason text null,
  turn_issued_at timestamptz null,
  updated_at timestamptz)

desktop_tickets(
  ticket_hash bytea pk,           -- sha256 of the 32-byte ticket
  sandbox_id uuid, label text, user_id text, api_key_id text null,
  auth_epoch int,
  expires_at timestamptz,         -- now() + 10 min
  used_at timestamptz null, created_at timestamptz)
```

Триггер на `sandbox_desktops` шлёт `NOTIFY sbx_routes '<slug>'`. Cleanup S6 удаляет билеты старше суток. Изменения `packages/core` (`SandboxService`: `desktopLink`, `setDesktopAccess`, `endDesktopStreams`, шаг `authEpoch+1` в stop, шаг TURN в claim и provision) вносит исполнитель S10, согласуя с треком S6, как S7 (S7 §20.2).

## 14. Дашборд, CLI, SDK, MCP

### 14.1 Дашборд (вкладка Desktop, S8 §8)

S8 оставил заглушку; вкладку реализует исполнитель S10.
- При открытии вкладки — `POST /api/v1/sandboxes/{id}/desktop/links`, затем iframe:

```html
<iframe src="{url}" allow="autoplay; fullscreen; clipboard-read; clipboard-write; keyboard-map"
        referrerpolicy="no-referrer" style="width:100%;aspect-ratio:16/9;border:0"></iframe>
```

- Новая ссылка — при каждом монтировании вкладки и после перехода sandbox в `ready` (resume).
- Кнопки: «открыть в новой вкладке» (новая ссылка), полный экран, выбор режима доступа, «отключить всех зрителей» (`DELETE /desktop/streams`).
- Sandbox не `ready` → сообщение и кнопка Resume. `desktop_not_ready` → «рабочий стол запускается», повтор через 2 s.
- CSP S8 уже разрешает `frame-src https://*.<sbx-domain>`.

### 14.2 CLI

| Команда | Что |
|---|---|
| `sbx desktop <id> [--fps 60] [--transport websocket] [--print]` | открыть ссылку в браузере (`--print` — только вывести) |
| `sbx desktop screenshot <id> [-o file.png] [--max-width N] [--jpeg]` | скриншот в файл или stdout |
| `sbx desktop act <id> [--json <file\|->]` | список действий из JSON; плюс короткие формы `click X Y`, `type TEXT`, `key ctrl+c`, `scroll DY` |
| `sbx desktop clipboard <id> [get\|set TEXT]` | буфер |
| `sbx desktop access <id> token\|sso\|public` | режим доступа |

Контракт вывода — как у остального CLI (S7 §14.3): JSON, если stdout не TTY.

### 14.3 SDK (TS и Python)

Хелперы поверх сгенерированного клиента: `desktop.link()`, `desktop.screenshot()`, `desktop.click(x, y)`, `desktop.type(text)`, `desktop.key(...keys)`, `desktop.scroll(dy)`, `desktop.drag(path)`, `desktop.clipboard.get()/set()`, `waitForDesktop(sandbox)` (повторяет `GET /desktop` до `state = ready`, повтор только при `retryable`).

### 14.4 Что получает S11 (MCP)

- `desktop_url` → `POST /desktop/links`.
- `computer_screenshot` → `GET /desktop/screenshot` с `maxWidth=1280` по умолчанию, ответ — image content MCP.
- `computer_click`, `computer_move`, `computer_drag`, `computer_scroll`, `computer_key`, `computer_type` → `POST /desktop/actions` с одним действием и `coordinateSpace` из последнего скриншота; опция `screenshot_after`.
- `computer_clipboard_read`, `computer_clipboard_write`.

В `docs/roadmap-phase2.md` §5.2 эти инструменты помечены S29; после S10 они переходят в S11 (MVP). Правку roadmap делает master.

## 15. Размеры и холодное создание

### 15.1 Размеры [S10]

| Size | vCPU | RAM | Где |
|---|---|---|---|
| `2gb` | 2 | 2048 | `linux` (есть) |
| `4gb` | 4 | 4096 | по умолчанию для `linux-desktop` и `windows` |
| `8gb` | 8 | 8192 | разрешён для `linux-desktop` и `windows`; в PoC занимает весь бюджет sandbox |

- `linux-desktop`: `defaultSize = 4gb`, `allowedSizes = [4gb, 8gb]`. На 2 GB Chrome с несколькими вкладками и рабочий стол упираются в OOM.
- `windows`: размер по умолчанию `4gb` теперь означает 4 vCPU вместо 2 (S9 §9). На `pve` 24 ядра, CPU не ограничен, а x264 и Windows вместе на 2 vCPU дают рывки. Ограничен только RAM (S6 §8.1).
- Резерв памяти под стример (roadmap-phase2 L18): Sunshine 150–250 MB и moonlight-web 30–60 MB во время потока. Отдельного `MemoryMin` у них нет: стример запускается по требованию, и его RAM входит в размер sandbox.

### 15.2 CPU и сеть

- x264 `superfast` + `zerolatency`, 1080p30: ожидается 0.7–1.5 vCPU во время активного потока; 1080p60 — до 2–3 vCPU. Без потока стример не работает, CPU не тратится. Замер §20, цифры — в §24.
- Сеть на зрителя: 8 Mbit/s по умолчанию, до 20 Mbit/s. Через TURN (WebRTC) или через gateway и туннель (WebSocket).
- Узкое место на одной ноде — CPU хоста при нескольких потоках одновременно. Квота на число одновременных потоков в MVP не вводится; метрики (§18) показывают, когда она понадобится.

### 15.3 Холодное создание (решение Ильи 2026-10-31)

Warm и hibernated pools не входят в MVP ни для Linux, ни для Windows. Create: cold clone → boot → claim → Desktop/Configure → desktop ready. Никаких pool targets, подготовки machine пула, hibernate/resume-hint для пула и цели ≤15 s.

Для `linux-desktop` ожидается 20–40 s, допускается до ~1 min; для Windows допускается до 5 min. Это ориентиры до замеров, не измеренный результат. Stop/resume обычной sandbox остаётся в приёмке. Размер `4gb` по умолчанию, `8gb` разрешён; общий бюджет работающих sandbox на pve — 8 GB.

## 16. Безопасность

- **Рабочий стол = полный контроль над `user`.** Поэтому: отдельный scope `desktop`; в режиме `sso` только команда и операторы; `public` выключен глобально по умолчанию (§10.2). Решение безопасности утверждено master 2026-10-29 (§26).
- **Билет и cookie.** Билет одноразовый и живёт 10 min, хранится хешем, `_token`/`_ticket` вырезаются из URL первым `302`, query не пишется в логи (S4 §12.2), `Referrer-Policy: no-referrer`. Cookie — `__Host-`, на один label, с `authEpoch`.
- **Отзыв действует на поток через TURN**: `EndStreams` в VM (§10.5). TURN-креды при этом остаются действительными до истечения, но через TURN нельзя ходить ни к чему, кроме его собственных allocation (§9.2).
- **TURN не открытый relay:** пиры — только свои relay-адреса; квоты на пользователя и сессию; `no-tcp-relay`; секрет только в `worker` и coturn.
- **Стример только на loopback.** Sunshine `bind_address = 127.0.0.1`, moonlight-web `127.0.0.1:47800`. Креды Sunshine и moonlight-web свои у каждой идентичности machine. Всё, что внутри VM, может к ним подключиться — это в пределах границы доверия (VM).
- **Подделка пользователя moonlight-web** снаружи невозможна: `X-Sbx-Desktop-User` ставит только gateway и только после авторизации, входящий вырезается. Preflight без авторизации на метке рабочего стола не пропускается, иначе `OPTIONS` отдал бы креды TURN (§10.2).
- **Скриншоты** не хранятся и не пишутся в логи `api` и агента. На экране могут быть секреты — это такой же доступ, как `files:read`.
- **Буфер обмена** в логи не пишется.
- **CSRF** на метке рабочего стола — проверка `Origin` (§10.2).
- **Внешние STUN** выключены: VM и браузер не ходят к серверам Google.
- **Подписи артефактов.** cua-driver — sigstore, Sunshine и moonlight-web — sha256 из `versions.toml`, Chrome — ключ репозитория Google.

## 17. Лицензии

| Компонент | Лицензия | Как используется |
|---|---|---|
| Sunshine | GPL-3.0 | бинарный пакет upstream без изменений, в образах шаблонов |
| moonlight-web | GPL-3.0 | бинарный архив upstream без изменений, в образах шаблонов |
| coturn | BSD-3-Clause | образ в кластере |
| cua-driver | MIT (расширение `cua-perception` — AGPL, не ставится) | в образах шаблонов |
| Google Chrome | Google Chrome Terms of Service | в образе `linux-desktop` (решение архитектуры §1) |
| openbox, LightDM, tint2, Xorg, PipeWire | GPL-2.0 / GPL-3.0 / MIT | пакеты Ubuntu |

GPL-3.0 при распространении бинарников требует предложить исходный код. Мы не модифицируем код. Манифест сборки (S5 §11) записывает версию и URL исходников каждого GPL-компонента: этого достаточно для предложения исходников. GPL-3.0-компоненты разрешены Ильёй: бинарники не изменяются, используются только внутри компании, третьим лицам не распространяются (§26). Замена без GPL на обеих ОС — Guacamole (Apache-2.0), но с худшей задержкой и проблемами RDP на Windows (§4.1).

## 18. Наблюдаемость

- **Агент:** `Desktop/Status`; событие `desktop.streaming_changed`; в `doctor --desktop` — версии, состояние сессии, стримера, pairing. Логи Sunshine и moonlight-web — в journald (Linux) и файлах службы (Windows), агент их не пересылает.
- **`api`:** метрики `sbx_api_desktop_links_total`, `sbx_api_desktop_actions_total{type, result}`, `sbx_api_desktop_screenshot_bytes` (histogram), `sbx_api_desktop_action_duration_seconds`.
- **Gateway:** существующие метрики с `access=desktop`; `sbx_gateway_desktop_open_total{result}`.
- **coturn:** встроенный Prometheus-экспортёр (allocations, трафик, сессии). Тревога S12 при `total-quota` ближе 80%.
- **S6:** `desktopStreams` в activity — сколько sandbox сейчас смотрят. CPU sandbox во время потока — из `System/Metrics`.

## 19. Спайки и порядок реализации

Спайки — первый шаг реализации, а не часть этой спеки: при её написании VM на `pve` не запускались. Перед стартом спайка тред реализации получает у master подтверждение, что хост свободен (бюджет 8 GB делят и другие треды, например замеры `s1-fix`).

### 19.1 Спайк L (Linux) — первым

На `pve` в рамках ограничений §3: одна VM 4 GB (VMID 5xx), вместе с ней другие sandbox — не больше 8 GB.
1. VM из шаблона S5 `linux` (только clone; исходные 597/598/599 не менять), шаг `60-desktop` вручную через QGA.
2. Проверить вопросы: pairing через API moonlight-web v3 и Sunshine; поведение при втором зрителе; как агент узнаёт об активном потоке; проверяет ли coturn срок кредов при `Refresh`.
3. Замеры §20: CPU при 1080p30 и 1080p60, RAM, время старта стримера, задержка «от стекла до стекла» по WebSocket и WebRTC через TURN.
4. Измерить холодный create и обычный stop/resume; часть спайка про hibernation исключена решением Ильи.

Браузер открывает поток через gateway CT 590; адреса задаются только в `infra/dev-cp/`. TURN — собственный coturn в compose. Любое изменение firewall предварительно сообщается master и выполняется только с таймером отката (S1 §4.4). Внешние туннели и relay-сервисы запрещены.

### 19.2 Спайк W (Windows)

После merge S9 и сообщения master, одна VM 4 GB:
1. Видеоадаптер (§7): `std`, `virtio` + `viogpudo`, IddCx-драйвер. Захват `ddx`, скриншот `BitBlt`/DXGI после cold boot и обычного stop/resume.
2. Sunshine с `encoder = software` на Windows: поток идёт, CPU при 1080p30.
3. Нужен ли аудиоустройство для старта потока.
4. `SendInput` и `KEYEVENTF_UNICODE` из `sbx-session`: клики, печать, буфер.

### 19.3 Порядок

1. Спайк L.
2. Proto `desktop.proto` и сообщения `session.proto`; `sbx-session` на Linux; сервис `Desktop` в агенте (скриншот, ввод, буфер), фаза `desktop`, `desktop: true`, env.
3. Рецепт `linux-desktop` с VMIDs `[595, 596]`, профиль `verify`, холодное создание без пула.
4. Стример: супервизор, pairing, `Open`, `EndStreams`, `Configure`.
5. Gateway: `kind = desktop`, билеты, `GET /`, заголовок, `Origin`, cookie `Partitioned`.
6. `api`: ручки §13, таблицы, внутренние ручки; `worker`: TURN-креды, `authEpoch` при stop, `desktopStreams`.
7. coturn: конфиг и манифест (передаётся в S12), IPSet `sbx-turn` в runbook S1.
8. Спайк W и интеграция Windows.
9. Вкладка дашборда, CLI, SDK.
10. Приёмка §20, цифры в §24.

## 20. Приёмка

Где идут тесты: unit (фейки `sbx-session` и стримера); kind/k3s (gateway, `api`, coturn, агент-процесс на Linux runner-е с Xvfb для `sbx-session`); стенд `pve` с реальными VM; браузер — Chrome на Mac через Tailscale.

**Computer-use (Linux и Windows):**
1. Скриншот PNG и JPEG 1920×1080; с `maxWidth=1280` — 1280×720 и `scale = 0.667`; `region` вырезает нужный прямоугольник. p50 ≤ 300 ms для полного PNG.
2. `click` по кнопке тестовой страницы в браузере — обработчик сработал; `count: 2` — `dblclick`; `right` — контекстное меню.
3. `type` строки с ASCII, кириллицей, эмодзи и CJK в текстовое поле — значение совпадает. `key ["ctrl","a"]`, `key ["ctrl","c"]` → `GetClipboard` возвращает текст поля.
4. `drag` перемещает элемент HTML5 drag-and-drop; `scroll` прокручивает страницу.
5. `coordinateSpace` 1280×720: клик по координатам с уменьшенного скриншота попадает в ту же кнопку.
6. Координаты вне экрана → `400 invalid_action`, ничего не выполнено. 101 действие → `400 validation`.
7. Повтор `actions` с тем же `Idempotency-Key` не печатает текст дважды.
8. Два параллельных `actions` выполняются по очереди, ввод не перемешивается.
9. Скриншот и действия работают при остановленном стримере; стример при этом не запускается.
10. Задержка одного действия (`click`) через API p50 ≤ 50 ms без учёта сети до `api`.

**Стрим:**
11. Дашборд: вкладка Desktop показывает рабочий стол в iframe; мышь и клавиатура из браузера работают. Время от открытия вкладки до первого кадра ≤ 5 s при остановленном стримере.
12. WebRTC: в `chrome://webrtc-internals` выбрана пара relay ↔ relay через наш TURN; внешних STUN-запросов нет.
13. Браузер с заблокированным UDP: поток идёт через TURN по TCP или TLS 443. Блокирован и TURN — через 15 s viewer переходит на WebSocket, поток идёт через gateway.
14. `transport=websocket` — поток идёт через gateway.
15. Задержка «от стекла до стекла» (часы на экране VM против часов на Mac): WebRTC p50 ≤ 150 ms, WebSocket p50 ≤ 250 ms по Tailscale в домашней сети. Цифры в §24.
16. Деплой gateway во время WebRTC-потока: поток не прерывается. Во время WebSocket-потока — прерывается не раньше чем через 2 min.
17. Второй зритель (вторая вкладка): оба видят экран и могут управлять; первый поток не обрывается при выдаче новой ссылки. CPU при двух потоках записывается в §24.
18. Стример останавливается через 15 min без потока; следующее открытие запускает его снова.

**Доступ:**
19. Билет: открывается один раз; второй переход по той же ссылке без cookie → `401`; через 10 min → `401`; `_ticket` нет ни в адресной строке после редиректа, ни в access log.
20. `sso`: участник команды входит; пользователь другой команды → отказ, даже при `ssoPortPolicy = any`; оператор входит.
21. `public` при `publicDesktopEnabled = false` → `403 route_blocked`; после включения — открывается без входа.
22. Смена режима и `DELETE /desktop/streams`: старая cookie сразу даёт `401`, а активный поток (в том числе через TURN) обрывается не позже чем через 5 s.
23. Stop: поток обрывается; после resume старая cookie не работает.
24. Ключ без scope `desktop` → `403` на всех ручках §13.2, кроме статуса.
25. Подделка `X-Sbx-Desktop-User` клиентом не доходит до moonlight-web (эхо-тест).
26. WebSocket upgrade и `POST` на метку рабочего стола с чужим `Origin` → `403 origin_forbidden`.
27. Iframe на другом сайте (тестовая страница на отдельном домене) в Chrome: поток работает (partitioned cookie).

**TURN:**
28. С кредами sandbox клиент TURN не может создать permission к внешнему адресу (`8.8.8.8`), адресу ноды, pod-у кластера или другой VM — отказ 403. Relay ↔ relay работает.
29. Креды с истёкшим сроком → `401` на `Allocate`. Продление контроллером: креды у `ready` sandbox никогда не старше 24 h.
30. Firewall: из VM сверх правил S1 доступен только `sbx-turn` UDP 3478; TCP и другие порты TURN-хоста — нет.

**Шаблон и холодный create:**
31. Проверки §6.6 и `windows-desktop` зелёные.
32. Холодный create `linux-desktop`: измерить clone + boot + desktop start (ориентир до ~1 min), `desktop: ready`, env claim виден в терминале. Windows — до 5 min. RAM всех sandbox ≤8 GB, без пула.
33. Fork работающей `linux-desktop`: у fork новые креды Sunshine и moonlight-web, pairing проходит при первом открытии; профиль Chrome сохранён.
34. Idle-stop: при открытом потоке через TURN и без других действий sandbox не останавливается 30 min (`desktopStreams` в `activity` и в `System/Activity`); после закрытия потока останавливается через `idle_timeout_seconds`.
35. Отзыв ключа, которым выдан билет, и удаление участника из команды: cookie зрителя сразу даёт `401`, поток обрывается не позже чем через 5 s после `NOTIFY sbx_identity`.
36. `OPTIONS` на метку рабочего стола без авторизации → `401`; заголовков `Link` с кредами TURN в ответе нет.

## 21. Изменения в соседних областях

Вносят исполнители этих областей по этой спеке (как S7 §20); согласование — через master.

- **S1:** IPSet `sbx-turn` и правило UDP 3478 в `sbx-egress` (§9.2), шаг runbook с таймером отката.
- **S2 / `libs/tunnel`:** лимит размера сообщения Connect до 32 MiB для `sbx.agent.v1.Desktop/Screenshot` (если сейчас меньше).
- **S3:** сервис `Desktop`; `sbx-session` на Linux и его сокет; фаза `desktop` на Linux; `CommandSpec.desktop` на Linux; `DISPLAY`/`XAUTHORITY` в платформенном env шаблонов с рабочим столом; перезапуск сессии при claim и после секретов; событие `desktop.streaming_changed` и `desktopStreams` в `activity` и `System/Activity`; учёт потока в признаке простоя; сокет `/run/sbx-session/`; подкоманда `resume-hint` на Linux; стирание состояния стримера при смене идентичности; коды ошибок §11.1; capabilities.
- **S4:** поле `kind` в маршруте; для `kind = desktop` — билеты и обмен, `GET /` → `Open` → `302`, заголовок `X-Sbx-Desktop-User` только после авторизации, без пропуска CORS preflight, `Origin`-проверка, cookie `m: "d"` с `SameSite=None; Partitioned`, страница `desktop_starting`; порты стримера в зарезервированных (`SBX_GATEWAY_RESERVED_PORTS`).
- **S5:** `extends` (S5 §16 уже предусмотрел), рецепт `linux-desktop`, профиль `verify: linux-desktop`, VMIDs `[595, 596]`; default size 4gb и allowed 4gb/8gb в runtime seeds/config.
- **S6:** `desktopStreams` в `activity`, `System/Activity` и idle-stop; `authEpoch+1` рабочего стола в stop; `Desktop/Configure` в шагах `claim` и `provision`; контроллер `desktop-turn`; таблицы §13.5 через `packages/core`.
- **S7:** scope `desktop`; ручки §13.2 и §13.3; ошибки; `endpoints.desktop`; зарезервированные порты стримера; политика `sso` для `kind = desktop`; отзыв доступа к рабочему столу в обработчике `NOTIFY sbx_identity` (§10.5, расширение S8 C9); креды TURN выдаёт `worker`, а не `api` (переопределение S4 §13); документация (смена env не меняет запущенный рабочий стол, Safari и чужой iframe).
- **S8:** `PlatformDefaults.publicDesktopEnabled` (по умолчанию `false`) с `NOTIFY sbx_routes '*'`; сид шаблона `linux-desktop` (`capabilities` с `desktop`, `defaultSize: 4gb`); сид размеров `4gb` (4 vCPU) и `8gb`; вкладка Desktop (§14.1) — делает исполнитель S10; scope `desktop` в форме ключей.
- **S9:** шаг `60-desktop` дополняется §7; `hw.vga` — по спайку W; `sbx-session` получает `Capture`, `Input`, `ClipboardGet/Set` и запускает cua-driver; размер `windows` по умолчанию — `4gb` с 4 vCPU.
- **S11:** инструменты §14.4.
- **S12:** coturn (Deployment `hostNetwork` на ноде с меткой или UDP LB, Secret `static-auth-secret`, сертификат `turn.<domain>`, DNS), конфиг `SBX_TURN_URLS` и `SBX_TURN_SECRET_FILE` для `worker`, тревога по квоте TURN; IP TURN в IPSet `sbx-turn`.

## 22. Раскладка кода

```
proto/sbx/agent/v1/desktop.proto        Desktop service (§11.1)
proto/sbx/session/v1/session.proto      agent <-> sbx-session (S9 §13 + Capture, Input, Clipboard)
services/guest-agent/
  internal/desktop/                     Desktop service, streamer supervisor, pairing, TURN config
  internal/session/                     session socket server, shared by Linux and Windows
  cmd/sbx-session/                      helper: *_linux.go (X11), *_windows.go (Win32)
infra/templates/linux-desktop/          recipe, versions.toml, steps/60-desktop.sh, files/
infra/templates/_windows/steps/60-desktop.ps1   S10 additions (§7)
services/gateway/internal/desktopauth/  tickets, open redirect, header, Origin check
apps/api/src/routes/desktop.ts          public routes (§13.2); internal routes (§13.3)
packages/core/                          desktop methods, TURN credential issuing, controller desktop-turn
db/migrations/04xx_*.sql                §13.5
infra/turn/                             coturn config template (manifests: S12)
apps/web/                               Desktop tab
apps/cli/                               sbx desktop
```

Структура пакетов внутри — **[исполнитель]**.

## 23. Версии

Правило проекта: последние стабильные версии, перепроверить перед реализацией. Sunshine, moonlight-web, coturn и cua-driver перепроверены 2026-10-31 через GitHub Releases API; Chrome наследуется из актуальных pins S5.

| Компонент | Версия | Примечание |
|---|---|---|
| Sunshine | v2026.914.233613 | последний стабильный; новее только prerelease. Deb `+ubuntu26.04`, MSI для Windows |
| moonlight-web (`MrCreativ3001/moonlight-web-stream`) | v3.0.1 | linux-gnu и windows-gnu архивы |
| coturn | 4.18.0 | та же, что в S4 §18 |
| cua-driver (`trycua/cua`, тег `cua-driver-rs-v*`) | 0.38.0 | все релизы помечены prerelease; закрепляем последний не-nightly |
| Google Chrome stable (Linux) | 156.0.8078.79-1 | наследуется из Linux versions.toml; закрепляется в `versions.toml` при сборке |
| Go-модули | `github.com/jezek/xgb` и `golang.org/x/image` — последние на момент реализации | проверить `go list -m -versions` |
| Для сравнения (§4.1) | KasmVNC 1.5.2, Selkies 2.1.0, noVNC 1.7.0, Guacamole 1.6.0, neko 3.2.0, TigerVNC 1.16.2, x11vnc 0.9.17 | не используются |

## 24. Результаты

Состояние 2026-10-31: `qm list` показывает работающую Windows-сборку S9 в VM 598 (4096 MiB). S10 не запускал VM, не менял firewall, шаблоны и CT 590. Сборки desktop и измерений пока нет. SSH по IP использует сохранённый host key через alias из `infra/dev-cp/README.md`.

Метаданные upstream (GitHub asset digest, не результат локального скачивания/проверки бинарника):

| Артефакт | SHA256 |
|---|---|
| [Sunshine ubuntu26.04 amd64](https://github.com/LizardByte/Sunshine/releases/tag/v2026.914.233613) `sunshine_2026.914.233613-1+ubuntu26.04_amd64.deb` | `b8a8ceeeb2b3f30a18a994ad268c94e0c91170f33a864c7aad31eed927ad7d47` |
| [moonlight-web linux x86_64](https://github.com/MrCreativ3001/moonlight-web-stream/releases/tag/v3.0.1) `moonlight-web-x86_64-unknown-linux-gnu.tar.gz` | `a46acb1f663faaff9cd97abd9671fe049dd525bfe955e95f7b9f753cc2b99f1a` |
| [cua-driver linux x86_64 binary](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.38.0) `cua-driver-rs-0.38.0-linux-x86_64-binary.tar.gz` | `31ab9709dd91ce73677e49b9f3e75c6f0d3e4d9625c286c9e58262bfbea698dd` |

cua-driver 0.38.0 — последний versioned release в просмотренной ленте (nightly исключены); GitHub помечает его prerelease, как уже предусмотрено §23. Перед сборкой нужны download/hash и Sigstore verification. Проверка coturn: latest tag `docker/4.18.0-r0`.

Заполняется при реализации: цифры спайков L и W (CPU, RAM, задержки, время старта стримера, claim-to-ready), выбранный видеоадаптер Windows, время холодного create `linux-desktop` (пула нет), поведение второго зрителя, способ определения активного потока.

## 25. Оставлено исполнителю

- Структура пакетов и интерфейсов в агенте, helper-е, gateway и `api`.
- Реализация ввода на X11 (своя перепривязка keycode или `xdotool` из helper-а) и захвата на Windows (`BitBlt` или DXGI).
- Точные вызовы API moonlight-web и Sunshine для pairing; способ определения активного потока.
- Замена LightDM своим unit-ом, если проверки §6.6 проходят.
- Как сборщик сливает `extends`.
- Точные ключи `turnserver.conf` (по документации 4.18) и квоты TURN по замерам.
- Значения таймаутов (старт стримера 20 s, остановка через 15 min, ожидание `Act` 10 s) по результатам тестов.

## 26. Решения master и открытые вопросы

Ревью master-сессии 2026-10-29: спека одобрена, решения [S10] приняты.

1. **Лицензии GPL-3.0** (Sunshine, moonlight-web) — **принято Ильёй** (2026-10-29). Условия: неизменённые бинарники upstream, ссылки на исходники в манифесте сборки, использование только внутри компании, без распространения третьим лицам. Guacamole (§4.1, §17) остаётся только описанием альтернативы.
2. **Политика доступа к рабочему столу — решено master** (2026-10-29): отдельный scope `desktop`; `sso` пускает только участников команды sandbox и операторов; `public` есть, но выключен глобально по умолчанию (`publicDesktopEnabled = false`) и включается оператором (§10.2, §13.1, §16).
3. **Граница фаз — решено master:** примитивы computer-use входят в MVP. Правку `docs/roadmap-phase2.md` (§2.9 D6, §4 S29, §5.2 инструменты `computer_*` → S11) вносит master.
4. **Сверка с моделью аутентификации Keycloak** (S7 §7, внесена параллельно со S10) — задача треда реализации:
   - человек приходит с Keycloak JWT, у которого нет scope; scope `desktop` проверяется только у командных ключей `sbx_`;
   - билет, выпущенный по JWT, привязан к пользователю, а не к `desktop_tickets.api_key_id`;
   - отзыв по деактивации пользователя идёт через путь S8 §20.1;
   - код ошибки для `public` при выключенном `publicDesktopEnabled` один: в §13 и в проверках §22 сейчас написано по-разному (`forbidden` и `route_blocked`).

5. **MVP без пулов — решение Ильи 2026-10-31:** warm и hibernated pools исключены, включая Linux spike L; цель claim ≤15 s снята. Cold create: Linux до ~1 min, Windows до 5 min. Обычный stop/resume сохраняется.
6. **Сеть — решение Ильи 2026-10-31:** продукт не привязан к Tailscale, dev-адреса только в `infra/dev-cp/`; cloudflared/ngrok/trycloudflare и внешние relay-сервисы запрещены. TURN собственный, self-hosted в compose.
7. **Template slots — решение Ильи 2026-10-31:** `linux-desktop` только `[595, 596]`, диапазон dev-infra 590–596; CT 590 остаётся. 597, 598, 599 не менять. Sandbox VMIDs 500–589; перед стартом проверять S9 и общий RAM ≤8 GB.

### S10 code pass 2026-10-31 (before pve spike)

Agent/worker/gateway/API/TS+Python SDK/CLI/MCP реализованы и проверены на fakes. Linux и Windows factories теперь подключают реальные Session/Streamer adapters; PendingStreamer остаётся только для unsupported OS и явно не подключённых тестовых adapters. Реализованы secrets gate, OS helper bindings, private upstream state, pairing, process lifecycle и observed viewers. Live acceptance на pve ещё не выполнялся. Windows требует rebase на S9 (без merge в этом проходе), затем проверки на настоящей Win11.

The linux-desktop recipe now inherits Linux pins, adds pinned cosign3.1.4 for cua signature verification, and installs upstream-generated moonlight config. The release archive contains `package/web-server`; extraction strips `package/`. Sunshine/moonlight services are manual; config templates contain no credentials. Audio starts disabled pending the best-effort spike (§8.5). `linux-desktop` verification combines Linux baseline and desktop image checks; full screen/input/stream acceptance runs after real claim through `infra/dev-cp/e2e-desktop.sh`. No template build/version or latency result has been claimed yet.

### Adapter implementation choices (source-backed, 2026-10-31)

`sbx-session` is implemented as the `session --socket` subcommand of the signed
agent binary. This keeps helper and agent versions together across updates.
Its local transport is bounded HTTP/JSON over an ACL-protected AF_UNIX socket,
not a second public API; this replaces the proposed custom protobuf framing.
Linux uses X11/XTEST/XFixes directly (no xdotool/scrot dependency for API calls),
including Unicode keymap input and INCR clipboard transfers. systemd owns restarts.

Sunshine source at v2026.914.233613 has no REST session-count endpoint.
`/api/clients/list` lists paired certificates only. RTSP TCP requests are short-lived.
Observed ENet CLIENT CONNECTED/DISCONNECTED log transitions are the primary count;
ASSURED UDP47999 conntrack flows are the fallback (conservative until flow expiry).
A failed observation never clears a previously active count. The agent also observes
already-running streamers after its own restart. Empty/no streamer is zero activity.

Sunshine password bootstrap uses POST/api/password and exact on-disk TLS certificate
pinning; pairing uses GET/api/pin and POST/api/pin with pairing_id. Moonlight v3.0.1
returns streamed NDJSON Pin then Paired. The proxy user sbx is a pre-created ordinary
User, cannot add hosts; only the generated private administrator manages pairing.
Source-derived wire fixtures are committed under internal/desktop/testdata/upstream;
they are not live pve recordings.

Windows implementation is based on local S9 d38ec62 (remote s9-impl was not yet
published). Its autologon/user creation stays in S9. S10 registers session and
cua-driver tasks after secrets/account readiness. Helper is the signed agent's
session subcommand; GDI, SendInput and clipboard operate in that user's console.
The upstream SunshineService owns Sunshine's console process. Moonlight runs in
an SCM wrapper under NT SERVICE\\sbx-moonlight-web. Installer overlay adds65-streamer;
Windows artifact pins are in windows/files/desktop-pins.json until the typed S9/S10
manifest integration. No Windows VM or slot598 is touched by this code-only pass.
Cua v0.38.0 defaults to stdio MCP; service/task explicitly launches serve.

Linux Sunshine запускается system unit `sbx-sunshine.service` с `User=user` и явным
session environment; upstream user unit выключен. Это упрощает один controller
для root agent без DBus вызовов в user manager. Оба Linux streamer unit имеют
TimeoutStopSec3. Revoke отменяет ещё и незавершённые Open/pairing requests,
чтобы disconnect не ждал30s HTTP handshake. Windows Cua task запускает serve
через hidden wrapper; PowerShell7.6.9 закреплён в mise, как в S9. Windows POSIX
file modes синтетические: private access обеспечивается DACL и проверяется live.

S8 integration (2026-10-31): Desktop tab uses real SDK, fresh single-use tickets outside query cache, retry2s on desktop_not_ready, iframe/fullscreen/new-tab/access/disconnect/resume. Payload migration adds publicDesktopEnabled=false + route invalidation and desktop4gb/8gb seeds. Runtime desktop migrations moved to0401/0402 after S8 environments0400. Linux verify stops source clone before booting fork (one4GiB VM). Master permits S9≤4GiB + S10≤4GiB; total≤8GiB.
