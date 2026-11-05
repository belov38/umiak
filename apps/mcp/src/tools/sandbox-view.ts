// The sandbox as the model sees it (S11 8.2 "Response shape") and the wait for
// a sandbox state by long-poll (S7 5.10, S11 7.5).
import type { CallToolResult } from "@modelcontextprotocol/server";
import { type OperationData, type SandboxData, UmiakError } from "@umiak/sdk";
import type { ToolContext } from "../context.ts";
import { toolText } from "../output/result.ts";
import { errorView } from "./view.ts";

export type WaitTarget = "ready" | "stopped";

/** Where the long-poll route of one sandbox lives. */
export const SANDBOX_PATH = "/v1/sandboxes/{sandbox}";

/** A wait is cut into polls of this length: after each one the client gets a progress note. */
const POLL_SECONDS = 5;

export interface OperationView {
	id: string;
	kind: string;
	state: string;
	progress?: OperationData["progress"];
}

export function operationView(op: OperationData): OperationView {
	return {
		id: op.id,
		kind: op.kind,
		state: op.state,
		...(op.progress ? { progress: op.progress } : {}),
	};
}

/**
 * The fields of spec 8.2 only: `createdBy`, `templateVersion`, `memoryMb` and
 * the rest cost tokens and tell the model nothing it can act on. Empty fields
 * are dropped later by `toolText`.
 */
export function sandboxView(s: SandboxData): Record<string, unknown> {
	// `desktop` is S10: absent from the generated type until that lands.
	const endpoints = s.endpoints as SandboxData["endpoints"] & {
		desktop?: string;
	};
	return {
		id: s.id,
		slug: s.slug,
		name: s.name,
		state: s.state,
		health: s.health,
		activity: s.activity,
		template: s.template,
		size: s.size,
		labels: s.labels,
		deadline_at: s.deadlineAt,
		idle_timeout_seconds: s.idleTimeoutSeconds,
		active_operation:
			s.activeOperation === null ? null : operationView(s.activeOperation),
		error: errorView(s.error),
		endpoints: {
			port_url_template: endpoints.portUrlTemplate,
			ssh: endpoints.ssh,
			desktop: endpoints.desktop,
		},
		created_at: s.createdAt,
	};
}

/** States in which nothing more will happen on its own. */
const FINAL_STATES = new Set(["error", "deleting", "deleted"]);

/** A wait for `target` ends when it is reached, or the sandbox failed or is going away. */
function waitIsOver(state: string, target: WaitTarget): boolean {
	// Waiting for ready also ends in stopped: nothing is starting.
	return (
		state === target ||
		FINAL_STATES.has(state) ||
		(target === "ready" && state === "stopped")
	);
}

/**
 * Long-polls `GET /v1/sandboxes/{id}?waitFor=<target>` until the target, a
 * final or error state, or `waitMs`. Returns the latest data and never
 * throws because time is up. `latest` is what the caller already knows (the
 * answer of the action): it is returned when the deadline cuts the very
 * first poll.
 */
export async function waitSandbox(
	ctx: ToolContext,
	id: string,
	target: WaitTarget,
	waitMs: number,
	latest?: SandboxData,
): Promise<SandboxData> {
	const started = Date.now();
	const end = started + waitMs;
	let data = latest;
	for (;;) {
		const slice = Math.max(
			0,
			Math.min(POLL_SECONDS, Math.floor((end - Date.now()) / 1000)),
		);
		try {
			const r = await ctx.umiak().raw.GET(SANDBOX_PATH, {
				params: {
					path: { sandbox: id },
					query: {
						waitFor: target === "ready" ? "ready,stopped" : target,
						waitSeconds: slice,
					},
				},
				...ctx.call,
			});
			data = r.data;
		} catch (err) {
			if (data !== undefined && ctx.deadline.expired()) return data;
			throw err;
		}
		if (slice === 0 || waitIsOver(data.state, target)) return data;
		await ctx.progress(
			Math.round((Date.now() - started) / 100) / 10,
			undefined,
			`sandbox ${data.slug} is ${data.state}`,
		);
	}
}

/** A plain read of one sandbox. */
export async function getSandbox(
	ctx: ToolContext,
	id: string,
): Promise<SandboxData> {
	const { data } = await ctx.umiak().raw.GET(SANDBOX_PATH, {
		params: { path: { sandbox: id } },
		...ctx.call,
	});
	return data;
}

