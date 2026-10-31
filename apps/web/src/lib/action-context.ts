// The context of a server action (S8 §9.11): the session from the same
// cached resolution as the /app layouts and the Payload strategy
// (requestAuth → authenticateRequest), and the Payload instance of the
// process.
import "server-only";
import { sessionCacheOf } from "@sbx/payload";
import { revalidatePath } from "next/cache";
import { getWebPayload } from "./payload";
import { requestAuth } from "./session";
import { type ActionCtx, type ActionResult, fail } from "./team-actions/core";

/**
 * Runs an action Impl for the signed-in user. Without a session (or a
 * refused one) the action is `forbidden`. After a success the session
 * cache of this process is flushed at once (the NOTIFY of the write flushes
 * it too, but asynchronously: the next navigation must see the new team
 * list) and /app is revalidated.
 */
export async function runAction<T extends object>(
	fn: (ctx: ActionCtx) => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
	const auth = await requestAuth();
	if (auth.kind !== "session") {
		return fail("forbidden", "You are not signed in.");
	}
	const payload = await getWebPayload();
	const r = await fn({ payload, session: auth.session });
	if ("ok" in r) {
		sessionCacheOf(payload)?.flush();
		revalidatePath("/app", "layout");
	}
	return r;
}

/** The action context of this request, or null without a session. */
export async function requestActionCtx(): Promise<ActionCtx | null> {
	const auth = await requestAuth();
	if (auth.kind !== "session") return null;
	return { payload: await getWebPayload(), session: auth.session };
}
