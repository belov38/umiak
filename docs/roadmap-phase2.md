# Roadmap фазы 2: паритет с boat.dev и сверх него

Статус: черновик v0.1, 2026-10-29. Для master-сессии: инвентарь возможностей boat, сверка с планом S1–S13, области S14+ для brainstorm, рекомендации к MVP. Реализации и brainstorm с Ильёй здесь нет.

Источники (локальные, не в git):
- `docs:` — `research/boat-docs/pages/` (213 страниц, индекс `llms.txt`);
- `cli:` — `research/boat-cli-help/` (help 120 команд) и `docs:cli-reference.md`;
- `sdk:` — `sdks/` (OpenAPI `boat-v1.yaml`, 121 операция; SDK TS/Python, хелперы `boat_helpers.py`, `boat-helpers.ts`);
- `vr:` — `vendor-repos/` (skills, kimi-плагин, optibox, boat-convex, harbor-box, eve-box, battleships, agent-server-release).

Наш план: `docs/architecture.md`, `docs/roadmap.md`, спецификации S1, S2, S3, S4, S6. S5 и S7 пишутся в других тредах, их объём взят из roadmap; где пишу «S7», это ожидание, а не факт из спецификации.

Обновление 2026-10-29: рекомендации R1–R11 внесены в спецификации MVP. Аутентификация MVP теперь на Keycloak: `sbx login` через device flow, люди без долгих ключей, командные ключи `sbx_`, SSH-сертификаты (S7 §7, §11.3; S4 §9; S8 §20.1). Поэтому K6, K8, SH1 и S24 частично закрыты в MVP, а правило S24 «дочерний ключ не шире родителя» теряет смысл. Остаток уточняется при brainstorm S24.

## 0. Кратко

- У boat около 200 отдельных возможностей. MVP (S1–S13) закрывает ядро: жизненный цикл, fork, saved snapshots, exec/files/ports, SSH, рабочий стол, ключи, MCP. Во многих местах ядро уже сильнее boat (§3).
- Главные пробелы — **слой поверх VM**: встроенные coding-агенты (prompt/steer/events), credentials proxy, environments с версиями, skills и плагины для агентов, webhooks/OTel, история команд вне VM, CI-раннеры, адаптеры eval-фреймворков.
- Предлагаю 17 областей **S14–S30** (§4). Первая волна (P1): S21 skills/плагины, S24 ключи v2, S22 CLI/SDK v2, S14 environments, S16 credentials proxy, S15 coding-агенты.
- 11 рекомендаций к MVP (§6). Самые важные: контракт JSON/JSONL у CLI и заголовок подтверждения удаления (S7), минимальная сущность environment (нужна S13), env на fork и resume (S6), модель scope ключей «действие × ресурс» (S8), coding-агенты и инструменты в шаблоне (S5), единый формат slug (S4/S6).

## 1. Обозначения

| Знак | Значение |
|---|---|
| ✅ | Покрыто планом (указана область и раздел) |
| ✅* | Входит в объём области, у которой ещё нет спецификации (S5, S7, S8, S9, S10, S11): ожидание по roadmap или `docs/architecture.md` |
| ◐ | Частично: есть примитив или часть, нужна доработка |
| ✗ | Нет в плане |
| ⊘ | Пропускаем: коммерция, наследие boat или неприменимо к нашей архитектуре (причина в строке) |

Колонка «Решение»: куда идёт пункт (S14+ или «MVP-рек.» — см. §6) и нужен ли он внутренней платформе. Приоритеты: P1 — первая волна после MVP, P2 — вторая, P3 — по запросу.

## 2. Инвентарь возможностей boat и покрытие

### 2.1 Жизненный цикл, размеры, ОС

| # | Возможность boat | Источник | Наш план | Статус | Решение |
|---|---|---|---|---|---|
| L1 | Create: `type`, `name`, `labels`, `env`, `ttlSeconds`, `from` (saved snapshot) | `docs:concepts.md`, `docs:api/reference/sandboxes/create-sandbox.md` | S6 §7.3, S7 | ✅ | — |
| L2 | Состояния `provisioning…ready/idle/running…archived/error`; `idle/running` = работает ли prompt агента | `docs:concepts.md` | S6 §6.1; `activity busy/idle` — отдельное поле | ◐ | Состояние «агент работает» — S15 |
| L3 | Stop с финальным снапшотом; отказ stop при неудачном снапшоте, `force`, авто-force через 3 дня | `docs:snapshots/stop.md`, `docs:api/reference/sandboxes/stop-and-archive-sandbox.md` | S6 §7.5: shutdown ОС, диски остаются на ноде; жёсткий stop при таймауте | ✅ | Механизм другой: финальный снапшот не нужен |
| L4 | Хук `~/.boat/pre-stop` (60 s), Docker-контейнеры останавливаются по 30 s | `docs:snapshots/stop.md` | S6 §7.5 `PrepareStop`; graceful shutdown ОС сам гасит systemd-юниты и Docker | ◐ | Пользовательский хук — S30 (дёшево) |
| L5 | Resume тем же id на новой machine | `docs:snapshots/resume-and-fork.md` | S6 §7.6 (та же VM на той же ноде) | ✅ | — |
| L6 | Resume во время `stopping` забирает ту же machine; machine держится 10 min после stop | `docs:readiness.md`, `docs:snapshots/stop.md` | Не нужно: диски и VM остаются на ноде | ⊘ | Следствие удалённых снапшотов boat |
| L7 | Fork, в том числе работающей sandbox (из минутного снапшота, теряет до 1 min записей) | `docs:snapshots/resume-and-fork.md` | S6 §7.7: снапшот с quiesce, точная копия | ✅ | Лучше boat |
| L8 | Смена размера: `resume --type`, `fork --type`, `type_too_small` | `docs:machines/change-size.md` | S6 §7.6 шаг `resize` (CPU/RAM); рост диска нет | ◐ | Диск по размеру — S30 |
| L9 | `recover`: power-cycle, не чаще раза в 10 min; boat отказывает здоровой sandbox (`409 sandbox_is_reachable`) | `docs:troubleshooting.md`, `docs:api/reference/sandboxes/recover-sandbox.md` | S6 §7.8 (разрешён и на здоровой `ready`) | ✅ | Отказ здоровой — по желанию, S7 |
| L10 | Авто-пересборка `error` sandbox на новой machine из последнего снапшота | `docs:troubleshooting.md` | Нет: диски локальные | ✗ | С PBS-архивом — S18/S12, P3 |
| L11 | Асинхронный delete с операцией `bdop_…`, стадии `waiting_for_uploads`, `retrying` | `docs:data-retention/delete.md`, `docs:api/reference/account/get-deletion-operation.md` | S6 операция `delete`; публичный статус — S7 | ◐ | S7 (статус операции) |
| L12 | `Idempotency-Key` на create и fork, 24 h, `idempotency_in_progress`, `idempotency_key_reused` | `docs:limits.md`, `docs:recipes/parallel-agents.md` | S6 §5.7, §14.1 | ✅ | Добавить resume — S30, P3 |
| L13 | `failFast`: только из тёплого пула, ответ ≈1.5 s или `503 no_ready_machine`, ничего не создаётся; работает и с `from`, fork, resume | `docs:machines/fail-fast.md`, `sdk:openapi/boat-v1.yaml` | Нет; create из snapshot у нас всегда холодный (S6 §7.3) | ✗ | MVP-рек. R2 (для шаблонов); тёплый пул под saved snapshot — S30 |
| L14 | `count` 1–1000 при create из snapshot, всё или ничего | `docs:api/reference/sandboxes/create-sandbox.md`, `cli:new.txt` | Нет | ✗ | S30 (evals), P2 |
| L15 | Фильтры list: `state`, `namePrefix`, `label=k=v`, `stoppedBefore`, `dataExpired`, cursor | `docs:api/reference/sandboxes/list-sandboxes.md` | S6 labels, `ListFilter`; форма — S7 | ◐ | S7 |
| L16 | Переименование поддомена (`PATCH subdomain`, 3–40 символов, не на `-desktop` и `-<число>`) | `docs:hosting.md`, `docs:api/reference/sandboxes/update-sandbox.md` | S4 §4.2: грамматика slug та же, генерация и rename — S7; S6 §5.6 описывает slug иначе (10 символов `[a-z0-9]`) | ◐ | S7; формат slug — MVP-рек. R10 |
| L17 | Размеры `small…xlarge`, `GET /limits.machineTypes` с причиной недоступности | `docs:machines.md` | Sizes в Payload (S8), квоты S6 §8.5 | ◐ | `/limits` — MVP-рек. R9 |
| L18 | Резерв 512 MiB под сервисы платформы, OOM → exit 137, `oomKilled` | `docs:troubleshooting.md`, `vr:agent-server-release/install.sh` (`MemoryMin=512M`) | S3 §9.1 `reason: OOM`; §17.2 `MemoryMin=64M` только агенту | ◐ | Размер резерва (агент + раннер S15 + стример S10) — S5/S15 |
| L19 | `--setup-file` на sandbox: один раз после ready, `setupStatus`/`setupError` | `docs:setup.md` | Нет | ✗ | S14, P1 |
| L20 | Setup-скрипт репозитория на каждый create/resume/fork, `setupBlocking`, логи в `/tmp/routine-logs/` | `docs:setup.md` | S13 (клон при claim), скрипт не описан | ◐ | S13/S14 |
| L21 | Команда во время старта ждёт до 60 s, затем `409 sandbox_starting`; `sandbox_restoring` retryable | `docs:readiness.md` | Архитектура §4: ожидание агента до 30 s, `503 agent_unavailable retryable` | ◐ | S7 |
| L22 | Ленивое восстановление диска, `hydrated`, прогресс, `playbook.json` префетч | `docs:readiness.md` | Не нужно: LVM-thin локально | ⊘ | Вернуться при PBS live-restore (S18) |
| L23 | Дедупликация с базовым образом: хранится только разница | `docs:readiness.md` | Thin-снимки делят блоки с шаблоном (архитектура §5) | ✅ | — |
| L24 | `/dev/kvm` во всех sandbox (QEMU, Firecracker, Android-эмулятор) | `docs:machines/virtualization.md` | S1 §4.6: `cpu host`; гарантии нет | ◐ | MVP-рек. R6 |
| L25 | Предустановленный набор: Node/bun/deno/pnpm, Python+uv, Go, Rust, JVM, Ruby, PHP, .NET, R, GCC/Clang, Docker+Compose, gh, rg, jq, Chrome, ffmpeg, xdotool | `docs:machines/tools.md` | S5 (brainstorm идёт) | ◐ | MVP-рек. R5 |
| L26 | Предустановленные coding-агенты (`claude`, `codex`, `opencode`, `pi`, `kimi`, `vibe`, …), обновляются при подготовке machine | `docs:machines/tools.md` | Нет | ✗ | MVP-рек. R5, S15 |
| L27 | Пользователь `user` с sudo, systemd, Docker без sudo | `docs:machines.md` | S3 §4, S5 | ✅ | — |
| L28 | Always-on сервисы: systemd-юнит + без auto-stop | `docs:long-running-tasks/always-on-services.md` | S6 §12: TTL `null` по умолчанию, idle-stop отключаем `null` | ✅ | — |
| L29 | Один образ Ubuntu 24.04, своих образов нет | `docs:machines.md`, `docs:faq.md` | 4 шаблона, включая Windows | ✅ | Лучше boat; свои образы — S28 |
| L30 | `degraded` при потере связи, письмо при зависании; после 3 дней без ответа boat сам останавливает sandbox | `docs:faq.md`, `docs:troubleshooting.md` | S6 §11.1 health; `degraded` никогда не останавливается автоматически; уведомлений нет | ◐ | Уведомления — S20; авто-stop зависшей — решить в S30 |
| L32 | `GET /me`: текущий пользователь и способ входа | `docs:api/reference/account/get-current-boat-user.md` | Архитектура §9 `/me` | ✅* | S7 |
| L31 | Hetzner-резерв при нехватке ёмкости, общие vCPU | `docs:machines/virtualization.md` | Ёмкость и admission S6 §8 | ⊘ | Специфика их флота |

