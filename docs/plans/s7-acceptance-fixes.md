# S7: доработки по итогам приёмки и подключение агента S3

> **Для исполнителей:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development и superpowers:test-driven-development. Шаги — чекбоксы `- [ ]`.

**Цель:** закрыть замечания приёмки S7 (master, 2026-10-30): слияние `main` с S5, детерминированные тесты, мелкие хвосты, подключение настоящего агента S3 (`ConnectAgentApi`), хранение `outputTruncated`, диапазоны миграций в roadmap.

**Спецификация:** `docs/specs/s7-public-api.md` (включая §23), `docs/specs/s3-guest-agent.md`, `proto/sbx/agent/v1`. Предыдущий план: `docs/plans/s7-public-api.md` (глобальные ограничения оттуда действуют).

## Глобальные ограничения

- Всё, что в «Глобальных ограничениях» `docs/plans/s7-public-api.md`, плюс: на CT 590 и `pve` ничего не запускать; внешние туннели и relay-сервисы запрещены; workflow GitHub — только `workflow_dispatch`.
- Миграции: `0200–0299` — runtime (S6 и изменения таблиц runtime из S7), `0300–0399` — S7. Новая колонка в таблице S6 из этой работы — в `03xx` (указание master), с комментарием в миграции.
- Тесты должны быть детерминированными под полной параллельной нагрузкой `pnpm -r test`: ожидания по условию, фейковые таймеры или точный учёт offset-ов, без фиксированных `sleep` как условия корректности.

## Задачи

### Task A1: слияние `main` (S5)
- [ ] `git merge origin/main` (голова `f1dbbbe` или новее). Конфликты: `pnpm-lock.yaml` — пересоздать (`pnpm install`), не править руками; `deploy/compose/README.md` — объединить оба текста; `deploy/compose/config/sbx.yaml` — оставить из S5 `vmidMax: 589` и запись сборки шаблона для 598, сохранить наши нейтральные дефолты адреса PVE; `docs/specs/s1-proxmox-foundation.md` — объединить (наши нейтральные дефолты + правки S5).
- [ ] `pnpm install --frozen-lockfile`, `pnpm -r typecheck`, `pnpm lint`, `pnpm build`, тесты затронутых пакетов (worker, bench, config, template-builder) — зелёные. Commit merge.

### Task A2: детерминированные тесты, уборка контейнеров
- [ ] `apps/api/test/pty.test.ts` (около 825–833, «ping every pingMs…») и `apps/api/test/commands-stream.test.ts` (около 93–95, `stdoutOffset` 150001 против 149996): найти причину недетерминизма и устранить (ожидание по условию, фейковые таймеры, точный учёт offset-ов — например, дождаться, пока фейк агента запишет весь вывод, или проверять offset по фактическому размеру потока). Просмотреть остальные тесты `apps/api`, `packages/sdk-ts`, `apps/cli`, `packages/sdk-py` на тот же класс проблем (фиксированные `sleep`/таймауты как условие) и исправить найденное.
- [ ] Postgres-контейнеры тестов (`packages/db/src/testing/global-setup.ts`) убираются и при SIGKILL родителя: например, контейнер с `--rm` и сторожевым процессом/`--label` + уборка «осиротевших» контейнеров с этой меткой и мёртвым владельцем при следующем старте (pid владельца в метке), если это реализуемо без хрупкости.
- [ ] Доказательство: `pnpm -r test` три раза подряд зелёный (вывод итогов каждого прогона в отчёт).

### Task A3: мелкие хвосты
- [ ] `sbx login --key-stdin` (`apps/cli/src/commands/login.ts` ~124): ключ — первая непустая строка, лишний текст (вторая строка) → ошибка аргументов; формат и CRC проверяются локально (`isWellFormedApiKey`), понятное сообщение, код выхода 2, до любого сетевого запроса. Тесты.
- [ ] `apps/api/src/http/body-limit.ts`: для маршрута чанков загрузки (`PUT /files/uploads/{upload}`) вместо общего дедлайна 60 s — таймаут простоя/прогресса (нет новых байт N секунд), общий дедлайн остаётся для прочих ограниченных тел. Тест с медленным, но непрерывным клиентом проходит; застывший клиент получает ошибку.
- [ ] PTY WebSocket: `offset` за концом потока завершённой PTY-команды → закрытие с ошибкой `range_not_satisfiable` (кадр `error` и код закрытия, согласованный с §10.2), без бесконечных переподключений; тест.

