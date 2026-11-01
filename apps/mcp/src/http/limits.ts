// Request guards of the remote MCP server (S11 6.2, 11.5): Host and Origin
// (DNS rebinding), the body size, and concurrent calls per principal.

/** A request body above this is 413 (files_write takes up to 1 MiB in base64). */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Concurrent tool calls of one principal on one pod; the next is rate_limited. */
export const MAX_CALLS_PER_PRINCIPAL = 16;

/**
 * Host values the endpoint answers (decision 8): the host of the public URL
 * with and without its port, plus the extra ones (UMIAK_MCP_ALLOWED_HOSTS).
 * An entry without a port matches its hostname on any port (as the MCP
 * SDK's check); one with a port matches only that port.
 */
export function allowedHostsOf(publicUrl: string, extra: string[] = []) {
	const u = new URL(publicUrl);
	return new Set(
		[u.host, u.hostname, ...extra].map((h) => h.trim().toLowerCase()),
	);
}

export function hostAllowed(host: string | null, allowed: Set<string>) {
	if (host === null) return false;
	const h = host.trim().toLowerCase();
	if (allowed.has(h)) return true;
	const hostname = /^(\[[^\]]*\]|[^:]*)(?::\d+)?$/.exec(h)?.[1];
	return hostname !== undefined && allowed.has(hostname);
}

/** Origins as `scheme://host[:port]`; a bad entry is a settings error upstream. */
export function allowedOriginsOf(origins: string[] = []): Set<string> {
	return new Set(origins.map((o) => new URL(o).origin));
}

/** No Origin (not a browser) passes; any other must be listed. */
export function originAllowed(origin: string | null, allowed: Set<string>) {
	if (origin === null) return true;
	try {
		const o = new URL(origin).origin;
		return o !== "null" && allowed.has(o);
	} catch {
		return false;
	}
}

/**
 * Reads a body up to `max` bytes; null when it is longer (the rest is not
 * read). Content-Length is checked first.
 */
export async function readBodyLimited(
	req: Request,
	max: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
	const declared = Number(req.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > max) return null;
	if (req.body === null) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let size = 0;
	const reader = req.body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > max) {
				await reader.cancel().catch(() => {});
				return null;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const out = new Uint8Array(size);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.byteLength;
	}
	return out;
}

/** Counts running calls per principal on this pod. */
export class CallLimiter {
	readonly #active = new Map<string, number>();
	readonly #max: number;

	constructor(max = MAX_CALLS_PER_PRINCIPAL) {
		this.#max = max;
	}

	/** A release function (idempotent), or null when the principal is at the limit. */
	acquire(key: string): (() => void) | null {
		const n = this.#active.get(key) ?? 0;
		if (n >= this.#max) return null;
		this.#active.set(key, n + 1);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const left = (this.#active.get(key) ?? 1) - 1;
			if (left <= 0) this.#active.delete(key);
			else this.#active.set(key, left);
		};
	}

	active(key: string): number {
		return this.#active.get(key) ?? 0;
	}
}
