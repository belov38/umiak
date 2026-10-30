// Response headers of web (S8 §5.6). The CSP keeps everything on the own
// origin; the only foreign frames are sandbox ports and desktops
// (`https://*.<sbxDomain>`, S10). Next.js and the Payload admin render inline
// scripts and styles, hence 'unsafe-inline' (README: CSP). The dev server
// also needs 'unsafe-eval' (React dev tooling and HMR).

export interface SecurityHeaderOptions {
	sbxDomain: string;
	/** `next dev`: adds 'unsafe-eval' to script-src. */
	dev?: boolean;
}

export function contentSecurityPolicy(o: SecurityHeaderOptions): string {
	const script = ["'self'", "'unsafe-inline'"];
	if (o.dev) script.push("'unsafe-eval'");
	const directives: [string, string[]][] = [
		["default-src", ["'self'"]],
		["base-uri", ["'self'"]],
		["object-src", ["'none'"]],
		["form-action", ["'self'"]],
		["frame-ancestors", ["'self'"]],
		// Same origin only; 'self' also matches wss:// of the own host.
		["connect-src", ["'self'"]],
		["frame-src", [`https://*.${o.sbxDomain}`]],
		["img-src", ["'self'", "data:", "blob:"]],
		["font-src", ["'self'", "data:"]],
		["style-src", ["'self'", "'unsafe-inline'"]],
		["script-src", script],
		["worker-src", ["'self'", "blob:"]],
	];
	return directives.map(([k, v]) => `${k} ${v.join(" ")}`).join("; ");
}

export function securityHeaders(
	o: SecurityHeaderOptions,
): Record<string, string> {
	return {
		"Content-Security-Policy": contentSecurityPolicy(o),
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy": "same-origin",
		"X-Frame-Options": "SAMEORIGIN",
	};
}
