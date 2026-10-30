# S3. Гостевой агент v0 (Linux)

Статус: согласовано, 2026-10-29 (master-сессия; ревью исполнителем пройдено, замечания внесены). Дополнено MVP-рекомендациями R7 (`docs/roadmap-phase2.md` §6, решения master-сессии 2026-10-29). Область S3 из `docs/roadmap.md`. Архитектура: `docs/architecture.md` §4. Контракт, на котором стоит агент: `docs/specs/s2-tunnel-protocol.md` (особенно §5, §9, §10, §15). Соседние области: S1 `docs/specs/s1-proxmox-foundation.md` (quiesce, smbios), S4 (gateway, SSH), S5 (шаблон), S6 (control plane).

Пометка **[исполнитель]** — решение автора спеки в рамках брифа; его можно менять без нового согласования, если причина записана. Остальные решения согласованы с master-сессией (2026-10-29).

## 1. Зачем и что считается успехом

Агент — единственный процесс платформы внутри VM. Через него control plane запускает команды, работает с файлами, публикует порты, выдаёт sandbox пользователю (claim), снимает согласованные снапшоты и обновляет самого агента. Linux сейчас, Windows (S9) — тем же кодом позже.

Сценарии по приоритету:

1. **Команды переживают всё, кроме перезагрузки.** Команда на час продолжает работать при обрыве туннеля, перезапуске и самообновлении агента; вывод читается байт в байт по offset, код выхода верный, команда никогда не выполняется дважды.
2. **Claim за доли секунды.** Warm-машина получает env, секреты, hostname и ключ SSH CA и сообщает о готовности по фазам.
3. **Fork и снапшоты чистые.** Fork получает новую идентичность (machine-id, hostname, SSH host keys, пустое состояние агента) до старта сети; секреты не попадают на диск и не уезжают в снапшот.
4. **Снапшот работающей machine согласован.** Docker на паузе, FS заморожены на секунды, и заморозка снимается сама, даже если вызывающий пропал.
5. **Обновление без человека.** Подписанный пакет доставляется через туннель; неудачная версия откатывается сама.

## 2. Цели, не-цели, анти-цели

**Цели:** сервисы `proto/sbx/agent/v1` (`Process`, `Filesystem`, `System`) и ручки `/files/*`; shim и supervisor; durable-состояние и retention; claim и готовность; смена идентичности; quiesce/thaw; порты и CONNECT; установка, unit-файлы, самообновление, восстановление через QEMU guest agent; модель пользователей. Код переносим на Windows: всё, что зависит от ОС, — за интерфейсами (§18), без cgo.

**Не-цели:** протокол туннеля и общая Go-библиотека туннеля (S2, `libs/tunnel`); gateway, HTTP-прокси `*.sbx`, SSH gateway (S4); операции Proxmox (S1); сборка образа (S5, здесь только требования к нему, §20); модель данных и машины состояний (S6); публичное API (S7); Windows-специфика (S9) кроме переносимости; рабочий стол и computer-use (S10); встроенные coding-агенты, AI-прокси, копия вывода вне VM (фаза 2).

**Анти-цели** (провал, даже если формально работает):
- команда выполнилась дважды после повтора `Start`;
- вывод при attach отличается от записанного хотя бы на байт; `exit` пришёл раньше последнего байта;
- секрет (BS, MT, `secretEnv`, `secretFiles`, env из spec команды) записан на диск гостя или в swap;
- FS осталась замороженной дольше lease, потому что вызывающий пропал;
- fork загрузился с machine-id, SSH host keys или журналом событий источника;
- неудачное обновление оставило VM без агента и без отката;
- агент — последний процесс, который ядро убивает при OOM, но при этом он сам раздувает память (буферизует вывод в RAM).

## 3. Обзор

```
 VM (Ubuntu)
 +-------------------------------------------------------------------------+
 | sbx-identity.service (oneshot, early boot, before network and sshd)     |
 |                                                                         |
 | sbx-agent.service (root)                     sbx-cmd.slice              |
 |  +------------------------------+            +-----------------------+  |
 |  | libs/tunnel client (WSS, h2) |            | sbx-cmd-<id>.service  |  |
 |  | Connect: sbx.agent.v1.*      |  D-Bus     |  shim (root)          |  |
 |  |          sbx.tunnel.v1.*     |----------->|  payload/ (cgroup)    |  |
 |  | /files/*, CONNECT            |  unix sock |   bash -lc ... (user) |  |
 |  | state: bbolt + log files     |<---------->|  pipes -> log files   |  |
 |  +------------------------------+            +-----------------------+  |
 |         | Docker API (unix)        sbx-quiesce-watchdog-<lease>.service |
 |  sshd 127.0.0.1:22 / [::1]:22 (TrustedUserCAKeys from claim)            |
 |  qemu-guest-agent (fallback channel, S1)                                |
 +-------------------------------------------------------------------------+
```

- Один бинарник `sbx-agent` (`services/guest-agent`, Go-модуль `github.com/belov38/boat-dev-clone/services/guest-agent`) с подкомандами: `run` (агент), `shim`, `identity`, `quiesce-watchdog`, `rollback`, `doctor`, `thaw`, `install-package`, `seal`, `selftest`.
- Туннель — библиотека `libs/tunnel` из S2: агент даёт ей `http.Handler` (Connect-сервисы, `/files/*`, CONNECT) и реализацию журнала событий и capabilities (§16, §17).
- Входящих TCP-портов у агента нет. С shim агент говорит через unix-сокеты в `/run/sbx-agent` (root 0700).

## 4. Пользователи, права, безопасность

Модель безопасности: **граница доверия — VM.** Root внутри VM принят Ильёй (S2 §16, п. 1): он может прочитать BS и MT своей VM, но это даёт только доступ к своей же VM. Отсюда решения ниже (согласовано master-сессией, Илья проинформирован и может пересмотреть):

- Агент работает от **root** (`sbx-agent.service`, `User=root`).
- Команды по умолчанию идут от **`user`** (uid 1000, группы `sudo` и `docker`, **NOPASSWD sudo**, linger включён). Пользователь создаётся в шаблоне (S5); имя берётся из `agent.toml` (`[user] default`).
- Поле `user` в spec команды допускает любого существующего пользователя, включая `root`.
- Файловые операции агент выполняет от root. Новые файлы и каталоги получают владельца `user` (или `owner` из запроса). Ограничений по путям нет (в отличие от boat).
- Секреты — только в отдельном tmpfs `/run/sbx` с опцией `noswap` (ядро ≥ 6.4), который агент монтирует при старте. Там же на время запуска лежит spec команды с env. Env из spec команды на диск не пишется (§9.2). Swap в шаблоне запрещён (§20): секреты есть и в памяти процессов, а `noswap` защищает только tmpfs.
- Агент не пишет в лог значения env, секретов, тела файлов и тела RPC.
- Каталоги состояния (`/var/lib/sbx-agent`, `/run/sbx-agent`) — root 0700. Это не защита от `user` (у него sudo), а защита от случайной порчи.
- CONNECT только на адреса самой VM (S2 §4.2).
- Обновления подписаны ed25519 (§17.3).

## 5. Конфигурация и каталоги

`/etc/sbx-agent/agent.toml` — настройки шаблона (кладёт S5) **[исполнитель: формат TOML]**:

```toml
[tunnel]
url = "wss://tunnel.example.com/v1/connect"

[user]
default = "user"

[readiness]
required = ["identity", "claim", "secrets", "docker"]   # phases that gate "ready"

[docker]
enabled = true                 # pause on quiesce, "docker" readiness phase

[ports]
exclude = [22, 53]             # not reported in ports.changed

[output]
per_stream_bytes = "128MiB"
total_bytes = "2GiB"
total_fraction = 0.10          # of the state filesystem; the smaller limit wins

[limits]
max_running_commands = 256

[idle]
window = "5m"
```

Доверенные материалы (бандл tunnel CA, публичные ключи обновлений) лежат **в каталоге версии** (`versions/<v>/trust/`), а не в `/etc`: они обновляются и откатываются вместе с бинарником (S2 §5.4). Для разработки путь можно переопределить в `agent.toml`.

| Путь | Что | Переживает |
|---|---|---|
| `/usr/local/lib/sbx-agent/versions/<v>/` | `sbx-agent`, `manifest.json`, `manifest.sig`, `trust/tunnel-ca.pem`, `trust/update-keys.pub` | всё |
| `/usr/local/lib/sbx-agent/current`, `previous` | symlink на версии | всё |
| `/usr/local/bin/sbx-agent` | symlink на `current/sbx-agent` (CLI для `doctor` и QGA) | всё |
| `/var/lib/sbx-agent/state.db` | bbolt: команды, кэш `requestId`, журнал событий, загрузки, claim без секретов, meta | перезагрузку; стирается при смене идентичности |
| `/var/lib/sbx-agent/commands/<id>/` | `stdout`, `stderr`, `pty`, `shim.json`, `exit.json` | перезагрузку; стирается при смене идентичности |
| `/var/lib/sbx-agent/uploads/` | временные файлы загрузок | перезагрузку; стирается при смене идентичности |
| `/var/lib/sbx-agent/identity.json` | machineId, записанный machine-id, отпечатки host keys | всё; переписывается при смене идентичности |
| `/var/lib/sbx-agent/pending-update.json` | незавершённое обновление `{from, to, deadline}`. Это файл, а не bbolt: его читает `rollback` (§17.4) | перезагрузку |
| `/run/sbx-agent/` | сокеты shim, lease quiesce, `status.json` | только до перезагрузки |
| `/run/sbx/` | tmpfs `noswap`, монтирует агент: `secrets/` (0750 `root:user`: `env`, `files/<name>`), `cmd-spec/` (0700 root: spec команды, пока его не прочитал shim) | только до перезагрузки |
| `/etc/sbx/env` | несекретный env sandbox для PAM (SSH-сессии), §8.2 | перезагрузку; при смене идентичности очищается |
| `/etc/sbx-agent/ssh-user-ca.pub` | ключи SSH CA gateway из шаблона (может быть пуст) | всё (часть шаблона) |
| `/etc/ssh/sbx_user_ca.pub` | действующие ключи SSH CA: из claim, иначе копия шаблонных | перезагрузку; при смене идентичности переписывается из шаблона |

