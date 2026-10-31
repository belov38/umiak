// Command output in a read-only terminal (S8 §9.6 Commands), without the
// DOM: NDJSON frames (S7 §9.5) → text for xterm, the stream filter, and the
// download links of `/output` (S7 §9.4).
import type { CommandData } from "@sbx/sdk";
import { API_BASE_URL } from "@/lib/api-base";

export type OutputFilter = "all" | "stdout" | "stderr";

/** `/output` gives at most this much per link (S7 §9.4). */
export const OUTPUT_DOWNLOAD_LIMIT = 4 * 1024 * 1024;
/** "Last part" start of the viewer: this many bytes before the end. */
export const OUTPUT_TAIL_BYTES = 1024 * 1024;

const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** A frame of the command stream as the SDK yields it (or as parsed). */
export type OutputFrame =
	| { type: "stdout" | "stderr" | "pty"; data: string }
	| { type: "truncated"; stream: string; availableFrom: number }
	| {
			type: "exit";
			status: string;
			exitCode: number | null;
			signal: string | null;
			outputTruncated?: string | null;
	  };

function shows(filter: OutputFilter, stream: string): boolean {
	if (filter === "all") return true;
	// A PTY command has one stream; it counts as stdout.
	return stream === "pty" ? filter === "stdout" : stream === filter;
}

/** One line of the viewer's own (dim), on a line of its own. */
function note(text: string): string {
	return `\r\n${DIM}${text}${RESET}\r\n`;
}

/**
 * Text to write for a frame, or null when the filter hides it. stderr is
 * red; a lost start of output and the exit get a dim line.
 */
export function frameText(f: OutputFrame, filter: OutputFilter): string | null {
	switch (f.type) {
		case "stdout":
		case "pty":
			return shows(filter, f.type) ? f.data : null;
		case "stderr":
			if (!shows(filter, "stderr")) return null;
			return filter === "stderr" ? f.data : `${RED}${f.data}${RESET}`;
		case "truncated":
			if (!shows(filter, f.stream)) return null;
			return note(
				`… the start of ${f.stream} was evicted; it goes on at byte ${f.availableFrom}`,
			);
		case "exit":
			return note(exitText(f));
	}
}

export function exitText(e: {
	status: string;
	exitCode: number | null;
	signal: string | null;
	outputTruncated?: string | null;
}): string {
	let s: string;
	switch (e.status) {
		case "exited":
			s = `[exited with code ${e.exitCode ?? "?"}]`;
			break;
		case "killed":
			s = `[killed${e.signal ? ` by ${e.signal}` : ""}]`;
			break;
		case "timed_out":
			s = "[timed out]";
			break;
		case "lost":
			s = "[lost: the sandbox stopped or restarted]";
			break;
		case "failed_to_start":
			s = "[failed to start]";
			break;
		default:
			s = `[${e.status}]`;
	}
	if (e.outputTruncated === "disk_full") {
		s += " (some output was dropped: the disk was full)";
	}
	return s;
}

/** Statuses of a command that still runs. */
export function isRunning(status: string): boolean {
	return status === "starting" || status === "running";
}

type Streams = NonNullable<CommandData["streams"]>;
type StreamName = keyof Streams;

/** Size of a stream as far as the resource knows (end once it ended). */
function streamSize(s: Streams[StreamName] | undefined): number {
	if (s === undefined) return 0;
	return s.endBytes ?? s.sizeBytes;
}

/** First byte of the last `bytes` of a stream that the agent still has. */
export function tailOffset(
	s: Streams[StreamName] | undefined,
	bytes: number,
): number {
	if (s === undefined) return 0;
	return Math.max(s.availableFromBytes ?? 0, streamSize(s) - bytes, 0);
}

/** Offsets for `follow` from the last OUTPUT_TAIL_BYTES of each stream. */
export function tailOffsets(c: Pick<CommandData, "mode" | "streams">): {
	stdoutOffset: number;
	stderrOffset: number;
	ptyOffset?: number;
} {
	const st = c.streams ?? {};
	if (c.mode === "pty") {
		return {
			stdoutOffset: 0,
			stderrOffset: 0,
			ptyOffset: tailOffset(st.pty, OUTPUT_TAIL_BYTES),
		};
	}
	return {
		stdoutOffset: tailOffset(st.stdout, OUTPUT_TAIL_BYTES),
		stderrOffset: tailOffset(st.stderr, OUTPUT_TAIL_BYTES),
	};
}

/** The output is longer than the tail the viewer starts with. */
export function hasLongOutput(c: Pick<CommandData, "streams">): boolean {
	const st = c.streams ?? {};
	return [st.stdout, st.stderr, st.pty].some(
		(s) => streamSize(s) > OUTPUT_TAIL_BYTES,
	);
}

/**
 * Link of up to 4 MiB of a stream from `offset` (default: the last 4 MiB
 * still kept). A link carries no Sbx-Team header: the team is in the query.
 */
export function outputDownloadUrl(o: {
	sandboxId: string;
	commandId: string;
	stream: "stdout" | "stderr" | "pty";
	offset: number;
	teamId: string;
}): string {
	const q = new URLSearchParams({
		stream: o.stream,
		offset: String(Math.max(0, Math.floor(o.offset))),
		limit: String(OUTPUT_DOWNLOAD_LIMIT),
		team: o.teamId,
	});
	return `${API_BASE_URL}/v1/sandboxes/${encodeURIComponent(o.sandboxId)}/commands/${encodeURIComponent(o.commandId)}/output?${q}`;
}

/** Default offset of a download link: the last 4 MiB the agent still has. */
export function defaultDownloadOffset(
	c: Pick<CommandData, "streams">,
	stream: StreamName,
): number {
	return tailOffset(c.streams?.[stream], OUTPUT_DOWNLOAD_LIMIT);
}

/** Splits NDJSON text into lines; the incomplete rest stays in `rest`. */
export function splitLines(buffer: string): { lines: string[]; rest: string } {
	const parts = buffer.split("\n");
	const rest = parts.pop() ?? "";
	return { lines: parts.filter((l) => l.trim() !== ""), rest };
}

/** Duration `1.2 s`, `3 min 4 s`, `2 h 5 min`, or "—". */
export function formatDuration(
	from: string | null,
	to: string | null,
	now: number,
): string {
	if (from === null) return "—";
	const a = Date.parse(from);
	const b = to === null ? now : Date.parse(to);
	if (Number.isNaN(a) || Number.isNaN(b) || b < a) return "—";
	const ms = b - a;
	if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
	const s = Math.floor(ms / 1000);
	if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
	return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}
