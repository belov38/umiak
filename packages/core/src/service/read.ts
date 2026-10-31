import { withTx } from "@sbx/db";
import {
	invalidState,
	notFound,
	operatorRequired,
	type ValidationIssue,
	validation,
} from "../errors.ts";
import { hasOperatorRights, type Principal } from "../principal.ts";
import {
	type Operation,
	operationFromRow,
	type Page,
	type Sandbox,
	sandboxFromRow,
} from "../rows.ts";
import {
	SANDBOX_STATES,
	type SandboxState,
	TERMINAL_OPERATION_STATES,
} from "../states.ts";
import {
	activeOperations,
	findSandboxRow,
	isUuid,
	loadOperation,
	loadSandbox,
	type Queryable,
	type SandboxRow,
	type SandboxServiceDeps,
	toSandbox,
} from "./common.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import {
	checkKnownKeys,
	checkLabels,
	checkName,
	checkSeconds,
	checkString,
	isPlainObject,
} from "./validate.ts";

// Reads (get, list, getOperation, waitForState) and the plain updates without
// an operation (update, extend; S6 §7.8).

export interface ListFilter {
	/** Default: every state except `deleted` (S7 §8.1). */
	state?: SandboxState[];
	/** All must match (`labels @> filter`). */
	labels?: Record<string, string>;
	template?: string;
	/** Case-insensitive prefix of name or slug. */
	q?: string;
	/** 1-200, default 50 (S7 §5.6). */
	limit?: number;
	/** Every team's sandboxes (S8 C3): operators only, else `forbidden`. */
	allTeams?: boolean;
	/** With `allTeams`: only this team (UUID). */
	teamId?: string;
}

export interface UpdateInput {
	name?: string | null;
	/** Replaces all labels. */
	labels?: Record<string, string>;
	/** null removes the TTL; on a ready sandbox the deadline becomes now + ttl. */
	ttlSeconds?: number | null;
	/** null disables idle-stop. */
	idleTimeoutSeconds?: number | null;
}

const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 200;

export async function getSandbox(
	deps: SandboxServiceDeps,
	p: Principal,
	idOrSlug: string,
): Promise<Sandbox> {
	const row = await findSandboxRow(deps.pool, p, idOrSlug);
	return toSandbox(deps.pool, row);
}

export async function getOperation(
	deps: SandboxServiceDeps,
	p: Principal,
	id: string,
): Promise<Operation> {
	if (!isUuid(id)) throw notFound("operation");
	const r = await deps.pool.query(
		`SELECT o.* FROM runtime.operations o
		 JOIN runtime.sandboxes s ON s.id = o.sandbox_id
		 WHERE o.id = $1 AND s.team_id = $2`,
		[id, p.teamId],
	);
	if (!r.rows[0]) throw notFound("operation");
	return operationFromRow(r.rows[0]);
}

function escapeLike(s: string): string {
	return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** The team's (or, for operators, every team's) sandboxes, newest first (`created_at DESC, id DESC`). */