### 2.2 Auto-stop и TTL

| # | Возможность boat | Источник | Наш план | Статус | Решение |
|---|---|---|---|---|---|
| T1 | TTL: по умолчанию 1 h, максимум 30 d, `null` = выключен, поле `archiveAfter` | `docs:long-running-tasks/auto-stop.md` | S6 §12: TTL по умолчанию `null`, idle-stop 900 s | ✅ | — |
| T2 | `extend`: дедлайн = now + TTL | `cli:extend.txt` | S6 §7.8 | ✅ | — |
| T3 | Работающий prompt агента продлевает TTL | `docs:long-running-tasks/auto-stop.md` | Idle-stop учитывает команды и PTY | ◐ | Prompt как активность — S15 |
| T4 | Fork не наследует «без auto-stop» | `docs:long-running-tasks/auto-stop.md` | S6 §7.7: TTL не наследуется | ✅ | — |
| T5 | Таймера простоя нет (платформы строят свой) | `docs:faq.md`, `vr:optibox/docs/redesign.md` | S6 §12 idle-stop по реальной активности | ✅ | Лучше boat |
| T6 | Пробуждение по запросу (у boat нет) | `vr:battleships/research/cards/boat.json` | S4 §17, S6 §21: фаза 2 | ✗ | S30, P2 |

### 2.3 Снапшоты

| # | Возможность boat | Источник | Наш план | Статус | Решение |
|---|---|---|---|---|---|
| SN1 | Авто-снапшот раз в минуту и при stop, инкрементальный | `docs:snapshots.md` | S6 §5.5: `kind auto` зарезервирован | ✗ | S18, P2 (защита от потери диска, откат) |
| SN2 | Хранение остановленных 14 d, письмо на 11-й день, `snapshot_data_expired` | `docs:snapshots/stop.md`, `docs:data-retention.md` | S6 §15.4 `stoppedRetentionDays` (выключен) | ◐ | S25 |
| SN3 | Saved snapshot: save, `new --from`, замена по имени, бессрочно | `docs:snapshots/templates.md`, `docs:api/reference/snapshots/save-saved-snapshot.md` | S6 §7.8 | ✅ | — |
| SN4 | Командные образы: владелец — org, при деплое коллегой вычищаются логины, SSH-ключи, secret-файлы | `docs:snapshots/templates.md` | S6 §5.5 `team_id` ✅; вычистки нет (секреты в tmpfs, но логины в `~` попадут) | ◐ | S23 |
| SN5 | Share-коды `bsh_…` между аккаунтами (256 бит, хранится хеш, счётчик, отзыв) | `docs:snapshots/templates.md`, `docs:api/reference/snapshots/create-snapshot-share.md` | Нет | ✗ | S23, P3 (между командами) |
| SN6 | Список, `latest`, дерево файлов, чтение файла или tar каталога из снапшота без VM; `snapshot pull` | `docs:snapshots/download-and-delete.md`, `docs:api/reference/snapshots/get-snapshot-tree.md`, `cli:snapshot.pull.txt` | Нет | ✗ | S18, P2 (полезно и для stopped sandbox) |
| SN7 | Полная выгрузка снапшота (подписанные чанки) | `docs:api/reference/snapshots/get-snapshot-download.md` | Нет | ✗ | S18, P3 (экспорт qcow2/raw) |
| SN8 | Удаление одного, всех авто-снапшотов, saved | `docs:data-retention/delete.md` | Saved ✅ (S6 §7.8); авто нет | ◐ | S18 |
| SN9 | Откат к моменту времени (у boat нет: только последний снапшот) | `docs:snapshots/resume-and-fork.md` | Нет | ✗ | S18 (лучше boat) |
| SN10 | Что сохраняется: `/home`, изменения системных каталогов, Docker-тома и образы | `docs:snapshots/whats-saved.md` | Блочный снимок всего диска | ✅ | Лучше boat |
| SN11 | `.boatignore` | `docs:snapshots/whats-saved.md` | Неприменимо: блочные снимки | ⊘ | — |
| SN12 | Письма при диске 85% и 95%, авто-чистка кэшей | `docs:troubleshooting.md` | S3 §13 `Metrics` даёт заполнение дисков; `disk.low` (S3 §10) — только для retention логов агента | ✗ | Уведомления — S20, метрики — S19 |
| SN13 | Снимок памяти, гибернация (у boat нет) | `vr:battleships/research/cards/boat.json` | Нет | ✗ | S30, P3 |

### 2.4 Environments, секреты, репозитории

| # | Возможность boat | Источник | Наш план | Статус | Решение |
|---|---|---|---|---|---|
| E1 | Именованные environments, `base`, default, soft delete | `docs:environments.md`, `docs:environments/manage.md` | `research/07` (коллекция Payload «environments и секреты»), S13 «репозитории в environment»; спецификации нет | ◐ | MVP-рек. R3; S14 |
| E2 | Неизменяемые версии, sandbox закреплена за версией, `upgrade` (горячая доставка, стирание отозванных секретов) | `docs:environments/versions.md` | Примитивы S3 `UpdateEnv`/`UpdateSecrets` | ◐ | S14, P1 |
| E3 | Переменные и secret-файлы environment; env на sandbox (≤100, 64 KB, зарезервированные имена) | `docs:environments/secrets.md` | S6 §13.1 (env и secretFiles на sandbox, AES-GCM) | ◐ | Уровень environment — S14 |
| E4 | Переключатели `passGithub`, `passSecrets`, `passSandboxCredentials`, `passAgentsCredentials` | `docs:environments/access.md` | Нет | ✗ | S14 |
| E5 | `safeForThirdParties` и `--no-env` с вычисткой снапшота (`sandbox_securing`), поле `effective` | `docs:environments/access.md`, `docs:security.md` | Нет | ✗ | S14 (недоверенный код, подрядчики) |
| E6 | Репозитории: клон в `/home/user/<repo>`, ветка, список установок GitHub App | `docs:environments/repositories.md` | S13 | ◐ | S13 |
| E7 | Приватные registry: npm, pip, uv, Docker через var + secret-файл | `docs:environments/private-registries.md` | S13 | ◐ | S13 |
| E8 | Environments организации, ограничение доступа участникам | `docs:environments/manage.md`, `cli:env.access.txt` | Нет | ✗ | S14/S23 |
| E9 | `credentialProfileId`, `proxyAiCredentials` на environment | `docs:environments/access.md` | Нет | ✗ | S16 |
| E11 | Переопределение при fork и resume: `env` (заменяет унаследованный), `environment` (перепривязка к версии), `noEnv`, `type`, `ttlSeconds` | `sdk:openapi/boat-v1.yaml` (`ResumeRequest`, тело fork), `cli:fork.txt`, `cli:resume.txt`, `docs:environments/secrets.md` | S6 §7.7: fork принимает `name, labels, ttlSeconds, size`, env наследует; §7.6: resume — `size` и TTL | ◐ | MVP-рек. R11 (env и secretFiles); `environment` — S14 |
| E10 | Legacy `/secrets`, `/repos` (заменяют всё сразу) | `docs:api/reference/account/update-boat-secrets-setup.md` | — | ⊘ | Наследие boat |

### 2.5 Команды, процессы, история

| # | Возможность boat | Источник | Наш план | Статус | Решение |
|---|---|---|---|---|---|
| C1 | Sync exec: timeout 1–600 s (30 по умолчанию), до 8 MiB на поток, `timedOut`, `oomKilled` | `docs:long-running-tasks/background-commands.md`, `docs:api/reference/agent/execute-sandbox-command.md` | S3 §9.1 (`timeout_ms`, `reason: TIMEOUT/OOM`); лимиты и форма sync-ответа — S7 | ◐ | S7 |
| C2 | Stream NDJSON `started/stdout/stderr/exit/error` | там же | S2 §9.1, S3 §9.1 `Run` | ✅ | — |
| C3 | Detached + статус по offset + attach NDJSON (heartbeat 15 s, `reconnect` через 10 min) | `docs:api/reference/agent/attach-command.md` | S2 §9, S3 §10 | ✅ | — |
| C4 | Kill: SIGTERM группе, через 5 s SIGKILL | `docs:api/reference/agent/stop-command.md` | S3 §9.5 `Kill(grace_ms)` | ✅ | — |
| C5 | Env и пользователь на команду (у boat нет) | `vr:harbor-box/sdks/harbor_box_environment.py` | S3 §9.1 `CommandSpec.env`, `user` | ✅ | Лучше boat |
| C6 | История команд 90 d, чтение вывода по offset при остановленной sandbox | `docs:long-running-tasks/command-history.md`, `docs:api/reference/agent/read-command-logs.md` | S6 §5.8 метаданные 90 d; вывод только в VM (S3 §10, 7 d) | ◐ | S19, P2 (архитектура §12: фаза 2) |
| C7 | Захват вывода всех процессов (tty, pipe, journal), 64 KiB/s, 72 h | `docs:long-running-tasks/command-history.md` | Нет | ✗ | S19, P3 |
| C8 | `ps`: топ-12 процессов раз в 30 s, хранится 7 d, доступно у остановленной | `docs:api/reference/agent/list-sandbox-processes.md`, `cli:ps.txt` | S3 §13 `Metrics` (только число процессов) | ◐ | S19 |
| C9 | Процессы переживают рестарт агента, статус `lost`, `409 agent_outdated` | `docs:long-running-tasks/background-commands.md` | S3 §9.3 shim, вывод сохраняется | ✅ | Лучше boat |
| C10 | Лимит вывода 10 MiB/ч на аккаунт | `docs:limits.md` | S3 §10 retention по объёму | ✅ | Механизм другой |
| C11 | Веб-терминал (PTY) в API (у boat только SSH) | — | S3 §9.4, архитектура §2 (xterm.js в дашборде) | ✅ | Лучше boat |

### 2.6 Файлы

| # | Возможность boat | Источник | Наш план | Статус | Решение |
|---|---|---|---|---|---|
| F1 | Read/write JSON до 5 MiB, utf8/base64 | `docs:api/reference/agent/read-sandbox-file.md` | S3 §11.2 потоковые `/files` любого размера, `Range`, докачка | ✅ | Лучше boat |
| F2 | delete, list, info, mkdir, move, chmod | `docs:api/reference/agent/*-sandbox-file*.md` | S3 §11.4 | ✅ | — |
| F3 | Поиск по glob, grep, замена по нескольким файлам | `docs:api/reference/agent/search-sandbox-files.md`, `find-in-sandbox-files.md`, `replace-in-sandbox-files.md` | Нет (делается через exec) | ✗ | S22, P3 |
| F4 | Подписанные URL загрузки и скачивания (отдаёт сама sandbox, без авторизации, 15 min–1 h) | `docs:ssh-access.md`, `docs:api/reference/agent/create-upload-url.md` | Нет | ✗ | S22, P2 (браузер, сторонние системы) |
| F5 | Artifacts: сырые байты до 50 MiB | `docs:api/reference/agent/download-sandbox-artifact.md` | S3 `/files` | ✅ | — |
| F6 | Пути только под `/home/user` и `/tmp` | `docs:ssh-access.md` | S3 §11.1: любые абсолютные пути | ✅ | Лучше boat (evals) |
| F7 | Загрузка и выгрузка каталога одним tar (у boat только в CLI `push`/`pull`) | `cli:push.txt`, `vr:harbor-box/README.md` | S3 §11.4: «позже» | ✗ | MVP-рек. R7 |
| F8 | Наблюдение за каталогом | — | S3 §11.4: «позже» | ✗ | S22, P3 |

