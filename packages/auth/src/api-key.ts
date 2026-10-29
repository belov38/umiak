import { createHash, randomBytes } from "node:crypto";
import { crc32 } from "node:zlib";

// Team API key secret (S7 §7.2): "sbx_" + 43 base62 chars (32 random bytes)
// + 6 base62 chars of CRC32 over everything before them.

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const PREFIX = "sbx_";
const BODY_LEN = 43;
const CRC_LEN = 6;

/** Pattern for secret scanners and the cheap pre-check before hashing. */
export const API_KEY_RE = /^sbx_[0-9A-Za-z]{49}$/;

function base62(n: bigint, width: number): string {
	let out = "";
	let v = n;
	while (v > 0n) {
		out = BASE62[Number(v % 62n)] + out;
		v /= 62n;
	}
	return out.padStart(width, "0");
}

function checksum(body: string): string {
	return base62(BigInt(crc32(PREFIX + body)), CRC_LEN);
}

export function generateApiKeySecret(): string {
	const body = base62(BigInt(`0x${randomBytes(32).toString("hex")}`), BODY_LEN);
	return PREFIX + body + checksum(body);
}

/** Format and CRC check; offline, says nothing about whether the key exists. */
export function isWellFormedApiKey(s: string): boolean {
	if (!API_KEY_RE.test(s)) return false;
	const body = s.slice(PREFIX.length, PREFIX.length + BODY_LEN);
	return s.slice(PREFIX.length + BODY_LEN) === checksum(body);
}

/** sha256 hex of the secret: the only form that is stored. */
export function apiKeyHash(secret: string): string {
	return createHash("sha256").update(secret).digest("hex");
}

/** Non-secret parts shown in listings: 8 chars after "sbx_" and the last 4. */
export function apiKeyDisplay(secret: string): {
	prefix: string;
	last4: string;
} {
	return {
		prefix: secret.slice(PREFIX.length, PREFIX.length + 8),
		last4: secret.slice(-4),
	};
}