export async function listSandboxes(
	deps: SandboxServiceDeps,
	p: Principal,
	filter: ListFilter = {},
	cursor?: string,
): Promise<Page<Sandbox>> {
	const issues: ValidationIssue[] = [];
	if (!isPlainObject(filter as unknown)) {
		throw validation([{ path: "filter", message: "must be an object" }]);
	}
	checkKnownKeys(
		filter as Record<string, unknown>,
		["state", "labels", "template", "q", "limit", "allTeams", "teamId"],
		issues,
	);
	if (filter.allTeams !== undefined && typeof filter.allTeams !== "boolean") {
		issues.push({ path: "allTeams", message: "must be a boolean" });
	}
	if (filter.teamId !== undefined) {
		if (filter.allTeams !== true) {
			issues.push({ path: "teamId", message: "needs allTeams=true" });
		} else if (!isUuid(filter.teamId)) {
			issues.push({ path: "teamId", message: "must be a team id" });
		}
	}
	const limit = filter.limit ?? LIST_DEFAULT_LIMIT;
	if (!Number.isInteger(limit) || limit < 1 || limit > LIST_MAX_LIMIT) {
		issues.push({
			path: "limit",
			message: `must be an integer in 1..${LIST_MAX_LIMIT}`,
		});
	}
	if (
		filter.state !== undefined &&
		(!Array.isArray(filter.state) ||
			!filter.state.every((s) => SANDBOX_STATES.includes(s)))
	) {
		issues.push({ path: "state", message: "unknown sandbox state" });
	}
	if (filter.labels !== undefined) checkLabels("labels", filter.labels, issues);
	if (filter.template !== undefined)
		checkString("template", filter.template, issues);
	if (filter.q !== undefined && typeof filter.q !== "string") {
		issues.push({ path: "q", message: "must be a string" });
	}
	if (issues.length > 0) throw validation(issues);
	if (filter.allTeams === true && !hasOperatorRights(p)) {
		throw operatorRequired();
	}
	const after = cursor === undefined ? null : decodeCursor(cursor);

	const where: string[] = [];
	const args: unknown[] = [];
	const arg = (v: unknown): string => {
		args.push(v);
		return `$${args.length}`;
	};
	if (filter.allTeams !== true) {
		where.push(`s.team_id = ${arg(p.teamId)}`);
	} else if (filter.teamId !== undefined) {
		where.push(`s.team_id = ${arg(filter.teamId)}::uuid`);
	}
	if (filter.state !== undefined && filter.state.length > 0) {
		where.push(`s.state = ANY(${arg(filter.state)}::text[])`);
	} else {
		where.push("s.state <> 'deleted'");
	}
	if (filter.labels !== undefined && Object.keys(filter.labels).length > 0) {
		where.push(`s.labels @> ${arg(JSON.stringify(filter.labels))}::jsonb`);
	}
	if (filter.template !== undefined) {
		where.push(`s.template_slug = ${arg(filter.template)}`);
	}
	if (filter.q !== undefined && filter.q !== "") {
		const like = arg(`${escapeLike(filter.q)}%`);
		where.push(`(s.name ILIKE ${like} OR s.slug ILIKE ${like})`);
	}
	if (after !== null) {
		where.push(
			`(s.created_at, s.id) < ((${arg(after.c)}::timestamp AT TIME ZONE 'UTC'), ${arg(after.id)}::uuid)`,
		);
	}
	const r = await deps.pool.query<SandboxRow & { cursor_ts: string }>(
		`SELECT s.*, to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS cursor_ts
		 FROM runtime.sandboxes s
		 WHERE ${where.join(" AND ")}
		 ORDER BY s.created_at DESC, s.id DESC
		 LIMIT ${arg(limit + 1)}`,
		args,
	);
	const rows = r.rows.slice(0, limit);
	const ops = await activeOperations(
		deps.pool,
		rows.map((row) => row.id),
	);
	const last = rows.at(-1);
	return {
		data: rows.map((row) => sandboxFromRow(row, ops.get(row.id) ?? null)),
		nextCursor:
			r.rows.length > limit && last !== undefined
				? encodeCursor({ c: last.cursor_ts, id: last.id })
				: null,
	};
}

const UPDATE_KEYS: readonly (keyof UpdateInput)[] = [
	"name",
	"labels",
	"ttlSeconds",
	"idleTimeoutSeconds",
];

