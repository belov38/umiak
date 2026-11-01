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
- Sunshine и moonlight-web ставятся из upstream-релизов без изменений. Исключение S10: pinned coturn с минимальным патчем повторной проверки REST credentials на Refresh (обоснование и RED→GREEN ниже).

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
    "first_login_create_admin": false,
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
- пароль администратора moonlight-web и пароль пользователя `sbx` — отдельные случайные секреты, не пароль Sunshine (s10-fix; в состоянии, записанном до разделения, остаётся общий пароль до следующей смены идентичности);
- идентификаторы `hostId` и `appId` после pairing.

Администратор moonlight-web создаётся до первого старта сервиса: агент кладёт в `data.json` хранилище формата v3 upstream (роль `Admin` и один пользователь, PBKDF2-HMAC-SHA256, 600 000 итераций, как `src/app/password.rs` v3.0.1), а `first_login_create_admin = false`. Первый `/api/login` больше не создаёт администратора, гонки с другим клиентом нет (s10-fix).

Агент генерирует их сам и проводит pairing при первом запуске стримера после смены идентичности (S3 §7, S9 §11):
1. Задать креды Sunshine, записать хранилище moonlight-web с администратором, запустить Sunshine и moonlight-web.
2. Через HTTP API moonlight-web (как администратор): создать роль `viewer` и пользователя `sbx` с этой ролью, добавить хост `localhost`, начать pairing и получить PIN.
3. Передать PIN в Sunshine через API веб-UI: `POST https://127.0.0.1:47990/api/pin` с basic auth, CSRF-токеном и `pairing_id`, как требует текущая версия.
4. Прочитать `hostId` и `appId` приложения `Desktop`.

Права роли `viewer`: `allow_add_hosts = false`; только H.264; без HDR; `maximum_bitrate_kbps = 20000`; оба транспорта разрешены.

Смена идентичности стирает это состояние, а также `sunshine_state.json` и данные moonlight-web: fork и VM из snapshot не уносят креды стримера источника. Pairing выполняется лениво при первом открытии для каждой новой идентичности, включая create и fork (несколько секунд).

Точные вызовы API moonlight-web v3 и Sunshine фиксирует спайк L **[исполнитель]**.

### 8.4 Запуск по требованию

- Стример не работает, пока рабочий стол не открывают. Скриншот и ввод через API идут мимо него.
- `Desktop/Open` (§11.1) запускает Sunshine и moonlight-web, если они не запущены, ждёт готовности (до 20 s) и возвращает `{hostId, appId}`.
- Агент останавливает стример через 15 min без активного потока [S10]. Так он не тратит CPU и RAM. Отсчёт — от последнего `Open` или последнего замеченного зрителя; цикл рабочего стола агента (раз в секунду) делает `StopStreamer` один раз за период простоя, следующий `Open` запускает стример заново. Остановка идемпотентна, поэтому работает и для стримера, который пережил перезапуск агента (s10-fix).
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

### 8.6 Патч moonlight-web на Windows (s10-followups, W1-B)

**Ошибка.** В Sunshine (v2026.914.233613 и текущий master) `recvThread` принимает ping видео- и аудиосокета в один общий `udp::endpoint peer`. На Windows (IOCP) ядро пишет адрес отправителя прямо в этот буфер при завершении приёма, поэтому если video ping и audio ping завершились раньше, чем отработал первый обработчик, оба ping приписываются одному порту. Если это порт аудиосокета moonlight-web, Sunshine шлёт всё видео в аудиосокет: moonlight-web не получает ни одного видеопакета, `moonlight_common::stream::proto::video` раз в секунду просит IDR (`requesting idr and unsyncing depayloader`, `IDR_REQUEST_TIMEOUT` 1 s), браузер видит «Connection Complete» и чёрный кадр. Ping совпадают по времени всегда: moonlight-common-rust начинает опрашивать драйверы audio/video только после подключения control stream, и первые ping обоих потоков уходят разом — ровно когда Sunshine регистрирует сессию. Исход решает гонка; на загруженной VM чаще.

Доказательство (`infra/dev-cp/desktop-media-probe.ts`, Sunshine `min_log_level = verbose`): в чёрной попытке `Received ping [v2] from 127.0.0.1:57337` дважды, хотя video ping шёл с 57338 (`Recv: 127.0.0.1:57338 :: VIDEO`); Sunshine кодирует и отправляет кадры (`Sent Frame`), в логе moonlight-web нет `received first video packet`, в браузере 0 видеосообщений WebSocket и 0 вызовов `VideoDecoder.decode`. Linux этой ошибки в прогонах не показал.

