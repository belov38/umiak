import { randomUUID } from "node:crypto";
import ssh2, { type Client as SshClient } from "ssh2";

/** Transport-independent sbx-node interface; tests use a fake. */
export interface NodeOps {
	call<T = unknown>(op: string, args?: object): Promise<T>;
	close(): void;
}

export class NodeOpsError extends Error {
	readonly code: string;
	readonly op: string;
	constructor(op: string, code: string, message: string) {
		super(`sbx-node ${op}: ${code}: ${message}`);
		this.name = "NodeOpsError";
		this.code = code;
		this.op = op;
	}
}

/** Raw public keys pinned for host in an OpenSSH known_hosts file (plain host names only). */
export function parseKnownHosts(text: string, host: string): Buffer[] {
	const keys: Buffer[] = [];
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t || t.startsWith("#")) continue;
		const [hosts, , blob] = t.split(/\s+/);
		if (!hosts || !blob) continue;
		if (hosts.split(",").includes(host)) keys.push(Buffer.from(blob, "base64"));
	}
	return keys;
}

export interface SshNodeOpsOptions {
	host: string;
	port?: number;
	username?: string;
	privateKey: string | Buffer;
	/** known_hosts content; the host key must be listed for host. */
	knownHosts: string;
	/** OpenSSH allows 10 sessions per connection by default (MaxSessions). */
	maxChannels?: number;
	/** Per-call deadline; a hung call must not hold a channel slot forever. */
	callTimeoutMs?: number;
}

/**
 * sbx-node over SSH: one connection, one exec channel per call. The server side is a forced
 * command, so the exec command string is ignored there.
 */
export class SshNodeOps implements NodeOps {
	readonly #opts: SshNodeOpsOptions;
	readonly #pinned: Buffer[];
	#conn: Promise<SshClient> | undefined;
	#active = 0;
	#waiters: (() => void)[] = [];

	constructor(opts: SshNodeOpsOptions) {
		this.#opts = opts;
		this.#pinned = parseKnownHosts(opts.knownHosts, opts.host);
		if (this.#pinned.length === 0)
			throw new Error(`no pinned host key for ${opts.host}`);
	}

	#connect(): Promise<SshClient> {
		if (this.#conn) return this.#conn;
		const conn = new ssh2.Client();
		const p = new Promise<SshClient>((resolve, reject) => {
			conn.on("ready", () => resolve(conn));
			conn.on("error", (err) => {
				this.#conn = undefined;
				reject(err);
			});
			conn.on("close", () => {
				this.#conn = undefined;
			});
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
		this.#conn = p;
		return p;
	}

	async #acquire(): Promise<void> {
		if (this.#active < (this.#opts.maxChannels ?? 8)) {
			this.#active++;
			return;
		}
		await new Promise<void>((r) => this.#waiters.push(r));
	}

	#release(): void {
		const next = this.#waiters.shift();
		if (next) next();
		else this.#active--;
	}

	async call<T = unknown>(op: string, args: object = {}): Promise<T> {
		await this.#acquire();
		try {
			const conn = await this.#connect();
			const out = await new Promise<string>((resolve, reject) => {
				conn.exec("sbx-node", (err, stream) => {
					if (err) {
						reject(err);
						return;
					}
					let stdout = "";
					let stderr = "";
					const timer = setTimeout(() => {
						stream.close();
						reject(new Error(`sbx-node ${op}: timed out`));
					}, this.#opts.callTimeoutMs ?? 120_000);
					stream.on("data", (d: Buffer) => {
						stdout += d.toString("utf8");
					});
					stream.stderr.on("data", (d: Buffer) => {
						stderr += d.toString("utf8");
					});
					stream.on("close", () => {
						clearTimeout(timer);
						if (stdout.trim()) resolve(stdout);
						else
							reject(
								new Error(`sbx-node ${op}: empty response ${stderr.trim()}`),
							);
					});
					stream.end(
						`${JSON.stringify({ op, args, requestId: randomUUID() })}\n`,
					);
				});
			});
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
			this.#release();
		}
	}

	close(): void {
		void this.#conn?.then((c) => c.end()).catch(() => {});
		this.#conn = undefined;
	}
}
