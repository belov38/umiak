# Roadmap: области для brainstorm

Каждая область — отдельный тред T3 Code (независимые области идут параллельно, каждая в своём git worktree и ветке): brainstorm → спецификация в `docs/specs/` → согласование с пользователем. После согласования спецификации brainstorm-тред закрывается (settle), реализация идёт в отдельном треде и ветке `sN-impl` (план в `docs/plans/`), master сливает ветки в main. Архитектура: `docs/architecture.md`.

Ограничения PoC на `pve`: VMID от 500, не больше 8 GB RAM на всё, хранилище `local-lvm`. Разрешено создать пользователя, токен, pool и SDN Simple zone + VNet. Существующие VM, LXC и `vmbr0` не трогать.

| # | Область | Что решаем | Зависит от | Статус |
|---|---|---|---|---|
| S1 | **Proxmox foundation** | Подготовка хоста (пользователь, токен, pool, SDN Simple zone + VNet, firewall); драйвер LVM-thin; примитивы machine (из шаблона, start/stop, snapshot с хуком quiesce, fork, delete); выделение VMID и MAC; транспорт операций на ноде (`node-agent` на Go или SSH); стенд для замеров | — | ✅ спецификация; реализация (ветка `s1-impl`) |
| S2 | Протокол туннеля агент ↔ gateway | Формат на проводе, auth, мультиплексирование, переподключение, `requestId`, offset, реестр `machine → gateway` | — | ✅ спецификация; реализация (ветка `s2-impl`) |
| S3 | Guest agent v0 (Linux) | exec / files / ports, claim, смена идентичности, quiesce, установка и обновление | S2 | brainstorm (ветка `s3-guest-agent`) |
| S4 | Gateway | Приём туннелей, HTTP-прокси `*.sbx`, маршрутизация, несколько экземпляров, позже SSH gateway и TURN | S2 | brainstorm (ветка `s4-gateway`) |
| S5 | Шаблон Linux | Сборка образа (cloud-init / Packer), встроенный агент, версии шаблонов | S1, S3 | |
| S6 | Ядро control plane | Модель данных, машины состояний sandbox и machine, worker, warm pool, оркестрация create / stop / resume / fork / delete | S1, S2 | brainstorm (ветка `s6-control-plane`) |
| S7 | Публичное API v1 | Hono + OpenAPI, генерация SDK, CLI | S6 | |
| S8 | Web (Payload) | Админка, клиентский дашборд, JIT-пользователи из заголовков oauth2-proxy, роли из групп IdP, команды, API-ключи, `sbx login` | S7 | |
| S9 | Windows | Шаблоны Win11 и Server Core (образ пользователя, autounattend, sysprep), агент как служба, ConPTY, VSS, autologon | S3, S5 | |
| S10 | Рабочий стол и computer-use | Sunshine + moonlight-web + TURN, cua-driver, шаблон `linux-desktop`, Windows desktop | S4, S9 | |
| S11 | MCP-сервер | Инструменты поверх публичного API | S7 | |
| S12 | Эксплуатация | Деплой в Kubernetes (Helm, ingress, oauth2-proxy, Postgres), метрики, логи, несколько нод, PBS | S6 | |

Порядок: S1 → S2 → S3/S4 → S5 → S6 → S7 → S8 → S9 → S10 → S11 → S12.
