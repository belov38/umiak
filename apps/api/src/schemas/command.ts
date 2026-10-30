// Command resources and requests (S7 §9): start (sync, stream, detached),
// list, the Command resource, the NDJSON frames, output, input, kill and
// signal. Request objects are strict (unknown fields are 400 validation).
import { z } from "@hono/zod-openapi";
import { extensibleEnum } from "../openapi/registry.ts";
import {
	EnvVars,
	Labels,
	NullableTimestamp,
	PageQuery,
	SandboxParams,
	Timestamp,
} from "./common.ts";

export const COMMAND_MAX_BYTES = 256 * 1024;
export const SYNC_DEFAULT_TIMEOUT_SECONDS = 60;
export const SYNC_MAX_TIMEOUT_SECONDS = 600;
export const OUTPUT_DEFAULT_LIMIT = 1024 * 1024;
export const OUTPUT_MAX_LIMIT = 4 * 1024 * 1024;
export const KILL_DEFAULT_GRACE_MS = 10_000;
export const SIGNALS = [
	"SIGINT",
	"SIGTERM",
	"SIGKILL",
	"SIGHUP",
	"SIGUSR1",
	"SIGUSR2",
	"SIGQUIT",
] as const;

export const COMMAND_MODES = ["sync", "stream", "detached", "pty"] as const;
export const START_MODES = ["sync", "stream", "detached"] as const;
export const COMMAND_STATUSES = [
	"starting",
	"running",
	"exited",
	"killed",
	"timed_out",
	"lost",
	"failed_to_start",
] as const;
export const EXIT_STATUSES = [
	"exited",
	"killed",
	"timed_out",
	"lost",
	"failed_to_start",
] as const;
export const OUTPUT_STREAMS = ["stdout", "stderr", "pty"] as const;
const ENCODINGS = ["utf8", "base64"] as const;

export const CommandParams = SandboxParams.extend({
	command: z.string().openapi({
		param: { name: "command", in: "path" },
		description: "Command id (`cmd_...`)",
		example: "cmd_01jbx2v7d3m6c8q9w0e4r5t6y7",
	}),
});

const byteLength = (s: string) => Buffer.byteLength(s, "utf8");

export const StartCommandRequest = z
	.strictObject({
		command: z
			.string()
			.min(1)
			.refine((s) => byteLength(s) <= COMMAND_MAX_BYTES, {
				message: `must be at most ${COMMAND_MAX_BYTES} bytes`,
			})
			.refine((s) => !s.includes("\0"), { message: "must not contain NUL" })
			.optional()
			.openapi({
				description:
					"Shell command line, run by `bash -lc` (up to 256 KiB). Exactly one of command and argv.",
				example: "npm test",
			}),
		argv: z
			.array(z.string())
			.min(1)
			.max(4096)
			.nullable()
			.optional()
			.openapi({
				description: "Program and arguments, run without a shell",
				example: ["node", "--version"],
			}),
		mode: z
			.enum(START_MODES)
			.optional()
			.openapi({
				description:
					"`sync` (default): 200 with the output once the command exits. `stream`: 200 NDJSON " +
					"frames. `detached`: 201 Command right after the start.",
			}),
		cwd: z.string().max(4096).nullable().optional().openapi({
			description: "Working directory; relative to the user's home (default)",
		}),
		env: EnvVars.optional().openapi({
			description: "Variables of this command only; values are never stored",
		}),
		user: z.string().min(1).max(64).optional().openapi({
			description: "Guest user (default `user`; `root` is allowed)",
		}),
		stdin: z.boolean().optional().openapi({
			description:
				"Keep stdin open for POST .../input (needs the agent capability process.stdin)",
		}),
		timeoutSeconds: z
			.int()
			.min(1)
			.nullable()
			.optional()
			.openapi({
				description:
					"Process timeout (status timed_out). sync: default 60, at most 600, null not allowed. " +
					"stream and detached: default none (null).",
			}),
		encoding: z.enum(ENCODINGS).optional().openapi({
			description:
				"Output in frames and the sync answer: utf8 (default; invalid bytes become U+FFFD) or base64",
		}),
		tags: Labels.optional(),
	})
	.superRefine((b, ctx) => {
		const hasCommand = b.command !== undefined;
		const hasArgv = b.argv !== undefined && b.argv !== null;
		if (hasCommand === hasArgv) {
			ctx.addIssue({
				code: "custom",
				path: hasCommand ? ["argv"] : ["command"],
				message: "exactly one of command and argv is required",
			});
		}
		const sync = (b.mode ?? "sync") === "sync";
		if (sync && b.timeoutSeconds === null) {
			// A sync request always finishes (§9.1): no unbounded process.
			ctx.addIssue({
				code: "custom",
				path: ["timeoutSeconds"],
				message: `sync commands always have a timeout (default ${SYNC_DEFAULT_TIMEOUT_SECONDS}, at most ${SYNC_MAX_TIMEOUT_SECONDS}); omit it or use stream or detached`,
			});
		}
		if (
			sync &&
			typeof b.timeoutSeconds === "number" &&
			b.timeoutSeconds > SYNC_MAX_TIMEOUT_SECONDS
		) {
			ctx.addIssue({
				code: "custom",
				path: ["timeoutSeconds"],
				message: `at most ${SYNC_MAX_TIMEOUT_SECONDS} in sync mode; use stream or detached for longer commands`,
			});
		}
	})
	.openapi("StartCommandRequest");

