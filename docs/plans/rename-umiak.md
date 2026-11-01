# R1: план реализации Umiak

> Исполнение: superpowers:executing-plans, один исполнитель последовательно.

**Цель:** выполнить утверждённый `docs/specs/rename-umiak.md`, §1–6; GitHub/T3 (§7) выполняет master.
**Архитектура:** атомарный rename исходников/контрактов, новая SQL-миграция без изменения истории; чистый redeploy существующего CT и четыре новых шаблона без legacy protocol.
**Стек:** pnpm/TS/Bun, Go/buf, Python/uv, Postgres, Docker compose, PVE.

## Ограничения

- До освобождения стенда master — только локальные действия; перед стадиями fetch/log main и интеграция новых слияний.
- Никаких параллельных редакторов; main не сливаем. Рабочая ветка `rename-umiak`, регулярные push.
- На стенде VMIDs 500–589, RAM ≤8 GiB, шаблоны строго 595/596/597/598 по одному; CT 590 сохраняется.
- Firewall/SDN/IPSet — host auto rollback; e2e только e2e@example.com; non-interactive delete --yes.
- Исторические миграции byte-identical. Старые секреты/сессии не переносим.

## Особое внимание

1. API key CRC покрывает новый prefix; body/display offsets и длина 55.
2. Windows hostname UMI+12 hex ≤15; SMBIOS prefix длиннее, byte limits сохраняются.
3. RPC allowlists/headers/cookie stripping меняются вместе с producers.
4. SQL upgrade сохраняет checksums/journal, listeners получают только новые каналы.
5. Templates проверяются с baked agent/new CA без override; никакой старой VM/LV уборки новым guard.

## Задачи

- [ ] R1.0: baseline/ref/toolchain/disk; новая ветка; прочитать места контрактов, записать gate evidence.
- [ ] R1.1a: обновить контрактные тесты key/identity/SMBIOS/notifications, увидеть RED.
- [ ] R1.1b: переименовать tracked source paths/content, manifests/imports/binaries/protocol/headers/env/types; корректировать исключения (§3 карты).
- [ ] R1.1c: 0500 заменяет notify function bodies; migration runner переносит legacy journal под lock; тесты fresh и upgrade (checksums сохранены).
- [ ] R1.1d: pnpm/uv lock, buf/OpenAPI/SDK regeneration; targeted GREEN, commit/push.
- [ ] R1.2a: compose/CI/recipes/scripts/UI/docs, fixtures/archive, named guards, registry и dry-run.
- [ ] R1.2b: последовательно build → lint → typecheck → test; Go build/vet/race/lint и Windows builds/vet/lint; DB integration реально включена.
- [ ] R1.2c: generated drift, compose config, девять images, signed Linux/Windows packages, integration harness и CLI platform compile; local dry-run.
- [ ] R1.2d: интегрировать main, повторить затронутый gate; inventory allowlist; commit/push. Если локальная работа исчерпана — запросить освобождение стенда.
- [ ] R1.3: после сигнала master §5 backup/clean old runtime, host identity/network/CT/CA/IdP/DB/Serve, rollback timers, 4 template builds (≥90 min background-task limit, дождаться каждого).
- [ ] R1.4: verify four templates, 20/20 e2e, два desktop E2E (UDP/TCP/TLS/idle), TURN guard/block/cache probes; уборка и evidence, push.
- [ ] Финал: master независимая приёмка; R1.5 только master. Никаких оставленных running tasks.

## Журнал

- R1.0: `origin/main=cb101753`; branch создан в существующем linked worktree; Docker 29.9.2, pnpm 12.16.1; свободно 46 GiB. Стенд занят, удалённые операции не выполнялись.
- Ruling: полный gate заменяет предварительный дублирующий baseline всего проекта — rename не меняет семантику, исходный main принят master; ошибки будут воспроизводиться сравнением с исходным ref. Стоимость ошибки: дополнительная диагностика baseline.
