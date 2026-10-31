// Windows of sandbox bytes that fit a character budget once sanitized
// (S11 9.2): sanitizing writes a control byte as up to 9 characters, so a
// byte budget alone does not bound the response.
import { sanitizeForLlm } from "./sanitize.ts";
import { decodeWindow, type Window } from "./utf8.ts";

/** Bytes `[offset, offset + bytes.length)` of a stream or file of `size` bytes. */
export interface ByteSpan {
	bytes: Uint8Array;
	offset: number;
	size: number;
	/** The span starts on a known character boundary. */
	atStart: boolean;
	/** Nothing follows the span: an unfinished character at its end is not held back. */
	final: boolean;
}

/** Characters the window takes once sanitized (inside a fence). */
export function shownChars(w: Window): number {
	return sanitizeForLlm(w.text).length;
}

/**
 * Decodes the span, shortened on a character boundary until its sanitized
 * text fits `maxChars`: from the end when reading forward (`keep: "head"`),
 * from the start for a tail (`keep: "tail"`). `from`/`to` of the result are
 * exactly the bytes shown.
 */
export function fittingWindow(
	span: ByteSpan,
	maxChars: number,
	keep: "head" | "tail" = "head",
): Window {
	const len = span.bytes.length;
	let n = len;
	for (;;) {
		const w =
			keep === "head"
				? decodeWindow(span.bytes.subarray(0, n), span.offset, span.size, {
						atStart: span.atStart,
						final: span.final && n === len,
					})
				: decodeWindow(
						span.bytes.subarray(len - n),
						span.offset + len - n,
						span.size,
						{ atStart: span.atStart && n === len, final: span.final },
					);
		const chars = shownChars(w);
		if (chars <= maxChars) return w;
		// Proportional, with a margin; always shorter than before.
		n = Math.min(n - 1, Math.floor((n * maxChars * 0.9) / chars));
	}
}
