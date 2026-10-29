// PTY routes (S7 §6, §10): create a PTY command (Idempotency-Key, agent
// capability process.pty), resize it, and connect to it over a WebSocket
// with the subprotocol sbx.pty.v1 (protocol: commands/pty-socket.ts).
// Before the upgrade, refusals are HTTP errors with the envelope:
// authentication 401, Origin on proxied and scopes 403, the subprotocol
// 400, the open-connection cap 429, shutdown 503. Everything checked after
// it (the command, the sandbox state, the agent) is an `error` frame and a
// close code, which a browser can read.
import { createRoute, z } from "@hono/zod-openapi";
import { agentErrorToHttp } from "../agent/errors.ts";
import type { AgentCommandSpec } from "../agent/types.ts";
import { authOf } from "../auth/principal.ts";
import { requireScope } from "../auth/scopes.ts";
import { StreamClose } from "../commands/frames.ts";
import {
	PTY_SUBPROTOCOL,
	ptyTarget,
	runPtySocket,
} from "../commands/pty-socket.ts";
import { streamOwner } from "../commands/registry.ts";
import { type StartPlan, startPlanned } from "../commands/run.ts";
import type { ApiApp, ApiDeps } from "../deps.ts";
import { ApiError, validationError } from "../http/errors.ts";
import {
	IDEMPOTENCY_REPLAYED_HEADER,
	idempotencyKeyHeader,
} from "../http/idempotency.ts";
import {
	acceptWebSocket,
	isWebSocketUpgrade,
	offeredProtocols,
} from "../http/websocket.ts";
import {
	isTerminalStatus,
	publicCommandId,
	toCommandResource,
} from "../map/command.ts";
import { resolveSandboxRef } from "../map/sandbox.ts";
import {
	ERROR_RESPONSES,
	errorResponse,
	jsonBody,
	jsonResponse,
} from "../openapi/registry.ts";
import { CommandParams, CommandSchema } from "../schemas/command.ts";
import { SandboxParams } from "../schemas/common.ts";
import {
	type CreatePtyBody,
	CreatePtyRequest,
	PTY_DEFAULT_COLS,
	PTY_DEFAULT_ROWS,
	PTY_DEFAULT_TERM,
	PtyConnectQuery,
	ResizePtyRequest,
} from "../schemas/pty.ts";

const TAGS = ["ptys"];

/** `command: null`: the user's login shell, started through `bash -lc`. */
// biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion, not a template
export const PTY_LOGIN_SHELL = 'exec "${SHELL:-/bin/bash}" -l';

const IdempotencyHeaders = z.object({
	"Idempotency-Key": z
		.string()
		.optional()
		.openapi({
			description:
				"1-255 printable ASCII characters; a repeat with the same key and body returns the " +
				"same PTY instead of starting another one (24 h)",
		}),
});

const notFound404 = errorResponse(
	"`not_found`: no such sandbox or PTY (another sandbox's command and non-PTY commands too)",
);

const createPtyRoute = createRoute({
	method: "post",
	path: "/v1/sandboxes/{sandbox}/ptys",
	operationId: "ptys.create",
	summary: "Open a terminal",
	description:
		"Starts a PTY command in a ready sandbox (a creating or starting one is awaited up to " +
		"60 s): the user's login shell, or `command` run by `bash -lc` in the terminal. Answers " +
		"201 Command (mode `pty`, one output stream `pty`). Connect with GET .../connect " +
		"(WebSocket), or read it with GET .../commands/{command}/stream?ptyOffset= and write " +
		"with POST .../commands/{command}/input. A PTY with no client connected is closed by " +
		"the agent after 10 min (reason pty_idle). With an Idempotency-Key a repeat returns the " +
		"same command with 200 and `Idempotency-Replayed: true`. Needs the agent capability " +
		"process.pty.",
	tags: TAGS,
	middleware: [requireScope("commands:exec")] as const,
	request: {
		params: SandboxParams,
		headers: IdempotencyHeaders,
		body: jsonBody(CreatePtyRequest, "The terminal"),
	},
	responses: {
		200: {
			...jsonResponse(CommandSchema, "Repeat with the same Idempotency-Key"),
			headers: {
				"Sbx-Command-Id": {
					description: "Id (`cmd_...`) of the command",
					schema: { type: "string" as const },
				},
				"Idempotency-Replayed": {
					description: "`true`: an earlier request with this key started it",
					schema: { type: "string" as const, enum: ["true"] },
				},
			},
		},
		201: {
			...jsonResponse(CommandSchema, "The started PTY command"),
			headers: {
				"Sbx-Command-Id": {
					description: "Id (`cmd_...`) of the command",
					schema: { type: "string" as const },
				},
			},
		},
		404: notFound404,
		409: errorResponse(
			"`sandbox_not_ready`, `sandbox_starting` (retryable), `agent_outdated` " +
				"(details.capability process.pty), `idempotency_key_reused` or `invalid_state`",
		),
		503: errorResponse(
			"`agent_unavailable`: retryable with an Idempotency-Key; without one " +
				"`details.outcome: unknown` (see `details.commandId`)",
		),
		...ERROR_RESPONSES,
	},
});

