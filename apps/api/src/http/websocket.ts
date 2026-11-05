// WebSocket upgrades of a listener app (S7 §10.2). An upgrade request goes
// through the app like any request: request id, logs, metrics, the
// listener's authentication (Bearer; owner ingress headers, Origin and
// `?team=` on proxied), scopes and validation. A route that accepts it
// calls `acceptWebSocket(c, ...)`; anything else the app answers (401,
// 403 origin_forbidden, 400, 429, ...) is written to the socket as a full
// HTTP response with the error envelope (capped at 64 KiB).
// (@hono/node-server's `upgradeWebSocket` writes refusals without a body,
// so this module owns the `upgrade` event instead.) Only `Upgrade:
// websocket` requests to a WebSocket route (`upgradePaths`) take this
// path; any other request with `Connection: Upgrade` (h2c, another path)
// is served as a normal request, with its body and abort signal.
import { type IncomingMessage, type Server, STATUS_CODES } from "node:http";
import type { Duplex } from "node:stream";
import { createAdaptorServer } from "@hono/node-server";
import type { Context } from "hono";
import { type WebSocket, WebSocketServer } from "ws";
import type { ApiEnv } from "../deps.ts";

/** Largest client message (input bytes or a control frame). */
export const WS_MAX_PAYLOAD = 1024 * 1024;

/** Largest body of a refused upgrade (error envelopes are small). */
export const WS_REFUSAL_MAX_BODY = 64 * 1024;

/** Paths of the WebSocket routes: `GET .../ptys/{command}/connect`. */
export const WEBSOCKET_PATHS: readonly RegExp[] = [
	/^\/v1\/sandboxes\/[^/]+\/ptys\/[^/]+\/connect$/,
];

/** True for an `Upgrade: websocket` request to one of `paths`. */
export function isWebSocketRequest(
	req: IncomingMessage,
	paths: readonly RegExp[] = WEBSOCKET_PATHS,
): boolean {
	if (req.headers.upgrade?.toLowerCase() !== "websocket") return false;
	const path = (req.url ?? "/").split("?")[0] ?? "/";
	return paths.some((p) => p.test(path));
}

/** What a route does with an accepted upgrade. */
export interface WebSocketAccept {
	/** The subprotocol to answer with (one the client offered). */
	protocol: string;
	/** The handshake completed. */
	open(ws: WebSocket): void;
	/** The handshake did not complete (socket gone, refused by `ws`). */
	cancel(): void;
}

const ACCEPT = Symbol("umiak.websocket.accept");

/** Hono `c.env` of an upgrade request. */
interface UpgradeEnv {
	incoming: IncomingMessage;
	outgoing: undefined;
	[ACCEPT]?: WebSocketAccept | null;
}

function upgradeEnv(c: Context<ApiEnv>): UpgradeEnv | null {
	const env = c.env as Partial<UpgradeEnv> | undefined;
	return env !== undefined && env !== null && ACCEPT in env
		? (env as UpgradeEnv)
		: null;
}

/** True for a WebSocket upgrade that this server can complete. */
export function isWebSocketUpgrade(c: Context<ApiEnv>): boolean {
	return (
		c.req.header("upgrade")?.toLowerCase() === "websocket" &&
		upgradeEnv(c) !== null
	);
}

/** Subprotocols offered in Sec-WebSocket-Protocol. */
export function offeredProtocols(c: Context<ApiEnv>): string[] {
	return (c.req.header("sec-websocket-protocol") ?? "")
		.split(",")
		.map((p) => p.trim())
		.filter((p) => p !== "");
}

/**
 * Accepts the upgrade: `a.open` runs once the 101 is sent. The returned
 * response stands for the 101 (its headers, such as Request-Id, are added
 * to it); return it from the handler. Throws unless `isWebSocketUpgrade`.
 */
export function acceptWebSocket(
	c: Context<ApiEnv>,
	a: WebSocketAccept,
): Response {
	const env = upgradeEnv(c);
	if (env === null) throw new Error("not a WebSocket upgrade of this server");
	env[ACCEPT] = a;
	return c.body(null, 200);
}

/** The WebSocket server of `handleUpgrades` (no own HTTP server). */
export function createWebSocketServer(): WebSocketServer {
	return new WebSocketServer({
		noServer: true,
		perMessageDeflate: false,
		maxPayload: WS_MAX_PAYLOAD,
		// The route has checked the offer; answer with its choice.
		handleProtocols: (offered, req) => {
			const p = chosen.get(req);
			return p !== undefined && offered.has(p) ? p : false;
		},
	});
}

const chosen = new WeakMap<IncomingMessage, string>();

type Fetch = (request: Request, env: UpgradeEnv) => unknown;

// Hop-by-hop and handshake headers are the server's own.
const SKIP_HEADERS = new Set([
	"connection",
	"content-length",
	"keep-alive",
	"transfer-encoding",
	"upgrade",
	"sec-websocket-accept",
	"sec-websocket-extensions",
	"sec-websocket-protocol",
]);

