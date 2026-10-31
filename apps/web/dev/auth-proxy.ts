// Dev stand-in for ingress + oauth2-proxy (S8 §13). Not part of the image
// (.dockerignore, `pnpm check:image`). Node built-ins only; run with plain
// node (type stripping).
//
//   - listens on 127.0.0.1 only and refuses any other address;
//   - drops every X-Auth-Request-* header the client sent and sets them from
//     the dev cookie `sbx_dev_identity` (none without the cookie);
//   - /__dev/login picks an identity ("user", "second user", "operator" or
//     a custom one; POST only with Origin = the proxy's own origin; no
//     control characters, no comma in email or sub), /__dev/logout and
//     /oauth2/sign_out drop it;
//   - routes as oauth2-proxy does (deploy/compose/oauth2-proxy): /api/* to
//     the api's proxied listener without /api, /sbx-auth/* to it unchanged,
//     everything else to `next dev`; WebSocket upgrades too.
import http from "node:http";
import net from "node:net";

export const DEV_IDENTITY_COOKIE = "sbx_dev_identity";
export const LOOPBACK = "127.0.0.1";

export interface Upstream {
	host: string;
	port: number;
}

export interface DevIdentity {
	email: string;
	/** `sub` of the IdP. */
	user: string;
	name: string;
	groups: string[];
}

export interface AuthProxyOptions {
	/** Must be 127.0.0.1 (default). */
	host?: string;
	/** Default 3000; 0 picks a free port. */
	port?: number;
	/** The api's proxied listener; default 127.0.0.1:8081. */
	api?: Upstream;
	/** `next dev`; default 127.0.0.1:3001. */
	web?: Upstream;
	/** Group of the "operator" preset; default sbx-operators. */
	operatorGroup?: string;
	/**
	 * The only Origin accepted on POST /__dev/login; default the proxy's
	 * own `http://127.0.0.1:<port>`.
	 */
	origin?: string;
	log?: (line: string) => void;
}

export interface AuthProxy {
	url: string;
	port: number;
	close(): Promise<void>;
}

export function presets(operatorGroup: string): Record<string, DevIdentity> {
	return {
		user: {
			email: "user@example.com",
			user: "dev-user",
			name: "Dev User",
			groups: [],
		},
		second: {
			email: "second@example.com",
			user: "dev-second-user",
			name: "Second User",
			groups: [],
		},
		operator: {
			email: "operator@example.com",
			user: "dev-operator",
			name: "Dev Operator",
			groups: [operatorGroup],
		},
	};
}

export function encodeIdentity(i: DevIdentity): string {
	return Buffer.from(JSON.stringify(i)).toString("base64url");
}

// C0 controls and DEL: a header value with them could split or smuggle
// headers upstream.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * The identity if every field is a safe header value: no control
 * characters anywhere, and no comma in the email or the subject (web reads
 * a comma-joined value as two headers and refuses it; a comma in a group
 * name would split it).
 */
export function validIdentity(i: DevIdentity): DevIdentity | null {
	const fields = [i.email, i.user, i.name, ...i.groups];
	if (fields.some((f) => CONTROL.test(f))) return null;
	if (i.email.trim() === "" || i.user.trim() === "") return null;
	if (i.email.includes(",") || i.user.includes(",")) return null;
	if (i.groups.some((g) => g.includes(","))) return null;
	return i;
}

export function decodeIdentity(v: string): DevIdentity | null {
	try {
		const o = JSON.parse(Buffer.from(v, "base64url").toString("utf8")) as
			| Partial<DevIdentity>
			| undefined;
		if (
			typeof o?.email !== "string" ||
			o.email === "" ||
			typeof o.user !== "string" ||
			o.user === ""
		) {
			return null;
		}
		return validIdentity({
			email: o.email,
			user: o.user,
			name: typeof o.name === "string" ? o.name : "",
			groups: Array.isArray(o.groups)
				? o.groups.filter((g): g is string => typeof g === "string")
				: [],
		});
	} catch {
		return null;
	}
}

function cookieValue(header: string | undefined, name: string): string | null {
	for (const part of (header ?? "").split(";")) {
		const i = part.indexOf("=");
		if (i < 0) continue;
		if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
	}
	return null;
}

/** The identity of the dev cookie, or null. */
export function identityOf(req: http.IncomingMessage): DevIdentity | null {
	const v = cookieValue(req.headers.cookie, DEV_IDENTITY_COOKIE);
	return v === null ? null : decodeIdentity(v);
}

/**
 * Upstream request headers: the client's, minus every X-Auth-Request-*,
 * plus the ones of the dev identity (as oauth2-proxy injects them).
 */