export type StartCommandBody = z.infer<typeof StartCommandRequest>;

const StreamInfo = z
	.object({
		sizeBytes: z.int().openapi({ description: "Bytes produced so far" }),
		availableFromBytes: z.int().nullable().openapi({
			description:
				"Oldest offset still kept by the agent; null when unknown (sandbox not ready)",
		}),
		endBytes: z
			.int()
			.nullable()
			.openapi({ description: "Final size once the stream ended" }),
	})
	.openapi("CommandStream");

export const CommandSchema = z
	.object({
		id: z.string().openapi({ example: "cmd_01jbx2v7d3m6c8q9w0e4r5t6y7" }),
		sandboxId: z.string().openapi({ example: "sb_01jbx4q3m7f8r2t6v9w0y1z2a3" }),
		mode: extensibleEnum(COMMAND_MODES),
		command: z.string().nullable().openapi({
			description: "Shell command line (first 64 KiB); null for argv",
		}),
		argv: z.array(z.string()).nullable(),
		cwd: z.string().nullable(),
		user: z.string(),
		envKeys: z
			.array(z.string())
			.openapi({ description: "Names of the command's env (never values)" }),
		tags: Labels,
		timeoutSeconds: z.int().nullable(),
		status: extensibleEnum(COMMAND_STATUSES),
		exitCode: z.int().nullable(),
		signal: z.string().nullable(),
		reason: z.string().nullable().openapi({
			description:
				"Why it ended: none, signal, timeout, oom, pty_idle, reboot, shim_lost, start_failed (`reboot` also when the platform marked it lost because the machine went down); null while it runs or when unknown",
		}),
		pid: z.int().nullable(),
		outputTruncated: z.string().nullable().openapi({
			description:
				"Why output is missing: `disk_full` when the agent dropped output because the sandbox disk was full (stream ends count only the bytes written); null otherwise. Live from the agent while the sandbox is ready, else the stored value",
		}),
		streams: z
			.object({
				stdout: StreamInfo.optional(),
				stderr: StreamInfo.optional(),
				pty: StreamInfo.optional(),
			})
			.nullable()
			.openapi({
				description:
					"Output sizes: live from the agent while the sandbox is ready, else the stored totals; null when unknown",
			}),
		createdBy: z.string().nullable().openapi({
			description: "The user (`usr_...`) who started it; null for a team key",
		}),
		createdByKey: z.string().nullable().openapi({
			description:
				"The team key (`key_...`) that started it; null for a person",
		}),
		createdAt: Timestamp,
		startedAt: NullableTimestamp,
		endedAt: NullableTimestamp,
	})
	.openapi("Command", {
		description: "A process started in a sandbox",
	});

export type CommandResource = z.infer<typeof CommandSchema>;

export const SyncCommandResultSchema = z
	.object({
		command: CommandSchema,
		stdout: z.string(),
		stderr: z.string(),
		stdoutTruncated: z.boolean().openapi({
			description:
				"The answer holds only the tail; read the start with GET .../output from 0",
		}),
		stderrTruncated: z.boolean(),
		stdoutFrom: z
			.int()
			.openapi({ description: "Offset of the first stdout byte returned" }),
		stderrFrom: z.int(),
	})
	.openapi("SyncCommandResult", {
		description:
			"The result of a sync command: the tail (up to 4 MiB) of each stream",
	});

export const CommandListSchema = z
	.object({
		data: z.array(CommandSchema),
		nextCursor: z.string().nullable(),
	})
	.openapi("CommandList");

export const ListCommandsQuery = z.object({
	status: z
		.string()
		.optional()
		.openapi({
			description: `Comma-separated statuses: ${COMMAND_STATUSES.join(", ")}`,
			example: "running",
		}),
	mode: z.enum(COMMAND_MODES).optional(),
	...PageQuery,
});

// --- frames ---

const offsets = {
	stdoutOffset: z.int(),
	stderrOffset: z.int(),
	ptyOffset: z.int().optional().openapi({ description: "PTY commands only" }),
};

const frame = <T extends string>(type: T) => z.literal(type);

const StartedFrame = z
	.object({
		type: frame("started"),
		commandId: z.string(),
		pid: z.int().nullable(),
		encoding: z.enum(ENCODINGS),
		replayed: z.boolean().optional().openapi({
			description:
				"A repeat with the same Idempotency-Key: the same command, from offset 0",
		}),
	})
	.openapi("CommandStartedFrame");

