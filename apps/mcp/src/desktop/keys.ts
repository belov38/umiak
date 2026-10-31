// Key names of the desktop API (S10 12.2): a fixed lowercase vocabulary, so a
// wrong name is caught here with the list of valid ones instead of as a 400.
import { ToolError } from "../errors.ts";

export const MODIFIERS = ["ctrl", "alt", "shift", "meta"] as const;

/** Named keys, without the single printable characters (`a`, `1`, `/`). */
export const KEY_NAMES: readonly string[] = [
	...MODIFIERS,
	"enter",
	"tab",
	"escape",
	"backspace",
	"delete",
	"insert",
	"space",
	"up",
	"down",
	"left",
	"right",
	"home",
	"end",
	"pageup",
	"pagedown",
	...Array.from({ length: 24 }, (_, i) => `f${i + 1}`),
	"capslock",
	"printscreen",
	"menu",
];

const NAMED = new Set(KEY_NAMES);

const VALID_KEYS =
	"ctrl, alt, shift, meta, enter, tab, escape, backspace, delete, insert, space, up, down, left, right, home, end, pageup, pagedown, f1-f24, capslock, printscreen, menu, or one printable character such as a, 1, /";

function invalid(message: string, valid: string): ToolError {
	return new ToolError({
		code: "invalid_action",
		message,
		hint: `nothing was executed. Valid names: ${valid}.`,
	});
}

/** One key: a named key or an ASCII letter in any case (the vocabulary is lowercase), or another printable character as typed. */
function keyOf(token: string): string {
	const name = token.toLowerCase();
	if (NAMED.has(name)) return name;
	const chars = [...token];
	if (chars.length === 1 && /^[A-Za-z]$/.test(token)) return name;
	if (chars.length === 1 && !/[\s\p{Cc}]/u.test(token)) return token;
	throw invalid(`unknown key name ${JSON.stringify(token)}`, VALID_KEYS);
}

/**
 * `ctrl+shift+t` -> `["ctrl", "shift", "t"]`. A chord whose last key is the
 * plus sign itself is written `ctrl++`. Unknown names are an `invalid_action`
 * error that lists the valid ones.
 */
export function parseChord(s: string): string[] {
	const text = s.trim();
	if (text === "") throw invalid("the key chord is empty", VALID_KEYS);
	let tokens = text.split("+");
	if (text.endsWith("+")) {
		// "+" and "ctrl++": the last key is the plus sign itself.
		const before = text.slice(0, -1);
		if (before === "") tokens = ["+"];
		else if (before.endsWith("+")) {
			tokens = [...before.slice(0, -1).split("+"), "+"];
		}
	}
	return tokens.map((t) => keyOf(t.trim()));
}

/** The modifiers of a click: only the four of S10 12.2. */
export function parseModifiers(list: readonly string[]): string[] {
	return list.map((m) => {
		const name = m.trim().toLowerCase();
		if ((MODIFIERS as readonly string[]).includes(name)) return name;
		throw invalid(
			`unknown modifier ${JSON.stringify(m)}`,
			MODIFIERS.join(", "),
		);
	});
}