## 6. Загрузка и жизненный цикл агента

Порядок при загрузке:

1. `sbx-identity.service` (oneshot, §7): сверяет smbios с `identity.json` и при смене сбрасывает идентичность. Идёт до сети, sshd и агента.
2. `sbx-agent.service`:
   1. Если есть `/run/sbx-agent/quiesce.json` — снять заморозку (§14.4). Иначе пробная запись в state-каталог; если она висит дольше 15 s — принудительный thaw (§14.4). До этого агент на диск не пишет. Затем смонтировать tmpfs `/run/sbx` (если его ещё нет) и создать пустые `secrets/env` и `/etc/sbx/env`, если их нет.
   2. Открыть `state.db`, миграции (только добавляющие, §17.5).
   3. Если `bootId` изменился — всем командам в `RUNNING` без `exit.json` поставить `LOST` (reason `REBOOT`), выпустить `command.exited`. Иначе — найти живые shim и переподключиться к их сокетам (§9.6).
   4. Подтвердить или откатить ожидающее обновление (`pending-update.json`, §17.4).
   5. Прочитать smbios, подключиться через `libs/tunnel` (S2 §4–§6).
   6. Событие `agent.started`, фазы готовности (§8.5).
3. `SIGTERM` (stop VM, `systemctl restart`): агент закрывает туннель, сбрасывает буферы в `state.db` и выходит. Shim и команды не трогает: они в своих unit-ах.

Что переживает что:

| Событие | Команды и PTY | Вывод, журнал, кэш `requestId` | Claim (env, hostname, SSH CA) | Секреты | Туннель, TCP-потоки, attach |
|---|---|---|---|---|---|
| обрыв туннеля | живы | целы | цел | целы | TCP рвутся; attach продолжается по offset |
| перезапуск или обновление агента | живы (shim в своих unit-ах) | целы | цел | целы (tmpfs) | переподключение с BS; TCP рвутся |
| перезагрузка (stop/resume) | `LOST`, PTY закрыты | целы | цел | **пропали**, фаза `secrets: pending` | новое подключение |
| смена идентичности (fork, VM из saved snapshot) | нет (холодный старт) | **стёрты**, `seq` с 1 | **стёрт**, ждёт нового claim | нет | новое подключение |

## 7. Идентичность

### 7.1 Источник

- `/sys/class/dmi/id/product_serial` (читает только root) содержит `sbx1:<machineId>:<base64url(BS)>`: Proxmox декодирует `base64=1` из `smbios1` (S2 §5.2, S1 §6.4). `product_uuid` должен совпадать с `machineId`; при расхождении — предупреждение в лог, верим serial.
- **vmgenid на Linux не читается**: драйвер `vmgenid` только пересевает RNG и значение в userspace не отдаёт (uevent `NEW_VMGENID` был откатан в 2024). Поэтому на Linux fork определяется только по `machineId`. Заголовок `Sbx-Vmgenid` агент шлёт пустым. На Windows (S9) vmgenid читается.
- Fork у нас всегда холодный старт новой VM (снимков памяти нет), поэтому смена идентичности видна только при загрузке, а не на работающей VM.
- Если serial нет или он не разбирается (сборка шаблона), агент работает без туннеля, фаза `identity: failed`, повтор чтения раз в 60 s.

### 7.2 `sbx-identity.service`

```ini
[Unit]
Description=sbx machine identity
DefaultDependencies=no
After=local-fs.target systemd-remount-fs.service
Before=network-pre.target systemd-networkd.service ssh.service ssh.socket cloud-init-local.service sbx-agent.service systemd-journal-flush.service sysinit.target
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/lib/sbx-agent/current/sbx-agent identity apply

[Install]
WantedBy=sysinit.target
```

`identity apply`: если `machineId` из smbios равен сохранённому в `identity.json` — ничего не делать. Иначе (или если `identity.json` нет — первая загрузка после `seal`):

1. Стереть состояние агента: `state.db`, `commands/`, `uploads/`, `pending-update.json`, другие файлы из списка управляемых (`/var/lib/sbx-agent/managed-files`); `/etc/sbx/env` оставить пустым. `/etc/ssh/sbx_user_ca.pub` переписать копией `/etc/sbx-agent/ssh-user-ca.pub` из шаблона.
2. **machine-id.** Если `/etc/machine-id` пуст, равен `uninitialized` или равен значению из старого `identity.json` (унаследован), записать новый: hex `machineId` без дефисов (32 символа). Если systemd уже выставил другое значение (`systemd.machine_id=firmware`, §20), оставить его. `/var/lib/dbus/machine-id` — symlink на `/etc/machine-id`.
3. **SSH host keys.** Удалить `/etc/ssh/ssh_host_*`, выполнить `ssh-keygen -A`. На Linux вызов системной утилиты допустим: OpenSSH в образе есть; на Windows (S9) свой путь.
4. **Hostname.** `sbx-<последние 12 hex machineId>` (последние, потому что первые 48 бит UUIDv7 — время создания и у соседних machine совпадают). `sethostname`, `/etc/hostname`, строка `127.0.1.1` в `/etc/hosts` (управляемый блок). Claim потом заменит hostname.
5. Записать `identity.json` с флагом `resetPending` (fsync).
6. **journald.** Если шаг 2 заменил действовавший machine-id (форк унаследовал id родителя), `systemctl try-restart systemd-journald` и дождаться перезапуска. journald запомнил старый id на старте и писал бы в `/var/log/journal/<старый id>`, где `journalctl` форка ничего не находит. Юнит идёт до `systemd-journal-flush.service`, поэтому сброс runtime-журнала в `/var/log/journal` идёт уже под новым id и забирает записи начала загрузки. Ошибка перезапуска пишется в лог и apply не валит.

Агент при старте видит `resetPending`, первым событием нового журнала (`seq = 1`) пишет `identity.reset` и снимает флаг.

Так machine-id и DHCP DUID (systemd-networkd выводит его из machine-id) меняются до старта сети. Это закрывает риск S1 «одинаковый IP у A и F». PID 1 кэширует machine-id с ранней загрузки; journald перезапускается шагом 6, остальным процессам хватает нового `/etc/machine-id`.

**Страховка в агенте.** Если агент при старте видит несовпадение (`sbx-identity` выключен или упал), он выполняет те же шаги сам, затем `systemctl try-restart ssh` и `networkctl renew`, пишет предупреждение.

### 7.3 `sbx-agent seal` (для S5)

Подготовка образа перед `qm template`: остановить агента, стереть `/var/lib/sbx-agent` целиком (вместе с `identity.json`) и host keys, очистить `/etc/machine-id` (пустой файл), вернуть управляемые файлы к шаблонным (`/etc/sbx/env` пустой, `/etc/ssh/sbx_user_ca.pub` — копия шаблонных ключей). Каталог версий `/usr/local/lib/sbx-agent` остаётся. Первая загрузка из шаблона пройдёт §7.2 как смена идентичности.

## 8. Claim, env, секреты, SSH, готовность

### 8.1 Claim

`System/Claim` (с `Sbx-Request-Id`) выполняется **один раз на идентичность machine**. Повтор с тем же `requestId` возвращает сохранённый ответ. Claim с другим содержимым после успешного — `failed_precondition` `already_claimed`. Если фаза `identity` ещё не `ready` — `unavailable` `identity_not_ready` (retryable).

```proto
message ClaimRequest {
  string sandbox_id = 1;
  string hostname = 2;                 // e.g. sandbox slug; RFC 1123 label
  string port_domain = 3;              // e.g. "sbx.example.com", for default env
  map<string, string> env = 4;         // non-secret, persisted in /etc/sbx/env
  map<string, string> secret_env = 5;  // tmpfs only
  repeated SecretFile secret_files = 6;
  repeated string ssh_user_ca_keys = 7; // gateway SSH CA public keys (current + next)
}
message SecretFile {
  string name = 1;        // file name under /run/sbx/secrets/files/
  bytes content = 2;      // <= 1 MiB each, <= 8 MiB total
  uint32 mode = 3;        // default 0440, group = default user
  string link_path = 4;   // optional symlink on disk pointing into tmpfs
}
```

Шаги (каждый идемпотентен):
1. Hostname: `sethostname`, `/etc/hostname`, `/etc/hosts`.
2. Env (платформенный и `env`) — в `state.db` (запись claim) и в `/etc/sbx/env` для PAM, атомарно (tmp + fsync + rename).
3. Секреты в `/run/sbx/secrets` (`env`, `files/`); symlink-и `link_path` (на диске лежит только symlink, содержимое в tmpfs; после перезагрузки symlink висит битым до повторной отправки секретов).
4. `/etc/ssh/sbx_user_ca.pub` атомарно; пустой список в claim → копия шаблонных ключей. Перезагружать sshd не нужно: он читает `TrustedUserCAKeys` при каждой аутентификации. Исполнитель проверяет это тестом §21; если окажется не так — `systemctl try-reload-or-restart ssh.service`, неактивный unit не считается ошибкой.
5. Записать claim без секретов и `secretsDigest` (sha256 канонического набора секретов, не сами значения) в `state.db`.
6. Фазы `claim` и `secrets` → `ready`, событие `claim.applied`.

Дальнейшие изменения — полной заменой набора:
- `System/UpdateEnv{env}` — новые команды видят новый env, запущенные — нет;
- `System/UpdateSecrets{secret_env, secret_files}` — после каждой перезагрузки (resume) control plane вызывает его заново: при старте агента фаза `secrets` = `pending`, если `secretsDigest` непустой. S6 хранит секреты зашифрованными и пересылает при resume; fork наследует env источника и получает claim заново; saved snapshot секретов не несёт;
- `System/UpdateSshCa{keys}` — ротация CA gateway.

### 8.2 Env команд и SSH-сессий

Агент собирает env процесса сам, не полагаясь на shell. Порядок (последний выигрывает):
1. базовый: `HOME`, `USER`, `LOGNAME`, `SHELL`, `PATH` (по умолчанию Ubuntu), `LANG=C.UTF-8`, `XDG_RUNTIME_DIR=/run/user/<uid>` (есть благодаря linger), `TERM` для PTY;
2. платформенный по умолчанию: `SBX=1`, `SBX_SANDBOX_ID`, `SBX_PORT_DOMAIN`, `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=.<port_domain>` (Vite dev server принимает хосты `*.sbx.<domain>`, требование S4);
3. `env` из claim;
4. `secret_env`;
5. `env` из spec команды.

