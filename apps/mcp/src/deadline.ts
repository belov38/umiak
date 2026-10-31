// Hard deadline of one tool call (S11 7.5). Every tool gets one Deadline; its
// signal goes to every SDK call, retries included.

/** No call lasts longer than this. */
export const CALL_BUDGET_MS = 50_000;
/** Waits inside a call end this long before the deadline, to leave time to answer. */
export const RESPONSE_MARGIN_MS = 1_500;

export class Deadline {
	/** Aborts when the parent aborts or the budget runs out. */
	readonly signal: AbortSignal;

	private readonly parent: AbortSignal;
	private readonly controller = new AbortController();
	private readonly endsAt: number;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private timedOut = false;
	private readonly onParentAbort = () => {
		this.controller.abort(this.parent.reason);
	};

	constructor(parent: AbortSignal, budgetMs: number = CALL_BUDGET_MS) {
		this.parent = parent;
		this.signal = this.controller.signal;
		this.endsAt = Date.now() + budgetMs;
		if (parent.aborted) {
			this.controller.abort(parent.reason);
			return;
		}
		parent.addEventListener("abort", this.onParentAbort, { once: true });
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.timedOut = true;
			this.parent.removeEventListener("abort", this.onParentAbort);
			this.controller.abort(
				new DOMException("tool call deadline reached", "TimeoutError"),
			);
		}, budgetMs);
	}

	/** Time left to the deadline, never negative. */
	remainingMs(): number {
		return Math.max(0, this.endsAt - Date.now());
	}

	/** How long a wait of `waitSeconds` may last: it must end before the response margin. */
	waitMs(waitSeconds: number): number {
		return Math.max(
			0,
			Math.min(waitSeconds * 1000, this.remainingMs() - RESPONSE_MARGIN_MS),
		);
	}

	/** The budget ran out (the parent was not cancelled first). */
	expired(): boolean {
		return !this.cancelled() && (this.timedOut || this.remainingMs() === 0);
	}

	/** The parent signal aborted: the client cancelled or went away. */
	cancelled(): boolean {
		return this.parent.aborted;
	}

	/** Clears the timer and the parent listener; call when the tool call ends. */
	dispose(): void {
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		this.parent.removeEventListener("abort", this.onParentAbort);
	}
}
