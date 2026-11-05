import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApiApp, ApiDeps } from "../deps.ts";
import { notFoundError } from "./errors.ts";

const mime: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".ttf": "font/ttf",
};
export function isAppPath(path: string) {
	return (
		/^\/app(?:\/(?:settings(?:\/(?:workspaces|templates|sizes|platform-defaults|account|deployment))?|templates|help|getting-started|account|teams\/new|snapshots|environments|keys|sandboxes\/new))?\/?$/.test(
			path,
		) ||
		/^\/app\/t\/team_[a-z0-9]+(?:\/(?:keys|snapshots|environments|settings|sandboxes\/[a-z0-9_-]+))?\/?$/.test(
			path,
		)
	);
}
function missing(): never {
	throw notFoundError("page or asset");
}
export function mountSpa(app: ApiApp, deps: ApiDeps) {
	const root = resolve(
		process.env.UMIAK_WEB_ASSETS_DIR ??
			fileURLToPath(new URL("../../../web/dist", import.meta.url)),
	);
	const o = deps.settings;
	const suffix =
		o.previewPort === (o.previewScheme === "https" ? 443 : 80)
			? ""
			: `:${o.previewPort}`;
	const csp = `default-src 'self'; base-uri 'self'; object-src 'none'; form-action 'self'; frame-ancestors 'self'; connect-src 'self'; frame-src 'self' ${o.previewScheme}://*.${o.umiakDomain}${suffix}; img-src 'self' data: blob:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self' blob:`;
	function send(path: string, html = false) {
		let decoded: string;
		try {
			decoded = decodeURIComponent(path);
		} catch {
			return null;
		}
		if (
			decoded.includes("..") ||
			decoded.includes("\\") ||
			decoded.includes("%") ||
			decoded.includes("\0")
		)
			return null;
		const target = resolve(root, decoded.replace(/^\//, ""));
		if (
			!target.startsWith(root + sep) ||
			!existsSync(target) ||
			!statSync(target).isFile()
		)
			return null;
		if (!realpathSync(target).startsWith(realpathSync(root) + sep)) return null;
		const type = mime[extname(target)];
		if (!type) return null;
		return new Response(readFileSync(target), {
			headers: {
				"Content-Type": type,
				"Cache-Control": html
					? "no-cache"
					: path.startsWith("/assets/")
						? "public, max-age=31536000, immutable"
						: "public, max-age=3600",
				"Content-Security-Policy": csp,
				"X-Content-Type-Options": "nosniff",
				"Referrer-Policy": "same-origin",
				"X-Frame-Options": "SAMEORIGIN",
			},
		});
	}
	app.get("/", (c) => c.redirect("/app", 302));
	for (const path of ["/app", "/app/*"])
		app.get(path, (c) =>
			isAppPath(c.req.path)
				? (send("/index.html", true) ?? missing())
				: missing(),
		);
	for (const path of [
		"/assets/*",
		"/appearance.js",
		"/icon.svg",
		"/favicon.ico",
		"/apple-icon.png",
		"/opengraph-image.png",
		"/brand/*",
	])
		app.get(path, (c) => send(c.req.path) ?? missing());
	app.get("/admin", (c) => c.redirect("/app/settings", 302));
	app.get("/admin/*", (c) => {
		const match = c.req.path.match(
			/^\/admin\/(?:collections\/(templates|sizes|api-keys|ssh-keys|teams)|globals\/(platform-defaults))(?:\/[^/]+)?$/,
		);
		if (!match) return missing();
		const section = match[1] ?? match[2];
		if (section === "api-keys") return c.redirect("/app/keys", 302);
		return c.redirect(
			`/app/settings/${section === "teams" ? "workspaces" : section === "ssh-keys" ? "account" : section}`,
			302,
		);
	});
}
