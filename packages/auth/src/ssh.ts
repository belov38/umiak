import {
	createHash,
	createPrivateKey,
	createPublicKey,
	type KeyObject,
	randomBytes,
	sign,
	verify,
} from "node:crypto";

// SSH user keys (S7 §11.3) and OpenSSH user certificates signed by the
// ed25519 SSH login CA (S4 §9.2). Wire format: RFC 4251 §5, OpenSSH
// PROTOCOL.certkeys, PROTOCOL.key.

export const SSH_KEY_TYPES = [
	"ssh-ed25519",
	"ecdsa-sha2-nistp256",
	"ecdsa-sha2-nistp384",
	"ecdsa-sha2-nistp521",
	"ssh-rsa",
] as const;

export type SshKeyType = (typeof SSH_KEY_TYPES)[number];

export type SshKeyErrorReason =
	| "malformed"
	| "unsupported_type"
	| "certificate"
	| "rsa_too_short"
	| "encrypted"
	| "private_key"
	| "bad_signature";

export class SshKeyError extends Error {
	readonly reason: SshKeyErrorReason;
	constructor(reason: SshKeyErrorReason, message: string) {
		super(message);
		this.name = "SshKeyError";
		this.reason = reason;
	}
}

export const MIN_RSA_BITS = 3072;
/** Upper limits of Go x/crypto/ssh (the gateway) and OpenSSH. */
const MAX_RSA_BITS = 16_384;
const MAX_RSA_EXPONENT_BITS = 24;
/** Longest accepted key or certificate line; a 16384-bit RSA key is ~2.8 KB. */
const MAX_LINE = 16_384;

const CERT_SUFFIX = "-cert-v01@openssh.com";
const SSH_CERT_TYPE_USER = 1;

/** OpenSSH defaults for user certificates, sorted by bytes as PROTOCOL.certkeys requires. */
const USER_CERT_EXTENSIONS = [
	"permit-X11-forwarding",
	"permit-agent-forwarding",
	"permit-port-forwarding",
	"permit-pty",
	"permit-user-rc",
] as const;

const EC_CURVES: Record<string, { name: string; jwk: string; coord: number }> =
	{
		"ecdsa-sha2-nistp256": { name: "nistp256", jwk: "P-256", coord: 32 },
		"ecdsa-sha2-nistp384": { name: "nistp384", jwk: "P-384", coord: 48 },
		"ecdsa-sha2-nistp521": { name: "nistp521", jwk: "P-521", coord: 66 },
	};

// --- wire helpers ---

class Reader {
	readonly buf: Buffer;
	pos = 0;
	constructor(buf: Buffer) {
		this.buf = buf;
	}
	u32(): number {
		if (this.pos + 4 > this.buf.length) throw malformed("truncated");
		const v = this.buf.readUInt32BE(this.pos);
		this.pos += 4;
		return v;
	}
	u64(): bigint {
		if (this.pos + 8 > this.buf.length) throw malformed("truncated");
		const v = this.buf.readBigUInt64BE(this.pos);
		this.pos += 8;
		return v;
	}
	bytes(): Buffer {
		const n = this.u32();
		if (n > this.buf.length - this.pos) throw malformed("truncated");
		const v = this.buf.subarray(this.pos, this.pos + n);
		this.pos += n;
		return v;
	}
	text(): string {
		const b = this.bytes();
		const s = b.toString("utf8");
		if (!Buffer.from(s, "utf8").equals(b)) throw malformed("invalid utf-8");
		return s;
	}
	end(): void {
		if (this.pos !== this.buf.length) throw malformed("trailing bytes");
	}
}

function malformed(what: string): SshKeyError {
	return new SshKeyError("malformed", `malformed ssh key: ${what}`);
}

function u32(n: number): Buffer {
	const b = Buffer.alloc(4);
	b.writeUInt32BE(n);
	return b;
}

function u64(n: bigint): Buffer {
	const b = Buffer.alloc(8);
	b.writeBigUInt64BE(n);
	return b;
}

