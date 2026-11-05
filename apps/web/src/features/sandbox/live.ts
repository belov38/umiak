// Live state of the sandbox page (S8 §9.6), without React: a long-poll loop
// `GET /v1/sandboxes/{sb}?waitFor=<every state but the current>&waitSeconds=30`
// (S7 §5.10). An operation started by a button is awaited in the same loop
// (`waitForOperation`), so the page holds at most one long-poll (S8 §9.1).
// Health and activity do not wake a long-poll: the page also polls every
// LIVE_POLL_MS.

/** The sandbox states of S7 §8.1, in lifecycle order. */
export const SANDBOX_STATES = [
	"creating",
	"ready",
	"stopping",
	"stopped",
	"starting",
	"error",
	"deleting",
	"deleted",
] as const;

/**
 * The api answers a long-poll at once when the sandbox is in one of these
 * states, whatever `waitFor` says: a loop would spin there.
 */
export const WAIT_END_STATES: ReadonlySet<string> = new Set([
	"error",
	"deleting",
	"deleted",
]);

/** waitSeconds of one long-poll. */
export const LONG_POLL_SECONDS = 30;
/** Plain poll for health, activity and the step of an operation. */
export const LIVE_POLL_MS = 10_000;
/** Pause of the loop while it cannot long-poll (end state, nothing read yet). */
export const LIVE_IDLE_MS = 2_000;
/** Pause after a failed long-poll. */
export const LIVE_ERROR_MS = 5_000;
/**
 * A long-poll that answers sooner than this is followed by a pause up to
 * it, so a server that does not wait cannot make the loop hammer it.
 */
export const LIVE_MIN_ROUND_MS = 1_000;

/** Every state except `current`. */
export function waitForStates(current: string): string[] {
	return SANDBOX_STATES.filter((s) => s !== current);
}

/** `waitFor` of the next long-poll, or null when a long-poll cannot wait. */
export function liveWaitFor(current: string | undefined): string | null {
	if (
		current === undefined ||
		WAIT_END_STATES.has(current) ||
		current === "queued"
	)
		return null;
	return waitForStates(current).join(",");
}

export interface LiveLoopDeps {
	/** The state the page shows now; undefined before the first answer. */
	state(): string | undefined;
	/** One long-poll of the sandbox; stores the answer. */
	longPoll(waitFor: string, signal: AbortSignal): Promise<void>;
	/** Waits until the operation is final, then refreshes the sandbox. */
	waitOperation(id: string, signal: AbortSignal): Promise<void>;
	onError?(e: unknown): void;
	sleep?(ms: number, signal: AbortSignal): Promise<void>;
	idleMs?: number;
	errorMs?: number;
	minRoundMs?: number;
}

export interface LiveLoop {
	/** Await this operation next; ends the long-poll in flight. */
	track(operationId: string): void;
	/** Ends the wait in flight: the next round reads the state again. */
	wake(): void;
	/** Settles once the loop has ended (its signal aborted). */
	done: Promise<void>;
}

/** Resolves after `ms`; rejects with the reason when `signal` aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const t = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(t);
			reject(signal.reason);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

export function startLiveLoop(
	deps: LiveLoopDeps,
	signal: AbortSignal,
): LiveLoop {
	const pause = deps.sleep ?? sleep;
	const idleMs = deps.idleMs ?? LIVE_IDLE_MS;
	const errorMs = deps.errorMs ?? LIVE_ERROR_MS;
	const minRoundMs = deps.minRoundMs ?? LIVE_MIN_ROUND_MS;
	const ops: string[] = [];
	let round: AbortController | null = null;
	const wake = () => round?.abort();

	const done = (async () => {
		while (!signal.aborted) {
			const current = new AbortController();
			round = current;
			const s = AbortSignal.any([signal, current.signal]);
			const op = ops[0];
			try {
				if (op !== undefined) {
					await deps.waitOperation(op, s);
					ops.shift();
					continue;
				}
				const waitFor = liveWaitFor(deps.state());
				if (waitFor === null) await pause(idleMs, s);
				else {
					const started = Date.now();
					await deps.longPoll(waitFor, s);
					const left = minRoundMs - (Date.now() - started);
					if (left > 0) await pause(left, s);
				}
			} catch (e) {
				if (signal.aborted) return;
				if (current.signal.aborted) continue; // woken up
				// A failed wait for an operation is dropped: the poll shows the state.
				if (op !== undefined && ops[0] === op) ops.shift();
				deps.onError?.(e);
				try {
					await pause(errorMs, s);
				} catch {
					// woken up or stopped: the loop condition decides
				}
			} finally {
				if (round === current) round = null;
			}
		}
	})();

	return {
		track(id) {
			if (ops.includes(id)) return;
			ops.push(id);
			// An operation wait in flight goes on; a sandbox long-poll yields.
			if (ops.length === 1) wake();
		},
		wake,
		done,
	};
}

/**
 * The SDK handle of the page's sandbox, built from the data the page has
 * (the query cache too, so a remount over cached data gets one without a
 * request). The same handle is kept while the id stays the same.
 */
export function sandboxHandle<
	D extends { id: string },
	H extends { id: string; data: D },
>(
	make: (data: D) => H,
	data: D | undefined,
	prev: H | undefined,
): H | undefined {
	if (data === undefined) return undefined;
	if (prev !== undefined && prev.id === data.id) {
		prev.data = data;
		return prev;
	}
	return make(data);
}

/** What the sandbox is read by: its id once known (a rename elsewhere keeps working), else the ref of the URL. */
export function pollRef(ref: string, knownId: string | undefined): string {
	return knownId ?? ref;
}
