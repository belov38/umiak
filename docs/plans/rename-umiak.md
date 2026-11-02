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
- [x] R1.3: после сигнала master §5 backup/clean old runtime, host identity/network/CT/CA/IdP/DB/Serve, rollback timers, 4 template builds (≥90 min background-task limit, дождаться каждого).
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

- Ruling: preserve only empty version-allocation `.claim` records from retired/failed old build history — otherwise a clean registry can reuse `windows 20261101.1`. No old manifests, runtime objects, credentials or active builds are imported; new build IDs and artifacts stay independent.
- TURN fault probe under its own 5-minute host rollback timer: relaying stopped 0.2 s after deleting its namespace table, recovered in 2.5 s; CT nftables reload preserved Docker/TURN. UDP/TCP/TLS, peer filtering, host-socket isolation, six reconnect allocations and expired Refresh all passed; timer cancelled after SSH/PVE/API checks. CT config touches only `inet filter`, never flushes the ruleset.

- Dashboard integration gate: build/lint/typecheck/typecheck:e2e, 228 unit tests and Playwright 21/21 pass. The first browser run found the fake E2E stack depended on the temporarily empty stand topology; added an independent four-build fake topology fixture mounted only by e2e.yaml. The rerun passed and removed its containers/volume/networks.

- Live legacy tunnel handshake with `sbx-tunnel.v1` returns 426 and advertises only `umiak-tunnel.v1`. Explicit legacy `sbx1`/`sbxt1` rejection cases added to wire/identity tests; both affected packages pass with race detection. These literals are intentional negative-test inventory exceptions. Private stand `.env` mode enforced on every deploy, including existing files.

- Linux 597 ready: manifest build `01a1991c-0aa8-77af-94fa-6e4ec1e9a24f`, version `20261101.1`, 99 PASS / 2 INFO / 0 FAIL, duration 1055 s. Runtime registration `01a1992d-2fce-7054-99f2-7ddcbe9a30e9` active; catalog still disabled. New topology contains this verified build; builder suite back to 584/584. Next build is linux-desktop 596 (`01a1992c-8cdc-7036-802a-fa52d23f7056`, version `20261101.3`).
- Allocator state consolidated into the normal `~/.local/state/umiak/poc.db` between builds; discarded only the unused preflight reservation database into a private temp backup. Both SQLite integrity checks passed, no builder held either file during the move.
- Eight old image tags exported to an encrypted off-host rollback archive (651936080 bytes); decryption/gzip/tar roundtrip validated 150 members. Cache GC removed only unused builder records older than ten minutes, preserving images/volumes; CT remains 6 GiB/30 GiB. Dashboard redeploy passed all external smoke checks after rerunning without editing the executing shell file.

- One fresh-context read-only review of the whole source branch (`7eeb7bfc → c953080b`) completed without actionable findings or blockers. Ruling: review after source completion, before costly Windows builds — remaining planned changes are live stand facts/docs/cleanup; actual Windows behavior remains a live gate, not a static-review claim.
- Remote MCP live acceptance on the new realm passed: authorization code + PKCE (`umiak-mcp`), issuer/audience/azp, initialize + 38 tools + limits call, refresh + repeated call. A fresh 55-character `umiak_` read-only key exposed 11 scoped tools and served limits; test keys revoked, loopback callback server closed. No credentials logged.
- Archived Keycloak dump confirms no operator-group membership for Ilia or E2E before cutover; preserve that baseline (the new operator group exists). E2E test logins remain exclusively `e2e@example.com`.
- All rollback archives roundtrip-read again (stand 36 members, Mac config 38, Mac state 226, template firewall 5, Docker images 150). Uniform AES-256-CBC/PBKDF2-HMAC-SHA256/200000 parameters and restoration cautions recorded in the private archive directory. Windows native tests cross-compiled offline: 19 binaries ready for a new 598 clone.

- Linux desktop 596 ready: manifest `01a1992c-8cdc-7036-802a-fa52d23f7056`, version `20261101.3`, 107 PASS / 2 INFO / 0 FAIL, duration 1001 s. Runtime registration `01a1993c-ac0b-7f58-9cf1-bc06f22b25c0` active; both Linux builds in topology. Windows desktop preflight passed including the 9,061,271,552-byte ISO hash and console permission; new build started only after Linux verify clones were removed. Windows recipes intentionally do not accept Linux-only CLI/API-url packaging flags; runner respects that existing contract.

- Live Chromium on CT (agent-browser, isolated E2E auth via password stdin): desktop/mobile brand Umiak, normal E2E `/app/operator` and `/admin` 403; temporary `umiak-operators` membership yields both 200. Full proxy + Keycloak logout returns protected app to login. Membership removed, browser closed and temporary encrypted vault profile deleted. Ilia never logged in. Agent-browser URL-wait stalled during the first attempt; its client was stopped, doctor clean, session closed; condition-based checks completed the run.
- Windows desktop 595 build `01a1993d-3986-7c3e-ab41-4408207656c4`, version `20261101.7`: installer completed and QGA answers; recipe steps in progress, 4096 MB configured RAM. No other sandbox/build VM runs.

