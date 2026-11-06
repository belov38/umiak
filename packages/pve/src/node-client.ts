import { createHash, createHmac, randomUUID } from "node:crypto";
import ssh2, { type Client as SshClient } from "ssh2";

/** Transport-independent umiak-node interface; tests use a fake. */
export interface NodeOps {
	call<T = unknown>(
		op: string,
		args?: object,
		onProgress?: (progress: Record<string, number>) => Promise<void>,
	): Promise<T>;
	sendVolume?<T = unknown>(
		args: object,
		onProgress?: (progress: Record<string, number>) => Promise<void>,
	): Promise<T>;
	close(): void;
}

export class NodeOpsError extends Error {
	readonly code: string;
	readonly op: string;
	constructor(op: string, code: string, message: string) {
		super(`umiak-node ${op}: ${code}: ${message}`);
		this.name = "NodeOpsError";
		this.code = code;
		this.op = op;
	}
}

function hostMatches(pattern: string, names: string[]): boolean {
	const h = /^\|1\|([^|]+)\|([^|]+)$/.exec(pattern);
	if (!h) return names.includes(pattern);
	const salt = Buffer.from(h[1] ?? "", "base64");
	const want = Buffer.from(h[2] ?? "", "base64");
	return names.some((n) =>
		createHmac("sha1", salt).update(n).digest().equals(want),
	);
}

/**
 * Raw public keys pinned for host in an OpenSSH known_hosts file. Like OpenSSH, a non-standard
 * port is written as [host]:port, and hashed names are supported; wildcard patterns are not.
 * A key on any @revoked line is never pinned, whatever its host pattern (stricter than OpenSSH,
 * since wildcards such as "@revoked *" are not matched here). @cert-authority lines are ignored:
 * host certificates are not supported.
 */
export function parseKnownHosts(
	text: string,
	host: string,
	port = 22,
): Buffer[] {
	const names = port === 22 ? [host, `[${host}]:22`] : [`[${host}]:${port}`];
	const keys: Buffer[] = [];
	const revoked: Buffer[] = [];
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t || t.startsWith("#")) continue;
		const fields = t.split(/\s+/);
		const marker = fields[0]?.startsWith("@") ? fields.shift() : undefined;
		const [hosts, , blob] = fields;
		if (!hosts || !blob) continue;
		if (marker === "@revoked") revoked.push(Buffer.from(blob, "base64"));
		else if (!marker && hosts.split(",").some((p) => hostMatches(p, names)))
			keys.push(Buffer.from(blob, "base64"));
	}
	return keys.filter((k) => !revoked.some((r) => r.equals(k)));
}

export interface SshNodeOpsOptions {
	host: string;
	port?: number;
	username?: string;
	privateKey: string | Buffer;
	/** known_hosts content; the host key must be listed for host. */
	knownHosts: string;
	/** SSH connections calls are spread over. */
	connections?: number;
	/**
	 * Concurrent channels per connection. OpenSSH allows 10 sessions per connection (MaxSessions)
	 * and frees a closed session only in a later pass of its main loop, so a channel opened right
	 * after another closed may still be refused: keep well below the limit.
	 */
	maxChannels?: number;
	/** Retries of a refused channel open; the request never reached umiak-node, so this is safe. */
	openRetries?: number;
	openRetryDelayMs?: number;
	/** Per-call deadline; a hung call must not hold a channel slot forever. */
	callTimeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** After a timeout, how long to wait for the channel close before giving the slot back anyway. */
const CLOSE_GRACE_MS = 5_000;

/**
 * umiak-node over SSH: a few connections, one exec channel per call. The server side is a forced
 * command, so the exec command string is ignored there.
 */
export class SshNodeOps implements NodeOps {
	readonly #opts: SshNodeOpsOptions;
	readonly #pinned: Buffer[];
	readonly #conns: (Promise<SshClient> | undefined)[];
	readonly #active: number[];
	#waiters: ((slot: number) => void)[] = [];

