# Roadmap: области для brainstorm

Каждая область — отдельный тред T3 Code (независимые области идут параллельно, каждая в своём git worktree и ветке): brainstorm → спецификация в `docs/specs/` → согласование с пользователем. После согласования спецификации brainstorm-тред закрывается (settle), реализация идёт в отдельном треде и ветке `sN-impl` (план в `docs/plans/`), master сливает ветки в main. Архитектура: `docs/architecture.md`.

Ограничения PoC на `pve`: VMID от 500, не больше 8 GB RAM на всё, хранилище `local-lvm`. Разрешено создать пользователя, токен, pool и SDN Simple zone + VNet. Существующие VM, LXC и `vmbr0` не трогать.

| # | Область | Что решаем | Зависит от | Статус |
|---|---|---|---|---|
| S1 | **Proxmox foundation** | Подготовка хоста (пользователь, токен, pool, SDN Simple zone + VNet, firewall); драйвер LVM-thin; примитивы machine (из шаблона, start/stop, snapshot с хуком quiesce, fork, delete); выделение VMID и MAC; транспорт операций на ноде (`node-agent` на Go или SSH); стенд для замеров | — | ✅ спецификация `docs/specs/s1-proxmox-foundation.md`; ✅ реализация в main (126/126 проверок стенда, цифры в §11; 4 раунда независимой приёмки) |
| S2 | Протокол туннеля агент ↔ gateway | Формат на проводе, auth, мультиплексирование, переподключение, `requestId`, offset, реестр `machine → gateway` | — | ✅ спецификация `docs/specs/s2-tunnel-protocol.md`; ✅ реализация в main (`libs/tunnel`, `@sbx/agent-client`; 4 раунда независимой приёмки, включая атаки агента) |
| S3 | Guest agent v0 (Linux) | exec / files / ports, claim, смена идентичности, quiesce, установка и обновление | S2 | ✅ спецификация `docs/specs/s3-guest-agent.md`; реализация (ветка `s3-impl`) |
| S4 | Gateway | Приём туннелей, HTTP-прокси `*.sbx`, маршрутизация, несколько экземпляров, позже SSH gateway и TURN | S2 | ✅ спецификация `docs/specs/s4-gateway.md`; реализация (ветка `s4-impl`) |
| S5 | Шаблон Linux | Сборка образа (cloud-init / Packer), встроенный агент, версии шаблонов | S1, S3 | ✅ спецификация `docs/specs/s5-linux-template.md` |
| S6 | Ядро control plane | Модель данных, машины состояний sandbox и machine, worker, warm pool, оркестрация create / stop / resume / fork / delete | S1, S2 | ✅ спецификация `docs/specs/s6-control-plane.md`; ✅ реализация в main (`packages/core`, `apps/worker`, `deploy/compose`; 2 раунда приёмки с chaos-тестом и проверкой на `pve`) |
| S7 | Публичное API v1 | Hono + OpenAPI, генерация SDK, CLI | S6 | ✅ спецификация `docs/specs/s7-public-api.md` |
| S8 | Web (Payload) | Админка, клиентский дашборд, JIT-пользователи из заголовков oauth2-proxy (Keycloak), роли из групп Keycloak, команды, командные API-ключи, offboarding через опрос Keycloak (`sbx login` — S7). Требования S7: ID в Payload — UUID, `IdentityStore`/`ConfigReader` на Payload, роли member/owner | S7 | ✅ спецификация `docs/specs/s8-web.md` |
| S9 | Windows | Шаблон Win11 (образ пользователя, autounattend, sysprep), агент как служба, ConPTY, VSS, autologon. Server Core — фаза 2 | S3, S5 | ✅ спецификация `docs/specs/s9-windows.md` (первым в реализации спайк: vTPM + `suspend --todisk`) |
| S10 | Рабочий стол и computer-use | Sunshine + moonlight-web + TURN, cua-driver, шаблон `linux-desktop`, Windows desktop, computer-use API | S4, S9 | ✅ спецификация `docs/specs/s10-desktop.md` |
| S11 | MCP-сервер | Инструменты поверх публичного API: `sbx mcp` (stdio) и удалённый `/mcp`, вход через Keycloak (`sbx-mcp`) или командный ключ, computer-use | S7, S10 | ✅ спецификация `docs/specs/s11-mcp.md` |
| S12 | Эксплуатация | Деплой в Kubernetes (Helm, ingress, oauth2-proxy, Postgres), метрики, логи, несколько нод, PBS | S6 | |
| S13 | Git и приватные зависимости | Репозитории в environment, клон при claim, доступ к приватным репо (GitHub App: токен установки на sandbox с минимальными правами через credential helper агента; позже git-прокси в gateway без токена в VM), политика push, приватные registry (npm, pip, Docker) | S3, S6 | фаза 2, в MVP не реализуем |

Порядок: S1 → S2 → S3/S4 → S5 → S6 → S7 → S8 → S9 → S10 → S11 → S12. S13 перенесена в фазу 2.

Решение Ильи 2026-10-29: время создания sandbox не оптимизируем, до ~1 min допустимо. Warm pool в MVP не входит: Linux создаётся холодным клоном (~12 s), `failFast` / `pool_exhausted` (S6, S7) не реализуются, пул остаётся задачей фазы 2. Windows (S9) и `linux-desktop` (S10) тоже без спящих пулов. Для Windows до 5 min допустимо, 2–3 min — хорошо: create идёт холодным путём S9 (клон шаблона + sysprep specialize при первой загрузке), спайк vTPM + `suspend --todisk` не нужен.

Приёмка реализации: master не сливает ветку `sN-impl` только по отчёту исполнителя. Независимый тестовый субагент собирает, прогоняет линтеры и тесты и проверяет поведение на `pve`; найденное исправляет отдельный тред, после чего проверка повторяется.

Первая сборка для Ильи: весь стек MVP поднимается локально через docker compose (`deploy/compose/`): Postgres, api, worker, gateway, web, Keycloak, oauth2-proxy; Proxmox — `pve`. Каждый тред реализации добавляет туда свой сервис.

Фаза 2 (паритет с boat.dev, области S14–S30): `docs/roadmap-phase2.md`.
