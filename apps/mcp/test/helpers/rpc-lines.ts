// A bare JSON-RPC peer over newline-delimited streams (the stdio wire): the
// test sees every byte the server wrote to stdout and fails on anything that
// is not a JSON-RPC 2.0 message. Used against runStdio in memory and against
// a real `sbx mcp` child process.

export type Json = Record<string, unknown>;

export interface RpcLines {
	/** Every message the server wrote, in order. */
	messages: Json[];
	/** stdout lines that are not JSON-RPC 2.0 messages (must stay empty). */
	garbage: string[];
	/** Feeds bytes the server wrote to stdout. */
	feed(chunk: Buffer | string): void;
	/** Sends a request; resolves with its response (result or error). */
	request(method: string, params?: Json): Promise<Json>;
	/** Sends a request without waiting; returns its id and the response. */
	start(method: string, params?: Json): { id: number; response: Promise<Json> };
	notify(method: string, params?: Json): void;
	/** The server is gone: pending and later requests reject with `err`. */
	fail(err: Error): void;
	/** The 2025-11-25 handshake (initialize + notifications/initialized). */
	initialize(): Promise<Json>;
	/** tools/call; resolves with the result (throws on a JSON-RPC error). */
	callTool(name: string, args?: Json): Promise<ToolAnswer>;
}

export interface ToolAnswer {
	isError: boolean;
	text: string;
	result: Json;
}

export const LEGACY_PROTOCOL_VERSION = "2025-11-25";

function isJsonRpc(v: unknown): v is Json {
	return (
		typeof v === "object" &&
		v !== null &&
		!Array.isArray(v) &&
		(v as Json).jsonrpc === "2.0" &&
		("method" in v || "result" in v || "error" in v)
	);
}

export function toolAnswer(response: Json): ToolAnswer {
	if (response.error !== undefined) {
		throw new Error(`JSON-RPC error: ${JSON.stringify(response.error)}`);
	}
	const result = response.result as Json;
	const content = (result.content ?? []) as { type: string; text?: string }[];
	return {
		isError: result.isError === true,
		text: content
			.map((b) => (b.type === "text" ? (b.text ?? "") : ""))
			.join("\n"),
		result,
	};
}

export function rpcLines(write: (line: string) => void): RpcLines {
	const messages: Json[] = [];
	const garbage: string[] = [];
	const waiters = new Map<
		number | string,
		{ resolve: (m: Json) => void; reject: (e: Error) => void }
	>();
	let failed: Error | undefined;
	let buffer = "";
	let nextId = 1;

	const self: RpcLines = {
		messages,
		garbage,
		feed(chunk) {
			buffer += chunk.toString();
			for (;;) {
				const nl = buffer.indexOf("\n");
				if (nl < 0) break;
				const line = buffer.slice(0, nl).replace(/\r$/, "");
				buffer = buffer.slice(nl + 1);
				if (line === "") continue;
				let v: unknown;
				try {
					v = JSON.parse(line);
				} catch {
					garbage.push(line);
					continue;
				}
				if (!isJsonRpc(v)) {
					garbage.push(line);
					continue;
				}
				messages.push(v);
				const id = v.id as number | string | undefined;
				if (id !== undefined && !("method" in v)) {
					waiters.get(id)?.resolve(v);
					waiters.delete(id);
				}
			}
		},
		start(method, params) {
			const id = nextId++;
			const response = new Promise<Json>((resolve, reject) => {
				if (failed !== undefined) reject(failed);
				else waiters.set(id, { resolve, reject });
			});
			// A request whose answer is never read (cancelled, stdin closed)
			// must not become an unhandled rejection when the server goes away.
			response.catch(() => {});
			write(
				`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`,
			);
			return { id, response };
		},
		request(method, params) {
			return self.start(method, params).response;
		},
		fail(err) {
			failed = err;
			for (const w of waiters.values()) w.reject(err);
			waiters.clear();
		},
		notify(method, params) {
			write(
				`${JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })}\n`,
			);
		},
		async initialize() {
			const r = await self.request("initialize", {
				protocolVersion: LEGACY_PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "rpc-lines", version: "1.0.0" },
			});
			if (r.error !== undefined) {
				throw new Error(`initialize failed: ${JSON.stringify(r.error)}`);
			}
			self.notify("notifications/initialized");
			return r.result as Json;
		},
		async callTool(name, args = {}) {
			return toolAnswer(
				await self.request("tools/call", { name, arguments: args }),
			);
		},
	};
	return self;
}
