# Локальный стек (docker compose)

Сейчас в стеке: Postgres 18 (схемы и миграции), одноразовый `migrate` и `worker`.
`api`, `gateway`, `web`, `keycloak`, `oauth2-proxy` добавляют потоки S2, S7, S8, S9
(места помечены комментариями в `compose.yaml`). Proxmox остаётся реальным хостом `pve`.

## Что нужно

- Docker с compose v2.
- `~/.config/sbx` с файлами `pve-token` (mode 600), `pve-root-ca.pem`, `sbx-node_ed25519`, `known_hosts`
  (в нём должен быть pinned ключ `100.64.10.2`). Другой каталог: `SBX_PVE_SECRETS_DIR`.
- Доступ контейнеров к `100.64.10.2` (Tailscale на хосте; в Docker Desktop проверено, что порты 8006 и 22 достижимы).
- Linux-хост (без Docker Desktop): файлы секретов (`~/.config/sbx/*`, `deploy/compose/secrets/data-keys.json`) имеют mode 600 и принадлежат пользователю хоста, а контейнер работает под uid 1000 (`node`). Если uid хоста не 1000, worker не прочитает их: запускать от пользователя с uid 1000, либо выдать права (`chown 1000` на копию каталога и указать её в `SBX_PVE_SECRETS_DIR`), либо задать `user: "<uid>:<gid>"` у `worker` и `migrate` в локальном override-файле.

## Ключи данных

Каталог `deploy/compose/secrets/` в `.gitignore`. Создать один раз из корня репозитория:

```sh
mkdir -p deploy/compose/secrets && printf '{"current":1,"keys":{"1":"%s"}}\n' "$(openssl rand -base64 32)" > deploy/compose/secrets/data-keys.json && chmod 600 deploy/compose/secrets/data-keys.json
```

Формат показан в `config/data-keys.example.json` (там плейсхолдер, не настоящий ключ).

## Запуск

```sh
docker compose -f deploy/compose/compose.yaml up -d --build
docker compose -f deploy/compose/compose.yaml ps -a     # migrate: Exited (0), worker: healthy
curl -i http://127.0.0.1:9090/readyz                    # 200 {"ready":true,...}
curl -s http://127.0.0.1:9090/metrics | head
```

Состояние пула и узлов (sbx-admin внутри контейнера):

```sh
docker compose -f deploy/compose/compose.yaml exec worker node apps/worker/src/admin/main.ts pool status
docker compose -f deploy/compose/compose.yaml exec worker node apps/worker/src/admin/main.ts reconcile --dry-run
```

Логи и psql:

```sh
docker compose -f deploy/compose/compose.yaml logs -f worker
docker compose -f deploy/compose/compose.yaml exec postgres psql -U sbx -d sbx
```

Остановка. `-v` удаляет том с базой:

```sh
docker compose -f deploy/compose/compose.yaml down        # данные сохраняются
docker compose -f deploy/compose/compose.yaml down -v     # чистый старт
```

## Настройки

- `config/sbx.yaml` — шаблоны, размеры, квоты и топология `pve` (узел, хранилище `local-lvm`, сборка шаблона 599). Worker читает конфиг один раз при старте, а `up -d` не пересоздаёт контейнер, если в `compose.yaml` ничего не поменялось. Поэтому после правки:

  ```sh
  docker compose -f deploy/compose/compose.yaml up -d --force-recreate worker
  ```

  Worker перечитывает конфиг. Если менялись топология или сборки шаблонов (их в базу загружает `bootstrap`), пересоздать и `migrate`: `... up -d --force-recreate migrate worker` (bootstrap идемпотентен). То же для правок `deploy/compose/.env` и файлов секретов.
- `deploy/compose/.env` (git-ignored) переопределяет: `SBX_NODE_SSH_HOST` (по умолчанию `100.64.10.2`), `SBX_PVE_TOKEN_ID`, `SBX_PVE_SECRETS_DIR`, `SBX_RECONCILE_DRY_RUN`. URL API и TLS-имя PVE берутся из `topology.providers` в `config/sbx.yaml` (`apiUrl`, `tlsName`).
- Учётные данные Postgres `sbx/sbx/sbx` — только для разработки; порт опубликован на `127.0.0.1:5432`.
- `SBX_DB_POOL_MAX` (по умолчанию 30) — размер пула соединений worker. Блокировка питания (`power:<nodeId>`, S6 §15.1) держит по одному соединению на ноду в каждом процессе и под ней берёт ещё одно, плюс соединения pg-boss и операций. Значение должно с запасом превышать число нод.

