// ANSI escape sequences: OSC (BEL or ST terminated), CSI (ESC [ or U+009B),
// nF sequences such as charset selection (ESC ( B), and other two-byte ones.
// An unterminated OSC is dropped up to the end of its line only.
const ANSI = new RegExp(
	[
		String.raw`\x1b\][^\x07\x1b\n]*(?:\x07|\x1b\\)?`,
		String.raw`(?:\x1b\[|\u009b)[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]`,
		String.raw`\x1b[\x20-\x2f]+[\x30-\x7e]`,
		String.raw`\x1b[\x30-\x7e]`,
	].join("|"),
	"g",
);

// C0 and C1 controls except tab and newline, DEL, invisible and bidi
// formatting characters, and Unicode tags. ZWJ/ZWNJ (U+200C/U+200D) stay.
const UNSAFE = new RegExp(
	[
		String.raw`[\x00-\x08\x0b-\x1f\x7f-\x9f]`,
		String.raw`[\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]`,
	].join("|"),
	"gu",
);

// Built from a code point so no invisible character sits in the source.
const BOM = String.fromCodePoint(0xfeff);

function visible(ch: string): string {
	const hex = (ch.codePointAt(0) as number).toString(16).toUpperCase();
	// Two digits for controls, at least four for everything else.
	const pad = (ch.codePointAt(0) as number) < 0x100 ? 2 : 4;
	return `\\u{${hex.padStart(pad, "0")}}`;
}

function resolveCarriageReturns(text: string): string {
	return text
		.replaceAll("\r\n", "\n")
		.split("\n")
		.map((line) => {
			const trimmed = line.replace(/\r+$/, "");
			return trimmed.slice(trimmed.lastIndexOf("\r") + 1);
		})
		.join("\n");
}

/**
 * Makes sandbox text safe to show to a model and a human reviewer: removes
 * terminal escape sequences, resolves carriage returns the way a terminal
 * would, and writes control and invisible characters in a visible form.
 * A BOM at the very start is kept.
 */
export function sanitizeForLlm(text: string): string {
	const plain = resolveCarriageReturns(text.replace(ANSI, ""));
	const bom = plain.startsWith(BOM);
	const body = bom ? plain.slice(1) : plain;
	return (bom ? BOM : "") + body.replace(UNSAFE, visible);
}
