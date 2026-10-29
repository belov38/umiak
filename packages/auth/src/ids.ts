import { ulid } from "ulid";

// Public ids (S7 §5.3): prefix + "_" + 26 chars of Crockford base32 (lower case)
// over 128 bits. UUIDv7 and ULID share the encoding, so ids sort by time.

export const ID_PREFIXES = {
	sandbox: "sb",
	operation: "op",
	command: "cmd",
	snapshot: "snap",
	apiKey: "key",
	sshKey: "sshk",
	environment: "env",
	user: "usr",
	team: "team",
	upload: "upl",
	request: "req",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

/** Crockford base32 without i, l, o, u. */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const BODY_LEN = 26;

const DECODE: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) {
	const c = ALPHABET[i] as string;
	DECODE[c] = i;
	DECODE[c.toUpperCase()] = i;
}

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BODY_RE = /^[0-7][0-9a-hjkmnp-tv-zA-HJKMNP-TV-Z]{25}$/;

function encodeBigint(n: bigint): string {
	let out = "";
	let v = n;
	for (let i = 0; i < BODY_LEN; i++) {
		out = ALPHABET[Number(v & 31n)] + out;
		v >>= 5n;
	}
	return out;
}

/** Returns the 26-char body (original case) if `publicId` has the kind's prefix. */
function splitBody(kind: IdKind, publicId: unknown): string | null {
	if (typeof publicId !== "string") return null;
	const prefix = `${ID_PREFIXES[kind]}_`;
	if (publicId.length !== prefix.length + BODY_LEN) return null;
	// ASCII-only case folding: Unicode toLowerCase maps e.g. U+212A (Kelvin) to "k".
	const head = publicId
		.slice(0, prefix.length)
		.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
	if (head !== prefix) return null;
	const body = publicId.slice(prefix.length);
	// The first char must be 0-7: 26 chars carry 130 bits, the top 2 are zero.
	return BODY_RE.test(body) ? body : null;
}

function decodeBody(body: string): bigint {
	let n = 0n;
	for (const c of body) n = (n << 5n) | BigInt(DECODE[c] as number);
	return n;
}

/** UUID (any case) to public id. Throws on a malformed UUID. */
export function encodeUuid(kind: IdKind, uuid: string): string {
	if (!UUID_RE.test(uuid)) throw new Error(`encodeUuid: invalid uuid: ${uuid}`);
	const n = BigInt(`0x${uuid.replaceAll("-", "")}`);
	return `${ID_PREFIXES[kind]}_${encodeBigint(n)}`;
}

/** Public id to lower-case UUID; null on any format error (S7 §5.3: not_found). */
export function decodeUuid(kind: IdKind, publicId: unknown): string | null {
	const body = splitBody(kind, publicId);
	if (body === null) return null;
	const h = decodeBody(body).toString(16).padStart(32, "0");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** ULID (any case) to public id (prefix + lower-case ULID). Throws on a malformed ULID. */
export function encodeUlid(kind: IdKind, id: string): string {
	if (!BODY_RE.test(id)) throw new Error(`encodeUlid: invalid ulid: ${id}`);
	return `${ID_PREFIXES[kind]}_${id.toLowerCase()}`;
}

/** Public id to upper-case ULID; null on any format error. */
export function decodeUlid(kind: IdKind, publicId: unknown): string | null {
	const body = splitBody(kind, publicId);
	return body === null ? null : body.toUpperCase();
}

/** Fresh public id for ULID-based resources (upload, request). */
export function newPublicUlid(kind: IdKind): string {
	return encodeUlid(kind, ulid());
}
