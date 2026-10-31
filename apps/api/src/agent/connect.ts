// AgentApi over the guest agent's Connect API (sbx.agent.v1 Process,
// Filesystem and System, S3 §9–§13). Every RPC goes through
// `AgentClient.transport(machineId)`: the client finds the gateway instance
// that owns the machine's tunnel (S2 §8.4), waits for the agent up to its
// budget and follows 421/503 answers. `/files*` goes through
// `AgentClient.fetch`, capabilities come from `tunnel.tunnel_sessions`.
//
// The proto ↔ AgentApi rules are in apps/api/README.md ("Wiring S3"):
// `*_UNSPECIFIED` is not a value, proto zeros are null, uint64 is a number
// only up to Number.MAX_SAFE_INTEGER, the streams of CommandInfo become an
// object by name, mutations carry Sbx-Request-Id. A reply that breaks them
// is AgentCallError("bad_response") (502 agent_error).
//
// `attach` is one Process/Attach stream; the caller resumes it with
// resumableAttach (commands/attach.ts). Without a client (no gateway token
// configured) every call fails with AgentUnavailableError.
import {
	type DescMessage,
	fromJson,
	type JsonObject,
	type Message,
	type MessageInitShape,
	toJson,
} from "@bufbuild/protobuf";
import { type Timestamp, timestampDate } from "@bufbuild/protobuf/wkt";
import {
	type CallOptions,
	Code,
	type Client as ConnectClient,
	ConnectError,
	createClient,
} from "@connectrpc/connect";
import {
	type AgentClient,
	type AgentFetchInit,
	AgentOutdatedError,
	AgentUnavailableError,
	HEADER_REQUEST_ID,
	isConnectionError,
} from "@sbx/agent-client";
import { ErrorDetailSchema } from "@sbx/proto";
import {
	type AttachResponse,
	type CommandInfo,
	type CommandSpecSchema,
	CommandState,
	Desktop,
	DesktopActionFailureSchema,
	type ExitEvent,
	type ExitInfo,
	ExitReason,
	ExitStatus,
	type FileInfo,
	Filesystem,
	FileType,
	Process,
	Stream,
	System,
} from "@sbx/proto/agent/v1";
import type pg from "pg";
import { AgentCallError } from "./errors.ts";
import type {
	AgentApi,
	AgentAttachEvent,
	AgentAttachRequest,
	AgentChmodRequest,
	AgentCommandInfo,
	AgentCommandSpec,
	AgentCommandState,
	AgentExitInfo,
	AgentExitReason,
	AgentExitStatus,
	AgentFileInfo,
	AgentFileType,
	AgentKillRequest,
	AgentListRequest,
	AgentListResult,
	AgentMakeDirRequest,
	AgentMakeDirResult,
	AgentMoveRequest,
	AgentPort,
	AgentReadiness,
	AgentRemoveRequest,
	AgentSecrets,
	AgentSendInputRequest,
	AgentSignalRequest,
	AgentStartRequest,
	AgentStartResult,
	AgentStatRequest,
	AgentStream,
	AgentUpdateRequest,
	DesktopMethod,
} from "./types.ts";

/** What ConnectAgentApi needs of AgentClient (tests pass a stand-in). */
export type AgentClientLike = Pick<
	AgentClient,
	"transport" | "fetch" | "requireCapability"
>;

