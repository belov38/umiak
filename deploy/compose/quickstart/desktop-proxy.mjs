// Path-addressed desktop viewer on the owner origin (S18).
//
// The owner ingress serves a trusted copy of the pinned moonlight-web frontend
// under /desktop/<slug>/ and forwards only its API and WebSocket to the
// gateway. A compromised sandbox must never run script on the owner origin, so
// every guest response is treated as data: only allowlisted data content types
// pass, response headers are allowlisted, and WebSocket bytes are relayed only
// after the gateway answered 101.
//
// First open vs. stream end: moonlight-web navigates to `/desktop/<slug>/`
// (path_prefix + "/", no query) when a stream ends. Desktop links minted by the
// API always carry a query (`?dataTransport=websocket[...]`), so a request with
// a query string opens the desktop and a bare path shows the "Stream ended"
// page. config.js (our own script, running on stream.html) remembers the open
// parameters in sessionStorage so Reconnect can reopen with the same fps,
// bitrate, language and dataTransport; without it Reconnect uses websocket.
//
// Content-Security-Policy is the last line of defence should the trusted
// viewer render hostile guest data through a DOM sink: viewer files allow only
// same-origin script (plus hashes of inline scripts in the pinned stream.html),
// own pages allow only hashes of their inline scripts, and proxied API
// responses are sandboxed.

import { createHash, createHmac } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { join } from "node:path";
import { renderPage } from "./ui.mjs";

const PREFIX = "/desktop";
const CREDENTIAL_TTL = 30; // seconds; the gateway accepts up to 60
const OPEN_TIMEOUT = 45000; // starting the streamer can take ~20 s
// Idle (not total) timeout of proxied API calls: a streaming
// application/x-ndjson response is cut after 60 s without any bytes.
const API_IDLE_TIMEOUT = 60000;
const HANDSHAKE_TIMEOUT = 20000;
const OPEN_PARAMS = ["fps", "bitrate", "dataTransport", "language"];
const DATA_TYPES = new Set([
	"application/json",
	"application/sdp",
	"application/trickle-ice-sdpfrag",
	"application/x-ndjson",
	"application/octet-stream",
]);
const REQUEST_HEADERS = [
	"accept",
	"accept-language",
	"content-type",
	"content-length",
	"user-agent",
];
const RESPONSE_HEADERS = [
	"content-type",
	"content-length",
	"cache-control",
	"retry-after",
	"umiak-error",
];
// Extensions are never offered upstream, so frames stay uncompressed and the
// 101 we build ourselves stays consistent with the relayed bytes.
const WS_REQUEST_HEADERS = [
	"sec-websocket-key",
	"sec-websocket-version",
	"sec-websocket-protocol",
];
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const VIEWER_CSP = (hashes = []) =>
	`default-src 'none'; script-src 'self' 'wasm-unsafe-eval'${hashes.map((h) => ` ${h}`).join("")}; worker-src 'self' blob:; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'; object-src 'none'`;
const PAGE_CSP = (hashes) =>
	`default-src 'none';${hashes.length ? ` script-src ${hashes.join(" ")};` : ""} style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; form-action 'self'; frame-ancestors 'self'; base-uri 'none'`;
const DATA_CSP = "default-src 'none'; sandbox";
const STATIC_TYPES = {
	html: "text/html; charset=utf-8",
	js: "text/javascript; charset=utf-8",
	wasm: "application/wasm",
	svg: "image/svg+xml",
	png: "image/png",
	json: "application/json",
};
// index.html and admin.html are not shipped: the viewer needs stream.html only.
const STATIC_FILE =
	/^(?:stream\.html|manifest\.json|[A-Za-z0-9_-]+\.(?:js|wasm|svg|png))$/;
const WEB_SOCKET_PATH = "/api/host/stream/web_socket";

