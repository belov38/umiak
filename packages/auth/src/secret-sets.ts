// Env and secrets of a sandbox or an environment (S7 §8.3, S8 §10) and the
// patch rules shared by fork, resume, `PATCH /env` and environments. Lives in
// auth so that the environments store and @umiak/core (which re-exports it) use
// one implementation; limits and encryption stay in core.

export interface SecretFile {
	name: string;
	contentBase64: string;
	/** File mode; SECRET_FILE_DEFAULT_MODE (0o440) of core when absent. */
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
 * sandbox's own; environments: the stored sets). Same key: the patch wins;
 * files match by name and are replaced whole; `null` deletes. Existing files
 * keep their order, new ones are appended. Limits are checked on the result
 * by `validateSecretSets` of core.
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