export interface ConnectAgentApiOptions {
	/**
	 * Deadline of one unary call, including the client's wait for the
	 * machine's route. Default 45 s.
	 */
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 45_000;

// --- proto → AgentApi ---

/** A reply that breaks the proto contract: 502 agent_error. */
function badResponse(what: string): AgentCallError {
	return new AgentCallError("bad_response", `the agent answered with ${what}`);
}

/** uint64 → number, never truncated. */
function safe(v: bigint, what: string): number {
	if (v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw badResponse(`${what} ${v} beyond 2^53 - 1`);
	}
	return Number(v);
}

function date(t: Timestamp | undefined): Date | null {
	return t === undefined ? null : timestampDate(t);
}

/** "" → null. */
function text(s: string): string | null {
	return s === "" ? null : s;
}

const STREAMS: Partial<Record<Stream, AgentStream>> = {
	[Stream.STDOUT]: "stdout",
	[Stream.STDERR]: "stderr",
	[Stream.PTY]: "pty",
};

const STATES: Partial<Record<CommandState, AgentCommandState>> = {
	[CommandState.STARTING]: "starting",
	[CommandState.RUNNING]: "running",
	[CommandState.EXITED]: "exited",
};

const EXIT_STATUSES: Partial<Record<ExitStatus, AgentExitStatus>> = {
	[ExitStatus.EXITED]: "exited",
	[ExitStatus.KILLED]: "killed",
	[ExitStatus.LOST]: "lost",
};

// UNSPECIFIED (an agent that does not refine the status) is null: unknown.
const EXIT_REASONS: Partial<Record<ExitReason, AgentExitReason>> = {
	[ExitReason.NONE]: "none",
	[ExitReason.SIGNAL]: "signal",
	[ExitReason.TIMEOUT]: "timeout",
	[ExitReason.OOM]: "oom",
	[ExitReason.PTY_IDLE]: "pty_idle",
	[ExitReason.REBOOT]: "reboot",
	[ExitReason.SHIM_LOST]: "shim_lost",
	[ExitReason.START_FAILED]: "start_failed",
};

// UNSPECIFIED and unknown types are "other": the agent could not tell.
const FILE_TYPES: Partial<Record<FileType, AgentFileType>> = {
	[FileType.FILE]: "file",
	[FileType.DIR]: "dir",
	[FileType.SYMLINK]: "symlink",
};

function exitStatus(s: ExitStatus): AgentExitStatus {
	const v = EXIT_STATUSES[s];
	if (v === undefined) throw badResponse(`exit status ${s}`);
	return v;
}

function exitReason(r: ExitReason): AgentExitReason | null {
	if (r === ExitReason.UNSPECIFIED) return null;
	const v = EXIT_REASONS[r];
	if (v === undefined) throw badResponse(`exit reason ${r}`);
	return v;
}

function toExit(e: ExitInfo): AgentExitInfo {
	return {
		status: exitStatus(e.status),
		code: e.code,
		signal: text(e.signal),
		reason: exitReason(e.reason),
	};
}

function toCommandInfo(c: CommandInfo | undefined): AgentCommandInfo {
	if (c === undefined) throw badResponse("no command");
	const state = STATES[c.state];
	if (state === undefined) throw badResponse(`command state ${c.state}`);
	const streams: AgentCommandInfo["streams"] = {};
	for (const s of c.streams) {
		const name = STREAMS[s.stream];
		if (name === undefined) continue;
		streams[name] = {
			size: safe(s.size, `${name} size`),
			availableFrom: safe(s.availableFrom, `${name} available_from`),
			end: s.end === undefined ? null : safe(s.end, `${name} end`),
		};
	}
	return {
		commandId: c.commandId,
		state,
		pid: c.pid === 0 ? null : c.pid,
		exit: c.exit === undefined ? null : toExit(c.exit),
		streams,
		startedAt: date(c.startedAt),
		endedAt: date(c.endedAt),
		outputTruncated: text(c.outputTruncated),
	};
}

function toExitEvent(e: ExitEvent): AgentAttachEvent {
	return {
		type: "exit",
		status: exitStatus(e.status),
		code: e.code,
		signal: text(e.signal),
		reason: exitReason(e.reason),
		stdoutEnd: safe(e.stdoutEnd, "stdout_end"),
		stderrEnd: safe(e.stderrEnd, "stderr_end"),
		ptyEnd: safe(e.ptyEnd, "pty_end"),
		endedAt: date(e.endedAt),
		outputTruncated: text(e.outputTruncated),
	};
}

/** One attach event; null without meaning here (UNSPECIFIED stream, unknown case). */
function toAttachEvent(r: AttachResponse): AgentAttachEvent | null {
	const ev = r.event;
	switch (ev.case) {
		case "data": {
			const stream = STREAMS[ev.value.stream];
			if (stream === undefined) return null;
			return {
				type: "data",
				stream,
				offset: safe(ev.value.offset, "data offset"),
				data: ev.value.data,
			};
		}
		case "truncated": {
			const stream = STREAMS[ev.value.stream];
			if (stream === undefined) return null;
			return {
				type: "truncated",
				stream,
				availableFrom: safe(ev.value.availableFrom, "available_from"),
			};
		}
		case "heartbeat":
			return { type: "heartbeat" };
		case "exit":
			return toExitEvent(ev.value);
		case "started":
			return { type: "started", command: toCommandInfo(ev.value.command) };
		default:
			return null;
	}
}

function toFileInfo(f: FileInfo | undefined): AgentFileInfo {
	if (f === undefined) throw badResponse("no file info");
	return {
		path: f.path,
		name: f.name,
		type: FILE_TYPES[f.type] ?? "other",
		size: safe(f.size, "file size"),
		mode: f.mode,
		owner: f.owner,
		group: f.group,
		uid: f.uid,
		gid: f.gid,
		mtime: date(f.mtime),
		symlinkTarget: f.symlinkTarget,
	};
}

// --- AgentApi → proto ---

function toProtoSpec(
	s: AgentCommandSpec,
): MessageInitShape<typeof CommandSpecSchema> {
	return {
		cmd:
			s.shell !== undefined
				? { case: "shell", value: s.shell }
				: { case: "argv", value: { args: s.argv ?? [] } },
		cwd: s.cwd,
		env: s.env,
		user: s.user,
		...(s.pty === undefined
			? {}
			: { pty: { cols: s.pty.cols, rows: s.pty.rows, term: s.pty.term } }),
		stdin: s.stdin,
		timeoutMs: BigInt(s.timeoutMs),
		tags: s.tags,
	};
}

// --- errors ---

/** `FailedPrecondition` → `failed_precondition`, the wire name of a Connect code. */
function codeName(code: Code): string {
	return (Code[code] ?? "unknown")
		.replace(/([a-z])([A-Z])/g, "$1_$2")
		.toLowerCase();
}

function errorDetail(e: ConnectError) {
	try {
		return e.findDetails(ErrorDetailSchema)[0];
	} catch {
		return undefined;
	}
}

/**
 * The AgentApi error of a failed call (the contract of agentErrorToHttp):
 * AgentUnavailableError, AgentOutdatedError, connection errors and Connect
 * Unavailable, Canceled and DeadlineExceeded pass unchanged (the transport
 * failed or the outcome is unknown); any other Connect error is an answer
 * of the agent: AgentCallError with the ErrorDetail code, or the Connect
 * code name without one. An answer is not always a refusal: the agent
 * sends `internal` also after Start launched the process, so callers of
 * mutations decide per code (commands/run.ts).
 */
export function toAgentError(e: unknown): unknown {
	if (!(e instanceof ConnectError)) return e;
	if (e instanceof AgentUnavailableError || e instanceof AgentOutdatedError) {
		return e;
	}
	const desktopCode = errorDetail(e)?.code;
	if (
		desktopCode &&
		/^desktop_|^streamer_|^action_failed$|^invalid_action$|^clipboard_unavailable$/.test(
			desktopCode,
		)
	) {
		let details: Record<string, unknown> = {};
		try {
			const action = e.findDetails(DesktopActionFailureSchema)[0];
			if (action && desktopCode === "invalid_action")
				details = { index: action.index, reason: action.reason };
			if (action && desktopCode === "action_failed")
				details = { index: action.index, completed: action.completed };
		} catch {
			/* Malformed optional details do not change the primary error. */
		}
		return new AgentCallError(
			desktopCode,
			e.rawMessage || desktopCode,
			details,
		);
	}
	if (isConnectionError(e)) return e;
	if (
		e.code === Code.Unavailable ||
		e.code === Code.Canceled ||
		e.code === Code.DeadlineExceeded
	) {
		return e;
	}
	const code = errorDetail(e)?.code || codeName(e.code);
	return new AgentCallError(code, e.rawMessage || code);
}

// --- the api ---

type Clients = {
	process: ConnectClient<typeof Process>;
	filesystem: ConnectClient<typeof Filesystem>;
	system: ConnectClient<typeof System>;
	desktop: ConnectClient<typeof Desktop>;
};

export class ConnectAgentApi implements AgentApi {
	readonly #client: AgentClientLike | null;
	readonly #pool: Pick<pg.Pool, "query">;
	readonly #timeoutMs: number;

