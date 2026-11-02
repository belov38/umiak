// Signed list cursors (S7 §5.6, decision 5): the opaque cursor of core is
// wrapped as base64url(JSON {c: <core cursor>}) + "." + base64url of the
// HMAC-SHA256 (UMIAK_API_CURSOR_KEY) of that payload, truncated to 16 bytes.
// A cursor the api did not sign is 400 invalid_cursor.
import { createHmac, timingSafeEqual } from "node:crypto";
import { ApiError } from "./errors.ts";

const MAC_BYTES = 16;

function mac(payload: string, key: Buffer): Buffer {
	return createHmac("sha256", key)
		.update(payload)
		.digest()
		.subarray(0, MAC_BYTES);
}

export function invalidCursorError(): ApiError {
	return new ApiError(
		400,
		"invalid_cursor",
		"the cursor is invalid; pass nextCursor of a previous page unchanged",
	);
}

export function encodeCursor(inner: string, key: Buffer): string {
	const payload = Buffer.from(JSON.stringify({ c: inner }), "utf8").toString(
		"base64url",
	);
	return `${payload}.${mac(payload, key).toString("base64url")}`;
}

/** The core cursor inside `s`; 400 invalid_cursor unless the api signed it. */
export function decodeCursor(s: string, key: Buffer): string {
	const dot = s.indexOf(".");
	if (dot <= 0) throw invalidCursorError();
	const payload = s.slice(0, dot);
	const given = Buffer.from(s.slice(dot + 1), "base64url");
	const want = mac(payload, key);
	if (given.length !== want.length || !timingSafeEqual(given, want)) {
		throw invalidCursorError();
	}
	try {
		const v: unknown = JSON.parse(
			Buffer.from(payload, "base64url").toString("utf8"),
		);
		const c = (v as { c?: unknown } | null)?.c;
		if (typeof c === "string") return c;
	} catch {
		// reported below
	}
	throw invalidCursorError();
}

/** `encodeCursor` of a page's `nextCursor`, keeping null. */
export function signNextCursor(
	inner: string | null,
	key: Buffer,
): string | null {
	return inner === null ? null : encodeCursor(inner, key);
}