/** CSP source expressions (`'sha256-…'`) for every inline <script> in `html`. */
export function inlineScriptHashes(html) {
	const hashes = [];
	for (const [, attrs, body] of html.matchAll(
		/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi,
	)) {
		if (/\ssrc\s*=/i.test(attrs ?? "")) continue;
		hashes.push(
			`'sha256-${createHash("sha256").update(body).digest("base64")}'`,
		);
	}
	return hashes;
}

const esc = (value) =>
	String(value).replace(
		/[&<>"']/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				c
			],
	);

/** `Umiak-Ingress-Desktop` value: `<label>.<exp>.<base64url HMAC-SHA256>`; `now` in Unix seconds. */
export function signDesktop(key, label, now = Date.now() / 1000) {
	const payload = `${label.toLowerCase()}.${Math.floor(now) + CREDENTIAL_TTL}`;
	return `${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`;
}

/** Same rules as the API slug validator (packages/core/src/slug.ts). */
function validSlug(slug) {
	return (
		slug.length >= 3 &&
		slug.length <= 40 &&
		/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) &&
		!/-[0-9]+$/.test(slug) &&
		!slug.endsWith("-desktop")
	);
}

function underPrefix(path) {
	return path === PREFIX || path.startsWith(`${PREFIX}/`);
}

/** True when the raw or the normalized request path addresses the desktop viewer. */
export function isDesktopRequest(rawUrl) {
	const raw = rawUrl.split("?")[0];
	let normalized = raw;
	try {
		normalized = new URL(rawUrl, "http://x").pathname;
	} catch {}
	return underPrefix(raw) || underPrefix(normalized);
}

// Parses the raw URL; anything encoded, dotted or doubled is refused, never normalized.
function parse(rawUrl) {
	const q = rawUrl.indexOf("?");
	const path = q < 0 ? rawUrl : rawUrl.slice(0, q);
	const search = q < 0 ? "" : rawUrl.slice(q);
	if (/[%\\]|\/\/|\/\.\.?(?:\/|$)/.test(path)) return null;
	const match = path.match(/^\/desktop\/([^/]+)(\/.*)?$/);
	if (!match || !validSlug(match[1])) return null;
	return { slug: match[1], rest: match[2] ?? "", search };
}

/** Reads the shared key and preview domain lazily; setup may write them after start. */
export function desktopContextFromEnv(env, assetsDir) {
	let key;
	let domain;
	let domainRead = 0;
	return () => {
		if (!key)
			try {
				const bytes = readFileSync(
					env.UMIAK_INGRESS_DESKTOP_KEY_FILE ??
						"/gateway-secrets/ingress-desktop-key",
				);
				if (bytes.length === 32) key = bytes;
			} catch {}
		if (Date.now() - domainRead > 5000) {
			domainRead = Date.now();
			try {
				domain = JSON.parse(
					readFileSync(
						env.UMIAK_QUICKSTART_NETWORK_FILE ??
							"/network-config/quickstart-network.json",
						"utf8",
					),
				).previewDomain;
			} catch {
				domain = undefined;
			}
		}
		return {
			key,
			gatewayUrl: env.UMIAK_QUICKSTART_GATEWAY_URL ?? "http://gateway:8085",
			previewDomain:
				domain ??
				env.UMIAK_GATEWAY_PREVIEW_DOMAIN ??
				env.UMIAK_PREVIEW_DOMAIN ??
				"umiak.localhost",
			assetsDir: assetsDir && join(assetsDir, "moonlight-web"),
		};
	};
}

const json = (res, status, value, headers = {}) => {
	res.writeHead(status, {
		"content-type": "application/json",
		"cache-control": "no-store",
		"content-security-policy": DATA_CSP,
		"cross-origin-resource-policy": "same-origin",
		...headers,
	});
	res.end(JSON.stringify(value));
};
const fail = (res, status, code) =>
	json(res, status, {
		error: { code, message: code, retryable: status === 503 },
	});
const rejected = (res) =>
	json(res, 502, { error: "desktop_upstream_rejected" });

