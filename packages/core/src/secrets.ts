import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { type ValidationIssue, validation } from "./errors.ts";

// Env and secrets of a sandbox (S7 §8.3) and their encryption at rest (S6 §13.1).
// Values must never be logged; error messages here never include them.

export interface SecretFile {
	name: string;
	contentBase64: string;
	/** File mode; SECRET_FILE_DEFAULT_MODE (0o440) when absent. */
	mode?: number;
	/** Absolute path of a symlink to the file in the guest. */
	linkPath?: string;
}

export interface SecretSets {
	env: Record<string, string>;
	secrets: Record<string, string>;
	secretFiles: SecretFile[];
}

/** Patch shape of fork, resume and `PATCH /env` (S7 §8.2): `null` deletes. */
export interface SecretPatch {
	env?: Record<string, string | null>;
	secrets?: Record<string, string | null>;
	secretFiles?: Record<string, Omit<SecretFile, "name"> | null>;
}

export const SECRET_FILE_DEFAULT_MODE = 0o440;

export const SECRET_LIMITS = {
	varsPerSet: 100,
	valueBytes: 32 * 1024,
	setBytes: 256 * 1024,
	files: 32,
	fileBytes: 1024 * 1024,
	filesTotalBytes: 8 * 1024 * 1024,
} as const;

/** `SBX_` names a sandbox may still set: the variables of the `sbx` CLI (S7 §14.1). */
export const ALLOWED_SBX_VARS: readonly string[] = [
	"SBX_API_KEY",
	"SBX_API_URL",
	"SBX_TEAM",
	"SBX_PROFILE",
];

const VAR_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const FILE_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;
const BASE64_RE =
	/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
// Linux guests use POSIX paths, Windows guests drive-absolute paths.
const ABS_PATH_RE = /^(?:\/|[A-Za-z]:[\\/])/;

export function emptySecretSets(): SecretSets {
	return { env: {}, secrets: {}, secretFiles: [] };
}

function mergeVars(
	base: Record<string, string>,
	patch: Record<string, string | null> | undefined,
): Record<string, string> {
	// A Map avoids `__proto__` surprises: the key grammar allows that name.
	const m = new Map(Object.entries(base));
	for (const [k, v] of Object.entries(patch ?? {})) {
		if (v === null) m.delete(k);
		else m.set(k, v);
	}
	return Object.fromEntries(m);
}

function copyFile(name: string, f: Omit<SecretFile, "name">): SecretFile {
	const out: SecretFile = { name, contentBase64: f.contentBase64 };
	if (f.mode !== undefined) out.mode = f.mode;
	if (f.linkPath !== undefined) out.linkPath = f.linkPath;
	return out;
}

/**
 * Overlays a patch on inherited sets (fork: the source's sets; resume: the
 * sandbox's own). Same key: the patch wins; files match by name and are
 * replaced whole; `null` deletes. Existing files keep their order, new ones
 * are appended. Limits are checked on the result by `validateSecretSets`.
 */
