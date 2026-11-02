import { withTx } from "@umiak/db";
import { invalidState, type ValidationIssue, validation } from "../errors.ts";
import type { Principal } from "../principal.ts";
import type { Sandbox } from "../rows.ts";
import {
	applySecretPatch,
	type SecretFile,
	type SecretPatch,
	type SecretSets,
	validateSecretSets,
} from "../secrets.ts";
import {
	findSandboxRow,
	type SandboxServiceDeps,
	toSandbox,
} from "./common.ts";
import {
	checkSecretPatch,
	readSandboxSecrets,
	writeSandboxSecrets,
} from "./secret-patch.ts";
import { checkKnownKeys, isPlainObject } from "./validate.ts";

// Env, secrets and secret files of a sandbox (S7 §8.3, S8 C2): read, replace
// (`PUT /env`) and patch (`PATCH /env`). Writes run under the sandbox row lock,
// check the S7 limits on the resulting sets and are not allowed in
// `deleting`/`deleted`. Delivery to a running agent is S7's job.

export interface EnvReplaceInput {
	env?: Record<string, string>;
	secrets?: Record<string, string>;
	secretFiles?: SecretFile[];
}

export interface EnvUpdateResult {
	sandbox: Sandbox;
	sets: SecretSets;
}

const ENV_KEYS = ["env", "secrets", "secretFiles"];

function checkInputObject(input: unknown): void {
	if (!isPlainObject(input)) {
		throw validation([{ path: "", message: "must be an object" }]);
	}
	const issues: ValidationIssue[] = [];
	checkKnownKeys(input, ENV_KEYS, issues);
	if (issues.length > 0) throw validation(issues);
}

export async function getEnv(
	deps: SandboxServiceDeps,
	p: Principal,
	idOrSlug: string,
): Promise<SecretSets> {
	const row = await findSandboxRow(deps.pool, p, idOrSlug);
	return readSandboxSecrets(deps.pool, deps.keys, row.id);
}

async function updateSets(
	deps: SandboxServiceDeps,
	p: Principal,
	idOrSlug: string,
	next: (cur: SecretSets) => SecretSets,
): Promise<EnvUpdateResult> {
	return withTx(deps.pool, async (tx) => {
		const row = await findSandboxRow(tx.client, p, idOrSlug, {
			lock: true,
			write: true,
		});
		if (row.state === "deleting" || row.state === "deleted") {
			throw invalidState(row.state);
		}
		const sets = next(await readSandboxSecrets(tx.client, deps.keys, row.id));
		validateSecretSets(sets);
		await writeSandboxSecrets(tx, deps.keys, row.id, sets);
		return { sandbox: await toSandbox(tx.client, row), sets };
	});
}

/** Each given set replaces the stored one whole; the others stay. */
export async function replaceEnv(
	deps: SandboxServiceDeps,
	p: Principal,
	idOrSlug: string,
	input: EnvReplaceInput,
): Promise<EnvUpdateResult> {
	checkInputObject(input);
	// A given null is checked (and rejected) as the new set.
	return updateSets(deps, p, idOrSlug, (cur) => ({
		env: input.env !== undefined ? input.env : cur.env,
		secrets: input.secrets !== undefined ? input.secrets : cur.secrets,
		secretFiles:
			input.secretFiles !== undefined ? input.secretFiles : cur.secretFiles,
	}));
}

/** `{K: v | null}` per set, secret files by name; `null` deletes. */
export async function patchEnv(
	deps: SandboxServiceDeps,
	p: Principal,
	idOrSlug: string,
	patch: SecretPatch,
): Promise<EnvUpdateResult> {
	checkInputObject(patch);
	const issues: ValidationIssue[] = [];
	checkSecretPatch(patch, issues);
	if (issues.length > 0) throw validation(issues);
	return updateSets(deps, p, idOrSlug, (cur) => applySecretPatch(cur, patch));
}
