// Command routes (S7 §6, §9): start in sync, stream or detached mode (with
// Idempotency-Key: never started twice), list, get, the NDJSON stream,
// raw output by offset, input, kill and signal. Every route reads the
// command through its sandbox with the principal first, so another
// sandbox's or team's command is 404. Open streams and sync waits are
// registered in deps.streams (limit per principal, closed on revocation
// and shutdown).
import { randomUUID } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import {
	type CommandListFilter,
	type CommandStatus,
	idempotencyPrincipal,
	type Principal,
	uuidv5,
} from "@sbx/core";
import {
	agentErrorToHttp,
	isAgentOutcomeUnknown,
	unknownOutcomeError,
} from "../agent/errors.ts";
import type { AgentCommandInfo, AgentStream } from "../agent/types.ts";
import { authOf } from "../auth/principal.ts";
import { requireScope } from "../auth/scopes.ts";
import {
	checkStreamOffsets,
	commandResultOf,
	DEFAULT_ATTACH_MAX_ATTEMPTS,
	followCommand,
	readBudget,
	withinBudget,
} from "../commands/attach.ts";
import { collectSync, type SyncResult } from "../commands/collect.ts";
import {
	type CloseFrame,
	type Frame,
	NDJSON_CONTENT_TYPE,
	ndjsonResponse,
	StreamClose,
} from "../commands/frames.ts";
import { streamOwner } from "../commands/registry.ts";
import { requireSameMachine, startCommand } from "../commands/run.ts";
import type { ApiApp, ApiDeps } from "../deps.ts";
import { decodeCursor, signNextCursor } from "../http/cursor.ts";
import { ApiError, validationError } from "../http/errors.ts";
import {
	IDEMPOTENCY_REPLAYED_HEADER,
	idempotencyKeyHeader,
} from "../http/idempotency.ts";
import {
	isTerminalStatus,
	publicCommandId,
	resolveCommandRef,
	toCommandResource,
} from "../map/command.ts";
import { resolveSandboxRef } from "../map/sandbox.ts";
import {
	ERROR_RESPONSES,
	errorResponse,
	jsonBody,
	jsonResponse,
	optionalJsonBody,
} from "../openapi/registry.ts";
import {
	COMMAND_STATUSES,
	CommandFrameSchema,
	CommandListSchema,
	CommandParams,
	CommandSchema,
	InputRequest,
	KILL_DEFAULT_GRACE_MS,
	KillRequest,
	ListCommandsQuery,
	OUTPUT_DEFAULT_LIMIT,
	OutputQuery,
	SignalRequest,
	StartCommandRequest,
	StreamQuery,
	SyncCommandResultSchema,
} from "../schemas/command.ts";
import { compact, csvList, SandboxParams } from "../schemas/common.ts";

const TAGS = ["commands"];

const IdempotencyHeaders = z.object({
	"Idempotency-Key": z
		.string()
		.optional()
		.openapi({
			description:
				"1-255 printable ASCII characters; a repeat with the same key and body attaches to " +
				"the same command instead of starting it again (24 h)",
		}),
});

const commandIdHeader = {
	"Sbx-Command-Id": {
		description: "Id (`cmd_...`) of the command",
		schema: { type: "string" as const },
	},
};
const replayedHeader = {
	"Idempotency-Replayed": {
		description:
			"`true` when the command was started by an earlier request with this key",
		schema: { type: "string" as const, enum: ["true"] },
	},
};

const ndjson = (description: string) => ({
	description,
	content: { [NDJSON_CONTENT_TYPE]: { schema: CommandFrameSchema } },
});

const notFound404 = errorResponse(
	"`not_found`: no such sandbox or command (another sandbox's command too)",
);
const notReady409 = errorResponse(
	"`sandbox_not_ready` (details.state), `sandbox_starting` (retryable), `agent_outdated` " +
		"(details.capability) or `invalid_state`",
);
const unavailable503 = errorResponse(
	"`agent_unavailable`: retryable with an Idempotency-Key; without one `details.outcome` " +
		"says whether the command may run (`unknown`) or runs (`running`), see `details.commandId`",
);

// --- start ---