**Исправление.** Шаблон `windows-desktop` ставит `web-server.exe`, собранный из того же релиза moonlight-web v3.0.1 с патчем `infra/templates/windows-desktop/moonlight-web/ping-order.patch` к закреплённому moonlight-common-rust: аудиопоток (и его ping) не опрашивается, пока видеопоток не получил первый пакет (Sunshine уже записал адрес видео), но не дольше 3 s (тайм-аут ping Sunshine — 10 s). Аудио в потоке выключено (`stream_audio = disabled`), поэтому ошибочный адрес аудио безвреден. Сборка — `moonlight-web/build.sh` (Docker, `rust:1.99.0-trixie` + mingw-w64, без PE-метки времени); выход `files/moonlight-web/{web-server.exe,build.json}` не хранится в git. Установщик заменяет сервер из закреплённого zip и проверяет SHA256 из `build.json`; веб-ресурсы остаются из zip. Verify: `desktop_moonlight_patch`. Linux остаётся на upstream-сборке. Исправление в Sunshine (отдельный `endpoint` на сокет) — кандидат в upstream, после него патч снимается.

Диагностика (s10-followups): служба `sbx-moonlight-web` сохраняет лог прошлого запуска как `web-server.log.1` (`EndStreams` перезапускает её); `e2e-desktop.ts` при сбое потока до `EndStreams` снимает лог moonlight-web, лог Sunshine, скриншот через агент и счётчики просмотрщика (видеосообщения и IDR WebSocket, вызовы и ошибки `VideoDecoder`, `inbound-rtp` WebRTC).

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

- **Где.** В Kubernetes рядом с gateway, но не в процессе gateway (S4 §13). TURN работает в **собственном network namespace** (s10-fix2), не на сети хоста: в compose — отдельная bridge-сеть, в Kubernetes — обычный под (не `hostNetwork`). Внутри namespace адрес TURN навешивается на `lo`, поэтому relay ↔ relay остаётся внутри namespace, а наружу публикуются только 3478/udp, 3478/tcp и 443/tcp (DNAT с сохранением адреса клиента: compose `ports`, в Kubernetes — Service `LoadBalancer`/`NodePort` с `externalTrafficPolicy: Local`). Выбор Service — S12, проверка — §20.
- **Имя:** `turn.<domain>` → IP TURN. Сертификат для `turns:` выпускает cert-manager (как `*.sbx`).
- **Порты:** `3478/udp`, `3478/tcp`, TLS на `443/tcp` (у TURN свой IP, поэтому 443 не конфликтует с `gateway-edge`). Порты relay — **61000–65535** (`SBX_TURN_RELAY_MIN/MAX`), выше эфемерного диапазона Linux (`ip_local_port_range` по умолчанию 32768–60999); наружу их не публикуют. В namespace TURN диапазон relay резервируется (`net.ipv4.ip_local_reserved_ports`), а entrypoint отказывается стартовать, если диапазон relay пересекается с `ip_local_port_range` этого namespace.
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

- **Фильтр relay по портам** (s10-fix, s10-fix2). `allowed-peer-ip` coturn задаёт только IP: разрешение на собственный адрес TURN пускает allocation к любому UDP-порту этого адреса. На сети хоста это были бы другие службы хоста (на CT 590 приёмка достучалась Send indication до слушателя `:40123` и tailscaled `:41641`) и любые его сокеты в диапазоне relay — в том числе эфемерные клиентские сокеты (DNS и т. п.), потому что старый диапазон 49152–65535 пересекался с 32768–60999. Защита в три слоя:
  1. **Свой namespace.** Entrypoint добавляет адрес TURN на `lo` своего namespace и отказывается стартовать, если этот адрес уже есть на другом интерфейсе (значит, контейнер запущен на сети хоста). `listening-ip` — адрес интерфейса namespace (куда приходит DNAT), `relay-ip` и `external-ip` — адрес TURN. В namespace нет других процессов с сокетами на адресе TURN, поэтому пиром может быть только relay-сокет этого же coturn. Прежний отказ от своего namespace касался NAT: hairpin-NAT Docker переписывал адрес пира relay ↔ relay. Здесь адрес TURN локален внутри namespace, пакеты relay ↔ relay не выходят из него и NAT не проходят.
  2. **Таблица nftables `inet sbx_turn`** в namespace TURN (hook `output`, `meta skuid` + адрес + порт relay): relay-сокеты coturn (uid `SBX_TURN_UID`) шлют только на relay-порты того же адреса. Entrypoint ставит её от root при каждом старте, потом запускает turnserver под `SBX_TURN_UID` (`setpriv`, остаётся только `NET_BIND_SERVICE`).
  3. **Fail closed.** Entrypoint остаётся init-процессом контейнера и каждые `SBX_TURN_GUARD_INTERVAL` (2 s) сравнивает `nft -s list table inet sbx_turn` с тем, что поставил. Если таблицы нет или она изменилась (например, root в контейнере через `docker exec`), init завершается, ядро убивает turnserver вместе с namespace PID, политика `restart` поднимает контейнер с новой таблицей. Healthcheck compose (`entrypoint.sh health`) делает ту же проверку; обе проверяют и адрес TURN на `lo` (ниже). Перезагрузка nftables на хосте (`flush ruleset`) таблицу в namespace TURN не трогает.

  **Посылка на запрещённый порт убивает свою allocation** (ожидаемо, s10-followups). Пакет relay-сокета на порт вне диапазона relay отбрасывает правило `drop` таблицы `inet sbx_turn` в hook `output`, и `sendto` в coturn получает `EPERM`. coturn считает это ошибкой сокета и закрывает allocation: следующий `Refresh` получает `437 Allocation Mismatch`. Это самоотказ отправителя — пострадавшая allocation принадлежит тому, кто послал запрещённый пакет (его кредам и его 5-tuple); чужие allocations, relay ↔ relay и сам coturn продолжают работать. Обычный WebRTC такие пакеты не шлёт: `CreatePermission` разрешает только адрес TURN, а кандидаты другой стороны — relay-порты. Чинить не нужно: отказ закрытый, а клиент, который пробует запрещённые порты, теряет только свою allocation.
  **Адрес TURN на `lo`** тоже под надзором (s10-followups): init и healthcheck проверяют, что `SBX_TURN_IP/32` остаётся на `lo` namespace. Без него новые allocations получают `508 Insufficient Capacity`, а relay ↔ relay не работает; раньше healthcheck при этом оставался `healthy`. Теперь init завершается, и контейнер перезапускается с адресом.

  **Требование к продакшену (S12):** TURN — под со своим network namespace (не `hostNetwork`), адрес TURN на `lo` пода, `NET_ADMIN` только у entrypoint (turnserver — под отдельным uid), диапазон relay выше `ip_local_port_range` и в `ip_local_reserved_ports` пода (обе sysctl в Kubernetes namespaced и разрешены как safe), публикуются только 3478 и 443 с сохранением адреса клиента. Liveness — та же проверка `entrypoint.sh health`. Если хостовый firewall перезагружается с `flush ruleset`, он не должен удалять NAT-правила публикации (иначе TURN недоступен, но не открыт). `no-software-attribute` и `no-cli` включены.
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

