import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clientGuard } from "../local/ingress.mjs";
import { OwnerStore, PgOwnerRepository } from "./owner.mjs";
import { quickstartTls } from "./tls.mjs";

const COOKIE = "__Host-umiak_owner";
const esc = (value) =>
	String(value).replace(
		/[&<>"']/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				c
			],
	);
const json = (res, status, value) => {
	res.writeHead(status, {
		"content-type": "application/json",
		"cache-control": "no-store",
	});
	res.end(JSON.stringify(value));
};
const fail = (res, status, code) =>
	json(res, status, {
		error: { code, message: code, retryable: status === 429 },
	});
const page = (res, title, body) => {
	res.writeHead(200, {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
	});
	res.end(
		`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)} · Umiak</title><style>:root{color-scheme:light dark;--bg:#fefefe;--panel:#fefefe;--fg:#060606;--border:#e0e0e0;--accent:#263fa9}@media(prefers-color-scheme:dark){:root{--bg:#060606;--panel:#060606;--fg:#fefefe;--border:#2e2e2e;--accent:#aab9ff}}*{box-sizing:border-box}body{font:15px/1.6 system-ui;max-width:800px;margin:3rem auto;padding:1.5rem;background:var(--bg);color:var(--fg)}h1{font-size:2rem;letter-spacing:-.04em}input,button{font:inherit;padding:.7rem;margin:.4rem 0;border:1px solid var(--border);border-radius:8px;background:var(--panel);color:var(--fg)}input:not([type=checkbox]){display:block;width:100%}button{cursor:pointer;background:var(--accent);color:var(--bg);font-weight:600}section{border:1px solid var(--border);padding:1rem;border-radius:12px;margin:1rem 0}a{color:var(--accent)}code{overflow-wrap:anywhere}pre{white-space:pre-wrap}nav{display:flex;gap:1.5rem;margin-bottom:2rem}</style><nav><strong>Umiak</strong><a href="/app">Sandboxes</a><a href="/app/getting-started">Getting started</a><a href="/owner/sessions">Sessions</a></nav><h1>${esc(title)}</h1>${body}</html>`,
	);
};
async function body(req) {
	let size = 0;
	const chunks = [];
	for await (const chunk of req) {
		size += chunk.length;
		if (size > 16384) throw new Error("body_too_large");
		chunks.push(chunk);
	}
	return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}
