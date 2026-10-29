import {
	DELETE_RETRY_LIMIT,
	insertSandboxEvent,
	lockNode,
	type MachineState,
	type Operation,
	operationFromRow,
	TERMINAL_OPERATION_STATES,
} from "@sbx/core";
import { type Tx, withTx } from "@sbx/db";
import type { WorkerCtx } from "./context.ts";
import { lockSandboxRow, type MachineRow, withMachineLocked } from "./db.ts";

// Fenced step engine (S6 §7.1, §15.1). An executor bumps a counter when it
// starts (`operations.attempt`, `machines.exec_attempt` for machine-op) and
// keeps its value as a fencing token: every write is conditional on it. A
// stale executor (a pod that lost the database but still talks to Proxmox)
// gets zero rows on its next write and leaves with `FencedOut`.

/** The executor lost its fencing token: another attempt runs, or the work was superseded. */
export class FencedOut extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FencedOut";
	}
}

/** The operation deadline passed (S6 §7.1 p. 3): compensate and fail. */
export class DeadlineExceeded extends Error {
	readonly retryable = false;
	readonly code = "deadline_exceeded";
	constructor(operationId: string) {
		super(`operation ${operationId}: deadline passed`);
		this.name = "DeadlineExceeded";
	}
}

/**
 * What shared steps (machine preparation, waits) need from a fence: a
 * re-check and a fenced transaction. `tx` takes the locks in lock order
 * (sandbox row, node lock when `nodeId` is given, the fence row) and throws
 * `FencedOut` before calling `fn` if the token is no longer valid.
 */
export interface StepFence {
	/** Clone slot holder id, unique per executor attempt. */
	readonly holder: string;
	/**
	 * The operation deadline that bounds waits inside steps (capacity, clone
	 * slot); null = no cap (machine-op, or an operation without a deadline).
	 */
	readonly deadline: { at: Date; operationId: string } | null;
	check(): Promise<unknown>;
	tx<T>(fn: (tx: Tx) => Promise<T>, opts?: { nodeId?: string }): Promise<T>;
}

/**
 * True when the operation has a deadline and it passed. A NULL deadline means
 * "none" for delete and "not set yet" for a fork target's create (the fork
 * sets it when its snapshot is ready, §7.7): never passed.
 */
export function deadlinePassed(
	op: { deadlineAt: Date | null },
	now: Date = new Date(),
): boolean {
	return op.deadlineAt !== null && op.deadlineAt.getTime() <= now.getTime();
}

export interface OperationError {
	code: string;
	message: string;
	retryable?: boolean;
}

async function loadOp(
	q: Pick<Tx["client"], "query">,
	id: string,
	lock = false,
): Promise<Operation | null> {
	const r = await q.query(
		`SELECT * FROM runtime.operations WHERE id = $1${lock ? " FOR UPDATE" : ""}`,
		[id],
	);
	return r.rows[0] ? operationFromRow(r.rows[0]) : null;
}

const isTerminal = (op: Operation): boolean =>
	TERMINAL_OPERATION_STATES.includes(op.state);

/** Fencing over an `operations` row (sandbox-op). */
export class Fenced implements StepFence {
	readonly #ctx: WorkerCtx;
	readonly attempt: number;
	/** The operation as last read by this executor. */
	op: Operation;

	private constructor(ctx: WorkerCtx, op: Operation) {
		this.#ctx = ctx;
		this.op = op;
		this.attempt = op.attempt;
	}

	get id(): string {
		return this.op.id;
	}

	get sandboxId(): string {
		return this.op.sandboxId;
	}

	get holder(): string {
		return `op:${this.op.id}:${this.attempt}`;
	}

	get deadline(): { at: Date; operationId: string } | null {
		const at = this.op.deadlineAt;
		return at === null ? null : { at, operationId: this.op.id };
	}