const AttachedFrame = z
	.object({
		type: frame("attached"),
		commandId: z.string(),
		encoding: z.enum(ENCODINGS),
		...offsets,
	})
	.openapi("CommandAttachedFrame");

const OutputFrame = z
	.object({
		type: z.enum(OUTPUT_STREAMS),
		offset: z.int(),
		nextOffset: z.int(),
		data: z.string().openapi({
			description:
				"Text (utf8) or base64 of exactly the bytes [offset, nextOffset)",
		}),
	})
	.openapi("CommandOutputFrame");

const TruncatedFrame = z
	.object({
		type: frame("truncated"),
		stream: z.enum(OUTPUT_STREAMS),
		availableFrom: z.int(),
	})
	.openapi("CommandTruncatedFrame");

const HeartbeatFrame = z
	.object({ type: frame("heartbeat") })
	.openapi("CommandHeartbeatFrame");

const ReconnectFrame = z
	.object({
		type: frame("reconnect"),
		reason: extensibleEnum(["max_duration", "server_shutdown"]),
		...offsets,
	})
	.openapi("CommandReconnectFrame");

const ExitFrame = z
	.object({
		type: frame("exit"),
		status: extensibleEnum(EXIT_STATUSES),
		exitCode: z.int().nullable(),
		signal: z.string().nullable(),
		reason: z.string().nullable(),
		outputTruncated: z.string().nullable().openapi({
			description:
				"Why output is missing: `disk_full` when the agent dropped output because the sandbox disk was full (stream ends count only the bytes written); null otherwise",
		}),
		...offsets,
	})
	.openapi("CommandExitFrame");

const ErrorFrame = z
	.object({
		type: frame("error"),
		code: z.string(),
		message: z.string(),
		retryable: z.boolean(),
		requestId: z.string(),
		...offsets,
	})
	.openapi("CommandErrorFrame");

export const CommandFrameSchema = z
	.union([
		StartedFrame,
		AttachedFrame,
		OutputFrame,
		TruncatedFrame,
		HeartbeatFrame,
		ReconnectFrame,
		ExitFrame,
		ErrorFrame,
	])
	.openapi("CommandFrame", {
		description:
			"One line of an application/x-ndjson command stream. Output frames carry " +
			"offsets; the last frame is exit, reconnect (reopen /stream with its offsets) or error " +
			"(reopen when retryable). Ignore frame types you do not know.",
	});

export const StreamQuery = z.object({
	stdoutOffset: z.coerce.number().int().min(0).optional(),
	stderrOffset: z.coerce.number().int().min(0).optional(),
	ptyOffset: z.coerce.number().int().min(0).optional(),
	tailBytes: z.coerce.number().int().min(0).optional().openapi({
		description:
			"Start each stream this many bytes before its end (ignores the offsets)",
	}),
	follow: z.enum(["true", "false"]).optional().openapi({
		description:
			"false: send what exists and close (exit if it has exited); default true",
	}),
	encoding: z.enum(ENCODINGS).optional(),
});

export const OutputQuery = z.object({
	stream: z
		.enum(OUTPUT_STREAMS)
		.optional()
		.openapi({ description: "Default stdout" }),
	offset: z.coerce.number().int().min(0).optional(),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(OUTPUT_MAX_LIMIT)
		.optional()
		.openapi({
			description: "Bytes, at most 4 MiB (default 1 MiB)",
		}),
});

export const InputRequest = z
	.strictObject({
		data: z
			.string()
			.openapi({ description: 'Bytes to write ("" with closeStdin)' }),
		encoding: z.enum(ENCODINGS).optional(),
		closeStdin: z.boolean().optional().openapi({
			description: "Close stdin after the data (not for PTY: send ^D)",
		}),
		sessionId: z
			.string()
			.regex(/^[A-Za-z0-9._-]{1,128}$/)
			.optional()
			.openapi({ description: "Writer id; with seq a repeat is applied once" }),
		seq: z.int().min(1).optional().openapi({
			description:
				"Order of this chunk within sessionId, from 1; repeats (seq <= last) are dropped",
		}),
	})
	.superRefine((b, ctx) => {
		if ((b.sessionId === undefined) !== (b.seq === undefined)) {
			ctx.addIssue({
				code: "custom",
				path: [b.sessionId === undefined ? "sessionId" : "seq"],
				message: "sessionId and seq go together",
			});
		}
	})
	.openapi("CommandInputRequest");

export const KillRequest = z
	.strictObject({
		graceMs: z.int().min(0).max(600_000).optional().openapi({
			description: "SIGTERM, then SIGKILL after this many ms (default 10 000)",
		}),
	})
	.openapi("CommandKillRequest");

export const SignalRequest = z
	.strictObject({ signal: z.enum(SIGNALS) })
	.openapi("CommandSignalRequest");