## Что worker делает сам, а чего нет

- Reconcile работает в dry-run (`SBX_RECONCILE_DRY_RUN=1`): читает список VM на `pve` (только чтение) и логирует, что сделал бы.
- Целевые размеры пулов в `sbx.yaml` равны 0 (`pools: []`, решение 17), поэтому worker сам не создаёт VM на `pve`.
- Пока нет агента (S3) и gateway (S2), создание sandbox не может дойти до `ready`: агентский порт недоступен, а без `SBX_GATEWAY_SERVICE_TOKEN_FILE` ротация токена падает по таймауту. Worker при этом предупреждает об этом в логе при старте.
- Схему `tunnel` создаёт миграция S2 `db/migrations/0100_tunnel_init.sql` (её применяет `migrate` вместе с миграциями S6). Том, созданный раньше временной фикстурой схемы `tunnel` (до этой миграции), с ней несовместим: пересоздать его `down -v`, затем `up -d --build`.
- С `SBX_GATEWAY_SERVICE_TOKEN_FILE` worker находит gateway, который держит туннель machine, через `PgRegistry` из `@sbx/agent-client` (своё небольшое подключение к Postgres и LISTEN `tunnel_sessions`) и вызывает на нём `rotate-token`.

## Smoke-тест реального адаптера Proxmox

`apps/worker/test/pve-smoke.test.ts` гоняет `PveInfraRegistry` против хоста `pve`: create/start/shutdown,
snapshot и fork, два параллельных старта (power lock), reconcile в dry-run, затем удаляет всё созданное
и сравнивает inventory sbx-node «до» и «после». Без `SBX_PVE_SMOKE=1` тест пропускается, так что
`pnpm -r test` остаётся офлайн. Топология берётся из `config/sbx.yaml` (через `sbx-admin bootstrap`)
в свежей тестовой базе (локальный docker Postgres из global setup).

```sh
SBX_PVE_SMOKE=1 mise exec -- pnpm --filter @sbx/worker exec vitest run test/pve-smoke.test.ts
```

- Секреты: `~/.config/sbx` (или `SBX_SECRETS_DIR`); SSH-хост sbx-node: `SBX_NODE_SSH_HOST` (по умолчанию `100.64.10.2`).
- Создаёт VM только в диапазоне 500–598 из шаблона 599, по 2 vCPU / 2 GB, не больше двух одновременно запущенных.
  Перед запуском в этом диапазоне не должно быть VM: тест проверяет это в начале.
- Идёт около 90 секунд, большая часть уходит на `shutdown` (гостю шаблона не хватает 60 с, дальше идёт `stop`).

## Как добавить сервис

1. Добавить блок в `services:` в `compose.yaml`; взять `<<: *service-defaults` (логирование и сеть `sbx`) и `<<: *db-env` для `DATABASE_URL`.
2. Если сервису нужна схема БД, поставить `depends_on: migrate: condition: service_completed_successfully`.
3. Секреты класть в `deploy/compose/secrets/` (git-ignored) и подключать через `secrets:`; в git — только `*.example`.
4. Образ собирать из корня репозитория (`context: ../..`, `dockerfile: apps/<name>/Dockerfile`); `.dockerignore` лежит в корне.
5. Новый пакет workspace (`packages/<name>` или `apps/<name>`) — добавить строку `COPY <dir>/package.json <dir>/` в `apps/worker/Dockerfile` (блок манифестов в стадии `base`), иначе `pnpm install --frozen-lockfile` не совпадёт с lockfile. Если пакет входит в зависимости worker, добавить и `COPY <dir>/src <dir>/src`; если он собирается в `dist` (как `@sbx/proto` и `@sbx/agent-client`), собрать его в стадии `build` и скопировать `dist` в итоговый образ. То же в Dockerfile других сервисов.

## Запуск worker без Docker

Пакеты S6 запускаются из исходников (`node src/main.ts`), а `@sbx/proto` и `@sbx/agent-client` в рантайме берутся из `dist`. Перед первым запуском и после их изменений собрать:

```sh
mise exec -- pnpm build        # или только нужное: pnpm --filter "@sbx/agent-client..." run build
mise exec -- pnpm --filter @sbx/worker start
```

Тесты worker (`vitest`) и `typecheck` от этого не зависят: vitest берёт исходники по условию `source`, а `typecheck` сам собирает `dist`.