### 2.7 Публичные URL, порты, сеть

| # | Возможность boat | Источник | Наш план | Статус | Решение |
|---|---|---|---|---|---|
| N1 | `host <port>` → `https://<sub>-<port>.on.boat.dev`, токен по умолчанию, `public`, идемпотентно, до 50 портов | `docs:hosting.md`, `docs:api/reference/agent/expose-a-port.md` | S4 §8, S6 §5.8 (`token`/`sso`/`public`) | ✅ | Режим `sso` лучше boat |
| N2 | `--localhost` relay для сервисов на 127.0.0.1/::1 | `docs:hosting/how-it-works.md` | S3 §12: CONNECT сам перебирает loopback и адреса | ✅ | Без флага |
| N3 | `host` внутри VM: `host url` ждёт маршрут, `list`, `hide`; токен `ASCII_TOKEN` только на свои порты | `docs:hosting/host-cli.md` | Нет | ✗ | S22 (in-VM CLI) + S24 (токен sandbox), P1 |
| N4 | `?_token=` → redirect + cookie; `Cookie: _port_auth` для API-клиентов | `docs:hosting.md` | S4 §8.2–8.3 | ✅ | — |
| N5 | Ротация токена порта (у boat только через public→private) | `docs:hosting.md` | S6 §14.1 `rotatePortToken` | ✅ | Лучше boat |
| N6 | URL переживает stop/resume | `docs:hosting.md` | S6 §5.8 `hosted_ports` | ✅ | — |
| N7 | Свои домены (у boat тоже нет) | `docs:hosting.md` | S4 §17 «позже» | ✗ | S17, P3 |
| N8 | Сырые TCP/UDP-порты через публичный IP и `ufw` | `docs:hosting/firewall.md` | Нет публичных IP (решение 5 в `research/07`) | ✗ | S17: TCP через gateway, P3 |
| N9 | Firewall внутри VM; блокировка туннеля → `degraded` + webhook | `docs:hosting/firewall.md` | Туннель исходящий (S2), health S6 §11 | ◐ | Webhook — S20 |
| N10 | Egress allowlist, сетевые политики (у boat нет, API нет) | `docs:faq.md`, `vr:battleships` | S1 §4.4: статичный запрет LAN; политики на sandbox нет | ◐ | S17 (лучше boat), P2 |
| N11 | Статический egress IP, приватная сеть между sandbox (у boat нет) | `vr:battleships/research/cards/boat.json` | Нет | ✗ | S17, P3 |
| N12 | Подсказка Vite `allowedHosts` | `docs:hosting/how-it-works.md` | S4 §7.5 | ✅ | — |
| N13 | Публичный IPv6 у каждой sandbox | `docs:machines.md` | Решение 5: публичных IP нет | ⊘ | Сознательно |

### 2.8 SSH, редакторы, копирование

| # | Возможность boat | Источник | Наш план | Статус | Решение |
|---|---|---|---|---|---|
| SH1 | `ssh` с ключом от CLI, host key через API без TOFU; host key меняется на каждом resume | `docs:ssh-access.md`, `docs:api/reference/agent/configure-sandbox-ssh-key.md` | S4 §9: SSH gateway, постоянный host key gateway, ключи пользователя из S8 | ✅ | Лучше boat |
| SH2 | `POST /sshkey` добавляет ключ в `authorized_keys` | там же | Ключи в профиле пользователя (S8), сертификаты CA (S4) | ✅ | Механизм другой |
| SH3 | `forward` локальный и обратный, переподключение | `cli:forward.txt` | S4 §9.4 (`-L`, `-R`) | ◐ | Обёртка CLI — S22 |
| SH4 | `scp` (tar-over-SSH), `push` (git-aware) | `cli:scp.txt`, `cli:push.txt` | S4 SSH (scp/sftp работают) | ◐ | S22 |
| SH5 | VS Code / Cursor: скрипт пишет `~/.ssh/boat/<id>.conf` | `docs:ssh-access/editors.md` | Работает через S4 | ◐ | `sbx ssh-config` — S22 |
| SH6 | Обратный туннель к локальному MCP или Ollama | `docs:integrated-agents/customize.md` | S4 §9.4 `-R` | ✅ | — |

### 2.9 Рабочий стол, браузер, запись, computer use

| # | Возможность boat | Источник | Наш план | Статус | Решение |
|---|---|---|---|---|---|
| D1 | Moonlight WebRTC 1080p60, URL с токеном во fragment, открыть за 10 min, iframe, `overlay=0`, `theme` | `docs:desktop-streaming.md`, `docs:desktop-streaming/urls-and-security.md` | S10; архитектура §8 (URL с коротким токеном, iframe) | ✅* | Токен во fragment и окно 10 min — взять в S10 |
| D2 | noVNC (`vnc=1`, `publicAccess`) | `docs:api/reference/agent/get-desktop-streaming-url.md` | Нет | ✗ | S29, P3 (запасной путь без WebRTC) |
| D3 | Только браузер: Chrome без рамки, профили Chrome | `docs:desktop-streaming/browser-only.md`, `cli:browser.txt` | Нет | ✗ | S29, P2 |
| D4 | Запись рабочего стола в mp4 | `docs:desktop-streaming/drive-and-record.md` | Нет | ✗ | S29, P2 (демо, разбор работы агента) |
| D5 | MCP `computer` (cua-driver) зарегистрирован во всех harness | `docs:integrated-agents/computer-use.md` | S10 cua-driver; регистрация в harness нет | ◐ | S15 |
| D6 | Computer-use через HTTP API (у boat только через harness) | — | S10 §13 (MVP) | ✓ | — |
| D7 | Обои, буфер обмена | `docs:desktop-streaming/background.md` | S10 (буфер — по возможностям moonlight-web) | ◐ | S29, P3 |
| D8 | `lux` (автоматизация рабочего стола с записью демо) | `vr:cloud-sandbox-vm-skills/skills/computer-use-browser-desktop/SKILL.md` | — | ⊘ | Проприетарный инструмент; наш путь — S15 + cua |
| D9 | Anti-bot Chromium (обход CAPTCHA и детекта) | `vr:battleships/research/cards/boat.json` | — | ⊘ | Не нужно внутренней платформе |
| D10 | Рабочий стол Windows (у boat нет) | — | S9, S10 | ✅* | Лучше boat |

### 2.10 Windows-приложения

| # | Возможность boat | Источник | Наш план | Статус | Решение |
|---|---|---|---|---|---|
| W1 | Wine staging, winetricks, рецепты установщиков, 25 проверенных приложений | `docs:windows-apps.md`, `docs:windows-apps/*` | Настоящие Windows-гости (S9) | ⊘ | Не нужно: есть шаблон `windows` |
| W2 | Агент ставит приложения, saved snapshot, fork | `docs:windows-apps/agents-and-forks.md` | S9 + saved snapshot (S6) | ✅* | Skill `windows-sandbox` — S21 |

### 2.11 Встроенные coding-агенты

| # | Возможность boat | Источник | Наш план | Статус | Решение |
|---|---|---|---|---|---|
| A1 | 7 harness: Claude Code, Codex, pi, OpenCode, Prime, Kimi, Mistral Vibe; обычные бинарники на PATH | `docs:integrated-agents/harnesses-and-models.md` | Архитектура §1: не входит в фазу 1 | ✗ | S15, P1 |
| A2 | `POST /prompt`: `provider`, `model`, `reasoningEffort`, `fast`, `new`/`conversationId`, вложения в `~/attachments` (до 12 файлов, 25 MB каждый, 64 MB всего) | `docs:api/reference/agent/prompt-sandbox-agent.md`, `docs:limits.md` | — | ✗ | S15 |
| A3 | Статус prompt run: `queued → running → finished/interrupted/failed` | `docs:integrated-agents/conversations.md` | — | ✗ | S15 |
| A4 | События: cursor-poll, ETag/304, типы `prompt`, `response` (`is_streaming`, `tools`), `steer`, `usage_limit`, `compaction_complete` | `docs:api/reference/agent/list-sandbox-events.md`, `sdk:openapi/boat-v1.yaml` (последние два типа) | — | ✗ | S15 (лучше: стрим и настоящие дельты) |
| A5 | Параллельные conversations, «текущая» на shell, лимит от RAM, очередь, переживают stop и fork | `docs:integrated-agents/conversations.md` | — | ✗ | S15 |
| A6 | Steer с гарантией доставки: `native`, `native-continued`, `fallback`, `late`; `409 no_running_turn` | `docs:integrated-agents/steering.md` | — | ✗ | S15 |
| A7 | Interrupt одной или всех conversations | `docs:api/reference/agent/interrupt-running-agent-work.md` | — | ✗ | S15 |
| A8 | Смена harness посреди разговора (замороженный транскрипт) | `docs:integrated-agents/conversations.md` | — | ✗ | S15, P3 |
| A9 | Каталог моделей `GET /provider-models` (уровни reasoning, `fastMode`) | `docs:integrated-agents/harnesses-and-models.md` | — | ✗ | S15 |
| A10 | Настройка: файлы правил, MCP, skills, hooks по каждому harness | `docs:integrated-agents/customize.md` | — | ✗ | S15 + S14 (запечь через environment) |
| A11 | Короткий системный prompt и skill `boat` в sandbox | `docs:integrated-agents.md`, `docs:ai-tools.md` | — | ✗ | S15/S21 |
| A12 | Подписки (Claude Pro/Max, ChatGPT, Kimi, Mistral, Grok) с обновлением токена на сервере | `docs:integrated-agents/keys.md` | — | ✗ | S16 |

### 2.12 AI credentials и прокси

| # | Возможность boat | Источник | Наш план | Статус | Решение |
|---|---|---|---|---|---|
| AI1 | Профили credentials: именованные, default, `copyFrom`, профиль organization, `access` | `docs:ai-credentials.md`, `docs:api/reference/ai-credentials/*` | Архитектура §1: не входит в фазу 1 | ✗ | S16, P1 |
| AI2 | Ключи провайдеров (Anthropic, OpenAI, OpenRouter, DeepSeek, Moonshot, Mistral, xAI, …), Bedrock | `docs:integrated-agents/keys.md` | — | ✗ | S16 |
| AI3 | Несколько аккаунтов на credential, переключение на лету | `docs:api/reference/ai-credentials/switch-credential-account.md` | — | ✗ | S16, P3 |
| AI4 | Custom API: любой HTTPS-секрет, в sandbox `NAME` и `NAME_BASE_URL` (плейсхолдер при прокси) | `docs:api/reference/ai-credentials/set-custom-api.md` | — | ✗ | S16 (внутренние API компании) |
| AI5 | Прокси: плейсхолдеры на каждый старт, ключ только в заголовок, привязка к хосту провайдера, refresh на сервере | `docs:ai-credentials.md` | — | ✗ | S16 |
| AI6 | Учёт: запросы, ошибки, токены по дню, credential, модели, sandbox | `docs:api/reference/ai-credentials/get-ai-usage.md` | — | ✗ | S16 |
| AI7 | Блокировка AI-доступа sandbox | `docs:api/reference/ai-credentials/block-or-unblock-sandbox-ai-access.md` | — | ✗ | S16 |
| AI8 | Организация может обязать прокси («никаких настоящих ключей») | `docs:ai-credentials.md` | — | ✗ | S16 |
| AI9 | Лимит трат «сделай сам» (опрос usage + block) | `docs:ai-credentials.md` | — | ✗ | S16: встроенный бюджет (лучше boat) |
| AI10 | Цена прокси $1/день + $1/1000 запросов | `docs:ai-credentials.md` | — | ⊘ | Коммерция |

