import type { CallToolResult } from "@modelcontextprotocol/server";

export const MAX_RESULT_CHARS = 80_000;

const CUT_NOTE = `response cut at ${MAX_RESULT_CHARS} characters`;

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isEmpty(v: unknown): boolean {
	return (
		v === undefined ||
		v === null ||
		v === "" ||
		(Array.isArray(v) && v.length === 0) ||
		(isPlainObject(v) && Object.keys(v).length === 0)
	);
}

function prune(v: unknown): unknown {
	if (!isPlainObject(v)) return v;
	const out: Record<string, unknown> = {};
	for (const [k, val] of Object.entries(v)) {
		const pruned = prune(val);
		if (!isEmpty(pruned)) out[k] = pruned;
	}
	return out;
}

/** Compact JSON header (empty fields dropped) plus optional extra text blocks. */
export function toolText(
	header: Record<string, unknown>,
	extra: string[] = [],
): CallToolResult {
	return {
		content: [
			{ type: "text", text: JSON.stringify(prune(header)) },
			...extra.map((text) => ({ type: "text" as const, text })),
		],
	};
}

function cutAt(text: string, n: number): string {
	// Do not leave half of a surrogate pair at the cut.
	const lastCode = text.charCodeAt(n - 1);
	const end = n > 0 && lastCode >= 0xd800 && lastCode <= 0xdbff ? n - 1 : n;
	return text.slice(0, end);
}

/**
 * Safety net for the whole response: text beyond MAX_RESULT_CHARS is cut,
 * last blocks first so the header survives, and a line says so. Images are
 * not counted or changed.
 */
export function capResult(r: CallToolResult): CallToolResult {
	let total = 0;
	for (const b of r.content) if (b.type === "text") total += b.text.length;
	if (total <= MAX_RESULT_CHARS) return r;

	let left = MAX_RESULT_CHARS - CUT_NOTE.length;
	const content: CallToolResult["content"] = [];
	for (const b of r.content) {
		if (b.type !== "text") {
			content.push(b);
			continue;
		}
		if (left <= 0) continue;
		const text = b.text.length <= left ? b.text : cutAt(b.text, left);
		left -= text.length;
		content.push({ ...b, text });
	}
	content.push({ type: "text", text: CUT_NOTE });
	return { ...r, content };
}
