// Server factory (S11 5, 7.5, 7.6, 11.4): an McpServer with the selected
// tools, each call wrapped in a deadline, a concurrency slot, error mapping,
// the result cap and one log line without arguments.
import {
	type CallToolResult,
	CLIENT_INFO_META_KEY,
	McpServer,
	type ServerContext,
} from "@modelcontextprotocol/server";
import { type Sbx, SbxError } from "@sbx/sdk";
import { type ClientInfo, createToolContext } from "./context.ts";
import { Deadline } from "./deadline.ts";
import { type ErrorResultExtra, errorResult, ToolError } from "./errors.ts";
import { pinnedInstructions, SERVER_INSTRUCTIONS } from "./instructions.ts";
import type { Logger } from "./log.ts";
import type { CallRecord } from "./metrics.ts";
import { capResult } from "./output/result.ts";
import {
	assertToolDef,
	isPinned,
	publishedSchemaOf,
	selectTools,
	type ToolDef,
	type Toolset,
} from "./registry.ts";
import { MCP_SERVER_NAME, MCP_VERSION } from "./version.ts";

export interface ServerOptions {
	/** ALL_TOOLS by default (Task 6). */
	tools: readonly ToolDef[];
	/** Default: all toolsets. */
	toolsets?: readonly Toolset[];
	readOnly?: boolean;
	/** null or absent: unknown, listed as a person (every tool). */
	principal?: {
		kind: "oidc" | "team_key" | "session";
		scopes: string[];
	} | null;
	/** Sandbox id or slug every call is pinned to. */
	pinnedSandbox?: string;
	/** May throw ToolError not_logged_in. */
	sbx: () => Sbx;
	transport: "stdio" | "http";
	log: Logger;
	wasCancelledByClient?: (requestId: string | number) => boolean;
	/** stdio: the hint of an API 401 (default: run `sbx login`). */
	unauthorizedHint?: string;
	/** HTTP: the API answered 401 during a call. */
	onAuthFailure?: () => void;
	/** HTTP concurrency limit: a release function, or null when no slot is free. */
	acquireSlot?: () => (() => void) | null;
	/** After every call (HTTP metrics). */
	onCallEnd?: (r: CallRecord) => void;
	/** Tests: a shorter budget than CALL_BUDGET_MS. */
	callBudgetMs?: number;
}

/** tools/list depends on the principal, so it is cached privately for 1 h. */
export const TOOLS_LIST_CACHE_HINT = {
	ttlMs: 3_600_000,
	cacheScope: "private",
} as const;

export function createServer(o: ServerOptions): McpServer {
	const server = new McpServer(
		{ name: MCP_SERVER_NAME, version: MCP_VERSION },
		{
			capabilities: { tools: {} },
			instructions:
				o.pinnedSandbox === undefined
					? SERVER_INSTRUCTIONS
					: pinnedInstructions(o.pinnedSandbox),
			cacheHints: { "tools/list": TOOLS_LIST_CACHE_HINT },
		},
	);
	for (const t of o.tools) assertToolDef(t);
	const pinned = isPinned(o);
	for (const t of selectTools(o)) {
		server.registerTool(
			t.name,
			{
				title: t.title,
				description: t.description,
				inputSchema: publishedSchemaOf(t, pinned),
				annotations: { ...t.annotations },
			},
			(args, req) =>
				callTool(server, o, t, args as Record<string, unknown>, req),
		);
	}
	return server;
}

function clientInfoOf(
	server: McpServer,
	req: ServerContext,
): ClientInfo | undefined {
	// 2026-07-28: per-request envelope; 2025-era: the initialize handshake.
	const envelope = req.mcpReq.envelope as Record<string, unknown> | undefined;
	const info =
		envelope?.[CLIENT_INFO_META_KEY] ?? server.server.getClientVersion();
	if (typeof info !== "object" || info === null) return undefined;
	const { name, version } = info as Record<string, unknown>;
	return typeof name === "string" && typeof version === "string"
		? { name, version }
		: undefined;
}

/** Unknown errors are bugs: their message and stack go to the log, never to the model. */
function logUnknown(
	log: Logger,
	fields: Record<string, unknown>,
	err: unknown,
) {
	const e =
		err instanceof Error
			? { type: err.name, message: err.message, stack: err.stack }
			: { type: typeof err, message: String(err) };
	log.error({ ...fields, err: e }, "tool call failed");
}

