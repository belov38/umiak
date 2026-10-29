# S6: исправления по итогам приёмки `eb9d214`

> **Для исполнителей:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development и superpowers:test-driven-development. Каждый регресс-тест из `/tmp/s6acc-repros/` сначала копируется в репозиторий и падает (red), затем исправление (green).

**Цель:** закрыть находки приёмки (H1, M1–M4, LOW), убрать фикстуру `tunnel` после слияния S2 и подключить `@sbx/agent-client`.

**Спецификация:** `docs/specs/s6-control-plane.md`; основной план — `docs/plans/s6-control-plane.md` (решения 1–17 действуют).

## Глобальные ограничения

- Те же, что в основном плане: mise, `.ts`-импорты, без `erasableSyntaxOnly`-нарушений, секреты не в логах и не в данных заданий, комментарии на английском.
- Правки `packages/pve` разрешены для H1/M2, минимальные и с тестами (master перепроверит поведение S1).
- `pve` свободен; правила хоста прежние, подключение по IP (`100.64.10.2`, TLS name `pve`).

## Review Focus

1. Повторный delete одной machine после переиспользования VMID другой sandbox не трогает чужую VM (H1).
2. Зависшее задание `machine-events` после kill -9 не блокирует события machine дольше ~30–60 s (M1).
3. Старт после fencing-out не выполняется (M3).
4. Admission на нескольких нодах не даёт `40P01` наружу (M4).
5. Ни один секрет не попадает в `operations.request.bodyHash` в восстановимом виде.

---

### Task F1: S2 в main — убрать фикстуру `tunnel`, подключить `@sbx/agent-client`

- Удалить `packages/db/test/fixtures/0100_tunnel_init.sql`, `packages/db/src/tunnel-fixture.ts`, флаг `sbx-admin migrate --tunnel-fixture`, тест `apps/worker/test/admin.test.ts` про фикстуру и его упоминания в compose и README; миграция `db/migrations/0100_tunnel_init.sql` из `main` — единственный источник схемы `tunnel`. Drift-тест зелёный.
- `HttpGatewayPort` находит владельца machine через `PgRegistry` (`@sbx/agent-client`) вместо своего SQL; на `421` — `registry.invalidate` и повтор; нет маршрута → временная ошибка. Где ещё S6 читает реестр (health: свежесть gateway, `resolveAgentTarget`) — оставить SQL или перейти на `Registry`, решение записать.
- `AgentPort` остаётся `UnavailableAgentPort` (proto S3 нет).
- Docker-образ worker собирает `@sbx/proto` и `@sbx/agent-client` (у них `dist`), compose поднимается.

### Task F2: H1, M2, M3 — операции питания и удаления с проверкой владельца

- S1 (`packages/pve`): `Machines.delete/stop/start` принимают необязательный `expectedOwner` (machineId); под блокировкой питания ноды (S6) и непосредственно перед действием S1 читает lease VMID и отказывает (`OwnerMismatchError`, постоянная), если `lease.ownerId !== expectedOwner` (lease нет — для delete допустимо только если VM тоже нет).
- Worker: все delete/stop/start/shutdown machine идут с `expectedOwner = machineId`; при `OwnerMismatch` machine считается уже удалённой (для delete) или операция падает с `machine_state_conflict` (для start).
- M2: откат create/fork в S1 (`machine.ts:283-290`) выполняется под той же блокировкой питания ноды (через колбэк/обёртку, которую передаёт S6-адаптер), а не вне её.
- M3: после получения блокировки питания старт перепроверяет fence (`fence.check()`), иначе `FencedOut` без вызова Proxmox.
- Регресс-тесты: `zz-acc-vmid-reuse.test.ts`, `zz-acc-power-lock-rollback.test.ts`.

### Task F3: M1, M4 и дешёвые LOW

- M1: `heartbeatSeconds: 30` у `machine-events` и аудит всех очередей (`QUEUES`): у каждой очереди, чьи задания могут жить дольше секунд, есть heartbeat; явный `expireInSeconds`, где нужно.
- M4: `admitCold` блокирует ноды в порядке `node_id`; `40P01`/`40001` в транзакциях сервиса → повтор транзакции (до 3 раз), затем `out_of_capacity` (retryable). Регресс: `zz-acc-lock-order.test.ts`.
- `allocate()` одного владельца параллельно возвращает существующий lease (`zz-acc-allocator.test.ts`).
- Slug в форме UUID или с префиксом id (`sb_` и др. из S7 §5.3) отклоняется (`zz-acc-slug-uuid.test.ts`).
- Global setup тестового Postgres удаляет контейнер вместе с томом (`docker rm -f -v`).
- `bodyHash` — HMAC-SHA256 на ключе, выведенном из текущего ключа данных (`KeyRing`), а не голый sha256; то же для `idempotency_keys.request_hash`, если в нём секреты.
- Fork проверяет `enabled` шаблона и пороги хранилища, как create.
- `apps/worker/test/machine-prep.test.ts:358` — ожидание по условию вместо 150 ms.
- Recover после неудачного resume с уменьшением размера: учёт RAM по фактическому размеру VM (если просто), иначе — известная проблема в отчёте.
- `failFast`/`pool_exhausted`: комментарий в коде — не часть публичного контракта MVP, S7 не выставляет.
- Спека S6 §6.1: добавить `machine_state_conflict` (одобрено master-ом).

### Task F4: проверка

- `pnpm -r test`, `pnpm lint`, `pnpm -r typecheck`, `pnpm build`; регресс-тесты red→green; `SBX_PVE_SMOKE=1` на `pve` с пустым world diff; `docker compose up`; push `s6-impl`.