export function upstreamHeaders(
	req: http.IncomingMessage,
	id: DevIdentity | null,
): http.OutgoingHttpHeaders {
	const out: http.OutgoingHttpHeaders = {};
	for (const [k, v] of Object.entries(req.headers)) {
		if (v === undefined || k.toLowerCase().startsWith("x-auth-request-")) {
			continue;
		}
		out[k] = v;
	}
	if (id !== null) {
		out["x-auth-request-email"] = id.email;
		out["x-auth-request-user"] = id.user;
		out["x-auth-request-preferred-username"] = id.email.split("@")[0] ?? "";
		if (id.groups.length > 0) {
			out["x-auth-request-groups"] = id.groups.join(",");
		}
	}
	return out;
}

/** Target of a path, as the alpha config of oauth2-proxy routes it. */
export function route(
	path: string,
	o: { api: Upstream; web: Upstream },
): { upstream: Upstream; path: string } {
	if (path === "/api" || path.startsWith("/api/") || path.startsWith("/api?")) {
		const rest = path.slice("/api".length);
		return {
			upstream: o.api,
			path: rest === "" || rest.startsWith("?") ? `/${rest}` : rest,
		};
	}
	if (path.startsWith("/sbx-auth/")) return { upstream: o.api, path };
	return { upstream: o.web, path };
}

function escapeHtml(s: string): string {
	return s.replace(
		/[&<>"']/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				c
			] ?? c,
	);
}

function loginPage(
	current: DevIdentity | null,
	all: Record<string, DevIdentity>,
	rd: string,
): string {
	const buttons = Object.entries(all)
		.map(
			([key, i]) =>
				`<button name="preset" value="${key}">${escapeHtml(i.name)} <small>${escapeHtml(i.email)}${i.groups.length ? ` [${escapeHtml(i.groups.join(","))}]` : ""}</small></button>`,
		)
		.join("\n");
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>sbx dev login</title>
<style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem}button{display:block;width:100%;margin:.4rem 0;padding:.6rem;text-align:left;cursor:pointer}label{display:block;margin:.4rem 0}input{width:100%;padding:.3rem}</style>
</head><body>
<h1>sbx dev login</h1>
<p>Dev stand-in for oauth2-proxy. Current identity: <b>${current ? escapeHtml(`${current.email} (${current.user})`) : "none"}</b>${current ? ' — <a href="/__dev/logout">log out</a>' : ""}</p>
<form method="post" action="/__dev/login">
<input type="hidden" name="rd" value="${escapeHtml(rd)}">
${buttons}
</form>
<h2>Custom</h2>
<form method="post" action="/__dev/login">
<input type="hidden" name="rd" value="${escapeHtml(rd)}">
<label>Email <input name="email" type="email" required></label>
<label>Name <input name="name"></label>
<label>Subject (sub; default dev:&lt;email&gt;) <input name="user"></label>
<label>Groups (comma-separated) <input name="groups"></label>
<button>Log in</button>
</form>
</body></html>`;
}

/** Only same-site relative paths are accepted as redirect targets. */
function safeRedirect(rd: string | null): string {
	// "//host" and "/\host" are protocol-relative to browsers.
	return rd?.startsWith("/") && !/^\/[/\\]/.test(rd) ? rd : "/app";
}

function readBody(
	req: http.IncomingMessage,
	limit = 64 * 1024,
): Promise<string> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => {
			size += c.length;
			if (size > limit) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function setIdentityCookie(res: http.ServerResponse, id: DevIdentity | null) {
	res.setHeader(
		"Set-Cookie",
		id === null
			? `${DEV_IDENTITY_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
			: `${DEV_IDENTITY_COOKIE}=${encodeIdentity(id)}; Path=/; HttpOnly; SameSite=Lax`,
	);
}

async function devPages(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	all: Record<string, DevIdentity>,
	origin: () => string,
): Promise<boolean> {
	const url = new URL(req.url ?? "/", "http://dev.invalid");
	if (url.pathname === "/__dev/logout" || url.pathname === "/oauth2/sign_out") {
		setIdentityCookie(res, null);
		res.writeHead(302, { Location: "/__dev/login" }).end();
		return true;
	}
	if (url.pathname !== "/__dev/login") return false;
	if (req.method === "POST") {
		// Login CSRF: another site's form must not pick the identity.
		if (req.headers.origin !== origin()) {
			res
				.writeHead(403, { "Content-Type": "text/plain" })
				.end("cross-origin login refused");
			return true;
		}
		const form = new URLSearchParams(await readBody(req));
		const preset = form.get("preset");
		let id: DevIdentity | null = null;
		if (preset !== null) {
			id = all[preset] ?? null;
		} else {
			const email = (form.get("email") ?? "").trim().toLowerCase();
			if (email !== "") {
				id = validIdentity({
					email,
					user: (form.get("user") ?? "").trim() || `dev:${email}`,
					name: (form.get("name") ?? "").trim(),
					groups: (form.get("groups") ?? "")
						.split(",")
						.map((g) => g.trim())
						.filter((g) => g !== ""),
				});
			}
		}
		if (id === null) {
			res.writeHead(400, { "Content-Type": "text/plain" }).end("no identity");
			return true;
		}
		setIdentityCookie(res, id);
		res.writeHead(303, { Location: safeRedirect(form.get("rd")) }).end();
		return true;
	}
	res
		.writeHead(200, {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
		})
		.end(
			loginPage(identityOf(req), all, safeRedirect(url.searchParams.get("rd"))),
		);
	return true;
}