function html(res, status, title, content, extraHead = "", headers = {}) {
	const page = renderPage(title, content, { authenticated: false }).replace(
		"<head>",
		`<head>${extraHead}`,
	);
	res.writeHead(status, {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
		"content-security-policy": PAGE_CSP(inlineScriptHashes(page)),
		...headers,
	});
	res.end(page);
}

/** Hidden inputs that reopen the desktop with the given open parameters. */
function openInputs(params) {
	const query = openQuery(params);
	return [...query]
		.map(
			([name, value]) =>
				`<input type="hidden" name="${esc(name)}" value="${esc(value)}">`,
		)
		.join("");
}

/** fps/bitrate/dataTransport/language in request order; dataTransport defaults to websocket. */
function openQuery(search) {
	const query = new URLSearchParams();
	for (const [name, value] of new URLSearchParams(search))
		if (OPEN_PARAMS.includes(name) && value && !query.has(name))
			query.set(name, value);
	if (!query.has("dataTransport")) query.set("dataTransport", "websocket");
	return query;
}

// Restores the parameters config.js stored for this prefix; constant text, so one CSP hash.
const RECONNECT_SCRIPT =
	'try{const f=document.getElementById("reconnect");const q=new URLSearchParams(sessionStorage.getItem("umiak-desktop:"+f.getAttribute("action"))||"");for(const k of ["fps","bitrate","language","dataTransport"]){const v=q.get(k);if(!v)continue;let i=f.querySelector("input[name="+k+"]");if(!i){i=document.createElement("input");i.type="hidden";i.name=k;f.appendChild(i)}i.value=v}}catch{}';

const SPINNER =
	"<style>.spinner{width:2rem;height:2rem;border:2px solid var(--border);border-top-color:var(--primary);border-radius:50%;animation:spin 1s linear infinite;margin-bottom:1rem}@keyframes spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.spinner{animation:none}}</style>";

function startingPage(res) {
	html(
		res,
		503,
		"Starting the desktop…",
		`${SPINNER}<div role="status" aria-live="polite"><div class="spinner" aria-hidden="true"></div><h1>Starting the desktop…</h1><p>This takes up to a minute.</p></div><p class="pending">You can stay here. Your desktop will open automatically.</p>`,
		'<meta http-equiv="refresh" content="5">',
		{ "retry-after": "5" },
	);
}

function streamEndedPage(res, slug) {
	html(
		res,
		200,
		"Stream ended",
		`<h1>Stream ended</h1><p>The desktop stream has ended. The sandbox keeps running.</p><form id="reconnect" method="get" action="${PREFIX}/${slug}/">${openInputs("")}<button type="submit">Reconnect</button></form><script>${RECONNECT_SCRIPT}</script>`,
	);
}

function unavailablePage(res, code, search) {
	const safe = /^[a-z_]{1,64}$/.test(code ?? "") ? code : "desktop_unavailable";
	html(
		res,
		502,
		"Desktop unavailable",
		`<h1>Desktop unavailable</h1><p>The desktop could not be opened. Try again in a moment.</p><p><code>${safe}</code></p><form method="get">${openInputs(search)}<button type="submit">Try again</button></form>`,
	);
}

function gatewayTarget(ctx, slug) {
	const url = new URL(ctx.gatewayUrl);
	return {
		host: url.hostname,
		port: Number(url.port || 80),
		// The gateway routes by Host on its preview listener.
		hostHeader: `${slug}-desktop.${ctx.previewDomain}:8085`,
		credential: signDesktop(ctx.key, `${slug}-desktop`),
	};
}

function pick(headers, names) {
	const out = {};
	for (const name of names)
		if (headers[name] != null) out[name] = headers[name];
	return out;
}

