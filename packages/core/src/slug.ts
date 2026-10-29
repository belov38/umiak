import { randomInt } from "node:crypto";
import { type ValidationIssue, validation } from "./errors.ts";
import { SLUG_WORDS } from "./slug-words.ts";

/** Slug suffixes reserved for service hosts (S4 §4.2), shared with the gateway. */
export const RESERVED_SLUG_SUFFIXES: readonly string[] = ["-desktop"];

/** Slugs reserved as a whole (S7 §5.4). */
export const RESERVED_SLUGS: readonly string[] = [
	"api",
	"app",
	"www",
	"ssh",
	"tunnel",
	"admin",
	"static",
	"sbx",
];

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ENDS_WITH_DIGITS_RE = /-[0-9]+$/;

/** Returns why `s` is not a valid slug, or null if it is. */
export function slugProblem(s: string): string | null {
	if (s.length < 3 || s.length > 40) return "must be 3 to 40 characters";
	if (!SLUG_RE.test(s)) {
		return "must be lowercase letters and digits in groups separated by single '-'";
	}
	if (ENDS_WITH_DIGITS_RE.test(s)) return "must not end with '-<digits>'";
	for (const suffix of RESERVED_SLUG_SUFFIXES) {
		if (s.endsWith(suffix))
			return `must not end with reserved suffix '${suffix}'`;
	}
	if (RESERVED_SLUGS.includes(s)) return "is reserved";
	return null;
}

export function isValidSlug(s: string): boolean {
	return slugProblem(s) === null;
}

/** Throws SbxError `validation` (path `slug`) if `s` violates S4 §4.2 / S7 §5.4. */
export function validateSlug(s: string): void {
	const problem = slugProblem(s);
	if (problem !== null) {
		const issue: ValidationIssue = { path: "slug", message: `slug ${problem}` };
		throw validation([issue]);
	}
}

/** Random integer in [0, n). */
export type RandomInt = (n: number) => number;

/**
 * Random slug of `words` dictionary words joined by '-' (S7 §5.4). Callers retry
 * on collision and switch to four words after five attempts (decision 11).
 */
export function generateSlug(words = 3, rnd: RandomInt = randomInt): string {
	if (!Number.isInteger(words) || words < 1 || words > 6) {
		throw new RangeError(`generateSlug: words must be 1..6, got ${words}`);
	}
	const parts: string[] = [];
	for (let i = 0; i < words; i++) {
		const word = SLUG_WORDS[rnd(SLUG_WORDS.length)];
		if (word === undefined)
			throw new RangeError("generateSlug: random index out of range");
		parts.push(word);
	}
	return parts.join("-");
}
