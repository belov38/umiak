// Request checks of proxy.ts (S8 §5.1, §5.6), kept free of Next.js types so
// they are unit-tested directly.
//   - every path but /healthz needs X-Auth-Request-Email (only oauth2-proxy
//     sets it; without it the request did not come through the proxy): 401;
//   - an unsafe method needs Origin == SBX_APP_ORIGIN (server actions,
//     Payload REST, admin uploads): 403. A missing Origin is refused too;
//   - /admin and /cms-api are for operators only (a group of
//     SBX_OPERATOR_GROUPS in X-Auth-Request-Groups, S8 §5.5): 403 before
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
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem"><h1>${title}</h1><p>${text}</p></body></html>`;
}

/** Payload's /admin and REST: served to operators only. */
const OPERATOR_PATH = /^\/(admin|cms-api)(\/|$)/;

/**
 * Auth endpoints of the `users` collection that only make sense with the
 * local strategy or Payload JWTs (both off): refresh-token would issue a JWT
 * nothing accepts. /me, /access, /init and /logout stay (the admin uses them).
 */
const DISABLED_AUTH =
	/^\/cms-api\/users\/(login|refresh-token|first-register|forgot-password|reset-password|unlock|verify\/[^/]+|[^/]+\/api-key\/reveal)\/?$/;

/** Groups of X-Auth-Request-Groups, parsed like `parseAuthHeaders` (S8 §5.2). */
export function headerGroups(h: Headers): string[] {
	return (h.get("x-auth-request-groups") ?? "")
		.split(",")
		.map((g) => g.trim())
		.filter((g) => g !== "" && !g.startsWith("role:"));
}

export function guard(
	r: GuardRequest,
	o: { appOrigin: string; operatorGroups: readonly string[] },
): GuardDenial | null {
	if (PUBLIC_PATHS.has(r.pathname)) return null;
	const email = r.headers.get("x-auth-request-email")?.trim() ?? "";
	if (email === "") {
		return {
			status: 401,
			reason: "not_signed_in",
			html: page(
				"Not signed in",
				"This page is only served through the sign-in proxy. Open the dashboard address and sign in.",
			),
		};
	}
	if (DISABLED_AUTH.test(r.pathname)) {
		return {
			status: 403,
			reason: "endpoint_disabled",
			html: page("Forbidden", "Sign-in goes through the sign-in proxy only."),
		};
	}
	if (
		OPERATOR_PATH.test(r.pathname) &&
		!headerGroups(r.headers).some((g) => o.operatorGroups.includes(g))
	) {
		return {
			status: 403,
			reason: "operators_only",
			html: page(
				"Operators only",
				'The admin is for platform operators. Open <a href="/app">the dashboard</a>.',
			),
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
