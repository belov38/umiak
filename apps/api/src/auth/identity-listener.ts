// LISTEN sbx_identity (S7 §7.2, §7.4, S8 §8): identity changes from the
// IdentityStore (Postgres triggers of the stand-in, Payload hooks in S8).
// Payloads are '<collection>:<id>' (users, teams, memberships, api-keys,
// ssh-keys; ids are opaque) or '*' (flush everything). Caches of the api
// (team keys, sessions) subscribe here; the stream registry follows (C9).
// 'sandboxes:<uuid>' is not an identity change: core sends it when an
// operator blocks or unblocks a sandbox; the stream registry and the desktop
// access monitor act on it.
import { type Notifier, PgNotifier } from "@sbx/core";
import type { Logger } from "pino";

export const IDENTITY_CHANNEL = "sbx_identity";

export type IdentityChange =
	| { all: false; collection: string; id: string }
	/** '*', or LISTEN was (re)established and notifications may be lost. */
	| { all: true };

export function parseIdentityPayload(payload: string): IdentityChange | null {
	if (payload === "*") return { all: true };
	const i = payload.indexOf(":");
	if (i <= 0 || i === payload.length - 1) return null;
	return {
		all: false,
		collection: payload.slice(0, i),
		id: payload.slice(i + 1),
	};
}

export type IdentityChangeHandler = (c: IdentityChange) => void;

export interface IdentityListenerOptions {
	log?: Logger;
}

/**
 * Fan-out of `sbx_identity` to the caches of this process. Without a
 * notifier (tests without Postgres) it never emits and counts as ready.
 */
export class IdentityListener {
	readonly #notifier: Notifier | null;
	readonly #log: Logger | undefined;
	readonly #handlers = new Set<IdentityChangeHandler>();
	#unsubscribe: (() => void) | null = null;
	#ready: boolean;
	#waiters: (() => void)[] = [];

	constructor(notifier: Notifier | null, o: IdentityListenerOptions = {}) {
		this.#notifier = notifier;
		this.#log = o.log;
		this.#ready = notifier === null;
	}

	/**
	 * A listener on its own Postgres connection. Connection errors make it
	 * not ready (`/readyz`) until LISTEN is confirmed again.
	 */
	static connect(
		connectionString: string,
		o: IdentityListenerOptions & { reconnectDelayMs?: number } = {},
	): IdentityListener {
		let self: IdentityListener | null = null;
		const notifier = new PgNotifier({
			connectionString,
			...(o.reconnectDelayMs === undefined
				? {}
				: { reconnectDelayMs: o.reconnectDelayMs }),
			onError: (err) => self?.connectionLost(err),
		});
		self = new IdentityListener(notifier, o);
		return self;
	}

	/** Subscribes to the channel; idempotent. */
	start(): void {
		if (this.#notifier === null || this.#unsubscribe !== null) return;
		this.#unsubscribe = this.#notifier.subscribe(IDENTITY_CHANNEL, (p) => {
			if (p === null) {
				// LISTEN is active (first time or after a reconnect): anything
				// sent while it was down is lost, so every cache starts over.
				this.#markReady();
				this.#emit({ all: true });
				return;
			}
			const change = parseIdentityPayload(p);
			if (change === null) {
				this.#log?.warn({ payload: p }, "unknown sbx_identity payload");
				return;
			}
			this.#emit(change);
		});
	}

	subscribe(fn: IdentityChangeHandler): () => void {
		this.#handlers.add(fn);
		return () => void this.#handlers.delete(fn);
	}

	/** LISTEN is confirmed and no connection error happened since. */
	isReady(): boolean {
		return this.#ready;
	}

	/** Resolves once ready (tests and startup). */
	whenReady(): Promise<void> {
		if (this.#ready) return Promise.resolve();
		return new Promise((resolve) => this.#waiters.push(resolve));
	}

	/** The LISTEN connection failed; ready again after the next LISTEN. */
	connectionLost(err?: unknown): void {
		if (this.#notifier === null) return;
		this.#ready = false;
		this.#log?.warn(
			{ err: err instanceof Error ? err.message : String(err) },
			"sbx_identity listener lost its connection",
		);
	}

	async close(): Promise<void> {
		this.#unsubscribe?.();
		this.#unsubscribe = null;
		this.#handlers.clear();
		await this.#notifier?.close();
	}

	#markReady(): void {
		this.#ready = true;
		const w = this.#waiters;
		this.#waiters = [];
		for (const fn of w) fn();
	}

	#emit(c: IdentityChange): void {
		for (const fn of [...this.#handlers]) {
			try {
				fn(c);
			} catch (err) {
				this.#log?.error(
					{ err: err instanceof Error ? err.message : String(err) },
					"sbx_identity handler failed",
				);
			}
		}
	}
}