const startCommandRoute = createRoute({
	method: "post",
	path: "/v1/sandboxes/{sandbox}/commands",
	operationId: "commands.create",
	summary: "Run a command",
	description:
		"Starts a process in a ready sandbox (a creating or starting one is awaited up to 60 s). " +
		"Exactly one of `command` (bash -lc) and `argv`. Modes: `sync` (default) answers 200 " +
		"SyncCommandResult once the process exits (timeout at most 600 s; the connection is " +
		"silent until then, so proxies may cut it: SDKs use stream); `stream` answers 200 " +
		"application/x-ndjson frames (first `started`, last `exit`, `reconnect` or `error`) with " +
		"`Sbx-Command-Id`; `detached` answers 201 Command right after the start. With an " +
		"Idempotency-Key a repeat never starts the command twice: sync waits for the same " +
		"command, stream streams it from offset 0 with `started.replayed: true`, detached " +
		"answers 200.",
	tags: TAGS,
	middleware: [requireScope("commands:exec")] as const,
	request: {
		params: SandboxParams,
		headers: IdempotencyHeaders,
		body: jsonBody(StartCommandRequest, "What to run"),
	},
	responses: {
		200: {
			description:
				"sync: the result (application/json); stream: NDJSON frames; detached repeat: the Command",
			headers: { ...commandIdHeader, ...replayedHeader },
			content: {
				"application/json": {
					schema: z.union([SyncCommandResultSchema, CommandSchema]),
				},
				[NDJSON_CONTENT_TYPE]: { schema: CommandFrameSchema },
			},
		},
		201: {
			...jsonResponse(CommandSchema, "detached: the started command"),
			headers: commandIdHeader,
		},
		400: errorResponse(
			"`validation` (also: command and argv, sync timeout over 600)",
		),
		404: notFound404,
		409: errorResponse(
			"`sandbox_not_ready`, `sandbox_starting` (retryable), `agent_outdated`, " +
				"`idempotency_key_reused` or `invalid_state` (details.reason too_many_commands)",
		),
		429: errorResponse(
			"`rate_limited`: too many open streams of this key or user",
		),
		503: unavailable503,
		...ERROR_RESPONSES,
	},
});

// --- list / get ---

const listCommandsRoute = createRoute({
	method: "get",
	path: "/v1/sandboxes/{sandbox}/commands",
	operationId: "commands.list",
	summary: "List commands",
	description:
		"Commands of the sandbox, newest first, kept 90 days; works while the sandbox is stopped. " +
		"Filters: `status` (comma-separated), `mode`.",
	tags: TAGS,
	middleware: [requireScope("commands:read")] as const,
	request: { params: SandboxParams, query: ListCommandsQuery },
	responses: {
		200: jsonResponse(CommandListSchema, "A page of commands"),
		400: errorResponse("`validation` or `invalid_cursor`"),
		404: notFound404,
		...ERROR_RESPONSES,
	},
});

const getCommandRoute = createRoute({
	method: "get",
	path: "/v1/sandboxes/{sandbox}/commands/{command}",
	operationId: "commands.get",
	summary: "Get a command",
	description:
		"The command; while the sandbox is ready, pid and stream sizes are live from the agent.",
	tags: TAGS,
	middleware: [requireScope("commands:read")] as const,
	request: { params: CommandParams },
	responses: {
		200: jsonResponse(CommandSchema, "The command"),
		404: notFound404,
		...ERROR_RESPONSES,
	},
});

// --- stream / output ---

const streamCommandRoute = createRoute({
	method: "get",
	path: "/v1/sandboxes/{sandbox}/commands/{command}/stream",
	operationId: "commands.stream",
	summary: "Attach to a command's output",
	description:
		"NDJSON frames from the given offsets (first `attached`). `tailBytes` starts each stream " +
		"that many bytes before its end; `follow=false` sends what exists and closes. Reopen with " +
		"the offsets of the last frame after `reconnect`, a retryable `error` or a dropped " +
		"connection (no line for 45 s; heartbeats come every 15 s). An offset past the end of its " +
		"stream is 416; a non-zero offset of a stream the command does not have is 400.",
	tags: TAGS,
	middleware: [requireScope("commands:read")] as const,
	request: { params: CommandParams, query: StreamQuery },
	responses: {
		200: { ...ndjson("NDJSON frames"), headers: commandIdHeader },
		404: notFound404,
		409: notReady409,
		416: errorResponse(
			"`range_not_satisfiable`: an offset past the end of its stream (details.stream, details.size)",
		),
		429: errorResponse(
			"`rate_limited`: too many open streams of this key or user",
		),
		...ERROR_RESPONSES,
	},
});