Login-shell (`bash -lc`) читает `/etc/profile` и `~/.profile`, но env платформы туда не добавляется, поэтому env из spec ничем не перетирается.

**SSH-сессии** (login и не-login: `ssh host cmd`, scp, sftp) получают пункты 2–4 через PAM. S5 добавляет в `/etc/pam.d/sshd` две строки:

```
session required pam_env.so readenv=1 envfile=/etc/sbx/env
session required pam_env.so readenv=1 envfile=/run/sbx/secrets/env
```

- Агент пишет оба файла в формате `KEY=VALUE`, который читает `pam_env`. Точное экранирование исполнитель проверяет тестом.
- Значения с переводом строки или NUL в эти файлы не попадают: их видят только команды агента. Многострочные секреты передаются через `secret_files`.
- Файлы существуют всегда (пустые до claim), чтобы PAM не падал.
- Тот же путь через PAM позже использует рабочий стол (S10).

### 8.3 SSH

Решение S4: gateway терминирует SSH и ходит через туннель (CONNECT `127.0.0.1:22`) в системный OpenSSH VM с короткоживущими user-сертификатами от SSH CA gateway. Поэтому:
- sshd слушает только `127.0.0.1` и `::1` (настройка шаблона, S5);
- `TrustedUserCAKeys /etc/ssh/sbx_user_ca.pub`; содержимое приходит в claim (`ssh_user_ca_keys`, текущий и следующий ключ), а если в claim пусто — копия `/etc/sbx-agent/ssh-user-ca.pub` из шаблона;
- principal в сертификате — имя пользователя VM (`user`, при необходимости `root`); выбор principal-ов — S4;
- ключи пользователей проверяет gateway, `authorized_keys` агент не ведёт;
- публичные host keys отдаются в `System/Info.ssh_host_keys`, чтобы gateway мог их закрепить (S4).

### 8.4 Hostname

До claim — `sbx-<12 hex>` из §7.2, после — из claim. Агент проверяет, что значение — допустимая метка RFC 1123 (до 63 символов), иначе `invalid_argument`.

### 8.5 Фазы готовности

| Фаза | `ready`, когда | Примечание |
|---|---|---|
| `agent` | агент запущен | всегда |
| `identity` | §7 выполнен, serial прочитан | |
| `claim` | claim применён | до claim — `pending` (машина в warm pool) |
| `secrets` | секреты в tmpfs совпадают с `secretsDigest` (пустой набор — сразу `ready`) | после перезагрузки `pending` до `UpdateSecrets` |
| `docker` | `docker.service` активен и `GET /_ping` по unix-сокету отвечает | `disabled`, если `[docker] enabled = false` |
| `desktop` | — | S10 |

Состояния: `pending`, `ready`, `failed` (с ошибкой), `disabled`. `System/Info.readiness` отдаёт все фазы и агрегат `ready` (все фазы из `[readiness] required` готовы). Каждое изменение — событие `readiness.changed`.

## 9. Процессы

### 9.1 API (`sbx.agent.v1.Process`)

| Метод | Вид | Идемпотентность |
|---|---|---|
| `Start(command_id, spec)` | unary | по `command_id` (S2 §9.1) |
| `Run(command_id, spec, attach-опции)` | server stream | `Start` + `Attach`, первое событие `started` |
| `Attach(command_id, stdout_offset, stderr_offset, pty_offset, tail_bytes, follow)` | server stream | `NO_SIDE_EFFECTS` |
| `SendInput(command_id, input_session_id, seq, data, close_stdin)` | unary | `IDEMPOTENT` (дедупликация по `seq`) |
| `Update(command_id, cols, rows)` | unary | `IDEMPOTENT` |
| `Signal(command_id, signal)` | unary | `IDEMPOTENT` |
| `Kill(command_id, grace_ms)` | unary | `IDEMPOTENT` |
| `Get(command_id)` | unary | `NO_SIDE_EFFECTS` |
| `List(state, tags, page_size, page_token)` | unary | `NO_SIDE_EFFECTS` |
| `Remove(command_id)` | unary | `IDEMPOTENT`; только для завершённых, удаляет логи и запись |

```proto
message CommandSpec {
  oneof cmd {
    Argv argv = 1;              // exec directly
    string shell = 2;           // /bin/bash -lc <shell> (or -c if login = false)
  }
  bool login = 3;               // default true for shell
  string cwd = 4;               // default: home of user; relative -> relative to home
  map<string, string> env = 5;  // never written to disk
  string user = 6;              // default from agent.toml; "root" allowed
  Pty pty = 7;                  // set -> PTY command with a single "pty" stream
  bool stdin = 8;               // open a stdin pipe (non-PTY); otherwise /dev/null
  uint64 timeout_ms = 9;        // 0 = none; enforced by the shim
  OnExit on_exit = 10;          // KEEP_LEFTOVERS (default) | KILL_LEFTOVERS
  map<string, string> tags = 11; // small labels for List
}
message Pty { uint32 cols = 1; uint32 rows = 2; string term = 3; } // term default xterm-256color
```

В отличие от S2 §9.1 у `Attach` есть `pty_offset` (PTY-поток отдельный, добавление поля), а также:
- `tail_bytes` — начать каждый поток с `max(available_from, size − tail_bytes)`, для scrollback терминала;
- `follow` — по умолчанию `true`. При `false` отдать имеющееся и закрыть стрим; `exit` придёт, если команда уже завершилась.

`CommandInfo` (в ответах `Start`, `Get`, `List`): `command_id`, spec без значений env (только ключи), `state` (`STARTING`, `RUNNING`, `EXITED`), `pid`, `started_at`, `ended_at`, `exit` (`status`: `EXITED`/`KILLED`/`LOST`; `code`, `signal`, `reason`: `NONE`/`SIGNAL`/`TIMEOUT`/`OOM`/`PTY_IDLE`/`REBOOT`/`SHIM_LOST`/`START_FAILED`), по каждому потоку `size`, `available_from` и `end` (после выхода), `has_leftovers`, `attached_clients`, `agent_version` shim-а, `output_truncated` (`""` или `disk_full`: часть вывода не записана из-за нехватки места; offset-ы и `end` относятся только к записанному). Статусы `exited/killed/lost` — как в S2; `reason` — добавленное поле.

### 9.2 Start: durable и ровно один запуск

1. Проверить spec, пользователя, лимит `max_running_commands` (иначе `resource_exhausted` `too_many_commands`).
2. Найти `command_id` в `state.db`:
   - есть и `spec_hash` совпадает → вернуть текущий `CommandInfo` (если запись в `STARTING` — см. п. 5);
   - есть с другим hash → `already_exists`.
3. Записать `STARTING`: spec без значений env + `spec_hash` (sha256 полного spec, включая env) + `bootId`; fsync. Env на диск не пишется: при повторе `Start` после сбоя вызывающий пришлёт spec заново, и hash подтвердит, что это тот же spec.
4. Положить полный spec в `/run/sbx/cmd-spec/<id>` (tmpfs `noswap`, 0600). Shim прочитает его и удалит.
5. Запустить transient unit `sbx-cmd-<id>.service` через D-Bus `StartTransientUnit` (§9.3). Имя детерминированное: systemd не создаст второй unit с тем же именем, пока жив первый.
   - Shim пишет маркер `shim.json` `{state: "launching", agentVersion, shimProto}` с fsync **до** запуска процесса. pid в маркере нет: в Go нет точки между fork и exec. pid shim дописывает после запуска (атомарная перезапись того же файла).
   - Повтор для записи в `STARTING`: если `shim.json` есть, запуск мог состояться, и команда считается запущенной (ждём или читаем её состояние). Если нет ни `shim.json`, ни unit-а — запуска не было, запускаем.
   - Поэтому повтор никогда не даст второго запуска. В худшем случае (shim умер между маркером и запуском) команда будет `LOST` с `SHIM_LOST`.
6. Дождаться `READY=1` от shim (`Type=notify`): он создал cgroup и запустил процесс. Записать `RUNNING` + `pid`, fsync, ответить.

Если процесс не запустился (нет бинарника, нет `cwd`, неизвестный пользователь) — команда сразу `EXITED` с `reason START_FAILED` и `code 127`. Текст ошибки пишется в `stderr` команды, чтобы клиент видел его через attach.

### 9.3 Shim и cgroup

Unit (свойства передаются в `StartTransientUnit`):

```
sbx-cmd-<id>.service
  Slice=sbx-cmd.slice
  Type=notify, NotifyAccess=main
  ExecStart=/usr/local/lib/sbx-agent/versions/<v>/sbx-agent shim --id <id>
  Delegate=yes
  KillMode=control-group      # only used by explicit unit stop during cleanup
  # OOMScoreAdjust stays 0 so the payload inherits 0; the shim lowers only itself to -900 after the start
  CollectMode=inactive-or-failed
```

Shim:
1. Читает и удаляет spec из `/run`.
2. Переносит себя в leaf `<unit>/shim`, включает в `<unit>/cgroup.subtree_control` контроллеры `memory pids cpu`, создаёт `<unit>/payload`.
3. Создаёт pipe-ы для stdout и stderr и копирует их в `commands/<id>/stdout` и `stderr` (root 0600) буфером 64 KiB. Offset — позиция в файле. Файлы пишет сам shim, агент в этом не участвует (S2 §9.1).
   Почему не отдать процессу файл напрямую: идиома `echo x >/dev/stderr` заново открывает fd 2 через `/proc/self/fd`. Для файла root это `EACCES`, а для файла, принадлежащего пользователю, — `O_TRUNC`, который обнуляет лог и ломает offset-ы.
4. Для PTY: открывает PTY (`creack/pty`), процесс — лидер сессии с управляющим терминалом. Shim копирует master → `commands/<id>/pty` и пишет ввод в master.
5. Для `stdin: true` держит pipe на запись, иначе stdin процесса — `/dev/null`.
6. `PR_SET_CHILD_SUBREAPER`: осиротевшие потомки остаются детьми shim, а не PID 1.
7. Пишет маркер `shim.json` (fsync, §9.2).
8. Запускает процесс через `SysProcAttr`:
   - `UseCgroupFD`/`CgroupFD` — `CLONE_INTO_CGROUP` в `payload`;
   - `Credential` — uid, gid и группы из `/etc/passwd` и `/etc/group` (`os/user` без cgo);
   - `Setpgid` (не-PTY) или `Setsid` + `Setctty` (PTY).

   Процесс наследует `oom_score_adj` 0 от unit-а. После запуска shim пишет -900 только в свой `/proc/self/oom_score_adj` (у root есть `CAP_SYS_RESOURCE`). Затем дописывает `pid` и `startedAt` в `shim.json` и отправляет `READY=1`.