const resizePtyRoute = createRoute({
	method: "post",
	path: "/v1/sandboxes/{sandbox}/ptys/{command}/resize",
	operationId: "ptys.resize",
	summary: "Resize a terminal",
	description:
		"Sets the window size of a PTY (the process gets SIGWINCH). The same as the `resize` " +
		"control frame of the WebSocket. Idempotent.",
	tags: TAGS,
	middleware: [requireScope("commands:exec")] as const,
	request: {
		params: CommandParams,
		body: jsonBody(ResizePtyRequest, "The size"),
	},
	responses: {
		204: { description: "Resized" },
		404: notFound404,
		409: errorResponse("`command_exited` or `sandbox_not_ready`"),
		...ERROR_RESPONSES,
	},
});

const connectPtyRoute = createRoute({
	method: "get",
	path: "/v1/sandboxes/{sandbox}/ptys/{command}/connect",
	operationId: "ptys.connect",
	summary: "Connect to a terminal (WebSocket)",
	description:
		"WebSocket upgrade with the subprotocol `sbx.pty.v1` (required). Server → client: " +
		"binary frames are consecutive PTY output bytes; text frames are JSON: " +
		'`{"type":"attached","offset":N}` first, `{"type":"truncated","availableFrom":N}`, ' +
		'`{"type":"exit",...}` (as in NDJSON), `{"type":"error","code","message","retryable",' +
		'"details","requestId"}`, `{"type":"reconnect","offset":N,"reason"}`. The client counts ' +
		"the offset itself: `attached.offset` (or `availableFrom` after truncated) plus the bytes " +
		"received. Client → server: binary frames are input (a key typed while the socket drops " +
		'may be lost, never applied twice); text `{"type":"resize","cols":N,"rows":N}`. Close ' +
		"codes: 1000 after exit; 1012 server shutdown (after `reconnect`); 4401 unauthorized; " +
		"4403 forbidden; 4404 no such PTY; 4409 sandbox not ready; 4503 agent unavailable " +
		"(reconnect later); 1008 malformed control frame. Reconnect with `offset` = your count; " +
		"`tailBytes` for scrollback. Pings every 15 s. Authentication as for other requests; " +
		"in the browser (dashboard origin) the session, with `Origin` checked and `?team=` " +
		"instead of the Sbx-Team header.",
	tags: TAGS,
	middleware: [requireScope("commands:exec")] as const,
	request: { params: CommandParams, query: PtyConnectQuery },
	responses: {
		101: {
			description:
				"Switching Protocols: the WebSocket with the subprotocol sbx.pty.v1",
		},
		400: errorResponse(
			"`validation`: the subprotocol sbx.pty.v1 was not offered, or a bad query",
		),
		426: errorResponse("`upgrade_required`: not a WebSocket upgrade"),
		429: errorResponse(
			"`rate_limited`: too many open streams and terminals of this key or user",
		),
		...ERROR_RESPONSES,
	},
	"x-sbx-websocket": { subprotocol: PTY_SUBPROTOCOL },
});