const outputCommandRoute = createRoute({
	method: "get",
	path: "/v1/sandboxes/{sandbox}/commands/{command}/output",
	operationId: "commands.output",
	summary: "Read output by offset",
	description:
		"Raw bytes of one stream from `offset` (up to `limit`, at most 4 MiB). Headers: " +
		"Sbx-Offset (where the bytes start), Sbx-Next-Offset, Sbx-Available-From, Sbx-Stream-End " +
		"(only once the stream ended), Sbx-Truncated: true when `offset` was already evicted and " +
		"reading started at Sbx-Available-From. An offset past the end is 416. For polling " +
		"without streams.",
	tags: TAGS,
	middleware: [requireScope("commands:read")] as const,
	request: { params: CommandParams, query: OutputQuery },
	responses: {
		200: {
			description: "The bytes",
			headers: {
				"Sbx-Offset": { schema: { type: "integer" as const } },
				"Sbx-Next-Offset": { schema: { type: "integer" as const } },
				"Sbx-Available-From": { schema: { type: "integer" as const } },
				"Sbx-Stream-End": {
					description: "Final size of the stream, once it ended",
					schema: { type: "integer" as const },
				},
				"Sbx-Truncated": {
					schema: { type: "string" as const, enum: ["true"] },
				},
			},
			content: {
				"application/octet-stream": {
					schema: { type: "string", format: "binary" },
				},
			},
		},
		400: errorResponse("`validation` (a stream the command does not have)"),
		416: errorResponse(
			"`range_not_satisfiable`: offset past the end of the stream (details.size)",
		),
		404: notFound404,
		409: notReady409,
		...ERROR_RESPONSES,
	},
});

// --- input / kill / signal ---

const inputCommandRoute = createRoute({
	method: "post",
	path: "/v1/sandboxes/{sandbox}/commands/{command}/input",
	operationId: "commands.input",
	summary: "Write to stdin",
	description:
		"Writes `data` to the command's stdin (started with `stdin: true`, or a PTY). With " +
		"`sessionId` and `seq` a repeat is applied once; without them every request is new. " +
		"`closeStdin` sends EOF (not for PTY: send ^D). If the agent is unreachable the answer is " +
		"503 agent_unavailable: retryable with sessionId+seq, else `retryable: false` with " +
		"`details.outcome: unknown`.",
	tags: TAGS,
	middleware: [requireScope("commands:exec")] as const,
	request: {
		params: CommandParams,
		body: jsonBody(InputRequest, "The input"),
	},
	responses: {
		204: { description: "Written" },
		404: notFound404,
		409: errorResponse(
			"`command_exited`, `invalid_state` (no stdin) or `sandbox_not_ready`",
		),
		...ERROR_RESPONSES,
	},
});

const killCommandRoute = createRoute({
	method: "post",
	path: "/v1/sandboxes/{sandbox}/commands/{command}/kill",
	operationId: "commands.kill",
	summary: "Kill a command",
	description:
		"SIGTERM to the process group, SIGKILL to everything left after `graceMs` (default " +
		"10 000). Idempotent; an ended command is returned as is.",
	tags: TAGS,
	middleware: [requireScope("commands:exec")] as const,
	request: {
		params: CommandParams,
		body: optionalJsonBody(KillRequest, "Grace period"),
	},
	responses: {
		200: jsonResponse(
			CommandSchema,
			"The command (status changes once it exits)",
		),
		404: notFound404,
		409: notReady409,
		...ERROR_RESPONSES,
	},
});

const signalCommandRoute = createRoute({
	method: "post",
	path: "/v1/sandboxes/{sandbox}/commands/{command}/signal",
	operationId: "commands.signal",
	summary: "Send a signal",
	description:
		"Sends a signal to the process group (SIGKILL: to everything of the command). If the " +
		"agent is unreachable the answer is 503 agent_unavailable with `retryable: false` and " +
		"`details.outcome: unknown` (a repeat may deliver the signal twice).",
	tags: TAGS,
	middleware: [requireScope("commands:exec")] as const,
	request: {
		params: CommandParams,
		body: jsonBody(SignalRequest, "The signal"),
	},
	responses: {
		200: jsonResponse(CommandSchema, "The command"),
		404: notFound404,
		409: notReady409,
		...ERROR_RESPONSES,
	},
});

// --- helpers ---