function str(v: Buffer | string): Buffer {
	const b = typeof v === "string" ? Buffer.from(v, "utf8") : v;
	return Buffer.concat([u32(b.length), b]);
}

/** Strict base64: canonical encoding only, so one key has one text form. */
function decodeBase64(s: string): Buffer {
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) throw malformed("invalid base64");
	const b = Buffer.from(s, "base64");
	if (b.toString("base64") !== s) throw malformed("non-canonical base64");
	return b;
}

function fingerprintOf(blob: Buffer): string {
	const h = createHash("sha256").update(blob).digest("base64");
	return `SHA256:${h.replace(/=+$/, "")}`;
}

function splitLine(line: string): {
	type: string;
	b64: string;
	comment: string | null;
} {
	if (line.length > MAX_LINE) throw malformed("too long");
	const m = /^(\S+)[ \t]+(\S+)(?:[ \t]+(.*?))?$/.exec(line.trim());
	if (!m) throw malformed("expected '<type> <base64> [comment]'");
	const comment = m[3] || null;
	// Comments are shown in listings and terminals: no escape sequences.
	if (comment !== null && /\p{Cc}/u.test(comment)) {
		throw malformed("control characters in comment");
	}
	return { type: m[1] as string, b64: m[2] as string, comment };
}

function checkType(type: string): SshKeyType {
	if (type.endsWith(CERT_SUFFIX)) {
		throw new SshKeyError("certificate", "certificates are not accepted");
	}
	if (!(SSH_KEY_TYPES as readonly string[]).includes(type)) {
		throw new SshKeyError("unsupported_type", `unsupported key type: ${type}`);
	}
	return type as SshKeyType;
}

/**
 * Bit length of an RFC 4251 mpint that must be positive and minimal: zero
 * is the empty string, a leading 0x00 only before a byte with the high bit
 * set. Go and OpenSSH re-encode keys canonically, so a padded blob would
 * have a different fingerprint than the one the gateway computes.
 */
function mpintBits(b: Buffer): number {
	if (b.length === 0) return 0;
	const first = b[0] as number;
	if ((first & 0x80) !== 0) throw malformed("negative mpint");
	if (first === 0 && (b.length === 1 || ((b[1] as number) & 0x80) === 0)) {
		throw malformed("non-minimal mpint");
	}
	const i = first === 0 ? 1 : 0;
	return (b.length - i - 1) * 8 + (b[i] as number).toString(2).length;
}

/**
 * Reads the type-specific public key fields (everything after the type
 * string) and validates them. Returns the fields as raw bytes.
 */
function readKeyFields(type: SshKeyType, r: Reader): Buffer {
	const start = r.pos;
	if (type === "ssh-ed25519") {
		const pk = r.bytes();
		if (pk.length !== 32) throw malformed("ed25519 key must be 32 bytes");
	} else if (type === "ssh-rsa") {
		const e = r.bytes();
		const n = r.bytes();
		const eBits = mpintBits(e);
		if (
			eBits < 2 ||
			eBits > MAX_RSA_EXPONENT_BITS ||
			((e[e.length - 1] as number) & 1) === 0
		) {
			throw malformed("invalid rsa exponent");
		}
		const bits = mpintBits(n);
		if (bits > MAX_RSA_BITS) {
			throw malformed(`rsa key is ${bits} bits, at most ${MAX_RSA_BITS}`);
		}
		if (bits < MIN_RSA_BITS) {
			throw new SshKeyError(
				"rsa_too_short",
				`rsa key is ${bits} bits, at least ${MIN_RSA_BITS} required`,
			);
		}
	} else {
		const curve = EC_CURVES[type] as (typeof EC_CURVES)[string];
		if (r.text() !== curve.name) throw malformed("curve does not match type");
		const q = r.bytes();
		if (q.length !== 1 + 2 * curve.coord || q[0] !== 4) {
			throw malformed("ecdsa point must be uncompressed");
		}
		try {
			// OpenSSL rejects points that are not on the curve.
			createPublicKey({
				key: {
					kty: "EC",
					crv: curve.jwk,
					x: q.subarray(1, 1 + curve.coord).toString("base64url"),
					y: q.subarray(1 + curve.coord).toString("base64url"),
				},
				format: "jwk",
			});
		} catch {
			throw malformed("ecdsa point is not on the curve");
		}
	}
	return r.buf.subarray(start, r.pos);
}

