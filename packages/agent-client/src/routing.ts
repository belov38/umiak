// The routing loop shared by the Connect transport and fetch: resolve the
// owning gateway instance, run one attempt, and act on its outcome.
import { AgentUnavailableError } from "./errors.js";
import { type Registry, type Route, sameRoute } from "./registry.js";

/** Result of one attempt against a gateway instance. Fatal errors are thrown. */
export type AttemptOutcome<T> =
	| { kind: "done"; value: T }
	/** 421: retry at instanceUrl if given, else after a fresh lookup. */
	| { kind: "moved"; instanceUrl?: string | undefined; cause?: unknown }
	/** 503 agent_unavailable or a connection error: look up again, wait if needed. */
	| { kind: "unavailable"; cause?: unknown };

export interface RoutingOptions {
	registry: Registry;
	machineId: string;
	/** Budget for waiting on a machine without a usable route, from the first miss. */
	waitForAgentMs: number;
	/** Upper bound of one registry wait (a poll in case a NOTIFY is missed). */
	pollIntervalMs: number;
	/** Maximum attempts against gateway instances. */
	maxAttempts: number;
	/** Caller's signal: on abort, abortError(reason) is thrown, never retried. */
	signal?: AbortSignal | undefined;
	abortError: (reason: unknown) => unknown;
	/** Absolute deadline (Date.now() ms) of the whole call; deadlineError() on expiry. */
	deadline?: number | undefined;
	deadlineError?: () => unknown;
}

/**
 * Runs attempt(instanceUrl) until it is done, a fatal error is thrown, the
 * caller aborts, the deadline passes, or the wait budget or attempt cap is
 * exhausted (AgentUnavailableError).
 *
 * - moved: invalidate; the next attempt goes to the URL from Sbx-Instance-Url.
 * - unavailable: invalidate and look up again. Without a route, or with the
 *   same route that just failed, wait for a registry change (at most
 *   pollIntervalMs at a time) until waitForAgentMs from the first miss.
 */
export async function routeCall<T>(
	opts: RoutingOptions,
	attempt: (instanceUrl: string) => Promise<AttemptOutcome<T>>,
): Promise<T> {
	const { registry, machineId } = opts;
	let attempts = 0;
	let missSince: number | undefined;
	let pinned: string | undefined;
	// The route whose attempt failed last; looking it up again means the
	// registry has not caught up yet, so wait once before trying it again.
	let failed: Route | undefined;
	let lastCause: unknown;

	for (;;) {
		checkStop(opts);
		let url: string;
		let current: Route | undefined;
		if (pinned !== undefined) {
			url = pinned;
			pinned = undefined;
		} else {
			current = await registry.lookup(machineId);
			checkStop(opts);
			const stale =
				current !== undefined &&
				failed !== undefined &&
				sameRoute(current, failed);
			if (current === undefined || stale) {
				failed = undefined;
				const now = Date.now();
				missSince ??= now;
				const left = opts.waitForAgentMs - (now - missSince);
				if (left <= 0) {
					throw new AgentUnavailableError(machineId, lastCause);
				}
				await registry.waitForChange(
					machineId,
					boundedWait(opts, Math.min(opts.pollIntervalMs, left)),
					opts.signal,
				);
				// A stale route is tried again after this wait (failed is cleared).
				continue;
			}
			url = current.internalUrl;
		}
		if (attempts >= opts.maxAttempts) {
			throw new AgentUnavailableError(machineId, lastCause);
		}
		attempts++;
		const outcome = await attempt(url);
		if (outcome.kind === "done") {
			return outcome.value;
		}
		lastCause = outcome.cause;
		registry.invalidate(machineId);
		if (outcome.kind === "moved" && outcome.instanceUrl) {
			pinned = outcome.instanceUrl;
			failed = undefined;
		} else {
			failed = current;
		}
	}
}

/**
 * Waits until the registry has a route for the machine, up to waitForAgentMs
 * (AgentUnavailableError after that).
 */
export async function waitForRoute(opts: RoutingOptions): Promise<Route> {
	const start = Date.now();
	for (;;) {
		checkStop(opts);
		const route = await opts.registry.lookup(opts.machineId);
		if (route !== undefined) {
			return route;
		}
		checkStop(opts);
		const left = opts.waitForAgentMs - (Date.now() - start);
		if (left <= 0) {
			throw new AgentUnavailableError(opts.machineId);
		}
		await opts.registry.waitForChange(
			opts.machineId,
			boundedWait(opts, Math.min(opts.pollIntervalMs, left)),
			opts.signal,
		);
	}
}

function checkStop(opts: RoutingOptions): void {
	if (opts.signal?.aborted) {
		throw opts.abortError(opts.signal.reason);
	}
	if (opts.deadline !== undefined && Date.now() >= opts.deadline) {
		throw opts.deadlineError?.() ?? new Error("deadline exceeded");
	}
}

function boundedWait(opts: RoutingOptions, ms: number): number {
	if (opts.deadline === undefined) {
		return ms;
	}
	return Math.max(0, Math.min(ms, opts.deadline - Date.now()));
}