- **Кэш `Sbx-Request-Id` и полезная нагрузка** (s10-fix). Исход `Act` хранится в кэше запросов агента (`state.db`, до 24 h) без скриншота: повтор с тем же id не повторяет ввод и возвращает сохранённый результат (`completed`, курсор, экран) со **свежим** скриншотом, если он был запрошен (`Screenshot` без побочных эффектов). Тело `SetClipboard` в кэше не хранится (только хеш запроса), `Screenshot` и `GetClipboard` не кэшируются. Так скриншоты не попадают в `state.db`, snapshot и fork (§16).
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
- **Ошибка наблюдения** (s10-fix). Неудачная выборка зрителей сохраняет прошлое значение (не меньше 1) не дольше 2 min подряд идущих ошибок; после этого агент считает `desktopStreams = 0`. Иначе сломанный источник держал бы sandbox занятой и idle-stop не срабатывал бы никогда. Успешная выборка сбрасывает окно.
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
- **Windows: заблокированный ввод** (s10-fix). `SendInput` возвращает 0 вставленных событий, пока входной рабочий стол не `Default` (переход входа в систему на свежем fork, защищённый рабочий стол). Helper повторяет только невставленные события каждые 50 ms до 2 s; затем `action_failed` с именем входного рабочего стола в сообщении. Ни одно нажатие не отправляется дважды.
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
- **Блокировка оператором** (S8 C3, s10-fix): `POST /links`, `PUT /access`, `POST /actions`, `PUT /clipboard` на заблокированной sandbox → `403 forbidden` с `details.reason: "sandbox_blocked"`, как `exec` (оператор проходит). Чтение (`GET /desktop`, `GET /screenshot`, `GET /clipboard`) разрешено, как чтение файлов; `DELETE /streams` разрешён (только отключает). Сама блокировка шлёт `NOTIFY sbx_identity 'sandboxes:<id>'`; монитор доступа `api` по нему (и раз в 5 s) поднимает `authEpoch`, вызывает `EndStreams` и отмечает `policy_revoked`, поэтому выданные билеты и cookie перестают действовать, а маршрут gateway получает `blocked`. Снятие блокировки снова поднимает `authEpoch` (s10-fix2): билет, выданный в те миллисекунды, пока ставилась блокировка, мог получить эпоху блокировки и иначе ожил бы после разблокировки.
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

Схема `runtime`, миграции S10 в `db/migrations/`: **0401–0405** внутри блока S8 `0400–0499` по решению master (0400 занята S8 environments); следующий свободный номер блока — 0406 (`docs/roadmap.md`):

```
sandbox_desktops(
  sandbox_id uuid pk,             -- runtime.sandboxes
  access text,                    -- token | sso | public
  auth_epoch int,
  turn_issued_at timestamptz null,
  turn_attempted_at timestamptz null, -- last renewal attempt (0405): failed guests go to the back
  pending_disconnect bool, policy_revoked bool,
  updated_at timestamptz)

desktop_tickets(
  ticket_hash bytea pk,           -- sha256 of the 32-byte ticket
  sandbox_id uuid, label text, user_id text, api_key_id text null,
  auth_epoch int,
  expires_at timestamptz,         -- now() + 10 min
  used_at timestamptz null, created_at timestamptz)
```