	constructor(opts: SshNodeOpsOptions) {
		this.#opts = opts;
		this.#pinned = parseKnownHosts(opts.knownHosts, opts.host, opts.port);
		if (this.#pinned.length === 0)
			throw new Error(`no pinned host key for ${opts.host}`);
		const n = Math.max(1, opts.connections ?? 2);
		this.#conns = new Array(n).fill(undefined);
		this.#active = new Array(n).fill(0);
	}

	#connect(slot: number): Promise<SshClient> {
		const existing = this.#conns[slot];
		if (existing) return existing;
		const conn = new ssh2.Client();
		const p = new Promise<SshClient>((resolve, reject) => {
			const forget = () => {
				if (this.#conns[slot] === p) this.#conns[slot] = undefined;
			};
			conn.on("ready", () => resolve(conn));
			conn.on("error", (err) => {
				forget();
				reject(err);
			});
			conn.on("close", forget);
			conn.connect({
				host: this.#opts.host,
				port: this.#opts.port ?? 22,
				username: this.#opts.username ?? "root",
				privateKey: this.#opts.privateKey,
				hostVerifier: (key: Buffer) => this.#pinned.some((k) => k.equals(key)),
				keepaliveInterval: 15_000,
				readyTimeout: 20_000,
			});
		});
		this.#conns[slot] = p;
		return p;
	}

	/** Takes a channel slot on the least busy connection. */
	async #acquire(): Promise<number> {
		const max = this.#opts.maxChannels ?? 5;
		let best = -1;
		for (let i = 0; i < this.#active.length; i++) {
			const a = this.#active[i] ?? 0;
			if (a < max && (best < 0 || a < (this.#active[best] ?? 0))) best = i;
		}
		if (best >= 0) {
			this.#active[best] = (this.#active[best] ?? 0) + 1;
			return best;
		}
		return new Promise<number>((r) => this.#waiters.push(r));
	}

	#release(slot: number): void {
		const next = this.#waiters.shift();
		if (next) next(slot);
		else this.#active[slot] = (this.#active[slot] ?? 1) - 1;
	}

	async #exec(conn: SshClient): Promise<ssh2.ClientChannel> {
		const retries = this.#opts.openRetries ?? 6;
		for (let attempt = 0; ; attempt++) {
			try {
				return await new Promise<ssh2.ClientChannel>((resolve, reject) =>
					conn.exec("umiak-node", (err, stream) =>
						err ? reject(err) : resolve(stream),
					),
				);
			} catch (err) {
				if (
					attempt >= retries ||
					!/Channel open failure/.test((err as Error).message)
				)
					throw err;
				await sleep((this.#opts.openRetryDelayMs ?? 20) * 2 ** attempt);
			}
		}
	}

	/** Sends the request and waits for the channel to close completely, also after a timeout. */
	#roundTrip(
		stream: ssh2.ClientChannel,
		op: string,
		args: object,
		onProgress?: (progress: Record<string, number>) => Promise<void>,
	): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			let stdout = "";
			let partial = "";
			let callbacks = Promise.resolve();
			let progressError: unknown;
			let stderr = "";
			let timedOut = false;
			let grace: NodeJS.Timeout | undefined;
			const fail = () => reject(new Error(`umiak-node ${op}: timed out`));
			const timer = setTimeout(
				() => {
					timedOut = true;
					stream.close();
					grace = setTimeout(fail, CLOSE_GRACE_MS);
				},
				this.#opts.callTimeoutMs ??
					(op === "layer.stage" ? 4 * 60 * 60_000 : 120_000),
			);
			stream.on("data", (d: Buffer) => {
				partial += d.toString("utf8");
				if (partial.length > 24 * 1024 * 1024) {
					stream.close();
					reject(new Error("node-agent response too large"));
					return;
				}
				let end = partial.indexOf("\n");
				while (end >= 0) {
					const line = partial.slice(0, end);
					partial = partial.slice(end + 1);
					try {
						const event = JSON.parse(line);
						if (event.event === "progress") {
							timer.refresh();
							callbacks = callbacks
								.then(() => onProgress?.(event.progress))
								.catch((error) => {
									progressError = error;
									stream.close();
								});
						} else stdout += line;
					} catch {
						stdout += line;
					}
					end = partial.indexOf("\n");
				}
			});
			stream.stderr.on("data", (d: Buffer) => {
				stderr += d.toString("utf8");
			});
			stream.on("close", async () => {
				clearTimeout(timer);
				clearTimeout(grace);
				await callbacks;
				stdout += partial;
				if (progressError) reject(progressError);
				else if (timedOut) fail();
				else if (stdout.trim()) resolve(stdout);
				else
					reject(
						new Error(`umiak-node ${op}: empty response ${stderr.trim()}`),
					);
			});
			stream.end(`${JSON.stringify({ op, args, requestId: randomUUID() })}\n`);
		});
	}