function ptyPlan(b: CreatePtyBody): StartPlan {
	const shell = b.command ?? PTY_LOGIN_SHELL;
	const cols = b.cols ?? PTY_DEFAULT_COLS;
	const rows = b.rows ?? PTY_DEFAULT_ROWS;
	const agent: AgentCommandSpec = {
		shell,
		cwd: b.cwd ?? "",
		env: b.env ?? {},
		user: b.user ?? "user",
		pty: { cols, rows, term: b.term ?? PTY_DEFAULT_TERM },
		stdin: false,
		timeoutMs: 0,
		tags: {},
	};
	return {
		capabilities: ["process.v1", "process.pty"],
		core: {
			cmd: shell,
			argv: null,
			cwd: b.cwd ?? null,
			env: b.env ?? {},
			mode: "pty",
			timeoutSeconds: null,
			user: b.user ?? "user",
			tags: {},
		},
		agent,
		// Wrapped: the same key and body on POST .../commands is another request.
		hashBody: { pty: b },
	};
}

export function registerPtyRoutes(app: ApiApp, deps: ApiDeps): void {
	app.openapi(createPtyRoute, async (c) => {
		const auth = authOf(c);
		const body = c.req.valid("json");
		const { sandbox } = c.req.valid("param");
		const idemKey = idempotencyKeyHeader(c);
		const r = await startPlanned(
			deps,
			auth,
			resolveSandboxRef(sandbox),
			ptyPlan(body),
			idemKey,
		);
		const headers: Record<string, string> = {
			"Sbx-Command-Id": publicCommandId(r.command.id),
		};
		if (r.replayed) headers[IDEMPOTENCY_REPLAYED_HEADER] = "true";
		return c.json(
			toCommandResource(r.command, r.info),
			r.replayed ? 200 : 201,
			headers,
		);
	});

	app.openapi(resizePtyRoute, async (c) => {
		const p = authOf(c).principal;
		const params = c.req.valid("param");
		const b = c.req.valid("json");
		const { command, machineId } = await ptyTarget(deps, p, params);
		if (isTerminalStatus(command.status)) {
			throw new ApiError(409, "command_exited", "the terminal has exited");
		}
		try {
			await deps.agent.update(machineId, {
				commandId: command.id,
				cols: b.cols,
				rows: b.rows,
			});
		} catch (e) {
			// command_exited when the row lags behind the agent: 409.
			throw agentErrorToHttp(e);
		}
		return c.body(null, 204);
	});

	app.openapi(connectPtyRoute, async (c) => {
		const auth = authOf(c);
		const params = c.req.valid("param");
		const q = c.req.valid("query");
		if (!isWebSocketUpgrade(c)) {
			throw new ApiError(
				426,
				"upgrade_required",
				`connect with a WebSocket (subprotocol ${PTY_SUBPROTOCOL}); without one use ` +
					"GET .../commands/{command}/stream and POST .../input",
				{ headers: { Upgrade: "websocket" } },
			);
		}
		if (!offeredProtocols(c).includes(PTY_SUBPROTOCOL)) {
			throw validationError([
				{
					path: "header.sec-websocket-protocol",
					message: `must offer the subprotocol ${PTY_SUBPROTOCOL}`,
				},
			]);
		}
		// The cap and shutdown refuse before the upgrade (429, 503).
		const close = new AbortController();
		const unregister = deps.streams.register(streamOwner(auth), (f) =>
			close.abort(new StreamClose(f)),
		);
		const requestId = c.var.requestId;
		return acceptWebSocket(c, {
			protocol: PTY_SUBPROTOCOL,
			open(ws) {
				void runPtySocket(deps, ws, {
					auth,
					sandbox: params.sandbox,
					command: params.command,
					...(q.offset === undefined ? {} : { offset: q.offset }),
					...(q.tailBytes === undefined ? {} : { tailBytes: q.tailBytes }),
					requestId,
					closed: close.signal,
					unregister,
				});
			},
			cancel: unregister,
		}) as never; // the 101 is completed by the server (http/websocket.ts)
	});
}