### 2.13 Организации и совместный доступ

| # | Возможность boat | Источник | Наш план | Статус | Решение |
|---|---|---|---|---|---|
| O1 | Org: создать, пригласить, роли owner/admin/member, transfer, delete | `docs:organizations.md`, `cli:org.*.txt` | S8: команды и роли из групп IdP | ◐ | Приглашения не нужны: участников даёт IdP |
| O2 | Активная org, `--org`, заголовок `X-Boat-Org` | `docs:organizations/active-wallet.md` | S8 (пользователь в нескольких командах) | ◐ | S23 |
| O3 | Shared/private sandbox, доступ `owner/use/view`, авто-private при логинах создателя | `docs:organizations/shared-sandboxes.md` | Нет | ✗ | S23, P2 |
| O4 | `share`/`unshare` с необратимой вычисткой логинов | `docs:api/reference/sandboxes/share-sandbox.md` | Нет | ✗ | S23 |
| O5 | Видимость по умолчанию для новых sandbox | `docs:api/reference/account/update-organization.md` | Нет | ✗ | S23 |
| O6 | Лимиты на участника (конкурентность, время) | `docs:organizations/seats-and-limits.md` | S6 §8.5 квоты на команду | ◐ | S23 (на пользователя) |
| O7 | Места (seats), перенос личного плана в org (`org migrate`), `org status` (активный кошелёк) | `docs:organizations/move-personal-plan.md`, `cli:org.migrate.txt`, `cli:org.status.txt` | — | ⊘ | Коммерция |

### 2.14 API-ключи и вход

| # | Возможность boat | Источник | Наш план | Статус | Решение |
|---|---|---|---|---|---|
| K1 | Bearer-ключ с префиксом | `docs:api-keys.md` | S8, архитектура §10–11 | ✅* | — |
| K2 | Действия (`sandbox.create/read/update/stop/resume/fork/delete/delete-own`, `exec`, `file.read/write`, `ssh`, `desktop`, `host`, `agent.prompt`, `snapshot.*`, `environment.*`, `account.*`) и пресеты `read-only`, `full-sandbox`, `ci`, `admin` | `docs:api-keys/scopes.md` | Архитектура §11 «ключи со scope», список не задан | ◐ | MVP-рек. R4 |
| K3 | Ограничение ключа списком sandbox и environments; ключ на одну sandbox для конечного пользователя | `docs:api-keys/scopes.md`, `docs:security.md` | Нет | ✗ | MVP-рек. R4 (модель), S24 |
| K4 | Срок жизни: по умолчанию 90 d, максимум 365 d, `never`; дочерний ключ не шире родителя | `docs:api-keys/create-and-list.md` | Не задано | ◐ | MVP-рек. R4 |
| K5 | Rotate, revoke, usage (запросы за 30 d, созданные ресурсы) | `docs:api-keys/store-rotate-revoke.md`, `cli:api-key.usage.txt` | Revoke — S8 | ◐ | S24 |
| K6 | Чувствительное только из браузерной сессии (rotate, revoke, ZDR) | `docs:account.md` | Нет | ✗ | S24 |
| K7 | Ключ sandbox внутри VM (только своя sandbox) + токен только на свои порты | `docs:api-keys/create-and-list.md`, `docs:environments/access.md` | Нет | ✗ | MVP-рек. R4 (тип ключа), S24 |
| K8 | `login --key-stdin`, браузерный вход, `logout` (отзыв сессии устройства) | `cli:login.txt`, `cli:logout.txt` | S8 `sbx login` | ◐ | `--key-stdin`, `logout` — S22 |
| K9 | Самостоятельная регистрация агента (`auth.md`, RFC 9728/8414, claim-код человеком), `WWW-Authenticate resource_metadata` | `docs:agent-auth.md` | Нет | ✗ | S24: device flow с подтверждением в SSO, P3 |
| K10 | Входы GitHub/Google/email/AgentID, связывание, закрытие аккаунта | `docs:account.md` | IdP через oauth2-proxy | ⊘ | Учётками управляет IdP |

### 2.15 События наружу и наблюдаемость

| # | Возможность boat | Источник | Наш план | Статус | Решение |
|---|---|---|---|---|---|
| EV1 | Webhooks: 6 событий, HMAC `v1=` над `delivery.timestamp.body`, 8 попыток, outbox в той же транзакции, rotate, журнал доставок, до 10 endpoint на аккаунт | `docs:webhooks.md`, `docs:api/reference/account/create-webhook.md` | S6 §5.6 `sandbox_events` (outbox), webhooks — фаза 2 | ◐ | S20, P2 |
| EV2 | Экспорт OTLP: метрики sandbox (CPU, RAM, диск, PSI) раз в 60 s и события жизненного цикла как логи; тест при сохранении, защита от SSRF | `docs:opentelemetry.md` | S12 — свои метрики платформы, экспорта на команду нет | ✗ | S20 |
| EV3 | Usage по sandbox: секунды с весом размера, `include=cost` | `docs:api/reference/sandboxes/get-sandbox-usage.md` | Нет | ✗ | S20 (showback без денег) |
| EV4 | Письма: диск, отказ stop, истечение хранения | `docs:troubleshooting.md` | Нет | ✗ | S20 (email/Slack) |
| EV5 | Журнал аудита (у boat нет) | `vr:battleships/research/cards/boat.json` | S6 `sandbox_events` 90 d | ◐ | S20 (лучше boat) |
| EV6 | `GET /limits`: остаток стартов, квоты, допустимые размеры с причиной | `docs:api/reference/account/get-boat-limits.md` | S6 §8.5 квоты | ◐ | MVP-рек. R9 |
| EV7 | Заголовки `RateLimit-Policy`, `RateLimit`; лимит стартов в минуту/час/день | `docs:limits.md` | S4 §11 лимиты gateway | ◐ | S7/S12, P3 |
| EV8 | Страница статуса, измеренный uptime 99.95% (не SLA) | `docs:compliance.md` | — | ⊘ | Операционка S12 |

### 2.16 Хранение данных и удаление

| # | Возможность boat | Источник | Наш план | Статус | Решение |
|---|---|---|---|---|---|
| DR1 | Сроки: остановленные 14 d, история 90 d / 72 h, закрытый аккаунт 30 d | `docs:data-retention.md` | S6 §15.4 (commands 90 d, events 90 d, надгробия 30 d) | ◐ | S25 |
| DR2 | ZDR: удаление данных при каждом stop, только из браузера, фраза-подтверждение | `docs:data-retention/zero-data-retention.md` | Нет | ✗ | S25, P3 |
| DR3 | `snapshots:false` (stop = удаление), `monitoring:false` | `docs:data-retention/snapshots-and-monitoring-off.md` | Нет | ✗ | S25 (эфемерные sandbox для CI и evals — P2) |
| DR4 | Заголовок `X-Ascii-Confirm-Delete: <id>` на удалениях | `docs:data-retention/delete.md` | Нет | ✗ | MVP-рек. R1 |
| DR5 | Закрытие аккаунта, GDPR | `docs:data-retention/close-account.md` | — | ⊘ | Увольнение — через IdP и S8 |

### 2.17 CI

| # | Возможность boat | Источник | Наш план | Статус | Решение |
|---|---|---|---|---|---|
| CI1 | GitHub Actions `runs-on: boat`, метки по размеру, `/from=<snapshot>`, `/debug` (30 min после падения), отказ публичных репо, до 6 h, swap 4 GB | `docs:ci.md` | Нет | ✗ | S26, P2/P3 |
| CI2 | API и CLI: обзор, репозитории, задание, логи `--follow` | `docs:ci.md`, `cli:ci.*.txt` | Нет | ✗ | S26 |
| CI3 | CLI в любом CI: статический бинарник, `--key-stdin`, `new --json`, `exec --timeout 0`, `run --push` | `docs:ci.md` | CLI — S7 | ◐ | S22 |
| CI4 | Аннотация «Out of memory» в run | `docs:ci.md` | Нет | ✗ | S26 |

### 2.18 Evals, RL, интеграции

| # | Возможность boat | Источник | Наш план | Статус | Решение |
|---|---|---|---|---|---|
| I1 | Паттерн evals: snapshot на задачу, идемпотентный create, backoff на 429/503, fork для ветвления | `docs:evals.md` | Примитивы есть (S6) | ◐ | Гайд и skill — S21/S27 |
| I2 | Harbor-адаптер `BaseEnvironment` (refuse Docker-образов, сетевых политик, GPU) | `docs:integrations/harbor.md`, `vr:harbor-box` | Нет | ✗ | S27, P3 |
| I3 | Eve-адаптер (`spawn` эмулирован через файлы) | `docs:integrations/eve.md`, `vr:eve-box` | Нет | ✗ | S27, P3 |
| I4 | Компонент Convex | `vr:boat-convex` | — | ⊘ | Convex в компании не используется (уточнить) |
| I5 | optibox: потребительский чат с быстрым общим ответом, пока VM стартует | `vr:optibox`, `docs:platform-guide/patterns.md` | — | ⊘ | Потребительский продукт; уроки взяты в S15 |
| I6 | Гайд «платформа для своих пользователей»: `--no-env`, тег арендатора, демон в VM + `host --private`, оценка числа sandbox | `docs:platform-guide.md`, `docs:platform-guide/*`, `docs:security.md` | — | ✗ | Skill `sbx-platform` — S21 |
| I7 | battleships: сравнение 366 провайдеров, 78 признаков | `vr:battleships` | — | ⊘ | Источник признаков для §3 |
| I8 | Агент-сервер в VM: systemd, `CPUWeight/IOWeight/MemoryMin=512M`, `/health`, порт 8911 входящий | `vr:agent-server-release/install.sh` | S3 §17.2 (`CPUWeight/IOWeight` те же, `MemoryMin=64M`), туннель исходящий | ✅ | Резерв памяти — см. L18 |

### 2.19 SDK

| # | Возможность boat | Источник | Наш план | Статус | Решение |
|---|---|---|---|---|---|
| SDK1 | Генерация TS и Python из OpenAPI | `docs:sdks/overview.md` | S7 (roadmap), архитектура §2 | ✅* | — |
| SDK2 | 14 хелперов: `waitUntilReady/Idle`, `waitForDesktop`, `waitForPrompt(Done)`, `streamEvents`, `streamPrompt`, `stopAndRemove`, `readText`, `writeText`, `execCommand` (повтор только при `retryable`), `streamCommand`, `followCommand` (без пропусков по offset), `runCommand` | `sdk:python/src/.../boat_helpers.py`, `sdk:typescript/src/package/src/boat-helpers.ts` | Нет | ✗ | S22 (часть — MVP-рек. R1) |
| SDK3 | HTTP/2 fetch в TS (одна сессия на origin) | `sdk:typescript/src/package/src/http2-fetch.ts` | Нет | ✗ | S22, P3 |
| SDK4 | Плоские параметры в TS, `AbortSignal` | `sdk:typescript/src/package/src/runtime.ts` | — | ✗ | S7/S22 |
| SDK5 | Python только синхронный | `docs:sdks/python.md` | — | ✗ | S22: async-клиент (лучше boat) |
| SDK6 | Хелперы загрузки и выгрузки бинарных файлов (у boat нет) | — | — | ✗ | S22 |

