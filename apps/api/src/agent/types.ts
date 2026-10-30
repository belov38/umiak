// The guest agent as seen by the api (S3 §9–§13). Shapes mirror
// proto/sbx/agent/v1 (Process, Filesystem, System) in plain TS: camelCase
// fields, lower-case enum values, offsets and sizes as `number`. Production
// uses ConnectAgentApi (connect.ts, over AgentClient); tests use FakeAgent.
import type { AgentFetchInit } from "@sbx/agent-client";

/** Capability strings of `Control/Info` (S3 §13). */
export const AGENT_CAPABILITIES = [
	"process.v1",
	"process.pty",
	"process.stdin",
	"files.v1",
	"files.upload.v1",
	"files.archive.v1",
	"system.claim.v1",
	"system.quiesce.v1",
	"system.update.v1",
	"system.ports.v1",
	"system.metrics.v1",
	"system.activity.v1",
] as const;

// --- Process ---

export type AgentStream = "stdout" | "stderr" | "pty";
export type AgentCommandState = "starting" | "running" | "exited";
export type AgentExitStatus = "exited" | "killed" | "lost";
/** `ExitReason` of S3 in lower case. */
export type AgentExitReason =
	| "none"
	| "signal"
	| "timeout"
	| "oom"
	| "pty_idle"
	| "reboot"
	| "shim_lost"
	| "start_failed";

export interface AgentPtySpec {
	cols: number;
	rows: number;
	/** Default `xterm-256color`. */
	term: string;
}

/** `CommandSpec`: exactly one of `shell` (run by `bash -lc`) or `argv`. */
export interface AgentCommandSpec {
	shell?: string;
	argv?: string[];
	/** Relative paths resolve against the user's home; "" is the home. */
	cwd: string;
	/** Never written to disk by the agent; not returned by `get`. */
	env: Record<string, string>;
	user: string;
	/** Set: a PTY command with the single stream `pty`. */
	pty?: AgentPtySpec;
	/** Keep stdin open for `sendInput` (non-PTY). */
	stdin: boolean;
	/** 0 = no timeout. */
	timeoutMs: number;
	tags: Record<string, string>;
}

export interface AgentExitInfo {
	status: AgentExitStatus;
	/** 128 + signal number when killed; 127 on start_failed. */
	code: number;
	/** Signal name such as `SIGTERM`; null when none. */
	signal: string | null;
	/** Null when the agent does not say (proto UNSPECIFIED). */
	reason: AgentExitReason | null;
}

export interface AgentStreamInfo {
	/**
	 * Bytes in the stream file. On Linux leftovers of an exited command may
	 * keep writing past `end` (S3 §10): use `streamSize` for offsets.
	 */
	size: number;
	/** Oldest offset still retained. */
	availableFrom: number;
	/** Final size once the stream is closed. */
	end: number | null;
}

/**
 * The size of a stream as the api serves it: `size`, capped by `end` once
 * the command has exited. Bytes past the end (leftovers, S3 §10) are never
 * sent by attach, so every offset, tail and size derives from this.
 */
export function streamSize(s: AgentStreamInfo): number {
	return s.end === null ? s.size : Math.min(s.size, s.end);
}

export interface AgentCommandInfo {
	commandId: string;
	state: AgentCommandState;
	pid: number | null;
	exit: AgentExitInfo | null;
	/** Only the streams the command has: stdout+stderr, or pty. */
	streams: Partial<Record<AgentStream, AgentStreamInfo>>;
	startedAt: Date | null;
	endedAt: Date | null;
	/**
	 * `output_truncated`: "disk_full" when the shim dropped output because
	 * the disk was full (stream ends cover only the bytes written); null
	 * otherwise (proto "").
	 */
	outputTruncated: string | null;
}

export interface AgentStartRequest {
	commandId: string;
	spec: AgentCommandSpec;
}

export interface AgentStartResult {
	command: AgentCommandInfo;
	/** False for a repeated `commandId` with the same spec. */
	created: boolean;
}

export interface AgentAttachRequest {
	commandId: string;
	stdoutOffset: number;
	stderrOffset: number;
	ptyOffset: number;
	/** Start each stream at max(availableFrom, size − tailBytes). */
	tailBytes?: number;
	/** Default true; false sends what exists and closes the stream. */
	follow?: boolean;
}

export type AgentAttachEvent =
	| { type: "data"; stream: AgentStream; offset: number; data: Uint8Array }
	| { type: "truncated"; stream: AgentStream; availableFrom: number }
	| { type: "heartbeat" }
	| {
			type: "exit";
			status: AgentExitStatus;
			code: number;
			signal: string | null;
			/** Null when the agent does not say (proto UNSPECIFIED). */
			reason: AgentExitReason | null;
			stdoutEnd: number;
			stderrEnd: number;
			ptyEnd: number;
			endedAt: Date | null;
			/** See AgentCommandInfo.outputTruncated. */
			outputTruncated: string | null;
	  }
	| { type: "started"; command: AgentCommandInfo };

export interface AgentSendInputRequest {
	commandId: string;
	/** One writer; `seq` orders its chunks and repeats are dropped. */
	inputSessionId: string;
	seq: number;
	data: Uint8Array;
	closeStdin: boolean;
}

export interface AgentUpdateRequest {
	commandId: string;
	cols: number;
	rows: number;
}

export interface AgentSignalRequest {
	commandId: string;
	/** `SIGINT`, `INT` or a decimal number. */
	signal: string;
}

