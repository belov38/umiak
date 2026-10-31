// The create-sandbox form (S8 §9.5) without the DOM: its state, the body of
// POST /v1/sandboxes and the search params of the page. Secrets, env,
// labels and secret files live only in React state and in that body; the
// URL carries the catalog choice (template, size, snapshot) and nothing else.
import type { CreateSandboxInput } from "@sbx/sdk";
import { teamPath } from "./team-path";

export interface KvRow {
	key: string;
	value: string;
}

export interface SecretFileDraft {
	/** `[A-Za-z0-9._-]{1,128}` */
	name: string;
	/** Octal as typed (`0440`); "" for the API default. */
	mode: string;
	/** Absolute path of a symlink in the guest; "" for none. */
	linkPath: string;
	contentBase64: string;
	sizeBytes: number;
}

export type EnvironmentChoice =
	| { kind: "default" }
	| { kind: "none" }
	| { kind: "named"; name: string };

/** "default": not sent (platform default); "none": null; else seconds. */
export type DurationChoice = "default" | "none" | `${number}`;

export interface CreateFormState {
	source: "template" | "snapshot";
	template: string;
	snapshot: string;
	size: string;
	name: string;
	slug: string;
	environment: EnvironmentChoice;
	labels: KvRow[];
	env: KvRow[];
	secrets: KvRow[];
	secretFiles: SecretFileDraft[];
	ttl: DurationChoice;
	idle: DurationChoice;
}

export function emptyCreateForm(): CreateFormState {
	return {
		source: "template",
		template: "",
		snapshot: "",
		size: "",
		name: "",
		slug: "",
		environment: { kind: "default" },
		labels: [{ key: "", value: "" }],
		env: [{ key: "", value: "" }],
		secrets: [{ key: "", value: "" }],
		secretFiles: [],
		ttl: "default",
		idle: "default",
	};
}

/** Limits of S7 §8.3 and the label checks of core (checked again by the API). */
export const LIMITS = {
	vars: 100,
	labels: 64,
	labelKeyChars: 128,
	labelValueChars: 256,
	nameChars: 255,
	secretFiles: 32,
	secretFileBytes: 1024 * 1024,
	secretFilesTotalBytes: 8 * 1024 * 1024,
} as const;

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** `SBX_` is reserved except the variables of the CLI (S7 §8.3). */
const SBX_ALLOWED = new Set([
	"SBX_API_KEY",
	"SBX_API_URL",
	"SBX_TEAM",
	"SBX_PROFILE",
]);
const FILE_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Why an env or secret name is not valid (S7 §8.3), or null. */
export function envKeyProblem(key: string): string | null {
	if (key === "") return "Name is missing";
	if (!ENV_KEY_RE.test(key)) {
		return "Letters, digits and _, not starting with a digit, up to 128 characters";
	}
	if (key.startsWith("SBX_") && !SBX_ALLOWED.has(key)) {
		return "The SBX_ prefix is reserved";
	}
	return null;
}

/** A secret file name the API accepts (S7 §8.3), or the problem. */
export function secretFileNameProblem(name: string): string | null {
	return FILE_NAME_RE.test(name)
		? null
		: "Letters, digits, '.', '_' and '-', up to 128 characters";
}

/** Why the slug is not valid, or null (the API also refuses reserved words). */
export function slugProblem(s: string): string | null {
	if (s.length < 3 || s.length > 40) return "3 to 40 characters";
	if (!SLUG_RE.test(s)) {
		return "lowercase letters and digits in groups separated by single '-'";
	}
	if (/-[0-9]+$/.test(s)) return "must not end with '-<digits>'";
	return null;
}

/** `0440` / `440` → 288; "" → undefined (API default); invalid → null. */
export function parseSecretFileMode(s: string): number | undefined | null {
	const t = s.trim();
	if (t === "") return undefined;
	if (!/^0?[0-7]{3}$/.test(t)) return null;
	return Number.parseInt(t, 8);
}

export function bytesToBase64(bytes: Uint8Array): string {
	let bin = "";
	const step = 0x8000;
	for (let i = 0; i < bytes.length; i += step) {
		bin += String.fromCharCode(...bytes.subarray(i, i + step));
	}
	return btoa(bin);
}

/** A file name the API accepts, from the name of an uploaded file. */
export function secretFileName(fileName: string): string {
	const cleaned = fileName.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
	return cleaned === "" ? "secret" : cleaned;
}

/** Field path (`env.2`, `slug`, `secretFiles.0.mode`) → message. */
export type FormErrors = Record<string, string>;

export type CreateRequestResult =
	| { ok: true; body: CreateSandboxInput }
	| { ok: false; errors: FormErrors };

function isBlank(r: KvRow): boolean {
	return r.key.trim() === "" && r.value === "";
}

/** Env or secret rows → a set; blank rows are dropped. */
export function envSet(
	field: "env" | "secrets",
	rows: KvRow[],
	errors: FormErrors,
): Record<string, string> | undefined {
	const out: Record<string, string> = {};
	let n = 0;
	rows.forEach((r, i) => {
		if (isBlank(r)) return;
		const key = r.key.trim();
		const at = `${field}.${i}`;
		const problem = envKeyProblem(key);
		if (problem !== null) errors[at] = problem;
		else if (key in out) errors[at] = "Duplicate name";
		else {
			out[key] = r.value;
			n++;
		}
	});
	if (n > LIMITS.vars) errors[field] = `At most ${LIMITS.vars} variables`;
	return n === 0 ? undefined : out;
}

