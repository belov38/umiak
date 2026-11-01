# E2E на dev control plane (CT 590)

> Исторический план до R1. Действующие имена и контракты — `docs/specs/rename-umiak.md`.

Первый подъём всего стека MVP (S1–S7) на CT 590 и сценарий Ильи с Mac: `sbx login` → `create` (шаблон 597, `linux 20261030.16`) → exec → файлы → превью → ssh → fork → snapshot → stop/resume → delete, плюс TS и Python SDK. Ветка `e2e-devcp`.

## Что сделано

- `infra/dev-cp/deploy.sh` разворачивает `main` со всеми сервисами S7 (api, Keycloak, oauth2-proxy) за Tailscale Serve; gateway ходит в api internal (`http://api:8082`), worker получает `SBX_TUNNEL_URL`. Шаблон 597 активен (`sbx-admin bootstrap` в `migrate`).
- `infra/dev-cp/dev-users.sh`: пользователи realm `sbx`. `ilia@example.com` с временным паролем в `~/.config/sbx/dev-cp/ilia-initial-password` (0600, вне git) и `e2e@example.com` с постоянным паролем для сценария. Команда с ролью owner — личная команда, которую api создаёт при первом входе.
- `infra/dev-cp/e2e.sh`: весь сценарий одной командой (таблица PASS/FAIL). Помощники: `kc-browser.py` (подтверждение device grant и вход в Keycloak для SSO-порта без браузера), `e2e-pty.py` (`sbx shell` в псевдотерминале). SDK: `packages/sdk-ts/e2e/devcp.ts`, `packages/sdk-py/e2e/devcp.py`.
- `infra/dev-cp/QUICKSTART.md` для Ильи.

## Результат

`infra/dev-cp/e2e.sh` на CT 590, 2026-10-31: 20/20 PASS, около 6 минут. Create ~14 s, resume ~10 s, fork ~15 s; первая строка `exec` ~130 ms; 80 MB `cp` в каждую сторону 4 s; idle stop при `--idle 60s` через 71–81 s. После прогона на `pve` нет VM 500–589 и LV снапшотов.

## Найденные ошибки

### 1. Keycloak съедает всю память CT

- **Симптом.** Первый `deploy.sh` с S7 не завершился; CT перестал отвечать по SSH (`banner exchange` timeout), `memory.current` CT упёрся в лимит 3 GB, `memory.events high` рос. Keycloak умер с кодом 137 посреди импорта realm.
- **Причина.** JVM в Docker внутри LXC без собственного cgroup-лимита считает heap от памяти хоста (`sysinfo` не виртуализирован lxcfs, 125 GB), по умолчанию `MaxRAMPercentage=70`. Keycloak вырос до 2.5 GB RSS.
- **Исправление.** `infra/dev-cp/compose.dev-cp.yaml`: у `keycloak` `mem_limit: 1200m` и `JAVA_OPTS_KC_HEAP=-Xms128m -Xmx512m`. Базу `keycloak` после оборванного импорта удалили. Теперь Keycloak ~520 MB, весь стек ~1.1 GB из 3 GB.
- **Тест.** Unit-теста нет (поведение JVM в LXC). Проверка — деплой на CT и `docker stats`.

### 2. SSH в sandbox не работает: worker не передаёт агенту SSH user CA

- **Симптом.** `sbx ssh` → `cannot reach sshd in sandbox`; в логе gateway `backend login failed ... unable to authenticate, attempted methods [none publickey]`. В VM `/etc/ssh/sbx_user_ca.pub` пустой.
- **Причина.** Gateway входит в sshd VM сертификатом от SSH user CA (`SBX_GATEWAY_SSH_USER_CA_KEY_FILE`), а агент доверяет ключам из Claim (`ssh_user_ca_keys`). Worker берёт их из `SBX_SSH_USER_CA_KEYS_FILE`, но `deploy/compose/gateway.yaml` давал worker только токен gateway. Список был пустым в любом стеке compose.
- **Исправление.** `deploy/compose/gateway.yaml`: worker получает `SBX_SSH_USER_CA_KEYS_FILE=/run/sbx-gateway/ssh_user_ca.pub` (каталог секретов gateway уже смонтирован).
- **Тест.** `apps/worker/test/compose-wiring.test.ts` разбирает `gateway.yaml` и сверяет пару «CA gateway → `.pub` у worker». На старом `gateway.yaml` падал (`expected undefined to be '/run/sbx-gateway/ssh_user_ca.pub'`). Шаги `sbx ssh` и `plain ssh :2222` в `e2e.sh`.
- **Ограничение.** Ключ приходит только в Claim (create, fork, create --from). Resume Claim не повторяет: sandbox, созданные до исправления, остаются без SSH, а смена SSH user CA не дойдёт до существующих sandbox. См. «Открытые вопросы». Закрыто веткой `fix-resume-sshca`: шаг `provision` (resume, recover, reprovision) вызывает `System/UpdateSshCa`.

