// The session of a request to /app (S8 §9.1): the same cached resolution the
// Payload strategy uses (authenticateRequest of @sbx/payload), so /admin and
// /app always agree. Refusals end rendering with the 401/403 pages
// (unauthorized(), forbidden(); see app/(app)/forbidden.tsx).
import "server-only";
import { authenticateRequest, type RequestAuth } from "@sbx/payload";
import { headers } from "next/headers";
import { forbidden, unauthorized } from "next/navigation";
import { cache } from "react";
import { type AppSession, toAppSession } from "./app-session";
import { getWebPayload } from "./payload";

export type { AppSession, AppTeam } from "./app-session";

/** The authentication outcome of this request (memoized per render). */
export const requestAuth = cache(async (): Promise<RequestAuth> => {
	const payload = await getWebPayload();
	return authenticateRequest(payload, await headers());
});

/** The session, or the 401/403 page. */
export const getAppSession = cache(async (): Promise<AppSession> => {
	const a = await requestAuth();
	if (a.kind === "anonymous") unauthorized();
	if (a.kind === "denied") {
		if (a.status === 401) unauthorized();
		forbidden();
	}
	const personal = a.user?.personalTeam;
	return toAppSession(
		a.session,
		typeof personal === "string" ? personal : null,
	);
});