9. Слушает `/run/sbx-agent/cmd/<id>.sock` (§9.6).
10. Следит за `timeout_ms`: по истечении выполняет Kill (§9.5) с `reason TIMEOUT`. Таймер живёт в shim, поэтому от агента не зависит.

**Выход.** Когда главный процесс завершился:
- shim дочитывает pipe-ы неблокирующим чтением до `EAGAIN` или EOF: всё, что процесс записал до выхода, уже лежит в буфере pipe. Для PTY master дочитывается до `EIO`;
- `end` каждого потока = размер файла после этого дочитывания;
- shim определяет `reason`: `OOM`, если `payload/memory.events` `oom_kill` вырос и процесс убит `SIGKILL`; иначе по сигналу или по команде Kill;
- пишет `exit.json` (fsync) и сообщает агенту через сокет (агент также видит смену состояния unit-а по D-Bus и `exit.json` через inotify).

**Фоновые процессы (leftovers).** `cmd &` и `nohup` живут дальше в `payload`:
- shim не выходит, пока `payload` непуст (следит за `cgroup.events` `populated`) и pipe-ы не дали EOF: если главный процесс service-unit-а выйдет, systemd убьёт cgroup;
- shim продолжает читать pipe-ы, поэтому leftovers не получают SIGPIPE и не блокируются. Их поздний вывод пишется в те же файлы за `end` и в attach не попадает;
- в `CommandInfo` поле `has_leftovers = true`;
- `Kill` или `Signal(SIGKILL)` на завершённой команде убивает leftovers;
- `on_exit: KILL_LEFTOVERS` убивает их сразу после выхода главного процесса.

Если shim умрёт (OOM, баг), читающий конец pipe закроется, и процесс получит SIGPIPE при следующей записи. Поэтому shim маленький и защищён `oom_score_adj` -900.

### 9.4 Ввод и PTY

- `SendInput` агент передаёт в сокет shim. Shim хранит `last_seq` по каждому `input_session_id` и отбрасывает `seq ≤ last` (S2 §9.3). Состояние в shim, поэтому дедупликация переживает перезапуск агента. Обработка в shim однопоточная: применение и обновление `seq` атомарны.
- `close_stdin` закрывает pipe (EOF для процесса). Для PTY не применяется: EOF клиент шлёт сам байтом `^D`.
- `Update(cols, rows)` → `TIOCSWINSZ` в shim (SIGWINCH процессу делает ядро).
- `SendInput` и `Update` для завершённой команды → `failed_precondition` `command_exited`.
- **Таймаут PTY без клиента** (S2 §9.3): агент считает attach-стримы PTY-команды. Когда последний отключился, пишет `pty_detached_at` в `state.db` и ставит таймер на 10 min (после перезапуска агента таймер восстанавливается из записи). Если команду ни разу не подключали, отсчёт идёт от старта. По истечении — `SIGHUP` группе сессии, через 10 s `cgroup.kill`, `reason PTY_IDLE`.

### 9.5 Сигналы и Kill

- `Signal(sig)` — сигнал группе процессов главного процесса. `Signal(SIGKILL)` — `cgroup.kill` на `payload` (всё, включая leftovers).
- `Kill(grace_ms)`, по умолчанию `grace_ms` = 10000: `SIGTERM` группе, через `grace_ms` — `cgroup.kill` на `payload`. Последовательность выполняет shim, поэтому она переживает перезапуск агента. Если shim нет — агент сам делает `cgroup.kill`.
- `Signal` и `Kill` по завершённой команде без leftovers ничего не делают и возвращают текущий `CommandInfo`.

### 9.6 Протокол агент ↔ shim

Unix-сокет `/run/sbx-agent/cmd/<id>.sock` (root 0700), сообщения protobuf с префиксом длины **[исполнитель]**.

Сообщения: `Hello{shim_proto_min, shim_proto_max}`, `Status → {pid, state, last_seq по сессиям, leftovers}`, `Input{session, seq, data}`, `CloseStdin`, `Resize{cols, rows}`, `Kill{grace_ms}`, `SignalGroup{sig}`, событие shim → агент `Exited{...}`.

Версия протокола shim отдельная. Агент поддерживает **все** версии протокола shim в пределах своего major: shim-ы старой версии переживают несколько обновлений (§17.4).

Если версия shim всё же не поддерживается (после смены major), команда не теряется. Агент читает логи и `exit.json` (их формат стабилен) и может убить её через `cgroup.kill`. `SendInput`, `Update` и `Kill` с grace в этом случае отвечают `failed_precondition` `shim_outdated`.

Shim запускается из `versions/<v>/`; эта версия не удаляется, пока есть живые shim-ы с ней.

Восстановление после перезапуска агента: для каждой записи `RUNNING` агент проверяет `exit.json` (есть → завершить запись), иначе unit (жив → подключиться к сокету), иначе (`unit` нет, `exit.json` нет) → `LOST` с `SHIM_LOST`.

### 9.7 Пределы и память

- `max_running_commands` (по умолчанию 256) считает команды с живым главным процессом.
- Цель **[исполнитель]**: RSS простаивающего агента < 40 MiB, shim < 8 MiB (`GOGC`, `GOMEMLIMIT` для shim заданы в unit-е; проверяется приёмкой §21).

## 10. Вывод: чтение и retention

**Чтение (Attach).**
- Агент читает файл с запрошенного offset кусками до 64 KiB. `Send` в Connect-стрим блокируется по flow control HTTP/2, поэтому агент ничего не копит в памяти (S2 §9.1).
- Новые данные агент видит по inotify на каталоге команды (`fsnotify`), с запасным опросом раз в 250 ms. Цель — лишние < 10 ms к эху PTY (S2 §14.3, p99 эха ≤ 50 ms).
- Если запрошенный offset меньше `available_from` — событие `truncated{stream, available_from}`, затем чтение с `available_from`.
- Janitor может выбить дыру одновременно с чтением, и прочитанное окажется нулями. Поэтому после каждого чтения агент заново берёт `available_from` (`SEEK_DATA`). Если оно стало больше начала прочитанного куска, часть до него отбрасывается и отдаётся `truncated`. Дыры только продвигаются вперёд, поэтому одной перепроверки достаточно.
- `heartbeat` после 15 s тишины. `exit` — только когда по всем потокам отдано до `end` (S2 §9.1).
- Несколько attach к одной команде одновременно разрешены: каждый читает файл независимо.

**Retention** (S2 оставил решение S3).
- Старый вывод вытесняется **выбиванием дыр** (`fallocate(PUNCH_HOLE|KEEP_SIZE)`) с начала файла, кратно 4 KiB. Offset-ы не сдвигаются, место освобождается. `available_from` берётся из самого файла (`lseek(SEEK_DATA, 0)`), отдельного учёта не нужно. На NTFS (S9) то же через sparse-файлы.
- Janitor агента раз в 1 s:
  - каждый поток каждой команды: если `size − available_from > per_stream_bytes` (128 MiB) — выбить начало до `size − per_stream_bytes`;
  - общий объём `commands/` больше `min(total_bytes, total_fraction × размер FS)` (2 GiB / 10%) — удалить логи самых старых **завершённых** команд целиком (`available_from = end`), затем подрезать самые старые работающие;
  - свободно на FS state-каталога меньше 1 GiB или 5% — предел на поток временно 16 MiB, событие `disk.low`; при восстановлении — `disk.ok`.
- Запись о завершённой команде хранится 7 дней или пока команд больше 10 000 (сначала удаляются старые). Логи удалённой записи удаляются вместе с ней.
- Команду из-за места **не убиваем**: теряется только старый вывод.

## 11. Файлы

### 11.1 Общие правила

- Путь абсолютный; `~`, `~/...` и относительный разрешаются от домашнего каталога пользователя из запроса (по умолчанию `user`).
- Операции выполняются от root; новые файлы и каталоги получают владельца `owner` (по умолчанию пользователь запроса) (§4).
- Symlink-и: чтение, запись и `Stat` следуют им (у `Stat` есть `no_follow`); `List` показывает symlink как `SYMLINK` с целью; рекурсивное удаление по ним не ходит.
- Ошибки: `ENOENT` → `not_found` `path_not_found`; `EEXIST` → `already_exists`; `ENOTDIR`/`EISDIR` → `failed_precondition` `not_directory`/`is_directory`; `ENOSPC`/`EDQUOT` → `resource_exhausted` `no_space`; `EACCES` → `permission_denied`. HTTP-ручки отдают те же коды в JSON `{code, message, retryable}` с соответствующим HTTP-статусом.

### 11.2 HTTP `/files/*` (S2 §9.5)

