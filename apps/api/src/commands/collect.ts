// Sync mode (S7 §9.2): the frames of a command are read until the last one
// and folded into one answer with the tail (up to 4 MiB) of each stream.
// `stdoutFrom` is the offset of the first byte returned; `stdoutTruncated`
// means the output before it is not in the answer (read it via /output).
import type {
	ErrorFrame,
	ExitFrame,
	Frame,
	OutputEncoding,
	ReconnectFrame,
} from "./frames.ts";

export const SYNC_TAIL_BYTES = 4 * 1024 * 1024;

export interface SyncResult {
	/** The `exit` frame; null when the stream ended otherwise. */
	exit: ExitFrame | null;
	/** The `error` or `reconnect` frame that ended the stream early. */
	ended: ErrorFrame | ReconnectFrame | null;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	stdoutFrom: number;
	stderrFrom: number;
}

interface Piece {
	offset: number;
	nextOffset: number;
	data: string;
}

class Tail {
	readonly #max: number;
	readonly #pieces: Piece[] = [];
	#bytes = 0;
	/** Where the stream starts when nothing is kept. */
	#end = 0;
	#truncated = false;

	constructor(max: number) {
		this.#max = max;
	}

	add(p: Piece): void {
		this.#pieces.push(p);
		this.#bytes += p.nextOffset - p.offset;
		this.#end = p.nextOffset;
		while (this.#bytes > this.#max && this.#pieces.length > 0) {
			const first = this.#pieces.shift() as Piece;
			this.#bytes -= first.nextOffset - first.offset;
		}
	}

	/** The first offset of the stream (`attached`), before any output. */
	startAt(offset: number): void {
		if (this.#pieces.length === 0) this.#end = offset;
	}

	/**
	 * `truncated`: output up to `availableFrom` is gone, so kept pieces are
	 * no longer contiguous with what follows; the answer starts there.
	 */
	truncate(availableFrom: number): void {
		this.#pieces.length = 0;
		this.#bytes = 0;
		this.#end = availableFrom;
		this.#truncated = true;
	}

	truncated(): boolean {
		return this.#truncated || this.from() > 0;
	}

	from(): number {
		return this.#pieces[0]?.offset ?? this.#end;
	}

	text(encoding: OutputEncoding): string {
		if (encoding === "utf8") return this.#pieces.map((p) => p.data).join("");
		return Buffer.concat(
			this.#pieces.map((p) => Buffer.from(p.data, "base64")),
		).toString("base64");
	}
}

/** Reads `frames` to the end and folds them (frames of one stdout/stderr command). */
export async function collectSync(
	frames: AsyncIterable<Frame>,
	encoding: OutputEncoding,
	maxBytes = SYNC_TAIL_BYTES,
): Promise<SyncResult> {
	const out = new Tail(maxBytes);
	const err = new Tail(maxBytes);
	let exit: ExitFrame | null = null;
	let ended: ErrorFrame | ReconnectFrame | null = null;
	for await (const f of frames) {
		switch (f.type) {
			case "stdout":
			case "pty":
				out.add(f);
				break;
			case "stderr":
				err.add(f);
				break;
			case "truncated":
				(f.stream === "stderr" ? err : out).truncate(f.availableFrom);
				break;
			case "attached":
				out.startAt(f.stdoutOffset);
				err.startAt(f.stderrOffset);
				break;
			case "exit":
				exit = f;
				break;
			case "error":
			case "reconnect":
				ended = f;
				break;
		}
	}
	return {
		exit,
		ended,
		stdout: out.text(encoding),
		stderr: err.text(encoding),
		stdoutTruncated: out.truncated(),
		stderrTruncated: err.truncated(),
		stdoutFrom: out.from(),
		stderrFrom: err.from(),
	};
}