export function applySecretPatch(
	base: SecretSets,
	patch: SecretPatch,
): SecretSets {
	const files = new Map(
		base.secretFiles.map((f) => [f.name, copyFile(f.name, f)]),
	);
	for (const [name, f] of Object.entries(patch.secretFiles ?? {})) {
		if (f === null) files.delete(name);
		else files.set(name, copyFile(name, f));
	}
	return {
		env: mergeVars(base.env, patch.env),
		secrets: mergeVars(base.secrets, patch.secrets),
		secretFiles: [...files.values()],
	};
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkVars(
	path: string,
	set: unknown,
	issues: ValidationIssue[],
): void {
	if (!isPlainObject(set)) {
		issues.push({ path, message: "must be an object of string values" });
		return;
	}
	const entries = Object.entries(set);
	if (entries.length > SECRET_LIMITS.varsPerSet) {
		issues.push({
			path,
			message: `at most ${SECRET_LIMITS.varsPerSet} variables allowed`,
		});
	}
	let total = 0;
	for (const [k, v] of entries) {
		const p = `${path}.${k}`;
		if (!VAR_KEY_RE.test(k)) {
			issues.push({
				path: p,
				message: "name must match [A-Za-z_][A-Za-z0-9_]{0,127}",
			});
		} else if (k.startsWith("SBX_") && !ALLOWED_SBX_VARS.includes(k)) {
			issues.push({
				path: p,
				message: "the SBX_ prefix is reserved by the platform",
			});
		}
		if (typeof v !== "string") {
			issues.push({ path: p, message: "value must be a string" });
			continue;
		}
		const bytes = Buffer.byteLength(v, "utf8");
		if (bytes > SECRET_LIMITS.valueBytes) {
			issues.push({ path: p, message: "value must be at most 32 KiB" });
		}
		if (v.includes("\0"))
			issues.push({ path: p, message: "value must not contain NUL" });
		total += Buffer.byteLength(k, "utf8") + bytes;
	}
	if (total > SECRET_LIMITS.setBytes) {
		issues.push({
			path,
			message: "names and values must total at most 256 KiB",
		});
	}
}

function base64DecodedLength(s: string): number {
	const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
	return (s.length / 4) * 3 - pad;
}

function checkFiles(files: unknown, issues: ValidationIssue[]): void {
	if (!Array.isArray(files)) {
		issues.push({ path: "secretFiles", message: "must be an array" });
		return;
	}
	if (files.length > SECRET_LIMITS.files) {
		issues.push({
			path: "secretFiles",
			message: `at most ${SECRET_LIMITS.files} files allowed`,
		});
	}
	const seen = new Set<string>();
	let total = 0;
	files.forEach((f: unknown, i) => {
		const p = `secretFiles[${i}]`;
		if (!isPlainObject(f)) {
			issues.push({ path: p, message: "must be an object" });
			return;
		}
		const { name, contentBase64, mode, linkPath } = f;
		if (
			typeof name !== "string" ||
			!FILE_NAME_RE.test(name) ||
			name === "." ||
			name === ".."
		) {
			issues.push({
				path: `${p}.name`,
				message: "name must match [A-Za-z0-9._-]{1,128}",
			});
		} else if (seen.has(name)) {
			issues.push({ path: `${p}.name`, message: "duplicate file name" });
		} else {
			seen.add(name);
		}
		if (typeof contentBase64 !== "string" || !BASE64_RE.test(contentBase64)) {
			issues.push({
				path: `${p}.contentBase64`,
				message: "must be standard base64",
			});
		} else {
			const size = base64DecodedLength(contentBase64);
			if (size > SECRET_LIMITS.fileBytes) {
				issues.push({
					path: `${p}.contentBase64`,
					message: "file must be at most 1 MiB",
				});
			}
			total += size;
		}
		if (
			mode !== undefined &&
			(!Number.isInteger(mode) ||
				(mode as number) < 0 ||
				(mode as number) > 0o777)
		) {
			issues.push({
				path: `${p}.mode`,
				message: "mode must be an integer in 0..0o777",
			});
		}
		if (
			linkPath !== undefined &&
			(typeof linkPath !== "string" ||
				!ABS_PATH_RE.test(linkPath) ||
				linkPath.includes("\0") ||
				linkPath.length > 4096)
		) {
			issues.push({
				path: `${p}.linkPath`,
				message: "linkPath must be an absolute path",
			});
		}
	});
	if (total > SECRET_LIMITS.filesTotalBytes) {
		issues.push({
			path: "secretFiles",
			message: "files must total at most 8 MiB",
		});
	}
}

/**
 * Checks the S7 §8.3 limits. Set totals count UTF-8 bytes of names and values.
 * Throws SbxError `validation` with `details.issues[] {path, message}`.
 */
export function validateSecretSets(s: SecretSets): void {
	const issues: ValidationIssue[] = [];
	checkVars("env", s.env, issues);
	checkVars("secrets", s.secrets, issues);
	checkFiles(s.secretFiles, issues);
	if (issues.length > 0) throw validation(issues);
}

export interface EncryptedBlob {
	keyVersion: number;
	/** 12-byte random GCM nonce. */
	nonce: Buffer;
	/** GCM ciphertext followed by the 16-byte auth tag. */
	ciphertext: Buffer;
}

export interface KeyRingSpec {
	current: number;
	keys: Record<string, string>;
}

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/**
 * AES-256-GCM key ring (S6 §13.1), file `SBX_DATA_KEYS_FILE`:
 * `{"current": 2, "keys": {"1": "<base64>", "2": "<base64>"}}`.
 * New records use `current`; any listed version decrypts. AAD binds the record
 * to its owner and key version: `<prefix>:<id>:v<keyVersion>`.
 */
export class KeyRing {
	readonly currentVersion: number;
	readonly #keys: Map<number, Buffer>;

	private constructor(current: number, keys: Map<number, Buffer>) {
		this.currentVersion = current;
		this.#keys = keys;
	}

	static fromFile(path: string): KeyRing {
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(path, "utf8"));
		} catch (e) {
			throw new Error(`KeyRing: cannot read key file ${path}`, { cause: e });
		}
		return KeyRing.fromObject(raw as KeyRingSpec);
	}

	static fromObject(spec: KeyRingSpec): KeyRing {
		if (!isPlainObject(spec) || !isPlainObject(spec.keys)) {
			throw new Error("KeyRing: expected {current, keys}");
		}
		const keys = new Map<number, Buffer>();
		for (const [ver, b64] of Object.entries(spec.keys)) {
			if (!/^[1-9][0-9]{0,8}$/.test(ver)) {
				throw new Error(
					`KeyRing: key version must be a positive integer, got '${ver}'`,
				);
			}
			if (typeof b64 !== "string" || !BASE64_RE.test(b64)) {
				throw new Error(`KeyRing: key ${ver} is not base64`);
			}
			const key = Buffer.from(b64, "base64");
			if (key.length !== KEY_BYTES) {
				throw new Error(
					`KeyRing: key ${ver} must be 32 bytes, got ${key.length}`,
				);
			}
			keys.set(Number(ver), key);
		}
		if (!Number.isInteger(spec.current) || !keys.has(spec.current)) {
			throw new Error(
				`KeyRing: current version ${String(spec.current)} is not in keys`,
			);
		}
		return new KeyRing(spec.current, keys);
	}

	/** Key versions in the ring, ascending. */
	get versions(): number[] {
		return [...this.#keys.keys()].sort((a, b) => a - b);
	}

	encryptFor(
		aadPrefix: string,
		id: string,
		plaintext: Uint8Array | string,
	): EncryptedBlob {
		const keyVersion = this.currentVersion;
		const key = this.#key(keyVersion);
		const nonce = randomBytes(NONCE_BYTES);
		const cipher = createCipheriv("aes-256-gcm", key, nonce, {
			authTagLength: TAG_BYTES,
		});
		cipher.setAAD(Buffer.from(aad(aadPrefix, id, keyVersion), "utf8"));
		const body =
			typeof plaintext === "string"
				? Buffer.from(plaintext, "utf8")
				: plaintext;
		const ciphertext = Buffer.concat([
			cipher.update(body),
			cipher.final(),
			cipher.getAuthTag(),
		]);
		return { keyVersion, nonce, ciphertext };
	}

	decryptFor(
		aadPrefix: string,
		id: string,
		blob: { keyVersion: number; nonce: Uint8Array; ciphertext: Uint8Array },
	): Buffer {
		const key = this.#key(blob.keyVersion);
		if (
			blob.nonce.length !== NONCE_BYTES ||
			blob.ciphertext.length < TAG_BYTES
		) {
			throw new Error("KeyRing: malformed encrypted record");
		}
		const ct = Buffer.from(blob.ciphertext);
		const tag = ct.subarray(ct.length - TAG_BYTES);
		try {
			const decipher = createDecipheriv("aes-256-gcm", key, blob.nonce, {
				authTagLength: TAG_BYTES,
			});
			decipher.setAAD(Buffer.from(aad(aadPrefix, id, blob.keyVersion), "utf8"));
			decipher.setAuthTag(tag);
			return Buffer.concat([
				decipher.update(ct.subarray(0, ct.length - TAG_BYTES)),
				decipher.final(),
			]);
		} catch (e) {
			throw new Error(
				"KeyRing: decryption failed (wrong key, owner or corrupted record)",
				{
					cause: e,
				},
			);
		}
	}

	/** Encrypts the sets of a sandbox with AAD `sandbox:<sandboxId>:v<keyVersion>`. */
	encrypt(sandboxId: string, sets: SecretSets): EncryptedBlob {
		return this.encryptFor("sandbox", sandboxId, JSON.stringify(sets));
	}

	decrypt(
		sandboxId: string,
		row: { keyVersion: number; nonce: Uint8Array; ciphertext: Uint8Array },
	): SecretSets {
		const parsed = JSON.parse(
			this.decryptFor("sandbox", sandboxId, row).toString("utf8"),
		) as Partial<SecretSets>;
		return {
			env: parsed.env ?? {},
			secrets: parsed.secrets ?? {},
			secretFiles: parsed.secretFiles ?? [],
		};
	}

	#key(version: number): Buffer {
		const key = this.#keys.get(version);
		if (key === undefined)
			throw new Error(`KeyRing: unknown key version ${version}`);
		return key;
	}
}

function aad(prefix: string, id: string, version: number): string {
	return `${prefix}:${id}:v${version}`;
}