Блокировка — только `runtime.sandboxes.blocked` (S8): колонки `sandbox_desktops.blocked/block_reason` никто не писал, `0404_desktop_drop_block.sql` их удаляет (s10-fix). Триггер на `sandbox_desktops` шлёт `NOTIFY sbx_routes '<slug>'`. Cleanup S6 удаляет билеты старше суток. Изменения `packages/core` (`SandboxService`: `desktopLink`, `setDesktopAccess`, `endDesktopStreams`, шаг `authEpoch+1` в stop, шаг TURN в claim и provision) вносит исполнитель S10, согласуя с треком S6, как S7 (S7 §20.2).

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
| `sbx desktop [open] <id> [--fps 60] [--bitrate N] [--transport websocket] [--print]` | открыть ссылку в браузере (`--print` — только вывести) |
| `sbx desktop screenshot <id> [-o file.png] [--max-width N] [--max-height N] [--jpeg] [--quality N]` | скриншот в файл или stdout |
| `sbx desktop act <id> [--file <path\|->]` | список действий из JSON; плюс короткие формы `click X Y`, `type TEXT`, `key ctrl+c`, `scroll DY` |
| `sbx desktop clipboard <id> [get\|set TEXT]` | буфер |
| `sbx desktop access <id> token\|sso\|public` | режим доступа |
| `sbx desktop end-streams <id>` | `DELETE /desktop/streams` |

Реализация s10-fix: вход действий — `--file <path|->` (`-f`), а не `--json`, потому что глобальный `--json` CLI — формат вывода (S7 §14.3) и перехватывает флаг подкоманды. `end-streams` добавлен для `DELETE /desktop/streams`. Команды первого прохода `sbx screenshot|input|clipboard` и опции `sbx desktop --access/--end-streams` оставлены скрытыми синонимами.

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
Linux counts recent ASSURED UDP 47999 (ENet control) conntrack flows as the primary
activity signal: the remaining TTL must be within 5 s of the guest's actual
`nf_conntrack_udp_timeout_stream`. Extended ipv4/ipv6 records are parsed by transport
token. Sunshine ENet CONNECTED/DISCONNECTED log transitions are a conservative fallback,
because a forced session end does not log DISCONNECT.
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

### Live Linux verification, 2026-10-31 (S10 after S8 merge)

- `linux-desktop 20261031.3`, slot596; agent0.1.0+20261031.ebe5ea8. Build704s,7.8GiB thin used. Slot595 previous failed verification build retired/deleted. Upstream pins unchanged (§24).
- `verify: linux-desktop`:109 checks,0FAIL; KVM available; first QGA9.606s, hardrestart9.441s. Sequential fork uses one4GiB VM; all clones/snapshot removed.
- Direct-agent live probe: cold clone+boot toQGA11.286s, claim→desktopready2.097s;1920x1080 screenshot, mouse/Unicode keyboard proof + pixel diff, clipboardUnicode/emoji, actual Sunshine/Moon pairing, stopstreamer; fork fresh streamercredentials and stop/resume verified. Resume desktopready1.057s. These are NOT public API create or gateway media timings.
- S8 Desktop tab implemented; Payload publicDesktopEnabled=false with route invalidation, catalog sizes4gb/8gb and verified build seeded. Worker waits actual desktop readiness on the same boot afterConfigure before create/resume finish.
- Migration0403 tracks policy revocation transition. Direct media is ended for blocked/public-disabled routes. Used grants of current ready epoch remain retained/rechecked beyond12h and1day until stop/revoke changes epoch; cleanup then removes them. Public views without ticket are covered by route monitor.
- Linux live acceptance passed on build 20261031.6 / VM 596; see "Linux live acceptance — 2026-11-01" below.

Dev TURN decision (master, 2026-11-01): CT 590 shares its address with the gateway.
Dev listener ports, TLS hostname and a narrow UDP relay range are configured only under
`infra/dev-cp`. The TLS leaf comes from the existing dev CA, with a hostname in its
permitted DNS namespace. A dedicated address with TLS 443, or SNI multiplexing, is a
production follow-up, not an MVP blocker. CT 590 RAM stays at most 6144 MiB.


