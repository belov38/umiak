// Idempotency of the tools that create things (S11 7.4, 7.5): the model-facing
// key, the key sent to the API, and the "outcome unknown" error.
import { randomUUID } from "node:crypto";
import { SbxError } from "@sbx/sdk";
import type { ToolContext } from "../context.ts";
import { ToolError } from "../errors.ts";
import { apiIdempotencyKey } from "../idempotency.ts";

export interface Keyed {
	/** What the model sees and may pass again. */
	modelKey: string;
	/** What goes into `Idempotency-Key`: scoped by tool and sandbox. */
	apiKey: string;
}

/**
 * The model's key, or a fresh UUIDv4 when it gave none. The API always gets
 * the derived key, so a generated key is returned to the model and a repeat
 * with it attaches to the same resource.
 */
export function keyFor(
	tool: string,
	given: string | undefined,
	sandboxId?: string,
): Keyed {
	const modelKey = given ?? randomUUID();
	return { modelKey, apiKey: apiIdempotencyKey(tool, modelKey, sandboxId) };
}

/**
 * The API did not answer, so the action may have started: the deadline
 * ran out, the connection broke, or the SDK gave up retrying. Answers of the
 * API (any status) are not this.
 */
export function outcomeUnknown(err: unknown, ctx: ToolContext): boolean {
	if (ctx.deadline.cancelled()) return false;
	if (err instanceof SbxError) return err.status === 0;
	return ctx.deadline.expired();
}

/** Runs the POST; an unknown outcome becomes `deadline_exceeded` carrying the model key. */
export async function withUnknownOutcome<T>(
	ctx: ToolContext,
	modelKey: string,
	send: () => Promise<T>,
): Promise<T> {
	try {
		return await send();
	} catch (err) {
		if (!outcomeUnknown(err, ctx)) throw err;
		throw new ToolError({
			code: "deadline_exceeded",
			message: "the API did not answer in time",
			retryable: true,
			hint: "the action may have started; call again with this idempotency_key to attach to it.",
			idempotencyKey: modelKey,
		});
	}
}
