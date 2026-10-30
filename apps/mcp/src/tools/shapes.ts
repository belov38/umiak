// Argument fields shared by several tools (S11 7.2, 7.4, 7.5, 8.2). Only the
// subset of JSON Schema every client understands: strings, integers,
// booleans, arrays of those and string dictionaries.
import { z } from "zod";
import { IDEMPOTENCY_KEY_RE } from "../idempotency.ts";

/** Default of `wait_seconds` of the tools that wait for a state change. */
export const DEFAULT_WAIT_SECONDS = 45;
/** No call lasts longer than 50 s (S11 7.5). */
export const MAX_WAIT_SECONDS = 50;

/**
 * `wait` and `wait_seconds` of a tool that waits for a sandbox state.
 * The handler applies the defaults (`wait`: `waitByDefault`, `wait_seconds`:
 * DEFAULT_WAIT_SECONDS), so the schema stays free of `default`.
 */
export function waitShape(waitByDefault: boolean) {
	return {
		wait: z
			.boolean()
			.optional()
			.describe(`Wait for the result (default ${waitByDefault})`),
		wait_seconds: z
			.number()
			.int()
			.min(0)
			.max(MAX_WAIT_SECONDS)
			.optional()
			.describe(`Max seconds to wait (default ${DEFAULT_WAIT_SECONDS})`),
	};
}

export const idempotencyKeyShape = z
	.string()
	.regex(IDEMPOTENCY_KEY_RE)
	.optional()
	.describe(
		"Unique per intended run (for example a UUID); reuse only to retry after a timeout or dropped connection",
	);

export const envShape = z
	.record(z.string(), z.string())
	.optional()
	.describe(
		"Environment variables, name -> value; non-secret values only (arguments appear in client logs)",
	);

export const unsetEnvShape = z
	.array(z.string())
	.optional()
	.describe("Variable names to remove");

export const labelsShape = z
	.record(z.string(), z.string())
	.optional()
	.describe("Labels, key -> value");

export const nameShape = z
	.string()
	.max(255)
	.optional()
	.describe("Display name");

export const slugShape = z
	.string()
	.optional()
	.describe("Unique short name, 3-40 characters [a-z0-9-]; default: random");

export const sizeShape = z
	.string()
	.optional()
	.describe("Size slug from templates_list, e.g. 2gb; default: the template's");

/** Longest TTL and idle timeout: 30 days, in seconds. */
export const MAX_SECONDS = 2_592_000;

export const ttlShape = z
	.number()
	.int()
	.min(1)
	.max(MAX_SECONDS)
	.optional()
	.describe(
		"Lifetime in seconds from ready, then it is deleted; default: none",
	);

export const idleTimeoutShape = z
	.number()
	.int()
	.min(60)
	.max(MAX_SECONDS)
	.optional()
	.describe("Stop after this many idle seconds; default: never");