// --- public keys ---

export interface SshPublicKey {
	type: SshKeyType;
	/** Public key blob: what the line carries in base64. */
	blob: Buffer;
	comment: string | null;
	/** "SHA256:" + unpadded base64 of sha256(blob), as `ssh-keygen -l`. */
	fingerprint: string;
}

/** Parses one `authorized_keys`-style line without options. Throws SshKeyError. */
export function parseSshPublicKey(line: string): SshPublicKey {
	const { type: outer, b64, comment } = splitLine(line);
	const type = checkType(outer);
	const blob = decodeBase64(b64);
	const r = new Reader(blob);
	if (r.text() !== type) throw malformed("key type does not match blob");
	readKeyFields(type, r);
	r.end();
	return { type, blob, comment, fingerprint: fingerprintOf(blob) };
}

// --- CA ---

export interface SshCa {
	/** "ssh-ed25519 AAAA..." without a comment. */
	readonly publicKey: string;
	readonly fingerprint: string;
	/** Raw ed25519 signature over `data`. */
	sign(data: Buffer): Buffer;
}

const OPENSSH_MAGIC = Buffer.from("openssh-key-v1\0", "latin1");

/** Unencrypted OpenSSH ed25519 private key to a KeyObject (PROTOCOL.key). */
function parseOpenSshPrivateKey(text: string): KeyObject {
	const m =
		/-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/.exec(
			text,
		);
	const raw = Buffer.from((m?.[1] ?? "").replace(/\s+/g, ""), "base64");
	if (!raw.subarray(0, OPENSSH_MAGIC.length).equals(OPENSSH_MAGIC)) {
		throw malformed("not an openssh-key-v1 key");
	}
	const r = new Reader(raw.subarray(OPENSSH_MAGIC.length));
	const cipher = r.text();
	const kdf = r.text();
	r.bytes(); // kdf options
	if (cipher !== "none" || kdf !== "none") {
		throw new SshKeyError("encrypted", "ssh CA key must not be encrypted");
	}
	if (r.u32() !== 1) throw malformed("expected exactly one key");
	const pubBlob = r.bytes();
	const priv = new Reader(r.bytes());
	r.end();
	const check1 = priv.u32();
	const check2 = priv.u32();
	if (check1 !== check2) throw malformed("check bytes differ");
	const type = priv.text();
	if (type !== "ssh-ed25519") {
		throw new SshKeyError(
			"unsupported_type",
			`ssh CA key must be ed25519, got ${type}`,
		);
	}
	const pk = priv.bytes();
	const sk = priv.bytes(); // seed || public key
	priv.text(); // comment
	if (pk.length !== 32 || sk.length !== 64) throw malformed("bad ed25519 key");
	if (!sk.subarray(32).equals(pk) || !pubBlob.equals(ed25519Blob(pk))) {
		throw malformed("public key does not match private key");
	}
	return createPrivateKey({
		key: {
			kty: "OKP",
			crv: "Ed25519",
			d: sk.subarray(0, 32).toString("base64url"),
			x: pk.toString("base64url"),
		},
		format: "jwk",
	});
}

function ed25519Blob(pk: Buffer): Buffer {
	return Buffer.concat([str("ssh-ed25519"), str(pk)]);
}

/**
 * Loads the SSH login CA: an unencrypted ed25519 private key as PKCS#8 PEM
 * or OpenSSH format. The private key stays in a closure and never appears
 * in a serialized SshCa.
 */
