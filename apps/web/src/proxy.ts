// Next.js 16 proxy (formerly middleware): identity header and CSRF checks
// for every path but /healthz and Next's static files, the operator gate of
// /admin and /cms-api, and the security headers on every answer (S8 §5.1,
// §5.5, §5.6).
import { type NextRequest, NextResponse } from "next/server";
import { webEnv } from "./lib/env";
import { guard } from "./lib/guard";
import { securityHeaders } from "./lib/security-headers";

export function proxy(req: NextRequest): NextResponse {
	const env = webEnv();
	const denial = guard(
		{
			method: req.method,
			pathname: req.nextUrl.pathname,
			headers: req.headers,
		},
		env,
	);
	const res =
		denial === null
			? NextResponse.next()
			: new NextResponse(denial.html, {
					status: denial.status,
					headers: { "Content-Type": "text/html; charset=utf-8" },
				});
	const headers = securityHeaders({
		umiakDomain: env.umiakDomain,
		previewScheme: env.previewScheme,
		previewPort: env.previewPort,
		dev: process.env.NODE_ENV === "development",
	});
	for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
	return res;
}

// Exempt: Next's static build files and the browser icons only. /_next/image
// (the image optimizer, which fetches and serves images) is guarded like
// every other path.
export const config = {
	matcher: ["/((?!_next/static|favicon.ico|icon.svg|apple-icon.png).*)"],
};