function forward(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	o: { api: Upstream; web: Upstream },
	log: (line: string) => void,
) {
	const target = route(req.url ?? "/", o);
	const up = http.request(
		{
			host: target.upstream.host,
			port: target.upstream.port,
			method: req.method,
			path: target.path,
			headers: upstreamHeaders(req, identityOf(req)),
		},
		(upRes) => {
			res.writeHead(upRes.statusCode ?? 502, upRes.rawHeaders);
			upRes.pipe(res);
		},
	);
	up.on("error", (err) => {
		log(
			`upstream ${target.upstream.host}:${target.upstream.port}: ${err.message}`,
		);
		if (!res.headersSent) {
			res
				.writeHead(502, { "Content-Type": "text/plain" })
				.end(
					`upstream ${target.upstream.host}:${target.upstream.port} unavailable\n`,
				);
		} else {
			res.destroy();
		}
	});
	req.pipe(up);
}

function forwardUpgrade(
	req: http.IncomingMessage,
	socket: net.Socket,
	head: Buffer,
	o: { api: Upstream; web: Upstream },
	log: (line: string) => void,
) {
	const target = route(req.url ?? "/", o);
	const headers = upstreamHeaders(req, identityOf(req));
	const up = net.connect(target.upstream.port, target.upstream.host, () => {
		let raw = `${req.method} ${target.path} HTTP/1.1\r\n`;
		for (const [k, v] of Object.entries(headers)) {
			for (const one of Array.isArray(v) ? v : [String(v)]) {
				raw += `${k}: ${one}\r\n`;
			}
		}
		up.write(`${raw}\r\n`);
		if (head.length > 0) up.write(head);
		up.pipe(socket);
		socket.pipe(up);
	});
	const drop = (err?: Error) => {
		if (err) log(`upgrade ${target.path}: ${err.message}`);
		socket.destroy();
		up.destroy();
	};
	up.on("error", drop);
	socket.on("error", drop);
	up.on("close", () => socket.destroy());
	socket.on("close", () => up.destroy());
}

export function startAuthProxy(o: AuthProxyOptions = {}): Promise<AuthProxy> {
	const host = o.host ?? LOOPBACK;
	if (host !== LOOPBACK) {
		return Promise.reject(
			new Error(
				`the dev auth proxy listens on ${LOOPBACK} only, not ${host}: anyone who reaches it can pick any identity`,
			),
		);
	}
	const routes = {
		api: o.api ?? { host: LOOPBACK, port: 8081 },
		web: o.web ?? { host: LOOPBACK, port: 3001 },
	};
	const all = presets(o.operatorGroup ?? "sbx-operators");
	const log = o.log ?? ((l: string) => console.error(`[auth-proxy] ${l}`));
	let ownOrigin = o.origin ?? "";
	const server = http.createServer((req, res) => {
		devPages(req, res, all, () => ownOrigin)
			.then((handled) => {
				if (!handled) forward(req, res, routes, log);
			})
			.catch((err: unknown) => {
				log(`dev page: ${err instanceof Error ? err.message : String(err)}`);
				if (!res.headersSent) res.writeHead(500).end();
			});
	});
	// Upgraded sockets leave the server's connection list; close them too.
	const upgraded = new Set<net.Socket>();
	server.on("upgrade", (req, socket, head) => {
		const s = socket as net.Socket;
		upgraded.add(s);
		s.on("close", () => upgraded.delete(s));
		forwardUpgrade(req, s, head, routes, log);
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(o.port ?? 3000, host, () => {
			server.off("error", reject);
			const addr = server.address() as net.AddressInfo;
			if (ownOrigin === "") ownOrigin = `http://${host}:${addr.port}`;
			resolve({
				url: `http://${host}:${addr.port}`,
				port: addr.port,
				close: () =>
					new Promise<void>((r) => {
						for (const s of upgraded) s.destroy();
						server.closeAllConnections();
						server.close(() => r());
					}),
			});
		});
	});
}
