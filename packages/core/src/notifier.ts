import pg from "pg";

/**
 * LISTEN/NOTIFY fan-out over one connection (`sbx_sandboxes`, `sbx_operations`,
 * `sbx_routes`).
 *
 * `fn(payload)` runs for each notification on the channel. `fn(null)` runs once
 * LISTEN is active for that subscriber: right after subscribing (or as soon as
 * the connection is up) and again after every reconnect. Notifications sent
 * before that may have been missed, so a subscriber re-reads its state on
 * `null`; reading once more on `null` after the first read closes the gap
 * between subscribing and the first read.
 */
export interface Notifier {
	subscribe(channel: string, fn: (payload: string | null) => void): () => void;
	close(): Promise<void>;
}

export interface PgNotifierOptions {
	connectionString: string;
	/** Delay before reconnecting (default 1000 ms, doubled up to 30 s). */
	reconnectDelayMs?: number;
	/** Connection errors (logged by the caller); never secrets. */
	onError?: (err: unknown) => void;
}

type Listener = (payload: string | null) => void;

interface ChannelState {
	fns: Set<Listener>;
	/** LISTEN confirmed on the current connection. */
	active: boolean;
}

const CHANNEL_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const MAX_DELAY_MS = 30_000;

/** Postgres implementation: connects lazily on the first subscribe. */
export class PgNotifier implements Notifier {
	readonly #opts: PgNotifierOptions;
	readonly #channels = new Map<string, ChannelState>();
	#client: pg.Client | null = null;
	#connecting = false;
	#closed = false;
	#timer: NodeJS.Timeout | null = null;
	#delay: number;

	constructor(opts: PgNotifierOptions) {
		this.#opts = opts;
		this.#delay = opts.reconnectDelayMs ?? 1000;
	}

	subscribe(channel: string, fn: Listener): () => void {
		if (!CHANNEL_RE.test(channel)) {
			throw new Error(`PgNotifier: invalid channel name '${channel}'`);
		}
		if (this.#closed) throw new Error("PgNotifier: closed");
		let st = this.#channels.get(channel);
		if (st === undefined) {
			st = { fns: new Set(), active: false };
			this.#channels.set(channel, st);
			const client = this.#client;
			if (client !== null) void this.#listen(client, channel);
		}
		st.fns.add(fn);
		if (st.active) queueMicrotask(() => this.#call(channel, fn, null));
		this.#ensureConnected();

		return () => {
			const cur = this.#channels.get(channel);
			if (cur === undefined || !cur.fns.delete(fn) || cur.fns.size > 0) return;
			this.#channels.delete(channel);
			this.#client?.query(`UNLISTEN ${channel}`).catch(() => {});
		};
	}

	async close(): Promise<void> {
		this.#closed = true;
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = null;
		this.#channels.clear();
		const c = this.#client;
		this.#client = null;
		if (c !== null) await c.end().catch(() => {});
	}

	#call(channel: string, fn: Listener, payload: string | null): void {
		// Unsubscribed in the meantime.
		if (!this.#channels.get(channel)?.fns.has(fn)) return;
		try {
			fn(payload);
		} catch (err) {
			this.#opts.onError?.(err);
		}
	}

	#ensureConnected(): void {
		if (this.#client !== null || this.#connecting || this.#closed) return;
		if (this.#timer !== null) return;
		void this.#connect();
	}

	async #connect(): Promise<void> {
		this.#connecting = true;
		const c = new pg.Client({ connectionString: this.#opts.connectionString });
		c.on("notification", (m) => {
			const st = this.#channels.get(m.channel);
			if (st === undefined || this.#client !== c) return;
			for (const fn of [...st.fns]) this.#call(m.channel, fn, m.payload ?? "");
		});
		c.on("error", (err) => this.#lost(c, err));
		c.on("end", () => this.#lost(c, null));
		try {
			await c.connect();
		} catch (err) {
			this.#connecting = false;
			c.end().catch(() => {});
			this.#lost(c, err);
			return;
		}
		this.#connecting = false;
		if (this.#closed) {
			await c.end().catch(() => {});
			return;
		}
		this.#client = c;
		this.#delay = this.#opts.reconnectDelayMs ?? 1000;
		for (const channel of [...this.#channels.keys()]) {
			await this.#listen(c, channel);
		}
	}

	async #listen(c: pg.Client, channel: string): Promise<void> {
		try {
			await c.query(`LISTEN ${channel}`);
		} catch (err) {
			this.#lost(c, err);
			return;
		}
		const st = this.#channels.get(channel);
		if (st === undefined || this.#client !== c || st.active) return;
		st.active = true;
		for (const fn of [...st.fns]) this.#call(channel, fn, null);
	}

	#lost(c: pg.Client, err: unknown): void {
		if (err !== null) this.#opts.onError?.(err);
		if (this.#client === c) this.#client = null;
		else if (this.#client !== null) return; // an old connection
		for (const st of this.#channels.values()) st.active = false;
		c.end().catch(() => {});
		if (this.#closed || this.#timer !== null || this.#connecting) return;
		const delay = this.#delay;
		this.#delay = Math.min(this.#delay * 2, MAX_DELAY_MS);
		this.#timer = setTimeout(() => {
			this.#timer = null;
			if (this.#channels.size > 0) this.#ensureConnected();
		}, delay);
		this.#timer.unref();
	}
}