| Ручка | Что делает |
|---|---|
| `GET /files?path=&user=` | Содержимое. `Range` (один диапазон; несколько → весь файл с `200`), `If-Range`, `ETag` = `"<inode>-<size>-<mtime_ns>"`, `Last-Modified`, `Accept-Ranges: bytes`. Каталог → `400 is_directory`. `HEAD` тоже |
| `PUT /files?path=&mode=&owner=&make_parents=true` | Запись одним потоком любого размера: временный файл в том же каталоге → fsync → rename. Ответ — `FileInfo` JSON. Невозобновляемая; повтор с тем же телом даёт тот же результат |
| `PUT /files/uploads/{uploadId}?offset=&path=` | Чанк до 8 MiB. `offset` обязан равняться текущему размеру, иначе `409` с заголовком `Sbx-Upload-Offset`. `path` в первом чанке — подсказка, где держать временный файл (§11.3) |
| `HEAD /files/uploads/{uploadId}` | `Sbx-Upload-Offset`; `404`, если загрузки нет |
| `POST /files/uploads/{uploadId}/commit` | JSON `{path, sha256?, mode?, owner?, overwrite=true, make_parents=true}` → `FileInfo`. Идемпотентен по `uploadId`: повтор возвращает сохранённый результат 24 h. Несовпадение `sha256` → `422 checksum_mismatch`, загрузка удаляется |
| `DELETE /files/uploads/{uploadId}` | Отмена |
| `GET /files/archive?path=&user=&format=tar\|tar.gz` | Каталог `path` одним потоком tar (POSIX pax; `tar.gz` — gzip потоком), имена относительно `path`. Обход без перехода по symlink-ам (они пишутся как symlink), hardlink-и — как отдельные файлы, сокеты, FIFO и устройства пропускаются. Не каталог → `400 not_directory`. Файлы, которые меняются во время чтения, отдаются как прочитаны: снимка каталога нет. Ошибка посреди потока обрывает ответ без завершающих блоков tar |
| `PUT /files/archive?path=&user=&format=tar\|tar.gz&overwrite=true&make_parents=true` | Распаковка tar-потока (по умолчанию `format=tar`) в каталог `path` (создаётся при `make_parents`). Записи: файлы, каталоги, symlink-и, hardlink-и внутри архива; абсолютный путь, `..`, hardlink наружу, устройства и FIFO → `400 invalid_path`. Пути разрешаются от `path` без перехода по symlink-ам (`openat2` с `RESOLVE_BENEATH \| RESOLVE_NO_SYMLINKS`), поэтому запись не выходит за `path` ни через symlink из архива, ни через уже лежащий (такая запись → `400 invalid_path`). Владелец — `owner` (по умолчанию пользователь запроса), uid/gid архива игнорируются; режим — из архива без setuid/setgid; mtime сохраняется. `overwrite=false` и файл есть → `already_exists`. Пределы: 200 000 записей, 16 GiB распакованных данных, путь до 4 096 байт → `413 payload_too_large`. Не атомарна: при ошибке записанное остаётся, в ответе ошибки `entries_written`. Ответ — `{path, entries, size}` JSON. Повтор с `overwrite=true` даёт тот же результат |

Временные загрузки без активности удаляются через 24 h. Архив каталога (MVP-рек. R7) идёт через тот же `/files/*`, поэтому gateway и `AgentClient.fetch` его не различают (S2 §9.5, S7 §17.1); capability `files.archive.v1`.

### 11.3 Где лежит временный файл загрузки

- В `/var/lib/sbx-agent/uploads/<uploadId>`, если подсказка `path` на той же FS (обычно у VM один диск). При смене идентичности такие файлы стираются вместе с состоянием.
- Иначе — `.sbx-upload-<uploadId>` в каталоге назначения; путь записан в `state.db`, janitor найдёт его по записи.
- При `commit` rename; если `EXDEV` (подсказки не было) — копирование во временный файл в каталоге назначения, fsync, rename.

### 11.4 `sbx.agent.v1.Filesystem` (Connect unary)

| Метод | Поля | Идемпотентность |
|---|---|---|
| `Stat` | `path, user, no_follow` → `FileInfo` | `NO_SIDE_EFFECTS` |
| `List` | `path, user, depth (1–8, default 1), include_hidden (default true), page_size (≤ 10 000), page_token` → `entries[], next_page_token`. Порядок по пути, курсор — последний путь | `NO_SIDE_EFFECTS` |
| `MakeDir` | `path, user, parents, mode, owner`. Уже есть каталог → успех `created=false` | `Sbx-Request-Id` |
| `Move` | `src, dst, user, overwrite`. Между FS: файлы копируются, каталоги → `failed_precondition cross_device` **[исполнитель]** | `Sbx-Request-Id` |
| `Chmod` | `path, user, mode?, owner?, group?, recursive` | `Sbx-Request-Id` |
| `Remove` | `path, user, recursive`. Нет пути → успех `existed=false` | `Sbx-Request-Id` |

`FileInfo`: `path, name, type (FILE/DIR/SYMLINK/OTHER), size, mode, owner, group, uid, gid, mtime, symlink_target`.

Не в v0 (позже, по capability): наблюдение за каталогом (`WatchDir`, как в E2B envd).

## 12. Порты и CONNECT

**Обнаружение.**
- Раз в 1 s агент читает `/proc/net/tcp` и `/proc/net/tcp6`: сокеты в `LISTEN`, адреса `0.0.0.0`, `::`, loopback и адреса интерфейсов VM.
- Порты из `[ports] exclude` не сообщаются. У агента TCP-слушателей нет.
- Владелец (pid, имя процесса, пользователь) определяется по inode сокета через `/proc/*/fd` только при изменении набора портов.
- `System/ListPorts` → `[{port, addresses[], pid, process, user}]`.
- Событие `ports.changed` — полный снимок, с debounce 2 s.

Известная дыра: Docker с `userland-proxy=false` публикует порты через iptables без `LISTEN`-сокета, и они не видны. По умолчанию userland-proxy включён; учёт через Docker API — позже.

**CONNECT** (S2 §4.2). Агент принимает `CONNECT <host>:<port>` от gateway:
- `host` — `localhost`, `127.0.0.1` или пусто: агент пробует по очереди `127.0.0.1`, `[::1]`, затем адреса интерфейсов VM (сначала IPv4, потом IPv6), на каждую попытку 1 s. Подключение отказано → следующий адрес. Так сервис, который слушает только `::1` или только адрес интерфейса, тоже доступен (так ожидает S4, отдельный флаг `--localhost` не нужен). Порядок можно начать с адреса, на котором порт виден в обнаружении, — результат тот же;
- другой адрес VM — подключение строго к нему;
- адрес не из VM → `403`; порт вне 1–65535 → `400`; все попытки отказаны → `502` с `Sbx-Dial-Error: refused` (или `timeout`, если хотя бы одна попытка или общий срок 10 s истекли по времени);
- поток полный дуплекс, half-close через END_STREAM; сокеты принадлежат агенту и рвутся при его перезапуске (S2 §11).

## 13. System: информация, метрики, простой

`sbx.agent.v1.System`:

| Метод | Что | Идемпотентность |
|---|---|---|
| `Info` | версия (`current`, `previous`), os/arch, ядро, `boot_id`, время загрузки, `machine_id`, hostname, `sandbox_id`, claim (без секретов), фазы готовности, `ssh_host_keys`, состояние quiesce, состояние обновления, `idle_since`, пользователь по умолчанию | `NO_SIDE_EFFECTS` |
| `Metrics` | CPU (использование за 5 s, число ядер, load 1/5/15), память (total, available, used, swap), диски по точкам монтирования (total, used, free, inodes), сеть (rx/tx байт и скорость), число процессов, работающих команд, attach-стримов и TCP-потоков | `NO_SIDE_EFFECTS` |
| `ListPorts` | §12 | `NO_SIDE_EFFECTS` |
| `Claim`, `UpdateEnv`, `UpdateSecrets`, `UpdateSshCa` | §8 | `Sbx-Request-Id` |
| `Quiesce`, `Thaw` | §14 | `Sbx-Request-Id` |
| `ApplyUpdate` | §17.4 | `Sbx-Request-Id` |

Capabilities (`Control/Info`, S2 §10.2) — строки: `process.v1`, `process.pty`, `process.stdin`, `files.v1`, `files.upload.v1`, `files.archive.v1`, `system.claim.v1`, `system.quiesce.v1`, `system.update.v1`, `system.ports.v1`, `system.metrics.v1`.

Метрики control plane запрашивает сам, когда нужно; в журнал событий они не пишутся.

**Простой.** Раз в 10 s агент считает VM простаивающей, если одновременно:
- нет работающих команд (leftovers не считаются, их ловят следующие условия);
- нет attach-стримов и TCP-потоков через туннель;
- средняя загрузка CPU всей VM < 5% и обмен по сети и диску < 16 MiB в минуту на протяжении `[idle] window` (5 min).

Смена состояния даёт событие `idle.changed{idle, since}`. Политика auto-stop — S6.

## 14. Quiesce и thaw

### 14.1 Как это сочетается с S1

S1 сейчас реализует `QuiesceHook` через QGA `fsfreeze`, потому что агента ещё нет. После S3 в worker появляется `AgentQuiesceHook` (основная реализация): `freeze()` = `System/Quiesce`, `thaw()` = `System/Thaw`. QGA-путь остаётся **запасным**, когда агент не подключён или нет capability `system.quiesce.v1` (Docker тогда не ставится на паузу). Оба пути для одной machine одновременно не используются: worker держит блокировку на machine (S6).

### 14.2 `Quiesce{lease_ms = 30000 (≤ 120000), docker = true, fs = true}`

1. Если уже заморожено → `failed_precondition` `already_quiesced` с `lease_id`.
2. Записать lease в `/run/sbx-agent/quiesce.json` (tmpfs): `lease_id`, `deadline`, затем по ходу — список приостановленных контейнеров и замороженных mount-ов.
3. Запустить watchdog: transient unit `sbx-quiesce-watchdog-<lease_id>.service` (`sbx-agent quiesce-watchdog --lease ...`). Он ждёт `deadline` и снимает заморозку сам (§14.3). Плюс таймер внутри агента.
4. Docker: `GET /containers/json` по unix-сокету, `POST /containers/{id}/pause` для работающих (параллельно до 8, всего до 5 s). Каждый id пишется в lease **до** паузы.
5. Хуки `/etc/sbx-agent/quiesce.d/*` (исполняемые, по имени) с аргументом `freeze`, до 5 s каждый (для СУБД и т.п.; аналог QGA `fsfreeze-hook`).
6. `sync()`.
7. FIFREEZE (ioctl) на точках монтирования из `/proc/self/mountinfo`: блочные `ext4`, `xfs`, `btrfs`, не `ro`.
   - Одна точка на источник (устройство): bind-mount-ы и подтома btrfs делят superblock, и второй FIFREEZE дал бы `EBUSY`.
   - Более глубокие точки — первыми.
   - `EBUSY` на источнике, который агент ещё не замораживал (заморожено кем-то другим, например QGA), → откат и `failed_precondition` `frozen_by_other`.
8. Ответ: `{lease_id, deadline, paused_containers[], frozen_mounts[]}`.

Ошибка на шагах 4–7 → откат в обратном порядке и ошибка. Бюджет S1 на заморозку — 10 s от freeze до thaw; Quiesce должен укладываться в 5 s.

