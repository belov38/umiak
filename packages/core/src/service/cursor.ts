import { validation } from "../errors.ts";
import { isUuid } from "./common.ts";
import { isPlainObject } from "./validate.ts";

// Opaque keyset cursor of the lists (`created_at DESC, id DESC`): base64url of
// `{c, id}`. S7 wraps it in its own signed cursor.

export interface Cursor {
	/** created_at in UTC with microseconds, `YYYY-MM-DD HH24:MI:SS.US`. */
	c: string;
	id: string;
}

const CURSOR_TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;

export function encodeCursor(c: Cursor): string {
	return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

/** `validation` (path `cursor`) unless `s` is a cursor whose id passes `isId`. */
export function decodeCursor(
	s: string,
	isId: (id: unknown) => boolean = isUuid,
): Cursor {
	try {
		const v: unknown = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
		if (
			isPlainObject(v) &&
			typeof v.c === "string" &&
			CURSOR_TS_RE.test(v.c) &&
			typeof v.id === "string" &&
			isId(v.id)
		) {
			return { c: v.c, id: v.id };
		}
	} catch {
		// reported below
	}
	throw validation([{ path: "cursor", message: "invalid cursor" }]);
}
