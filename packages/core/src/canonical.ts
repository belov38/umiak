import { createHash } from "node:crypto";

/**
 * Canonical JSON: object keys sorted by code unit order, `undefined` object
 * members dropped (in arrays they become `null`, like JSON.stringify),
 * `toJSON` honoured. Non-finite numbers, bigints, functions and symbols throw.
 */
export function canonicalJson(v: unknown): string {
	const out = encode(v);
	if (out === undefined) {
		throw new TypeError("canonicalJson: value is not representable in JSON");
	}
	return out;
}

function encode(v: unknown): string | undefined {
	if (
		v !== null &&
		typeof v === "object" &&
		typeof (v as { toJSON?: unknown }).toJSON === "function"
	) {
		return encode((v as { toJSON: () => unknown }).toJSON());
	}
	switch (typeof v) {
		case "undefined":
			return undefined;
		case "string":
		case "boolean":
			return JSON.stringify(v);
		case "number":
			if (!Number.isFinite(v)) {
				throw new TypeError(`canonicalJson: non-finite number ${v}`);
			}
			return JSON.stringify(v);
		case "object": {
			if (v === null) return "null";
			if (Array.isArray(v)) {
				return `[${v.map((x) => encode(x) ?? "null").join(",")}]`;
			}
			const parts: string[] = [];
			for (const k of Object.keys(v).sort()) {
				const val = encode((v as Record<string, unknown>)[k]);
				if (val !== undefined) parts.push(`${JSON.stringify(k)}:${val}`);
			}
			return `{${parts.join(",")}}`;
		}
		default:
			throw new TypeError(`canonicalJson: unsupported type ${typeof v}`);
	}
}

/** Idempotency body hash: sha256(scope + "\n" + canonicalJson(body)). */
export function requestHash(scope: string, body: unknown): Buffer {
	return createHash("sha256")
		.update(`${scope}\n${canonicalJson(body)}`, "utf8")
		.digest();
}
