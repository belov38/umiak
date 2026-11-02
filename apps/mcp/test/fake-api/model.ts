// Shared helpers of the route modules: resources as the API renders them,
// sandbox lookup with team scoping, operations, idempotency and paging.
import { createHash } from "node:crypto";
import type { Context } from "hono";
import { FakeApiError, forbidden, notFound, validation } from "./errors.ts";
import {
	type Fake,
	type FakeEnv,
	type FakeOperation,
	type FakePrincipal,
	type FakeSandbox,
	type FakeTemplate,
	type OperationKind,
	UMIAK_DOMAIN,
} from "./state.ts";

/** 403 `forbidden` with `details.requiredScope` unless the principal has it. */
export function checkScope(p: FakePrincipal, scope: string): void {
	if (!p.scopes.includes(scope)) {
		throw forbidden(
			`the API key lacks the scope ${scope}; a team owner can issue a key with it`,
			{ requiredScope: scope },
		);
	}
}

/** The `:sandbox` path parameter (for handlers that take a plain Context). */
export function sandboxParam(c: Context<FakeEnv>): string {
	return c.req.param("sandbox") as string;
}

export const iso = (d: Date): string => d.toISOString();
export const isoOrNull = (d: Date | null): string | null =>
	d === null ? null : d.toISOString();

export function operationResource(op: FakeOperation) {
	return {
		id: op.id,
		sandboxId: op.sandboxId,
		kind: op.kind,
		state: op.state,
		step: op.step,
		error: op.error,
		forceStop: op.forceStop,
		createdAt: iso(op.createdAt),
		startedAt: isoOrNull(op.startedAt),
		finishedAt: isoOrNull(op.finishedAt),
	};
}

export function isActive(op: FakeOperation | undefined): op is FakeOperation {
	return op !== undefined && (op.state === "pending" || op.state === "running");
}

export function activeOperation(
	fake: Fake,
	sb: FakeSandbox,
): FakeOperation | undefined {
	const op =
		sb.activeOperationId === null
			? undefined
			: fake.state.operations.get(sb.activeOperationId);
	return isActive(op) ? op : undefined;
}

export function templateOf(fake: Fake, slug: string): FakeTemplate | undefined {
	return fake.state.templates.find((t) => t.slug === slug);
}

export function hasCapability(
	fake: Fake,
	sb: FakeSandbox,
	capability: string,
): boolean {
	return (
		templateOf(fake, sb.template)?.capabilities.includes(capability) ?? false
	);
}

export function sandboxResource(fake: Fake, sb: FakeSandbox) {
	const active = activeOperation(fake, sb);
	const endpoints: Record<string, string> = {
		portUrlTemplate: `https://${sb.slug}-{port}.${UMIAK_DOMAIN}`,
		ssh: `ssh ${sb.slug}@ssh.example.com`,
	};
	if (hasCapability(fake, sb, "desktop")) {
		endpoints.desktop = `https://${sb.slug}-desktop.${UMIAK_DOMAIN}/`;
	}
	return {
		id: sb.id,
		slug: sb.slug,
		name: sb.name,
		teamId: sb.teamId,
		createdBy: sb.createdBy,
		createdByKey: sb.createdByKey,
		template: sb.template,
		templateVersion: templateOf(fake, sb.template)?.version ?? null,
		size: sb.size,
		vcpu: sb.vcpu,
		memoryMb: sb.memoryMb,
		state: sb.state,
		health: sb.health,
		healthReason: null,
		degradedSince: null,
		activity: sb.activity,
		lastActivityAt: null,
		stopReason: sb.stopReason,
		error: sb.error,
		origin: sb.origin,
		labels: sb.labels,
		ttlSeconds: sb.ttlSeconds,
		deadlineAt: isoOrNull(sb.deadlineAt),
		idleTimeoutSeconds: sb.idleTimeoutSeconds,
		activeOperation: active ? operationResource(active) : null,
		endpoints,
		environment: null,
		excludeOwnerSecrets: false,
		// Operator blocks (S8 C3) are not modelled.
		blocked: false,
		blockReason: null,
		createdAt: iso(sb.createdAt),
		readyAt: isoOrNull(sb.readyAt),
		stoppedAt: isoOrNull(sb.stoppedAt),
		deletedAt: isoOrNull(sb.deletedAt),
		updatedAt: iso(sb.updatedAt),
	};
}