	/**
	 * Takes the operation (S6 §7.1 p. 2): `pending -> running` (or keeps
	 * `running`) and `attempt + 1` under the sandbox row lock. Returns null for
	 * an unknown or terminal operation, and for a child whose parent has not
	 * succeeded yet (the parent enqueues it). A child whose parent `failed` or
	 * was `superseded` fails with `fork_failed`: its sandbox goes `creating ->
	 * error` and its `allocating` machines to `deleting` (they hold reserved
	 * RAM and have no VM yet).
	 */
	static async begin(
		ctx: WorkerCtx,
		operationId: string,
	): Promise<Fenced | null> {
		const first = await loadOp(ctx.pool, operationId);
		if (first === null || isTerminal(first)) return null;
		return withTx(ctx.pool, async (tx) => {
			await lockSandboxRow(tx, first.sandboxId);
			const op = await loadOp(tx.client, operationId, true);
			if (op === null || isTerminal(op)) return null;
			if (op.parentOperationId !== null) {
				const parent = await loadOp(tx.client, op.parentOperationId);
				if (parent?.state === "pending" || parent?.state === "running") {
					return null;
				}
				if (parent?.state !== "succeeded") {
					await failForkChild(ctx, tx, op);
					return null;
				}
			}
			const r = await tx.client.query(
				`UPDATE runtime.operations
				 SET state = 'running', attempt = attempt + 1,
				     started_at = COALESCE(started_at, now()), version = version + 1
				 WHERE id = $1 AND state IN ('pending', 'running')
				 RETURNING *`,
				[operationId],
			);
			return r.rows[0] ? new Fenced(ctx, operationFromRow(r.rows[0])) : null;
		});
	}

	/** Re-reads the operation; `FencedOut` if it is not `running` with our attempt. */
	async check(): Promise<Operation> {
		const op = await loadOp(this.#ctx.pool, this.op.id);
		if (op === null || op.state !== "running" || op.attempt !== this.attempt) {
			throw new FencedOut(
				`operation ${this.op.id}: attempt ${this.attempt} fenced out (state ${op?.state ?? "missing"}, attempt ${op?.attempt ?? "-"})`,
			);
		}
		this.op = op;
		return op;
	}

	async tx<T>(
		fn: (tx: Tx) => Promise<T>,
		opts: { nodeId?: string } = {},
	): Promise<T> {
		return withTx(this.#ctx.pool, async (tx) => {
			await lockSandboxRow(tx, this.op.sandboxId);
			if (opts.nodeId !== undefined) await lockNode(tx, opts.nodeId);
			const r = await tx.client.query<{ state: string; attempt: number }>(
				"SELECT state, attempt FROM runtime.operations WHERE id = $1 FOR UPDATE",
				[this.op.id],
			);
			const row = r.rows[0];
			if (row?.state !== "running" || row.attempt !== this.attempt) {
				throw new FencedOut(
					`operation ${this.op.id}: attempt ${this.attempt} fenced out`,
				);
			}
			return fn(tx);
		});
	}

	/** `UPDATE operations SET step, progress = progress || $p WHERE id AND attempt AND state = 'running'`. */
	async recordStep(
		step: string,
		progress: Record<string, unknown> = {},
	): Promise<void> {
		const op = await this.tx(async (tx) => {
			const r = await tx.client.query(
				`UPDATE runtime.operations
				 SET step = $3, progress = progress || $4::jsonb, version = version + 1
				 WHERE id = $1 AND attempt = $2 AND state = 'running'
				 RETURNING *`,
				[this.op.id, this.attempt, step, JSON.stringify(progress)],
			);
			if (!r.rows[0]) throw new FencedOut(`operation ${this.op.id}: step lost`);
			return operationFromRow(r.rows[0]);
		});
		this.op = op;
	}

