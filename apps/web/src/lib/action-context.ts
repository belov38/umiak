// The context of a server action (S8 §9.11): the session from the same
// request resolution as the /app layouts and the Payload strategy
// (requestAuth → authenticateRequest), and the Payload instance of the
// process.
import "server-only";
import { revalidatePath } from "next/cache";
import { getWebPayload } from "./payload";
import { requestAuth } from "./session";
import { type ActionCtx, type ActionResult, fail } from "./team-actions/core";

/**
 * Runs an action Impl for the signed-in user. Without a session (or a
 * refused one) the action is `forbidden`. After a success /app is revalidated; the next request resolves current identity data.
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
