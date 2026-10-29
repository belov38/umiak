// The routing loop shared by the Connect transport and fetch: resolve the
// owning gateway instance, run one attempt, and act on its outcome.
import { AgentUnavailableError } from "./errors.js";
import {
	type Registry,
	RegistryClosedError,
	type Route,
	sameRoute,
} from "./registry.js";

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
	/**
	 * Maximum immediate attempts against gateway instances (after a 421 or a
	 * connection error without a registry wait). Attempts made after a wait
	 * do not count: waitForAgentMs bounds those.
	 */
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
 *   A 421 that names the instance that answered it (a restarted pod on the
 *   same IP) counts as unavailable.
 * - unavailable: invalidate and look up again. Without a route, with the
 *   same route that just failed, or after such a self-421, wait for a
 *   registry change (at most pollIntervalMs at a time) until waitForAgentMs
 *   from the first miss.
 * - a failed registry lookup is a miss: wait pollIntervalMs and look up again
 *   within the same budget. A TypeError (an invalid machine id) is thrown.
 *
 * maxAttempts caps only immediate attempts; an attempt after a registry wait
 * is bounded by waitForAgentMs instead.
 */
export async function routeCall<T>(
	opts: RoutingOptions,
	attempt: (instanceUrl: string) => Promise<AttemptOutcome<T>>,
): Promise<T> {
	const { registry, machineId } = opts;
	let immediate = 0;
	let waited = false;
	const budget = new MissBudget(opts);
	let pinned: string | undefined;
	// The route whose attempt failed last; looking it up again means the
	// registry has not caught up yet, so wait once before trying it again.
	let failed: Route | undefined;
	// Wait before the next lookup-based attempt whatever the route.
	let mustWait = false;
	let lastCause: unknown;

	for (;;) {
		checkStop(opts);
		let url: string;
		let current: Route | undefined;
		if (pinned !== undefined) {
			url = pinned;
			pinned = undefined;
		} else {
			const found = await lookupOrMiss(opts);
			checkStop(opts);
			if (found.error !== undefined) {
				lastCause = found.error;
			}
			current = found.route;
			const stale =
				current !== undefined &&
				failed !== undefined &&
				sameRoute(current, failed);
			if (current === undefined || stale || mustWait) {
				failed = undefined;
				mustWait = false;
				await budget.wait(lastCause);
				waited = true;
				// A stale route is tried again after this wait (failed is cleared).
				continue;
			}
			url = current.internalUrl;
		}
		if (!waited) {
			if (immediate >= opts.maxAttempts) {
				throw new AgentUnavailableError(machineId, lastCause);
			}
			immediate++;
		}
		waited = false;
		const outcome = await attempt(url);
		if (outcome.kind === "done") {
			return outcome.value;
		}
		lastCause = outcome.cause;
		registry.invalidate(machineId);
		if (outcome.kind === "moved" && outcome.instanceUrl) {
			if (sameUrl(outcome.instanceUrl, url)) {
				// Following it would ask the same instance again at once.
				failed = current;
				mustWait = true;
			} else {
				pinned = outcome.instanceUrl;
				failed = undefined;
			}
		} else {
			failed = current;
		}
	}
}

/**
 * Waits until the registry has a route for the machine, up to waitForAgentMs
 * (AgentUnavailableError after that). A failed lookup counts as a miss. With
 * accept, routes it rejects count as misses too.
 */
export async function waitForRoute(
	opts: RoutingOptions,
	accept: (route: Route) => boolean = () => true,
): Promise<Route> {
	const budget = new MissBudget(opts);
	let lastCause: unknown;
	for (;;) {
		checkStop(opts);
		const found = await lookupOrMiss(opts);
		if (found.route !== undefined && accept(found.route)) {
			return found.route;
		}
		if (found.error !== undefined) {
			lastCause = found.error;
		}
		checkStop(opts);
		await budget.wait(lastCause);
		if (found.route !== undefined) {
			// Do not serve the rejected route from a cache again.
			opts.registry.invalidate(opts.machineId);
		}
	}
}

/** The wait budget of a call: waitForAgentMs from the first miss. */
class MissBudget {
	private since: number | undefined;

	constructor(private readonly opts: RoutingOptions) {}

	/**
	 * Waits for a registry change, at most pollIntervalMs, or throws
	 * AgentUnavailableError when the budget is spent. It always yields to
	 * the macrotask queue first: a registry whose lookup fails and whose
	 * waitForChange resolves at once must not turn the loop into a
	 * synchronous spin that starves timers and abort signals.
	 */
	async wait(cause: unknown): Promise<void> {
		const { opts } = this;
		const now = Date.now();
		this.since ??= now;
		const left = opts.waitForAgentMs - (now - this.since);
		if (left <= 0) {
			throw new AgentUnavailableError(opts.machineId, cause);
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		await opts.registry.waitForChange(
			opts.machineId,
			boundedWait(opts, Math.min(opts.pollIntervalMs, left)),
			opts.signal,
		);
	}
}

/**
 * A registry lookup; errors come back as a miss, except TypeError (an
 * invalid machine id) and RegistryClosedError, which are thrown.
 */
async function lookupOrMiss(
	opts: RoutingOptions,
): Promise<{ route?: Route | undefined; error?: unknown }> {
	try {
		return { route: await opts.registry.lookup(opts.machineId) };
	} catch (err) {
		if (err instanceof TypeError || err instanceof RegistryClosedError) {
			throw err;
		}
		return { error: err };
	}
}

/** Compares two instance URLs ignoring trailing slashes. */
function sameUrl(a: string, b: string): boolean {
	return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
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
