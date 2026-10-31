// The environment form (S8 §10.1, §10.2) without the DOM: its state, the
// body of POST /v1/environments and the merge patch of PATCH. Secret values
// are write-only: the API never returns them, the form only sends what was
// typed, and a removed secret or file is sent as null. Repositories are
// checked like the API does (no credentials, query or fragment in the URL)
// and replace the stored list whole.
import type { components } from "@sbx/sdk";
import {
	envSet,
	type FormErrors,
	type KvRow,
	type SecretFileDraft,
	secretFiles,
} from "./create-form";

export type EnvironmentSummary = components["schemas"]["EnvironmentSummary"];
export type EnvironmentDetail = components["schemas"]["Environment"];
export type CreateEnvironmentInput =
	components["schemas"]["CreateEnvironmentRequest"];
export type EnvironmentPatch =
	components["schemas"]["UpdateEnvironmentRequest"];

export interface RepositoryRow {
	url: string;
	/** Branch or tag; "" for the remote's default. */
	branch: string;
	/** Relative to the home of `user`; "" for the repository name. */
	path: string;
}

export interface EnvironmentFormState {
	name: string;
	isDefault: boolean;
	excludeOwnerSecrets: boolean;
	/** Every env variable with its value (an edit starts from GET of one). */
	env: KvRow[];
	/** Secrets to set: new names or new values of existing ones. */
	secrets: KvRow[];
	/** Existing secret names to delete (edit only). */
	removedSecrets: string[];
	/** Files to add or replace (by name). */
	secretFiles: SecretFileDraft[];
	/** Existing secret file names to delete (edit only). */
	removedSecretFiles: string[];
	repositories: RepositoryRow[];
}

export const MAX_REPOSITORIES = 20;

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCP_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s:][^\s]*$/;

const blankKv = (): KvRow => ({ key: "", value: "" });
const blankRepo = (): RepositoryRow => ({ url: "", branch: "", path: "" });

export function emptyEnvironmentForm(): EnvironmentFormState {
	return {
		name: "",
		isDefault: false,
		excludeOwnerSecrets: false,
		env: [blankKv()],
		secrets: [blankKv()],
		removedSecrets: [],
		secretFiles: [],
		removedSecretFiles: [],
		repositories: [blankRepo()],
	};
}

/** The edit form of an environment read with GET of one (env values, no secrets). */
export function formFromEnvironment(
	e: EnvironmentDetail,
): EnvironmentFormState {
	const env = Object.keys(e.env)
		.sort()
		.map((key) => ({ key, value: e.env[key] ?? "" }));
	return {
		name: e.name,
		isDefault: e.isDefault,
		excludeOwnerSecrets: e.excludeOwnerSecrets,
		env: env.length === 0 ? [blankKv()] : env,
		secrets: [blankKv()],
		removedSecrets: [],
		secretFiles: [],
		removedSecretFiles: [],
		repositories:
			e.repositories.length === 0
				? [blankRepo()]
				: e.repositories.map((r) => ({
						url: r.url,
						branch: r.branch ?? "",
						path: r.path ?? "",
					})),
	};
}

/** Why the name is not valid (S8 §10.2), or null. */
export function environmentNameProblem(name: string): string | null {
	if (!NAME_RE.test(name)) {
		return "Lowercase letters, digits and '-', starting with a letter or digit, up to 63 characters";
	}
	if (UUID_RE.test(name)) return "Must not look like a UUID";
	return null;
}

/**
 * `https://host/...`, `ssh://[user@]host/...` or `user@host:path`, without a
 * password, a token, a query or a fragment: every reader of the environment
 * sees the URL (the same rules as the API).
 */
export function repositoryUrlProblem(url: string): string | null {
	if (url === "") return "URL is missing";
	if (url.length > 2048) return "At most 2048 characters";
	if (url.includes("?") || url.includes("#")) {
		return "No query (?) or fragment (#): tokens do not belong in the URL";
	}
	if (SCP_RE.test(url) && !url.includes("://")) return null;
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return "An https://, ssh:// or user@host:path URL";
	}
	if (u.protocol !== "https:" && u.protocol !== "ssh:") {
		return "An https://, ssh:// or user@host:path URL";
	}
	if (u.hostname === "") return "The URL must name a host";
	if (u.password !== "" || (u.protocol === "https:" && u.username !== "")) {
		return "No credentials in the URL (git credentials come later)";
	}
	return null;
}

function repositoryBranchProblem(branch: string): string | null {
	if (branch.length > 255) return "At most 255 characters";
	return /[\s\0]/.test(branch) ? "No spaces" : null;
}

function repositoryPathProblem(path: string): string | null {
	if (path.length > 1024) return "At most 1024 characters";
	if (path.includes("\0")) return "Not a valid path";
	if (path.startsWith("/")) return "Relative to the user's home";
	if (path.split("/").some((s) => s === "..")) return "Must not contain ..";
	return null;
}

type Repository = NonNullable<CreateEnvironmentInput["repositories"]>[number];

