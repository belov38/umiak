import { timingSafeEqual } from "node:crypto";

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

/** The key source of request hashes (`KeyRing`). */
export interface RequestHashKeys {
	readonly currentVersion: number;
	/** HMAC-SHA256 under a subkey of data key `version`; throws for an unknown version. */
	mac(purpose: string, data: string, version?: number): Buffer;
}

/** A request body hash and its comparison with a stored one. */
export interface RequestHash {
	/** Stored as is (`idempotency_keys.request_hash`, hex in `operations.request.bodyHash`). */
	value: Buffer;
	/** Same scope and canonical body, whichever ring version made `stored`. */
	matches(stored: Uint8Array): boolean;
}

export const REQUEST_HASH_PURPOSE = "sbx-request-hash/v1";
const VERSION_BYTES = 4;
const MAC_BYTES = 32;

/**
 * Body hash of idempotency (S6 §14.1) and of an active resume (§7.6). The body
 * includes env and secret values, so it is keyed, never a plain sha256 that
 * could confirm a guessed secret: `version (uint32 BE) || HMAC-SHA256(subkey
 * of data key version, scope "\n" canonicalJson(body))`. The version prefix
 * keeps hashes made before a key rotation comparable: `matches` recomputes
 * with the stored version while that key is still in the ring (keep a retired
 * key at least the idempotency TTL, 24 h). A hash whose key is gone never
 * matches (the conservative answer: `idempotency_key_reused`, no duplicate).
 */
export function requestHash(
	keys: RequestHashKeys,
	scope: string,
	body: unknown,
): RequestHash {
	const data = `${scope}\n${canonicalJson(body)}`;
	const value = versioned(keys, data, keys.currentVersion);
	return {
		value,
		matches(stored: Uint8Array): boolean {
			if (stored.length !== VERSION_BYTES + MAC_BYTES) return false;
			const version = Buffer.from(stored).readUInt32BE(0);
			let expected: Buffer;
			try {
				expected =
					version === keys.currentVersion
						? value
						: versioned(keys, data, version);
			} catch {
				return false;
			}
			return timingSafeEqual(expected, stored);
		},
	};
}

function versioned(
	keys: RequestHashKeys,
	data: string,
	version: number,
): Buffer {
	const prefix = Buffer.alloc(VERSION_BYTES);
	prefix.writeUInt32BE(version, 0);
	return Buffer.concat([prefix, keys.mac(REQUEST_HASH_PURPOSE, data, version)]);
}
