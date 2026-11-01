// stdio entry of the MCP server (S11 6.1, 10.2): `umiak mcp` calls runStdio
// with the CLI's SDK client. One connection per process: the principal is
// read once (GET /v1/me, 5 s), stdout carries only JSON-RPC, and a client's
// notifications/cancelled is told apart from a stdin close, so exec_run
// kills its command only on the former.
import type { Readable, Writable } from "node:stream";
import {
	isJSONRPCNotification,
	type JSONRPCMessage,
	type MessageExtraInfo,
	type Transport,
	type TransportSendOptions,
} from "@modelcontextprotocol/server";
import {
	StdioServerTransport,
	serveStdio,
} from "@modelcontextprotocol/server/stdio";
import type { Umiak } from "@umiak/sdk";
import type { Logger } from "./log.ts";
import type { Toolset } from "./registry.ts";
import { createServer, type ServerOptions } from "./server.ts";
import { ALL_TOOLS } from "./tools/index.ts";

/** How long the connection waits for GET /v1/me before listing every tool. */
export const PRINCIPAL_TIMEOUT_MS = 5_000;

export interface StdioOptions {
	/** The SDK client; throws UmiakError/ToolError not_logged_in when there is no login. */
	umiak: () => Umiak;
	toolsets?: Toolset[];
	readOnly?: boolean;
	/** Sandbox id or slug (`self` is resolved by the caller). */
	pinnedSandbox?: string;
	/** Hint of an API 401 a new token does not fix; default: run `umiak login`. */
	unauthorizedHint?: string;
	log: Logger;
	/** Default process.stdin / process.stdout (tests pass their own). */
	stdin?: Readable;
	stdout?: Writable;
}

export interface StdioServer {
	/** Resolves when the client closed stdin (or close() was called). */
	closed: Promise<void>;
	close(): Promise<void>;
}

type RequestId = string | number;

/**
 * A transport that records the ids of inbound `notifications/cancelled`
 * before passing them on: the handler's signal is aborted both by such a
 * notification and by a closed stdin, and only the first one is the
 * person's Esc (spec 10.2).
 */
export class CancelTrackingTransport implements Transport {
	onclose?: () => void;
	onerror?: (error: Error) => void;
	onmessage?: <T extends JSONRPCMessage>(
		message: T,
		extra?: MessageExtraInfo,
	) => void;
	/** Resolves once the inner transport closed. */
	readonly closed: Promise<void>;
	readonly #inner: Transport;
	readonly #cancelled = new Set<RequestId>();
	#markClosed: () => void = () => {};

	constructor(inner: Transport) {
		this.#inner = inner;
		this.closed = new Promise((resolve) => {
			this.#markClosed = resolve;
		});
	}

	async start(): Promise<void> {
		this.#inner.onmessage = (message, extra) => {
			if (
				isJSONRPCNotification(message) &&
				message.method === "notifications/cancelled"
			) {
				const id = (message.params as { requestId?: unknown } | undefined)
					?.requestId;
				if (typeof id === "string" || typeof id === "number") {
					this.#cancelled.add(id);
				}
			}
			this.onmessage?.(message, extra);
		};
		this.#inner.onerror = (error) => this.onerror?.(error);
		this.#inner.onclose = () => {
			try {
				this.onclose?.();
			} finally {
				this.#markClosed();
			}
		};
		await this.#inner.start();
	}

	send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
		return this.#inner.send(message, options);
	}

	close(): Promise<void> {
		return this.#inner.close();
	}

	setProtocolVersion(version: string): void {
		this.#inner.setProtocolVersion?.(version);
	}

	/** The client sent notifications/cancelled for this request. */
	wasCancelled(id: RequestId): boolean {
		return this.#cancelled.has(id);
	}
}

type Principal = NonNullable<ServerOptions["principal"]>;

const PRINCIPAL_KINDS = new Set<string>(["oidc", "team_key", "session"]);

/** GET /v1/me within PRINCIPAL_TIMEOUT_MS; null (list every tool) on any failure. */
async function resolvePrincipal(
	umiak: () => Umiak,
	log: Logger,
): Promise<Principal | null> {
	try {
		const me = await umiak().me({
			signal: AbortSignal.timeout(PRINCIPAL_TIMEOUT_MS),
			retryBudgetMs: PRINCIPAL_TIMEOUT_MS,
		});
		const { kind, scopes } = me.auth;
		if (!PRINCIPAL_KINDS.has(kind)) return null;
		return { kind: kind as Principal["kind"], scopes: [...scopes] };
	} catch (err) {
		const code =
			typeof err === "object" && err !== null && "code" in err
				? String((err as { code: unknown }).code)
				: err instanceof Error
					? err.name
					: "unknown";
		log.info({ code }, "principal unknown, listing every tool");
		return null;
	}
}

/** Serves MCP on stdin/stdout until the client closes stdin. */
export async function runStdio(o: StdioOptions): Promise<StdioServer> {
	const wire = new CancelTrackingTransport(
		new StdioServerTransport(o.stdin, o.stdout),
	);
	// Started now, awaited by the first message: startup never waits for it.
	const principal = resolvePrincipal(o.umiak, o.log);
	const handle = serveStdio(
		async () =>
			createServer({
				tools: ALL_TOOLS,
				...(o.toolsets === undefined ? {} : { toolsets: o.toolsets }),
				...(o.readOnly === undefined ? {} : { readOnly: o.readOnly }),
				...(o.pinnedSandbox === undefined
					? {}
					: { pinnedSandbox: o.pinnedSandbox }),
				...(o.unauthorizedHint === undefined
					? {}
					: { unauthorizedHint: o.unauthorizedHint }),
				principal: await principal,
				umiak: o.umiak,
				transport: "stdio",
				log: o.log,
				wasCancelledByClient: (id) => wire.wasCancelled(id),
			}),
		{
			transport: wire,
			legacy: "serve",
			onerror: (err) =>
				o.log.warn({ reason: err.message }, "stdio connection error"),
		},
	);
	return {
		closed: wire.closed,
		close: () => handle.close(),
	};
}