function labelSet(
	rows: KvRow[],
	errors: FormErrors,
): Record<string, string> | undefined {
	const out: Record<string, string> = {};
	let n = 0;
	rows.forEach((r, i) => {
		const key = r.key.trim();
		const value = r.value.trim();
		if (key === "" && value === "") return;
		const at = `labels.${i}`;
		if (key === "") errors[at] = "Key is missing";
		else if (key.length > LIMITS.labelKeyChars) {
			errors[at] = `Key: at most ${LIMITS.labelKeyChars} characters`;
		} else if (value.length > LIMITS.labelValueChars) {
			errors[at] = `Value: at most ${LIMITS.labelValueChars} characters`;
		} else if (key in out) errors[at] = "Duplicate key";
		else {
			out[key] = value;
			n++;
		}
	});
	if (n > LIMITS.labels) errors.labels = `At most ${LIMITS.labels} labels`;
	return n === 0 ? undefined : out;
}

/** Secret file drafts → the request list, problems into `errors`. */
export function secretFiles(
	files: SecretFileDraft[],
	errors: FormErrors,
): CreateSandboxInput["secretFiles"] {
	if (files.length === 0) return undefined;
	if (files.length > LIMITS.secretFiles) {
		errors.secretFiles = `At most ${LIMITS.secretFiles} files`;
	}
	const total = files.reduce((s, f) => s + f.sizeBytes, 0);
	if (total > LIMITS.secretFilesTotalBytes) {
		errors.secretFiles = "At most 8 MiB in total";
	}
	const names = new Set<string>();
	return files.map((f, i) => {
		const at = `secretFiles.${i}`;
		if (!FILE_NAME_RE.test(f.name)) {
			errors[`${at}.name`] = "Letters, digits, '.', '_' and '-', up to 128";
		} else if (names.has(f.name)) errors[`${at}.name`] = "Duplicate name";
		names.add(f.name);
		if (f.sizeBytes > LIMITS.secretFileBytes) {
			errors[`${at}.content`] = "At most 1 MiB per file";
		}
		const mode = parseSecretFileMode(f.mode);
		if (mode === null) errors[`${at}.mode`] = "Octal mode, like 0440";
		const linkPath = f.linkPath.trim();
		if (linkPath !== "" && !linkPath.startsWith("/")) {
			errors[`${at}.linkPath`] = "An absolute path";
		}
		return {
			name: f.name,
			contentBase64: f.contentBase64,
			...(typeof mode === "number" ? { mode } : {}),
			...(linkPath === "" ? {} : { linkPath }),
		};
	});
}

function seconds(c: DurationChoice): number | null | undefined {
	if (c === "default") return undefined;
	if (c === "none") return null;
	return Number(c);
}

/** The body of POST /v1/sandboxes, or the problems per field. */
export function toCreateRequest(f: CreateFormState): CreateRequestResult {
	const errors: FormErrors = {};
	const body: CreateSandboxInput = {};
	if (f.source === "snapshot") {
		if (f.snapshot === "") errors.snapshot = "Pick a saved snapshot";
		else body.from = { snapshot: f.snapshot };
	} else if (f.template !== "") {
		body.template = f.template;
	}
	if (f.size !== "") body.size = f.size;
	const name = f.name.trim();
	if (name.length > LIMITS.nameChars) {
		errors.name = `At most ${LIMITS.nameChars} characters`;
	} else if (name !== "") body.name = name;
	const slug = f.slug.trim();
	if (slug !== "") {
		const p = slugProblem(slug);
		if (p !== null) errors.slug = p;
		else body.slug = slug;
	}
	if (f.environment.kind === "none") body.environment = null;
	else if (f.environment.kind === "named")
		body.environment = f.environment.name;
	const labels = labelSet(f.labels, errors);
	if (labels) body.labels = labels;
	const env = envSet("env", f.env, errors);
	if (env) body.env = env;
	const secrets = envSet("secrets", f.secrets, errors);
	if (secrets) body.secrets = secrets;
	const files = secretFiles(f.secretFiles, errors);
	if (files) body.secretFiles = files;
	const ttl = seconds(f.ttl);
	if (ttl !== undefined) body.ttlSeconds = ttl;
	const idle = seconds(f.idle);
	if (idle !== undefined) body.idleTimeoutSeconds = idle;
	return Object.keys(errors).length > 0
		? { ok: false, errors }
		: { ok: true, body };
}

/** What a link may preselect on the create page. */
export interface CreatePrefill {
	template?: string;
	size?: string;
	snapshot?: string;
}

const PREFILL_KEYS = ["template", "size", "snapshot"] as const;

/** /app/t/<team>/sandboxes/new with the catalog choice only. */
export function newSandboxHref(teamId: string, p: CreatePrefill): string {
	const q = new URLSearchParams();
	for (const k of PREFILL_KEYS) {
		const v = p[k];
		if (typeof v === "string" && v !== "") q.set(k, v);
	}
	const base = teamPath(teamId, "sandboxes/new");
	const s = q.toString();
	return s === "" ? base : `${base}?${s}`;
}

/** The prefill from the page's search params; anything else is ignored. */
export function parsePrefill(
	sp: Record<string, string | string[] | undefined>,
): CreatePrefill {
	const out: CreatePrefill = {};
	for (const k of PREFILL_KEYS) {
		const raw = sp[k];
		const v = Array.isArray(raw) ? raw[0] : raw;
		if (typeof v === "string" && v !== "") out[k] = v.slice(0, 128);
	}
	return out;
}
