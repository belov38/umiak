import {
	COMMAND_EXIT_REASONS,
	type CommandExitReason,
	type CommandStatus,
	storableOutputTruncated,
} from "../rows.ts";

// Agent event names (decision 13). The machine-events handler works with the
// S6 §10.2 set; S3 §16 names are mapped here. Payloads arrive as decoded JSON
// (protojson lowerCamelCase or proto snake_case; both are accepted).
// Unknown types and malformed payloads give null: the handler marks such
// events processed and ignores them.

export const AGENT_PHASES = ["pool_ready", "ready", "secrets_missing"] as const;
export type AgentPhase = (typeof AGENT_PHASES)[number];

export type TerminalCommandStatus = Exclude<
	CommandStatus,
	"starting" | "running"
>;

export type AgentEvent =
	/** S6 `phase{phase}`; S3 `readiness.changed` secrets/pending and identity/ready. */
	| { kind: "phase"; phase: AgentPhase }
	/** Any other S3 `readiness.changed` (kept for logs; no S6 reaction). */
	| { kind: "readiness"; phase: string; state: string; error: string | null }
	| {
			kind: "command_exited";
			commandId: string;
			status: TerminalCommandStatus;
			exitCode: number | null;
			signal: string | null;
			/** S3 `ExitReason` in lower case; null when unknown. */
			reason: CommandExitReason | null;
			/** "disk_full" when the agent dropped output; else null. */
			outputTruncated: string | null;
			stdoutBytes: number | null;
			stderrBytes: number | null;
	  }
	| { kind: "pty_closed"; commandId: string; reason: CommandExitReason | null }
	/** S3 `output.truncated`: the agent dropped output of the command. */
	| { kind: "output_truncated"; commandId: string; reason: string }
	| {
			kind: "activity";
			runningCommands: number;
			openPtys: number;
			tcpStreams: number;
	  }
	| { kind: "ports_changed"; listening: unknown[] }
	/** S6 `quiesce.watchdog_thawed`; S3 `quiesce.auto_thawed`. */
	| { kind: "quiesce_watchdog_thawed" }
	/** S3 `identity.reset`. */
	| { kind: "identity_reset"; machineId: string | null }
	/** S3 `claim.applied`. */
	| { kind: "claim_applied"; sandboxId: string | null };

export type AgentEventKind = AgentEvent["kind"];

const TERMINAL: readonly TerminalCommandStatus[] = [
	"exited",
	"killed",
	"timed_out",
	"lost",
	"failed_to_start",
];

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `camelCase` field, else its `snake_case` form. */
function field(p: Obj, camel: string): unknown {
	if (p[camel] !== undefined) return p[camel];
	return p[camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)];
}

function str(v: unknown): string | null {
	return typeof v === "string" && v !== "" ? v : null;
}

/** Integer from a number or a decimal string (protojson int64). */
function int(v: unknown): number | null {
	if (typeof v === "number" && Number.isSafeInteger(v)) return v;
	if (typeof v === "string" && /^-?[0-9]+$/.test(v)) {
		const n = Number(v);
		return Number.isSafeInteger(n) ? n : null;
	}
	return null;
}

function count(v: unknown): number | null {
	const n = int(v);
	return n !== null && n >= 0 ? n : null;
}

/** Lowercases an enum value and drops a protobuf type prefix (`COMMAND_STATUS_EXITED`). */
function enumValue(v: unknown, known: readonly string[]): string | null {
	if (typeof v !== "string") return null;
	const s = v.toLowerCase();
	if (known.includes(s)) return s;
	return known.find((k) => s.endsWith(`_${k}`)) ?? null;
}

const READINESS_STATES = ["pending", "ready", "failed", "disabled"];