	async call<T = unknown>(
		op: string,
		args: object = {},
		onProgress?: (progress: Record<string, number>) => Promise<void>,
	): Promise<T> {
		const slot = await this.#acquire();
		try {
			const conn = await this.#connect(slot);
			const out = await this.#roundTrip(
				await this.#exec(conn),
				op,
				args,
				onProgress,
			);
			const resp = JSON.parse(out) as {
				ok: boolean;
				result?: T;
				error?: { code: string; message: string };
			};
			if (!resp.ok)
				throw new NodeOpsError(
					op,
					resp.error?.code ?? "unknown",
					resp.error?.message ?? "",
				);
			return resp.result as T;
		} finally {
			this.#release(slot);
		}
	}

	async sendVolume<T = unknown>(
		args: object,
		onProgress?: (progress: Record<string, number>) => Promise<void>,
	): Promise<T> {
		return this.call<T>("volume.sendTo", args, onProgress);
	}

	close(): void {
		for (let i = 0; i < this.#conns.length; i++) {
			void this.#conns[i]?.then((c) => c.end()).catch(() => {});
			this.#conns[i] = undefined;
		}
	}
}

export interface OfflineLayerRequest {
	jobId: string;
	vmid: number;
	manifest: object;
	mediaStorage?: string;
	signature: string;
	platform: string;
	agent: string;
	channel: "stable" | "edge";
	slug: "linux" | "linux-desktop";
}
export interface OfflineLayerReceipt {
	jobId: string;
	vmid: number;
	manifestSha256: string;
	mediaName: string;
	mediaIdentity: string;
	mediaSha256: string;
	mediaBytes: number;
	verified: boolean;
}
/** Only an authenticated exact-job receipt can become a read-only build input. */
export async function stageOfflineLayer(
	node: NodeOps,
	request: OfflineLayerRequest,
	onProgress?: (progress: Record<string, number>) => Promise<void>,
): Promise<OfflineLayerReceipt> {
	const digest = createHash("sha256")
		.update(JSON.stringify(request.manifest))
		.digest("hex");
	const prepared = await node.call<{
		manifestSha256: string;
		missing: string[];
	}>("layer.prepare", request);
	if (prepared.manifestSha256 !== digest)
		throw new Error("Node prepared a different offline layer");
	const receipt = await node.call<OfflineLayerReceipt>(
		"layer.stage",
		request,
		onProgress,
	);
	if (
		!receipt.verified ||
		receipt.jobId !== request.jobId ||
		receipt.vmid !== request.vmid ||
		receipt.manifestSha256 !== digest ||
		receipt.mediaName !== `umiak-layer-${request.jobId}.raw` ||
		!/^\d+:\d+$/.test(receipt.mediaIdentity) ||
		!/^[a-f0-9]{64}$/.test(receipt.mediaSha256) ||
		!Number.isSafeInteger(receipt.mediaBytes) ||
		receipt.mediaBytes <= 0 ||
		receipt.mediaBytes > 64 * 1024 ** 3
	)
		throw new Error("Node offline layer receipt identity mismatch");
	return receipt;
}
