import { createHash } from "node:crypto";

/** The `idempotency_key` argument of the tools (S11 7.4). */
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** Longest `Idempotency-Key` the API accepts (S7 5.7; packages/core validateIdempotencyKey). */
const API_KEY_MAX = 255;

/**
 * The key sent to the API: scoped by tool and sandbox, so one model key on
 * two sandboxes or in two tools never gives 409 idempotency_key_reused.
 * Above the API limit it is the sha256 hex of the same string.
 */
export function apiIdempotencyKey(
	tool: string,
	modelKey: string,
	sandboxId?: string,
): string {
	const key =
		sandboxId === undefined
			? `mcp:${tool}:${modelKey}`
			: `mcp:${tool}:${sandboxId}:${modelKey}`;
	return key.length > API_KEY_MAX
		? createHash("sha256").update(key).digest("hex")
		: key;
}
