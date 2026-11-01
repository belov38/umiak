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

- [x] R1.0: baseline/ref/toolchain/disk; новая ветка; прочитать места контрактов, записать gate evidence.
- [x] R1.1a: обновить контрактные тесты key/identity/SMBIOS/notifications, увидеть RED.
- [x] R1.1b: переименовать tracked source paths/content, manifests/imports/binaries/protocol/headers/env/types; корректировать исключения (§3 карты).
- [x] R1.1c: 0500 заменяет notify function bodies; migration runner переносит legacy journal под lock; тесты fresh и upgrade (checksums сохранены).
- [x] R1.1d: pnpm/uv lock, buf/OpenAPI/SDK regeneration; targeted GREEN, commit/push.
- [x] R1.2a: compose/CI/recipes/scripts/UI/docs, fixtures/archive, named guards, registry и dry-run.
- [x] R1.2b: последовательно build → lint → typecheck → test; Go build/vet/race/lint и Windows builds/vet/lint; DB integration реально включена.
- [x] R1.2c: generated drift, compose config, девять images, signed Linux/Windows packages, integration harness и CLI platform compile; local dry-run.
- [x] R1.2d: интегрировать main, повторить затронутый gate; inventory allowlist; commit/push. Если локальная работа исчерпана — запросить освобождение стенда.
- [ ] R1.3: после сигнала master §5 backup/clean old runtime, host identity/network/CT/CA/IdP/DB/Serve, rollback timers, 4 template builds (≥90 min background-task limit, дождаться каждого).
- [ ] R1.4: verify four templates, 20/20 e2e, два desktop E2E (UDP/TCP/TLS/idle), TURN guard/block/cache probes; уборка и evidence, push.
- [ ] Финал: master независимая приёмка; R1.5 только master. Никаких оставленных running tasks.

## Журнал

- R1.0: `origin/main=cb101753`; branch создан в существующем linked worktree; Docker 29.9.2, pnpm 12.16.1; свободно 46 GiB. Стенд занят, удалённые операции не выполнялись.
- Ruling: полный gate заменяет предварительный дублирующий baseline всего проекта — rename не меняет семантику, исходный main принят master; ошибки будут воспроизводиться сравнением с исходным ref. Стоимость ошибки: дополнительная диагностика baseline.

- R1.1/R1.2: source rename pushed (`66fa5368`, `e59ff881`), main rebuild 598 integrated (`b19cbb19`, origin/main `416d8cf6`). Historical migrations unchanged. API 1049/1049; builder 584/584; worker 423 pass, 7 live-only skips; TS SDK 141/141; Python 81/81; web 228/228. Final consolidated gate pending.
- Generated drift: 429 files, zero differences (buf/OpenAPI/TS/Python). All 9 local images built; CLI five targets, Linux/Windows signed packages verified. Linux privileged systemd integration PASS including update/rollback; stand-only cases skipped there by design.
- Ruling: migration journal table and PK index rename together under the existing advisory lock — actual branded metadata was absent from initial inventory; preserve rows/checksums and reject dual journals. Upgrade regression failed on leftover legacy PK, then passed after its rename.
- Ruling: node-agent Windows build is not applicable (PVE host binary uses syscall.Flock/O_NOFOLLOW); build/vet/race/lint on native plus Linux build/vet/lint, Windows gates apply to the other four modules. No portability layer added.
- R1 fixes: length-dependent header filter and base64 redaction, semantic PVE pool guard, CRLF Windows wrappers, sorted fixtures. Agent CLI test sockets exceeded macOS AF_UNIX path length after rename; shortened fixture ShimSockDir, 15 repeated race tests pass. MCP tool list grew 2 chars past its quota; shortened limits description without increasing the budget.
- Master released stand; after local gate proceed without another approval. Fresh dev Payload quota max RAM = 8192 MB, product default unchanged. R1.5 remains master-owned.

- R1.2 complete on `4f7eac0e`: sequential build/lint/typecheck/test exit 0 (test 278 s); TS 4466 pass / 8 expected skips, Python 81/81. Go root tests 1167 pass / 2 skips (1836 passes including subtests); all applicable Windows builds/vet/lint and Linux build/vet/lint (guest integration tag) pass. Node-agent is Linux host-only.
- Local evidence: 9 image builds + gateway version, API/core/MCP imports, web syntax, oauth2 version; CLI 5 targets; npm pack + Python wheel import; signed Linux and Windows packages. Generated drift 429 files / 0 changes; buf breaking against namespace-normalized old proto passes (old unnormalized baseline reports 12 deleted namespace files as expected). Shell syntax Linux Bash 36/36 and PowerShell 22/22; native Mac Bash 3.2 cannot parse an unchanged Linux-only case inside process substitution, verified with the actual Linux interpreter instead.
- Stand stage begins only after the consolidated gate above. Main checked again before R1.3; dashboard branch still pending.

- R1.3 backup: DB/Keycloak/Payload dumps and private config encrypted off-host; independent readonly LVM rollback snapshots of owned slots 595–599 verified. Old builds retired with the old guard/tool; old PoC 599 removed. No sandbox consumers remained. Old compose stopped; old volume retained isolated.
- R1.3 host: new least-privilege user/token/pool/roles and restricted node key installed. SDN `umiak/umiak0` migrated without ifreload-a or changing vmbr0/shared SNAT/conntrack. First 5-minute host timer actually fired and restored the network; probe exposed missing cloned VM firewall group, and scoped IPAM restore was added. Second attempt passed TLS, TURN UDP, Internet/DNS, 17 blocked management endpoints, SSH and PVE API 200; probe removed before cancelling the timer.
- Ruling: use scoped SDN config commit/generation and admin-only bridge rename — the normal PVE SDN apply reloads all interfaces, conflicting with the explicit vmbr0 restriction. Checked physical bridge settings/addresses/default route and shared netfilter rules before/after.
- CT Unix user/group/home and OS/Tailscale hostname renamed, uid/gid 1000 and node/IP identity preserved. Old home/config isolated under root; new CA trusted on Mac. Stand DB/dev-user credentials now random and private, verified at all eight compose consumers; product/local compose defaults unchanged. Old template topology removed until new verified builds exist.

- Main dashboard integrated from `7eeb7bfc`/`57cca0f5`; conflicts resolved by retaining the accepted dashboard layout and applying R1 names. Sidebar/mobile wordmark is Umiak; theme storage, new key form, test env and added docs use the new prefix. No other branches remain open.
- Fresh stand: all services healthy after adding gateway as the ninth rotated-DB credential consumer. Serve/API/PRM and new Keycloak issuer return expected HTTP responses; new CA is trusted. Dev Payload default and new shared-team RAM quota both 8192 MB, four templates disabled until verified builds. Product quota remains 6144 MB. Password generator fixed after actual Mac pipefail exit 141.
- Linux build started in 597 (`01a1991c-0aa8-77af-94fa-6e4ec1e9a24f`), 3-hour process limit; only its exact slot is allowed. Patched Windows moonlight-web built successfully. Agent packages version `0.1.0+20261101.087b3f3a` pin the new CA.
