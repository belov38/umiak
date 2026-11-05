// `--wait` of create, fork, resume, recover and stop (S7 §14.3): long-polls
// the sandbox (`?waitFor=<every other state>`), so each change of state comes
// back at once and is reported, until the awaited state. A state the
// awaited one cannot follow ends the wait with `sandbox_failed` (exit 1);
// the overall limit with `wait_timeout` (exit 75).

import {
	DEFAULT_RETRY_BUDGET_MS,
	type OperationData,
	type SandboxData,
	SandboxFailedError,
	UmiakError,
	WAIT_TIMEOUT,
} from "@umiak/sdk";
import type { Context } from "./context.ts";

/** Default limit of a wait (S7 §15.4). */
export const WAIT_TIMEOUT_MS = 300_000;

const STATES: readonly SandboxData["state"][] = [
	"creating",
	"ready",
	"stopping",
	"stopped",
	"starting",
	"error",
	"deleting",
	"deleted",
];
const FAILED: Record<"ready" | "stopped", ReadonlySet<string>> = {
	ready: new Set(["error", "deleting", "deleted", "stopped"]),
	stopped: new Set(["error", "deleting", "deleted"]),
};
/** Seconds of one long-poll (the api allows up to 60). */
const POLL_SECONDS = 30;
/** A poll that has not answered this long after its waitSeconds is repeated. */
const POLL_MARGIN_MS = 15_000;

export interface WaitStateOptions {
	timeoutMs?: number;
	/** Ends the wait at once with its reason. */
	signal?: AbortSignal;
	/** Called with the sandbox at every change of state. */
	onState(sb: SandboxData): void;
}

export async function waitForState(
	ctx: Context,
	start: SandboxData,
	target: "ready" | "stopped",
	o: WaitStateOptions,
): Promise<SandboxData> {
	const deadline = Date.now() + (o.timeoutMs ?? WAIT_TIMEOUT_MS);
	let sb = start;
	for (;;) {
		if (sb.state === target) return sb;
		if (FAILED[target].has(sb.state)) {
			throw new SandboxFailedError({
				status: sb.error?.code === "out_of_capacity" ? 503 : 409,
				code:
					sb.error?.code === "out_of_capacity"
						? "out_of_capacity"
						: "sandbox_failed",
				message: `sandbox ${sb.slug} is ${sb.state}, not ${target}${sb.error ? `: ${sb.error.message}` : ""}`,
				retryable: sb.error?.code === "out_of_capacity",
				details: { state: sb.state, sandboxId: sb.id, error: sb.error },
			});
		}
		const left = deadline - Date.now();
		if (left <= 0) {
			throw new UmiakError({
				status: 0,
				code: WAIT_TIMEOUT,
				message: `sandbox ${sb.slug} is still ${sb.state} (not ${target})`,
				retryable: true,
			});
		}
		o.signal?.throwIfAborted();
		const next = await poll(ctx, sb, left, o.signal);
		if (next !== undefined && next.state !== sb.state) o.onState(next);
		if (next !== undefined) sb = next;
	}
}

async function poll(
	ctx: Context,
	sb: SandboxData,
	leftMs: number,
	signal: AbortSignal | undefined,
): Promise<SandboxData | undefined> {
	const waitSeconds = Math.max(
		1,
		Math.min(POLL_SECONDS, Math.ceil(leftMs / 1000)),
	);
	const timeout = AbortSignal.timeout(waitSeconds * 1000 + POLL_MARGIN_MS);
	try {
		const { data } = await ctx.umiak().raw.GET("/v1/sandboxes/{sandbox}", {
			params: {
				path: { sandbox: sb.id },
				query: {
					waitFor:
						sb.state === "queued" || sb.state === "moving"
							? "ready,stopped"
							: STATES.filter((s) => s !== sb.state).join(","),
					waitSeconds,
				},
			},
			signal:
				signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
			// A wait outlives short API outages; its own deadline bounds it.
			retryBudgetMs: Math.min(DEFAULT_RETRY_BUDGET_MS, leftMs),
		});
		return data;
	} catch (err) {
		if (signal?.aborted) throw signal.reason;
		if (timeout.aborted) return undefined;
		throw err;
	}
}

const VERBS: Record<string, string> = {
	create: "Creating",
	fork: "Forking",
	stop: "Stopping",
	resume: "Resuming",
	recover: "Recovering",
};

/**
 * Prints the JSON Lines of a waiting command: `accepted` (the action's
 * answer), `state` at every change, last `ready` or `stopped`.
 */
export async function reportWait(
	ctx: Context,
	accepted: { sandbox: SandboxData; operation: { kind: string } | null },
	target: "ready" | "stopped",
	timeoutMs: number | undefined,
): Promise<SandboxData> {
	ctx.out.event("accepted", accepted, (v) => {
		const verb = VERBS[v.operation?.kind ?? ""] ?? "Accepted:";
		return `${verb} ${v.sandbox.slug} (${v.sandbox.id})`;
	});
	const sb = await waitForState(ctx, accepted.sandbox, target, {
		...(timeoutMs === undefined ? {} : { timeoutMs }),
		onState: (s) =>
			ctx.out.event(
				"state",
				{ state: s.state, sandbox: s },
				(v) => `${v.sandbox.slug}: ${v.state}`,
			),
	});
	ctx.out.event(
		target,
		{ sandbox: sb },
		(v) => `${v.sandbox.slug} (${v.sandbox.id}) is ${target}`,
	);
	return sb;
}

/**
 * Warns when a fork or save with --force-stop could not start its source
 * again (S9 §24.8): the snapshot is good, the source is in `error` until it
 * is resumed.
 */
export function warnForceStop(ctx: Context, op: OperationData): void {
	const f = op.forceStop;
	if (f === null || f.sourceRestarted !== false) return;
	const why =
		f.restartError === null
			? ""
			: `: ${f.restartError.message} (${f.restartError.code})`;
	ctx.out.warn(
		`the source sandbox was stopped for the snapshot but failed to start again${why}; resume it: umiak resume ${op.sandboxId}`,
	);
}