### 2.20 CLI

Все команды boat (`cli:*.txt`). Базовый CLI — S7. Подкоманды доменных областей идут вместе с ними.

| # | Возможность boat | Источник | Наш план | Статус | Решение |
|---|---|---|---|---|---|
| CL1 | Глобальные флаги `--api-url`, `--org`, `--json`, `--no-update`; env `BOAT_API_URL`, `BOAT_ORG` | `cli:boat.txt`, `docs:cli-reference.md` | S7 | ◐ | S7 |
| CL2 | JSON автоматически, когда stdout не TTY; JSONL у `new`, `prompt`, `events`, `conversations` (и `fork --wait`); ошибка — последняя строка `{"event":"error",…}`; exit code команды, 124 при таймауте | `docs:cli-reference.md` | Не задано | ✗ | MVP-рек. R1 |
| CL3 | `current` (последняя sandbox в этом shell), `self` (внутри VM), текущая conversation на shell | `docs:cli-reference.md` | Нет | ✗ | MVP-рек. R1 (`current`), S22 |
| CL4 | `new`: `--file PATH=LOCAL`, `--host PORT[:public]`, `--setup-file`, `--count`, `--fail-fast`, `--visibility` | `cli:new.txt` | S7 частично | ◐ | S14/S22/S30 |
| CL5 | `list --filter rspte`, `info`, `rename`, `extend`, `stop --status`, `resume` с проверкой no-op exec, `fork --wait`, `delete` с отслеживанием операции | `cli:list.txt` и др. | S7 | ◐ | S7/S22 |
| CL6 | `exec`: `--timeout 0` = detach + attach с переподключением, `--stream`, `--detach/--status/--kill/--attach`, Ctrl-C убивает | `cli:exec.txt` | S7 | ◐ | S7/S22 |
| CL7 | `run`: create → push → exec → итог времени → delete; `--keep`; sandbox сам остановится через 15 min, если CLI умер | `cli:run.txt` | Нет | ✗ | S22, P1 |
| CL8 | `push` (git-aware tar), `scp` (tar-over-SSH), `forward`, `ssh -t` | `cli:push.txt`, `cli:scp.txt`, `cli:forward.txt`, `cli:ssh.txt` | SSH-gateway S4 | ◐ | S22 |
| CL9 | `host`, `desktop`, `browser` | `cli:host.txt`, `cli:desktop.txt`, `cli:browser.txt` | S7/S10 | ◐ | S7, S29 |
| CL10 | `history`, `ps`, `events --follow` | `cli:history.txt`, `cli:ps.txt`, `cli:events.txt` | Нет | ✗ | S19, S15 |
| CL11 | `prompt`, `steer`, `interrupt`, `conversations` | `cli:prompt.txt` и др. | Нет | ✗ | S15 |
| CL12 | `snapshot`, `snapshots`, `snapshot latest/tree/pull/delete/rm/share/shares/unshare` | `cli:snapshot.*.txt` | Save/rm — S7 | ◐ | S18, S23 |
| CL13 | `env *` (15 подкоманд), `ai *` (11), `api-key *` (5), `org *` (10), `webhook *` (4), `telemetry *` (3), `ci *` (4), `data-retention *`, `deletion status` | `cli:env.*.txt`, `cli:ai.*.txt`, … | Ключи — S8 | ◐ | S14, S16, S24, S23, S20, S26, S25 |
| CL14 | `completions` с живыми id (кэш 15 s), `self-update` по каналам, авто-обновление раз в 6 h | `cli:completions.txt`, `cli:self-update.txt` | Нет | ✗ | S22 |
| CL15 | `status --check`, `limits`, `usage`, `dashboard` (одноразовый код входа) | `cli:status.txt`, `cli:dashboard.txt` | Нет | ✗ | S22, S20 |
| CL16 | `onboard` (вопрос «для себя или для третьих лиц»), `feedback` | `cli:onboard.txt`, `cli:feedback.txt` | — | ⊘ | Onboard не нужен при SSO; feedback — ссылка на канал поддержки |
| CL17 | `billing *`, `wallet *` | `cli:billing.*.txt`, `cli:wallet.*.txt` | — | ⊘ | Коммерция |

### 2.21 Для агентов: документация, skills, плагины, MCP

| # | Возможность boat | Источник | Наш план | Статус | Решение |
|---|---|---|---|---|---|
| AG1 | MCP-сервер документации `docs.boat.dev/mcp` (поиск и чтение страниц) | `docs:ai-tools.md` | Нет | ✗ | S21, P1 |
| AG2 | `llms.txt` с блоком «ключевые факты» и шпаргалкой CLI; `llms-full.txt`; любая страница как `.md` | `docs:ai-tools.md`, `llms.txt` | Нет | ✗ | S21 |
| AG3 | Фрагмент для `AGENTS.md`/`CLAUDE.md` проекта: когда брать sandbox, всегда передавать id, stop против delete | `docs:ai-tools.md` | Нет | ✗ | S21 |
| AG4 | Пакет из 13 сценарных skills (`npx skills add …`) | `vr:cloud-sandbox-vm-skills` | Нет | ✗ | S21 |
| AG5 | Плагин Kimi: `/box:setup`, `/box:new <task>`, справочные skills (CLI, API, SDK TS/Py, platform) | `vr:kimi-box-plugin` | Нет | ✗ | S21 |
| AG6 | Skill `boat` предустановлен для всех harness в sandbox | `docs:ai-tools.md` | Нет | ✗ | S15/S21 |
| AG7 | MCP-сервер управления sandbox (у boat нет) | `vr:battleships/research/cards/boat.json` | S11 | ✅* | Лучше boat; список инструментов — §5.2 |
| AG8 | Правило «не называй цены по памяти, вызови `limits`» | `docs:ai-tools.md` | — | ✗ | Аналог: «узнай шаблоны и квоты через `sbx limits`» — S21 |
| AG9 | Кнопки «открыть в Claude/ChatGPT/Cursor» на страницах документации | `docs:ai-tools.md` | — | ✗ | S21, P3 |

### 2.22 Соглашения API

| # | Возможность boat | Источник | Наш план | Статус | Решение |
|---|---|---|---|---|---|
| API1 | Конверт `{ok, type}`, ошибки `{code, message, details.retryable}`, `requestId` | `docs:api/v1.md` | S6 §14.1 `SbxError{code, retryable}`; формат — S7 | ◐ | MVP-рек. R1 |
| API2 | Cursor-пагинация `limit/cursor/sort`, `pageInfo` | `docs:api/v1.md` | S7 | ◐ | S7 |
| API3 | Асинхронные операции с 202 и опросом | `docs:api/v1.md` | S6 операции | ✅ | — |
| API4 | Префиксы id: `bx_`, `wh_`, `evt_`, `bdop_`, `bsh_` | `docs:api/v1.md` | S7 | ◐ | S7 |
| API5 | Переименование Box → boat: алиасы путей, ключей, заголовков, `Deprecation`/`Sunset` | `docs:migrating-from-box.md`, `docs:migrating-from-box/*` | — | ⊘ | Нам нечего мигрировать; политику `Deprecation` взять в S7 позже |
| API6 | Long-poll с ETag/304 для событий | `docs:api/reference/agent/list-sandbox-events.md` | S6 `waitForState` (LISTEN) | ◐ | S15 |

### 2.23 Пропускаем: коммерция и прочее

| Что | Источник | Почему пропускаем |
|---|---|---|
| Планы $20–$2000, пробный период, кредитная карта | `docs:pricing.md`, `docs:free-trial.md`, `docs:billing.md` | Внутренняя платформа без биллинга |
| Кошелёк, автопополнение, бонусы, Stripe-портал, НДС | `docs:billing.md`, `docs:billing/plan-changes.md`, `cli:wallet.*.txt` | То же |
| Платные старты сверх лимита (×1.5–3) | `docs:limits.md` | Лимиты задаёт оператор (квоты S6/S8) |
| Места в организации, умножение лимитов | `docs:organizations/seats-and-limits.md` | Команды приходят из IdP |
| Цены по размерам, поле `dollars`, `deletedCost` | `docs:pricing.md`, `docs:api/reference/sandboxes/get-sandbox-usage.md` | Заменяем учётом ресурсо-секунд (S20) |
| Платный CI, checkout пробного периода агентом | `docs:ci.md`, `docs:agent-auth.md` | Коммерция |
| Ограничения пробного периода (`trial_*`) | `docs:free-trial.md` | Коммерция |
| Поддержка по email/Discord, `feedback` | `docs:support.md` | Внутренний канал поддержки |
| SOC 2, резидентность данных ЕС | `docs:compliance.md` | Данные и так внутри компании |
| Таблицы цен конкурентов, движок цен battleships | `docs:pricing.md`, `vr:battleships/site` | Нерелевантно |

## 3. Где мы можем быть лучше boat

Слабые места boat взяты из его же документации и карточки в `vr:battleships/research/cards/boat.json`.

| Тема | У boat | У нас | Где |
|---|---|---|---|
| Windows | Нет гостей, только Wine | Windows 11 и Server Core, рабочий стол, PowerShell, ConPTY, VSS | S9, S10 |
| MCP для управления sandbox | Нет (только MCP документации) | MCP-сервер поверх API, инструменты в §5.2 | S11, S21 |
| Токены git в VM | Долгоживущий GitHub-токен в `~/.git-credentials` и `hosts.yml` | MVP: короткоживущий токен установки с минимальными правами через credential helper агента (S13). Фаза 2: git-прокси без токена в VM | S13, S16 |
| Прокси секретов | AI-ключи и custom API | Тот же механизм для git, внутренних API и registry; встроенный бюджет на AI | S16 |
| Auto-stop | TTL от старта; продлевает только работающий prompt агента | Idle-stop по реальной активности (команды, PTY, TCP); пробуждение по HTTP/SSH | S6 §12, S30 |
| Готовность | `ready` не ждёт Docker и systemd-сервисы | `ready` ждёт фазу `docker` | S3 §8.5 |
| Resume | Новая machine: меняются IP, hostname, SSH host keys | Та же VM на той же ноде, идентичность не меняется | S6 §7.6 |
| Fork работающей | Из минутного снапшота, теряет до 1 min | Снапшот с quiesce, точная копия | S6 §7.7 |
| Откат во времени | Только последний снапшот | Авто-снапшоты с выбором точки | S18 |
| Exec | Нет env и user на команду; файлы ≤5 MiB; пути только `/home/user` и `/tmp` | Env и user на команду; файлы любого размера с докачкой; любые пути | S3 |
| Терминал | Только SSH | PTY через API и xterm.js в дашборде | S3, S8 |
| SSH host key | Меняется на каждом resume | Постоянный ключ gateway | S4 |
| Доступ к портам | Только токен или публично | Ещё `sso` через корпоративный IdP | S4 §8.4 |
| Сеть | Нет egress-политик, приватной сети, статического IP | Политики на sandbox через Proxmox firewall/SDN | S17 |
| Свои образы | Нет (только saved snapshot) | Dockerfile/OCI → шаблон | S28 |
| Тома | Нет volumes | Общие тома команды (наше расширение, у boat аналога нет) | S18 |
| Гибернация | Память не сохраняется | Снапшот памяти QEMU | S30 |
| Аудит и SSO | Нет | Журнал аудита; SSO через oauth2-proxy | S8, S20 |
| События агента | Опрос раз в секунду, частичный и финальный ответ с разными id (боль optibox) | Стрим и настоящие дельты | S15 |
| Вывод команд | `/commands` обрезает до 512 KB с конца (боль optibox) | Чтение по offset, до 128 MiB на поток с вытеснением начала (`truncated`) | S3 §10 |
| GPU | Нет | Проброс GPU, если в компании есть железо | Вне плана, идея |