### 14.3 `Thaw{lease_id}` и авто-разморозка

- `Thaw`: FITHAW в обратном порядке (`EINVAL`, то есть не заморожено, — норма), хуки с `thaw` в обратном порядке, `unpause` контейнеров, остановка watchdog-unit-а, удаление lease, сброс буферов на диск.
- Ответ: `{auto_thawed, auto_thawed_at}`. Повтор, неизвестный или уже снятый lease → успех с `already_thawed = true`.
- Если `auto_thawed = true` и время авто-разморозки раньше конца снимка, снимок только crash-consistent. Worker (S6, через S1) повторяет снимок или помечает его.
- Watchdog по `deadline` делает то же, что `Thaw`, и оставляет маркер в `/run/sbx-agent`. Агент по маркеру шлёт `quiesce.auto_thawed{by: watchdog}`.

### 14.4 Поведение агента при заморозке и после сбоя

- Любая запись на диск может заблокироваться в любой момент, при своей или чужой заморозке. Поэтому все durable-записи идут через одного писателя `state.db`. Обработчики ждут его в пределах дедлайна своего вызова и не держат блокировок, нужных путям чтения.
- Пока FS заморожены своим lease, агент **не пишет на диск**:
  - записи `state.db` (журнал событий, ответы `requestId`) копятся в памяти (до 10 000 записей или 64 MiB) и сбрасываются при thaw;
  - события в памяти ещё **без `seq`**: `seq` присваивается при записи в `state.db`, а `Events/Subscribe` отдаёт только записанное. Если агент упадёт во время заморозки, эти события потеряются, но их `seq` не достанется другим событиям. `command.exited` восстановится из `exit.json`, порты и фазы пересчитаются;
  - мутации, которым нужна durable-запись (`Start`, `Claim`, загрузки), ждут thaw до своего дедлайна, затем `unavailable` `quiesced` (retryable);
  - чтение (attach, `GET /files`, `Stat`) работает;
  - лог агента асинхронный и неблокирующий: при переполнении буфера сообщения отбрасываются со счётчиком. Иначе journald, пишущий в замороженную FS, остановил бы агента.
- Процессы пользователя, которые пишут на диск, блокируются (так и задумано); shim пишет вывод PTY и тоже ждёт.
- **Агент перезапустился во время заморозки:** до первой записи он видит `quiesce.json` и выполняет thaw с `by: agent_start`.
- **Чужая забытая заморозка** (например, QGA-путь с упавшим worker). При старте, а затем раз в 5 s, если своего lease нет, агент в отдельной горутине делает пробную запись с `fdatasync` в state-каталог. Если она не завершилась за 15 s — FITHAW всех блочных FS и событие `quiesce.auto_thawed{by: foreign}`. 15 s больше бюджета S1 (10 s), поэтому штатный QGA-снимок это не задевает.
- Аварийная команда для QGA: `sbx-agent thaw --force` (FITHAW всех и `unpause` всех приостановленных контейнеров).

## 15. Durable-состояние

`state.db` — bbolt (pure Go, работает на Windows). Записи — protobuf, поэтому старая версия агента читает записи новой (неизвестные поля игнорируются, §17.5).

| Bucket | Ключ → значение |
|---|---|
| `meta` | версия схемы, `identity` (ссылка), `last_seq`, `acked_seq`, состояние обновления, `pty_detached_at` |
| `commands` | `command_id` → запись команды |
| `requests` | `requestId` → `{procedure, request_hash, code, response, expires_at}` |
| `events` | `seq` (big-endian) → конверт события (S2 §9.6) |
| `uploads` | `uploadId` → `{temp_path, size, created_at, last_activity, commit_result?}` |
| `claim` | claim без секретов, `secretsDigest` |

**Кэш `requestId`** (S2 §9.2). Interceptor Connect на мутирующих методах:
- hash = sha256(процедура + тело запроса);
- TTL 24 h, до 10 000 записей (при переполнении удаляются самые старые);
- ответы больше 1 MiB не кэшируются: хранится только hash и код;
- параллельный дубль ждёт первый вызов (singleflight в памяти).

**Журнал событий** (S2 §9.6):
- `seq` монотонный через перезапуски агента, с 1 после смены идентичности. Он присваивается в транзакции записи; `EventJournal.Read` (интерфейс `libs/tunnel`) отдаёт только записанные события;
- `Events/Ack(seq)` удаляет записи до `seq`;
- предел 100 000 событий или 64 MiB; при переполнении удаляются самые старые и пишется `journal.gap{from_seq, to_seq}`. Получив его, control plane сверяется через `Process/List` и `System/Info`;
- запись событий батчится в одну транзакцию bbolt (fsync на транзакцию).

## 16. События (тип → payload)

Payload — сообщения из `proto/sbx/agent/v1/events.proto`, в конверте S2 (`protobuf Any`). Это ответ на открытый вопрос S2 §19 со стороны агента; S6 добавит свои типы.

| Тип | Payload | Когда |
|---|---|---|
| `agent.started` | `version, previous_version, boot_id, reason (boot / restart / update / rollback)` | при каждом старте агента |
| `identity.reset` | `machine_id` | первое событие после смены идентичности |
| `command.exited` | `command_id, status, code, signal, reason, stdout_end, stderr_end, pty_end, ended_at` | выход команды, в том числе `LOST` после перезагрузки |
| `readiness.changed` | `phase, state, error` | смена фазы |
| `claim.applied` | `sandbox_id` | claim выполнен |
| `ports.changed` | полный список портов | изменение набора, debounce 2 s |
| `idle.changed` | `idle, since` | смена простоя |
| `quiesce.auto_thawed` | `lease_id, at, by (watchdog / agent_start / agent_stop / foreign)` | авто-разморозка |
| `disk.low`, `disk.ok` | `mount, free_bytes` | порог §10 |
| `update.result` | `from, to, ok, rolled_back, error` | после обновления или отката |
| `journal.gap` | `from_seq, to_seq` | переполнение журнала |
| `output.truncated` | `command_id, stream, reason (disk_full)` | shim не смог записать часть вывода (`ENOSPC`/`EDQUOT`); один раз на поток, агент узнаёт при подключении к shim или при выходе команды |

`command.started` не нужен: команду создаёт control plane и знает о ней из ответа `Start`.

## 17. Установка, unit-ы, обновление, восстановление

### 17.1 Пакет

`sbx-agent-<version>-linux-<arch>.tar`:
- `sbx-agent`;
- `manifest.json`: `{format: "sbx-agent-manifest/v1", version, os, arch, files: {name: sha256}, created_at}`;
- `manifest.sig` — подпись ed25519 над байтами `manifest.json`;
- `trust/tunnel-ca.pem` — бандл tunnel CA, текущий и следующий (S2 §5.4);
- `trust/update-keys.pub` — ключи обновлений, текущий и следующий.

Установка в шаблон (S5) и обновление идут одним путём: `sbx-agent install-package <tar>` проверяет подпись и раскладывает пакет в `versions/<v>`. Первичная установка доверяет ключам, вшитым в установщик (сборка из репозитория).

### 17.2 Unit-ы

```ini
# sbx-agent.service
[Unit]
Description=sbx guest agent
After=network-online.target sbx-identity.service
Wants=network-online.target sbx-identity.service
OnFailure=sbx-agent-rollback.service
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
Type=notify
ExecStart=/usr/local/lib/sbx-agent/current/sbx-agent run
Restart=always
RestartMode=direct
RestartSec=1
TimeoutStartSec=90
TimeoutStopSec=15
OOMScoreAdjust=-900
MemoryMin=64M
CPUWeight=500
IOWeight=500

[Install]
WantedBy=multi-user.target
```

- `RestartMode=direct` (systemd ≥ 254): автоматический перезапуск минует состояние failed, поэтому `OnFailure=` (откат) срабатывает только после исчерпания `StartLimitBurst`, а не на первом падении.
- `TimeoutStartSec=90`: старт до `READY=1` может ждать запасных путей идентичности (до 60 s), поэтому срок с запасом выше; задан явно, чтобы не зависеть от `DefaultTimeoutStartSec` образа. Версия, зависшая при старте, убивается через 90 s. Срок подтверждения обновления (§17.4) агент взводит сразу после quiesce Startup, до медленных шагов старта: зависшая новая версия откатывается по сроку, а перезапуск после него сразу возвращает `current` на старую версию.
- `OOMScoreAdjust=-900`, а не -1000 (как у boat): при нехватке памяти ядро сначала убивает задачи пользователя, но агент не может довести VM до паники.
- `sbx-agent-rollback.service` — oneshot `/usr/local/lib/sbx-agent/previous/sbx-agent rollback` (если `previous` нет — из `current`). Поведение описано в §17.4.
- `sbx-cmd.slice` — общий slice команд (место для будущих лимитов).
- `sbx-identity.service` — §7.2.

### 17.3 Подпись

- Ключ ed25519. **PoC:** ключ сгенерирован локально и хранится вне репозитория (`~/.config/sbx/update-signing/`). Публичные ключи (текущий и следующий) закреплены в `trust/update-keys.pub`.
- **Production:** ключ подписи держит CI, его сертифицирует offline root. Решается в S12.
- Ротация: следующий ключ закрепляется заранее, пакет, подписанный текущим ключом, приносит новую пару `trust/`.
- Инструмент подписи — подкоманда release-утилиты в `services/guest-agent` **[исполнитель]**.

### 17.4 Самообновление

1. Control plane загружает пакет через `/files/uploads` (§11.2) с подсказкой `path=/var/lib/sbx-agent/staging/` и вызывает `System/ApplyUpdate{upload_id}` (с `Sbx-Request-Id`). Агент сам ничего не скачивает: исходящий доступ VM нужен только к туннелю.
2. Агент распаковывает пакет в `staging/<v>` и проверяет:
   - подпись ключами из `current/trust`;
   - sha256 файлов;
   - `os` и `arch`;
   - что `version` ≠ текущей. Откат на старую подписанную версию разрешён: это решение control plane.