function headerLines(h: Headers): string[] {
	const out: string[] = [];
	h.forEach((v, k) => {
		if (!SKIP_HEADERS.has(k.toLowerCase())) out.push(`${k}: ${v}`);
	});
	return out;
}

/** The upgrade request; its signal aborts when the socket closes. */
function toRequest(req: IncomingMessage, socket: Duplex): Request {
	const tls = (req.socket as { encrypted?: boolean }).encrypted === true;
	const url = new URL(
		req.url ?? "/",
		`${tls ? "https" : "http"}://${req.headers.host ?? "localhost"}`,
	);
	const headers = new Headers();
	for (const [k, v] of Object.entries(req.headers)) {
		if (v === undefined) continue;
		for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
	}
	const ac = new AbortController();
	if (socket.destroyed) ac.abort();
	else socket.once("close", () => ac.abort());
	return new Request(url, { headers, signal: ac.signal });
}

/** The body of `res` up to `max` bytes; null when it is longer. */
async function cappedBody(res: Response, max: number): Promise<Buffer | null> {
	if (res.body === null) return Buffer.alloc(0);
	const reader = res.body.getReader();
	const parts: Uint8Array[] = [];
	let n = 0;
	try {
		for (;;) {
			const r = await reader.read();
			if (r.done) return Buffer.concat(parts);
			n += r.value.length;
			if (n > max) return null;
			parts.push(r.value);
		}
	} catch {
		return Buffer.alloc(0);
	} finally {
		void reader.cancel().catch(() => {});
	}
}

/**
 * The app's answer as a plain HTTP response; the connection closes. A body
 * over WS_REFUSAL_MAX_BODY is not read further: 500 without a body.
 */
async function refuse(socket: Duplex, res: Response): Promise<void> {
	const capped = await cappedBody(res, WS_REFUSAL_MAX_BODY);
	if (socket.destroyed) return;
	const status = capped === null ? 500 : res.status;
	const body = capped ?? Buffer.alloc(0);
	const lines = [
		`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}`,
		...headerLines(res.headers),
		"Connection: close",
		`Content-Length: ${body.length}`,
	];
	socket.end(
		Buffer.concat([Buffer.from(`${lines.join("\r\n")}\r\n\r\n`), body]),
	);
}

async function upgrade(
	wss: WebSocketServer,
	fetch: Fetch,
	req: IncomingMessage,
	socket: Duplex,
	head: Buffer,
): Promise<void> {
	socket.on("error", () => socket.destroy());
	if (!isWebSocketRequest(req)) {
		// Only reachable on a server built without the shouldUpgradeCallback.
		await refuse(socket, new Response(null, { status: 400 }));
		return;
	}
	const env: UpgradeEnv = {
		incoming: req,
		outgoing: undefined,
		[ACCEPT]: null,
	};
	let res: Response;
	try {
		const r = await fetch(toRequest(req, socket), env);
		res = r instanceof Response ? r : new Response(null, { status: 500 });
	} catch {
		res = new Response(null, { status: 500 });
	}
	const a = env[ACCEPT] ?? null;
	if (a === null || res.status >= 300) {
		a?.cancel();
		await refuse(socket, res);
		return;
	}
	if (socket.destroyed) {
		a.cancel();
		return;
	}
	let opened = false;
	const onClose = () => {
		if (!opened) a.cancel();
	};
	socket.once("close", onClose);
	chosen.set(req, a.protocol);
	const addHeaders = (lines: string[]) => {
		lines.push(...headerLines(res.headers));
	};
	wss.on("headers", addHeaders);
	try {
		wss.handleUpgrade(req, socket, head, (ws) => {
			opened = true;
			socket.off("close", onClose);
			a.open(ws);
		});
	} finally {
		wss.off("headers", addHeaders);
	}
}

/**
 * Completes WebSocket upgrades of `server` through `fetch` (the listener
 * app's `fetch`). Returns the WebSocket server; it is closed with `server`.
 * The server must be created with `shouldUpgradeCallback:
 * isWebSocketRequest`, else other upgrade requests are refused with 400.
 */
function handleUpgrades(
	server: Server,
	fetch: (request: Request, env: never) => unknown,
	wss: WebSocketServer = createWebSocketServer(),
): WebSocketServer {
	server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
		void upgrade(wss, fetch as Fetch, req, socket, head);
	});
	server.on("close", () => wss.close());
	return wss;
}

/**
 * The HTTP server of a listener app (public, proxied): @hono/node-server's
 * request handling plus WebSocket upgrades. Call `server.listen(...)`.
 */
export function createApiServer(app: {
	fetch: (request: Request, env: never) => unknown;
}): { server: Server; wss: WebSocketServer } {
	const server = createAdaptorServer({
		fetch: app.fetch as never,
		// Other requests with Connection: Upgrade stay normal requests.
		serverOptions: { shouldUpgradeCallback: (req) => isWebSocketRequest(req) },
	}) as Server;
	const wss = handleUpgrades(server, app.fetch);
	return { server, wss };
}