## 4. План фазы 2: области S14–S30

| # | Область | Что решаем | Зависит от | Размер | Приоритет |
|---|---|---|---|---|---|
| S14 | Environments v2 и setup | Именованные environments с версиями и `upgrade`; переменные, secret-файлы, репозитории, переключатели передачи (git, секреты, ключ sandbox, AI); `noEnv` и «без секретов владельца» с вычисткой диска; setup-скрипт репозитория и `--setup-file` со статусом; доступ к environment по участникам | S6, S7, S8, S13 | M | P1 |
| S15 | Встроенные coding-агенты | Harness в шаблоне (Claude Code, Codex, OpenCode, позже pi и другие); раннер в VM; `prompt`, `promptRun`, события (стрим + cursor), conversations, `steer` с режимами доставки, `interrupt`, каталог моделей, вложения, смена harness в разговоре (P3); регистрация MCP `computer` и skill `sbx` в конфигах harness; prompt как активность для idle-stop | S3, S5, S7, S10, S14, S16 | L | P1 |
| S16 | Credentials proxy | Профили credentials (личные и командные), ключи и подписки, несколько аккаунтов; привязка профиля к environment; прокси с плейсхолдерами на старт, подстановка в заголовок, привязка к хосту; custom API для внутренних сервисов; **git-прокси без токена в VM** (отложенная часть S13 переходит сюда); учёт токенов, блокировка sandbox, бюджеты; обязательный прокси для команды | S4, S8, S13, S14 | L | P1 |
| S17 | Сеть v2 | Egress-политики на sandbox или шаблон (deny-all, allowlist доменов и CIDR); приватная сеть sandbox одной команды; статический egress IP; TCP-порты наружу через gateway; свои домены | S1, S4, S12 | M | P2 |
| S18 | Снапшоты v2 | Авто-снапшоты по расписанию с откатом к точке; snapshot-now; fork из снапшота по id; дерево и чтение файлов снапшота без VM (thin-снимок read-only на ноде); `snapshot pull` и экспорт; архив остановленных в PBS и восстановление на другую ноду (вместе с S12); общие тома (volumes, наше расширение) | S1, S6, S12 | L | P2 |
| S19 | История и наблюдаемость в sandbox | Копия вывода команд вне VM (90 d) и чтение у остановленной; `history`; захват вывода всех процессов (journal, tty); `ps` с хранимыми сэмплами; ряды CPU/RAM/диска (заполнение диска — для уведомлений S20); дашборд History | S3, S6, S7 | M | P2 |
| S20 | События наружу | Webhooks (события жизненного цикла, HMAC, повторы, журнал доставок) из outbox S6; экспорт OTLP метрик и событий на команду; usage в ресурсо-секундах для showback; журнал аудита; уведомления email/Slack (диск, ошибки, хранение) | S6, S7, S8 | M | P2 |
| S21 | Агентам: skills, плагины, документация | Пакет skills (справочные + сценарные, §5.1; часть сценарных выходит вместе с S14, S15, S16, S22); плагин Claude Code со slash-командами и `.mcp.json`; манифесты для Codex, OpenCode, Cursor, Kimi; skill `sbx` внутри sandbox; `llms.txt`, `.md` для страниц, MCP-сервер документации; фрагмент для `AGENTS.md`; гайды evals и «sandbox на задачу» | S7, S11; S14, S15, S16, S22 для части skills | M | P1 |
| S22 | CLI и SDK v2 | `run`, `push`, `scp`, `forward`, `ssh-config`, `ssh -t`; `current`/`self`; `login --key-stdin`, `logout`, `status --check`, `dashboard`; completions с живыми id, self-update; in-VM `sbx` и `host` (на ключе sandbox из S24); хелперы SDK (ожидания, `runCommand`, `followCommand`, стримы, загрузка файлов), плоские параметры и HTTP/2 в TS, async-клиент Python; подписанные URL файлов; поиск, замена и наблюдение за каталогом в файлах | S7, S4, S24 | M | P1 |
| S23 | Команды и совместный доступ | Shared/private, доступ `owner/use/view`, авто-private при логинах создателя; `share`/`unshare` с вычисткой; вычистка логинов при деплое командного образа; share-коды между командами; лимиты на пользователя; выбор активной команды | S8, S14, S16 | M | P2 |
| S24 | API-ключи v2 и вход агентов | Ключи с ресурсами (sandbox, environments), сроки, дочерний не шире родителя; rotate, usage; операции только из браузерной сессии; ключ sandbox и токен портов внутри VM; device flow для агента с подтверждением в SSO; `WWW-Authenticate` с `resource_metadata` | S8 | S | P1 |
| S25 | Хранение данных и удаление | Сроки хранения остановленных и истории с предупреждениями; эфемерные sandbox (stop = delete); выключение мониторинга; ZDR на команду. Публичный статус удаления — в S7 | S6, S18, S19 | S | P3 |
| S26 | CI-раннеры | Эфемерные раннеры GitHub Actions (или GitLab — по ответу S13): метки размеров, `from=<saved snapshot>`, `debug`, отказ публичных репо, лимит времени; API и CLI заданий и логов; аннотация OOM | S13, S22; S28 по желанию | M | P2/P3 |
| S27 | Evals и адаптеры | Harbor `BaseEnvironment`, Eve backend, по запросу E2B-совместимая обёртка; гайд RL/evals; использует пакетный create и тёплый пул под snapshot из S30 | S7, S22, S28, S17, S30 | M | P3 |
| S28 | Свои образы и шаблоны v2 | Шаблон из Dockerfile/OCI или скрипта (сборка на ноде, кэш); пользовательские шаблоны команды; версии и откат; каталог шаблонов в админке | S5, S9 | L | P2 |
| S29 | Рабочий стол v2 | Computer-use API уже в MVP (S10); здесь: браузер-только с профилями Chrome; запись рабочего стола; noVNC; буфер обмена, обои | S10, S9 | M | P2 |
| S30 | Жизненный цикл v2 | Пробуждение остановленной sandbox по HTTP/SSH (gateway держит запрос); гибернация через снапшот памяти QEMU; пакетный create (`count`); тёплый пул под saved snapshot (для `failFast` с `from`); идемпотентность resume; рост диска при смене размера; пользовательский pre-stop хук; политика для зависших `degraded` | S1, S4, S6 | L | P2 |

Порядок волн:
1. **P1** сразу после MVP: S21 (справочные skills и плагин дёшевы и сразу полезны агентам с MVP) и S24 → S22 (S22 строит in-VM CLI на ключе sandbox из S24), затем S14 → S16 → S15 (S15 зависит от двух предыдущих).
2. **P2**: S20, S17, S29, S30, S28, S19, S23, S18.
3. **P3**: S26, S27, S25. S26 поднять в P2, если Илья подтвердит спрос на CI-раннеры.

### 4.1 Подробности областей

**S14. Environments v2 и setup.**
- Цель: настройки, которые sandbox получает при старте, задаются один раз и обновляются контролируемо.
- Содержание:
  - environment: переменные, secret-файлы (пути от home), репозитории (из S13), credential-профиль (S16), переключатели передачи;
  - неизменяемые версии; sandbox закреплена за версией; `upgrade` горячо через S3 `UpdateEnv`/`UpdateSecrets`, у остановленной — при resume;
  - `noEnv` и «без секретов владельца»: перед первым доступом вычистить с диска логины, `~/.git-credentials`, `~/.claude`, `~/.codex`, ключ sandbox (у boat: `sandbox_securing`);
  - setup-скрипт репозитория на каждом старте и одноразовый `--setup-file`; статус `setupStatus`/`setupError`;
  - лимиты env (100 переменных, 64 KB, зарезервированные имена);
  - доступ к environment команды по участникам.
- Опора: `docs:environments/*`, `docs:setup.md`.

**S15. Встроенные coding-агенты.**
- Цель: `POST /prompt` запускает harness в sandbox, клиент получает поток событий, может направить (steer) или прервать агента.
- Содержание:
  - раннер в VM — отдельный сервис или модуль guest agent (решить в brainstorm), процесс на conversation под shim S3;
  - нормализованный формат событий (`prompt`, `response` дельтами, `tool_use`, `tool_result`, `steer`, `usage_limit`, `compaction`); стрим (NDJSON/SSE) и cursor-опрос;
  - conversations переживают stop и fork, потому что история лежит на диске;
  - steer: нативно (Claude Code, Codex) или interrupt + продолжение; режим доставки в событии;
  - каталог моделей; вложения; лимит параллельных conversations по RAM;
  - конфиги harness при старте: MCP `computer` (S10), skill `sbx` (S21), файлы правил; слияние с пользовательскими;
  - prompt и ожидание агента считаются активностью для idle-stop.
- Уроки optibox: настоящие дельты, без двойного ответа; `cwd` всегда явный; идемпотентность `prompt` по ключу.
- Опора: `docs:integrated-agents/*`, `vr:optibox/docs/*`.

**S16. Credentials proxy.**
- Цель: в sandbox не попадают настоящие ключи к AI, git и внутренним API.
- Содержание:
  - профили credentials (личные и командные), ключи и подписки; OAuth/device flow для подписок; refresh только на сервере;
  - прокси (сервис рядом с gateway или в нём): плейсхолдер на каждый старт, проверка, подстановка в `Authorization`/`x-api-key`, привязка к хосту, учёт токенов из ответа провайдера;
  - custom API: `NAME` и `NAME_BASE_URL`;
  - git-прокси без токена в VM на том же механизме (в S13 MVP — короткоживущий токен через credential helper, прокси отложен; владелец — S16);
  - привязка профиля к environment (`credentialProfileId`, S14);
  - блокировка sandbox; бюджеты на sandbox, пользователя, команду с авто-блоком;
  - команда может обязать прокси.
- Вопросы к brainstorm: куда направлять трафик (`*_BASE_URL` или прозрачный MITM с CA в шаблоне); как быть с Bedrock SigV4.
- Опора: `docs:ai-credentials.md`, `docs:integrated-agents/keys.md`.

**S17. Сеть v2.**
- Содержание:
  - политики egress на уровне PVE firewall (IPSet на VM) или SDN; домены через DNS-прокси с allowlist;
  - API политики на sandbox и шаблон, наследование при fork;
  - приватная VNet команды;
  - egress через выделенный NAT IP;
  - TCP-порты наружу через gateway (L4 по SNI или по порту);
  - свои домены (ACME HTTP-01/DNS-01). Переименование slug — S7 (S4 §4.2).
- Опора: `docs:hosting/firewall.md`, `vr:battleships`, S1 §4.4, S4 §17.

**S18. Снапшоты v2.**
- Содержание:
  - контроллер авто-снапшотов (`kind auto`): интервал, хранение N последних, при stop;
  - откат sandbox к снапшоту и fork из снапшота по id;
  - чтение снапшота без VM: node-agent активирует thin-снимок read-only, монтирует и отдаёт дерево и файлы через API;
  - экспорт;
  - архив остановленных в PBS и восстановление на другую ноду (стык с S12);
  - тома (volumes): отдельный LV, подключаемый к sandbox команды (у boat нет, наше расширение; одновременное подключение к нескольким VM требует общей ФС — решить в brainstorm).
- Риски: блокировки LVM при частых снимках, место в thin pool (метрика, лимит).
- Опора: `docs:snapshots/*`, `vr:optibox/docs/scenario-timetravel-design.md` (точки отката нужны и boat-пользователям).

