import type { Tx } from "@sbx/db";
import type { ValidationIssue } from "../errors.ts";
import {
	type EncryptedBlob,
	emptySecretSets,
	type KeyRing,
	type SecretPatch,
	type SecretSets,
} from "../secrets.ts";
import type { Queryable } from "./common.ts";
import { isPlainObject } from "./validate.ts";

// Patch of env, secrets and secret files on fork and resume (S6 §7.6, §7.7,
// S7 §8.2): `{K: v | null}` and `{<name>: {contentBase64, mode?, linkPath?} | null}`.
// Shapes are checked here; names and limits are checked on the merged sets by
// `validateSecretSets`. Messages never include values.

const FILE_KEYS = ["contentBase64", "mode", "linkPath"];

function checkVarPatch(
	path: string,
	v: unknown,
	issues: ValidationIssue[],
): void {
	if (!isPlainObject(v)) {
		issues.push({
			path,
			message: "must be an object of string or null values",
		});
		return;
	}
	for (const [k, val] of Object.entries(v)) {
		if (val !== null && typeof val !== "string") {
			issues.push({
				path: `${path}.${k}`,
				message: "value must be a string or null",
			});
		}
	}
}

function checkFilePatch(v: unknown, issues: ValidationIssue[]): void {
	if (!isPlainObject(v)) {
		issues.push({
			path: "secretFiles",
			message:
				"must be an object of {contentBase64, mode?, linkPath?} or null by file name",
		});
		return;
	}
	for (const [name, f] of Object.entries(v)) {
		if (f === null) continue;
		const p = `secretFiles.${name}`;
		if (!isPlainObject(f)) {
			issues.push({ path: p, message: "must be an object or null" });
			continue;
		}
		for (const k of Object.keys(f)) {
			if (!FILE_KEYS.includes(k)) {
				issues.push({ path: `${p}.${k}`, message: "unknown field" });
			}
		}
		if (typeof f.contentBase64 !== "string") {
			issues.push({ path: `${p}.contentBase64`, message: "must be a string" });
		}
	}
}

/** Pushes issues for the patch fields present in `input`. */
export function checkSecretPatch(
	input: SecretPatch,
	issues: ValidationIssue[],
): void {
	if (input.env !== undefined) checkVarPatch("env", input.env, issues);
	if (input.secrets !== undefined)
		checkVarPatch("secrets", input.secrets, issues);
	if (input.secretFiles !== undefined)
		checkFilePatch(input.secretFiles, issues);
}

/** The patch part of an input, or null when it has none of the three fields. */
export function pickSecretPatch(input: SecretPatch): SecretPatch | null {
	const patch: SecretPatch = {};
	if (input.env !== undefined) patch.env = input.env;
	if (input.secrets !== undefined) patch.secrets = input.secrets;
	if (input.secretFiles !== undefined) patch.secretFiles = input.secretFiles;
	return Object.keys(patch).length === 0 ? null : patch;
}

/** Decrypted sets of a sandbox; empty if it has no row. */
export async function readSandboxSecrets(
	q: Queryable,
	keys: KeyRing,
	sandboxId: string,
): Promise<SecretSets> {
	const r = await q.query<{
		key_version: number;
		nonce: Buffer;
		ciphertext: Buffer;
	}>(
		"SELECT key_version, nonce, ciphertext FROM runtime.sandbox_secrets WHERE sandbox_id = $1",
		[sandboxId],
	);
	const row = r.rows[0];
	if (!row) return emptySecretSets();
	return keys.decrypt(sandboxId, {
		keyVersion: row.key_version,
		nonce: row.nonce,
		ciphertext: row.ciphertext,
	});
}

/** Encrypts the sets with the sandbox's AAD and upserts its row. */
export async function writeSandboxSecrets(
	tx: Tx,
	keys: KeyRing,
	sandboxId: string,
	sets: SecretSets,
): Promise<void> {
	const blob: EncryptedBlob = keys.encrypt(sandboxId, sets);
	await tx.client.query(
		`INSERT INTO runtime.sandbox_secrets (sandbox_id, key_version, nonce, ciphertext)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (sandbox_id) DO UPDATE
		   SET key_version = EXCLUDED.key_version, nonce = EXCLUDED.nonce,
		       ciphertext = EXCLUDED.ciphertext, updated_at = now()`,
		[sandboxId, blob.keyVersion, blob.nonce, blob.ciphertext],
	);
}