/**
 * The id of the sandbox a reference points to. An id is taken as it is; a
 * slug costs one read. When the read is not allowed or finds nothing, the
 * typed value stands (the action itself then answers 403 or 404).
 */
export async function resolveSandboxId(
	ctx: ToolContext,
	ref: string,
): Promise<string> {
	if (ref.toLowerCase().startsWith("sb_")) return ref;
	try {
		return (await getSandbox(ctx, ref)).id;
	} catch (err) {
		if (
			err instanceof UmiakError &&
			(err.status === 403 || err.status === 404)
		) {
			return ref;
		}
		throw err;
	}
}

/** What to tell the model when the sandbox is not in the state it waited for; undefined when it is. */
export function waitHint(
	state: string,
	target: WaitTarget,
	pinned = false,
): string | undefined {
	if (state === target) return undefined;
	if (state === "error") {
		return pinned
			? "the sandbox is in state error (see error): sandbox_recover reboots it."
			: "the sandbox is in state error (see error): sandbox_recover reboots it, sandbox_delete removes it.";
	}
	if (state === "deleting" || state === "deleted") {
		return `the sandbox is ${state}; it cannot be used any more.`;
	}
	if (target === "ready" && state === "stopped") {
		return "the sandbox is stopped, not ready: call sandbox_resume to start it.";
	}
	return `state not final yet: call sandbox_get with wait_for=${target} and wait_seconds=50`;
}

export const REPLAYED_LINE =
	"result of an earlier call with the same idempotency_key";

export interface ResultOptions {
	/** The operation the action started. */
	operation?: OperationData | null;
	/** Fork: the `fork` operation on the source sandbox. */
	sourceOperation?: OperationData;
	/** The state the tool waited for (or would have): drives the hint and `isError`. */
	target?: WaitTarget;
	replayed?: boolean;
	/** The model-facing key, shown when the tool creates things. */
	idempotencyKey?: string;
	/** Extra lines under the header. */
	notes?: string[];
	/** Pinned mode: the hint names no hidden tool. */
	pinned?: boolean;
}

/**
 * The operation as of now: an operation the action started is still `running`
 * in the answer of the action, but when the sandbox reached the state the
 * operation leads to (or failed), the operation is over. Reading the
 * operation instead would need a scope the action does not.
 */
function operationNow(
	op: OperationData,
	s: SandboxData,
	target: WaitTarget | undefined,
): OperationView {
	const view = operationView(op);
	if (op.state !== "pending" && op.state !== "running" && op.state !== "queued")
		return view;
	if (target !== undefined && s.state === target) view.state = "succeeded";
	else if (
		s.state === "error" ||
		(s.state === "stopped" && s.error?.code === "out_of_capacity")
	)
		view.state = "failed";
	return view;
}

/** The answer of a tool about a sandbox: JSON header, notes, `isError` when the sandbox failed. */
export function sandboxResult(
	s: SandboxData,
	o: ResultOptions = {},
): CallToolResult {
	const header: Record<string, unknown> = sandboxView(s);
	if (o.operation) header.operation = operationNow(o.operation, s, o.target);
	if (o.sourceOperation) {
		header.source_operation = operationNow(o.sourceOperation, s, o.target);
	}
	const lines: string[] = [];
	if (o.target !== undefined) {
		const hint = waitHint(s.state, o.target, o.pinned === true);
		if (hint !== undefined) lines.push(hint);
		if (hint?.startsWith("state not final yet")) {
			const id = o.operation?.id ?? s.activeOperation?.id;
			if (id !== undefined) header.operation_id = id;
		}
	}
	if (o.replayed === true) {
		header.replayed = true;
		lines.push(REPLAYED_LINE);
	}
	if (o.idempotencyKey !== undefined) {
		header.idempotency_key = o.idempotencyKey;
	}
	lines.push(...(o.notes ?? []));
	const result = toolText(header, lines.length > 0 ? [lines.join("\n")] : []);
	// A failed wait is an error of the call; reading a failed sandbox is not.
	return (s.state === "error" ||
		(s.state === "stopped" &&
			s.error?.code === "out_of_capacity" &&
			o.target === "ready")) &&
		o.target !== undefined
		? { ...result, isError: true }
		: result;
}
