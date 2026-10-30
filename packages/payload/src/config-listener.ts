// LISTEN on one channel with its own Postgres connection. `onSignal` runs for
// every notification and each time LISTEN is (re)established, because
// notifications sent while the connection was down are lost. A lost
// connection is retried with a growing delay; reads must not rely on the
// listener alone (the reader has a TTL).
import pg from "pg";

export const CONFIG_CHANNEL = "sbx_config";
export const LISTENER_APPLICATION_NAME = "sbx-config-listener";

const MAX_RECONNECT_DELAY_MS = 10_000;

export interface ChannelListenerOptions {
	databaseUrl: string;
	channel: string;
	onSignal: () => void;
	reconnectDelayMs?: number;
	/** Connection errors; the listener retries by itself. */
	onError?: (err: unknown) => void;
}

export class ChannelListener {
	readonly #o: ChannelListenerOptions;
	readonly #baseDelayMs: number;
	#delayMs: number;
	#client: pg.Client | null = null;
	#timer: NodeJS.Timeout | null = null;
	#closed = false;

	constructor(o: ChannelListenerOptions) {
		this.#o = o;
		this.#baseDelayMs = o.reconnectDelayMs ?? 500;
		this.#delayMs = this.#baseDelayMs;
	}

	/** Resolves once LISTEN is confirmed; rejects if the first attempt fails. */
	async start(): Promise<void> {
		if (this.#closed) throw new Error("listener is closed");
		await this.#connect();
	}

	async close(): Promise<void> {
		this.#closed = true;
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = null;
		const c = this.#client;
		this.#client = null;
		await c?.end().catch(() => {});
	}

	async #connect(): Promise<void> {
		const client = new pg.Client({
			connectionString: this.#o.databaseUrl,
			application_name: LISTENER_APPLICATION_NAME,
		});
		const lost = (err?: unknown) => {
			// Only the live client counts; a failed attempt reports by throwing.
			if (this.#client !== client) return;
			this.#client = null;
			if (err !== undefined) this.#o.onError?.(err);
			void client.end().catch(() => {});
			this.#scheduleReconnect();
		};
		client.on("error", lost);
		client.on("end", () => lost());
		client.on("notification", (m) => {
			if (m.channel === this.#o.channel) this.#o.onSignal();
		});
		try {
			await client.connect();
			await client.query(`LISTEN ${this.#o.channel}`);
		} catch (err) {
			await client.end().catch(() => {});
			throw err;
		}
		if (this.#closed) {
			await client.end().catch(() => {});
			return;
		}
		this.#client = client;
		this.#delayMs = this.#baseDelayMs;
		this.#o.onSignal();
	}

	#scheduleReconnect(): void {
		if (this.#closed || this.#timer) return;
		const delay = this.#delayMs;
		this.#delayMs = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
		this.#timer = setTimeout(() => {
			this.#timer = null;
			this.#connect().catch((err) => {
				this.#o.onError?.(err);
				this.#scheduleReconnect();
			});
		}, delay);
		this.#timer.unref();
	}
}