- Compiled native `umiak mcp` stdio acceptance against the fresh stand: initialize, 38 tools, live limits call pass; stdin EOF closes the process. Runtime metrics: API 4 and gateway 13 Umiak metric families, zero old prefix. All nine running containers have new names, env keys and mounts.
- Residual tracked-name audit (case-insensitive): 1012 matching lines / 36 files, all allowlisted — historical docs/spec mapping/evidence 970, immutable migrations 28, explicit legacy rejection/upgrade tests 10, journal adoption 4. Historical migration diff still zero; only new SQL 0500 (113 lines). Empty old Python package directories removed from the working tree so they cannot form a legacy namespace package.

- Live Windows verify exposed an incorrect verifier contract missed by static review: guest already has UMI+12 hex (15 characters), but both TS helpers and guest verify.ps1 still expected UMIAK+12 (17). A literal/length regression failed RED (1 fail / 56 pass), then builder 584/584 and bench 44/44 passed after aligning all three verifiers; Go identity race and native/Windows vet/lint pass, all 19 Windows test binaries rebuilt.
- Ruling: preserve the sealed 595 artifact and rerun full standard verify after fixing its observer — recipe/agent/package bytes are unchanged. Stopped only the waiting Node verifier (to avoid its build rollback deleting the completed image), removed only its clone 500 through the guarded Machines API and its exact tunnel UUID; no sandbox remained and 595 remained a sealed template. Manifest stays building until the new complete verify succeeds; no acceptance result fabricated.
- Repeated full local gate found the MCP compose fixtures needed the new stand password variables; updated them and added real compose resolution assertions for all nine DB consumers. One existing MCP body-timeout test failed once under the full run, then passed 3/3 isolated attempts without production changes; full sequential gate is running again.

- Gate follow-up: a second full run hit a different preexisting TCP drain race in MCP while other files spawned compilers. Production MCP remains byte-identical to namespace-normalized main. Serialize MCP test files (strict deadlines/assertions unchanged); the complete package then passes 705/705 plus one expected skip. Full build/lint/typecheck/sequential-workspace gate repeated with that configuration.
- Consolidated post-dashboard/Windows-verifier gate PASS: build 8 s, lint 1 s, typecheck 14 s, sequential workspace tests 524 s; TS 4467 pass / 8 expected skips, Python 81/81. MCP 705 pass / 1 skip inside that full run. Windows hostname correction also has native/Windows Go vet/lint, identity race, PowerShell 22/22 parse and 19 cross-compiled native test binaries.

- Windows desktop 595 recovered through a complete fresh standard verify using corrected hostname observers on `c3bd89db`: manifest `01a1993d-3986-7c3e-ab41-4408207656c4`, version `20261101.7`, 112 PASS / 5 INFO / 0 FAIL. Both verify clones, snapshot and tunnel registrations removed before setting ready. Runtime build `01a19982-d42a-7cf5-a002-c0062008fdf6` active; topology now has three verified builds, catalog remains disabled. Duration 4560 s includes the interrupted observer run and local gate pause; recipe/agent bytes were preserved.
- Runbook clarification: current four one-slot recipes supersede historical S1/S10 slot rotation; 599 remains only an unused protected reservation. Linux desktop helper scripts are Linux-only, whereas standard CLI verification dispatches the full Windows verifier with QGA/VSS. Fixed the remaining Windows unattended XML hostname comment; XML parse and comment-only TS lint pass.

- Windows 598 ready: manifest `01a19983-d967-7ea4-bd34-233e58dbce4d`, version `20261101.2`, 101 PASS / 5 INFO / 0 FAIL, duration 2503 s. Runtime `01a199ab-0705-799e-ba4d-696edac4ae0c` active; topology now contains all four verified builds. All use new CA and agent `0.1.0+20261101.087b3f3a`; combined template verify 419 PASS / 14 INFO / 0 FAIL. Verify clones/snapshots/registrations cleaned.
- Additional live evidence: new CA accepts the tunnel, old CA rejects its chain; strict TLS MemoryBIO test accepts a newly signed permitted tunnel leaf and rejects a signed outside.invalid leaf with code 47 (name constraints). Ephemeral leaf keys/certs removed. Live T3 incognito E2E browser sees both Umiak wordmarks and CSP frame-src https://*.umiak.100-64-10-7.sslip.io. Fresh CLI config 0700, config/credentials 0600. Live limits: RAM 8192, usage zero, creates disabled until catalog enable.
- Smoke observer regression found by inspecting the new 597: sealed recipes have no firewall rules and enable=0, while the old PoC smoke expected an inherited group. Configure only the disposable clone with umiak-egress, DHCP/macfilter/IP filter, then add its assigned IPv4 before data probes; Bash parse passes, actual smoke pending after final redeploy. Host firewall object cleanup remains separate and timer-guarded.

