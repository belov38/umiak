// Payload auth strategy of the users collection (S8 §5.4): no passwords,
// login, JWT or Payload cookie. Every request is authenticated by the
// oauth2-proxy headers through resolveSession.
//
// Payload only takes a user or null from a strategy, but web must tell a
// missing login (401) from a refused one (403 pages "account disabled",
// "identity conflict", S8 §5.3 item 4). So:
// - authenticateHeaders() returns the outcome with the reason; web (proxy,
//   layouts, server actions) calls it, with its cache around it (plan
//   task 9), and renders the 401/403 pages itself;
// - the strategy maps the outcome to {user} for Payload (/admin,
//   /cms-api) and, when refused, adds the response header
//   `X-Sbx-Auth-Denied: <reason>` (Payload copies strategy response
//   headers to its REST responses).
import {
	IdentityError,
	type SessionHeaders,
	type SessionIdentity,
} from "@sbx/auth";
import type { AuthStrategy, Payload } from "payload";
import type { SbxCustomConfig } from "../config.ts";
import { type HeaderSource, parseAuthHeaders } from "./headers.ts";
import { resolveSession } from "./resolve-session.ts";

export const OAUTH2_PROXY_STRATEGY = "oauth2-proxy";

/** Response header of a refused login: the IdentityError code. */
export const AUTH_DENIED_HEADER = "x-sbx-auth-denied";

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

/** SBX_OPERATOR_GROUPS of the config (config.custom.sbx). */
export function operatorGroupsOf(payload: Payload): string[] {
	const sbx = payload.config.custom?.sbx as SbxCustomConfig | undefined;
	return sbx?.operatorGroups ?? [];
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

export const oauth2ProxyStrategy: AuthStrategy = {
	name: OAUTH2_PROXY_STRATEGY,
	authenticate: async ({ headers, payload }) => {
		const out = await authenticateHeaders(payload, headers);
		if (out.kind === "anonymous") return { user: null };
		if (out.kind === "denied") {
			return {
				user: null,
				responseHeaders: new Headers({ [AUTH_DENIED_HEADER]: out.reason }),
			};
		}
		const doc = await payload.findByID({
			collection: "users",
			id: out.session.user.id,
			depth: 0,
			disableErrors: true,
		});
		if (!doc) return { user: null };
		return {
			user: { ...doc, collection: "users", _strategy: OAUTH2_PROXY_STRATEGY },
		};
	},
};
