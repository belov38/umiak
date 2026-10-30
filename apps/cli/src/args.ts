// Parsers of option values shared by the commands: repeatable options,
// `K=V` pairs, env files, durations and the words after `--`.

import { readFileSync } from "node:fs";
import { usageError } from "./exit-codes.ts";

/** commander `argParser` of a repeatable option: collects every value. */
export function collect(value: string, previous: string[] = []): string[] {
	return [...previous, value];
}

/** `K=V` items as an object; a later key wins. */
export function parsePairs(
	items: readonly string[] | undefined,
	flag: string,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [n, item] of (items ?? []).entries()) {
		const i = item.indexOf("=");
		if (i <= 0) {
			// The value is never echoed: it may be a secret pasted without its key.
			throw usageError(
				`${flag} takes KEY=VALUE; value ${n + 1} of ${flag} has ${i < 0 ? "no =" : "no key"}`,
			);
		}
		out[item.slice(0, i)] = item.slice(i + 1);
	}
	return out;
}

/**
 * A dotenv file: `KEY=VALUE` lines, `#` comments, blank lines, an optional
 * `export ` prefix; a value in single or double quotes loses them (double
 * quotes also turn `\n` into a new line).
 */
export function parseEnvFile(path: string): Record<string, string> {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		throw usageError(`cannot read ${path}: ${(err as Error).message}`);
	}
	const out: Record<string, string> = {};
	for (const [n, raw] of text.split(/\r?\n/).entries()) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		const body = line.startsWith("export ") ? line.slice(7).trimStart() : line;
		const i = body.indexOf("=");
		if (i <= 0) throw usageError(`${path}:${n + 1}: expected KEY=VALUE`);
		const key = body.slice(0, i).trim();
		let value = body.slice(i + 1).trim();
		const q = value[0];
		if ((q === '"' || q === "'") && value.length >= 2 && value.endsWith(q)) {
			value = value.slice(1, -1);
			if (q === '"') value = value.replaceAll("\\n", "\n");
		}
		out[key] = value;
	}
	return out;
}

/** The env files in order, then the `--env` pairs on top. */
export function envSet(
	files: readonly string[] | undefined,
	pairs: readonly string[] | undefined,
	flag = "--env",
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const f of files ?? []) Object.assign(out, parseEnvFile(f));
	return Object.assign(out, parsePairs(pairs, flag));
}

const UNIT_SECONDS: Record<string, number> = {
	s: 1,
	m: 60,
	h: 3600,
	d: 86_400,
};

/** Seconds of `90`, `90s`, `15m`, `2h` or `7d`. */
export function parseDuration(value: string, flag: string): number {
	const m = /^(\d+)([smhd]?)$/.exec(value.trim());
	const n =
		m === null ? Number.NaN : Number(m[1]) * (UNIT_SECONDS[m[2] || "s"] ?? 1);
	if (!Number.isSafeInteger(n) || n <= 0) {
		throw usageError(
			`${flag} takes a duration like 90, 90s, 15m, 2h or 7d, not ${JSON.stringify(value)}`,
		);
	}
	return n;
}

/** A positive integer argument. */
export function parseCount(value: string, flag: string): number {
	const n = /^\d+$/.test(value) ? Number(value) : Number.NaN;
	if (!Number.isSafeInteger(n) || n <= 0) {
		throw usageError(
			`${flag} takes a positive number, not ${JSON.stringify(value)}`,
		);
	}
	return n;
}

/**
 * The words after the first `--` of the command line (the remote command),
 * and the positional arguments before it. `args` are commander's operands,
 * which end with the words after `--`.
 */
export function splitDashDash(
	argv: readonly string[],
	args: readonly string[],
): { before: string[]; after: string[] | null } {
	const i = argv.indexOf("--");
	if (i < 0) return { before: [...args], after: null };
	const after = argv.slice(i + 1);
	return { before: args.slice(0, args.length - after.length), after };
}