Coturn Refresh policy (implementation, 2026-11-01): upstream4.18.0 intentionally
caches the password for an established allocation ([upstream REST documentation](https://github.com/coturn/coturn/blob/23c6c1d32a3d2b21a56cee65d3203bcc4ea82d2b/README.turnserver)). To satisfy expiry-on-Refresh, compose builds the same pinned source with
`deploy/compose/turn/refresh-auth.patch`: clear the cached key on the first Refresh
pass and use the existing async credential callback; preserve it on the resumed
pass. Source commit/archive SHA256 and patch are pinned in Dockerfile; no new auth
algorithm. Live wire regression: original expired Refresh succeeds (RED), patched
image rejects it while valid Refresh and UDP/TCP/TLS allocation succeed (GREEN).
This intentionally tightens upstream's session policy; API and TURN credential
format/TTL remain unchanged.


Совместимость TURN channels (live, 2026-11-01): pinned rtc-turn0.21.1 из
moonlight-web3.0.1 удаляет binding при438 и создаёт новый channel number для того же
peer; coturn закономерно отвечает400. Подтверждено live-обрывом через10min и
изолированным wire fixture с nonceTTL2s (тот же400 за3s). Для этой версии выбран
стандартный `stale-nonce=0`. Повторная HMAC/REST timestamp проверка каждого Refresh
сохраняется патчем; это не отключает срок credentials. Ротацию nonce можно вернуть
после обновления исправленного upstream rtc-turn и повторной long-idle приёмки.


TURN reconnect sizing (live, 2026-11-01): штатные browser ICE allocations и остатки
предыдущего Moon peer при reconnect исчерпывали исходную user-quota4 (486; relay
candidate на VM отсутствовал). Wire fixture с6 одновременными allocations того же
REST principal воспроизводит486. По измерению выбраны user-quota16 и
max-allocate-lifetime60s: закрытые UDP allocations освобождаются не позже1min,
действующие обновляются каждые~30s. rtc-turn0.21.1 соблюдает выданный LIFETIME.
Проверены6 allocations, LIFETIME≤60, valid/expired Refresh, peer403 и UDP/TCP/TLS.
Квота400 и per-session bandwidth остаются; peer allowlist не расширялся.


### Linux live acceptance — 2026-11-01

Immutable `linux-desktop 20261031.6`, VM 596, agent `0.1.0+20261031.4865e13`.

- Clean recipe build 676 s, 7.8 GiB; `verify: linux-desktop` 109 checks, 0 FAIL;
  first QGA 9.9 s, hard-restart QGA 12.3 s.
- Public cold create (API to `running` with desktop ready): 18.4 s and 14.4 s on two runs.
- All MCP `computer_*` tools and `desktop_url` work against the real API; the
  "desktop unsupported" fallback is not used when the capability is advertised.
- PNG screenshot with cursor, Unicode keyboard proof, clipboard round-trip, WebSocket
  media and forced relay-to-relay WebRTC over UDP, TCP and TLS TURN: changed frames.
- 30 min hold with an open viewer and no API calls: 176 samples, `desktopStreams >= 1`,
  all other activity counters 0, last API call 1830 s ago; frames still change after the hold.
- Idle-stop with `idle_timeout = 60 s`: stopped 78.1 s after an explicit end-streams,
  98.8 s after a natural page close without EndStreams.
- Fork gets fresh streamer credentials; stop/resume with screenshot; old desktop
  cookie returns 401 after resume; delete cleans up clones and snapshots.
- After the runs only VM 596 remains in the S10 slots; 595 and all clones are removed.

The S8 Desktop tab and S11 API contract are unchanged by the live fixes.
Open: Windows desktop (§8) after S9; production TURN on TLS 443 (dedicated address or
SNI). Audio stays disabled; performance, glass-to-glass latency and multi-viewer
behaviour are not characterised by this acceptance.


### Windows desktop — решения реализации (2026-11-01, после merge S9)

- **Отдельный шаблон `windows-desktop`** (`extends: windows`, слот **595**), решение master
  2026-11-01. Шаблон `windows` (598) остаётся headless и не меняется; §7 «S10 добавляет в
  `60-desktop`» заменено отдельным шагом `65-streamer` дочернего рецепта (общие шаги
  `_windows` без изменений). `linux-desktop` теперь занимает один слот **596**; как у
  `windows`, пересборка одного слота требует сначала вывести старый шаблон.
- **`agent.toml`** desktop-рецепта рендерит `sbx-tpl` (`isDesktopRecipe`): `[desktop] enabled`,
  фаза `desktop` в `[readiness] required`, порты стримера в `[ports] exclude`. Установщик
  `desktop-install.ps1` больше не правит `agent.toml` регулярными выражениями.
- **Пины Windows-артефактов** (Sunshine MSI, moonlight-web zip, cua-driver zip, cosign) — в
  `windows-desktop/files/desktop-pins.json` с sha256; cua-driver дополнительно проверяется
  `cosign verify-blob`. Перенос в типизированный `versions.toml [desktop]` для Windows — follow-up.
- **Edge**: политики `HideFirstRunExperience`, `BrowserSignin=0`, `SyncDisabled`,
  `DefaultBrowserSettingEnabled=0`, без промо и рекомендаций.
- **Verify `windows-desktop`**: базовый `windows/verify.ps1` целиком плюс группа `desktop`
  (файлы стримеров, службы Manual/Stopped и учётная запись `NT SERVICE\sbx-moonlight-web`,
  шаблон moonlight-web на loopback без STUN, `agent.toml`, нет слушателей стримера до Open,
  политики Edge). Группа вставляется перед `# --- main ---` и регистрируется через
  `$SbxExtraGroups`; в `windows/verify.ps1` добавлен только этот хук.
- **Activity на Windows**: conntrack нет, а лог Sunshine не пишет DISCONNECT при
  принудительном завершении. Основной признак — UDP-сокеты процесса moonlight-web
  (`web-server.exe`, `GetExtendedUdpTable` с владельцем): ENet-канал к Sunshine есть у каждого
  потока при любом транспорте браузера, без потока у moonlight-web UDP-сокетов нет. Число
  потоков не определяется, агент сообщает `desktopStreams = 1` при наличии сокетов.
  Ошибка выборки — запасной путь через лог Sunshine (консервативно).
- **Сессия**: `register-session.ps1` регистрирует задачи `\sbx\session` и `\sbx\cua-driver`
  (Interactive, `user`, триггер AtLogOn) при каждом старте агента; запуск сразу — только если
  `user` уже вошёл, иначе их запускает триггер автологона.
- **Видео (спайк W, §19.2)**: `hw.vga: std` (Microsoft Basic Display Adapter), без смены
  адаптера. Его режим задаёт GOP OVMF, по умолчанию 1280×800, а `ChangeDisplaySettingsEx`
  его не меняет. Шаг `65-streamer` пишет NVRAM-переменную OVMF `PlatformConfig`
  (GUID `7235c51c-…`, 1920×1080) в efidisk сборочной VM; efidisk копируется в шаблон и клоны,
  поэтому каждая загрузка сразу идёт в 1920×1080. Проверено на клоне: Basic Display Adapter
  1920×1080, скриншот API 1920×1080, захват Sunshine `ddx` идёт. `vga: virtio` + `viogpudo`
  проверен и отклонён: драйвер берёт тот же режим 1280×800, а смена режима из сессии
  зависала. Verify проверяет `desktop_display` (1920×1080).
- **ACL на Windows**: `icacls <dir> /inheritance:r /grant:r <sid>:(OI)(CI)F /T` оставляет
  файлам внутри пустой DACL (флаги наследования для файлов отбрасываются), и даже SYSTEM
  не может их прочитать. Агент и установщик ставят наследуемые права только на каталог,
  дочерние элементы сбрасываются на наследование (`icacls <child> /reset /T`).
- **Старт стримера на Windows**: Sunshine перед прослушиванием тестирует энкодеры, первый
  `Open` занимает ~16–20 s; gateway в это время отвечает retryable `503 desktop_starting`,
  вкладка Desktop и `e2e-desktop.ts` повторяют со свежим билетом через 2 s.
- Лог moonlight-web на Windows: `state\desktop-moonlight\web-server.log` (текущий запуск) и `web-server.log.1` (предыдущий, s10-followups).

### Windows live acceptance — 2026-11-01

`windows-desktop 20261101.1`, VM 595, agent `0.1.0+20261101.a17c0d7b`, `hw.vga: std` +
OVMF `PlatformConfig` 1920×1080.

- Сборка 31.8 min (сборка + первый verify), диск 17.1 GiB. `verify: windows-desktop`:
  110 проверок, 0 FAIL (базовый профиль S9 + группа `desktop`, включая `desktop_display`).
  Первый verify этой сборки прервался потерей QGA на fork сразу после готовности агента
  (перезагрузка переименования S9, R16); повторный `sbx-tpl verify` прошёл полностью.
  В сборке 3 тот же шаг прошёл с первого раза.
- Публичный холодный create до `ready` с фазой `desktop`: 139 s и 146 s (лимит 5 min).
  Первое открытие стримера: 22 s (тест энкодеров Sunshine), повторные — < 1 s.
- Скриншот 1920×1080, ввод мышью и клавиатурой меняет кадр, Unicode (`S10 экран 世界`) через
  `KEYEVENTF_UNICODE` в окне «Выполнить» доходит до pwsh, буфер обмена туда и обратно.
- Все MCP `computer_*` и `desktop_url` против настоящего API.
- Стрим через gateway CT 590: WebSocket и relay↔relay WebRTC через TURN по UDP, TCP и TLS,
  меняющиеся кадры, ещё раз после удержания.
- Удержание зрителя 3 min без вызовов API: `desktopStreams = 1` весь интервал (UDP-сокеты
  moonlight-web), sandbox не остановлен. После естественного закрытия страницы idle-stop
  (`idle_timeout = 60 s`) через 105 s.
- Fork получает новые креды стримера; stop/resume — desktop ready; старая cookie — 401;
  удаление чистит всё. VM гостя ходит к TURN только по UDP 3478, TCP/TLS закрыты.
- Регрессия Linux тем же сценарием после правок e2e: зелёная, create 17.9 s.

Не заявлено для Windows: 30-минутное удержание (проверено 3 min; на Linux — 30 min),
производительность и задержка, несколько зрителей, звук.

### Windows desktop после правила fork/snapshot только из остановленной VM (2026-11-01)

Rebase на `main` `743f112` (S9 §24.8–24.9, S6 §7.8–7.9, миграция `0208`) без конфликтов;
runtime-миграции S10 остаются 0401–0403 и идут после 0208.

- **Fork рабочего стола Windows.** Работающий `windows-desktop` без `forceStop` →
  `409 snapshot_requires_stop` (проверено live). Fork из штатно остановленного источника
  проходит; у fork новые креды стримера, скриншот 1920×1080, все MCP `computer_*` работают
  на fork. `forceStop` переиспользует `stopSteps` worker-а, поэтому `authEpoch` растёт и
  ссылки зрителей источника отзываются; перезапуск источника идёт через `deliverProvision`
  с `Desktop/Configure` и ожиданием фазы `desktop`. Live-прогон `forceStop` для десктопа
  не делался: источник и fork одновременно — 8 GB при бюджете S10 4 GB; общий путь
  проверен S9 на шаблоне 598.
- **Размер рабочего стола после перезагрузки.** Live-проверка нашла, что на 20261101.1
  только первая загрузка клона давала 1920×1080, а resume и fork — сохранённые Windows
  1280×800, растянутые на режим 1920×1080 (`GraphicsDrivers\Configuration`, сохранено
  при сборке до записи `PlatformConfig`). `65-streamer` теперь очищает `Configuration` и
  `Connectivity`; следующие загрузки сборки сохраняют 1920×1080. Verify проверяет и
  сохранённый размер, e2e — скриншот после resume и на fork.
- **Сборка `windows-desktop 20261101.2`**, VM 595, агент `0.1.0+20261101.cbddbf59`:
  38 min со всем verify, 16.5 GiB, verify 110 проверок, 0 FAIL. Live на CT 590: create
  198 s, первое открытие стрима 22 s, WebSocket и relay UDP/TCP/TLS, fork-правило,
  `computer_*` на fork, resume 1920×1080, отзыв cookie, удаление — PASS.
- Наблюдение: один раз на 20261101.1 штатный stop сразу после create не уложился в 300 s
  (hard stop, `clean_stop = false`, затем fork → `snapshot_requires_clean_stop`). На
  20261101.2 тот же сценарий — clean за 39 s, повторить не удалось. Если повторится —
  `forceStop` после resume или повторный stop (сообщение API это подсказывает).

### Приёмочные правки s10-fix (2026-11-01)

Независимая приёмка master нашла 12 замечаний; правила записаны в разделах выше (помечены s10-fix).

- **Блокировка оператором (H1).** Ручки рабочего стола, которые управляют гостем, проверяют блокировку как `exec` (§13.2). Live на CT 590 (`desktop-block-probe.ts`, `windows-desktop`): после блокировки `exec`, `POST /actions`, `PUT /clipboard`, `POST /links`, `PUT /access` → `403 sandbox_blocked`; скриншот разрешён; `authEpoch` 1→2, `EndStreams` выполнен, старая cookie зрителя → 403; после снятия блокировки действия снова работают. MCP `computer_*` показывает ошибку с подсказкой «не повторять».
- **TURN и порты своего адреса (M3).** Таблица `inet sbx_turn` (§9.2). Live `verify-turn.py`: relay↔relay до UDP-, TCP- и TLS-клиента работает; Send indication на `192.168.68.90:40123` и `:41641` не доходит, счётчик drop растёт. Контроль: без таблицы тот же зонд доходит до слушателя `:40123` (`received 14`). turnserver работает от uid 3478 только с `CAP_NET_BIND_SERVICE`.
- **Скриншоты в кэше запросов (M1).** Live (`desktop-cache-probe.ts`, `linux-desktop 20261101.2`): после 22 `Act` со скриншотами 1920×1080 в `state.db`, `-wal`, `-shm` 0 сигнатур PNG; повтор с тем же `Idempotency-Key` возвращает сохранённый результат и свежий скриншот.
- **Контроллер `desktop-turn` (M2).** Ошибка одной sandbox пишется в лог и не прерывает остальные; порядок — старые креды первыми, `id`; партия до 100.
- **Квота при `forceStop` (B3).** Счёт был верным: работающий источник уже учтён один раз, fork добавляет свой размер. С квотой 6144 MB fork 4 GB от источника 4 GB действительно не помещается (оба работают после fork). Сообщение теперь называет занятое, запрошенное и правило `forceStop`: `quota 'maxRamMb' exceeded (4096 MB in use + 4096 MB requested > limit 6144 MB); the source restarts after a forceStop fork…`, `details.requested`. Тест: при квоте 8192 forced fork проходит.
- **Windows SendInput (B2).** Причина по коду: `SendInput` возвращает 0 вставленных событий (`ERROR_ACCESS_DENIED`), пока входной рабочий стол не `Default` — короткий переход входа в систему на свежем fork после переименования S9. Исходная ошибка не воспроизведена; helper теперь повторяет только невставленные события до 2 s (§12.2) и называет входной рабочий стол в ошибке. Три полных Windows `e2e-desktop` подряд на `20261101.3` без `action_failed`.
- **Стример и простой (п. 8–9).** Автоостановка через 15 min без зрителя и окно 2 min для ошибок наблюдения (§8.4, §11.4), unit-тесты с управляемыми часами. Долгая live-проверка 15 min не проводилась.
- **Креды стримера (п. 11).** Раздельные секреты и администратор moonlight-web до первого старта (§8.3); live: pairing и поток на новых сборках проходят (`e2e-desktop`). coturn: `no-software-attribute`, `no-cli`.
- **CLI (п. 10)** — §14.2; **миграции (п. 12)** — `0401–0404` в блоке S8, `docs/roadmap.md`.
- **e2e на Linux fork (B1).** MCP-проверка клавиатуры открывает и фокусирует свой терминал на fork.

Сборки: `linux-desktop 20261101.2` (VM 596, verify 109 проверок, 0 FAIL; первая попытка verify упала на `qmstop` клона по блокировке VM после жёсткого рестарта — verify теперь повторяет остановку через `retryOnVmLock`, как Windows verify), `windows-desktop 20261101.3` (VM 595, verify 110 проверок, 0 FAIL), агент `0.1.0+20261101.fabc0b94`.

Live на CT 590 (`s10-fix`): Linux `e2e-desktop` зелёный целиком — create 17.3 s, первое открытие потока 1.1 s, WebSocket и relay↔relay WebRTC UDP, MCP `computer_*` на источнике и на fork, stop/resume, отзыв cookie. Windows `e2e-desktop` — три прогона подряд зелёные (43 проверки каждый): create 187 s, 153 s, 123 s; первое открытие потока ~22 s.

### Приёмочные правки s10-fix2 (2026-11-01)

Вторая независимая приёмка master приняла H1, M1, M2, B1–B3 и п. 8–12 и нашла S1, S2, W1, N1, N2.

- **S1, S2 — TURN (§9.2).** coturn перенесён в собственный network namespace (compose-сеть `turn`): адрес TURN на `lo` внутри, наружу опубликованы только 3478/udp, 3478/tcp и TLS; на сети хоста entrypoint отказывается стартовать. Порты relay — 61000–65535 (dev 61000–61040), выше `ip_local_port_range`, зарезервированы sysctl в namespace TURN; пересечение — отказ старта. Entrypoint остаётся init и каждые 2 s сравнивает таблицу `inet sbx_turn` с поставленной; при удалении или изменении init выходит, turnserver умирает вместе с namespace PID, compose перезапускает с новой таблицей; healthcheck — та же проверка. На CT 590 `nftables.conf` без `flush ruleset` (`infra/dev-cp/README.md`).
  Live (`verify-turn.py`, `SBX_TURN_PROBE_GUARD=1`): relay↔relay до UDP/TCP/TLS-клиента работает; UDP-слушатели хоста на `192.168.68.90:40123` и `:61039` (внутри диапазона relay) ничего не получают, `:41641` тоже, счётчик drop растёт; после `docker exec … nft delete table inet sbx_turn` relay перестал работать через 0.5 s, восстановился с таблицей через 2.7 s; `systemctl reload nftables` в CT 590 не перезапускает TURN и не ломает публикацию портов. Запрещённые пиры (8.8.8.8, LAN, сеть VM) — 403.
- **N1.** Снятие запрета политики (блокировка, public) тоже поднимает `authEpoch` (§13.2); тест: билет, записанный с эпохой блокировки, после разблокировки не обменивается.
- **N2.** `ctl-desktop-turn` отмечает попытку (`turn_attempted_at`, миграция `0405`) и выбирает сначала не пробованные, потом самые давние попытки: полная партия недоступных гостей больше не блокирует остальных; тест с партией 1.
- **W1 — Windows e2e.**
  - *Прогон A* (текст не дошёл): Start открылся в момент запуска Run через `explorer.exe shell:::` на свежем входе и забрал фокус. Тест теперь открывает Run задачей в сессии `user`, находит поле ввода (`FindWindow` + `GetWindowRect`, права на передний план не нужны), кликает в него дважды настоящим вводом (первый клик может только закрыть Start), выделяет и печатает; успех — по файлу-доказательству, до 3 попыток с `Escape` между ними (`apps/mcp/test/windows-run.ts`, общий для e2e и MCP-проверки). Проверено с принудительно открытым Start. Продукт: готовность рабочего стола не задерживается до конца работы оболочки после первого входа — Start, тосты («Searching for Display Driver» у Basic Display Adapter) могут появиться и позже; агенты computer-use, как и тест, должны фокусировать окно кликом, а не полагаться на фокус.
  - *Прогон B* (чёрный websocket viewer): в браузере не было ни одного декодированного кадра, Sunshine при этом закодировал 177 кадров с 8 I-кадрами за 8 s (обычно 2–4 — клиент повторно просил IDR). Не воспроизвелось: 3 подряд на тёплой VM, 3 после stop/resume, 7 полных Windows `e2e-desktop` подряд (последние 4 — на `s10-fix2` с новым TURN: 43 проверки каждый, create 119–129 s, первое открытие потока 24–27 s, первый кадр WebSocket/WebRTC через 150–215 ms, Run — с первой попытки). Причина не установлена; продуктовая ошибка не доказана. Тест теперь отличает «нет картинки» (ждёт первый кадр до 30 s) от «кадр не изменился», меняет кадр движением курсора (раньше — только набором текста, который виден лишь при фокусе), и при сбое сохраняет консоль браузера и `web-server.log` moonlight-web.

Live на CT 590 (`s10-fix2`): `e2e.sh` 20/20, Linux `e2e-desktop` зелёный (44 проверки), Windows `e2e-desktop` 4 подряд зелёные; pve после прогонов — только шаблоны.