	/** `client` null: no gateway token, every call is agent_unavailable. */
	constructor(
		client: AgentClientLike | null,
		pool: Pick<pg.Pool, "query">,
		opts: ConnectAgentApiOptions = {},
	) {
		this.#client = client;
		this.#pool = pool;
		this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	#clients(machineId: string): Clients {
		if (this.#client === null) throw new AgentUnavailableError(machineId);
		const t = this.#client.transport(machineId);
		return {
			process: createClient(Process, t),
			filesystem: createClient(Filesystem, t),
			system: createClient(System, t),
			desktop: createClient(Desktop, t),
		};
	}

	/** Call options: the deadline, Sbx-Request-Id of a mutation, the caller's signal. */
	#opts(requestId?: string, signal?: AbortSignal): CallOptions {
		return {
			timeoutMs: this.#timeoutMs,
			...(requestId === undefined
				? {}
				: { headers: { [HEADER_REQUEST_ID]: requestId } }),
			...(signal === undefined ? {} : { signal }),
		};
	}

	/** One unary call with the errors mapped (toAgentError). */
	async #call<S extends keyof Clients, T>(
		machineId: string,
		service: S,
		fn: (c: Clients[S]) => Promise<T>,
	): Promise<T> {
		try {
			return await fn(this.#clients(machineId)[service]);
		} catch (e) {
			throw toAgentError(e);
		}
	}

	/** `tunnel.tunnel_sessions.capabilities`; [] without a session or while NULL. */
	async desktopCall(
		machineId: string,
		method: DesktopMethod,
		body: Record<string, unknown>,
		opts: { requestId?: string; signal?: AbortSignal } = {},
	): Promise<Record<string, unknown>> {
		const descriptor = Desktop.method[method];
		const response = await this.#call(machineId, "desktop", (client) => {
			const call = client[method] as unknown as (
				message: Message,
				options: CallOptions,
			) => Promise<Message>;
			return call(
				fromJson(
					descriptor.input,
					JSON.parse(JSON.stringify(body)) as JsonObject,
				),
				{
					...this.#opts(opts.requestId, opts.signal),
					...(method === "act" ? { timeoutMs: 75_000 } : {}),
				},
			);
		});
		return toJson(descriptor.output as DescMessage, response, {
			alwaysEmitImplicit: true,
		}) as Record<string, unknown>;
	}
	async capabilities(machineId: string): Promise<string[]> {
		const r = await this.#pool.query<{ capabilities: string[] | null }>(
			"SELECT capabilities FROM tunnel.tunnel_sessions WHERE machine_id = $1",
			[machineId],
		);
		return r.rows[0]?.capabilities ?? [];
	}

	async requireCapability(
		machineId: string,
		capability: string,
		signal?: AbortSignal,
	): Promise<void> {
		if (this.#client === null) throw new AgentUnavailableError(machineId);
		await this.#client.requireCapability(machineId, capability, signal);
	}

	async files(
		machineId: string,
		path: string,
		init: AgentFetchInit,
	): Promise<Response> {
		if (this.#client === null) throw new AgentUnavailableError(machineId);
		return this.#client.fetch(machineId, path, init);
	}

	// --- Process ---

	async start(
		machineId: string,
		req: AgentStartRequest,
		opts: { requestId: string; signal?: AbortSignal },
	): Promise<AgentStartResult> {
		const r = await this.#call(machineId, "process", (c) =>
			c.start(
				{ commandId: req.commandId, spec: toProtoSpec(req.spec) },
				this.#opts(opts.requestId, opts.signal),
			),
		);
		return { command: toCommandInfo(r.command), created: r.created };
	}

	async *attach(
		machineId: string,
		req: AgentAttachRequest,
		signal: AbortSignal,
	): AsyncGenerator<AgentAttachEvent> {
		try {
			const stream = this.#clients(machineId).process.attach(
				{
					commandId: req.commandId,
					stdoutOffset: BigInt(req.stdoutOffset),
					stderrOffset: BigInt(req.stderrOffset),
					ptyOffset: BigInt(req.ptyOffset),
					tailBytes: BigInt(req.tailBytes ?? 0),
					...(req.follow === undefined ? {} : { follow: req.follow }),
				},
				{ signal },
			);
			for await (const r of stream) {
				const ev = toAttachEvent(r);
				if (ev !== null) yield ev;
			}
		} catch (e) {
			throw toAgentError(e);
		}
	}

	async sendInput(
		machineId: string,
		req: AgentSendInputRequest,
		signal?: AbortSignal,
	): Promise<{ applied: boolean }> {
		const r = await this.#call(machineId, "process", (c) =>
			c.sendInput(
				{
					commandId: req.commandId,
					inputSessionId: req.inputSessionId,
					seq: BigInt(req.seq),
					data: req.data,
					closeStdin: req.closeStdin,
				},
				this.#opts(undefined, signal),
			),
		);
		return { applied: r.applied };
	}

	async update(machineId: string, req: AgentUpdateRequest): Promise<void> {
		await this.#call(machineId, "process", (c) =>
			c.update(
				{ commandId: req.commandId, cols: req.cols, rows: req.rows },
				this.#opts(),
			),
		);
	}

	async signal(
		machineId: string,
		req: AgentSignalRequest,
	): Promise<AgentCommandInfo> {
		const r = await this.#call(machineId, "process", (c) =>
			c.signal({ commandId: req.commandId, signal: req.signal }, this.#opts()),
		);
		return toCommandInfo(r.command);
	}

	async kill(
		machineId: string,
		req: AgentKillRequest,
	): Promise<AgentCommandInfo> {
		const r = await this.#call(machineId, "process", (c) =>
			c.kill(
				{
					commandId: req.commandId,
					...(req.graceMs === undefined ? {} : { graceMs: req.graceMs }),
				},
				this.#opts(),
			),
		);
		return toCommandInfo(r.command);
	}

	async get(machineId: string, commandId: string): Promise<AgentCommandInfo> {
		const r = await this.#call(machineId, "process", (c) =>
			c.get({ commandId }, this.#opts()),
		);
		return toCommandInfo(r.command);
	}

	// --- Filesystem ---

	async stat(machineId: string, req: AgentStatRequest): Promise<AgentFileInfo> {
		const r = await this.#call(machineId, "filesystem", (c) =>
			c.stat(
				{
					path: req.path,
					user: req.user ?? "",
					noFollow: req.noFollow ?? false,
				},
				this.#opts(),
			),
		);
		return toFileInfo(r.info);
	}

	async list(
		machineId: string,
		req: AgentListRequest,
	): Promise<AgentListResult> {
		const r = await this.#call(machineId, "filesystem", (c) =>
			c.list(
				{
					path: req.path,
					user: req.user ?? "",
					depth: req.depth ?? 0,
					...(req.includeHidden === undefined
						? {}
						: { includeHidden: req.includeHidden }),
					pageSize: req.pageSize ?? 0,
					pageToken: req.pageToken ?? "",
				},
				this.#opts(),
			),
		);
		return {
			entries: r.entries.map((f) => toFileInfo(f)),
			nextPageToken: r.nextPageToken,
		};
	}

	async makeDir(
		machineId: string,
		req: AgentMakeDirRequest,
	): Promise<AgentMakeDirResult> {
		const r = await this.#call(machineId, "filesystem", (c) =>
			c.makeDir(
				{
					path: req.path,
					user: req.user ?? "",
					parents: req.parents ?? false,
					...(req.mode === undefined ? {} : { mode: req.mode }),
					owner: req.owner ?? "",
				},
				this.#opts(req.requestId),
			),
		);
		return { info: toFileInfo(r.info), created: r.created };
	}

	async move(machineId: string, req: AgentMoveRequest): Promise<AgentFileInfo> {
		const r = await this.#call(machineId, "filesystem", (c) =>
			c.move(
				{
					src: req.src,
					dst: req.dst,
					user: req.user ?? "",
					overwrite: req.overwrite ?? false,
				},
				this.#opts(req.requestId),
			),
		);
		return toFileInfo(r.info);
	}

	async chmod(
		machineId: string,
		req: AgentChmodRequest,
	): Promise<AgentFileInfo> {
		const r = await this.#call(machineId, "filesystem", (c) =>
			c.chmod(
				{
					path: req.path,
					user: req.user ?? "",
					...(req.mode === undefined ? {} : { mode: req.mode }),
					owner: req.owner ?? "",
					group: req.group ?? "",
					recursive: req.recursive ?? false,
				},
				this.#opts(req.requestId),
			),
		);
		return toFileInfo(r.info);
	}

	async remove(
		machineId: string,
		req: AgentRemoveRequest,
	): Promise<{ existed: boolean }> {
		const r = await this.#call(machineId, "filesystem", (c) =>
			c.remove(
				{
					path: req.path,
					user: req.user ?? "",
					recursive: req.recursive ?? false,
				},
				this.#opts(req.requestId),
			),
		);
		return { existed: r.existed };
	}

	// --- System ---

	async listPorts(machineId: string): Promise<AgentPort[]> {
		const r = await this.#call(machineId, "system", (c) =>
			c.listPorts({}, this.#opts()),
		);
		return r.ports.map((p) => ({
			port: p.port,
			addresses: [...p.addresses],
			pid: p.pid,
			process: p.process,
			user: p.user,
		}));
	}

	async updateEnv(
		machineId: string,
		env: Record<string, string>,
		requestId: string,
	): Promise<AgentReadiness> {
		const r = await this.#call(machineId, "system", (c) =>
			c.updateEnv({ env }, this.#opts(requestId)),
		);
		return { ready: r.ready };
	}

	async updateSecrets(
		machineId: string,
		secrets: AgentSecrets,
		requestId: string,
	): Promise<AgentReadiness> {
		const r = await this.#call(machineId, "system", (c) =>
			c.updateSecrets(
				{
					secretEnv: secrets.secretEnv,
					secretFiles: secrets.secretFiles.map((f) => ({
						name: f.name,
						content: f.content,
						mode: f.mode,
						linkPath: f.linkPath,
					})),
				},
				this.#opts(requestId),
			),
		);
		return { ready: r.ready };
	}
}