export interface AgentKillRequest {
	commandId: string;
	/** SIGTERM, then SIGKILL after this (default 10 000). */
	graceMs?: number;
}

// --- Filesystem ---

export type AgentFileType = "file" | "dir" | "symlink" | "other";

export interface AgentFileInfo {
	path: string;
	name: string;
	type: AgentFileType;
	size: number;
	/** Permission bits with setuid, setgid and sticky (0o7777). */
	mode: number;
	owner: string;
	group: string;
	uid: number;
	gid: number;
	mtime: Date | null;
	/** Set for symlinks only; "" otherwise. */
	symlinkTarget: string;
}

export interface AgentStatRequest {
	path: string;
	user?: string;
	noFollow?: boolean;
}

export interface AgentListRequest {
	path: string;
	user?: string;
	/** 1–8, default 1. */
	depth?: number;
	/** Default true. */
	includeHidden?: boolean;
	/** ≤ 10 000, default 1000. */
	pageSize?: number;
	/** The last path of the previous page. */
	pageToken?: string;
}

export interface AgentListResult {
	entries: AgentFileInfo[];
	/** "" on the last page. */
	nextPageToken: string;
}

/** Mutating Filesystem calls carry `requestId` (Sbx-Request-Id, S2 §9.2). */
export interface AgentMakeDirRequest {
	path: string;
	user?: string;
	parents?: boolean;
	mode?: number;
	owner?: string;
	requestId: string;
}

export interface AgentMakeDirResult {
	info: AgentFileInfo;
	/** False when the directory already existed. */
	created: boolean;
}

export interface AgentMoveRequest {
	src: string;
	dst: string;
	user?: string;
	overwrite?: boolean;
	requestId: string;
}

export interface AgentChmodRequest {
	path: string;
	user?: string;
	mode?: number;
	owner?: string;
	group?: string;
	recursive?: boolean;
	requestId: string;
}

export interface AgentRemoveRequest {
	path: string;
	user?: string;
	recursive?: boolean;
	requestId: string;
}

// --- System ---

export interface AgentPort {
	port: number;
	addresses: string[];
	pid: number;
	process: string;
	user: string;
}

export interface AgentSecretFile {
	name: string;
	content: Uint8Array;
	mode: number;
	/** Optional symlink to the file; "" for none. */
	linkPath: string;
}

export interface AgentSecrets {
	secretEnv: Record<string, string>;
	secretFiles: AgentSecretFile[];
}

/** Readiness after a System update. */
export interface AgentReadiness {
	ready: boolean;
}

/**
 * The agent of one machine, by `machineId`. Errors: AgentUnavailableError
 * (the agent cannot be reached within the routing budget),
 * AgentOutdatedError (`requireCapability`), AgentCallError (the agent
 * answered with an error code, S3 §11.1). `agentErrorToHttp` maps them.
 */
export interface AgentApi {
	/** Capabilities the agent reported; [] while unknown. */
	capabilities(machineId: string): Promise<string[]>;
	/** Throws AgentOutdatedError or AgentUnavailableError. */
	requireCapability(
		machineId: string,
		capability: string,
		signal?: AbortSignal,
	): Promise<void>;

	/** Idempotent by `commandId` (same spec → `created: false`). */
	start(
		machineId: string,
		req: AgentStartRequest,
		opts: { requestId: string; signal?: AbortSignal },
	): Promise<AgentStartResult>;
	/**
	 * Output from the offsets (S2 §9.1, S3 §10): `truncated` when an offset
	 * was evicted, `heartbeat` after silence, `exit` only after all output.
	 */
	attach(
		machineId: string,
		req: AgentAttachRequest,
		signal: AbortSignal,
	): AsyncIterable<AgentAttachEvent>;
	sendInput(
		machineId: string,
		req: AgentSendInputRequest,
		signal?: AbortSignal,
	): Promise<{ applied: boolean }>;
	update(machineId: string, req: AgentUpdateRequest): Promise<void>;
	signal(machineId: string, req: AgentSignalRequest): Promise<AgentCommandInfo>;
	kill(machineId: string, req: AgentKillRequest): Promise<AgentCommandInfo>;
	get(machineId: string, commandId: string): Promise<AgentCommandInfo>;

	stat(machineId: string, req: AgentStatRequest): Promise<AgentFileInfo>;
	list(machineId: string, req: AgentListRequest): Promise<AgentListResult>;
	makeDir(
		machineId: string,
		req: AgentMakeDirRequest,
	): Promise<AgentMakeDirResult>;
	move(machineId: string, req: AgentMoveRequest): Promise<AgentFileInfo>;
	chmod(machineId: string, req: AgentChmodRequest): Promise<AgentFileInfo>;
	remove(
		machineId: string,
		req: AgentRemoveRequest,
	): Promise<{ existed: boolean }>;

	listPorts(machineId: string): Promise<AgentPort[]>;
	updateEnv(
		machineId: string,
		env: Record<string, string>,
		requestId: string,
	): Promise<AgentReadiness>;
	updateSecrets(
		machineId: string,
		secrets: AgentSecrets,
		requestId: string,
	): Promise<AgentReadiness>;

	/**
	 * The agent's HTTP `/files*` (S3 §11.2): `path` is "" or starts with
	 * "?" or "/" and is appended to `/files` (`?path=`, `/uploads/{id}`,
	 * `/archive?path=`). Query names are the agent's (snake_case). The
	 * response is the agent's, streamed; read error bodies with
	 * `agentHttpError`.
	 */
	files(
		machineId: string,
		path: string,
		init: AgentFetchInit,
	): Promise<Response>;
}
