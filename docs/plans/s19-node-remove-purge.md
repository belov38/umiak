# S19 node removal with purge — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Add or remove sandbox nodes → remove" deletes everything Umiak owns on the node (sandboxes, machines, snapshots, templates) after a clear listing and confirmation, then retires the node as today.

**Architecture:** Core gets a read-only `nodeRemovalPlan` (human-readable inventory + hard blockers) and `requestNodePurge` (cordon, then the normal lifecycle deletes: `requestSystemDelete` for sandboxes, `snapshot-op delete`, `machine-op delete`). The worker does the actual PVE work exactly as for API deletes. The console bridge (`nodes.mjs`) exposes `removal-plan` and `purge` (send-only pg-boss). The installer lists, confirms (strong confirmation when sandboxes/snapshots/machines exist), requests the purge, polls with progress, retires templates through the existing `retire-template`, then `retire` + host cleanup.

**Tech Stack:** TypeScript (core, vitest + real PostgreSQL), Node ESM bridge, Python installer (pytest, ruff).

**Spec:** `docs/specs/s19-multi-node.md` (Safe removal), decision of 2026-11-09 (Ilia): removing a node deletes all Umiak-owned objects on it after an explicit confirmation.

## Global Constraints

- Reuse the lifecycle path: no raw `UPDATE … state='deleted'` and no direct PVE deletes for sandboxes/machines/snapshots; templates only via `retireNodeTemplate`.
- Lock order: sandbox row before node advisory lock (`requestSystemDelete` per sandbox, own transaction).
- Hard blockers (running/interrupted build or preparation job other than a template retirement intent, unfinished volume transfer, orphan VMID lease, orphan disk) refuse the purge before anything is deleted.
- Interactive: typing the node name is required when sandboxes/machines/snapshots exist, even with `--yes`. Non-interactive: `--yes --delete-sandboxes`.
- Templates-only node: the normal confirmation only.
- Everything idempotent: a rerun after a partial failure continues.
- Installer's own host node stays excluded from the remove list (unchanged).

## Review Focus

- Rerun after a partial purge (some sandboxes already `deleted`, node cordoned, a template retirement intent open) must continue, not refuse → test `purge is idempotent and an open retirement intent is not a blocker`.
- A sandbox whose current machine sits on the node but `sandboxes.node_id` differs → included (test in core plan test).
- Worker down / delete stuck → installer stops after a stall timeout with a plain list of what remains and "rerun to continue" → installer test `purge stall reports remaining items`.
- `retire-template` failure (e.g. PVE error) → plain message with template slug and VMID, no raw stack → installer test.
- Non-interactive without `--delete-sandboxes` while sandboxes exist → usage error before any deletion → installer test.

---

### Task 1: Core removal plan and purge request

**Files:**
- Create: `packages/core/src/node-purge.ts`, `packages/core/test/node-purge.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces (Produces):**
- `nodeRemovalPlan(q: Queryable, nodeId: string): Promise<NodeRemovalPlan>` where `NodeRemovalPlan = { sandboxes: {id, slug, name, state, vmids:number[]}[]; machines: {id, vmid, state}[]; snapshots: {id, name, kind, state}[]; templates: {buildId, slug, version, vmid, status}[]; blockers: {kind, id, message}[] }`. `machines` = live machines on the node without a live sandbox. `blockers` = only what the purge cannot clear.
- `requestNodePurge(pool, jobs: JobSender, nodeId): Promise<NodeRemovalPlan>` — throws `Error(message of first blockers…)` when blockers exist; cordons; requests deletes; returns the plan after the requests.

- [ ] Tests: plan lists a sandbox (slug, VMID), saved snapshot by name, orphan warm machine, template (slug, version, VMID); running build job is a blocker with plain message; template retirement intent is not; purge sends `sandbox-op`, `snapshot-op`, `machine-op` jobs, cordons, sandbox → `deleting` with a `delete` operation reason `node_removal`; second purge sends no duplicate sandbox delete operation; purge with a blocker refuses and changes nothing.
- [ ] Implement, run `pnpm --filter @umiak/core vitest run test/node-purge.test.ts`, commit.

### Task 2: Console bridge ops

**Files:** Modify `deploy/compose/quickstart/nodes.mjs`; test `apps/worker/test/setup-node-console.test.ts`.

- `{"op":"removal-plan","nodeId"}` → plan (also for a retired node: empty lists).
- `{"op":"purge","nodeId"}` → `requestNodePurge` with injected `jobs` (default: send-only PgBoss like the API, `ensureQueues`).
- [ ] Test through real PostgreSQL with `RecordingJobSender`; commit.

### Task 3: Installer flow

**Files:** Modify `deploy/installer/umiak_installer/nodes.py` (`remove_node`), `main.py` (`--delete-sandboxes`), tests `deploy/installer/tests/test_nodes.py`.

`remove_node(runner, current, node, *, ui, console=None, host=None, delete_sandboxes=False, sleep=time.sleep, clock=time.monotonic)`:
1. list → target; retired target skips to host cleanup.
2. `removal-plan` → print what will be deleted and what is retained; blockers → `InstallerError` with their messages.
3. `ui.confirm`; if sandboxes/machines/snapshots: non-interactive needs `delete_sandboxes` (UsageError), interactive `ui.typed(..., node)`.
4. `purge`; poll `removal-plan` every 5 s, print progress when counts change; stall 10 min without change → InstallerError listing remaining items + "rerun to continue".
5. `retire-template` per template with progress; failure → plain message.
6. `retire`; blocked → describe via plan; host `remove`.
- [ ] Tests (real `main.Ui` where confirmation semantics matter); `uv run pytest`, `ruff`; commit.

### Task 4: Docs

Update `docs/specs/s19-multi-node.md` (goal line + Safe removal) and `docs/operations-multi-node.md` (Removing a node, bridge ops). Commit, push.