**S19. История и наблюдаемость в sandbox.**
- Содержание:
  - агент отправляет вывод команд в хранилище (S3 offset-ы позволяют догружать) — объектное хранилище или Postgres с компрессией;
  - чтение истории у остановленной sandbox;
  - захват вывода прочих процессов через journald и tty с лимитами;
  - сэмплы `ps` и метрик раз в 30 s, хранение 7 d;
  - вид History в дашборде.
- Опора: `docs:long-running-tasks/command-history.md`.

**S20. События наружу.**
- Содержание:
  - webhooks из `sandbox_events` (S6 §5.6): подпись HMAC, повторы, журнал доставок, ротация секрета;
  - события `ready`, `stopped`, `error`, `degraded`, `recovered` и новые (`agent.turn_finished` из S15);
  - OTLP-экспорт метрик и событий на команду с тестом при сохранении;
  - usage в ресурсо-секундах по sandbox, пользователю, команде;
  - журнал аудита (кто, что, когда, с какого ключа);
  - уведомления email/Slack.
- Опора: `docs:webhooks.md`, `docs:opentelemetry.md`.

**S21. Агентам: skills, плагины, документация.** Подробно в §5.

**S22. CLI и SDK v2.**
- Содержание:
  - `run` (create → push → exec → итог → delete, авто-stop через 15 min, если CLI умер);
  - `push` (git-aware tar через `/files/archive` или SSH), `scp`, `forward`, `ssh-config` для VS Code/Cursor;
  - `current` и `self`; completions; self-update;
  - in-VM CLI: `sbx` и `host` внутри sandbox на ключе sandbox из S24 (`host url` ждёт маршрут);
  - `login --key-stdin`, `logout`, `status --check`, `dashboard` (одноразовый вход), `ssh -t`;
  - SDK-хелперы как у boat плюс загрузка файлов, плоские параметры и HTTP/2 в TS, async-клиент Python;
  - подписанные URL файлов через gateway; поиск, замена, наблюдение за каталогом.
- Опора: `docs:cli-reference.md`, `sdk:*/boat_helpers*`.

**S23. Команды и совместный доступ.**
- Содержание:
  - видимость sandbox, уровни доступа, авто-private при логинах создателя;
  - `share` с вычисткой логинов;
  - командные образы с вычисткой при деплое коллегой;
  - share-коды образов между командами;
  - лимиты на пользователя;
  - активная команда для CLI и заголовок команды.
- Опора: `docs:organizations/shared-sandboxes.md`, `docs:snapshots/templates.md`.

**S24. API-ключи v2 и вход агентов.**
- Содержание:
  - ключи, ограниченные набором sandbox и environments;
  - rotate и usage; операции только из браузерной сессии;
  - ключ sandbox (видит только себя) и токен портов в VM;
  - device flow для агента: агент получает код, человек подтверждает в дашборде под SSO;
  - `WWW-Authenticate` с `resource_metadata` (RFC 9728) — заодно OAuth для MCP (S11).
- Опора: `docs:api-keys/*`, `docs:agent-auth.md`.

**S25. Хранение данных и удаление.**
- Содержание:
  - политики хранения остановленных sandbox и истории (с предупреждением за N дней);
  - эфемерные sandbox (stop = delete, без снапшотов) для CI и evals;
  - выключение мониторинга;
  - ZDR для команды.
- Публичный статус операций удаления — в S7 (L11).
- Опора: `docs:data-retention/*`.

**S26. CI-раннеры.**
- Содержание:
  - GitHub App (или webhook GitLab), очередь заданий, JIT-раннер в эфемерной sandbox;
  - метки `sbx`, `sbx-large`, `sbx/from=<snapshot>/debug`;
  - отказ публичных репозиториев; лимит 6 h;
  - логи и статус в API/CLI; аннотация OOM;
  - Windows-раннеры на шаблоне `windows-core` (у boat нет).
- Опора: `docs:ci.md`.

**S27. Evals и адаптеры.**
- Содержание:
  - Harbor `BaseEnvironment`: использует per-command env/user, абсолютные пути, tar каталогов, сетевые политики S17, образы из S28 — то, что harbor-box вынужден отклонять;
  - Eve backend с нативным `spawn` через detached + attach;
  - E2B-совместимая обёртка, если её попросят фреймворки компании;
  - гайд RL/evals; пакетный create и тёплый пул под snapshot берутся из S30.
- Опора: `docs:evals.md`, `vr:harbor-box`, `vr:eve-box`.

**S28. Свои образы и шаблоны v2.**
- Содержание:
  - сборка шаблона из Dockerfile или скрипта поверх базового шаблона (RUN-шаги в VM, затем seal и регистрация сборки S5);
  - кэш по hash Dockerfile;
  - пользовательские шаблоны команды с квотой;
  - версии и откат;
  - Windows: тот же пайплайн поверх S9.
- Опора: `vr:harbor-box/README.md` (Terminal-Bench требует образы), `vr:battleships` (custom image).

**S29. Рабочий стол v2 и computer-use API.**
- Содержание:
  - API и MCP-инструменты computer-use через cua-driver для Linux и Windows;
  - браузер-только поток с профилями Chrome;
  - запись mp4 с выгрузкой;
  - noVNC как запасной путь;
  - буфер обмена, обои, `overlay=0`.
- Опора: `docs:desktop-streaming/*`, `docs:integrated-agents/computer-use.md`.

**S30. Жизненный цикл v2.**
- Содержание:
  - пробуждение по запросу: gateway (S4) держит HTTP-запрос или SSH-соединение и вызывает resume;
  - гибернация: `qm suspend --todisk` или снапшот с vmstate (проверить время и размер на LVM-thin);
  - пакетный create с `count`;
  - тёплый пул под saved snapshot, чтобы `failFast` и массовый старт работали и с `from` (сейчас create из snapshot всегда холодный, S6 §7.3);
  - `Idempotency-Key` на resume;
  - рост диска при смене размера;
  - пользовательский хук `~/.sbx/pre-stop` (сохранить состояние приложения перед stop);
  - что делать с долго `degraded` sandbox (boat останавливает через 3 дня, S6 §11.1 не трогает).

## 5. Интеграции для агентов (подробно)

### 5.1 Skills и плагины

Что есть у boat:
- `vr:cloud-sandbox-vm-skills` — 13 сценарных skills, ставятся через `npx skills add` в Claude Code, Codex, OpenCode, Cursor. Каждый: когда использовать → почему → предпосылки → рецепт на bash → ограничения. Наш пакет примерно такой же: в нём 14 сценарных skills, набор и рецепты под `sbx` и наши шаблоны.
- `vr:kimi-box-plugin` — плагин Kimi Code (`kimi.plugin.json`) с командами `/box:setup`, `/box:new` и 18 skills: те же 13 сценарных (с правками) и 5 справочных (CLI, API, SDK TS, SDK Python, platform).
- В sandbox для всех harness предустановлен skill `boat`.
- Манифеста для Claude Code и `.mcp.json` у boat нет.

Наш пакет (репозиторий `sbx-agent-kit` или каталог `integrations/agent-kit` в монорепо; строится вместе с CLI, версии совпадают).

**Справочные skills:**

| Skill | Содержание |
|---|---|
| `sbx-cli` | Установка и вход (`sbx login`, ключ из env, `--key-stdin`); глобальные флаги; `current`/`self`; жизненный цикл; exec/ssh/push/forward/desktop; снапшоты; **контракт JSON/JSONL**: `jq 'select(.event=="ready")'`, строка ошибки, коды выхода; особенность stdin в PowerShell |
| `sbx-api` | Base URL, авторизация, конверт, таблица кодов ошибок с `retryable` и действием; машина состояний; таблица эндпоинтов; цикл на curl; 502 = «могло выполниться» |
| `sbx-sdk-ts`, `sbx-sdk-py` | Конфигурация, поток create → ждать → работа → очистка в `finally`; хелперы и их фреймы |
| `sbx-mcp` | Список инструментов, когда MCP, а когда CLI, длинные задачи через detached + опрос |
| `sbx-platform` | Sandbox на задачу или на пользователя, шаблон → fork, демон в VM + порт с токеном, квоты, что переживает stop/resume/fork |

**Сценарные skills** (триггер в `description` решает, сработает ли skill):

| Skill | Сценарий | Основа у boat | Когда |
|---|---|---|---|
| `run-untrusted-code` | Недоверенный или сгенерированный код: `timeout`, удаление в `trap`, без секретов | есть | MVP (флаг из R3); полностью — S14 |
| `code-execution` | Интерпретатор кода на настоящей машине | есть | MVP |
| `offload-build-test` | Сборки и тесты вне хоста; до S22 — create + exec + delete, после — `sbx run --push .` | `cloud-sandbox` | MVP, упрощается в S22 |
| `docker-sandbox` | Docker/Compose + порт наружу | есть | MVP |
| `ephemeral-ci` | Чистое окружение CI, артефакты обратно | есть | MVP |
| `delegate-to-agent` | Отдать задачу coding-агенту в sandbox (`sbx prompt`, события, steer) | `agent-sandbox` | S15 |
| `parallel-agents` | Подготовить базу, stop, fork N (свой env на копию — R11), собрать через git | есть | MVP |
| `long-running-service` | systemd, без TTL, idle-stop, что переживает stop | `background-worker` | MVP |
| `expose-port` | Публичный URL: `token`/`sso`/`public`, bind на 0.0.0.0 не нужен | `expose-localhost-tunnel`, `public-url-hosting` | MVP |
| `dev-box-ssh` | Удалённая машина разработчика, VS Code Remote | `cloud-vm`, `linux-server-ssh` | MVP |
| `computer-use-desktop` | GUI и браузер: рабочий стол, computer-use (Linux и Windows) | есть | S10; API — S29 |
| `windows-sandbox` | PowerShell, Windows-приложения, GUI на Windows-шаблоне | нет у boat | S9 |
| `private-repo-work` | Приватные репо: в MVP короткоживущий токен (S13), без токена — S16 | нет у boat | S13 |
| `evals-per-task` | Snapshot на задачу, идемпотентный create, backoff | `docs:evals.md` | MVP |

**Правила во всех skills** (из boat, адаптировано):
- ждать `ready` перед exec;
- очистка в `trap`/`finally`; по умолчанию stop, а не delete;
- повторять только при `retryable: true`;
- не передавать секреты в prompt, URL и аргументах;
- URL с токеном, ключи и ссылки рабочего стола — секреты, в логах редактировать;
- всегда передавать id (в скриптах `current` не работает);
- квоты и шаблоны узнавать через `sbx limits`, не по памяти.

**Slash-команды** (плагин):

| Команда | Что делает |
|---|---|
| `/sbx:setup` | Ставит CLI, входит (ключ из env или браузер), проверяет `sbx limits --json` |
| `/sbx:new <задача>` | Создаёт sandbox, копирует входные данные, выполняет, возвращает результат или URL, по умолчанию stop |
| `/sbx:list` | Список sandbox пользователя с состоянием |
| `/sbx:cleanup` | Stop или delete sandbox, созданных в этой сессии (по метке) |
| `/sbx:desktop [id]` | Ссылка на рабочий стол |
| `/sbx:fork <n> <задача>` | Fork N копий и параллельный запуск (после S15 — через `prompt`) |

**Упаковка:**
- `skills/*/SKILL.md` в формате agentskills: установка `npx skills add <внутренний репозиторий>` для Claude Code, Codex, OpenCode, Cursor;
- плагин Claude Code: `.claude-plugin/plugin.json`, `marketplace.json` во внутреннем marketplace, `commands/`, `.mcp.json` с нашим MCP (Streamable HTTP, ключ из env или OAuth);
- Codex, OpenCode, Cursor, Kimi: каталоги skills + регистрация MCP их командами (`codex mcp add`, `opencode.json`, `mcp.json`, `kimi.plugin.json`). Форматы манифестов проверить на момент S21: они быстро меняются;
- skill `sbx` в шаблонах для всех harness (S15): как sandbox управляет собой через in-VM CLI.

