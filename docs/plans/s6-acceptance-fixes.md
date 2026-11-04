# S6: fixes after the acceptance of `eb9d214`

> Historical plan, predating R1. Current names and contracts: `docs/specs/rename-umiak.md`.

> **For implementers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development and superpowers:test-driven-development. Each regression test from `/tmp/s6acc-repros/` is first copied into the repository and fails (red), then the fix (green).

**Goal:** close the acceptance findings (H1, M1–M4, LOW), remove the `tunnel` fixture after the S2 merge, and wire in `@sbx/agent-client`.

**Specification:** `docs/specs/s6-control-plane.md`; main plan — `docs/plans/s6-control-plane.md` (decisions 1–17 stay in force).

## Global constraints

- Same as in the main plan: mise, `.ts` imports, no `erasableSyntaxOnly` violations, secrets not in logs or job data, comments in English.
- Changes to `packages/pve` are allowed for H1/M2, minimal and with tests (master will re-check S1 behavior).
- `pve` is free; host rules unchanged, connection by IP (`100.64.10.2`, TLS name `pve`).

## Review Focus

1. A repeated delete of one machine after its VMID was reused by another sandbox does not touch the foreign VM (H1).
2. A stuck `machine-events` job after kill -9 does not block machine events for longer than ~30–60 s (M1).
3. A start after fencing-out is not performed (M3).
4. Admission on several nodes does not leak `40P01` outward (M4).
5. No secret ends up in `operations.request.bodyHash` in recoverable form.

---

### Task F1: S2 in main — remove the `tunnel` fixture, wire in `@sbx/agent-client`

- Remove `packages/db/test/fixtures/0100_tunnel_init.sql`, `packages/db/src/tunnel-fixture.ts`, the flag `sbx-admin migrate --tunnel-fixture`, the test `apps/worker/test/admin.test.ts` about the fixture and its mentions in compose and README; the migration `db/migrations/0100_tunnel_init.sql` from `main` is the only source of the `tunnel` schema. The drift test is green.
- `HttpGatewayPort` finds the machine owner through `PgRegistry` (`@sbx/agent-client`) instead of its own SQL; on `421` — `registry.invalidate` and retry; no route → transient error. Where else S6 reads the registry (health: gateway freshness, `resolveAgentTarget`) — keep the SQL or move to `Registry`, record the decision.
- `AgentPort` stays `UnavailableAgentPort` (no S3 proto yet).
- The worker Docker image builds `@sbx/proto` and `@sbx/agent-client` (they have `dist`), compose comes up.

### Task F2: H1, M2, M3 — power and delete operations with owner check

- S1 (`packages/pve`): `Machines.delete/stop/start` accept an optional `expectedOwner` (machineId); under the node power lock (S6) and immediately before the action S1 reads the VMID lease and refuses (`OwnerMismatchError`, permanent) if `lease.ownerId !== expectedOwner` (no lease — acceptable for delete only if the VM is gone too).
- Worker: all machine delete/stop/start/shutdown calls go with `expectedOwner = machineId`; on `OwnerMismatch` the machine is considered already deleted (for delete) or the operation fails with `machine_state_conflict` (for start).
- M2: the create/fork rollback in S1 (`machine.ts:283-290`) runs under the same node power lock (through a callback/wrapper passed by the S6 adapter), not outside it.
- M3: after acquiring the power lock, start re-checks the fence (`fence.check()`), otherwise `FencedOut` without calling Proxmox.
- Regression tests: `zz-acc-vmid-reuse.test.ts`, `zz-acc-power-lock-rollback.test.ts`.

### Task F3: M1, M4 and cheap LOW items

- M1: `heartbeatSeconds: 30` on `machine-events` and an audit of all queues (`QUEUES`): every queue whose jobs can live longer than seconds has a heartbeat; explicit `expireInSeconds` where needed.
- M4: `admitCold` locks nodes in `node_id` order; `40P01`/`40001` in service transactions → retry the transaction (up to 3 times), then `out_of_capacity` (retryable). Regression: `zz-acc-lock-order.test.ts`.
- `allocate()` for one owner in parallel returns the existing lease (`zz-acc-allocator.test.ts`).
- A slug shaped like a UUID or with an id prefix (`sb_` etc. from S7 §5.3) is rejected (`zz-acc-slug-uuid.test.ts`).
- The test Postgres global setup removes the container together with its volume (`docker rm -f -v`).
- `bodyHash` is HMAC-SHA256 with a key derived from the current data key (`KeyRing`), not a bare sha256; the same for `idempotency_keys.request_hash` if it contains secrets.
- Fork checks the template's `enabled` and the storage thresholds, like create.
- `apps/worker/test/machine-prep.test.ts:358` — wait on a condition instead of 150 ms.
- Recover after a failed resume with a size decrease: RAM accounting by the VM's actual size (if simple), otherwise a known issue in the report.
- `failFast`/`pool_exhausted`: a code comment — not part of the MVP public contract, S7 does not expose it.
- S6 spec §6.1: add `machine_state_conflict` (approved by master).

### Task F4: verification

- `pnpm -r test`, `pnpm lint`, `pnpm -r typecheck`, `pnpm build`; regression tests red→green; `SBX_PVE_SMOKE=1` on `pve` with an empty world diff; `docker compose up`; push `s6-impl`.
