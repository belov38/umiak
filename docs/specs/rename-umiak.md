> Historical design: Keycloak, oauth2-proxy and OIDC authentication were removed on 2026-11-05. Current deployments use owner authentication over Tailscale; see [architecture](../architecture.md).

> Historical record: references below to `infra/pve` describe the retired PoC host-preparation path.
> For supported installation and host preparation, use the [Proxmox installer](../getting-started.md#install-on-proxmox);
> for added-node checks and preparation, use the [installer node console](../operations-multi-node.md).

# R1. Rename to Umiak

> S17 update (2026-11-03): `windows` now includes desktop; `windows-desktop` is a compatibility alias. VM 598 is retired and read-only; VM 595 is the active Windows build. Historical build notes below do not authorize template mutations. See [S17](s17-windows-single.md).

Status: **specification**, 2026-11-02. Basis: Ilia's decision of 2026-11-01.
The implementation is a separate sequential branch; this document does not permit changing the stand.

## 1. Decision and boundaries

The full product name is **Umiak**, the machine spelling is `umiak`, the variable prefix is `UMIAK_`.
We rename the UI, documentation, CLI, SDK, GitHub, images, internal protocols,
services, configuration, and platform-owned Proxmox objects. `sbx` conflicts
with the Docker Sandboxes CLI; Skiff/Kayak/Dinghy were rejected. The availability of the name in registries
is accepted as Ilia's initial decision; registration and publication are not part of R1.

The chosen approach is a **clean redeploy of the application on the existing CT 590**, with a new DB, realm,
secrets, and a rebuild of all four templates. We keep the CT itself, its disks, addresses, and Tailscale
node identity; we rename its hostname and user. There is no production.
An in-place data conversion and a dual protocol increase risk without benefit.
Old sandboxes and snapshots are not carried over, old keys and sessions are revoked.
There is no compatibility with the `sbx` CLI, env, API keys, headers, RPC, and agents.
This is a one-off exception to the S2/S7/S11 compatibility rules; future Umiak changes
are again subject to these rules. `/v1` stays v1: a rename before production does not change
resource semantics, only the brand parts of the contract named below.

We do not add a short CLI alias: the only command is `umiak`. We do not install `umi`, `um`, and especially
`sbx`. Operational utilities have explicit names `umiak-admin`,
`umiak-tpl`, `umiak-bench`; MCP stdio — `umiak mcp`.

## 2. Inventory of the source tree

Snapshot: `e349e8aa65650d9b5c33f735fd963cd6523f65b6`, before R1 was added.
Read: `CLAUDE.md`, architecture, roadmap, S1–S11, the dev-cp README, and the related
compose/PVE/template configurations and scripts. The source of a specific spelling is the code:
for example, a key has a 43-character body **plus 6 CRC**, not just 43.
This is an inventory of the repository, not a survey of the current state of `pve` or the CT.
The READMEs contain stale "not verified" messages, 3 GB, and old build IDs;
they do not cancel the later roadmap decisions and the S10 results.

### 2.1. Method and numbers

All 2444 tracked paths were checked, including `.github`, `.env.example`, lockfiles,
generated files, and tests. For text content — the case-insensitive regex
`sbx|boat` without word boundaries: it catches `SBX_`, `Sbx`, `sbxt1`, scopes, SDK, and repo.
Ignored secrets, node_modules, research, local sdks/vendor-repos, and `.git`
are not included in the numbers; their local paths are checked separately before the cutover, without printing
secrets. Binary fixtures are checked by the archive manifest, not by string replacement.

| Area (non-overlapping groups) | Files with a match | Lines | Occurrences |
|---|---:|---:|---:|
| `apps/`, `packages/`, except Python | 793 | 6721 | 7466 |
| `packages/sdk-py/` | 74 | 659 | 823 |
| `services/`, `libs/` (including generated Go) | 506 | 4909 | 5903 |
| `proto/` | 14 | 41 | 53 |
| `db/` | 8 | 26 | 26 |
| `deploy/compose/` | 16 | 524 | 751 |
| `infra/dev-cp/` | 27 | 480 | 678 |
| `infra/pve/` | 4 | 220 | 319 |
| `infra/templates/` | 54 | 416 | 546 |
| `docs/` | 28 | 2159 | 3488 |
| `.github/` | 4 | 15 | 18 |
| Root and other | 5 | 55 | 55 |
| **Total** | **1533** | **16225** | **20126** |

516 tracked paths themselves contain the old name (including the whole Python import tree).
Separate case-sensitive searches overlap and **are not summed**:

| Literal | Occurrences | Files |
|---|---:|---:|
| `sbx` | 13300 | 1334 |
| `SBX_` | 2852 | 317 |
| `Sbx` | 2345 | 400 |
| `SBX` | 3034 | 335 |
| `boat-dev-clone` | 1280 | 468 |
| `boat` | 1442 | 475 |
| `sbxt1` | 47 | 21 |
| `@sbx/` | 1197 | 535 |
| `sbx-sdk` | 29 | 20 |
| `sbx_sdk` | 62 | 25 |

A repeatable dump of matches and paths (run on the needed snapshot):

```sh
git grep -n -i -E 'sbx|boat' HEAD -- .
git grep -I -o -i -E 'sbx|boat' HEAD -- .
git ls-files | rg -i 'sbx|boat'
git grep -n -E 'SBX_|Sbx|sbxt1|sbx1|@sbx/|sbx-sdk|sbx_sdk' HEAD -- .
```

For the final check, the exceptions of §4 are specified by exact paths/lines, not by a broad
exclusion of `docs/`, generated files, or tests. R1 itself intentionally contains the old names.

### 2.2. Map by subsystem and dangerous places

- **TS workspace:** 16 scoped packages: `api`, `bench`, `cli`, `mcp`,
  `template-builder`, `web`, `worker`, `agent-client`, `auth`, `config`, `core`,
  `db`, `payload`, `proto`, `pve`, `sdk`. The Python wrapper is the seventeenth manifest,
  currently the unscoped `sbx-sdk`. The root `package.json` is called `boat-dev-clone`.
  Changed: manifests, imports/exports, pnpm filters, scripts, Docker COPY/filter,
  the lockfile, fixtures, and generated clients. Sub-slices (files/occurrences): api 154/1087,
  cli 75/842, mcp 74/742, web 105/574, worker 90/804, builder 59/854,
  bench 15/131, auth 16/48, Payload 44/342, TS SDK 32/557.
- **Go:** five `go.mod`: `libs/proto`, `libs/tunnel`, `services/gateway`,
  `services/guest-agent`, `services/node-agent`; `go.work`, imports, module options
  buf and Docker build paths. `cmd/sbx-{gateway,agent,node,release,agent-harness}`,
  the internal `sbxerr`, package/type names, and the test harness are renamed too.
- **Proto:** 12 source `.proto` files: 6 agent, 5 tunnel, 1 testing; two generation YAMLs
  also contain the name. `proto/sbx/{agent,tunnel,testing}/v1`, Go `libs/proto/sbx`,
  TS `packages/proto/src/gen/sbx`, testpb, and test/gen. The Connect procedure names and
  type URLs change: replacing the Go imports is not enough, the descriptors must be regenerated.
  The gateway RPC allowlist and the ban on access to Control must match the new namespace.
- **API/SDK/CLI/MCP:** OpenAPI `apps/api/openapi/v1.json`, API schemas, generated TS
  and Python, `Sbx`/`AsyncSbx`/`SbxError`, CLI completions/help/build assets,
  User-Agent, MCP serverInfo, `mcpServers.sbx`, `mcp__sbx__*`,
  the fence `<<<sbx-untrusted …>>>`, metrics `sbx_*`, error domain/realm strings.
  `apps/api/src/routes/sbx-auth.ts` and the routes `/sbx-auth/*` are brand URLs.
  HTTP headers `Sbx-*` and `X-Sbx-*` pass through the API, gateway, agent, SDK, CORS,
  trailer parsing, oauth2-proxy, and moonlight-web. Check the stripping of incoming headers
  and the cookie protection: changing only the producers breaks either auth or filtering.
  The error codes themselves (`agent_unavailable`, `snapshot_requires_stop`, `team_forbidden`,
  `desktop_unsupported`, and the other semantic codes) contain no brand and stay.
  Public IDs from `packages/auth/src/ids.ts`: `sb_`, `op_`, `cmd_`, `snap_`, `key_`,
  `sshk_`, `env_`, `usr_`, `team_`, `upl_`, `req_`; these are resource types, not `sbx`.
- **DB:** schemas `runtime`, `tunnel`, `identity`, `payload`, the pg-boss service queue;
  table/column names describe entities, not the brand. In SQL 8 files/26 occurrences:
  `0201`, `0204`, `0206`, `0300`, `0301`, `0302`, `0303`, `0401`.
  The risk is not the DB name but LISTEN/NOTIFY `sbx_sandboxes`, `sbx_routes`, `sbx_operations`,
  `sbx_identity`, `sbx_ssh_revoke`, plus `sbx_config` in Payload hooks/listeners.
  Two historical Payload TS migrations contain one `sbx_config` each; the JSON snapshots
  and the journal of applied migrations stay unchanged. After the new deployment
  SQL triggers on the old channels must not remain alongside the new listeners.
- **Config/compose:** `config/sbx.yaml`, `realm-sbx.json`, identity seed,
  `oauth2-proxy.yaml`, `.env.example`, `e2e.env`, secrets and mount paths,
  project/network `sbx`, DB/user/password defaults, DSN/healthchecks, TLS `sbx.pem/key`,
  cookies `__Host-sbx_auth`, `__Host-sbx_state_*`, `__Host-sbx_session`.
  Images: `sbx-{api,worker,web,mcp,gateway,oauth2-proxy,secrets-init,turn,e2e-backend}:dev`.
  Our own TURN label `sbx.turn.entrypoint-sha256` and the nft table `inet sbx_turn`.
  Changing the compose project creates new networks/volumes and does not clean the old ones itself.
- **Dev-cp:** `names.sh`, deploy/smoke/e2e, TURN firewall/cert/probes,
  CLI password files, CT login `sbx`, checkout `~/boat-dev-clone`, config/cache,
  the gateway IPSet, CA trust on the Mac, MagicDNS/Serve issuer/redirect/CSP/Host allowlists.
  `names.sh` still contains the old relay range 49160–49200; the working dev range per
  S10/README is **61000–61040**. The rename must not bring back the old values.
- **PVE:** all 4 files of `infra/pve/`; in reality the pool is called **`sandbox`**, the token —
  **`sbx@pve!poc`**, the roles `SbxPoC`, `SbxTemplateMedia`, `SbxConsole`, not a hypothetical
  `sbx-pool`. SDN `sbx`/`sbx0`, dnsmasq config/leases, ACL, firewall groups/IPSets,
  node-agent restricted authorized_keys command, VM names/tags, LV ownership guards,
  ISO/import names/cache. Tags must not be mechanically replaced and then prune run:
  the old LVs would stop being recognized. First delete the old resources with the old code.
- **Templates/guest:** 54 of 82 recipe files contain the name; installer/verify,
  shared `_windows`, early GPO, sysprep answer files, services, SCM recovery,
  LSA `L$sbx_user`, Windows named jobs/mutexes, Linux users `sbxstream`, desktop paths,
  package tar entries/signature manifests, trust bundle, runtime env `SBX=1`,
  `SBX_SANDBOX_ID`, `SBX_ENV_APPLIED`; the SSH CA path. Special cases — the Windows hostname
  is limited to 15 characters; the serial `sbx1:` and the family `sbxt1:` are **different** SMBIOS fields,
  the WS subprotocol is a third string. Check the lengths and the parser boundaries separately.
- **Docs/CI/root:** S1–S11, plans and acceptance results, architecture/roadmaps,
  README/quickstart, `CLAUDE.md`, `.gitignore`, root manifest/lockfile.
  All 4 workflows in `.github/workflows/` contain the old name: DB env/password,
  pnpm filters, image tags, and the buf baseline path. Leave only `workflow_dispatch`.

## 3. Normative name map

The rule for own names: `sbx` → `umiak`, `Sbx` → `Umiak`, `SBX` → `UMIAK`,
`boat-dev-clone` → `umiak`, including case-insensitive checks and regexes. This rule
is for classified entities, not a global replace of an arbitrary `boat`/`sb`.

| Kind | Was | Becomes |
|---|---|---|
| Brand / repo / root package | sbx, boat-dev-clone | Umiak / `belov38/umiak` / `umiak` |
| CLI and utilities | `sbx`, `sbx-admin`, `sbx-tpl`, `sbx-bench` | `umiak`, `umiak-admin`, `umiak-tpl`, `umiak-bench` |
| npm | `@sbx/<name>` | `@umiak/<name>` (all 16, `sdk` keeps the suffix) |
| Python distribution / import | `sbx-sdk` / `sbx_sdk` | `umiak-sdk` / `umiak_sdk` |
| Python workspace manifest | `sbx-sdk` | `@umiak/sdk-py` (private; the PyPI name is separate) |
| SDK API | `Sbx`, `AsyncSbx`, `SbxError`, `sbx.ts`, `sbx.py` | `Umiak`, `AsyncUmiak`, `UmiakError`, `umiak.ts`, `umiak.py` |
| Go modules | `github.com/belov38/boat-dev-clone/<dir>` | `github.com/belov38/umiak/<dir>` |
| Proto source/package | `sbx.<area>.v1`, `proto/sbx/…` | `umiak.<area>.v1`, `proto/umiak/…` |
| WS subprotocol | `sbx-tunnel.v1` | `umiak-tunnel.v1` |
| SMBIOS serial / family | `sbx1:<id>:<BS>` / `sbxt1:<url>` | `umiak1:<id>:<BS>` / `umiakt1:<url>` |
| Env | `SBX_*`, `SBX=1` | `UMIAK_*`, `UMIAK=1` |
| Double brand in env | `SBX_SBX_DOMAIN`, `SBX_GATEWAY_TLS_SBX_{CERT,KEY}_FILE` | `UMIAK_PREVIEW_DOMAIN`, `UMIAK_GATEWAY_TLS_PREVIEW_{CERT,KEY}_FILE` |
| HTTP headers / bootstrap scheme | `Sbx-*`, `X-Sbx-*`, `Sbx-Bootstrap` | `Umiak-*`, `X-Umiak-*`, `Umiak-Bootstrap` |
| API team key | `sbx_` + 43 base62 + 6 CRC | `umiak_` + the same 43 + 6 (full length 55) |
| Reserved sandbox key / port token | `sbxs_` / `sbxp_` | `umiaks_` / `umiakp_` |
| Preview DNS | `*.sbx.<domain>` | `*.umiak.<domain>` |
| Config/cache/state | `~/.config/sbx`, `~/.cache/sbx`, `~/.local/state/sbx` | the corresponding `umiak` directories |
| Product config | `config/sbx.yaml`, `/etc/sbx/sbx.yaml` | `config/umiak.yaml`, `/etc/umiak/umiak.yaml` |
| Realm / client audience | `sbx`, `sbx-cli`, `sbx-api`, `sbx-mcp`, `sbx-worker` | `umiak`, `umiak-cli`, `umiak-api`, `umiak-mcp`, `umiak-worker` |
| Operator group | `sbx-operators` | `umiak-operators` |
| App DB / DB role | `sbx` / `sbx` | `umiak` / `umiak` (a new random password) |
| SQL channels | `sbx_{sandboxes,routes,operations,identity,ssh_revoke,config}` | `umiak_` + the same suffix |
| PVE user / token / pool | `sbx@pve`, `sbx@pve!poc`, `sandbox` | `umiak@pve`, `umiak@pve!dev`, `umiak` |
| PVE roles | `SbxPoC`, `SbxTemplateMedia`, `SbxConsole` | `UmiakPoC`, `UmiakTemplateMedia`, `UmiakConsole` |
| SDN zone / VNet | `sbx`, `sbx0` | `umiak`, `umiak0` |
| Firewall | `sbx-gateway`, `sbx-deny`, `sbx-deny-public`, `sbx-deny6`, `sbx-egress` | `umiak-` + the same suffix |
| PVE VM/LV/media tags | `sbx`, `sbx-tpl`, `sbx-vm-*`, `sbx-snap-*`, `sbx-src-*`, `sbx-{seed,build,offline,virtio-win}-*` | `umiak` and the corresponding `umiak-*` |
| Node binary/config/state | `sbx-node`, `/etc/sbx-node.toml`, `/var/lib/sbx-node` | `umiak-node`, `/etc/umiak-node.toml`, `/var/lib/umiak-node` |
| Guest agent / release utility | `sbx-agent[.exe]`, `sbx-release` | `umiak-agent[.exe]`, `umiak-release` |
| Linux agent dirs / units | `/etc/sbx-agent`, `/var/lib/sbx-agent`, `/run/sbx-agent`, `sbx-{agent,identity,agent-rollback}.service`, `sbx-cmd.slice` | the same layout with `umiak` |
| Linux runtime/desktop | `/etc/sbx`, `sbx-desktop`, `sbx-sunshine`, `sbx-moonlight-web`, `sbx-session`, `sbxstream` | the same names with `umiak` |
| Windows agent dirs/service | `%ProgramFiles%\sbx-agent`, `%ProgramData%\sbx-agent`, SCM `sbx-agent` | the corresponding `umiak-agent` |
| Windows identity | `SBX` + 12 hex | `UMI` + the same 12 hex (15 characters, keeps a 48-bit suffix) |
| Windows LSA/jobs/GPO | `L$sbx_user`, `Global\sbx-*`, `sbx-early.cmd`, `sbx-unattend.xml` | `L$umiak_user`, `Global\umiak-*`, `umiak-early.cmd`, `umiak-unattend.xml` |
| SSH user CA files | `sbx_user_ca.pub` | `umiak_user_ca.pub` |
| Compose project/network/images | `sbx`, `sbx-<service>:<tag>` | `umiak`, `umiak-<service>:<tag>` |
| TURN table/label | `inet sbx_turn`, `sbx.turn.*` | `inet umiak_turn`, `umiak.turn.*` |
| Cookie / auth URL | `__Host-sbx_*`, `/sbx-auth/*` | `__Host-umiak_*`, `/umiak-auth/*` |
| TLS preview files | `sbx.pem`, `sbx.key` | `umiak.pem`, `umiak.key` |
| CT hostname/login/checkout | `sbx-dev-cp`, `sbx`, `~/boat-dev-clone` | `umiak-dev-cp`, `umiak` (uid 1000), `~/umiak` |
| MCP/config/metrics/User-Agent | `sbx`, `sbx-untrusted`, `sbx_*`, `sbx-mcp/<v>` | the corresponding `umiak`, `umiak-untrusted`, `umiak_*`, `umiak-mcp/<v>` |

For the future registry the namespace `ghcr.io/belov38/umiak-<service>:<tag>` is chosen;
local compose images stay `umiak-<service>:dev`. R1 changes references/labels
but does not publish images and does not create a Docker Hub repository. Existing image
artifacts are not renamed: new ones are built from the renamed source.

The headers include `Team`, `Confirm-Delete`, `Request-Id`, `Port-Token`, `Error-Code`,
`Command-Id`, offsets, screen/cursor sizes, `Machine-Id`, `Boot-Id`,
`Agent-Instance-Id`, `Vmgenid`, `Agent-Version`, `Gateway-Instance`, `Conn-Epoch`,
`Conn-Id`, `Instance-Url`, `Lane`, `Caller` and trailers. The lowercase variants change too.
`X-Sbx-Desktop-User: sbx` becomes `X-Umiak-Desktop-User: umiak`.
The API key CRC is computed over the **new** prefix + body; replacing the text in an old key
is impossible: only the hash is in the DB. Keys are reissued, regexes/scanners/display lengths
are updated; the reserved `umiaks_` stays forbidden in the MVP.

The public paths `/v1/*`, `/api/v1/*`, `/mcp`, `/.well-known/*`, `/oauth2/*`,
`/app`, `/admin`, health/metrics, and `/v1/connect` are kept. The only URL exception
for the brand is `/sbx-auth/*`. The RPC `/sbx.agent.v1.…` and `/sbx.tunnel.v1.…` change together
with the proto, this is the internal wire API. The public `sb_` stays as an abbreviation of sandbox;
the variables `sb`, the words sandbox and snapshot are not the old brand.

## 4. What we keep

1. **Other products:** boat.dev as the original/future external provider (S14), URLs and
   attribution; Sunshine, moonlight-web, coturn/turnserver, `user`, SYSTEM,
   qemu-guest-agent, oauth2-proxy (including clientId), Keycloak, PostgreSQL,
   `KC_*`, `OAUTH2_PROXY_*`, `POSTGRES_*`, `PAYLOAD_SECRET`, `DATABASE_URL`,
   `NODE_EXTRA_CA_CERTS`, upstream module names, licenses, pinned versions/hashes.
   Our own wrappers/units/images of these products change, the upstream identity does not.
2. **Infrastructure outside the brand:** `pve`, `local-lvm`, VG `pve`, thin pool `data`,
   `vmbr0`, `10.88.0.0/24`, CT 590, VMIDs, the MAC allocation scheme, LAN/tailnet addresses,
   `vm-<id>-disk-N`, `base-<id>-disk-N`, the original Windows ISO, and the personal VMs 9000/9001.
   `keycloak` as a separate DB/user/service is kept. New DSNs use the new
   app DB/user, and schema and entity names are not renamed for the brand.
3. **Ports:** 443 gateway; 2222 SSH; Serve 8443/10000; loopback 8080/4180/8180/8090;
   internal API 8082, proxied API 8081, gateway 7000/9190, ops 9090/9091/9092;
   Postgres 5432; TURN 3478/5349 and the dev relay 61000–61040. We change names, not topology.
4. **History:** existing SQL and Payload migrations (including JSON snapshots), their numbers,
   hashes, and journal are **not edited and not squashed**. The new SQL migration
   `0500_umiak_names.sql` (the R1 block `0500–0599`) after all existing ones replaces the bodies of the
   notify functions `runtime.sandboxes_notify`, `hosted_ports_notify`, `operations_notify`,
   `desktop_notify`, `identity.notify_change`, `notify_ssh_revoke` with the new channels.
   Keep the triggers/transactionality and the notification payload; find all `pg_notify`
   in the DB catalog, do not limit yourself to the list. Payload hooks/listeners change in code;
   the old seed migrations send the old `sbx_config` before the listeners start — acceptable
   history, not runtime compatibility. New migrations use only Umiak.
5. Old commit SHAs, names of already finished branches, dates, and acceptance measurements are not rewritten.
   In docs we update the current contracts/commands; historical reports are explicitly marked
   as "before R1". R1 takes priority on a spelling conflict. The old names stay
   in the R1 map and the exact history allowlist; links to the current repo are moved to the new one.

## 5. Runbook of the clean dev move (future implementation only)

### 5.1. Preparation and the return point

Master assigns a downtime window; one implementer owns the cutover. Before acting,
take the current `qm list`, `pct list`, jobs, template builds, LV tags,
SDN/firewall references, and actual ports. The CT has **6 GiB**, the sandbox budget is
**8 GiB in total**; do not raise the limits and do not touch foreign VMs/LXCs/`vmbr0`.
All builds/verifies are run sequentially, checking RAM before each start.

Save outside git with modes 0700/0600: the dump of the app DB and Keycloak, Payload data,
compose .env/secrets, data encryption keys, the update signature, CA and trust fingerprints,
PVE ACL/token metadata, SDN/firewall configs, the CT config, Serve JSON, the source commit,
and images. Record a verified way of restoring; dumps/secrets are not included in the report.
The Payload configuration export is for comparison and manual reproduction: templates,
sizes, quotas, operator policy, environments. Users/teams/memberships and IdP subjects
are **created anew**; runtime rows, keys, browser sessions, and old encrypted secrets
are not imported. The needed dev environment values are set again by the operator, not by a bulk restore.

Disable incoming create/access, finish active operations, stop idp-sync and
other writers after cleanup. With the old stack/agent delete all own sandboxes,
saved snapshots, build clones, and temporary media in the allowed range; check
DB ↔ qm ↔ LVs. Old templates are retired, not active. Do not run the new prune over the old
tags; do not weaken ownership guards. Prepare a backup/export of the old templates for
rollback before deletion. If there is not enough disk for the backup — stop and report to master,
do not increase storage/the limit without Ilia's decision.

### 5.2. Host, network, and CT

1. Stop the old compose project by its explicit old name; keep the old volume/dump
   isolated for rollback. The new project `umiak` must not automatically pick up the
   volume `sbx_*`. Do not do a general Docker prune and do not delete foreign volumes.
2. Create the roles/user `umiak@pve`, token `dev`, pool `umiak`, and ACLs with the same
   minimal rights; check the allowed and forbidden operations with the new token.
   Revoke the old token at the cutover. Install `umiak-node`, config/state, and a new
   restricted SSH key; keep host-key pinning, do not disable TLS/SSH verification.
3. With no old VMs present, recreate only the own SDN zone `umiak` and VNet
   `umiak0`, with the same subnet/SNAT/DHCP/isolate-ports; reconcile dnsmasq paths/leases,
   template config refs and node-agent. The rename enables the pool `sandbox` only
   after checking that it is exclusively ours; foreign items are not moved/deleted.
4. **Every change of PVE firewall/IPSets/CT firewall/SDN with a risk of losing access —
   first an automatic rollback on the host**, with the affected configs saved.
   The timer must survive an SSH disconnect; for the firewall a 5-minute window (cp-gateway
   allows its own existing 3-minute timer). Check the timer before apply.
   First create the new IPSets `umiak-*` with the same content, then atomically switch
   rule references/groups and check compilation/connectivity. Do not delete the old IPSet
   while there are references. The TURN helper is adapted too: its rollback removes only
   its own tagged rules, preserving foreign/parallel changes. Do not consider turning off
   the datacenter firewall sufficient for restoring SDN; a snapshot of the network configs is mandatory.
5. Checks before cancelling the timer: operator SSH over LAN/tailnet, the PVE API, existing foreign
   guests reachable as before the change; a sandbox can reach only CT:443 and the allowed TURN,
   not the host/router/LAN/DB/ops, IPv6 deny is kept; internet/DNS work.
   Cancel the timer only after all checks. An error/lost connectivity → rollback.
   `/etc/nftables.conf` of the CT manages only `table inet filter`, **without `flush ruleset`**,
   otherwise Docker chains are lost. Keep the TURN namespace and the watchdog `inet umiak_turn`.
6. Do not recreate CT 590: with a root session rename the Unix login/group `sbx` to `umiak`,
   the home to `/home/umiak`, keeping uid/gid 1000, ownership, and the docker group. Check the new
   SSH before closing the root session. A new checkout `/home/umiak/umiak`, secrets/config with
   the right owners; do not leave an active service with the old home/working directory.
   Rename the CT hostname and the Tailscale hostname to `umiak-dev-cp`, the operator to `umiak`;
   the node identity/IP is kept, a repeated `tailscale up` is not needed unless necessary.

### 5.3. CA, names, data, and startup

- The new Serve name is `umiak-dev-cp.<current-tailnet>.ts.net`; check the actual
  MagicDNS/CertDomains, do not allow an automatic suffix from a duplicate name.
  The new preview is `*.umiak.100-64-10-7.sslip.io`; the tunnel stays
  `tunnel.192-168-68-90.sslip.io`, TURN is `turn.<tunnel-host>`. Re-check the addresses.
- The old CA is constrained to `tunnel.<LAN>` and **`sbx.<tailnet-IP>`**. One cannot simply move
  `ca.pem` to a new directory: create a new CA in `~/.config/umiak/dev-ca` with CN/O Umiak,
  constraints `tunnel.<LAN>` and `umiak.<tailnet-IP>`, then new tunnel/preview/TURN
  leaf certs. TURN stays a child name of the tunnel namespace. Keep the leaf lifetime and renewal
  per the current code; do not extend trust to arbitrary domains.
  Install the new CA on the Mac via the trust helper (a system dialog is possible); check
  SAN/constraints/chain and the refusal for a foreign name. Remove the old trust by fingerprint
  after acceptance, not in bulk by an approximate CN. New agent packages pin only the new CA.
- Create a fresh app DB/user `umiak`, a separate `keycloak` DB, the realm `umiak` from the new
  `realm-umiak.json`. Import does not update an existing realm, so do not try to
  rename it on top of the old DB. Run the SQL migrations including 0500,
  then the Payload migrations, then the topology bootstrap; seed the new catalogs/policies,
  pools empty. Until verified builds are registered, new creates are disabled.
- Rotate the app/Keycloak passwords, client secrets, service/cookie/cursor/data keys,
  the TURN REST secret, the SSH CA/host keys. Do not carry over active tokens; the update-signing key
  can safely be copied to a new path (the brand is not a reason to change the key), compare the recipe
  public keys. If an archive of the old stand is restored, it needs its old data keys.
- Update the issuer `/realms/umiak`, audiences/azp, the worker sync realm/client, groups,
  oauth2-proxy redirects/logout/whitelist, MCP PRM and Host/Origin allowlists, CSP,
  the gateway auth URL `/umiak-auth/authorize`, TLS paths, the clients' SSH host pins.
  Inside compose Keycloak is still reachable at `http://keycloak:8080`, the public
  issuer uses Serve; CT containers are not required to reach the external Serve URL.
- Save the Serve configuration for rollback, then reset/rebuild the mappings 8443
  `/`, `/v1`, `/mcp`, `/.well-known/oauth-protected-resource/mcp` and 10000 `/`.
  443 **is not given to Serve**, it is needed by the gateway previews. Check the new LE certificate,
  login/logout/device flow/MCP OAuth, and the absence of old issuers/redirects.
- Create dev users anew (`dev-users.sh` after the rename), assign the operator membership to
  the new group, perform JIT in Payload, issue new team API keys. Create CLI profiles
  via `umiak login`, do not copy credentials from `~/.config/sbx`.

### 5.4. Four templates and no compatibility window

Rebuild with new signed agent packages/CA: **linux 597 → linux-desktop 596 →
windows-desktop 595 → windows 598**. For Windows desktop first build the
pinned patched moonlight-web as now. Check the `extends` dependencies of the recipes;
each build uses its own exact VMID range. Do not use 599 as a spare
new active build: the old PoC does not meet the R1 contract, deregister it;
if it belongs to the platform, archive/retire it with the old tool, without touching
the original 9000/9001. The final placement is exactly the four slots set by Ilia.

Before rebuilding a slot check that it has no consumers and make a backup; do not mix
old/new LV tags. Versions/build IDs are new; after verify update the topology and the active
build references in Payload/runtime. Check inside Linux all units/paths/SSH CA,
in Windows the SCM, recovery commands, junctions current/previous, startup GPO, LSA, named
jobs/mutexes, seal/identity reset, and reboot-before-ready. The new Windows hostname is
`UMI` + the last 12 hex of the machineId, not `UMIAK` + 12 (it would exceed 15).

The old agent uses `sbx-tunnel.v1`, `sbx1`/`sbxt1`, and the old CA; the new gateway does not
accept them. At the cutover there are no old runtime VMs. Updating old agents through
the tunnel is not required; old snapshots are not registered, resuming an old disk is forbidden.
Separate negative tests confirm the refusal of the old handshake/SMBIOS without a fallback.

### 5.5. Completion and rollback

On failure stop the new stack and the new VMs, restore the host configs/old node binary,
CA, Serve, the old app/IdP dumps and secrets **as one consistent set**;
do not attach the new worker to the old DB or vice versa. For restored template backups
return the old tags/refs. Returning deleted dev sandboxes is not promised: they were cleaned before the cutover.

After full acceptance delete only confirmed own old roles/ACLs/pool,
SDN/firewall objects/references, restricted key, packages, networks, images, volumes,
inactive certs/trust and local credentials. Keep the encrypted rollback archive
for 7 days outside git, then delete it as a separate operation. No deletion command
inside a compound shell command; deleting each resource is a separate verified step.

## 6. Sequential implementation stages and a green main

One implementation thread, one branch, no parallel editors of shared files.
The stages are checkpoints within the branch, not permission to merge non-working halves of the rename.
Until final acceptance main stays the old consistent stack; master merges one
fully verified set. CI checks stay manual dispatch. No temporary
old protocol for the sake of intermediate commits.

| Stage | Result | Check before the next stage |
|---|---|---|
| R1.0 | Baseline, inventory/exceptions, window, backup/restore runbook recorded; competing implementations stopped | Clean tree, baseline local checks; all needed credentials available without logging; enough space/limits |
| R1.1 | Atomic source rename: manifests/lockfiles, five Go modules, proto namespace + regeneration, API/SDK/CLI/MCP/env/headers/cookies/SQL channels + 0500, security guards/tests | The full local gate below; the new wire passes, the old is rejected; a fresh DB + upgrade history test; no generated drift |
| R1.2 | Compose/Docker/CI, recipes/install/verify, PVE/dev-cp scripts, UI/docs/quickstart aligned with the map | The full gate again; compose base + dev/desktop/e2e config; build of all images, Linux/Windows packages; dry-run of scripts without SSH to the stand |
| R1.3 | Move of the dev stand per §5, new network/IdP/CA/data, four verified templates | Firewall with a timer; template verify of each recipe; smoke and TLS/ACL/ownership checks, readiness of all services |
| R1.4 | Full acceptance from outside and from a VM, cleanup of old objects, current build IDs/documentation | `e2e.sh` **20/20**, both `e2e-desktop`, TURN and the probes below; independent acceptance by master |
| R1.5 | Master merges the green branch; GitHub rename and re-pointing of tools | New clone/module resolution, remotes/worktrees/T3/dispatch checked; a final audit of the old name |

### 6.1. Local gate

All tools through `mise exec --`, versions from `mise.toml`, without updating dependencies
along the way. `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm lint`,
`pnpm typecheck`, `pnpm test`; regenerate lockfiles with the standard pnpm/uv and then
check a frozen/locked install. Python — `uv run --locked ruff check .`,
`ruff format --check .`, `pytest` in `packages/sdk-py` (with the prefix `uv run --locked`).

For each of the five Go modules: `go build ./...`, `go vet ./...`,
`go test -race ./...`, `golangci-lint run ./...`; separately the Linux integration tag
and `services/guest-agent/test/linux/run.sh`, a Windows amd64/arm64 cross-build
of the applicable modules. Windows-native agent tests need a runner/stand, a cross-build does not replace them.
Postgres-backed tests must really run with the new test DSN, not skip.

In `proto/`: `buf lint`, both generations (the regular one and `buf.gen.test.yaml`), a zero diff
after repeated generation. The breaking check against the old `main` **is expected**
to see the removal of the namespace. Do not disable it permanently and do not do a silent skip because of
the change `proto/sbx` to `proto/umiak`: check the diff as a permitted rename, update the
baseline guard workflows, after the merge check `buf breaking` against the new main.
Field numbers/semantics do not change. Run the OpenAPI/TS/Python generators from the
package scripts; compare public paths/operationIds, except the declared auth path,
check the Python `_async` → `_sync` generation, new imports, and the wheel build.

Contract tests: new key CRC/lengths, an old bearer rejected, headers/CORS/trailers,
stripping of planted headers/cookies, new proto procedure/type URLs and the Control
deny, SMBIOS max length with the longer prefix, package signature/install/self-update,
the Windows 15-char hostname; SQL triggers send the new NOTIFY and listeners invalidate the
route/identity/config/SSH revocation caches. Run the migrations on an empty DB and on a
copy of the old schema (to verify the chain, not as a way of moving the stand), check
the catalog function bodies and the absence of an active `sbx_*` NOTIFY. Old migrations are checksum-identical.

Validate the compose config for the base, gateway, dev-cp, desktop, and e2e overlays with
the necessary fixture env; do not print resolved secrets. Build all nine own
images; smoke version/health, CLI compile for the S7-supported platforms, `umiak mcp`
initialize/tools/list, npm pack, and a wheel import of `Umiak`/`AsyncUmiak`.

### 6.2. Stand acceptance

- Each of the four recipes: the regular `umiak-tpl verify` and the corresponding
  `infra/templates/<recipe>/verify.*`, all checks without FAIL; names/services/agent/CA
  are checked in the baked image. For desktop — `verify-desktop.ts <buildId>`;
  Windows-native agent tests via the S9 bench. Record the new versions and the number of checks,
  do not copy the old 97/100/112 from historical reports.
- `infra/dev-cp/e2e.sh` **20/20** with the new CLI and both SDKs: device login, lifecycle,
  exec/PTY, files, preview token/sso, SSH, fork/snapshot, idle-stop, delete; after
  the test no VMs/LVs/rows remain. Do not replace several SDK steps with mock tests.
- Linux: `infra/dev-cp/e2e-desktop.sh`; Windows: the same script with
  `UMIAK_E2E_TEMPLATE=windows-desktop`. On each — the real baked agent (without a
  diagnostic agent-package override), websocket and relay-only WebRTC, frames
  really change, MCP computer tools, fork credentials, stop/resume, old cookies
  rejected, cleanup. Sequentially, with the source stopped before the fork.
- On both desktops: `UMIAK_DESKTOP_TURN_TRANSPORTS=udp,tcp,tls`; one long-idle run
  on each OS with `UMIAK_DESKTOP_IDLE_HOLD_MS=1800000`, natural viewer closing
  and idle-stop without an API keepalive. `desktop-block-probe.ts` and `desktop-cache-probe.ts`.
- `infra/dev-cp/verify-turn.py` with `UMIAK_TURN_PROBE_GUARD=1`: UDP/TCP/TLS, Refresh expiry,
  peer restrictions/relay filter, fail-closed on loss of the table/address and recovery,
  a CT nftables reload does not break Docker/TURN. From a guest TCP/TLS TURN stays closed,
  only the intended UDP 3478 is allowed.
- A real browser login/logout, the admin gate of the new operator group, preview iframe/CSP,
  CLI profile/config perms, remote MCP OAuth + a new API key, PRM/issuer/audience,
  User-Agent/metrics with the new name. A repeated deploy is idempotent, the old realm/CA/agent
  are not accepted. The final grep has only the explained exceptions of §4/R1.

These are requirements for the implementer; **in the spec thread these checks are not run on the stand**.

## 7. GitHub, worktrees, and T3

The GitHub rename `belov38/boat-dev-clone` → `belov38/umiak` is performed by master **after the merge
of the implementation and acceptance**, when there are no more working branches with old module imports.
The rename must not be a way to bypass red checks. The repository stays private;
we do not reserve/publish packages and domains along the way.

1. Close/agree the remaining PRs and worktrees; save the list of branches, remotes, and
   `git worktree list --porcelain`. The repo rename is a GitHub metadata operation, it does not move files
   locally. After the rename set the origin of each clone to
   `https://github.com/belov38/umiak.git` (or the SSH equivalent), check fetch/push,
   the branch upstream. Worktrees of one clone usually share the remote config, separate
   clones are updated separately. Do not rely on the redirect of the old repo as a contract.
2. The Go paths are already new in the implementation: go.mod, go imports, buf go_package/module options,
   Dockerfiles. Check in a **fresh clone with a new Go cache** that the workspace does not hide
   requests to old modules; configure private access/GOPRIVATE to the exact new
   namespace with the existing credentials. Do not add permanent replaces to the old repo.
3. Check the manual Actions workflows, secrets/variables/environments, external
   allowlists/webhooks/integrations, release assets/links, image labels/source URLs,
   badges, and install snippets. Update references that store a URL as a string.
   Check repo-scoped package permissions, if they already exist. A new registry scope
   does not appear from a repo rename; publication is not needed for the local R1 build.
4. Update the T3 project display name and project path via the standard T3 setting after closing
   the active worktree threads. Do not rename the live
   `/Users/ib/.t3/worktrees/boat-dev-clone/...` by hand: Git worktree metadata and
   the T3 binding diverge. Preferably create a project on the new canonical checkout
   `umiak` and new worktrees with T3's tools, leave the old ones as closed history.
   If the canonical checkout is moved with Git, check `git worktree list`,
   the `.git` pointers and, if necessary, `git worktree repair`, then rebind T3.
   Check opening a new thread, cwd, git status/fetch, and task commands.
5. The remote checkout of the CT changes in R1.3 independently of the local T3 path; both forms
   are checked separately. Historical links to commits/PRs are acceptable as history,
   the current remotes and instructions use only the new URL.

## 8. Completion criterion and questions

Done when main contains the agreed rename, the stand works only with Umiak,
all four templates are rebuilt/verified, the gate of §6 is green, repo/remotes/T3 are rebound,
and the remnants of the old name are explained by an exact allowlist. Master gets the commit/build IDs,
the test results, the state of the rollback timer (not active after a successful check), and the list of
deleted own objects; there are no secrets in the report.

**There are no open questions for Ilia.** The technical decisions are made in this specification.
Domain registration, public publication, legal trademark checking, and an increase of
host limits are outside R1; the availability of the name is not a legal opinion. If the
backup/build really lacks the current disk/RAM, this is a separate blocker master → Ilia,
not a permission to change the limits. In this branch only R1 and the roadmap line change;
implementation/deploy/GitHub rename are done after master's review as a separate assignment.