3. Перенести в `versions/<v>` и выполнить `versions/<v>/sbx-agent selftest --schema <N> --shim-protos <список>` (до 10 s). Selftest проверяет конфиг и доверенные материалы, а также что новая версия поддерживает текущую схему `state.db` и протоколы живых shim-ов. Сам `state.db` selftest не открывает: на нём эксклюзивная блокировка bbolt работающего агента.
4. Записать `pending-update.json` `{from, to, deadline = now + 120 s}` (fsync). Переключить `previous` → `from`, `current` → `to` (атомарная замена symlink через rename).
5. Ответить и выйти с кодом 0 после отправки ответа; systemd перезапускает агента (`Restart=always`) уже новой версии.
6. Новый агент видит `pending-update.json`, подключается к туннелю:
   - первый `101` и обслуженный `Control/Info` → подтверждение, `update.result{ok}`;
   - не подключился до `deadline` → вернуть `current` на `from`, выйти; старая версия пишет `update.result{rolled_back}`;
   - падает в цикле → `StartLimitBurst` → `OnFailure` → `sbx-agent-rollback.service`.
   - `sbx-agent rollback`:
     - есть `pending-update.json` → `current` = `from`, `previous` не меняется. Версия `to` записывается в `bad-versions`: control plane повторит её только явным флагом. Файл удаляется, событие `update.result{rolled_back}` уходит при следующем старте;
     - нет `pending-update.json` (падает давно стабильная версия: баг, полный диск) → версии не трогает и ждёт 30 s;
     - в обоих случаях затем выполняет `systemctl reset-failed sbx-agent` и `systemctl start sbx-agent`. Агент перезапускается бесконечно с паузой, версии туда-сюда не переключаются;
     - `rollback --to <v>` (вручную через QGA) переключает на указанную версию из уже установленных.
7. Команды и PTY не затрагиваются: shim-ы живут в своих unit-ах и работают из своих каталогов версий. Хранятся `current`, `previous` и версии с живыми shim-ами; остальные удаляет janitor.

Если туннель недоступен по причине, не связанной с обновлением, откат сработает зря. Это безопасно: control plane повторит обновление позже.

### 17.5 Совместимость состояния

- Схема `state.db` в пределах major только добавляется (новые bucket-ы и поля). Старая версия после отката работает с базой новой.
- Ломающее изменение — новый major агента с миграцией и без отката ниже него (manifest укажет `min_rollback_version` — когда понадобится).
- Протокол shim: §9.6.

### 17.6 Восстановление через QEMU guest agent

QGA (S1) — запасной канал, когда туннеля нет. Через PVE API `agent/exec` (права `VM.GuestAgent.Unrestricted` у токена S1 есть):

| Команда | Зачем |
|---|---|
| `sbx-agent doctor --json` | версии `current`/`previous`, состояние unit-ов, идентичность (без BS), состояние туннеля и последние ошибки (из `/run/sbx-agent/status.json`, агент обновляет его раз в 5 s), quiesce, свободное место |
| `journalctl -u sbx-agent -n 500 --no-pager` | лог |
| `systemctl restart sbx-agent` | перезапуск |
| `sbx-agent rollback [--to <v>]` | откат на имеющуюся версию |
| `sbx-agent thaw --force` | аварийная разморозка |
| `sbx-agent install-package <path>` | установка пакета, загруженного через QGA `file-write` чанками в `/var/lib/sbx-agent/staging/` |

Агент ниже минимальной версии по безопасности (`426`, S2 §5.3): warm-машины списываются (S6), на занятые пакет заливается через QGA и ставится `install-package`. Дальше — `recover` (перезагрузка VM).

## 18. Переносимость (для S9)

Всё зависимое от ОС — за интерфейсами, файлы `*_linux.go` / `*_windows.go`. CI собирает `GOOS=windows CGO_ENABLED=0` с первого дня.

| Интерфейс | Linux (S3) | Windows (S9, как сделано; пакеты в `services/guest-agent/internal/`) |
|---|---|---|
| `Supervisor` (запуск unit-а команды, поиск, kill) | systemd transient service через D-Bus + shim, cgroup v2 | `supervisor/windows.go`: shim запускается с `CREATE_BREAKAWAY_FROM_JOB \| DETACHED_PROCESS`, spec — в stdin, готовность — строка `READY`; живость — mutex `Global\sbx-shim-<id>`, команда — постоянный job `Global\sbx-cmd-<id>` (`winproc/job_windows.go`, `NtCreateJobObject` + `OBJ_PERMANENT`); shim — `shim/*_windows.go` |
| IPC агент ↔ shim | AF_UNIX, shimproto | то же: AF_UNIX `run\cmd\<id>.sock`, shimproto без изменений |
| `PTY` | `creack/pty` | ConPTY (`winproc/conpty_windows.go`) |
| Командная строка | `argv` как есть, `shell` = `bash -lc` (`-c` без login) | `wincmd`: правила MSVCRT, `.cmd`/`.bat` через `cmd.exe /d /s /c` (BatBadBut → `unsafe_batch_args`), `shell` = `pwsh -EncodedCommand` с эпилогом кода выхода (S9 §12.6) |
| `IdentitySource` (machineId, BS, vmgenid, bootId) | DMI sysfs, `/proc/sys/kernel/random/boot_id`; vmgenid нет | `ident/source_windows.go`: `GetSystemFirmwareTable('RSMB')` (`ident/smbios.go`), bootId = UUIDv5(machineId, счётчик `BootId` в реестре), запасной — volatile-ключ реестра; vmgenid не читается |
| `IdentityResetter` | machine-id, host keys, hostname | `ident/{apply,reset,early,seal}_windows.go`: `MachineGuid`, host keys встроенного OpenSSH, имя `SBX<12 hex>`, пароль `user` только на клоне шаблона; `identity apply --specialize`, `early` (startup-скрипт `sbx-early.cmd`) |
| `Quiescer` | Docker pause + FIFREEZE | `quiesce/{freeze,hooks}_windows.go`: только хуки `quiesce.d\*.ps1` и очистка файлов секретов; FS замораживает QGA VSS из worker |
| `PortScanner` | `/proc/net/tcp{,6}` | `ports/scan_windows.go`: `GetExtendedTcpTable` раз в 1 s, фильтр по процессам (`ports/filter.go`) |
| `Metrics` | `gopsutil` | `gopsutil` |
| `Credentials` | uid/gid/groups (`os/user` без cgo) | `process/users_windows.go`, `winapi/{logon,lsa,profile}_windows.go`: `LogonUserW` + связанный повышенный токен, пароль из LSA secret `L$sbx_user`; `root` = `SYSTEM` |
| `SecretStore` | tmpfs `noswap` | `claim/secrets_windows.go`, `claim/acl_windows.go`: `C:\ProgramData\sbx\secrets\files`, ACL SYSTEM + `user`, `FILE_ATTRIBUTE_TEMPORARY`, перезапись нулями перед удалением; `secret_env` и содержимое файлов — только в памяти |
| `ServiceManager` | systemd D-Bus | SCM (`x/sys/windows/svc`, `update/service_windows.go`, `cmd/sbx-agent/service_windows.go`) |
| Переключение версий | symlink-и `current`/`previous` | junction-ы NTFS (`update/junction_windows.go`) |
| `OutputStore` (выбивание дыр) | `fallocate PUNCH_HOLE` | sparse-файлы: `FSCTL_SET_SPARSE`, `FSCTL_SET_ZERO_DATA` с шагом 64 KiB, `FSCTL_QUERY_ALLOCATED_RANGES` (`output/store_windows.go`) |
| Файлы | POSIX | `files/*_windows.go`: пути `C:\…`, `mode`/`owner` синтезируются, `file_in_use` (S9 §12.9) |
| Локальные сокеты | `--debug-listen` (тесты) | `run\admin.sock` (SYSTEM + Administrators, клиенты `exec`, `call`), `run\env.sock` (`env --format pwsh`) — `agent/localsock_windows.go` |

Пакет Windows: `sbx-agent-<v>-windows-amd64.tar` с `sbx-agent.exe` (`sbx-release pack --os windows`, `infra/templates/agent-package.sh --os windows`). Отличия и решения реализации — S9 §24.

## 19. Proto

`proto/sbx/agent/v1/`: `process.proto`, `filesystem.proto`, `system.proto`, `events.proto`, `common.proto` (`FileInfo`, `CommandInfo`). Соглашения S2 §10: только добавления, `buf breaking`; `idempotency_level` на методах как в таблицах §9.1, §11.4, §13; ошибки — коды Connect + `ErrorDetail{code, retryable}` из `sbx.tunnel.v1`.

Коды `ErrorDetail.code` агента: `already_exists`, `command_not_found`, `command_exited`, `too_many_commands`, `start_failed`, `user_not_found`, `path_not_found`, `is_directory`, `not_directory`, `no_space`, `cross_device`, `upload_offset_mismatch`, `checksum_mismatch`, `identity_not_ready`, `already_claimed`, `not_claimed`, `quiesced`, `already_quiesced`, `frozen_by_other`, `signature_invalid`, `update_in_progress`, `shim_outdated`.

Добавлены в S9 (Windows): `unsupported_signal`, `unsafe_batch_args`, `file_in_use`, `secrets_in_use`, `secrets_pending`, `fs_freeze_unsupported`, `desktop_not_ready`. Поля proto S9 (только добавления): `CommandSpec.desktop`, `ClaimResponse.hostname_applied` (Linux всегда `true`), `QuiesceRequest.wipe_secret_files`, `PrepareStopResponse.secret_files_wiped` (Linux `true` после успешной очистки). Capability `system.quiesce.wipe_secrets.v1` объявляет только Windows-агент.

Сгенерированный код кладётся как в реализации S2: Go — в `libs/proto` (`github.com/belov38/boat-dev-clone/libs/proto/sbx/agent/v1`), TS — в `packages/proto`.

## 20. Требования к шаблону (S5)