	/**
	 * Ends the operation. `apply` runs in the same fenced transaction (sandbox
	 * and machine state of the final step).
	 */
	async finish(
		state: "succeeded" | "failed",
		error?: OperationError,
		apply?: (tx: Tx) => Promise<void>,
	): Promise<void> {
		const op = await this.tx(async (tx) => {
			const r = await tx.client.query(
				`UPDATE runtime.operations
				 SET state = $3, error_code = $4, error_message = $5, retryable = $6,
				     finished_at = now(), version = version + 1
				 WHERE id = $1 AND attempt = $2 AND state = 'running'
				 RETURNING *`,
				[
					this.op.id,
					this.attempt,
					state,
					error?.code ?? null,
					error?.message ?? null,
					error === undefined ? null : (error.retryable ?? false),
				],
			);
			if (!r.rows[0])
				throw new FencedOut(`operation ${this.op.id}: finish lost`);
			if (apply) await apply(tx);
			return operationFromRow(r.rows[0]);
		});
		this.op = op;
	}

	deadlinePassed(now?: Date): boolean {
		return deadlinePassed(this.op, now);
	}
}

async function failForkChild(
	ctx: WorkerCtx,
	tx: Tx,
	op: Operation,
): Promise<void> {
	const message = "the parent fork operation did not succeed";
	await tx.client.query(
		`UPDATE runtime.operations
		 SET state = 'failed', error_code = 'fork_failed', error_message = $2, retryable = false,
		     finished_at = now(), version = version + 1
		 WHERE id = $1 AND state IN ('pending', 'running')`,
		[op.id, message],
	);
	const s = await tx.client.query<{ state: string }>(
		`UPDATE runtime.sandboxes
		 SET state = 'error', error_code = 'fork_failed', error_message = $2,
		     state_changed_at = now(), version = version + 1
		 WHERE id = $1 AND state = 'creating'
		 RETURNING state`,
		[op.sandboxId, message],
	);
	if (s.rowCount === 1) {
		await insertSandboxEvent(tx, {
			sandboxId: op.sandboxId,
			type: "state_changed",
			fromState: "creating",
			toState: "error",
			reason: "fork_failed",
			data: { operationId: op.id, parentOperationId: op.parentOperationId },
		});
	}
	const m = await tx.client.query<{ id: string }>(
		`UPDATE runtime.machines
		 SET state = 'deleting', state_changed_at = now(), version = version + 1
		 WHERE sandbox_id = $1 AND state = 'allocating'
		 RETURNING id`,
		[op.sandboxId],
	);
	for (const { id } of m.rows) {
		await ctx.jobs.send(
			tx,
			"machine-op",
			{ machineId: id, action: "delete" },
			{ singletonKey: id, retryLimit: DELETE_RETRY_LIMIT },
		);
	}
}

// ---------------------------------------------------------------------------

export interface Step {
	name: string;
	/** "Already done?" check; a skipped step is still recorded. */
	skipIf?: () => Promise<boolean>;
	/** The step; a returned plain object is merged into `progress`. */
	run: () => Promise<unknown>;
}

/**
 * Runs the steps after the last recorded one (`operations.step`). Before each
 * step it re-reads the operation (`FencedOut` if taken over or superseded)
 * and throws `DeadlineExceeded` once the deadline passed; after each step it
 * records the step under the fence.
 */
export async function runSteps(fenced: Fenced, steps: Step[]): Promise<void> {
	const names = steps.map((s) => s.name);
	const done = fenced.op.step;
	let start = 0;
	if (done !== null) {
		const i = names.indexOf(done);
		if (i < 0) {
			throw new Error(
				`operation ${fenced.id}: recorded step '${done}' is not one of ${names.join(", ")}`,
			);
		}
		start = i + 1;
	}
	for (const s of steps.slice(start)) {
		const op = await fenced.check();
		if (deadlinePassed(op)) throw new DeadlineExceeded(op.id);
		if (s.skipIf && (await s.skipIf())) {
			await fenced.recordStep(s.name);
			continue;
		}
		const out = await s.run();
		const progress =
			typeof out === "object" && out !== null && !Array.isArray(out)
				? (out as Record<string, unknown>)
				: {};
		await fenced.recordStep(s.name, progress);
	}
}

// ---------------------------------------------------------------------------

