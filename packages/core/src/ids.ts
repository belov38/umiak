import { createHash, randomBytes } from "node:crypto";

/**
 * Namespace for UUIDv5 ids derived by the platform (step request ids, §7.1 p. 4).
 * A fixed random UUID chosen once for this project; never change it, or retried
 * steps would send the agent a different request id.
 */
export const UMIAK_NAMESPACE = "8936fdf5-56ac-44bd-8e77-4e050ecf5b5c";

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function format(b: Buffer): string {
	const h = b.toString("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function setVersion(b: Buffer, version: number): Buffer {
	b[6] = ((b[6] ?? 0) & 0x0f) | (version << 4);
	b[8] = ((b[8] ?? 0) & 0x3f) | 0x80; // RFC 9562 variant 10
	return b;
}

/**
 * UUIDv7 (RFC 9562 §5.7): 48-bit unix ms timestamp, version 7, variant 10,
 * 74 random bits. Ids from different milliseconds sort by time; ids within
 * one millisecond are in random order.
 */
export function uuidv7(nowMs: number = Date.now()): string {
	if (!Number.isInteger(nowMs) || nowMs < 0 || nowMs >= 2 ** 48) {
		throw new RangeError(`uuidv7: timestamp out of range: ${nowMs}`);
	}
	const b = randomBytes(16);
	b.writeUIntBE(nowMs, 0, 6);
	return format(setVersion(b, 7));
}

/** UUIDv5 (RFC 9562 §5.5): SHA-1 of namespace bytes and the UTF-8 name. */
export function uuidv5(
	name: string,
	namespace: string = UMIAK_NAMESPACE,
): string {
	if (!UUID_RE.test(namespace)) {
		throw new TypeError(`uuidv5: invalid namespace UUID: ${namespace}`);
	}
	const ns = Buffer.from(namespace.replaceAll("-", ""), "hex");
	const digest = createHash("sha1").update(ns).update(name, "utf8").digest();
	return format(setVersion(digest.subarray(0, 16), 5));
}

/** Deterministic agent requestId for a step of an operation (S6 §7.1 p. 4). */
export function stepRequestId(operationId: string, step: string): string {
	return uuidv5(`${operationId}:${step}`);
}