### Task A4: `ConnectAgentApi` — настоящий агент S3
- [ ] `apps/api/src/agent/connect.ts`: `ConnectAgentApi implements AgentApi` поверх `AgentClient.transport(machineId)` и сгенерированных клиентов `@sbx/proto/agent/v1` (`Process`, `Filesystem`, `System`), по разделу «Wiring S3» в `apps/api/README.md` и по примеру `apps/worker/src/adapters/agent-connect.ts`: enum `*_UNSPECIFIED`, нули → `null`, `bigint` ↔ `number` с проверкой безопасного целого, `Sbx-Request-Id` для мутаций, `resumableAttach`, таблица ошибок (`AgentCallError` для ответов агента с деталью, `AgentUnavailableError`/`Unavailable` — недоступность), `files()` через `AgentClient.fetch`, capabilities из `tunnel.tunnel_sessions`.
- [ ] `DeadlineExceeded` (и прочие «исход неизвестен») на мутациях без идемпотентного ключа (файловые `makeDir`/`move`/`chmod`/`remove`, `updateEnv`/`updateSecrets`, input без сессии, signal) → `retryable: false`, `details.outcome: "unknown"`; повторяемые чтения остаются `retryable: true`. Тесты на уровне маршрутов.
- [ ] `startApi` использует `ConnectAgentApi` (вместо `UnwiredAgentApi`), конфигурация как у worker (service token, PgRegistry).
- [ ] Интеграционные тесты против настоящего агента: небольшая Go-программа в модуле `services/guest-agent` (например, `services/guest-agent/cmd/sbx-agent-harness`), которая, как `services/guest-agent/test/harness`, поднимает в одном процессе настоящий gateway S2 (реестр в переданной Postgres, internal listener на loopback-порту) и настоящий агент с фейковыми зависимостями ОС, регистрирует machine и печатает JSON `{internalUrl, serviceToken, machineId}`; TS-тесты (`apps/api/test/agent-real.test.ts`) запускают её (сборка через `go build` в global setup или `go run`), прогоняют через api с `ConnectAgentApi` сценарии: команды (sync, stream, detached, attach по offset, input, kill, signal), PTY, файлы (content с Range, uploads, stat/list/mkdir/move/remove, archive), порты. Если фейковые зависимости агента не позволяют сценарий на macOS — тест помечается и объясняется в отчёте; всё, что работает, должно идти в `pnpm -r test` (с пропуском, если нет `go`). Добавить модуль в `go.work`, если нужно (`go work use`).

### Task A5: `outputTruncated` в БД, roadmap
- [ ] Миграция `03NN_command_output_truncated.sql`: колонка в `runtime.commands` (по указанию master — в диапазоне S7, с комментарием, что таблица S6); Drizzle-схема; core: `completeCommand`/обработчик событий пишут её (из `exit`/`command.exited`/`output.truncated`); ресурс Command отдаёт сохранённое значение, когда агент недоступен. Тесты core и api.
- [ ] `docs/roadmap.md`: зарезервированные диапазоны миграций (`0200–0299` runtime: S6 и изменения таблиц runtime, `0300–0399` S7); §23 спеки — что изменилось в этой работе.

### Task A6: полная проверка
- [ ] `pnpm install --frozen-lockfile`, `pnpm -r test` три раза подряд зелёный, `pnpm lint`, `pnpm build`, `pnpm -r typecheck`; compose smoke с нуля (без `pve`); финальное ревью всех изменений этой работы свежим субагентом; push `s7-impl`.