function readiness(p: Obj): AgentEvent | null {
	const phase = str(p.phase);
	if (phase === null) return null;
	const state = enumValue(p.state, READINESS_STATES) ?? str(p.state);
	if ((AGENT_PHASES as readonly string[]).includes(phase)) {
		return state === null || state === "ready"
			? { kind: "phase", phase: phase as AgentPhase }
			: null;
	}
	if (state === null) return null;
	// S3 §8.5: after a boot `secrets` is pending until UpdateSecrets.
	if (phase === "secrets" && state === "pending") {
		return { kind: "phase", phase: "secrets_missing" };
	}
	// S3 §7: the identity is applied, so the machine can be claimed.
	if (phase === "identity" && state === "ready") {
		return { kind: "phase", phase: "pool_ready" };
	}
	return { kind: "readiness", phase, state, error: str(p.error) };
}

/** S3 `ExitReason` values that decide the command status (as attach does). */
const STATUS_BY_REASON: Record<string, TerminalCommandStatus> = {
	timeout: "timed_out",
	start_failed: "failed_to_start",
};

function exitReason(p: Obj): CommandExitReason | null {
	return enumValue(
		field(p, "reason"),
		COMMAND_EXIT_REASONS,
	) as CommandExitReason | null;
}

function commandExited(p: Obj): AgentEvent | null {
	const commandId = str(field(p, "commandId"));
	if (commandId === null) return null;
	const exitCode = int(field(p, "code") ?? field(p, "exitCode"));
	const signal = str(field(p, "signal"));
	const reason = exitReason(p);
	let status =
		(reason === null ? undefined : STATUS_BY_REASON[reason]) ??
		(enumValue(field(p, "status"), TERMINAL) as TerminalCommandStatus | null);
	if (status === null) {
		if (exitCode !== null) status = "exited";
		else if (signal !== null) status = "killed";
		else return null;
	}
	// A PTY command has the one stream `pty`, kept in stdout_bytes.
	const ptyEnd = count(field(p, "ptyEnd"));
	const pty = ptyEnd !== null && ptyEnd > 0;
	return {
		kind: "command_exited",
		commandId,
		status,
		exitCode,
		signal,
		reason,
		outputTruncated: storableOutputTruncated(field(p, "outputTruncated")),
		stdoutBytes: pty ? ptyEnd : count(field(p, "stdoutEnd")),
		stderrBytes: pty ? 0 : count(field(p, "stderrEnd")),
	};
}

/** Maps an agent event to the S6 vocabulary, or null if S6 has no use for it. */
export function normalizeAgentEvent(e: {
	type: string;
	payload: unknown;
}): AgentEvent | null {
	const p = e.payload;
	if (!isObj(p)) return null;
	switch (e.type) {
		case "phase": {
			const phase = str(p.phase);
			return phase !== null &&
				(AGENT_PHASES as readonly string[]).includes(phase)
				? { kind: "phase", phase: phase as AgentPhase }
				: null;
		}
		case "readiness.changed":
			return readiness(p);
		case "command.exited":
			return commandExited(p);
		case "pty.closed": {
			const commandId = str(field(p, "commandId"));
			return commandId === null
				? null
				: { kind: "pty_closed", commandId, reason: exitReason(p) };
		}
		case "output.truncated": {
			const commandId = str(field(p, "commandId"));
			const reason = storableOutputTruncated(p.reason);
			return commandId === null || reason === null
				? null
				: { kind: "output_truncated", commandId, reason };
		}
		case "activity": {
			const runningCommands = count(field(p, "runningCommands"));
			const openPtys = count(field(p, "openPtys"));
			const tcpStreams = count(field(p, "tcpStreams"));
			if (
				runningCommands === null ||
				openPtys === null ||
				tcpStreams === null
			) {
				return null;
			}
			return { kind: "activity", runningCommands, openPtys, tcpStreams };
		}
		case "ports.changed": {
			const listening = p.listening ?? p.ports ?? [];
			return Array.isArray(listening)
				? { kind: "ports_changed", listening }
				: null;
		}
		case "quiesce.watchdog_thawed":
		case "quiesce.auto_thawed":
			return { kind: "quiesce_watchdog_thawed" };
		case "identity.reset":
			return { kind: "identity_reset", machineId: str(field(p, "machineId")) };
		case "claim.applied":
			return { kind: "claim_applied", sandboxId: str(field(p, "sandboxId")) };
		default:
			return null;
	}
}