export function loadSshCa(pemOrOpenSsh: string): SshCa {
	let key: KeyObject;
	if (pemOrOpenSsh.includes("-----BEGIN OPENSSH PRIVATE KEY-----")) {
		key = parseOpenSshPrivateKey(pemOrOpenSsh);
	} else {
		if (/-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(pemOrOpenSsh)) {
			throw new SshKeyError("encrypted", "ssh CA key must not be encrypted");
		}
		try {
			key = createPrivateKey(pemOrOpenSsh);
		} catch {
			throw malformed("cannot read private key");
		}
		if (key.asymmetricKeyType !== "ed25519") {
			throw new SshKeyError(
				"unsupported_type",
				`ssh CA key must be ed25519, got ${key.asymmetricKeyType}`,
			);
		}
	}
	const x = createPublicKey(key).export({ format: "jwk" }).x as string;
	const blob = ed25519Blob(Buffer.from(x, "base64url"));
	return {
		publicKey: `ssh-ed25519 ${blob.toString("base64")}`,
		fingerprint: fingerprintOf(blob),
		sign: (data) => sign(null, data, key),
	};
}

// --- certificates ---

/** Non-empty, no whitespace and no control characters. */
function isToken(s: string): boolean {
	return s.length > 0 && !/[\s\p{Cc}]/u.test(s);
}

export interface SignUserCertificateInput {
	/** User public key line; same types as parseSshPublicKey. */
	publicKey: string;
	keyId: string;
	principals: string[];
	validAfter: Date;
	validBefore: Date;
	/** Defaults to 8 random bytes. */
	serial?: bigint;
}

function toUnixSeconds(d: Date, what: string): bigint {
	const ms = d.getTime();
	if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`invalid ${what}`);
	return BigInt(Math.floor(ms / 1000));
}

/** Signs an OpenSSH user certificate (PROTOCOL.certkeys) with the ed25519 CA. */
export function signUserCertificate(
	ca: SshCa,
	input: SignUserCertificateInput,
): { certificate: string; serial: bigint } {
	const key = parseSshPublicKey(input.publicKey);
	// An empty principal list means "any principal" to OpenSSH.
	if (input.principals.length === 0 || !input.principals.every(isToken)) {
		throw new RangeError(
			"principals must be non-empty, without spaces or controls",
		);
	}
	if (!isToken(input.keyId)) {
		throw new RangeError(
			"key id must be non-empty, without spaces or controls",
		);
	}
	const after = toUnixSeconds(input.validAfter, "validAfter");
	const before = toUnixSeconds(input.validBefore, "validBefore");
	if (before <= after)
		throw new RangeError("validBefore must be after validAfter");
	const serial = input.serial ?? randomBytes(8).readBigUInt64BE();
	if (serial < 0n || serial >= 1n << 64n) {
		throw new RangeError("serial must fit in uint64");
	}

	const certType = `${key.type}${CERT_SUFFIX}`;
	// Key fields of the blob follow its type string.
	const keyFields = key.blob.subarray(4 + key.type.length);
	const caBlob = decodeBase64(ca.publicKey.split(" ")[1] ?? "");
	const body = Buffer.concat([
		str(certType),
		str(randomBytes(32)), // nonce
		keyFields,
		u64(serial),
		u32(SSH_CERT_TYPE_USER),
		str(input.keyId),
		str(Buffer.concat(input.principals.map((p) => str(p)))),
		u64(after),
		u64(before),
		str(Buffer.alloc(0)), // critical options
		str(Buffer.concat(USER_CERT_EXTENSIONS.flatMap((e) => [str(e), str("")]))),
		str(Buffer.alloc(0)), // reserved
		str(caBlob),
	]);
	const signature = str(
		Buffer.concat([str("ssh-ed25519"), str(ca.sign(body))]),
	);
	const blob = Buffer.concat([body, signature]);
	return {
		certificate: `${certType} ${blob.toString("base64")} ${input.keyId}`,
		serial,
	};
}

export interface SshUserCertificate {
	/** Certificate type, e.g. "ssh-ed25519-cert-v01@openssh.com". */
	type: string;
	/** Certified user key: "<type> <base64>". */
	publicKey: string;
	keyId: string;
	principals: string[];
	serial: bigint;
	validAfter: Date;
	validBefore: Date;
	criticalOptions: string[];
	extensions: string[];
	/** Signing CA: "ssh-ed25519 <base64>". */
	signatureKey: string;
}

