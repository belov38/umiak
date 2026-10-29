import type { ValidationIssue } from "../errors.ts";

// Field checks shared by create, update and later methods. Each pushes issues
// with the field path; the caller throws `validation(issues)` once.

/** Postgres `int` upper bound of duration columns. */
const INT_MAX = 2_147_483_647;

export const LABEL_LIMITS = {
	count: 64,
	keyChars: 128,
	valueChars: 256,
} as const;

export const NAME_MAX_CHARS = 255;

export function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function checkLabels(
	path: string,
	v: unknown,
	issues: ValidationIssue[],
): void {
	if (!isPlainObject(v)) {
		issues.push({ path, message: "must be an object of string values" });
		return;
	}
	const entries = Object.entries(v);
	if (entries.length > LABEL_LIMITS.count) {
		issues.push({
			path,
			message: `at most ${LABEL_LIMITS.count} labels allowed`,
		});
	}
	for (const [k, val] of entries) {
		if (k.length === 0 || k.length > LABEL_LIMITS.keyChars) {
			issues.push({
				path: `${path}.${k}`,
				message: `key must be 1 to ${LABEL_LIMITS.keyChars} characters`,
			});
		}
		if (typeof val !== "string") {
			issues.push({ path: `${path}.${k}`, message: "value must be a string" });
		} else if (val.length > LABEL_LIMITS.valueChars) {
			issues.push({
				path: `${path}.${k}`,
				message: `value must be at most ${LABEL_LIMITS.valueChars} characters`,
			});
		}
	}
}

/** `null` allowed: no TTL / no idle-stop. */
export function checkSeconds(
	path: string,
	v: unknown,
	issues: ValidationIssue[],
	opts: { nullable: boolean; max?: number },
): void {
	if (v === null && opts.nullable) return;
	if (typeof v !== "number" || !Number.isInteger(v) || v <= 0 || v > INT_MAX) {
		issues.push({
			path,
			message: "must be a positive integer number of seconds",
		});
		return;
	}
	if (opts.max !== undefined && v > opts.max) {
		issues.push({ path, message: `must be at most ${opts.max} seconds` });
	}
}

export function checkName(
	path: string,
	v: unknown,
	issues: ValidationIssue[],
): void {
	if (v === null) return;
	if (typeof v !== "string" || v.length > NAME_MAX_CHARS) {
		issues.push({
			path,
			message: `must be a string of at most ${NAME_MAX_CHARS} characters`,
		});
	}
}

export function checkString(
	path: string,
	v: unknown,
	issues: ValidationIssue[],
): void {
	if (typeof v !== "string" || v.length === 0 || v.length > 128) {
		issues.push({ path, message: "must be a non-empty string" });
	}
}

export function checkKnownKeys(
	v: Record<string, unknown>,
	known: readonly string[],
	issues: ValidationIssue[],
): void {
	for (const k of Object.keys(v)) {
		if (!known.includes(k)) issues.push({ path: k, message: "unknown field" });
	}
}
