import { execFileSync } from "node:child_process";
import {
	createReadStream,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import { createSecureContext } from "node:tls";
import { fileURLToPath } from "node:url";
import { clientGuard } from "../local/ingress.mjs";
import { OwnerStore, PgOwnerRepository } from "./owner.mjs";

const COOKIE = "umiak_owner";
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
		`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)} · Umiak</title><style>body{font:16px system-ui;max-width:800px;margin:3rem auto;padding:1rem;background:#111827;color:#f3f4f6}input,button{font:inherit;padding:.7rem;margin:.4rem}a{color:#93c5fd}code{overflow-wrap:anywhere}pre{white-space:pre-wrap}</style><h1>${esc(title)}</h1>${body}</html>`,
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
			/^(x-auth-|x-forwarded-|x-umiak-|authorization$|cookie$|proxy-|forwarded$|host$)/i.test(
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
}) {
	const allowed = clientGuard(
		env.UMIAK_LOCAL_ALLOWED_CIDRS ??
			"127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,fc00::/7",
		env.UMIAK_LOCAL_DENIED_CIDRS ?? "10.88.0.0/24",
		env,
	);
	const appOrigin = env.UMIAK_APP_ORIGIN ?? "http://localhost:4180";
	const buckets = new Map();
	function rate(req) {
		const key = req.socket.remoteAddress;
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
			const safe = ["GET", "HEAD", "OPTIONS"].includes(req.method);
			const token = bearer(req);
			const owner = await store.authenticate(token);
			const browser = !!req.headers.cookie;
			if (req.headers.origin && req.headers.origin !== origin)
				return fail(res, 403, "origin_forbidden");
			if (!safe && browser && req.headers.origin !== origin)
				return fail(res, 403, "origin_required");
			if (path.startsWith("/owner/") && !rate(req))
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
					oidc: null,
					apiUrl: origin,
					appUrl: origin,
					ownerClaimed: await store.claimed(),
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
					!/^(install\.sh|SHA256SUMS|umiak-node-linux-amd64|umiak-(linux|darwin)-(arm64|x64)|umiak-windows-x64\.exe)$/.test(
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
				return json(res, 200, await store.pairStart());
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
				if (await setupHandler(req, res, { origin, owner })) return;
			}
			if (!owner) {
				if (
					req.method === "GET" &&
					(path === "/" ||
						path === "/app" ||
						path === "/setup" ||
						path === "/owner/pair")
				) {
					return page(
						res,
						"Claim this Umiak deployment",
						`<p>Enter the one-time setup code from <code>docker compose logs quickstart</code>. Network access alone grants no control.</p><form id="claim"><input id="code" type="password" autocomplete="off" required placeholder="Setup code"><button>Claim deployment</button></form><pre id="message"></pre><script>document.getElementById('claim').onsubmit=async e=>{e.preventDefault();const r=await fetch('/owner/claim',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:document.getElementById('code').value})});if(r.ok)location.reload();else document.getElementById('message').textContent='Claim failed. Check the setup code; it can only be used once.';};</script>`,
					);
				}
				return fail(res, 401, "owner_required");
			}
			if (path === "/owner/tls" && req.method === "GET")
				return page(
					res,
					"HTTPS addresses",
					`<p>Open initially using localhost or a DNS name. Add LAN/tailnet IPs here for clients that connect by IP. The same CA remains valid.</p><form id="tls"><input id="names" placeholder="192.168.1.10,100.100.1.10"><button>Save certificate names</button></form><pre id="result"></pre><p><a href="/setup">Setup</a></p><script>document.querySelector('#tls').onsubmit=async e=>{e.preventDefault();const r=await fetch('/owner/tls',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({names:document.querySelector('#names').value.split(',').map(x=>x.trim()).filter(Boolean)})});document.querySelector('#result').textContent=r.ok?'Saved. IP clients can now connect with the verified CA.':'Invalid names';};</script>`,
				);
			if (path === "/owner/tls" && req.method === "POST") {
				const input = await body(req);
				if (!tls.updateNames) return fail(res, 400, "tls_not_configurable");
				server.setSecureContext(tls.updateNames(input.names));
				return json(res, 200, { saved: true });
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
				await store.pairApprove(input.id);
				return json(res, 200, { approved: true });
			}
			if (path === "/owner/pair" && req.method === "GET") {
				const id = url.searchParams.get("id");
				await store.pairInfo(id);
				return page(
					res,
					"Approve CLI pairing",
					`<p>Only approve a request you started in your terminal. Confirm the request identifier matches:</p><code>${esc(id)}</code><p><button id="approve">Approve this CLI</button></p><pre id="message"></pre><script>document.getElementById('approve').onclick=async()=>{const r=await fetch('/owner/pair/approve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:${JSON.stringify(id)}})});document.getElementById('message').textContent=r.ok?'Approved. Return to your terminal.':'Approval failed or expired.';};</script>`,
				);
			}
			if (setupHandler && (await setupHandler(req, res, { origin, owner })))
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

/** A dedicated owner CA, separate from the guest gateway CA and SSH identities. */
export function quickstartTls(dir, names = []) {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const run = (args) => execFileSync("openssl", args, { stdio: "ignore" });
	const ca = join(dir, "ca.pem"),
		caKey = join(dir, "ca.key");
	if (!existsSync(ca) || !existsSync(caKey))
		run([
			"req",
			"-sha256",
			"-x509",
			"-newkey",
			"ec",
			"-pkeyopt",
			"ec_paramgen_curve:P-256",
			"-pkeyopt",
			"ec_param_enc:named_curve",
			"-nodes",
			"-days",
			"3650",
			"-subj",
			"/CN=Umiak quickstart owner CA",
			"-keyout",
			caKey,
			"-out",
			ca,
			"-addext",
			"basicConstraints=critical,CA:TRUE",
			"-addext",
			"keyUsage=critical,keyCertSign,cRLSign",
		]);
	const valid = (name) =>
		typeof name === "string" &&
		name.length <= 253 &&
		(net.isIP(name) ||
			/^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$/.test(name) ||
			name === "localhost");
	const namesFile = join(dir, "tls-names.json");
	const savedNames = existsSync(namesFile)
		? JSON.parse(readFileSync(namesFile, "utf8"))
		: [];
	const local = [
		...savedNames,
		"localhost",
		"127.0.0.1",
		"::1",
		...names,
		...Object.values(networkInterfaces())
			.flat()
			.map((x) => x?.address),
	].filter(valid);
	const cache = new Map();
	function issue(list, key = "default") {
		const stem = join(dir, key);
		const conf = `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=${[...new Set(list)].map((name) => `${net.isIP(name) ? "IP" : "DNS"}:${name}`).join(",")}\n`;
		writeFileSync(`${stem}.ext`, conf, { mode: 0o600 });
		run([
			"req",
			"-sha256",
			"-new",
			"-newkey",
			"ec",
			"-pkeyopt",
			"ec_paramgen_curve:P-256",
			"-pkeyopt",
			"ec_param_enc:named_curve",
			"-nodes",
			"-subj",
			"/CN=Umiak owner ingress",
			"-keyout",
			`${stem}.key`,
			"-out",
			`${stem}.csr`,
		]);
		run([
			"x509",
			"-sha256",
			"-req",
			"-in",
			`${stem}.csr`,
			"-CA",
			ca,
			"-CAkey",
			caKey,
			"-set_serial",
			`0x${Date.now().toString(16)}${Math.floor(Math.random() * 0xffffff).toString(16)}`,
			"-days",
			"90",
			"-extfile",
			`${stem}.ext`,
			"-out",
			`${stem}.pem`,
		]);
		return {
			key: readFileSync(`${stem}.key`),
			cert: readFileSync(`${stem}.pem`),
		};
	}
	const fallback = issue(local);
	return {
		...fallback,
		updateNames(extra) {
			if (
				!Array.isArray(extra) ||
				extra.length > 16 ||
				extra.some((name) => !valid(name))
			)
				throw new Error("invalid_tls_names");
			writeFileSync(namesFile, JSON.stringify(extra), { mode: 0o600 });
			return issue([...local, ...extra]);
		},
		SNICallback(name, cb) {
			try {
				if (!valid(name)) throw new Error("invalid_sni");
				if (!cache.has(name)) {
					if (cache.size >= 64) throw new Error("sni_limit");
					cache.set(
						name,
						createSecureContext(issue([name], `sni-${cache.size}`)),
					);
				}
				cb(null, cache.get(name));
			} catch (error) {
				cb(error);
			}
		},
	};
}

async function main() {
	const { default: pg } = await import("pg");
	const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
	const store = new OwnerStore(new PgOwnerRepository(pool));
	const code = await store.init();
	if (code) console.log(`Umiak one-time setup code: ${code}`);
	const dir =
		process.env.UMIAK_QUICKSTART_TLS_DIR ?? "/var/lib/umiak/owner/tls";
	const tls = quickstartTls(
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