function bearer(req) {
	const a = req.headers.authorization;
	if (a?.startsWith("Bearer ")) return a.slice(7);
	return req.headers.cookie
		?.split(";")
		.map((x) => x.trim())
		.find((x) => x.startsWith(`${COOKIE}=`))
		?.slice(COOKIE.length + 1);
}
export function requestOrigin(req) {
	const host = req.headers.host;
	if (typeof host !== "string" || !host || /[\s/@\\#?]/.test(host))
		throw new Error("invalid_host");
	const url = new URL(`https://${host}`);
	if (url.host !== host.toLowerCase()) throw new Error("invalid_host");
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	if (
		!net.isIP(hostname) &&
		!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(hostname)
	)
		throw new Error("invalid_host");
	return url.origin;
}
export function upstreamHeaders(req, appOrigin) {
	const out = {};
	for (const [key, value] of Object.entries(req.headers)) {
		if (
			/^(tailscale-|x-auth-|x-forwarded-|x-umiak-|authorization$|cookie$|proxy-|forwarded$|host$)/i.test(
				key,
			)
		)
			continue;
		out[key] = value;
	}
	const app = new URL(appOrigin);
	out.host = app.host;
	out["x-forwarded-host"] = app.host;
	out["x-forwarded-proto"] = app.protocol.slice(0, -1);
	out["x-forwarded-for"] = req.socket.remoteAddress;
	out["x-umiak-client-ip"] = req.socket.remoteAddress;
	if (req.headers.origin) out.origin = app.origin;
	return out;
}
function route(path, env) {
	if (
		path.startsWith("/mcp") ||
		path.startsWith("/.well-known/oauth-protected-resource")
	)
		return [env.UMIAK_QUICKSTART_MCP_HOST ?? "mcp", 8080, path];
	if (path.startsWith("/api/"))
		return [env.UMIAK_QUICKSTART_API_HOST ?? "api", 8081, path.slice(4)];
	if (path.startsWith("/v1/"))
		return [env.UMIAK_QUICKSTART_API_HOST ?? "api", 8080, path];
	return [env.UMIAK_QUICKSTART_WEB_HOST ?? "web", 3000, path];
}

export function createQuickstartServer({
	store,
	setupHandler,
	assetsDir,
	env = process.env,
	tls = {},
	transport = https,
	renewIntervalMs = 86400000,
}) {
	const allowed = clientGuard(
		env.UMIAK_LOCAL_ALLOWED_CIDRS ??
			"127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,fc00::/7",
		env.UMIAK_LOCAL_DENIED_CIDRS ?? "10.88.0.0/24",
		env,
	);
	const appOrigin = env.UMIAK_APP_ORIGIN ?? "http://localhost:4180";
	const buckets = new Map();
	function rate(req, authenticated = false) {
		const key = `${req.socket.remoteAddress}:${authenticated ? "owner" : "public"}`;
		const now = Date.now();
		const old = buckets.get(key);
		const next =
			!old || old.until < now ? { until: now + 60000, count: 0 } : old;
		if (buckets.size > 10000)
			for (const [k, v] of buckets) if (v.until < now) buckets.delete(k);
		if (buckets.size > 10000 && !buckets.has(key)) return false;
		next.count++;
		buckets.set(key, next);
		return next.count <= 60;
	}
	const server = transport.createServer(tls, async (req, res) => {
		res.setHeader("x-content-type-options", "nosniff");
		res.setHeader("referrer-policy", "no-referrer");
		res.setHeader("x-frame-options", "DENY");
		try {
			const origin = requestOrigin(req);
			const url = new URL(req.url, origin);
			const path = url.pathname;
			if (url.origin !== origin) return fail(res, 400, "invalid_path");
			// Host preparation uses an expiring capability, never network ownership.
			const preparation =
				!!setupHandler &&
				((path === "/pve-setup.sh" && req.method === "GET") ||
					(path === "/quickstart/setup/callback" && req.method === "POST"));
			if (
				!preparation &&
				(!allowed(req.socket.remoteAddress) ||
					(await setupHandler?.deniedPeer?.(req.socket.remoteAddress)))
			)
				return fail(res, 403, "local_network_forbidden");
			if (preparation && !rate(req)) return fail(res, 429, "rate_limited");
			const publicUrl = new URL(origin);
			const ownerPrivateCA = !(
				(env.UMIAK_QUICKSTART_SERVE_PEERS ?? "")
					.split(",")
					.includes(req.socket.remoteAddress?.replace(/^::ffff:/, "")) &&
				publicUrl.hostname.endsWith(".ts.net") &&
				(publicUrl.port || "443") === (env.UMIAK_QUICKSTART_SERVE_PORT ?? "443")
			);
			const safe = ["GET", "HEAD", "OPTIONS"].includes(req.method);
			const token = bearer(req);
			const owner = token ? await store.authenticate(token) : false;
			const browser = !!req.headers.cookie;
			if (req.headers.origin && req.headers.origin !== origin)
				return fail(res, 403, "origin_forbidden");
			if (!safe && browser && req.headers.origin !== origin)
				return fail(res, 403, "origin_required");
			if (path.startsWith("/owner/") && !rate(req, owner))
				return fail(res, 429, "rate_limited");
			if (path === "/v1/meta" && req.method === "GET") {
				const reply = await fetch(
					`http://${env.UMIAK_QUICKSTART_API_HOST ?? "api"}:8080/v1/meta`,
					{
						headers: upstreamHeaders(req, appOrigin),
						signal: AbortSignal.timeout(10000),
						redirect: "error",
					},
				);
				if (!reply.ok) return fail(res, 503, "upstream_unavailable");
				const meta = await reply.json();
				return json(res, 200, {
					...meta,
					authMode: "owner",
					tenancy: "single",
					oidc: null,
					apiUrl: origin,
					appUrl: origin,
					ownerClaimed: await store.claimed(),
					ownerPrivateCA,
				});
			}
			if (
				req.method === "GET" &&
				(path === "/install.sh" ||
					path.startsWith("/downloads/") ||
					path === "/ca.pem")
			) {
				if (path === "/ca.pem") {
					res.setHeader("content-type", "application/x-pem-file");
					return res.end(
						readFileSync(
							join(
								env.UMIAK_QUICKSTART_TLS_DIR ?? "/var/lib/umiak/owner/tls",
								"ca.pem",
							),
						),
					);
				}
				const file =
					path === "/install.sh"
						? "install.sh"
						: path.slice("/downloads/".length);
				if (
					!assetsDir ||
					!/^(install\.sh|SHA256SUMS|DOWNLOADS|umiak-node-linux-amd64|umiak-(linux|darwin)-(arm64|x64)(\.gz)?|umiak-windows-x64\.exe(\.gz)?)$/.test(
						file,
					)
				)
					return fail(res, 404, "not_found");
				const asset = join(assetsDir, file);
				if (!existsSync(asset)) return fail(res, 404, "not_found");
				res.setHeader(
					"content-type",
					file === "install.sh"
						? "text/x-shellscript"
						: "application/octet-stream",
				);
				if (file === "install.sh")
					return res.end(
						readFileSync(asset, "utf8").replaceAll("__UMIAK_ORIGIN__", origin),
					);
				res.setHeader("content-length", statSync(asset).size);
				return createReadStream(asset).pipe(res);
			}
			if (path === "/owner/claim" && req.method === "POST") {
				if (req.headers.origin !== origin)
					return fail(res, 403, "origin_required");
				const input = await body(req);
				const credential = await store.claim(input.code);
				res.setHeader(
					"set-cookie",
					`${COOKIE}=${credential}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=15552000`,
				);
				return json(res, 200, { claimed: true });
			}
			if (path === "/owner/pair" && req.method === "POST")
				return json(
					res,
					200,
					await store.pairStart({
						source: req.socket.remoteAddress,
						userAgent: req.headers["user-agent"],
					}),
				);
			if (path === "/owner/pair/poll" && req.method === "POST") {
				const input = await body(req);
				const credential = await store.pairPoll(input.id, input.secret);
				return json(
					res,
					200,
					credential ? { token: credential } : { pending: true },
				);
			}
			if (
				(path === "/pve-setup.sh" || path === "/quickstart/setup/callback") &&
				setupHandler
			) {
				if (await setupHandler(req, res, { origin, owner, ownerPrivateCA }))
					return;
			}
			if (!owner) {
				if (
					req.method === "GET" &&
					(path === "/" ||
						path === "/app" ||
						(path.startsWith("/app/") &&
							req.headers.accept?.includes("text/html")) ||
						path === "/setup" ||
						path === "/owner/pair")
				) {
					if (await store.claimed())
						return page(
							res,
							"Open your signed-in deployment address",
							"<p>This deployment is already claimed. Open this pairing link on the hostname where you signed in. Owner cookies stay on that hostname. Console recovery is available if you lost your session.</p>",
						);
					return page(
						res,
						"Claim this Umiak deployment",
						`<p>Enter the one-time setup code from <code>docker compose logs quickstart</code>. Network access alone grants no control.</p><form id="claim"><input id="code" type="password" autocomplete="off" required placeholder="Setup code"><button>Claim deployment</button></form><pre id="message"></pre><script>document.getElementById('claim').onsubmit=async e=>{e.preventDefault();const r=await fetch('/owner/claim',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:document.getElementById('code').value})});if(r.ok)location.reload();else document.getElementById('message').textContent='Claim failed. Check the setup code; it can only be used once.';};</script>`,
					);
				}
				return fail(res, 401, "owner_required");
			}
			if (
				!(await store.canApprove(token)) &&
				(path.startsWith("/quickstart/") ||
					path === "/setup" ||
					path.startsWith("/owner/tls"))
			)
				return fail(res, 403, "browser_session_required");
			if (path === "/owner/tls/status" && req.method === "GET")
				return json(res, 200, tls.status?.() ?? { warning: null });
			if (path === "/owner/tls" && req.method === "GET")
				return page(
					res,
					"HTTPS addresses",
					`<p role="status">${esc(tls.status?.().warning ?? "")}</p><p>Current CA SHA256: <code>${esc(tls.status?.().caFingerprint ?? "")}</code></p><p>Open initially using localhost or a configured DNS name. Add LAN/tailnet IPs here for clients that connect by IP. Adding names rotates the constrained owner CA. Download and verify the new CA before using these addresses.</p><form id="tls"><input id="names" value="${esc(tls.status?.().pendingNames.join(",") ?? "")}" placeholder="192.168.1.10,100.100.1.10"><label><input id="rotate" type="checkbox" required> I understand that adding names rotates the CA and requires trusting the new fingerprint.</label><button>Save certificate names</button></form><pre id="result"></pre><p><a href="/setup">Setup</a></p><script>document.querySelector('#tls').onsubmit=async e=>{e.preventDefault();const r=await fetch('/owner/tls',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({rotateCA:document.querySelector("#rotate").checked,names:document.querySelector('#names').value.split(',').map(x=>x.trim()).filter(Boolean)})});document.querySelector('#result').textContent=r.ok?'Saved. New CA SHA256: '+(await r.json()).caFingerprint+'. Replace old client trust with the new CA obtained through Docker.':'Invalid names';};</script>`,
				);
			if (path === "/owner/tls" && req.method === "POST") {
				const input = await body(req);
				if (!tls.updateNames) return fail(res, 400, "tls_not_configurable");
				server.setSecureContext(
					await tls.updateNames(input.names, {
						rotateCA: input.rotateCA === true,
					}),
				);
				return json(res, 200, { saved: true, ...tls.status?.() });
			}
			if (path === "/app/help" || path === "/help") {
				res.writeHead(302, { location: "/app/getting-started" });
				return res.end();
			}
			if (path === "/owner/sessions" && req.method === "GET") {
				if (!(await store.canApprove(token)))
					return fail(res, 403, "browser_session_required");
				const sessions = await store.sessions();
				return page(
					res,
					"Owner sessions",
					`<p>CLI sessions expire after 30 days. Revoke a lost device here.</p>${sessions.map((x) => `<section><strong>${esc(x.kind)}</strong> · expires ${esc(new Date(x.expires).toISOString())} <button data-session="${esc(x.id)}">Revoke</button></section>`).join("")}<p id="result" role="status"></p><script>document.querySelectorAll('[data-session]').forEach(b=>b.onclick=async()=>{const r=await fetch('/owner/sessions/revoke',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:b.dataset.session})});if(r.ok)location.reload();else document.querySelector('#result').textContent='Could not revoke session';});</script>`,
				);
			}
			if (path === "/owner/sessions/revoke" && req.method === "POST") {
				if (!(await store.canApprove(token)))
					return fail(res, 403, "browser_session_required");
				await store.revokeSession((await body(req)).id);
				return json(res, 200, { revoked: true });
			}
			if (path === "/owner/logout" && req.method === "POST") {
				await store.revoke(token);
				res.setHeader(
					"set-cookie",
					`${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
				);
				return json(res, 200, { loggedOut: true });
			}
			if (path === "/owner/pair/approve" && req.method === "POST") {
				const input = await body(req);
				if (!(await store.canApprove(token)))
					return fail(res, 403, "browser_session_required");
				await store.pairApprove(input.id, input.code);
				return json(res, 200, { approved: true });
			}
			if (path === "/owner/pair" && req.method === "GET") {
				const id = url.searchParams.get("id");
				const info = await store.pairInfo(id);
				return page(
					res,
					"Approve CLI pairing",
					`<p>Approve only a login you started. Enter the short code printed in your terminal.</p><p>Source (possibly a Docker NAT address): ${esc(info.source)} · ${esc(new Date(info.created).toISOString())}</p><p>Client: ${esc(info.userAgent)}</p><form id="approval"><label>Pairing code <input id="pair-code" autocomplete="off" placeholder="ABCD-1234" required></label><button>Approve CLI</button></form><pre id="message" role="status"></pre><script>document.getElementById('approval').onsubmit=async e=>{e.preventDefault();const r=await fetch('/owner/pair/approve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:${JSON.stringify(id)},code:document.getElementById('pair-code').value})});document.getElementById('message').textContent=r.ok?'Approved. Return to your terminal.':'Approval failed. Check the code and expiry.';};</script>`,
				);
			}
			if (
				setupHandler &&
				(await setupHandler(req, res, { origin, owner, ownerPrivateCA }))
			)
				return;
			if (path === "/") {
				res.writeHead(302, { location: "/app" });
				return res.end();
			}
			const [host, port, pathOut] = route(req.url, env);
			const upstream = http.request(
				{
					host,
					port,
					path: pathOut,
					method: req.method,
					headers: upstreamHeaders(req, appOrigin),
				},
				(reply) => {
					const headers = { ...reply.headers };
					if (headers.location?.startsWith(appOrigin))
						headers.location =
							origin + headers.location.slice(appOrigin.length);
					res.writeHead(reply.statusCode, headers);
					reply.pipe(res);
				},
			);
			upstream.on("error", () => {
				if (!res.headersSent) fail(res, 502, "upstream_unavailable");
				else res.end();
			});
			req.on("aborted", () => upstream.destroy());
			req.pipe(upstream);
		} catch (error) {
			if (!res.headersSent)
				fail(
					res,
					error.message === "body_too_large" ? 413 : 403,
					[
						"invalid_claim",
						"invalid_pair",
						"owner_unclaimed",
						"pair_limit",
						"session_limit",
					].includes(error.message)
						? error.message
						: "request_rejected",
				);
			else res.end();
		}
	});
	if (tls.renew) {
		let renewing = false;
		const renewal = setInterval(async () => {
			if (renewing) return;
			renewing = true;
			try {
				const credentials = await tls.renew();
				if (credentials) {
					server.setSecureContext(credentials);
					console.log(
						"Umiak owner TLS leaf renewed without restart; CA trust unchanged",
					);
				}
			} catch (error) {
				console.warn("Umiak TLS leaf renewal failed:", error.message);
			} finally {
				renewing = false;
			}
		}, renewIntervalMs);
		renewal.unref();
		server.once("close", () => clearInterval(renewal));
	}
	server.requestTimeout = 30000;
	server.headersTimeout = 15000;
	server.on("upgrade", async (req, socket, head) => {
		try {
			const origin = requestOrigin(req);
			if (
				!allowed(req.socket.remoteAddress) ||
				(await setupHandler?.deniedPeer?.(req.socket.remoteAddress)) ||
				!(await store.authenticate(bearer(req))) ||
				(req.headers.origin && req.headers.origin !== origin)
			)
				throw new Error("denied");
			const [host, port, path] = route(req.url, env);
			const upstream = net.connect(port, host, () => {
				upstream.write(
					`${req.method} ${path} HTTP/1.1\r\n${Object.entries(
						upstreamHeaders(req, appOrigin),
					)
						.map(([key, value]) => `${key}: ${value}`)
						.join("\r\n")}\r\n\r\n`,
				);
				upstream.write(head);
				socket.pipe(upstream);
				upstream.pipe(socket);
			});
			upstream.on("error", () => socket.destroy());
			socket.on("error", () => upstream.destroy());
			socket.on("close", () => upstream.destroy());
		} catch {
			socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
		}
	});
	return server;
}

export { quickstartTls } from "./tls.mjs";

async function main() {
	const { default: pg } = await import("pg");
	const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
	const store = new OwnerStore(new PgOwnerRepository(pool));
	const code = await store.init();
	if (code) console.log(`Umiak one-time setup code: ${code}`);
	const dir =
		process.env.UMIAK_QUICKSTART_TLS_DIR ?? "/var/lib/umiak/owner/tls";
	const tls = await quickstartTls(
		dir,
		(process.env.UMIAK_QUICKSTART_TLS_NAMES ?? "").split(",").filter(Boolean),
	);
	let setupHandler;
	if (existsSync(fileURLToPath(new URL("./setup.mjs", import.meta.url)))) {
		const { createSetupHandler } = await import("./setup.mjs");
		setupHandler = createSetupHandler({ pool });
		await setupHandler.init?.();
	}
	const server = createQuickstartServer({
		store,
		setupHandler,
		assetsDir: process.env.UMIAK_QUICKSTART_ASSETS ?? "/app/quickstart-assets",
		tls,
	});
	const port = Number(process.env.UMIAK_QUICKSTART_PORT ?? 8444);
	server.listen(port, "0.0.0.0", () =>
		console.log(
			`Umiak owner HTTPS ingress ready on :${port}; retrieve CA using docker compose cp quickstart:${dir}/ca.pem ./umiak-ca.pem`,
		),
	);
	const close = () =>
		server.close(() => pool.end().then(() => process.exit(0)));
	process.on("SIGTERM", close);
	process.on("SIGINT", close);
}
if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	main().catch((error) => {
		console.error("quickstart startup failed:", error.message);
		process.exitCode = 1;
	});
