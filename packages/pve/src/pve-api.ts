import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import type { IncomingMessage } from "node:http";
import { Agent, request } from "node:https";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

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

/**
 * Proxmox gave up waiting for the QEMU guest agent. The guest may still execute the command (or
 * already did), so it must never be repeated blindly: exec may run twice, exec-status may have
 * consumed the exit status.
 */
export class QgaTimeoutError extends PveApiError {
	/** QGA command name, e.g. guest-exec-status. */
	readonly command: string;
	constructor(status: number, message: string, command: string) {
		super(status, message);
		this.name = "QgaTimeoutError";
		this.command = command;
	}
}

const QGA_TIMEOUT_RE = /qga command '([\w-]+)' failed - got timeout/i;
const LOCK_TIMEOUT_RE = /can't lock file/i;

function apiError(
	status: number,
	message: string,
	errors?: Record<string, string>,
): PveApiError {
	const qga = QGA_TIMEOUT_RE.exec(message);
	if (qga?.[1]) return new QgaTimeoutError(status, message, qga[1]);
	return new PveApiError(status, message, errors);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CONNECTION_ERROR_CODES = new Set([
	"ECONNRESET",
	"EPIPE",
	"ETIMEDOUT",
	"ECONNREFUSED",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"EAI_AGAIN",
]);

/**
 * The connection to the API broke or could not be made (a flaky uplink): reset ("socket hang
 * up"), timed out, refused, unreachable. The request may or may not have reached Proxmox.
 */
export function isConnectionError(err: unknown): boolean {
	if (!(err instanceof Error) || err instanceof PveApiError) return false;
	const code = (err as { code?: unknown }).code;
	return (
		(typeof code === "string" && CONNECTION_ERROR_CODES.has(code)) ||
		/socket hang up/i.test(err.message)
	);
}

/**
 * A lock timeout means the request was not executed, so any method may be retried. Guest agent
 * calls are not idempotent (exec, fsfreeze, and exec-status, which forgets an exited PID): only
 * their read-only GETs other than exec-status are retried after a broken connection (Qga.exec
 * polls exec-status on by itself). Otherwise only GET is retried on a timeout or a broken
 * connection, which may hide an executed request.
 */
function isRetryable(err: unknown, method: string, path: string): boolean {
	if (err instanceof QgaTimeoutError) return false;
	if (err instanceof PveApiError && LOCK_TIMEOUT_RE.test(err.message))
		return true;
	if (path.includes("/agent/"))
		return (
			method === "GET" &&
			!path.endsWith("/agent/exec-status") &&
			isConnectionError(err)
		);
	if (err instanceof PveApiError)
		return (
			err.status === 503 ||
			(method === "GET" && /got timeout/.test(err.message))
		);
	return method === "GET" && isConnectionError(err);
}

export interface UploadFile {
	/** File name on the storage. */
	name: string;
	/** Local path of the file. */
	path: string;
	size: number;
}

/**
 * Field parts in the order pveproxy accepts: its multipart parser fails ("wrong
 * Content-Disposition ... expected 'form-data'") when `checksum` comes before
 * `checksum-algorithm` (seen on PVE 9), so the algorithm goes right before the checksum.
 */
function uploadFieldOrder(fields: Record<string, string>): [string, string][] {
	const algo = fields["checksum-algorithm"];
	const out: [string, string][] = [];
	for (const [k, v] of Object.entries(fields)) {
		if (k === "checksum-algorithm" && "checksum" in fields) continue;
		if (k === "checksum" && algo !== undefined)
			out.push(["checksum-algorithm", algo]);
		out.push([k, v]);
	}
	return out;
}

function readResponse(
	res: IncomingMessage,
	method: string,
	path: string,
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		res.on("data", (c: Buffer) => chunks.push(c));
		res.on("error", reject);
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
				reject(apiError(status, `${method} ${path}: ${msg}`, parsed.errors));
				return;
			}
			resolve(parsed.data ?? null);
		});
	});
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
				if (attempt >= this.#opts.retries || !isRetryable(err, method, path))
					throw err;
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
				(res) => readResponse(res, method, path).then(resolve, reject),
			);
			req.on("timeout", () =>
				req.destroy(new Error(`${method} ${path}: timeout`)),
			);
			req.on("error", reject);
			req.end(body);
		});
	}

	/**
	 * POST as multipart/form-data with the file streamed from disk as the last part (Proxmox
	 * reads the parameters before the file). Never retried. The socket idle timeout is long:
	 * Proxmox answers only after it has checked and moved the file.
	 */
	upload<T = unknown>(
		path: string,
		fields: Record<string, string>,
		file: UploadFile,
		opts: { timeoutMs?: number } = {},
	): Promise<T> {
		const unsafe = /["\\\r\n]/;
		for (const name of [...Object.keys(fields), file.name])
			if (name === "" || unsafe.test(name))
				return Promise.reject(
					new Error(`upload ${path}: bad part name ${JSON.stringify(name)}`),
				);
		const boundary = `umiak-${randomBytes(16).toString("hex")}`;
		let head = "";
		for (const [k, v] of uploadFieldOrder(fields))
			head += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
		head += `--${boundary}\r\nContent-Disposition: form-data; name="filename"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
		const tail = `\r\n--${boundary}--\r\n`;
		async function* body() {
			yield Buffer.from(head);
			let n = 0;
			for await (const chunk of createReadStream(file.path)) {
				n += (chunk as Buffer).length;
				if (n > file.size) break;
				yield chunk as Buffer;
			}
			if (n !== file.size)
				throw new Error(
					`upload ${path}: ${file.path} does not have the declared size ${file.size}`,
				);
			yield Buffer.from(tail);
		}
		return new Promise<T>((resolve, reject) => {
			const req = request(
				{
					host: this.#url.hostname,
					port: this.#url.port || 8006,
					method: "POST",
					path: `/api2/json${path}`,
					headers: {
						Authorization: `PVEAPIToken=${this.#opts.tokenId}=${this.#opts.tokenSecret}`,
						"Content-Type": `multipart/form-data; boundary=${boundary}`,
						"Content-Length": String(
							Buffer.byteLength(head) + file.size + Buffer.byteLength(tail),
						),
					},
					agent: this.#agent,
					ca: this.#opts.ca,
					servername: this.#opts.tlsName,
					timeout: opts.timeoutMs ?? 30 * 60_000,
				},
				(res) =>
					readResponse(res, "POST", path).then((v) => resolve(v as T), reject),
			);
			req.on("timeout", () => req.destroy(new Error(`POST ${path}: timeout`)));
			req.on("error", reject);
			pipeline(Readable.from(body()), req).catch((err: unknown) => {
				req.destroy(err as Error);
				reject(err);
			});
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
				if (st.exitstatus !== "OK" && !st.exitstatus?.startsWith("WARNINGS"))
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