const MAX_DATE_SECONDS = 8_640_000_000_000n;

function fromUnixSeconds(s: bigint): Date {
	return new Date(Number(s < MAX_DATE_SECONDS ? s : MAX_DATE_SECONDS) * 1000);
}

function readNames(buf: Buffer): string[] {
	const r = new Reader(buf);
	const names: string[] = [];
	while (r.pos < buf.length) {
		names.push(r.text());
		r.bytes(); // data
	}
	return names;
}

/**
 * Parses an OpenSSH user certificate line and checks that it was signed by
 * its own embedded signature key (ed25519 only). This does NOT establish
 * trust: the caller must compare `signatureKey` with the trusted CA public
 * key. Validity times are not checked either.
 */
export function parseUserCertificate(line: string): SshUserCertificate {
	const { type: certType, b64 } = splitLine(line);
	if (!certType.endsWith(CERT_SUFFIX)) throw malformed("not a certificate");
	const keyType = certType.slice(0, -CERT_SUFFIX.length);
	if (!(SSH_KEY_TYPES as readonly string[]).includes(keyType)) {
		throw new SshKeyError(
			"unsupported_type",
			`unsupported key type: ${keyType}`,
		);
	}
	const blob = decodeBase64(b64);
	const r = new Reader(blob);
	if (r.text() !== certType)
		throw malformed("certificate type does not match blob");
	r.bytes(); // nonce
	const keyFields = readKeyFields(keyType as SshKeyType, r);
	const serial = r.u64();
	if (r.u32() !== SSH_CERT_TYPE_USER) throw malformed("not a user certificate");
	const keyId = r.text();
	const pr = new Reader(r.bytes());
	const principals: string[] = [];
	while (pr.pos < pr.buf.length) principals.push(pr.text());
	const validAfter = fromUnixSeconds(r.u64());
	const validBefore = fromUnixSeconds(r.u64());
	const criticalOptions = readNames(r.bytes());
	const extensions = readNames(r.bytes());
	r.bytes(); // reserved
	const caBlob = r.bytes();
	const signed = blob.subarray(0, r.pos);
	const sig = new Reader(r.bytes());
	r.end();

	const ca = new Reader(caBlob);
	if (ca.text() !== "ssh-ed25519") {
		throw new SshKeyError("unsupported_type", "only ed25519 CAs are supported");
	}
	const caPk = ca.bytes();
	ca.end();
	if (caPk.length !== 32) throw malformed("bad ed25519 CA key");
	if (sig.text() !== "ssh-ed25519") throw malformed("signature type mismatch");
	const sigBytes = sig.bytes();
	sig.end();
	const caKey = createPublicKey({
		key: { kty: "OKP", crv: "Ed25519", x: caPk.toString("base64url") },
		format: "jwk",
	});
	if (sigBytes.length !== 64 || !verify(null, signed, caKey, sigBytes)) {
		throw new SshKeyError("bad_signature", "certificate signature is invalid");
	}

	const userBlob = Buffer.concat([str(keyType), keyFields]);
	return {
		type: certType,
		publicKey: `${keyType} ${userBlob.toString("base64")}`,
		keyId,
		principals,
		serial,
		validAfter,
		validBefore,
		criticalOptions,
		extensions,
		signatureKey: `ssh-ed25519 ${caBlob.toString("base64")}`,
	};
}

// --- host keys ---

/**
 * Gateway host keys from SBX_SSH_HOST_KEYS_FILE: public key lines
 * ("<type> <base64> [comment]"), blank lines and "#" comments allowed.
 * Returns "<type> <base64>" per key. Any private key is an error.
 */
export function loadSshHostKeys(text: string): string[] {
	if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(text)) {
		throw new SshKeyError(
			"private_key",
			"host keys file must contain only public keys",
		);
	}
	const out: string[] = [];
	for (const raw of text.split("\n")) {
		const l = raw.trim();
		if (l === "" || l.startsWith("#")) continue;
		const k = parseSshPublicKey(l);
		out.push(`${k.type} ${k.blob.toString("base64")}`);
	}
	return out;
}