- R1.3 complete: final idempotent deploy exit 0, external tunnel/preview/Serve/API/PRM checks passed; Payload Local API enabled exactly four templates only after verifying active builds, no pool targets and both dev quota RAM values 8192. Live limits confirms canCreate=true, all four templates, zero runtime usage. One-off Local API helper completed its writes/assertions but held connections during shutdown; SIGTERM sent only to its identified `node --input-type=module` PID 176, worker untouched; helper SSH reaped (143). Read-after-write API proof recorded.
- R1.4 Windows native tests started against fresh 598, all 19 cross-compiled test binaries; single clone 4 GiB. T3 incognito browser tab closed before desktop idle tests; iframe check will use a fresh login later.

- First native Windows run: 18/19 binaries passed, 523 root PASS / 27 SKIP / 1 FAIL. The single failure is a stale exact env-order fixture: runtime correctly sorts TEMP/TERM before UMIAK, whereas mechanical SBX replacement kept their former positions. Reordered only the literal expected array (no runtime/agent/template changes), native claim race + native/Windows lint + Windows vet pass; claim test executable rebuilt. Full 19-binary native rerun follows the Linux desktop helper.
- Extra Linux desktop helper (`verify-desktop.ts`, build 596) passed, including hard restart, raw-disk scan and fork; clones, snapshot and registration removed. Its no-connect-url profile records 106 PASS / 3 INFO (one expected tunnel skip); the original build's connected standard verifier remains evidenced by 107 PASS / 2 INFO above.
- Complete native Windows rerun PASS: 19/19 binaries, 524 root PASS / 27 expected SKIP / 0 FAIL, on fresh 598 clone; ISO and VM cleaned. No production agent bytes changed by the fixture correction.

- Live E2E initially passed ten steps but failed strict SSH because the temporary operator SSH wrapper prepended its pin file and overrode CLI's explicit UserKnownHostsFile. Corrected only that external wrapper to honor explicit pins; three ssh -G probes pass, strict checking retained. Repeated the full scenario: 20/20 PASS, TS SDK 6 live checks, Python SDK 5 live checks; idle stop after 72 s. No PVE sandbox VMs, zero snapshot LVs and zero E2E team sandboxes after cleanup. Product SSH code unchanged; CLI /v1/meta-derived pins work.

- Linux desktop acceptance reached live WebSocket/relay UDP frame diffs and MCP computer tools, then its idle observer immediately rejected tcpStreams=3/desktopStreams=1. Gateway HTTP pools intentionally idle for 30 s; a separate non-acceptance diagnostic (read-only SQL, no API keepalive) observed a clean desktop-only baseline twice, with API age advancing. Runtime files remain namespace-normalized main.
- Observer now waits at most 120 s for a desktop-only baseline using SQL; only then starts the full requested hold. Strict counters, state and no-API checks remain unchanged throughout the hold. Five clock-controlled regression tests prove setup time is excluded, setup is bounded, and TCP/API/state failures remain failures (RED: 2 fail / 3 pass; GREEN whole builder 589/589). Builder and full desktop-runner typechecks pass. Linux full 30-minute acceptance repeated; diagnostic failure is not counted as acceptance.

- Final consolidated local gate on a4b5e727 PASS again: build 8 s / lint 1 s / typecheck 15 s / sequential tests 524 s; TS 4472 pass / 8 expected skips, Python 81/81.
- Linux desktop full acceptance PASS with baked agent (no override/reuse): 52 ok assertions, WebSocket + relay-only UDP/TCP/TLS live frame changes, full 1,800,000 ms desktop-only hold (173 strict SQL samples; last API age 1831 s), natural-close idle-stop 100649 ms. Fresh fork streamer credentials and MCP tools, stop/resume, old-cookie 401, delete cleanup all pass. Artifacts private: /var/folders/11/v77p7v_x1qx3f5r4kc__cc3r0000gn/T/tmp.E9DapTvSmo.

- Windows desktop full acceptance PASS with baked 595 agent: 52 ok assertions, WebSocket and relay UDP/TCP/TLS frame changes, full 1,800,000 ms desktop-only hold (175 strict SQL samples, last API age 1802 s), natural-close idle-stop 105852 ms. Running fork without forceStop refused; stopped fork gets new streamer state and MCP computer tools; stop/resume, screenshot, old-cookie 401 and cleanup pass. Create 246513 ms; stream open 23281 ms. Artifacts private: /var/folders/11/v77p7v_x1qx3f5r4kc__cc3r0000gn/T/tmp.wHpoWFeMj6.