// stream.html is pinned upstream content with an inline script; hash it once per file version.
const streamHashCache = new Map();
function streamHashes(file, info) {
	const key = `${file}:${info.mtimeMs}:${info.size}`;
	if (!streamHashCache.has(key)) {
		streamHashCache.clear();
		streamHashCache.set(key, inlineScriptHashes(readFileSync(file, "utf8")));
	}
	return streamHashCache.get(key);
}

function serveStatic(req, res, ctx, rest) {
	const name = rest.slice(1);
	if (!ctx.assetsDir || !STATIC_FILE.test(name))
		return fail(res, 404, "not_found");
	const file = join(ctx.assetsDir, name);
	let info;
	try {
		info = statSync(file);
		if (!info.isFile()) throw new Error("not_file");
	} catch {
		return fail(res, 404, "not_found");
	}
	const csp = VIEWER_CSP(
		name === "stream.html" ? streamHashes(file, info) : [],
	);
	const modified = Math.floor(info.mtimeMs / 1000) * 1000;
	const since = Date.parse(req.headers["if-modified-since"] ?? "");
	const common = {
		"last-modified": new Date(modified).toUTCString(),
		"cache-control": "no-cache",
		"content-security-policy": csp,
	};
	if (!Number.isNaN(since) && modified <= since) {
		res.writeHead(304, common);
		return res.end();
	}
	res.writeHead(200, {
		...common,
		"content-type": STATIC_TYPES[name.slice(name.lastIndexOf(".") + 1)],
		"content-length": info.size,
	});
	if (req.method === "HEAD") return res.end();
	createReadStream(file).pipe(res);
}

function open(res, ctx, slug, search) {
	const query = openQuery(search);
	const target = gatewayTarget(ctx, slug);
	const upstream = http.request(
		{
			host: target.host,
			port: target.port,
			method: "GET",
			path: `/?${query}`,
			headers: {
				host: target.hostHeader,
				accept: "application/json",
				"umiak-ingress-desktop": target.credential,
			},
			timeout: OPEN_TIMEOUT,
		},
		(reply) => {
			reply.resume();
			const location = reply.headers.location ?? "";
			if (
				[302, 303].includes(reply.statusCode) &&
				/^\/stream\.html\?[A-Za-z0-9._~%&=+-]*$/.test(location)
			) {
				res.writeHead(302, {
					location: `${PREFIX}/${slug}${location}`,
					"cache-control": "no-store",
				});
				return res.end();
			}
			const code = reply.headers["umiak-error"];
			if (reply.statusCode === 503 && code === "desktop_starting")
				return startingPage(res);
			unavailablePage(res, code, search);
		},
	);
	upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
	upstream.on("error", () => {
		if (!res.headersSent) unavailablePage(res, "desktop_unreachable", search);
		else res.destroy();
	});
	upstream.end();
}

function proxyApi(req, res, ctx, slug, rest, search) {
	const target = gatewayTarget(ctx, slug);
	const headers = pick(req.headers, REQUEST_HEADERS);
	headers.host = target.hostHeader;
	headers["umiak-ingress-desktop"] = target.credential;
	const upstream = http.request(
		{
			host: target.host,
			port: target.port,
			method: req.method,
			path: rest + search,
			headers,
		},
		(reply) => {
			const type = reply.headers["content-type"];
			const media = type?.split(";")[0].trim().toLowerCase();
			const out = {
				...pick(reply.headers, RESPONSE_HEADERS),
				"content-security-policy": DATA_CSP,
				"cross-origin-resource-policy": "same-origin",
			};
			if (media) {
				if (!DATA_TYPES.has(media)) {
					reply.destroy();
					return rejected(res);
				}
				res.writeHead(reply.statusCode, out);
				return reply.pipe(res);
			}
			// Untyped responses pass only when they carry no body at all.
			if (
				req.method === "HEAD" ||
				[204, 304].includes(reply.statusCode) ||
				reply.headers["content-length"] === "0"
			) {
				reply.resume();
				res.writeHead(reply.statusCode, out);
				return res.end();
			}
			let body = false;
			reply.on("data", () => {
				if (body) return;
				body = true;
				reply.destroy();
				rejected(res);
			});
			reply.on("end", () => {
				if (body) return;
				res.writeHead(reply.statusCode, out);
				res.end();
			});
		},
	);
	upstream.setTimeout(API_IDLE_TIMEOUT, () =>
		upstream.destroy(new Error("timeout")),
	);
	upstream.on("error", () => {
		if (!res.headersSent) fail(res, 502, "desktop_unreachable");
		else res.destroy();
	});
	req.on("aborted", () => upstream.destroy());
	req.pipe(upstream);
}