/** The command (404 unless it is the sandbox's) and the machine to call. */
async function commandTarget(
	deps: ApiDeps,
	p: Principal,
	params: { sandbox: string; command: string },
) {
	const command = await deps.svc.getCommand(
		p,
		resolveSandboxRef(params.sandbox),
		resolveCommandRef(params.command),
	);
	const { machineId } = await deps.svc.resolveAgentTarget(p, command.sandboxId);
	requireSameMachine(command, machineId);
	return { command, machineId };
}

function streamsOf(mode: string): AgentStream[] {
	return mode === "pty" ? ["pty"] : ["stdout", "stderr"];
}

/** Frame types that end a stream. */
const LAST_FRAMES = new Set(["exit", "error", "reconnect"]);

/**
 * `frames` with `done` called once the stream is over: at its last frame
 * (the client may never read past it) or when it ends otherwise.
 */
async function* untilDone(
	frames: AsyncIterable<Frame>,
	done: () => void,
): AsyncGenerator<Frame> {
	try {
		for await (const f of frames) {
			if (LAST_FRAMES.has(f.type)) done();
			yield f;
		}
	} finally {
		done();
	}
}

/** The HTTP answer of a sync request whose stream ended without exit (§9.7). */
function syncEndedError(
	end: SyncResult["ended"] | CloseFrame | null,
	commandId: string,
	keyed: boolean,
): ApiError {
	const id = publicCommandId(commandId);
	const outcome = keyed
		? { commandId: id }
		: { commandId: id, outcome: "running" };
	if (end?.type === "reconnect") {
		return new ApiError(
			503,
			"server_shutting_down",
			keyed
				? "this api instance is shutting down; retry with the same Idempotency-Key to wait for the same command"
				: `this api instance is shutting down; the command keeps running, see GET .../commands/${id}`,
			{ retryable: keyed, details: outcome },
		);
	}
	if (end?.code === "unauthorized") {
		return new ApiError(401, "unauthorized", end.message);
	}
	if (end?.code === "agent_unavailable") {
		return new ApiError(503, "agent_unavailable", end.message, {
			retryable: keyed,
			details: outcome,
		});
	}
	if (end?.code === "not_found") {
		return new ApiError(404, "not_found", end.message);
	}
	return new ApiError(
		502,
		"agent_error",
		end?.message ?? "the command output ended without an exit",
		{ details: { agentCode: end?.code ?? null, commandId: id } },
	);
}

/** A close of the registry while the command was being started. */
function startClosedError(e: unknown): unknown {
	if (!(e instanceof StreamClose)) return e;
	const f = e.frame;
	if (f.type === "error") return new ApiError(401, "unauthorized", f.message);
	return new ApiError(
		503,
		"server_shutting_down",
		"this api instance is shutting down; retry the request",
		{ retryable: true },
	);
}

function base64Bytes(s: string): Uint8Array {
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) {
		throw validationError([{ path: "data", message: "must be base64" }]);
	}
	return Buffer.from(s, "base64");
}

