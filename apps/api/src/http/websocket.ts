// WebSocket upgrades of a listener app (S7 §10.2). An upgrade request goes
// through the app like any request: request id, logs, metrics, the
// listener's authentication (Bearer; oauth2-proxy headers, Origin and
// `?team=` on proxied), scopes and validation. A route that accepts it
// calls `acceptWebSocket(c, ...)`; anything else the app answers (401,
// 403 origin_forbidden, 400, 429, ...) is written to the socket as a full
// HTTP response with the error envelope. (@hono/node-server's
// `upgradeWebSocket` writes refusals without a body, so this module owns
// the `upgrade` event instead.)
import { type IncomingMessage, type Server, STATUS_CODES } from "node:http";
import type { Duplex } from "node:stream";
import { createAdaptorServer } from "@hono/node-server";
import type { Context } from "hono";
import { type WebSocket, WebSocketServer } from "ws";
import type { ApiEnv } from "../deps.ts";

/** Largest client message (input bytes or a control frame). */
export const WS_MAX_PAYLOAD = 1024 * 1024;

/** What a route does with an accepted upgrade. */
export interface WebSocketAccept {
	/** The subprotocol to answer with (one the client offered). */
	protocol: string;
	/** The handshake completed. */
	open(ws: WebSocket): void;
	/** The handshake did not complete (socket gone, refused by `ws`). */
	cancel(): void;
}

const ACCEPT = Symbol("sbx.websocket.accept");

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

function toRequest(req: IncomingMessage): Request {
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
	return new Request(url, { headers });
}

/** The app's answer as a plain HTTP response; the connection closes. */
async function refuse(socket: Duplex, res: Response): Promise<void> {
	const body = Buffer.from(
		await res.arrayBuffer().catch(() => new ArrayBuffer(0)),
	);
	if (socket.destroyed) return;
	const lines = [
		`HTTP/1.1 ${res.status} ${STATUS_CODES[res.status] ?? ""}`,
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
	const env: UpgradeEnv = {
		incoming: req,
		outgoing: undefined,
		[ACCEPT]: null,
	};
	let res: Response;
	try {
		const r = await fetch(toRequest(req), env);
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
 */
export function handleUpgrades(
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
	const server = createAdaptorServer({ fetch: app.fetch as never }) as Server;
	const wss = handleUpgrades(server, app.fetch);
	return { server, wss };
}