/** Plain update with a version check (S6 §7.8); not in `deleting`/`deleted`. */
export async function updateSandbox(
	deps: SandboxServiceDeps,
	p: Principal,
	idOrSlug: string,
	patch: UpdateInput,
): Promise<Sandbox> {
	if (!isPlainObject(patch as unknown)) {
		throw validation([{ path: "", message: "must be an object" }]);
	}
	const issues: ValidationIssue[] = [];
	checkKnownKeys(patch as Record<string, unknown>, UPDATE_KEYS, issues);
	if (patch.name !== undefined) checkName("name", patch.name, issues);
	if (patch.labels !== undefined) checkLabels("labels", patch.labels, issues);
	if (patch.idleTimeoutSeconds !== undefined) {
		checkSeconds("idleTimeoutSeconds", patch.idleTimeoutSeconds, issues, {
			nullable: true,
		});
	}
	if (patch.ttlSeconds !== undefined) {
		const { maxTtlSeconds } = await deps.config.defaults();
		checkSeconds("ttlSeconds", patch.ttlSeconds, issues, {
			nullable: true,
			max: maxTtlSeconds,
		});
	}
	if (issues.length > 0) throw validation(issues);

	return withTx(deps.pool, async (tx) => {
		const row = await findSandboxRow(tx.client, p, idOrSlug, {
			lock: true,
			write: true,
		});
		if (row.state === "deleting" || row.state === "deleted") {
			throw invalidState(row.state);
		}
		const sets: string[] = [];
		const args: unknown[] = [row.id, row.version];
		const arg = (v: unknown): string => {
			args.push(v);
			return `$${args.length}`;
		};
		if (patch.name !== undefined) sets.push(`name = ${arg(patch.name)}`);
		if (patch.labels !== undefined) {
			sets.push(`labels = ${arg(JSON.stringify(patch.labels))}::jsonb`);
		}
		if (patch.idleTimeoutSeconds !== undefined) {
			sets.push(`idle_timeout_seconds = ${arg(patch.idleTimeoutSeconds)}`);
		}
		if (patch.ttlSeconds !== undefined) {
			const ttl = arg(patch.ttlSeconds);
			sets.push(`ttl_seconds = ${ttl}::int`);
			// A ready sandbox gets the new deadline now; otherwise the worker sets
			// it when the sandbox becomes ready (create, resume).
			sets.push(
				`deadline_at = CASE WHEN ${ttl}::int IS NOT NULL AND state = 'ready'
				   THEN now() + make_interval(secs => ${ttl}::int) ELSE NULL END`,
			);
		}
		sets.push("version = version + 1");
		const r = await tx.client.query<SandboxRow>(
			`UPDATE runtime.sandboxes SET ${sets.join(", ")}
			 WHERE id = $1 AND version = $2 RETURNING *`,
			args,
		);
		const updated = r.rows[0];
		// The row is locked, so the version cannot have moved.
		if (!updated) throw new Error("update: sandbox version changed under lock");
		return toSandbox(tx.client, updated);
	});
}

/**
 * `deadline_at = now + ttl` of a ready sandbox (S6 §7.8, S7 §20.2 p. 12).
 * `ttlSeconds` extends this deadline only; the sandbox's TTL stays.
 */
export async function extendSandbox(
	deps: SandboxServiceDeps,
	p: Principal,
	idOrSlug: string,
	ttlSeconds?: number,
): Promise<Sandbox> {
	const { maxTtlSeconds } = await deps.config.defaults();
	if (ttlSeconds !== undefined) {
		const issues: ValidationIssue[] = [];
		checkSeconds("ttlSeconds", ttlSeconds, issues, {
			nullable: false,
			max: maxTtlSeconds,
		});
		if (issues.length > 0) throw validation(issues);
	}
	return withTx(deps.pool, async (tx) => {
		const row = await findSandboxRow(tx.client, p, idOrSlug, {
			lock: true,
			write: true,
		});
		if (row.state !== "ready") throw invalidState(row.state);
		const ttl: number | null = ttlSeconds ?? row.ttl_seconds;
		if (ttl === null) {
			throw validation([
				{
					path: "ttlSeconds",
					message: "the sandbox has no TTL; pass ttlSeconds",
				},
			]);
		}
		const r = await tx.client.query<SandboxRow>(
			`UPDATE runtime.sandboxes
			 SET deadline_at = now() + make_interval(secs => $3::int), version = version + 1
			 WHERE id = $1 AND version = $2 RETURNING *`,
			[row.id, row.version, ttl],
		);
		const updated = r.rows[0];
		if (!updated) throw new Error("extend: sandbox version changed under lock");
		return toSandbox(tx.client, updated);
	});
}