**Документация для агентов:**
- `llms.txt` с блоком ключевых фактов (шаблоны, размеры, квоты, сроки, таймауты, события) и шпаргалкой CLI;
- `llms-full.txt`; каждая страница доступна как `.md`;
- MCP документации (`search_docs`, `read_page`) — можно как инструменты нашего же MCP-сервера;
- фрагмент `AGENTS.md`/`CLAUDE.md` для проектов.

### 5.2 Список инструментов MCP-сервера (S11 и фаза 2)

Обновление 2026-10-29: итоговый список MVP — `docs/specs/s11-mcp.md` (38 инструментов). `computer_*` и `desktop_url` вошли в S11; `files_mkdir`, `files_move`, `sandbox_extend` не вводятся; добавлены `files_edit`, `sandbox_recover`, `computer_move`, `computer_clipboard_*`; `exec_input` и PTY — S22. Таблица ниже — исходный черновик.

Транспорт: Streamable HTTP за `api.<domain>` (Bearer-ключ, позже OAuth по RFC 9728 через S24) и stdio через `sbx mcp`. Аннотации инструментов: `readOnlyHint` и `destructiveHint`. Delete требует повторить id (как заголовок подтверждения).

Длинные операции: `exec_start` + `exec_output` с offset, без удержания одного вызова. Вывод в ответе обрезается с явным `next_offset`.

| Инструмент | Что делает | Область |
|---|---|---|
| `templates_list` | Шаблоны и размеры, доступные пользователю | S11 |
| `limits_get` | Квоты и остаток, допустимые размеры с причиной | S11 (MVP-рек. R9) |
| `sandbox_create` | template, size, name, labels, env, ttl, idle, from, failFast; ждёт `ready` (опция) | S11 |
| `sandbox_list`, `sandbox_get` | Фильтры по состоянию и меткам | S11 |
| `sandbox_stop`, `sandbox_resume`, `sandbox_fork`, `sandbox_extend`, `sandbox_update` | Жизненный цикл | S11 |
| `sandbox_delete` | С подтверждением id | S11 |
| `exec_run` | Синхронно с таймаутом: exit, stdout/stderr с обрезкой | S11 |
| `exec_start`, `exec_output`, `exec_kill`, `exec_list` | Detached, чтение по offset, kill | S11 |
| `files_read`, `files_write`, `files_list`, `files_stat`, `files_delete`, `files_mkdir`, `files_move` | Файлы (чтение диапазоном) | S11 |
| `port_expose`, `port_list`, `port_unexpose` | URL порта (`token`/`sso`/`public`) | S11 |
| `snapshot_save`, `snapshot_list`, `snapshot_delete` | Saved snapshots | S11 |
| `desktop_url` | Ссылка на рабочий стол | S11 (после S10) |
| `computer_screenshot`, `computer_click`, `computer_type`, `computer_key`, `computer_scroll`, `computer_drag` | Computer-use | S11 (поверх S10 §13) |
| `agent_prompt`, `agent_events`, `agent_steer`, `agent_interrupt`, `agent_conversations` | Встроенные агенты | S15 |
| `history_list`, `history_output`, `processes_list` | История и процессы | S19 |
| `env_list`, `env_get`, `env_set_var`, `env_add_repo` | Environments | S14 |
| `snapshot_tree`, `snapshot_read_file`, `snapshot_restore` | Снапшоты v2 | S18 |
| `docs_search`, `docs_read` | Документация платформы | S21 |

Ресурсы MCP (по желанию): `sbx://<id>/files/<path>`, `sbx://<id>/commands/<cmd>/output`.

### 5.3 Интеграции с фреймворками и eval-харнессами

| Интеграция | Что делаем | Область |
|---|---|---|
| Harbor (Terminal-Bench и др.) | `BaseEnvironment` на Python: exec с env/user, абсолютные пути, tar каталогов, сетевые политики, образ задачи из Dockerfile | S27 (+S17, S28) |
| Eve | `SandboxBackend` с нативным `spawn` | S27 |
| E2B-совместимый SDK | Обёртка поверх нашего API для фреймворков, которые умеют только E2B (LangChain, OpenAI Agents SDK и др.) — только при спросе | S27, P3 |
| Claude Agent SDK / свой агент в sandbox | Пример как в `vr:harbor-box/sdks/harbor-box-evals`: агент в VM, траектория JSONL выгружается | S21 (гайд) |
| CI | GitHub Actions/GitLab раннеры; `sbx run` в любом CI | S26, S22 |
| Convex, optibox | Не делаем | ⊘ |

## 6. Рекомендации master к MVP (S1–S13)

Пробелы, которые дешевле закрыть сейчас, чем менять после релиза.

| # | Область | Рекомендация | Почему сейчас |
|---|---|---|---|
| R1 | S7 | Зафиксировать **контракт CLI**: JSON автоматически, когда stdout не TTY; JSONL с событием `ready` у `new`/`fork --wait`; ошибка — последняя строка `{"event":"error","code",…}`; код выхода команды и 124 при таймауте; `current`. В API: заголовок подтверждения удаления (`Sbx-Confirm-Delete: <id>`), `retryable` и `requestId` в каждой ошибке. В SDK — хелперы `waitUntilReady`, `runCommand`, `streamCommand` | На этом контракте строятся skills, MCP, CI и скрипты; менять после релиза — ломать всех. Подтверждение удаления защищает от ошибок агентов |
| R2 | S6, S7 | `failFast` на create из шаблона: только тёплый пул, иначе `503 pool_exhausted`, ничего не создаётся. С `from` create у нас всегда холодный (S6 §7.3), поэтому там `failFast` либо отклоняется, либо ждёт тёплого пула под snapshot (S30) | Пул уже есть (S6 §9), это одна ветка admission; нужно evals и агентам, чувствительным к задержке |
| R3 | S7/S8, S13 | Минимальная сущность **environment** (переменные, secret-файлы, репозитории, default) и флаг «без секретов пользователя» на create. Решить владельца: коллекция Payload (S8) + применение при claim (S6) | S13 кладёт репозитории в environment, а сущности нет ни в одной спецификации. Версии и upgrade — потом (S14) |
| R4 | S8 | Модель scope ключей сразу как **действие × ресурс** со сроком жизни: действия как у boat (§2.14 K2), ограничение списком sandbox и environments (по желанию — шаблонов), срок по умолчанию 90 d, дочерний ключ не шире родителя. Зарезервировать тип ключа «sandbox» (видит только свою sandbox) для in-VM CLI | Менять семантику выданных ключей потом — миграция и риск для безопасности; S22/S24 строятся на этом |
| R5 | S5 | В шаблон `linux` положить CLI coding-агентов (`claude`, `codex`, `opencode`), наш `sbx` CLI и набор инструментов по `docs:machines/tools.md` (Node+pnpm, Python+uv, Go, Rust, Java, Docker+Compose+buildx, gh, rg, jq, Chrome, ffmpeg, xdotool) | Пользователи начнут запускать агентов через exec и SSH задолго до S15; S15 опирается на версии в шаблоне |
| R6 | S1, S5 | Проверить `/dev/kvm` в госте (вложенная виртуализация на хосте, `cpu host` уже в S1 §4.6) и записать: гарантия платформы или нет | Docker уже есть; Android-эмулятор, Firecracker, QEMU-тесты в CI требуют KVM. `cpu host` мешает живой миграции между разными CPU — решение влияет на S12 |
| R7 | S3/S7 | Поднять `/files/archive` (tar каталога вверх и вниз потоком) из «позже» в v0 или в S7 | Без него `sbx push`, выгрузка артефактов и адаптеры evals делают по вызову на файл (боль harbor-box) |
| R8 | S11 | Взять список инструментов §5.2 как вход brainstorm S11, включая шаблон длинных задач (detached + опрос) и аннотации `destructiveHint` | S11 — главный канал для агентов и наше отличие от boat |
| R9 | S7 | `GET /v1/limits`: квоты команды и остаток, допустимые шаблоны и размеры с причиной | Квоты есть (S6 §8.5); агентам нужно проверять перед массовым стартом, skills ссылаются на `sbx limits` |
| R10 | S4, S6, S7 | Согласовать формат slug: S6 §5.6 пишет «10 символов `[a-z0-9]`», S4 §4.2 — `[a-z0-9]+(-[a-z0-9]+)*`, 3–40 символов, по умолчанию три слова, rename в S7 | Slug виден в URL портов и SSH; противоречие между спецификациями нужно снять до реализации |
| R11 | S6, S7 | `env` и `secretFiles` на fork (заменяют унаследованные) и на resume. Сейчас fork принимает только `name, labels, ttlSeconds, size` (S6 §7.7), resume — `size` и TTL (§7.6) | Центральный сценарий parallel-agents и evals: своя задача или секрет на каждую копию. Перешифровка `sandbox_secrets` для цели уже есть в §7.7, доработка мала |

Не трогать в MVP (уже решено хорошо или ждёт фазы 2): idle-stop по активности, точный fork, `sso`-порты, постоянный SSH host key, вывод команд через shim — это наши преимущества (§3).

## 7. Открытые вопросы для brainstorm фазы 2

- S15: раннер агентов — часть guest agent (Go) или отдельный сервис в VM (TS, ближе к SDK harness)?
- S16: прокси через `*_BASE_URL` или прозрачный MITM с CA в шаблоне; что делать с SigV4 (Bedrock) и OAuth-подписками.
- S17: домены в allowlist через DNS-прокси или только IP/CIDR в PVE firewall.
- S18: объектное хранилище для истории и экспорта (S19 тоже) — MinIO/S3 в кластере или Postgres.
- S26: GitHub или GitLab (ответ Ильи по S13).
- S27: нужна ли E2B-совместимость — какие фреймворки используют в компании.
- GPU: есть ли в компании железо для проброса.

## Приложение. Покрытие источников

- Документация: прочитаны все 213 страниц `docs:` (по разделам: guide и платформа — 35, environments/hosting/ssh/desktop/windows/ci/evals/otel/webhooks/data-retention — 34, agents/AI/orgs/keys/billing/SDK — 29, `cli-reference.md` — 1, API reference — 113 страниц + `api/v1.md`) и `llms.txt`. Все 113 страниц API reference сопоставлены с 121 операцией OpenAPI; 8 операций без страниц (4 CI и 4 скрытых `named-snapshots`). В документации упомянуты эндпоинты, которых нет в OpenAPI: `GET /provider-models`, `POST /sandboxes/{id}/browser`, ручки agent-auth.
- CLI: прочитаны все 120 файлов `cli:` и `docs:cli-reference.md`.
- SDK: `sdk:openapi/boat-v1.yaml`, хелперы Python и TS, `http2-fetch.ts`, README.
- Vendor: `vr:cloud-sandbox-vm-skills` (13 skills), `vr:kimi-box-plugin` (2 команды, 18 skills), `vr:optibox`, `vr:boat-convex`, `vr:harbor-box`, `vr:eve-box`, `vr:battleships` (карточки, сравнение), `vr:agent-server-release` (скрипты установки).
- Расхождения в источниках boat: лимит запросов с IP 1000/мин против 10 000/60 s (`docs:limits.md`); `provider` у prompt обязателен по схеме, но необязателен по тексту; `boat_starting` против `sandbox_starting`.