/**
 * Handles every `/desktop/...` request. `ctx.owner` must be true only for a
 * browser owner session (store.canApprove); `ctx.origin` is the exact origin.
 */
export function handleDesktop(req, res, ctx) {
	if (!isDesktopRequest(req.url)) return false;
	// The dashboard embeds the viewer in a same-origin iframe.
	res.setHeader("x-frame-options", "SAMEORIGIN");
	if (!ctx.owner) {
		fail(res, 403, "browser_session_required");
		return true;
	}
	const target = parse(req.url);
	if (!target) {
		fail(res, 404, "not_found");
		return true;
	}
	const { slug, rest, search } = target;
	const read = ["GET", "HEAD"].includes(req.method);
	if (!read && req.headers.origin !== ctx.origin) {
		fail(res, 403, "origin_required");
		return true;
	}
	const needsGateway = rest.startsWith("/api/") || (rest === "/" && search);
	if (needsGateway && !ctx.key) {
		fail(res, 503, "desktop_unavailable");
		return true;
	}
	if (rest.startsWith("/api/")) {
		proxyApi(req, res, ctx, slug, rest, search);
		return true;
	}
	if (!read) {
		res.setHeader("allow", "GET, HEAD");
		fail(res, 405, "method_not_allowed");
		return true;
	}
	if (rest === "") {
		res.writeHead(302, { location: `${PREFIX}/${slug}/${search}` });
		res.end();
	} else if (rest === "/") {
		if (search.length <= 1) streamEndedPage(res, slug);
		else if (req.method === "GET") open(res, ctx, slug, search);
		else {
			res.setHeader("allow", "GET");
			fail(res, 405, "method_not_allowed");
		}
	} else if (rest === "/config.js") {
		const prefix = `${PREFIX}/${slug}`;
		res.writeHead(200, {
			"content-type": "text/javascript; charset=utf-8",
			"cache-control": "no-store",
			"content-security-policy": VIEWER_CSP(),
		});
		// The second statement remembers the open parameters for Reconnect.
		res.end(
			`window.__CONFIG_JS__ = ${JSON.stringify({ path_prefix: prefix })};\ntry{const q=new URLSearchParams(location.search),s=new URLSearchParams();for(const k of ["fps","bitrate","language","dataTransport"]){const v=q.get(k);if(v)s.set(k,v)}if(q.has("hostId"))sessionStorage.setItem(${JSON.stringify(`umiak-desktop:${prefix}/`)},s.toString())}catch{}\n`,
		);
	} else serveStatic(req, res, ctx, rest);
	return true;
}

