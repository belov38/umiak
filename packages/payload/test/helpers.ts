import type { Payload } from "payload";
import pg from "pg";
import {
	closeSbxPayload,
	getSbxPayload,
	type SbxPayloadOptions,
} from "../src/index.ts";

export function testOptions(databaseUrl: string): SbxPayloadOptions {
	return {
		databaseUrl,
		secret: "test-payload-secret-0123456789abcdef",
		operatorGroups: ["sbx-operators"],
		appOrigin: "https://app.sbx.test",
		poolMax: 4,
	};
}

/** The Payload instance of a test database; close it with closePayload. */
export function openPayload(databaseUrl: string): Promise<Payload> {
	return getSbxPayload(testOptions(databaseUrl));
}

export function closePayload(databaseUrl: string): Promise<void> {
	return closeSbxPayload(databaseUrl);
}

export interface Note {
	channel: string;
	payload: string;
}

/**
 * LISTEN on its own connection. `settle()` sends a sentinel through another
 * session and waits for it: notifications committed before it have arrived.
 */
export class Listener {
	readonly notes: Note[] = [];
	readonly client: pg.Client;
	readonly #url: string;
	#onNote: ((n: Note) => void | Promise<void>) | null = null;
	#seq = 0;

	constructor(url: string) {
		this.#url = url;
		this.client = new pg.Client({ connectionString: url });
	}

	async start(channels: string[]): Promise<void> {
		await this.client.connect();
		this.client.on("notification", (m) => {
			const n = { channel: m.channel, payload: m.payload ?? "" };
			this.notes.push(n);
			if (!n.payload.startsWith("sentinel:")) void this.#onNote?.(n);
		});
		for (const c of [...channels, "sbx_test_sentinel"]) {
			await this.client.query(`LISTEN ${c}`);
		}
	}

	/** Called for every notification but sentinels. */
	onNote(fn: ((n: Note) => void | Promise<void>) | null): void {
		this.#onNote = fn;
	}

	clear(): void {
		this.notes.length = 0;
	}

	/** Waits until a notification matches, or fails after timeoutMs. */
	async waitFor(pred: (n: Note) => boolean, timeoutMs = 5_000): Promise<Note> {
		const end = Date.now() + timeoutMs;
		for (;;) {
			const n = this.notes.find(pred);
			if (n) return n;
			if (Date.now() > end) {
				throw new Error(
					`no matching notification; got ${JSON.stringify(this.notes)}`,
				);
			}
			await new Promise((r) => setTimeout(r, 10));
		}
	}

	/** Waits for a sentinel sent now; returns the notifications before it (sentinels dropped). */
	async settle(): Promise<Note[]> {
		const s = `sentinel:${++this.#seq}`;
		const c = new pg.Client({ connectionString: this.#url });
		await c.connect();
		try {
			await c.query("SELECT pg_notify('sbx_test_sentinel', $1)", [s]);
		} finally {
			await c.end();
		}
		await this.waitFor((n) => n.payload === s);
		const i = this.notes.findIndex((n) => n.payload === s);
		return this.notes
			.slice(0, i)
			.filter((n) => !n.payload.startsWith("sentinel:"));
	}

	async stop(): Promise<void> {
		await this.client.end();
	}
}
