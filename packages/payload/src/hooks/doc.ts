// Helpers over Payload documents in hooks: relationship ids and "what
// changed" between previousDoc (depth 0) and doc (the depth of the call).
import type { FlattenedField } from "payload";

type Doc = Record<string, unknown>;

/** The id of a relationship value: an id or a populated document. */
export function relId(v: unknown): string | null {
	if (v === null || v === undefined) return null;
	if (typeof v === "object") {
		const id = (v as { id?: unknown }).id;
		return id === null || id === undefined ? null : String(id);
	}
	return String(v);
}

function normalize(fields: FlattenedField[], doc: Doc): Doc {
	const out: Doc = {};
	for (const f of fields) {
		const v = doc[f.name];
		// Absent: hidden from this read (field read access); not comparable.
		if (v === undefined) continue;
		if (f.type === "relationship" || f.type === "upload") {
			out[f.name] = Array.isArray(v) ? v.map(relId) : relId(v);
		} else if (f.type === "group" && v !== null && typeof v === "object") {
			out[f.name] = normalize(f.flattenedFields, v as Doc);
		} else {
			out[f.name] = v;
		}
	}
	return out;
}

function stable(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
	if (v !== null && typeof v === "object") {
		const o = v as Doc;
		return `{${Object.keys(o)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(v ?? null);
}

/**
 * Top-level fields whose values differ between two versions of a document.
 * Fields absent from either version are not compared.
 */
export function changedFields(
	fields: FlattenedField[],
	prev: Doc | undefined,
	doc: Doc,
): Set<string> {
	const a = normalize(fields, prev ?? {});
	const b = normalize(fields, doc);
	const out = new Set<string>();
	for (const f of fields) {
		if (!(f.name in a) || !(f.name in b)) continue;
		if (stable(a[f.name]) !== stable(b[f.name])) out.add(f.name);
	}
	return out;
}
