// Next.js 16 proxy (formerly middleware): identity header and CSRF checks
// for every path but /healthz and Next's static files, plus the security
// headers on every answer (S8 §5.1, §5.6).
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
		sbxDomain: env.sbxDomain,
		dev: process.env.NODE_ENV === "development",
	});
	for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
	return res;
}

export const config = {
	matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