function toCallError(
	err: unknown,
	deadline: Deadline,
	o: ServerOptions,
	fields: Record<string, unknown>,
): ToolError | SbxError {
	if (err instanceof ToolError) return err;
	if (err instanceof SbxError && err.status === 401) {
		if (o.transport === "stdio") {
			// The SDK already asked the CLI for a new token once: only a new
			// login helps, so the model must not loop on it.
			return new ToolError({
				code: "unauthorized",
				message: "the API rejected the credentials",
				hint:
					o.unauthorizedHint ?? "run `sbx login` in a terminal, then retry.",
			});
		}
		o.onAuthFailure?.();
		return new ToolError({
			code: "unauthorized",
			message: "retry the call",
			retryable: true,
		});
	}
	if (err instanceof SbxError) return err;
	// The client dropped the request: the answer is not read, keep it sane.
	if (deadline.cancelled()) {
		return new ToolError({
			code: "cancelled",
			message: "the call was cancelled by the client",
			retryable: true,
		});
	}
	if (deadline.expired()) {
		return new ToolError({
			code: "deadline_exceeded",
			message: "the call did not finish in time",
			retryable: true,
		});
	}
	logUnknown(o.log, fields, err);
	// errorResult never sees the raw error (it would map AbortError by name).
	return new ToolError({ code: "internal", message: "internal error" });
}

function firstText(r: CallToolResult): string | undefined {
	const b = r.content[0];
	return b?.type === "text" ? b.text : undefined;
}

function lineValue(text: string, key: string): string | undefined {
	return new RegExp(`^${key}: (.+)$`, "m").exec(text)?.[1];
}

/** What the call line says about the result: error code, API request id, command id. */
function resultFields(r: CallToolResult): Record<string, string> {
	const text = firstText(r);
	if (text === undefined) return {};
	const out: Record<string, string> = {};
	if (r.isError) {
		const code = lineValue(text, "error");
		const requestId = lineValue(text, "request_id");
		if (code !== undefined) out.code = code;
		if (requestId !== undefined) out.requestId = requestId;
		return out;
	}
	if (text.startsWith("{")) {
		try {
			const header: unknown = JSON.parse(text);
			const id = (header as Record<string, unknown> | null)?.command_id;
			if (typeof id === "string") out.commandId = id;
		} catch {
			// Not a JSON header: nothing to log.
		}
	}
	return out;
}

async function callTool(
	server: McpServer,
	o: ServerOptions,
	t: ToolDef,
	args: Record<string, unknown>,
	req: ServerContext,
): Promise<CallToolResult> {
	const started = performance.now();
	const sandbox = t.sandboxArg
		? (o.pinnedSandbox ?? String(args.sandbox))
		: undefined;
	const fields: Record<string, unknown> = {
		tool: t.name,
		rpcId: req.mcpReq.id,
	};
	if (sandbox !== undefined) fields.sandbox = sandbox;
	if (typeof args.command_id === "string") fields.commandId = args.command_id;
	const extra: ErrorResultExtra = {
		...(sandbox === undefined ? {} : { sandbox }),
		...(isPinned(o) ? { pinned: true } : {}),
	};

	let result: CallToolResult;
	const release = o.acquireSlot === undefined ? () => {} : o.acquireSlot();
	if (release === null) {
		result = errorResult(
			new ToolError({
				code: "rate_limited",
				message: "too many concurrent calls",
				retryable: true,
			}),
			extra,
		);
	} else {
		const deadline = new Deadline(req.mcpReq.signal, o.callBudgetMs);
		try {
			const ctx = createToolContext({
				o,
				deadline,
				req,
				client: clientInfoOf(server, req),
			});
			result = await t.handler({ ...args, sandbox: sandbox ?? "" }, ctx);
		} catch (err) {
			result = errorResult(toCallError(err, deadline, o, fields), extra);
		} finally {
			deadline.dispose();
			release();
		}
	}

	result = capResult(result);
	const outcome = resultFields(result);
	const durationMs = Math.round(performance.now() - started);
	o.log.info({ ...fields, ...outcome, durationMs }, "tool call");
	o.onCallEnd?.({
		tool: t.name,
		outcome: result.isError ? (outcome.code ?? "error") : "ok",
		durationMs,
		bytes: contentBytes(result),
	});
	return result;
}

/** Bytes of the text and the base64 data of a result. */
function contentBytes(r: CallToolResult): number {
	let n = 0;
	for (const b of r.content) {
		if (b.type === "text") n += Buffer.byteLength(b.text);
		else if (b.type === "image" || b.type === "audio") n += b.data.length;
	}
	return n;
}