/** Rows → the repository list; blank rows dropped, problems into `errors`. */
function repositoryList(
	rows: RepositoryRow[],
	errors: FormErrors,
): Repository[] {
	const out: Repository[] = [];
	rows.forEach((r, i) => {
		const url = r.url.trim();
		const branch = r.branch.trim();
		const path = r.path.trim();
		if (url === "" && branch === "" && path === "") return;
		const at = `repositories.${i}`;
		const problems: [string, string | null][] = [
			["url", repositoryUrlProblem(url)],
			["branch", branch === "" ? null : repositoryBranchProblem(branch)],
			["path", path === "" ? null : repositoryPathProblem(path)],
		];
		for (const [field, p] of problems) {
			if (p !== null) errors[`${at}.${field}`] = p;
		}
		out.push({
			url,
			...(branch === "" ? {} : { branch }),
			...(path === "" ? {} : { path }),
		});
	});
	if (out.length > MAX_REPOSITORIES) {
		errors.repositories = `At most ${MAX_REPOSITORIES} repositories`;
	}
	return out;
}

/** Secrets to set; a name without a value is a mistake, not a deletion. */
function secretSet(
	rows: KvRow[],
	errors: FormErrors,
): Record<string, string> | undefined {
	rows.forEach((r, i) => {
		if (r.key.trim() !== "" && r.value === "") {
			errors[`secrets.${i}`] = "Value is missing";
		}
	});
	return envSet("secrets", rows, errors);
}

function nameOf(f: EnvironmentFormState, errors: FormErrors): string {
	const name = f.name.trim();
	const p = environmentNameProblem(name);
	if (p !== null) errors.name = p;
	return name;
}

export type FormResult<T> =
	| { ok: true; body: T }
	| { ok: false; errors: FormErrors };

/** The body of POST /v1/environments, or the problems per field. */
export function toCreateEnvironmentRequest(
	f: EnvironmentFormState,
): FormResult<CreateEnvironmentInput> {
	const errors: FormErrors = {};
	const body: CreateEnvironmentInput = { name: nameOf(f, errors) };
	if (f.isDefault) body.isDefault = true;
	if (f.excludeOwnerSecrets) body.excludeOwnerSecrets = true;
	const env = envSet("env", f.env, errors);
	if (env) body.env = env;
	const secrets = secretSet(f.secrets, errors);
	if (secrets) body.secrets = secrets;
	const files = secretFiles(f.secretFiles, errors);
	if (files) body.secretFiles = files;
	const repos = repositoryList(f.repositories, errors);
	if (repos.length > 0) body.repositories = repos;
	return Object.keys(errors).length > 0
		? { ok: false, errors }
		: { ok: true, body };
}

function sameRepositories(a: Repository[], b: Repository[]): boolean {
	const key = (r: Repository) =>
		JSON.stringify([r.url, r.branch ?? "", r.path ?? ""]);
	return (
		a.length === b.length &&
		a.every((r, i) => key(r) === key(b[i] as Repository))
	);
}

/**
 * The merge patch of PATCH /v1/environments/{id} against the environment
 * as read (S8 §10.2): only what changed; `null` deletes a key or a file;
 * repositories whole when they changed. `empty`: nothing to send.
 */
export function toEnvironmentPatch(
	orig: EnvironmentDetail,
	f: EnvironmentFormState,
):
	| { ok: true; body: EnvironmentPatch; empty: boolean }
	| { ok: false; errors: FormErrors } {
	const errors: FormErrors = {};
	const body: EnvironmentPatch = {};
	const name = nameOf(f, errors);
	if (name !== orig.name) body.name = name;
	if (f.isDefault !== orig.isDefault) body.isDefault = f.isDefault;
	if (f.excludeOwnerSecrets !== orig.excludeOwnerSecrets) {
		body.excludeOwnerSecrets = f.excludeOwnerSecrets;
	}

	const env = envSet("env", f.env, errors) ?? {};
	const envPatch: Record<string, string | null> = {};
	for (const k of Object.keys(orig.env)) {
		if (!(k in env)) envPatch[k] = null;
	}
	for (const [k, v] of Object.entries(env)) {
		if (orig.env[k] !== v) envPatch[k] = v;
	}
	if (Object.keys(envPatch).length > 0) body.env = envPatch;

	const secrets = secretSet(f.secrets, errors) ?? {};
	const secretPatch: Record<string, string | null> = { ...secrets };
	for (const k of f.removedSecrets) {
		if (orig.secretKeys.includes(k) && !(k in secrets)) secretPatch[k] = null;
	}
	if (Object.keys(secretPatch).length > 0) body.secrets = secretPatch;

	const files = secretFiles(f.secretFiles, errors) ?? [];
	const filePatch: NonNullable<EnvironmentPatch["secretFiles"]> = {};
	for (const { name: n, ...file } of files) filePatch[n] = file;
	const existing = new Set(orig.secretFiles.map((x) => x.name));
	for (const n of f.removedSecretFiles) {
		if (existing.has(n) && !(n in filePatch)) filePatch[n] = null;
	}
	if (Object.keys(filePatch).length > 0) body.secretFiles = filePatch;

	const repos = repositoryList(f.repositories, errors);
	if (!sameRepositories(repos, orig.repositories)) body.repositories = repos;

	if (Object.keys(errors).length > 0) return { ok: false, errors };
	return { ok: true, body, empty: Object.keys(body).length === 0 };
}