- Ubuntu 26.04 (шаблон S1 `ubuntu-2604-dev-tpl`), systemd ≥ 257: в cmdline ядра `systemd.machine_id=firmware`. Тогда machine-id = `product_uuid` = `machineId` с самого PID 1; `sbx-identity` это учитывает (§7.2). Ядро ≥ 6.4 для `tmpfs noswap`.
- **Без swap** (ни раздела, ни swap-файла): секреты есть в памяти процессов.
- Пользователь `user` (uid 1000), группы `sudo` и `docker`, `/etc/sudoers.d/90-sbx-user`: `user ALL=(ALL) NOPASSWD:ALL`; `loginctl enable-linger user`.
- sshd: `ListenAddress 127.0.0.1` и `::1`, `PasswordAuthentication no`, `TrustedUserCAKeys /etc/ssh/sbx_user_ca.pub`. Ключи CA шаблона (если есть) — в `/etc/sbx-agent/ssh-user-ca.pub`. В `/etc/pam.d/sshd` — две строки `pam_env` из §8.2.
- cloud-init после сборки отключён (`/etc/cloud/cloud-init.disabled`) или выключены модули `ssh`, `set_hostname`, `update_hostname`, `users-groups`: идентичностью владеет агент. Сеть — netplan с DHCP по имени (`en*`), не по MAC. Диск cloud-init от S1 при этом безвреден.
- Docker (userland-proxy по умолчанию), `qemu-guest-agent`, OpenSSH.
- Агент: `sbx-agent install-package`, `agent.toml`, unit-ы включены; последний шаг сборки — `sbx-agent seal` (§7.3).

## 21. Приёмка

Где идут тесты **[исполнитель]**:
- **Unit:** фейки интерфейсов §18; хранилище, retention, кэш `requestId`, журнал, разбор smbios, CONNECT-порядок адресов.
- **Интеграция Linux в CI:** на VM раннера GitHub Actions (там systemd — PID 1 и есть sudo) под тегом `integration`: transient unit-ы и shim, cgroup, PTY, перезапуск агента, выбивание дыр, FIFREEZE на ext4 в loop-образе, Docker pause.
- **Стенд `pve`:** реальная VM из шаблона S5 (или S1 599 с установленным агентом).
- **Windows:** только кросс-компиляция (S9).

Проверки на стенде:

1. **Команды.** `Run`: вывод байт в байт (sha256), код выхода; `echo x >/dev/stderr` и `>/dev/stdout` от `user` и от root работают и не портят лог. Повторный `Start` с тем же `command_id` (в том числе после SIGKILL агента между записью и ответом) — файл-маркер создан ровно один раз. Другой spec с тем же id → `already_exists`.
2. **Перезапуск агента** (`systemctl restart`, `SIGKILL`) и **самообновление** во время 20-минутной команды и открытого PTY: команда жива, attach продолжается по offset, `exit` верный, PTY с прежним scrollback.
3. **Откат обновления:** пакет с бинарником, который сразу выходит с кодом 1 → через `StartLimitBurst` откат на предыдущую версию, `update.result{rolled_back}`. Пакет с неверной подписью → `signature_invalid`, ничего не меняется.
4. **Перезагрузка:** работающие команды → `LOST/REBOOT`, их вывод читается; секреты пропали, фаза `secrets: pending`; `UpdateSecrets` возвращает `ready`.
5. **PTY:** resize, ввод с дублями `seq` (повтор не применяется дважды), закрытие через 10 min без клиента, через 9 min ещё жив.
6. **Leftovers:** `sleep 1000 &` переживает выход команды, `has_leftovers = true`; `Kill` убивает. `on_exit: KILL_LEFTOVERS` убивает сразу.
7. **Таймаут и OOM:** `timeout_ms` → `KILLED/TIMEOUT`; процесс, превысивший память, → `KILLED/OOM`, агент жив.
8. **Retention:** команда пишет 1 GiB в stdout → занятое место команды ≤ 128 MiB + 1 s записи; attach с 0 получает `truncated`, offset-ы сходятся с размером файла.
9. **Файлы:** `Range`-скачивание 1 GiB с обрывом и докачкой (sha256); загрузка чанками с обрывом, `HEAD`, продолжение, `commit` дважды → один результат; `sha256` не совпал → `422`. Архив: каталог с вложенными каталогами, symlink-ами, hardlink-ом и файлом 1 GiB — `GET /files/archive` и `PUT /files/archive` в другой каталог дают те же sha256, режимы и цели symlink-ов; архив с `../x`, `/etc/x`, записью через symlink на `/etc` и устройством → `invalid_path`, вне `path` ничего не создано; 200 001 запись → `413`.
10. **Порты:** `python3 -m http.server` на `127.0.0.1`, `::1`, `0.0.0.0` и адресе интерфейса → `ports.changed` за ≤ 3 s; CONNECT на `localhost:<port>` работает во всех четырёх случаях; CONNECT на соседнюю VM → `403`.
11. **Quiesce:** при записи в файл и в Docker-контейнере `Quiesce` → запись блокируется, снимок S1, `Thaw`; fork из снимка загружается, данные согласованы. Без `Thaw` → авто-разморозка не позже `deadline + 5 s`, событие. `SIGKILL` агента в заморозке → разморозка при его старте. Заморозка QGA с «забытым» thaw при работающем агенте → агент размораживает через 15–20 s.
12. **Идентичность:** fork → новые machine-id, host keys, hostname, пустое состояние агента, `seq` с 1, `identity.reset` первым событием, IP отличается; исходная VM не затронута.
13. **Claim и env:**
    - env из claim виден в командах агента, в SSH login-shell и в `ssh host env` (не-login) — через gateway S4 или через локальный `ssh` с сертификатом CA;
    - env из spec перекрывает env claim;
    - `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` выставлен;
    - смена CA через `UpdateSshCa` действует без перезапуска sshd.
14. **Секреты не на диске:** уникальная строка-секрет из `secret_env`, `secret_files` и env команды не находится поиском по блочному устройству VM (`grep -a` по снапшоту LV) после `sync`; swap в VM нет или `noswap` проверен.
15. **Память:** RSS агента в простое < 40 MiB, shim < 8 MiB.
16. Совместная приёмка S2 §14 (chaos, drain, перф, терминал) с S4.

## 22. Интерфейсы к другим областям

- **S1:** `AgentQuiesceHook` — основная реализация `QuiesceHook`, QGA fsfreeze — запасная (§14.1). Smbios по S2 §5.2. QGA exec для восстановления (§17.6).
- **S2 / `libs/tunnel`** (план `s2-impl`, пакет `libs/tunnel/agent`). Агент заполняет `agent.Config`:
  - `Handler` — Connect `sbx.agent.v1` и `/files/*`;
  - `Journal` — `EventJournal` поверх `state.db` (§15);
  - `Info` — capabilities (§13);
  - `Credentials` — smbios (§7.1);
  - `Identity` — `bootId`, `agentInstanceId`, версия; `Vmgenid` на Linux пустой.

  CONNECT обслуживает сама библиотека с политикой `LocalOnly`. Для порядка адресов из §12 **нужно добавление в S2**: поле `Dial func(ctx context.Context, host string, port int) (net.Conn, error)` в `agent.Config`. При `nil` dial прямой, как сейчас; ошибка `Dial` → `502`. Ответы на открытые вопросы S2 §19: retention — §10, типы событий агента — §16.
- **S4:** порядок адресов CONNECT (§12); sshd только на loopback с `TrustedUserCAKeys` из claim (§8.3); host keys в `System/Info`; `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` в env по умолчанию.
- **S5:** требования §20, `sbx-agent seal`, `install-package`.
- **S6:**
  - claim при выдаче из warm pool; `UpdateSecrets` после каждой загрузки (по `agent.started{reason: boot}` или фазе `secrets: pending`); claim для fork с env источника;
  - блокировка на machine для quiesce, обработка `auto_thawed`;
  - политика обновлений: пакет, когда версия ниже желаемой; списание warm-машин со старым агентом;
  - потребление событий §16; auto-stop по `idle.changed`;
  - `degraded` и `journal.gap` → сверка через `List`/`Info`.
- **S7:** публичные commands (sync / stream / detached / attach / kill / list), files, ports, env/secrets поверх этих RPC.
- **S9:** интерфейсы §18.
- **S12:** production-ключ подписи (CI + offline root), ротация tunnel CA через пакеты агента.

## 23. Библиотеки

Правило проекта: последние стабильные версии, перед добавлением перепроверить (`go list -m -versions`). Проверено 2026-10-29:

| Назначение | Модуль | Версия |
|---|---|---|
| Go toolchain | `mise.toml` | go 1.27.3 |
| Туннель, Connect, protobuf, WebSocket, HTTP/2 | `libs/tunnel` и его зависимости (S2 §17): `connectrpc.com/connect`, `google.golang.org/protobuf`, `github.com/coder/websocket`, `golang.org/x/net` | v1.21.1, v1.36.12, v1.8.15, v0.62.0 |
| systemd D-Bus (transient unit-ы, свойства), sd_notify | `github.com/coreos/go-systemd/v22` (поверх `github.com/godbus/dbus/v5`) | v22.7.0, v5.2.4 |
| PTY | `github.com/creack/pty` | v1.1.24 |
| Состояние | `go.etcd.io/bbolt` | v1.5.0 |
| inotify | `github.com/fsnotify/fsnotify` | v1.10.1 |
| Метрики | `github.com/shirou/gopsutil/v4` | v4.26.9 |
| ioctl FIFREEZE, fallocate, cgroup, Windows API | `golang.org/x/sys` | v0.49.0 |
| ed25519 есть в stdlib; SSH-форматы при необходимости | `golang.org/x/crypto` | v0.58.0 |
| Конфиг | `github.com/pelletier/go-toml/v2` | v2.4.3 |

Docker Engine API — простые HTTP-вызовы по unix-сокету через stdlib, без Docker SDK (меньше зависимостей).

## 24. Оставлено исполнителю

- Структура Go-пакетов внутри `services/guest-agent` и форма интерфейсов §18.
- Формат сообщений протокола shim (protobuf с префиксом длины — рекомендация).
- Реализация подписи и release-утилиты; формат tar (с zstd или без).
- Точная очерёдность адресов CONNECT при известном слушателе (семантика §12 обязательна).
- Детали janitor-а (частота, порядок), если пределы §10 соблюдаются.
- Батчинг записей bbolt.
- Конкретные значения `GOGC`/`GOMEMLIMIT` для shim.

## 25. Открытые вопросы

- Порты Docker при `userland-proxy=false` — через Docker API (позже).
- `WatchDir`, лимиты ресурсов на команду, список всех процессов ОС (`ps`) — по запросу S7.
- Копия вывода команд вне VM (история после удаления sandbox) — фаза 2 (architecture §3).
- Principal-ы SSH-сертификатов (`user`, `root`) — S4.
- Производственный ключ подписи и offline root — S12.
