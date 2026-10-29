import { Agent, request } from "node:https";

export type ParamValue = string | number | boolean | readonly string[];
export type Params = Record<string, ParamValue | undefined>;

export class PveApiError extends Error {
	readonly status: number;
	readonly errors: Record<string, string> | undefined;
	constructor(
		status: number,
		message: string,
		errors?: Record<string, string>,
	) {
		super(errors ? `${message} ${JSON.stringify(errors)}` : message);
		this.name = "PveApiError";
		this.status = status;
		this.errors = errors;
	}
}

export class PveTaskError extends Error {
	readonly upid: string;
	readonly exitstatus: string;
	constructor(upid: string, exitstatus: string) {
		super(`task ${upid} failed: ${exitstatus}`);
		this.name = "PveTaskError";
		this.upid = upid;
		this.exitstatus = exitstatus;
	}
}

export interface PveApiOptions {
	url: string;
	tokenId: string;
	tokenSecret: string;
	ca: string | Buffer;
	/** Name the server certificate is checked against (also sent as SNI). */
	tlsName: string;
	retries?: number;
	retryDelayMs?: number;
}

/** The subset of PveApi the rest of the package depends on; tests use a fake. */
export interface PveClient {
	get<T = unknown>(path: string, params?: Params): Promise<T>;
	post<T = unknown>(path: string, params?: Params): Promise<T>;
	put<T = unknown>(path: string, params?: Params): Promise<T>;
	delete<T = unknown>(path: string, params?: Params): Promise<T>;
	waitTask(
		node: string,
		upid: string,
		opts?: { timeoutMs?: number; pollMs?: number },
	): Promise<void>;
}

export function encodeParams(params: Params = {}): string {
	const q = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) {
		if (v === undefined) continue;
		if (Array.isArray(v)) for (const item of v) q.append(k, item);
		else q.append(k, typeof v === "boolean" ? (v ? "1" : "0") : String(v));
	}
	return q.toString();
}

/** JSON.parse that tolerates raw control characters (QGA exec output passes them through). */
export function parseJsonLenient(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		// PVE responses are single-line, so control characters can only be inside strings.
		let fixed = "";
		for (const ch of text) {
			const code = ch.charCodeAt(0);
			fixed += code < 0x20 ? `\\u${code.toString(16).padStart(4, "0")}` : ch;
		}
		return JSON.parse(fixed);
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isRetryable(err: unknown): boolean {
	if (err instanceof PveApiError) {
		return (
			err.status === 503 || /can't lock file|got timeout/i.test(err.message)
		);
	}
	const code = (err as { code?: string }).code;
	return code === "ECONNRESET" || code === "EPIPE";
}

export class PveApi implements PveClient {
	/** Number of retried requests (lock contention etc.), reported by the bench. */
	retryCount = 0;
	readonly #opts: Required<PveApiOptions>;
	readonly #url: URL;
	readonly #agent: Agent;

	constructor(opts: PveApiOptions) {
		this.#opts = { retries: 5, retryDelayMs: 200, ...opts };
		this.#url = new URL(opts.url);
		this.#agent = new Agent({
			keepAlive: true,
			ca: opts.ca,
			servername: opts.tlsName,
			maxSockets: 16,
		});
	}

	get<T = unknown>(path: string, params?: Params) {
		return this.request<T>("GET", path, params);
	}
	post<T = unknown>(path: string, params?: Params) {
		return this.request<T>("POST", path, params);
	}
	put<T = unknown>(path: string, params?: Params) {
		return this.request<T>("PUT", path, params);
	}
	delete<T = unknown>(path: string, params?: Params) {
		return this.request<T>("DELETE", path, params);
	}

	async request<T>(method: string, path: string, params?: Params): Promise<T> {
		for (let attempt = 0; ; attempt++) {
			try {
				return (await this.#once(method, path, params)) as T;
			} catch (err) {
				if (attempt >= this.#opts.retries || !isRetryable(err)) throw err;
				this.retryCount++;
				await sleep(this.#opts.retryDelayMs * 2 ** attempt);
			}
		}
	}

	#once(method: string, path: string, params?: Params): Promise<unknown> {
		const encoded = encodeParams(params);
		const inQuery = method === "GET" || method === "DELETE";
		const fullPath = `/api2/json${path}${inQuery && encoded ? `?${encoded}` : ""}`;
		const headers: Record<string, string> = {
			Authorization: `PVEAPIToken=${this.#opts.tokenId}=${this.#opts.tokenSecret}`,
		};
		const body = inQuery ? "" : encoded;
		if (!inQuery) {
			headers["Content-Type"] = "application/x-www-form-urlencoded";
			headers["Content-Length"] = String(Buffer.byteLength(body));
		}
		return new Promise((resolve, reject) => {
			const req = request(
				{
					host: this.#url.hostname,
					port: this.#url.port || 8006,
					method,
					path: fullPath,
					headers,
					agent: this.#agent,
					ca: this.#opts.ca,
					servername: this.#opts.tlsName,
					timeout: 120_000,
				},
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (c: Buffer) => chunks.push(c));
					res.on("end", () => {
						const text = Buffer.concat(chunks).toString("utf8");
						let parsed: {
							data?: unknown;
							message?: string;
							errors?: Record<string, string>;
						} = {};
						try {
							parsed = text ? (parseJsonLenient(text) as typeof parsed) : {};
						} catch {
							parsed = {};
						}
						const status = res.statusCode ?? 0;
						if (status !== 200) {
							const msg = (
								parsed.message ??
								res.statusMessage ??
								`HTTP ${status}`
							).trim();
							reject(
								new PveApiError(
									status,
									`${method} ${path}: ${msg}`,
									parsed.errors,
								),
							);
							return;
						}
						resolve(parsed.data ?? null);
					});
				},
			);
			req.on("timeout", () =>
				req.destroy(new Error(`${method} ${path}: timeout`)),
			);
			req.on("error", reject);
			req.end(body);
		});
	}

	async waitTask(
		node: string,
		upid: string,
		opts: { timeoutMs?: number; pollMs?: number } = {},
	): Promise<void> {
		const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
		const pollMs = opts.pollMs ?? 250;
		for (;;) {
			const st = await this.get<{ status: string; exitstatus?: string }>(
				`/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`,
			);
			if (st.status === "stopped") {
				if (st.exitstatus !== "OK")
					throw new PveTaskError(upid, st.exitstatus ?? "unknown");
				return;
			}
			if (Date.now() > deadline)
				throw new Error(`task ${upid} did not finish in time`);
			await sleep(pollMs);
		}
	}

	close(): void {
		this.#agent.destroy();
	}
}