export function registerCommandRoutes(app: ApiApp, deps: ApiDeps): void {
	const svc = deps.svc;

	app.openapi(startCommandRoute, async (c) => {
		const auth = authOf(c);
		const body = c.req.valid("json");
		const { sandbox } = c.req.valid("param");
		const idemKey = idempotencyKeyHeader(c);
		const ref = resolveSandboxRef(sandbox);
		const mode = body.mode ?? "sync";
		const encoding = body.encoding ?? "utf8";

		if (mode === "detached") {
			const r = await startCommand(deps, auth, ref, body, idemKey);
			const headers: Record<string, string> = {
				"Sbx-Command-Id": publicCommandId(r.command.id),
			};
			if (r.replayed) headers[IDEMPOTENCY_REPLAYED_HEADER] = "true";
			return c.json(
				toCommandResource(r.command, r.info),
				r.replayed ? 200 : 201,
				headers,
			);
		}

		// sync and stream are long connections, closed on revocation and
		// shutdown; only streams count toward the per-principal cap.
		const close = new AbortController();
		const unregister = deps.streams.register(
			streamOwner(auth),
			(f) => close.abort(new StreamClose(f)),
			// A body that is never read must not keep the slot.
			{ capped: mode === "stream", signal: c.req.raw.signal },
		);
		let r: Awaited<ReturnType<typeof startCommand>>;
		try {
			r = await startCommand(deps, auth, ref, body, idemKey, close.signal);
		} catch (e) {
			unregister();
			throw startClosedError(e);
		}
		const pub = publicCommandId(r.command.id);
		const pid = r.info?.pid ?? r.command.pid;
		const timings = deps.commandTimings;

		if (mode === "stream") {
			const gone = new AbortController();
			const frames = followCommand(
				deps,
				r.machineId,
				r.command.id,
				{},
				{
					follow: true,
					encoding,
					signal: AbortSignal.any([
						close.signal,
						gone.signal,
						c.req.raw.signal,
					]),
					maxDurationMs: timings.maxDurationMs,
					heartbeatMs: timings.heartbeatMs,
					attachMaxAttempts:
						timings.attachMaxAttempts ?? DEFAULT_ATTACH_MAX_ATTEMPTS,
					requestId: c.var.requestId,
					head: () => ({
						type: "started",
						commandId: pub,
						pid,
						encoding,
						...(r.replayed ? { replayed: true } : {}),
					}),
				},
			);
			const headers: Record<string, string> = { "Sbx-Command-Id": pub };
			if (r.replayed) headers[IDEMPOTENCY_REPLAYED_HEADER] = "true";
			return ndjsonResponse(c, untilDone(frames, unregister), headers, () => {
				gone.abort();
				unregister();
			}) as never; // zod-openapi has no response type for application/x-ndjson
		}

		// sync: read to the exit (the process timeout is at most 600 s).
		let result: SyncResult;
		try {
			result = await collectSync(
				followCommand(
					deps,
					r.machineId,
					r.command.id,
					{},
					{
						follow: true,
						encoding,
						signal: AbortSignal.any([close.signal, c.req.raw.signal]),
						maxDurationMs: Number.POSITIVE_INFINITY,
						heartbeatMs: timings.heartbeatMs,
						attachMaxAttempts:
							timings.attachMaxAttempts ?? DEFAULT_ATTACH_MAX_ATTEMPTS,
						requestId: c.var.requestId,
					},
				),
				encoding,
			);
		} finally {
			unregister();
		}
		if (result.exit === null && c.req.raw.signal.aborted) {
			// The client went away; the command keeps running (§9.2).
			return new Response(null, { status: 499 }) as never;
		}
		if (result.exit === null) {
			throw syncEndedError(
				result.ended ??
					(close.signal.reason instanceof StreamClose
						? close.signal.reason.frame
						: null),
				r.command.id,
				idemKey !== undefined,
			);
		}
		const done = await svc.getCommand(
			auth.principal,
			r.command.sandboxId,
			r.command.id,
		);
		const headers: Record<string, string> = { "Sbx-Command-Id": pub };
		if (r.replayed) headers[IDEMPOTENCY_REPLAYED_HEADER] = "true";
		return c.json(
			{
				command: {
					...toCommandResource(done),
					// The exit's value even if storing it failed.
					outputTruncated: result.exit.outputTruncated ?? done.outputTruncated,
				},
				stdout: result.stdout,
				stderr: result.stderr,
				stdoutTruncated: result.stdoutTruncated,
				stderrTruncated: result.stderrTruncated,
				stdoutFrom: result.stdoutFrom,
				stderrFrom: result.stderrFrom,
			},
			200,
			headers,
		);
	});

	app.openapi(listCommandsRoute, async (c) => {
		const p = authOf(c).principal;
		const { sandbox } = c.req.valid("param");
		const q = c.req.valid("query");
		const status = csvList(q.status);
		const bad = (status ?? []).filter(
			(s) => !(COMMAND_STATUSES as readonly string[]).includes(s),
		);
		if (bad.length > 0) {
			throw validationError([
				{
					path: "query.status",
					message: `unknown status ${bad.join(", ")}; one of ${COMMAND_STATUSES.join(", ")}`,
				},
			]);
		}
		const filter: CommandListFilter = compact({
			status: status as CommandStatus[] | undefined,
			mode: q.mode,
			limit: q.limit,
		});
		const key = deps.settings.cursorKey;
		const inner =
			q.cursor === undefined ? undefined : decodeCursor(q.cursor, key);
		const page = await svc.listCommands(
			p,
			resolveSandboxRef(sandbox),
			filter,
			inner,
		);
		return c.json(
			{
				data: page.data.map((cmd) => toCommandResource(cmd)),
				nextCursor: signNextCursor(page.nextCursor, key),
			},
			200,
		);
	});

	app.openapi(getCommandRoute, async (c) => {
		const p = authOf(c).principal;
		const params = c.req.valid("param");
		const s = await svc.get(p, resolveSandboxRef(params.sandbox));
		const command = await svc.getCommand(
			p,
			s.id,
			resolveCommandRef(params.command),
		);
		let live: AgentCommandInfo | null = null;
		if (s.state === "ready" && s.machineId === command.machineId) {
			// Enrichment only: a slow agent falls back to the stored row.
			live = await withinBudget(
				deps.agent.get(command.machineId, command.id),
				readBudget(deps),
				command.machineId,
			).catch(() => null);
		}
		const result = live === null ? null : commandResultOf(live);
		if (
			result !== null &&
			(!isTerminalStatus(command.status) ||
				(result.outputTruncated != null && command.outputTruncated === null))
		) {
			// A command nobody followed to its end (detached), or output the
			// agent dropped after the row was ended (completeCommand keeps
			// the status and only adds outputTruncated then).
			await svc.completeCommand(command.id, result).catch(() => {});
		}
		return c.json(toCommandResource(command, live), 200);
	});

	app.openapi(streamCommandRoute, async (c) => {
		const auth = authOf(c);
		const params = c.req.valid("param");
		const q = c.req.valid("query");
		const { command, machineId } = await commandTarget(
			deps,
			auth.principal,
			params,
		);
		const encoding = q.encoding ?? "utf8";
		const pty = command.mode === "pty";
		await checkStreamOffsets(
			deps,
			machineId,
			command.id,
			pty,
			compact({
				stdout: q.stdoutOffset,
				stderr: q.stderrOffset,
				pty: q.ptyOffset,
			}),
		);
		const close = new AbortController();
		const gone = new AbortController();
		const unregister = deps.streams.register(
			streamOwner(auth),
			(f) => close.abort(new StreamClose(f)),
			{ signal: c.req.raw.signal },
		);
		const pub = publicCommandId(command.id);
		const frames = followCommand(
			deps,
			machineId,
			command.id,
			compact({
				stdout: q.stdoutOffset,
				stderr: q.stderrOffset,
				pty: q.ptyOffset,
			}),
			{
				...(q.tailBytes === undefined ? {} : { tailBytes: q.tailBytes }),
				follow: q.follow !== "false",
				encoding,
				signal: AbortSignal.any([close.signal, gone.signal, c.req.raw.signal]),
				maxDurationMs: deps.commandTimings.maxDurationMs,
				heartbeatMs: deps.commandTimings.heartbeatMs,
				attachMaxAttempts:
					deps.commandTimings.attachMaxAttempts ?? DEFAULT_ATTACH_MAX_ATTEMPTS,
				requestId: c.var.requestId,
				pty,
				head: (o) => ({ type: "attached", commandId: pub, encoding, ...o }),
			},
		);
		return ndjsonResponse(
			c,
			untilDone(frames, unregister),
			{ "Sbx-Command-Id": pub },
			() => {
				gone.abort();
				unregister();
			},
		) as never; // zod-openapi has no response type for application/x-ndjson
	});

	app.openapi(outputCommandRoute, async (c) => {
		const p = authOf(c).principal;
		const params = c.req.valid("param");
		const q = c.req.valid("query");
		const { command, machineId } = await commandTarget(deps, p, params);
		const has = streamsOf(command.mode);
		const stream = q.stream ?? (has[0] as AgentStream);
		if (!has.includes(stream)) {
			throw validationError([
				{
					path: "query.stream",
					message: `this command has the streams ${has.join(", ")}`,
				},
			]);
		}
		const limit = q.limit ?? OUTPUT_DEFAULT_LIMIT;
		let info: AgentCommandInfo;
		try {
			info = await withinBudget(
				deps.agent.get(machineId, command.id),
				readBudget(deps),
				machineId,
			);
		} catch (e) {
			throw agentErrorToHttp(e);
		}
		const si = info.streams[stream] ?? { size: 0, availableFrom: 0, end: 0 };
		let offset = q.offset ?? 0;
		let availableFrom = si.availableFrom;
		let truncated = false;
		if (offset < availableFrom) {
			offset = availableFrom;
			truncated = true;
		}
		if (offset > si.size) {
			throw new ApiError(
				416,
				"range_not_satisfiable",
				`offset ${offset} is past the end of ${stream} (${si.size} bytes so far)`,
				{ details: { size: si.size } },
			);
		}
		const parts: Uint8Array[] = [];
		let got = 0;
		if (offset < si.size) {
			const ac = new AbortController();
			const at = (s: AgentStream) =>
				s === stream ? offset : (info.streams[s]?.size ?? 0);
			try {
				for await (const ev of deps.agent.attach(
					machineId,
					{
						commandId: command.id,
						stdoutOffset: at("stdout"),
						stderrOffset: at("stderr"),
						ptyOffset: at("pty"),
						follow: false,
					},
					ac.signal,
				)) {
					if (ev.type === "truncated" && ev.stream === stream) {
						// Evicted between Get and Attach.
						if (got > 0) break;
						availableFrom = ev.availableFrom;
						offset = Math.max(offset, ev.availableFrom);
						truncated = true;
					}
					if (ev.type !== "data" || ev.stream !== stream) continue;
					const part = ev.data.subarray(0, limit - got);
					parts.push(part);
					got += part.length;
					if (got >= limit) break;
				}
			} catch (e) {
				throw agentErrorToHttp(e);
			} finally {
				ac.abort();
			}
		}
		const next = offset + got;
		const headers: Record<string, string> = {
			"Content-Type": "application/octet-stream",
			"Sbx-Offset": String(offset),
			"Sbx-Next-Offset": String(next),
			"Sbx-Available-From": String(availableFrom),
		};
		if (si.end !== null) headers["Sbx-Stream-End"] = String(si.end);
		if (truncated) headers["Sbx-Truncated"] = "true";
		return c.body(Buffer.concat(parts), 200, headers);
	});

	app.openapi(inputCommandRoute, async (c) => {
		const p = authOf(c).principal;
		const params = c.req.valid("param");
		const b = c.req.valid("json");
		const { command, machineId } = await commandTarget(deps, p, params);
		if (isTerminalStatus(command.status)) throw commandExitedError();
		const data =
			b.encoding === "base64"
				? base64Bytes(b.data)
				: Buffer.from(b.data, "utf8");
		// A client's session is scoped to the principal and the command.
		const inputSessionId =
			b.sessionId === undefined
				? randomUUID()
				: uuidv5(
						`${idempotencyPrincipal(p)}:commands.input:${command.id}:${b.sessionId}`,
					);
		try {
			await deps.agent.sendInput(machineId, {
				commandId: command.id,
				inputSessionId,
				seq: b.seq ?? 1,
				data,
				closeStdin: b.closeStdin ?? false,
			});
		} catch (e) {
			// Without sessionId+seq the agent cannot drop a repeat.
			if (b.sessionId === undefined && isAgentOutcomeUnknown(e)) {
				throw unknownOutcomeError("the input may have been written", {
					commandId: publicCommandId(command.id),
				});
			}
			throw agentErrorToHttp(e);
		}
		return c.body(null, 204);
	});

	app.openapi(killCommandRoute, async (c) => {
		const p = authOf(c).principal;
		const params = c.req.valid("param");
		const b = c.req.valid("json") ?? {};
		const { command, machineId } = await commandTarget(deps, p, params);
		let info: AgentCommandInfo;
		try {
			info = await deps.agent.kill(machineId, {
				commandId: command.id,
				graceMs: b.graceMs ?? KILL_DEFAULT_GRACE_MS,
			});
		} catch (e) {
			throw agentErrorToHttp(e);
		}
		return c.json(toCommandResource(command, info), 200);
	});

	app.openapi(signalCommandRoute, async (c) => {
		const p = authOf(c).principal;
		const params = c.req.valid("param");
		const b = c.req.valid("json");
		const { command, machineId } = await commandTarget(deps, p, params);
		let info: AgentCommandInfo;
		try {
			info = await deps.agent.signal(machineId, {
				commandId: command.id,
				signal: b.signal,
			});
		} catch (e) {
			// A repeat would send the signal twice.
			if (isAgentOutcomeUnknown(e)) {
				throw unknownOutcomeError("the signal may have been sent", {
					commandId: publicCommandId(command.id),
				});
			}
			throw agentErrorToHttp(e);
		}
		return c.json(toCommandResource(command, info), 200);
	});
}

function commandExitedError(): ApiError {
	return new ApiError(
		409,
		"command_exited",
		"the command has exited; input is no longer accepted",
	);
}