function refuse(socket, status, reason, code) {
	const body = JSON.stringify({
		error: { code, message: code, retryable: false },
	});
	socket.end(
		`HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
	);
}

// Any control character other than HTAB (CR/LF were already split on).
const hasControl = (line) =>
	[...line].some((c) => {
		const code = c.charCodeAt(0);
		return (code < 32 && code !== 9) || code === 127;
	});

/** WebSocket for the viewer stream; same `ctx` as handleDesktop. */
export function handleDesktopUpgrade(req, socket, head, ctx) {
	if (!isDesktopRequest(req.url)) return false;
	if (!ctx.owner) {
		refuse(socket, 403, "Forbidden", "browser_session_required");
		return true;
	}
	const target = parse(req.url);
	if (!target || target.rest !== WEB_SOCKET_PATH) {
		refuse(socket, 404, "Not Found", "not_found");
		return true;
	}
	if (req.headers.origin !== ctx.origin) {
		refuse(socket, 403, "Forbidden", "origin_required");
		return true;
	}
	if (!ctx.key) {
		refuse(socket, 503, "Service Unavailable", "desktop_unavailable");
		return true;
	}
	const clientKey = req.headers["sec-websocket-key"] ?? "";
	if (!/^[A-Za-z0-9+/]{22}==$/.test(clientKey)) {
		refuse(socket, 400, "Bad Request", "invalid_websocket_key");
		return true;
	}
	const expectedAccept = createHash("sha1")
		.update(clientKey + WS_GUID)
		.digest("base64");
	const offered = (req.headers["sec-websocket-protocol"] ?? "")
		.split(",")
		.map((x) => x.trim())
		.filter(Boolean);
	const gw = gatewayTarget(ctx, target.slug);
	const headers = {
		host: gw.hostHeader,
		connection: "Upgrade",
		upgrade: "websocket",
		...pick(req.headers, WS_REQUEST_HEADERS),
		"umiak-ingress-desktop": gw.credential,
	};
	const upstream = net.connect(gw.port, gw.host);
	let relaying = false;
	let buffered = Buffer.alloc(0);
	const abort = () => {
		upstream.destroy();
		if (!relaying && !socket.destroyed)
			refuse(socket, 502, "Bad Gateway", "desktop_upstream_rejected");
		else socket.destroy();
	};
	upstream.setTimeout(HANDSHAKE_TIMEOUT, abort);
	upstream.on("connect", () => {
		upstream.write(
			`GET ${WEB_SOCKET_PATH}${target.search} HTTP/1.1\r\n${Object.entries(
				headers,
			)
				.map(([key, value]) => `${key}: ${value}`)
				.join("\r\n")}\r\n\r\n`,
		);
		if (head?.length) upstream.write(head);
	});
	const onHandshake = (chunk) => {
		buffered = Buffer.concat([buffered, chunk]);
		const end = buffered.indexOf("\r\n\r\n");
		if (end < 0) {
			if (buffered.length > 16384) abort();
			return;
		}
		const lines = buffered.subarray(0, end).toString("latin1").split("\r\n");
		if (!/^HTTP\/1\.1 101 /.test(lines[0])) return abort();
		// Rebuild the 101 ourselves; upstream values are validated, never copied.
		const fields = new Map();
		for (const line of lines.slice(1)) {
			const colon = line.indexOf(":");
			if (colon < 1 || hasControl(line)) return abort();
			const name = line.slice(0, colon).trim().toLowerCase();
			if (fields.has(name)) return abort();
			fields.set(name, line.slice(colon + 1).trim());
		}
		const protocol = fields.get("sec-websocket-protocol");
		if (
			fields.get("upgrade")?.toLowerCase() !== "websocket" ||
			fields.get("sec-websocket-accept") !== expectedAccept ||
			fields.has("sec-websocket-extensions") ||
			(protocol !== undefined && !offered.includes(protocol))
		)
			return abort();
		upstream.off("data", onHandshake);
		upstream.setTimeout(0);
		relaying = true;
		socket.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${expectedAccept}\r\n${protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : ""}\r\n`,
		);
		const rest = buffered.subarray(end + 4);
		if (rest.length) socket.write(rest);
		socket.pipe(upstream);
		upstream.pipe(socket);
	};
	upstream.on("data", onHandshake);
	upstream.on("end", () => {
		if (!relaying) abort();
	});
	upstream.on("close", () => {
		if (relaying) socket.destroy();
	});
	upstream.on("error", abort);
	socket.on("error", () => upstream.destroy());
	socket.on("close", () => upstream.destroy());
	return true;
}
