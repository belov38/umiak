// Idempotency-Key policy of the dashboard's create and fork (S7 §5.7). A
// manual retry ("Try again", a second click) after an outcome-unknown
// failure must reuse the key of the first attempt, or the API may create a
// second sandbox. The key is kept while the body is unchanged and rotated
// after a success, after a definitive API error (the request was answered
// and nothing was done), and when the body changes.
import {
	NETWORK_ERROR,
	newIdempotencyKey,
	UmiakError,
	UNEXPECTED_RESPONSE,
} from "@umiak/sdk";

export interface IdempotencySlot {
	key: string;
	/** Hash of the body the key was used for (the body itself is not kept). */
	bodyHash: string;
}

/** JSON with sorted object keys: equal bodies give equal strings. */
function stableJson(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
	if (v !== null && typeof v === "object") {
		const o = v as Record<string, unknown>;
		return `{${Object.keys(o)
			.filter((k) => o[k] !== undefined)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(v) ?? "null";
}

/** 64-bit FNV-1a of the stable JSON, hex; not a security hash. */
export function bodyHash(body: unknown): string {
	const s = stableJson(body);
	let h = 0xcbf29ce484222325n;
	for (let i = 0; i < s.length; i++) {
		h ^= BigInt(s.charCodeAt(i));
		h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
	}
	return h.toString(16).padStart(16, "0");
}

/** The slot for sending `body`: the current one if the body is the same. */
export function slotFor(
	slot: IdempotencySlot | null,
	body: unknown,
	newKey: () => string = newIdempotencyKey,
): IdempotencySlot {
	const h = bodyHash(body);
	return slot !== null && slot.bodyHash === h
		? slot
		: { key: newKey(), bodyHash: h };
}

/**
 * The request may or may not have been applied: no answer, an answer
 * without the API envelope (a proxy page), the api going away, an aborted
 * call, or an API error that says so (`details.outcome: "unknown"`).
 */
export function outcomeUnknown(e: unknown): boolean {
	if (!(e instanceof UmiakError)) return true;
	if (e.code === NETWORK_ERROR || e.code === UNEXPECTED_RESPONSE) return true;
	if (e.code === "server_shutting_down" || e.code === "not_ready") return true;
	return e.details.outcome === "unknown";
}

/**
 * The slot to keep after an attempt: the same one only when the outcome is
 * unknown; null (a new key next time) after a success or a definitive error.
 */
export function slotAfter(
	slot: IdempotencySlot,
	error: unknown | undefined,
): IdempotencySlot | null {
	return error !== undefined && outcomeUnknown(error) ? slot : null;
}
