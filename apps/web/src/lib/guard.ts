import {
	type AuthMode,
	isTrustedIngressClient,
	ownerCidrSet,
} from "@umiak/auth";
import { ACCESS_CSS } from "./access-style";
import { APPEARANCE_BOOTSTRAP } from "./appearance";
import { LOCKUP_SVG } from "./brand-markup";
// Request checks of proxy.ts (S8 §5.1, §5.6), kept free of Next.js types so
// they are unit-tested directly.
//   - every path but /healthz needs X-Auth-Request-Email (only owner ingress
//     sets it; without it the request did not come through the proxy): 401;
//   - an unsafe method needs Origin == UMIAK_APP_ORIGIN (server actions,
//     Payload REST, admin uploads): 403. A missing Origin is refused too;
//   - /admin and /cms-api are for operators only (a group of
//     UMIAK_OPERATOR_GROUPS in X-Auth-Request-Groups, S8 §5.5): 403 before
//     Payload renders anything (its admin would send the field config);
//   - Payload's password-login endpoints of `users` (local strategy is off,
//     §5.4) are refused to everyone: 403.

export interface GuardRequest {
	method: string;
	pathname: string;
	headers: Headers;
}

export interface GuardDenial {
	status: 401 | 403;
	reason:
		| "client_network_forbidden"
		| "not_signed_in"
		| "origin_forbidden"
		| "operators_only"
		| "endpoint_disabled";
	html: string;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Paths served without the identity headers (exec probes, S8 §5.1). */
export const PUBLIC_PATHS: ReadonlySet<string> = new Set(["/healthz"]);

export function page(title: string, text: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — Umiak</title><style>${ACCESS_CSS}</style><script>${APPEARANCE_BOOTSTRAP}</script></head><body><main class="umiak-access"><a href="/app" aria-label="Umiak">${LOCKUP_SVG}</a><h1>${title}</h1><p>${text}</p></main></body></html>`;
}

/**
 * Auth endpoints of the `users` collection that only make sense with the
 * local strategy or Payload JWTs (both off): refresh-token would issue a JWT
 * nothing accepts. /me, /access, /init and /logout stay (the admin uses them).
 */
const DISABLED_AUTH =
	/^\/cms-api\/users\/(login|refresh-token|first-register|forgot-password|reset-password|unlock|verify\/[^/]+|[^/]+\/api-key\/reveal)\/?$/;

export function guard(
	r: GuardRequest,
	o: {
		appOrigin: string;
		operatorGroups: readonly string[];
		authMode?: AuthMode;
		localAllowedCidrs?: string;
		localDeniedCidrs?: string;
	},
): GuardDenial | null {
	if (PUBLIC_PATHS.has(r.pathname)) return null;
	// Only the private owner ingress may reach Next; it replaces this header
	// with its socket peer. X-Forwarded-For never authenticates web requests.
	if (
		!isTrustedIngressClient(
			r.headers.get("x-umiak-client-ip") ?? "",
			ownerCidrSet({
				UMIAK_LOCAL_ALLOWED_CIDRS: o.localAllowedCidrs,
				UMIAK_LOCAL_DENIED_CIDRS: o.localDeniedCidrs,
			}),
		)
	) {
		return {
			status: 403,
			reason: "client_network_forbidden",
			html: page(
				"Forbidden",
				"Your client network is not allowed in owner mode.",
			),
		};
	}
	if (DISABLED_AUTH.test(r.pathname)) {
		return {
			status: 403,
			reason: "endpoint_disabled",
			html: page("Forbidden", "Sign in through the owner ingress."),
		};
	}
	if (!SAFE_METHODS.has(r.method.toUpperCase())) {
		if (r.headers.get("origin") !== o.appOrigin) {
			return {
				status: 403,
				reason: "origin_forbidden",
				html: page(
					"Forbidden",
					"The request did not come from the dashboard origin.",
				),
			};
		}
	}
	return null;
}