/**
 * Resolves with the sandbox once its state is one of `states`, or with its
 * current row when `timeoutMs` passes (long-poll). Woken by
 * `NOTIFY sbx_sandboxes '<id>'`, re-read when the listener becomes active
 * (closes the gap to the first read) and by a fallback poll.
 */
export function waitForSandboxState(
	deps: SandboxServiceDeps,
	id: string,
	states: SandboxState[],
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<Sandbox> {
	return waitForRow(deps, {
		id,
		channel: "sbx_sandboxes",
		what: "sandbox",
		load: (q, rowId) => loadSandbox(q, rowId),
		done: (s) => states.includes(s.state),
		timeoutMs,
		...(signal === undefined ? {} : { signal }),
	});
}

/**
 * Resolves with the operation once it is terminal (`succeeded`, `failed`,
 * `superseded`), or with its current row when `timeoutMs` passes. Woken by
 * `NOTIFY sbx_operations '<id>'` (trigger of 0201) like `waitForSandboxState`.
 * No access check: the caller has read the operation with `getOperation`.
 */
export function waitForOperation(
	deps: SandboxServiceDeps,
	id: string,
	timeoutMs: number,
): Promise<Operation> {
	return waitForRow(deps, {
		id,
		channel: "sbx_operations",
		what: "operation",
		load: (q, rowId) => loadOperation(q, rowId),
		done: (op) => TERMINAL_OPERATION_STATES.includes(op.state),
		timeoutMs,
	});
}

interface WaitSpec<T> {
	id: string;
	/** NOTIFY channel whose payload is the row id. */
	channel: string;
	/** For `not_found`. */
	what: string;
	load: (q: Queryable, id: string) => Promise<T | null>;
	done: (row: T) => boolean;
	timeoutMs: number;
	/** Abort: reject with its reason and stop listening and polling. */
	signal?: AbortSignal;
}

function waitForRow<T>(deps: SandboxServiceDeps, w: WaitSpec<T>): Promise<T> {
	const notifier = deps.notifier;
	const pollMs = deps.waitPollMs ?? (notifier ? 2000 : 500);
	const deadline = Date.now() + Math.max(0, w.timeoutMs);
	const { id } = w;

	return new Promise<T>((resolve, reject) => {
		let done = false;
		let reading = false;
		let again = false;
		let unsubscribe: (() => void) | null = null;
		const timers: NodeJS.Timeout[] = [];

		const signal = w.signal;
		const onAbort = () => finish(signal?.reason);
		const finish = (err: unknown, row?: T) => {
			if (done) return;
			done = true;
			for (const t of timers) clearTimeout(t); // also clears the interval
			unsubscribe?.();
			signal?.removeEventListener("abort", onAbort);
			if (row !== undefined) resolve(row);
			else reject(err);
		};
		if (signal?.aborted) {
			finish(signal.reason);
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });

		const check = async (): Promise<void> => {
			if (done) return;
			if (reading) {
				again = true;
				return;
			}
			reading = true;
			try {
				do {
					again = false;
					const row = await w.load(deps.pool, id);
					if (row === null) return finish(notFound(w.what));
					if (w.done(row) || Date.now() >= deadline) {
						return finish(null, row);
					}
				} while (again && !done);
			} catch (err) {
				finish(err);
			} finally {
				reading = false;
			}
		};

		if (!isUuid(id)) {
			finish(notFound(w.what));
			return;
		}
		if (notifier) {
			unsubscribe = notifier.subscribe(w.channel, (payload) => {
				if (payload === null || payload === id) void check();
			});
		}
		const poll = setInterval(() => void check(), pollMs);
		timers.push(poll);
		timers.push(
			setTimeout(() => void check(), Math.max(0, deadline - Date.now())),
		);
		void check();
	});
}