export type MachineAction = "provision" | "delete";

/** States in which a provision may start (or resume after a crash). */
const PROVISION_BEGIN: readonly MachineState[] = [
	"allocating",
	"provisioning",
	"booting",
];
/** States in which a running provision keeps its fence (events may set `warm` first). */
const PROVISION_LIVE: readonly MachineState[] = [...PROVISION_BEGIN, "warm"];

/**
 * Fencing over `machines.exec_attempt` (machine-op, §15.1).
 *
 * Delete always wins over provision:
 * - provision begins (and bumps `exec_attempt`) only in `allocating`,
 *   `provisioning` or `booting`, and keeps its fence only while the machine is
 *   in one of those or `warm`;
 * - delete begins in any state but `deleted`, moves the machine to `deleting`
 *   in the same transaction and bumps `exec_attempt`.
 * So a provision in flight loses its fence on its next write or check, and a
 * late or redelivered provision job cannot start (and cannot bump the counter
 * under a running delete). Only another delete attempt can fence a delete out.
 */
export class MachineFence implements StepFence {
	readonly #ctx: WorkerCtx;
	readonly machineId: string;
	readonly action: MachineAction;
	readonly attempt: number;
	/** The machine row as of `begin`. */
	readonly machine: MachineRow;

	private constructor(ctx: WorkerCtx, action: MachineAction, m: MachineRow) {
		this.#ctx = ctx;
		this.machineId = m.id;
		this.action = action;
		this.attempt = m.exec_attempt;
		this.machine = m;
	}

	get holder(): string {
		return `machine:${this.machineId}:${this.attempt}`;
	}

	/** Machine-op has no operation deadline. */
	get deadline(): null {
		return null;
	}

	static async begin(
		ctx: WorkerCtx,
		machineId: string,
		action: MachineAction,
	): Promise<MachineFence | null> {
		return withMachineLocked(ctx.pool, machineId, async (tx, m) => {
			if (m === null) return null;
			if (action === "provision" && !PROVISION_BEGIN.includes(m.state)) {
				return null;
			}
			if (action === "delete" && m.state === "deleted") return null;
			const r = await tx.client.query<MachineRow>(
				`UPDATE runtime.machines
				 SET exec_attempt = exec_attempt + 1,
				     state = CASE WHEN $2 THEN 'deleting' ELSE state END,
				     state_changed_at = CASE WHEN $2 AND state <> 'deleting' THEN now() ELSE state_changed_at END,
				     version = version + 1
				 WHERE id = $1
				 RETURNING *`,
				[machineId, action === "delete"],
			);
			const row = r.rows[0];
			return row ? new MachineFence(ctx, action, row) : null;
		});
	}

	#valid(m: Pick<MachineRow, "state" | "exec_attempt"> | null): boolean {
		if (m === null || m.exec_attempt !== this.attempt) return false;
		return this.action === "provision"
			? PROVISION_LIVE.includes(m.state)
			: m.state === "deleting";
	}

	#out(m: Pick<MachineRow, "state" | "exec_attempt"> | null): FencedOut {
		return new FencedOut(
			`machine ${this.machineId}: ${this.action} attempt ${this.attempt} fenced out (state ${m?.state ?? "missing"}, exec_attempt ${m?.exec_attempt ?? "-"})`,
		);
	}

	async check(): Promise<MachineRow> {
		const r = await this.#ctx.pool.query<MachineRow>(
			"SELECT * FROM runtime.machines WHERE id = $1",
			[this.machineId],
		);
		const m = r.rows[0] ?? null;
		if (m === null || !this.#valid(m)) throw this.#out(m);
		return m;
	}

	async tx<T>(
		fn: (tx: Tx) => Promise<T>,
		opts: { nodeId?: string } = {},
	): Promise<T> {
		return withMachineLocked(
			this.#ctx.pool,
			this.machineId,
			async (tx, m) => {
				if (!this.#valid(m)) throw this.#out(m);
				return fn(tx);
			},
			opts,
		);
	}
}
