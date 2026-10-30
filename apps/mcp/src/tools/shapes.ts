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
			.describe(
				`Wait for the result before answering (default ${waitByDefault})`,
			),
		wait_seconds: z
			.number()
			.int()
			.min(0)
			.max(MAX_WAIT_SECONDS)
			.optional()
			.describe(
				`Seconds to wait, 0-${MAX_WAIT_SECONDS} (default ${DEFAULT_WAIT_SECONDS})`,
			),
	};
}

export const idempotencyKeyShape = z
	.string()
	.regex(IDEMPOTENCY_KEY_RE)
	.optional()
	.describe(
		"Retry key, 1-128 characters [A-Za-z0-9._-]. Use a new unique value (for example a UUID) per new action; repeat a call with the same key only after a timeout, to get the earlier result instead of acting twice. The answer shows the key used.",
	);

export const envShape = z
	.record(z.string(), z.string())
	.optional()
	.describe(
		"Environment variables, name -> value. Non-secret values only: arguments appear in client logs. Secrets come from the team environment, never from here.",
	);

export const unsetEnvShape = z
	.array(z.string())
	.optional()
	.describe("Names of environment variables to remove");

export const labelsShape = z
	.record(z.string(), z.string())
	.optional()
	.describe("Labels, key -> value (up to 64)");

export const nameShape = z
	.string()
	.max(255)
	.optional()
	.describe("Display name, up to 255 characters");

export const slugShape = z
	.string()
	.optional()
	.describe(
		"Unique short name, 3-40 characters [a-z0-9-]; default: three random words",
	);

export const sizeShape = z
	.string()
	.optional()
	.describe(
		"Size slug from templates_list, for example 2gb; default: the template's",
	);

export const ttlShape = z
	.number()
	.int()
	.min(1)
	.optional()
	.describe(
		"Lifetime in seconds from ready, then the sandbox is deleted; default: no limit",
	);

export const idleTimeoutShape = z
	.number()
	.int()
	.min(60)
	.optional()
	.describe("Stop after this many idle seconds (at least 60); default: never");
