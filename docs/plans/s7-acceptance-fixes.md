# S7: follow-ups after acceptance and wiring in the S3 agent

> Historical plan, predating R1. Current names and contracts: `docs/specs/rename-umiak.md`.

> **For implementers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development and superpowers:test-driven-development. Steps are `- [ ]` checkboxes.

**Goal:** close the S7 acceptance remarks (master, 2026-10-30): merge `main` with S5, deterministic tests, small leftovers, wire in the real S3 agent (`ConnectAgentApi`), store `outputTruncated`, migration ranges in the roadmap.

**Specification:** `docs/specs/s7-public-api.md` (including §23), `docs/specs/s3-guest-agent.md`, `proto/sbx/agent/v1`. Previous plan: `docs/plans/s7-public-api.md` (its global constraints stay in force).

## Global constraints

- Everything in the "Global constraints" of `docs/plans/s7-public-api.md`, plus: do not run anything on CT 590 and `pve`; external tunnels and relay services are forbidden; GitHub workflows only `workflow_dispatch`.
- Migrations: `0200–0299` — runtime (S6 and runtime table changes from S7), `0300–0399` — S7. A new column in an S6 table from this work goes in `03xx` (master's instruction), with a comment in the migration.
- Tests must be deterministic under the full parallel load of `pnpm -r test`: waits on conditions, fake timers, or exact offset accounting, no fixed `sleep` as a correctness condition.

## Tasks

### Task A1: merge `main` (S5)
- [ ] `git merge origin/main` (head `f1dbbbe` or newer). Conflicts: `pnpm-lock.yaml` — regenerate (`pnpm install`), do not edit by hand; `deploy/compose/README.md` — combine both texts; `deploy/compose/config/sbx.yaml` — keep `vmidMax: 589` and the template build entry for 598 from S5, keep our neutral PVE address defaults; `docs/specs/s1-proxmox-foundation.md` — combine (our neutral defaults + S5 edits).
- [ ] `pnpm install --frozen-lockfile`, `pnpm -r typecheck`, `pnpm lint`, `pnpm build`, tests of affected packages (worker, bench, config, template-builder) — green. Commit the merge.

### Task A2: deterministic tests, container cleanup
- [ ] `apps/api/test/pty.test.ts` (around 825–833, "ping every pingMs…") and `apps/api/test/commands-stream.test.ts` (around 93–95, `stdoutOffset` 150001 vs 149996): find the cause of the nondeterminism and fix it (wait on a condition, fake timers, exact offset accounting — for example, wait until the fake agent has written all the output, or check the offset against the actual stream size). Review the other tests in `apps/api`, `packages/sdk-ts`, `apps/cli`, `packages/sdk-py` for the same class of problem (fixed `sleep`/timeouts as a condition) and fix what is found.
- [ ] Test Postgres containers (`packages/db/src/testing/global-setup.ts`) are removed even on SIGKILL of the parent: for example, a container with `--rm` and a watchdog process/`--label` + cleanup of "orphaned" containers with that label and a dead owner at the next start (owner pid in the label), if feasible without fragility.
- [ ] Proof: `pnpm -r test` green three times in a row (the summary output of each run goes in the report).

### Task A3: small leftovers
- [ ] `sbx login --key-stdin` (`apps/cli/src/commands/login.ts` ~124): the key is the first non-empty line, extra text (a second line) → argument error; format and CRC are checked locally (`isWellFormedApiKey`), clear message, exit code 2, before any network request. Tests.
- [ ] `apps/api/src/http/body-limit.ts`: for the upload chunk route (`PUT /files/uploads/{upload}`), instead of the general 60 s deadline use an idle/progress timeout (no new bytes for N seconds); the general deadline stays for other bounded bodies. A test with a slow but continuous client passes; a stalled client gets an error.
- [ ] PTY WebSocket: an `offset` past the end of the stream of a finished PTY command → close with the error `range_not_satisfiable` (an `error` frame and a close code consistent with §10.2), no endless reconnects; test.

### Task A4: `ConnectAgentApi` — the real S3 agent
- [ ] `apps/api/src/agent/connect.ts`: `ConnectAgentApi implements AgentApi` on top of `AgentClient.transport(machineId)` and the generated clients `@sbx/proto/agent/v1` (`Process`, `Filesystem`, `System`), following the "Wiring S3" section of `apps/api/README.md` and the example of `apps/worker/src/adapters/agent-connect.ts`: `*_UNSPECIFIED` enums, zeros → `null`, `bigint` ↔ `number` with a safe-integer check, `Sbx-Request-Id` for mutations, `resumableAttach`, error table (`AgentCallError` for agent responses with detail, `AgentUnavailableError`/`Unavailable` — unavailability), `files()` via `AgentClient.fetch`, capabilities from `tunnel.tunnel_sessions`.
- [ ] `DeadlineExceeded` (and other "outcome unknown") on mutations without an idempotency key (file `makeDir`/`move`/`chmod`/`remove`, `updateEnv`/`updateSecrets`, input without a session, signal) → `retryable: false`, `details.outcome: "unknown"`; repeatable reads stay `retryable: true`. Route-level tests.
- [ ] `startApi` uses `ConnectAgentApi` (instead of `UnwiredAgentApi`), configured like the worker (service token, PgRegistry).
- [ ] Integration tests against the real agent: a small Go program in the `services/guest-agent` module (for example, `services/guest-agent/cmd/sbx-agent-harness`) that, like `services/guest-agent/test/harness`, runs in one process a real S2 gateway (registry in the given Postgres, internal listener on a loopback port) and a real agent with fake OS dependencies, registers a machine and prints the JSON `{internalUrl, serviceToken, machineId}`; TS tests (`apps/api/test/agent-real.test.ts`) start it (built with `go build` in global setup or `go run`) and run scenarios through the api with `ConnectAgentApi`: commands (sync, stream, detached, attach by offset, input, kill, signal), PTY, files (content with Range, uploads, stat/list/mkdir/move/remove, archive), ports. If the agent's fake dependencies do not allow a scenario on macOS — the test is marked and explained in the report; everything that works must go into `pnpm -r test` (skipped if there is no `go`). Add the module to `go.work` if needed (`go work use`).

### Task A5: `outputTruncated` in the DB, roadmap
- [ ] Migration `03NN_command_output_truncated.sql`: a column in `runtime.commands` (per master's instruction — in the S7 range, with a comment that it is an S6 table); Drizzle schema; core: `completeCommand`/the event handler write it (from `exit`/`command.exited`/`output.truncated`); the Command resource returns the stored value when the agent is unavailable. Core and api tests.
- [ ] `docs/roadmap.md`: reserved migration ranges (`0200–0299` runtime: S6 and runtime table changes, `0300–0399` S7); §23 of the spec — what changed in this work.

### Task A6: full verification
- [ ] `pnpm install --frozen-lockfile`, `pnpm -r test` green three times in a row, `pnpm lint`, `pnpm build`, `pnpm -r typecheck`; compose smoke from scratch (without `pve`); final review of all changes in this work by a fresh subagent; push `s7-impl`.