/**
 * The sandbox of a path reference (`sb_...` id or slug) in the caller's team;
 * another team's sandbox is a plain 404, like a missing one. A deleted
 * sandbox is only found by id and only with `allowDeleted`.
 */
export function lookupSandbox(
	fake: Fake,
	p: FakePrincipal,
	ref: string,
	o: { allowDeleted?: boolean } = {},
): FakeSandbox {
	let found: FakeSandbox | undefined;
	if (ref.toLowerCase().startsWith("sb_")) {
		found = fake.state.sandboxes.get(ref);
	} else {
		for (const sb of fake.state.sandboxes.values()) {
			if (sb.slug === ref && sb.state !== "deleted") found = sb;
		}
	}
	if (!found || found.teamId !== p.teamId) throw notFound("sandbox");
	if (found.state === "deleted" && o.allowDeleted !== true)
		throw notFound("sandbox");
	return found;
}

/** Creates a running operation on a sandbox and makes it the active one. */
export function startOperation(
	fake: Fake,
	sb: FakeSandbox,
	kind: OperationKind,
	step: string | null = null,
): FakeOperation {
	const now = new Date();
	const op: FakeOperation = {
		id: fake.newId("op"),
		sandboxId: sb.id,
		kind,
		state: "running",
		step,
		error: null,
		forceStop: null,
		createdAt: now,
		startedAt: now,
		finishedAt: null,
	};
	fake.state.operations.set(op.id, op);
	sb.activeOperationId = op.id;
	return op;
}

/**
 * Fork and saved snapshot of a running Windows sandbox (S9 §24.8): 409
 * `snapshot_requires_stop` without `forceStop`; true when the source is
 * stopped for the snapshot and started again. Linux and a stopped source
 * ignore the flag.
 */
export function forceStopFor(
	fake: Fake,
	sb: FakeSandbox,
	kind: "fork" | "save_snapshot",
	forceStop: unknown,
): boolean {
	if (sb.state !== "ready" || templateOf(fake, sb.template)?.os !== "windows") {
		return false;
	}
	if (forceStop === true) return true;
	const what =
		kind === "fork"
			? "Windows sandboxes are forked from a stopped VM"
			: "Windows snapshots are saved from a stopped VM";
	throw new FakeApiError(
		409,
		"snapshot_requires_stop",
		`${what}; stop it first or retry with forceStop: true (CLI --force-stop), which stops the sandbox, takes the snapshot and starts it again`,
		{
			details: {
				reason: "windows_running",
				retryWith: { forceStop: true },
				cli: "--force-stop",
			},
		},
	);
}

/**
 * A forced operation: the source was stopped and started again, or its
 * restart failed (`state.forceStopRestartError`; the source is then `error`).
 */
export function markForceStopped(
	fake: Fake,
	op: FakeOperation,
	src: FakeSandbox,
): void {
	const restartError = fake.state.forceStopRestartError;
	op.forceStop = {
		sourceStopped: true,
		sourceRestarted: restartError === null,
		restartError,
	};
	if (restartError !== null) {
		src.state = "error";
		src.error = {
			code: "resume_failed",
			message: `the restart after the forced snapshot failed: ${restartError.message}`,
		};
		src.updatedAt = new Date();
	}
}

export function finishOperation(
	fake: Fake,
	op: FakeOperation,
	state: "succeeded" | "failed" | "superseded",
	error: FakeOperation["error"] = null,
): void {
	if (!isActive(op)) return;
	op.state = state;
	op.error = error;
	op.finishedAt = new Date();
	const sb = fake.state.sandboxes.get(op.sandboxId);
	if (sb && sb.activeOperationId === op.id) sb.activeOperationId = null;
	fake.notify();
}

/** Waits for the sandbox of a command or file call; throws the 409s of S7 §9.1. */
export async function requireReady(
	fake: Fake,
	sb: FakeSandbox,
	signal?: AbortSignal,
): Promise<void> {
	const settling = () => sb.state === "creating" || sb.state === "starting";
	if (settling()) {
		await fake.waitUntil(() => !settling(), fake.opts.startWaitMs, signal);
		if (settling()) {
			throw new FakeApiError(
				409,
				"sandbox_starting",
				`sandbox ${sb.slug} is still ${sb.state}; retry shortly`,
				{ retryable: true, details: { state: sb.state } },
			);
		}
	}
	if (sb.state !== "ready") {
		throw new FakeApiError(
			409,
			"sandbox_not_ready",
			`sandbox ${sb.slug} is ${sb.state}, not ready; resume or recover it first`,
			{ details: { state: sb.state } },
		);
	}
}

