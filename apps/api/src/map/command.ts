// Command (core) -> Command resource (S7 §9.6). Live fields (pid, stream
// sizes, the exit, outputTruncated) come from the agent's `Process/Get`
// while the sandbox is ready; otherwise from the row (`stdout_bytes`/
// `stderr_bytes`, a PTY command keeps its one stream in `stdout_bytes`;
// `reason`, `output_truncated`). An ended row's stored reason wins over the
// agent's.
import { decodeUlid, encodeUlid, encodeUuid } from "@umiak/auth";
import {
	type Command,
	type CommandStatus,
	storableOutputTruncated,
} from "@umiak/core";
import {
	type AgentCommandInfo,
	type AgentStreamInfo,
	streamSize,
} from "../agent/types.ts";
import { commandStatus } from "../commands/attach.ts";
import { notFoundError } from "../http/errors.ts";
import type { CommandResource } from "../schemas/command.ts";
import { iso, isoOrNull } from "./operation.ts";

/** `cmd_...` → the command id of core; anything else is 404. */
export function resolveCommandRef(ref: string): string {
	const id = decodeUlid("command", ref);
	if (id === null) throw notFoundError("command");
	return id;
}

export function publicCommandId(id: string): string {
	return encodeUlid("command", id);
}

const TERMINAL: readonly CommandStatus[] = [
	"exited",
	"killed",
	"timed_out",
	"lost",
	"failed_to_start",
];

export function isTerminalStatus(s: CommandStatus): boolean {
	return TERMINAL.includes(s);
}

/**
 * The reason when none is known (a row from before migration 0304, or an
 * agent that gave none): derived from the status; null for `lost`, whose
 * cause the status does not tell.
 */
function reasonOf(status: CommandStatus): string | null {
	switch (status) {
		case "exited":
			return "none";
		case "killed":
			return "signal";
		case "timed_out":
			return "timeout";
		case "failed_to_start":
			return "start_failed";
		default:
			return null;
	}
}

// sizeBytes stops at the end of an exited command (leftovers, S3 §10).
const streamInfo = (s: AgentStreamInfo) => ({
	sizeBytes: streamSize(s),
	availableFromBytes: Math.min(s.availableFrom, streamSize(s)),
	endBytes: s.end,
});

const storedStream = (bytes: number) => ({
	sizeBytes: bytes,
	availableFromBytes: null,
	endBytes: bytes,
});

function storedStreams(c: Command): CommandResource["streams"] {
	if (c.stdoutBytes === null) return null;
	if (c.mode === "pty") return { pty: storedStream(c.stdoutBytes) };
	return {
		stdout: storedStream(c.stdoutBytes),
		stderr: storedStream(c.stderrBytes ?? 0),
	};
}

export function toCommandResource(
	c: Command,
	live: AgentCommandInfo | null = null,
): CommandResource {
	let status: CommandStatus = c.status;
	let exitCode = c.exitCode;
	let signal = c.signal;
	let reason: string | null = c.reason;
	let endedAt = c.endedAt;
	const exit = live?.exit ?? null;
	if (exit !== null) {
		if (!isTerminalStatus(status)) {
			status = commandStatus(exit.status, exit.reason);
			exitCode = exit.code;
			signal = exit.signal;
			endedAt = live?.endedAt ?? endedAt;
			reason = exit.reason;
		} else {
			// Ended: the stored reason stays (the platform may know better,
			// e.g. a reboot); the agent's only fills a gap.
			reason = c.reason ?? exit.reason;
		}
	}
	reason ??= reasonOf(status);
	let streams: CommandResource["streams"] = storedStreams(c);
	if (live !== null) {
		streams = {};
		for (const [name, s] of Object.entries(live.streams)) {
			if (s !== undefined) {
				streams[name as keyof typeof streams] = streamInfo(s);
			}
		}
	}
	return {
		id: publicCommandId(c.id),
		sandboxId: encodeUuid("sandbox", c.sandboxId),
		mode: c.mode,
		command: c.argv === null ? c.cmd : null,
		argv: c.argv,
		cwd: c.cwd,
		user: c.user,
		envKeys: c.envKeys,
		tags: c.tags,
		timeoutSeconds: c.timeoutSeconds,
		status,
		exitCode,
		signal,
		reason,
		pid: live?.pid ?? c.pid,
		outputTruncated:
			storableOutputTruncated(live?.outputTruncated) ?? c.outputTruncated,
		streams,
		createdBy: c.createdBy === null ? null : encodeUuid("user", c.createdBy),
		createdByKey:
			c.createdByKey === null ? null : encodeUuid("apiKey", c.createdByKey),
		createdAt: iso(c.createdAt),
		startedAt: isoOrNull(live?.startedAt ?? c.startedAt),
		endedAt: isoOrNull(endedAt),
	};
}
