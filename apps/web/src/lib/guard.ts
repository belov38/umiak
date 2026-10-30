// Request checks of proxy.ts (S8 §5.1, §5.6), kept free of Next.js types so
// they are unit-tested directly.
//   - every path but /healthz needs X-Auth-Request-Email (only oauth2-proxy
//     sets it; without it the request did not come through the proxy): 401;
//   - an unsafe method needs Origin == SBX_APP_ORIGIN (server actions,
//     Payload REST, admin uploads): 403. A missing Origin is refused too.

export interface GuardRequest {
	method: string;
	pathname: string;
	headers: Headers;
}

export interface GuardDenial {
	status: 401 | 403;
	reason: "not_signed_in" | "origin_forbidden";
	html: string;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Paths served without the identity headers (exec probes, S8 §5.1). */
export const PUBLIC_PATHS: ReadonlySet<string> = new Set(["/healthz"]);

export function page(title: string, text: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem"><h1>${title}</h1><p>${text}</p></body></html>`;
}

export function guard(
	r: GuardRequest,
	o: { appOrigin: string },
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