/**
 * A long-poll: resolves when `pred` holds, after `seconds`, or on abort. With
 * `script.silent` it never answers on its own.
 */
export async function longPoll(
	fake: Fake,
	pred: () => boolean,
	seconds: number,
	signal: AbortSignal,
): Promise<void> {
	if (fake.script.silent) {
		await fake.waitUntil(() => false, 2 ** 31 - 1, signal);
		return;
	}
	await fake.waitUntil(pred, seconds * 1000, signal);
}

// --- idempotency (S7 §5.7) ---

function stable(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(stable);
	if (v !== null && typeof v === "object") {
		return Object.fromEntries(
			Object.entries(v as Record<string, unknown>)
				.sort(([a], [b]) => (a < b ? -1 : 1))
				.map(([k, x]) => [k, stable(x)]),
		);
	}
	return v;
}

export function principalId(p: FakePrincipal, token: string): string {
	return p.keyId ?? p.userEmail ?? token;
}

export interface IdempotencyClaim {
	/** What the first request with this key and body created; null on a first request. */
	replay: Record<string, string> | null;
	save(result: Record<string, string>): void;
}

/**
 * The claim of an `Idempotency-Key` header: null without one; a repeat with
 * another body is 409 `idempotency_key_reused`.
 */
export function claimIdempotency(
	fake: Fake,
	c: Context<FakeEnv>,
	scope: string,
	hashInput: unknown,
): IdempotencyClaim | null {
	const key = c.req.header("Idempotency-Key");
	if (key === undefined) return null;
	if (!/^[\x20-\x7e]{1,255}$/.test(key)) {
		throw validation([
			{
				path: "header.Idempotency-Key",
				message: "must be 1-255 printable ASCII characters",
			},
		]);
	}
	const id = `${principalId(c.get("principal"), c.get("token"))}:${scope}:${key}`;
	const hash = createHash("sha256")
		.update(JSON.stringify(stable(hashInput)))
		.digest("hex");
	const rec = fake.state.idempotency.get(id);
	if (rec && rec.hash !== hash) {
		throw new FakeApiError(
			409,
			"idempotency_key_reused",
			"this Idempotency-Key was used with a different request; use a new key",
		);
	}
	return {
		replay: rec ? rec.result : null,
		save: (result) => {
			fake.state.idempotency.set(id, { hash, result });
		},
	};
}

// --- paging (S7 §5.6) ---

export function encodeCursor(after: string | number): string {
	return Buffer.from(JSON.stringify({ c: after })).toString("base64url");
}

export function decodeCursor(cursor: string): string | number {
	try {
		const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
			c?: unknown;
		};
		if (typeof v.c === "string" || typeof v.c === "number") return v.c;
	} catch {
		// falls through
	}
	throw new FakeApiError(
		400,
		"invalid_cursor",
		"the cursor is not valid; use a nextCursor unchanged",
	);
}

/** One page of an ordered list; `key` is what the order is by. */
export function paginate<T>(
	items: T[],
	o: {
		limit: number;
		cursor: string | undefined;
		key: (t: T) => string | number;
		dir: "asc" | "desc";
	},
): { data: T[]; nextCursor: string | null } {
	let rest = items;
	if (o.cursor !== undefined) {
		const after = decodeCursor(o.cursor);
		rest = items.filter((t) =>
			o.dir === "asc" ? o.key(t) > after : o.key(t) < after,
		);
	}
	const data = rest.slice(0, o.limit);
	const last = data[data.length - 1];
	return {
		data,
		nextCursor:
			rest.length > o.limit && last !== undefined
				? encodeCursor(o.key(last))
				: null,
	};
}

/** `limit` of a validated query (the schema already bounds it). */
export function limitOf(c: Context<FakeEnv>, dflt: number): number {
	const v = c.req.query("limit");
	return v === undefined ? dflt : Number(v);
}