### 3. Каждый деплой, пересоздающий gateway, кладёт стек на 16 минут

- **Симптом.** Повторный `deploy.sh` висел больше 10 минут: старый gateway `unhealthy`, новый и worker в `Created`.
- **Причина.** `gateway.yaml` задаёт продовый drain (`stop_grace_period: 960s`, drain до 950 s: ждёт, пока туннели и SSH уйдут на другой экземпляр). На CT gateway один, уходить некуда, и compose ждёт весь срок, а worker зависит от gateway.
- **Исправление.** `infra/dev-cp/compose.dev-cp.yaml`: `SBX_GATEWAY_DRAIN_TIMEOUT=20s` и `stop_grace_period: 30s`. Compose берёт срок остановки у старого контейнера, поэтому первый деплой после исправления ещё раз ждал (старый gateway остановили `docker kill`); дальше пересоздание занимает секунды.
- **Тест.** Деплой на CT; `docker inspect` у gateway: `StopTimeout 30`, `SBX_GATEWAY_DRAIN_TIMEOUT=20s`.

### Мелочи по ходу (не ошибки продукта)

- Realm `sbx` берёт email как username (`registrationEmailAsUsername`), поэтому логин Ильи — `ilia@example.com`, а не `ilia`.
- Keycloak 26 требует имя и фамилию (required action `VERIFY_PROFILE`): без них вход по device grant останавливается на форме профиля. `dev-users.sh` их задаёт.
- `docker compose exec -T` читает stdin: в скрипте, переданном через `ssh … bash -s`, он съедал остаток скрипта (`</dev/null` в `dev-users.sh`).

## Открытые вопросы для master

- **SSH user CA только в Claim** (S3/S6). Агент сохраняет `ssh_user_ca_keys` из первого Claim, resume его не обновляет. Значит, ротация CA (S4 §9.3) не доходит до существующих sandbox. Нужна передача ключей при resume или отдельный вызов агента — это изменение протокола или оркестрации, в рамках e2e не делал.
- `create --from <snapshot>` не переносит env и секреты исходной sandbox (переносится диск). Похоже на задуманное поведение (env задаётся в запросе), но в спеке S7 явно не сказано.
- `sbx logs -f` выходит с `0` для команды с ненулевым кодом (спека задаёт код команды только для `exec`/`run`).
- `sbx snapshot save` без `--wait`: снапшот готов через ~2 s, сценарий ждёт `snapshot list`.
- Idle stop при `--idle 60s` срабатывает через ~80 s (шаг учёта активности).

## Закрыто веткой `fix-resume-sshca` (2026-10-31)

- SSH user CA: worker шлёт `System/UpdateSshCa` с текущим набором ключей в шаге `provision` (S6 §7.6, S3 §8.1). Протокол агента не менялся: RPC был с S3. Sandbox, созданные до настройки CA, получают ключ при следующем stop/resume.
- `sbx logs -f` выходит с кодом команды, как `exec` (S7 §14.2, §14.3); без `-f` — `0`.
- `snapshot save --wait` был и раньше, сценарий его не использовал. Теперь вывод как у других ждущих команд (JSONL `accepted` → `ready`, лимит 5 min); `e2e.sh` ждёт через `--wait`.
- `create --from <snapshot>` не переносит env и секреты — записано в S7 §8.3 как задуманное.
