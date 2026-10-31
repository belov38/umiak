// Per-call context handed to every tool handler: the SDK client, the 50 s
// deadline, pinned substitution, progress, cancel state, logger, User-Agent.
import type { ServerContext } from "@modelcontextprotocol/server";
import type { Sbx } from "@sbx/sdk";
import { type Deadline, RESPONSE_MARGIN_MS } from "./deadline.ts";
import type { Logger } from "./log.ts";
import type { ServerOptions } from "./server.ts";
import { MCP_VERSION } from "./version.ts";

export interface ToolContext {
	/** The SDK client; may throw ToolError not_logged_in. */
	sbx(): Sbx;
	deadline: Deadline;
	/** Spread into every SDK call; read at the call, so SDK retries end before the response margin. */
	call: { signal: AbortSignal; retryBudgetMs: number };
	/** The pinned sandbox in pinned mode, else `ref`. */
	sandbox(ref: string): string;
	/** Pinned mode (`sbx mcp --sandbox`): answers must not name hidden tools. */
	pinned: boolean;
	/** `notifications/progress`; a no-op when the request has no progressToken. Never throws. */
	progress(progress: number, total?: number, message?: string): Promise<void>;
	/** stdio: the client sent notifications/cancelled for this request (not a stdin close). */
	cancelledByClient(): boolean;
	transport: "stdio" | "http";
	log: Logger;
	/** sbx-mcp/<version> (<client>/<version>; stdio|http) */
	userAgent: string;
}

export interface ClientInfo {
	name: string;
	version: string;
}

// Header-safe token: no spaces, parentheses, slashes or semicolons, ASCII only.
function token(s: string): string {
	return s.replace(/[^\x21-\x7e]|[()/;\\]/g, "_").slice(0, 64);
}

export function userAgentOf(
	transport: "stdio" | "http",
	client: ClientInfo | undefined,
): string {
	const who =
		client === undefined
			? ""
			: `${token(client.name)}/${token(client.version)}; `;
	return `sbx-mcp/${MCP_VERSION} (${who}${transport})`;
}

export interface ContextInit {
	o: Pick<
		ServerOptions,
		"sbx" | "transport" | "log" | "pinnedSandbox" | "wasCancelledByClient"
	>;
	deadline: Deadline;
	req: ServerContext;
	client: ClientInfo | undefined;
}

export function createToolContext({
	o,
	deadline,
	req,
	client,
}: ContextInit): ToolContext {
	let sbx: Sbx | undefined;
	return {
		sbx() {
			sbx ??= o.sbx();
			return sbx;
		},
		deadline,
		get call() {
			return {
				signal: deadline.signal,
				retryBudgetMs: Math.max(0, deadline.remainingMs() - RESPONSE_MARGIN_MS),
			};
		},
		sandbox: (ref) => o.pinnedSandbox ?? ref,
		pinned: o.pinnedSandbox !== undefined,
		async progress(progress, total, message) {
			const progressToken = req.mcpReq._meta?.progressToken;
			if (progressToken === undefined) return;
			try {
				await req.mcpReq.notify({
					method: "notifications/progress",
					params: {
						progressToken,
						progress,
						...(total === undefined ? {} : { total }),
						...(message === undefined ? {} : { message }),
					},
				});
			} catch (err) {
				o.log.debug(
					{ rpcId: req.mcpReq.id, reason: String(err) },
					"progress notification failed",
				);
			}
		},
		cancelledByClient: () => o.wasCancelledByClient?.(req.mcpReq.id) ?? false,
		transport: o.transport,
		log: o.log,
		userAgent: userAgentOf(o.transport, client),
	};
}
