// Payload auth strategy of the users collection (S8 §5.4): no passwords,
// login, JWT or Payload cookie. Every request is authenticated by the
// oauth2-proxy headers through resolveSession.
//
// Payload only takes a user or null from a strategy, but web must tell a
// missing login (401) from a refused one (403 pages "account disabled",
// "identity conflict", S8 §5.3 item 4). So:
// - authenticateHeaders() returns the outcome with the reason;
// - authenticateRequest() is the same through the session cache of the
//   instance (session-cache.ts, attached in web) plus the user document;
//   web's layouts and server actions call it and render the 401/403 pages
//   themselves;
// - the strategy calls authenticateRequest() too (so /admin and /app agree)
//   and maps the outcome to {user} for Payload (/admin, /cms-api); when
//   refused, it adds the response header `X-Umiak-Auth-Denied: <reason>`
//   (Payload copies strategy response headers to its REST responses).
import {
	IdentityError,
	type SessionHeaders,
	type SessionIdentity,
} from "@umiak/auth";
import type { AuthStrategy, Payload } from "payload";
import type { UmiakCustomConfig } from "../config.ts";
import { type HeaderSource, parseAuthHeaders } from "./headers.ts";
import { resolveSession } from "./resolve-session.ts";
import { sessionCacheKey, sessionCacheOf } from "./session-cache.ts";

export const OAUTH2_PROXY_STRATEGY = "oauth2-proxy";

/** Response header of a refused login: the IdentityError code. */
export const AUTH_DENIED_HEADER = "x-umiak-auth-denied";

export type AuthDeniedReason =
	| "subject_required"
	| "user_disabled"
	| "identity_conflict";

export type AuthOutcome =
	/** No X-Auth-Request-Email: not behind oauth2-proxy (S8 §5.1). */
	| { kind: "anonymous"; status: 401 }
	/** subject_required -> 401; user_disabled, identity_conflict -> 403. */
	| { kind: "denied"; status: 401 | 403; reason: AuthDeniedReason }
	| { kind: "session"; claims: SessionHeaders; session: SessionIdentity };

const DENIED: ReadonlySet<string> = new Set<AuthDeniedReason>([
	"subject_required",
	"user_disabled",
	"identity_conflict",
]);

/** UMIAK_OPERATOR_GROUPS of the config (config.custom.umiak). */
export function operatorGroupsOf(payload: Payload): string[] {
	const umiak = payload.config.custom?.umiak as UmiakCustomConfig | undefined;
	return umiak?.operatorGroups ?? [];
}

/**
 * Parses the oauth2-proxy headers and resolves the session. IdentityErrors
 * of the login become `denied`; anything else (database down) is thrown.
 */
export async function authenticateHeaders(
	payload: Payload,
	headers: HeaderSource,
	o: { operatorGroups?: readonly string[] } = {},
): Promise<AuthOutcome> {
	const claims = parseAuthHeaders(headers);
	if (claims === null) return { kind: "anonymous", status: 401 };
	try {
		const session = await resolveSession(payload, claims, {
			operatorGroups: o.operatorGroups ?? operatorGroupsOf(payload),
		});
		return { kind: "session", claims, session };
	} catch (e) {
		if (e instanceof IdentityError && DENIED.has(e.code)) {
			const reason = e.code as AuthDeniedReason;
			return {
				kind: "denied",
				status: reason === "subject_required" ? 401 : 403,
				reason,
			};
		}
		throw e;
	}
}

/** The users document of a session (depth 0), as Payload's req.user takes it. */
export type UserDoc = Record<string, unknown> & { id: string };

export type RequestAuth =
	| Exclude<AuthOutcome, { kind: "session" }>
	| (Extract<AuthOutcome, { kind: "session" }> & {
			/** null when the row vanished between resolveSession and the read. */
			user: UserDoc | null;
	  });

async function resolveRequest(
	payload: Payload,
	headers: HeaderSource,
): Promise<RequestAuth> {
	const out = await authenticateHeaders(payload, headers);
	if (out.kind !== "session") return out;
	const doc = await payload.findByID({
		collection: "users",
		id: out.session.user.id,
		depth: 0,
		disableErrors: true,
	});
	// isOperator of the resolved session, not of the second read: access
	// rules (isOperatorReq) and the session must agree.
	const user =
		doc === null || doc === undefined
			? null
			: { ...(doc as UserDoc), isOperator: out.session.isOperator };
	return { ...out, user };
}

/**
 * authenticateHeaders() plus the users document, through the session cache
 * of the instance when one is attached (only sessions are cached; refusals
 * and errors are not).
 */
export async function authenticateRequest(
	payload: Payload,
	headers: HeaderSource,
): Promise<RequestAuth> {
	const cache = sessionCacheOf(payload);
	if (cache === null) return resolveRequest(payload, headers);
	const claims = parseAuthHeaders(headers);
	if (claims === null) return { kind: "anonymous", status: 401 };
	return (await cache.load(
		sessionCacheKey(claims),
		() => resolveRequest(payload, headers),
		(v) => (v as RequestAuth).kind === "session",
	)) as RequestAuth;
}

export const oauth2ProxyStrategy: AuthStrategy = {
	name: OAUTH2_PROXY_STRATEGY,
	authenticate: async ({ headers, payload }) => {
		const out = await authenticateRequest(payload, headers);
		if (out.kind === "anonymous") return { user: null };
		if (out.kind === "denied") {
			return {
				user: null,
				responseHeaders: new Headers({ [AUTH_DENIED_HEADER]: out.reason }),
			};
		}
		if (out.user === null) return { user: null };
		return {
			user: {
				...out.user,
				collection: "users",
				_strategy: OAUTH2_PROXY_STRATEGY,
			},
		};
	},
};
