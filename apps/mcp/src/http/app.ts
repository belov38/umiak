// Remote MCP server (S11 6.2-6.6, 10.2, 11.5): stateless Streamable HTTP on
// `POST <public path>`. Every request goes Host -> Origin -> bearer (GET
// /v1/me, cached) -> body limit -> a fresh McpServer for this principal
// (createMcpHandler, both protocol eras). The bearer of the request is the
// only credential the SDK client of the request uses.
import {
	type AuthInfo,
	CLIENT_INFO_META_KEY,
	createMcpHandler,
	type McpRequestContext,
	TRACEPARENT_META_KEY,
} from "@modelcontextprotocol/server";
import { authMode, isLocalClientAllowed, TrustedProxies } from "@umiak/auth";
import { Umiak } from "@umiak/sdk";
import { type Context, Hono } from "hono";
import { type ClientInfo, userAgentOf } from "../context.ts";
import { apiCallLogger, type Logger } from "../log.ts";
import type { Metrics } from "../metrics.ts";
import { parseToolsets, type Toolset } from "../registry.ts";
import { createServer } from "../server.ts";
import { ALL_TOOLS } from "../tools/index.ts";
import {
	type AuthRejection,
	bearerOf,
	createAuthenticator,
	isRejection,
	MeCache,
	type Principal,
} from "./auth.ts";
import {
	allowedHostsOf,
	allowedOriginsOf,
	CallLimiter,
	hostAllowed,
	MAX_BODY_BYTES,
	originAllowed,
	readBodyLimited,
} from "./limits.ts";
import {
	bearerChallenge,
	prmPath,
	prmUrl,
	protectedResourceMetadata,
} from "./prm.ts";

export interface HttpOptions {
	localEnv?: Record<string, string | undefined>;
	/** UMIAK_MCP_API_URL: the api's public listener. */
	apiUrl: string;
	/** UMIAK_MCP_PUBLIC_URL, e.g. https://api.example.com/mcp. */
	publicUrl: string;
	/** UMIAK_OIDC_ISSUER (PRM authorization_servers); null: none. */
	issuer: string | null;
	/** Extra Host values (UMIAK_MCP_ALLOWED_HOSTS). */
	allowedHosts?: string[];
	/** Origins a browser may call from (UMIAK_MCP_ALLOWED_ORIGINS); default none. */
	allowedOrigins?: string[];
	log: Logger;
	metrics?: Metrics;
	/** fetch of every api call (tests). */
	fetch?: typeof fetch;
	/** Replaces the bearer check (tests, conformance). */
	authenticate?: (
		req: Request,
		team: string | undefined,
	) => Promise<Principal | Response>;
	now?: () => number;
}

export interface HttpApp {
	app: Hono;
	/** False once drain() or close() was called (/readyz). */
	ready(): boolean;
	/** Readiness goes false and new /mcp requests get 503; calls in flight go on. */
	drain(): void;
	/** drain(), then the exchanges still in flight are torn down. */
	close(): Promise<void>;
}

/** authInfo.extra key of the request state the factory reads. */
const STATE = "umiak";

/** What one HTTP request hands to its McpServer. */
interface RequestState {
	clientIp?: string;
	principal: Principal;
	toolsets?: Toolset[];
	readOnly: boolean;
	client?: ClientInfo;
	traceparent?: string;
	/** The api answered 401 during a call of this request. */
	authFailed: boolean;
}

/** A team id as the API gives it (team_ and a base32 id). */
const TEAM_ID = /^team_[A-Za-z0-9]{1,64}$/;

const TRACEPARENT = /^[\da-f]{2}-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/;

/** JSON-RPC error body of the HTTP-level refusals (as the MCP SDK's own). */
function rpcError(status: number, message: string, headers = {}): Response {
	return Response.json(
		{ jsonrpc: "2.0", error: { code: -32000, message }, id: null },
		{ status, headers },
	);
}

function isJson(res: Response): boolean {
	return (res.headers.get("content-type") ?? "").startsWith("application/json");
}

/** traceparent and clientInfo of a single request's `_meta` (2026-07-28 envelope). */
function metaOf(body: unknown): { client?: ClientInfo; traceparent?: string } {
	if (typeof body !== "object" || body === null || Array.isArray(body))
		return {};
	const params = (body as { params?: unknown }).params;
	const meta =
		typeof params === "object" && params !== null
			? (params as { _meta?: unknown })._meta
			: undefined;
	if (typeof meta !== "object" || meta === null) return {};
	const m = meta as Record<string, unknown>;
	const out: { client?: ClientInfo; traceparent?: string } = {};
	const tp = m[TRACEPARENT_META_KEY];
	if (typeof tp === "string" && TRACEPARENT.test(tp)) out.traceparent = tp;
	const info = m[CLIENT_INFO_META_KEY] as Record<string, unknown> | undefined;
	if (typeof info?.name === "string" && typeof info.version === "string") {
		out.client = { name: info.name, version: info.version };
	}
	return out;
}

/** fetch that adds traceparent to every api call of the request (13.3). */
function withTraceparent(f: typeof fetch, tp: string | undefined) {
	if (tp === undefined) return f;
	return ((input: RequestInfo | URL, init?: RequestInit) => {
		if (input instanceof Request && init === undefined) {
			// The SDK's own Request object: mutated, not copied (it holds it).
			input.headers.set("traceparent", tp);
			return f(input);
		}
		const headers = new Headers(
			init?.headers ?? (input instanceof Request ? input.headers : undefined),
		);
		headers.set("traceparent", tp);
		return f(input, { ...init, headers });
	}) as typeof fetch;
}

function queryFlags(
	url: URL,
): { toolsets?: Toolset[]; readOnly: boolean } | string {
	const out: { toolsets?: Toolset[]; readOnly: boolean } = { readOnly: false };
	const toolsets = url.searchParams.get("toolsets");
	if (toolsets !== null) {
		try {
			out.toolsets = parseToolsets(toolsets);
		} catch (err) {
			return `toolsets: ${(err as Error).message}`;
		}
	}
	const ro = url.searchParams.get("read_only");
	if (ro !== null) {
		if (ro === "1" || ro === "true") out.readOnly = true;
		else if (!(ro === "0" || ro === "false" || ro === ""))
			return "read_only: must be 1 or 0";
	}
	return out;
}

export function createHttpApp(o: HttpOptions): HttpApp {
	const clients = new WeakMap<Request, string>();
	function forwardClient(
		f: typeof fetch,
		ip: string | undefined,
	): typeof fetch {
		if (ip === undefined) return f;
		return (async (input, init) => {
			const request = new Request(input, init);
			request.headers.set("x-forwarded-for", ip);
			return f(request);
		}) as typeof fetch;
	}
	const log = o.log;
	const canonicalApi =
		o.localEnv?.UMIAK_AUTH_MODE === "none" && o.localEnv.UMIAK_API_URL;
	// Connect to fixed internal DNS while presenting the configured API authority.
	// Never derive this Host from an incoming browser or MCP header.
	const apiTransport = canonicalApi
		? ((async (input: RequestInfo | URL, init?: RequestInit) => {
				const request = new Request(input, init);
				request.headers.set("host", new URL(canonicalApi).host);
				return (o.fetch ?? fetch)(request);
			}) as typeof fetch)
		: (o.fetch ?? fetch);
	const apiFetch = apiCallLogger(apiTransport, log);
	const mcpPath = new URL(o.publicUrl).pathname.replace(/(.)\/+$/, "$1");
	const metadataUrl = prmUrl(o.publicUrl);
	const metadata = protectedResourceMetadata(o);
	const hosts = allowedHostsOf(o.publicUrl, o.allowedHosts);
	const origins = allowedOriginsOf(o.allowedOrigins);
	const limiter = new CallLimiter();
	const cache = new MeCache({ ...(o.now === undefined ? {} : { now: o.now }) });
	const userAgent = userAgentOf("http", undefined);
	const check = createAuthenticator({
		apiUrl: o.apiUrl,
		fetch: apiFetch,
		cache,
		userAgent,
		...(o.now === undefined ? {} : { now: o.now }),
		...(o.metrics === undefined ? {} : { metrics: o.metrics }),
	});
	let closing = false;

	function refuse(r: AuthRejection): Response {
		o.metrics?.authRejections.inc({ status: r.status, reason: r.reason });
		log.info({ status: r.status, reason: r.reason }, "bearer refused");
		const headers: Record<string, string> = {};
		if (r.status === 401 && authMode(o.localEnv ?? {}) === "oidc") {
			headers["WWW-Authenticate"] = bearerChallenge(metadataUrl, r.challenge);
		}
		if (r.status === 503) headers["Retry-After"] = "1";
		return Response.json(
			{ error: r.code, error_description: r.message },
			{ status: r.status, headers },
		);
	}

	async function authenticate(
		req: Request,
		team: string | undefined,
	): Promise<Principal | Response> {
		if (o.authenticate !== undefined) return o.authenticate(req, team);
		const bearer = bearerOf(req);
		const local = authMode(o.localEnv ?? {}) === "none";
		if (local && req.headers.has("authorization") && bearer === null) {
			return refuse({
				status: 401,
				reason: "malformed_authorization",
				code: "unauthorized",
				message:
					"send one Authorization: Bearer <token> header or omit it in local mode",
			});
		}
		const token = bearer ?? (local ? "" : null);
		if (token === null) {
			o.metrics?.authRejections.inc({ status: 401, reason: "no_bearer" });
			return Response.json(
				{
					error: "unauthorized",
					error_description: "send Authorization: Bearer <token>",
				},
				{
					status: 401,
					headers: { "WWW-Authenticate": bearerChallenge(metadataUrl) },
				},
			);
		}
		const localClient = clients.get(req);
		const verify =
			localClient === undefined
				? check
				: createAuthenticator({
						apiUrl: o.apiUrl,
						fetch: forwardClient(apiFetch as typeof fetch, localClient),
						cache: new MeCache(),
						userAgent,
					});
		const r = await verify(token, team);
		return isRejection(r) ? refuse(r) : r;
	}

	function factory(ctx: McpRequestContext) {
		const state = ctx.authInfo?.extra?.[STATE] as RequestState | undefined;
		if (state === undefined) throw new Error("request without its state");
		const p = state.principal;
		let umiak: Umiak | undefined;
		return createServer({
			tools: ALL_TOOLS,
			...(state.toolsets === undefined ? {} : { toolsets: state.toolsets }),
			readOnly: state.readOnly,
			principal: { kind: p.kind, scopes: p.scopes },
			umiak: () => {
				umiak ??= new Umiak({
					baseUrl: o.apiUrl,
					...(p.token === ""
						? { session: true }
						: p.token.startsWith("umiak_")
							? { apiKey: p.token }
							: { accessToken: p.token }),
					...(p.team === undefined ? {} : { team: p.team }),
					fetch: withTraceparent(
						forwardClient(apiFetch as typeof fetch, state.clientIp),
						state.traceparent,
					),
					userAgent: userAgentOf("http", state.client),
					env: {},
				});
				return umiak;
			},
			transport: "http",
			log,
			onAuthFailure: () => {
				state.authFailed = true;
				cache.delete(p.token, p.team);
			},
			acquireSlot: () => {
				const release = limiter.acquire(p.subject);
				if (release === null) return null;
				o.metrics?.inFlight.inc();
				let done = false;
				return () => {
					if (done) return;
					done = true;
					release();
					o.metrics?.inFlight.dec();
				};
			},
			...(o.metrics === undefined
				? {}
				: { onCallEnd: (r) => o.metrics?.recordCall(r) }),
		});
	}

	const handler = createMcpHandler(factory, {
		legacy: "stateless",
		maxRequestBodySize: MAX_BODY_BYTES,
		onerror: (err) => log.debug({ reason: err.message }, "mcp request error"),
	});

	async function serveMcp(c: Context): Promise<Response> {
		const req = c.req.raw;
		const url = new URL(req.url);
		if (!hostAllowed(req.headers.get("host"), hosts)) {
			return rpcError(421, "this Host is not served here");
		}
		if (!originAllowed(req.headers.get("origin"), origins)) {
			return rpcError(403, "this Origin is not allowed");
		}
		if (closing) {
			return rpcError(503, "this server is shutting down; retry", {
				"Retry-After": "1",
			});
		}
		if (req.method !== "POST") {
			return rpcError(405, "Method not allowed.", { Allow: "POST" });
		}
		if (Number(req.headers.get("content-length")) > MAX_BODY_BYTES) {
			return rpcError(413, `the request body is over ${MAX_BODY_BYTES} bytes`);
		}
		const flags = queryFlags(url);
		if (typeof flags === "string") return rpcError(400, flags);
		// Umiak-Team wins over ?team=; either must look like a team id, so
		// nothing odd reaches /v1/me or the SDK's headers.
		const team =
			req.headers.get("umiak-team")?.trim() ||
			url.searchParams.get("team")?.trim() ||
			undefined;
		if (team !== undefined && !TEAM_ID.test(team)) {
			return refuse({
				status: 400,
				reason: "bad_team",
				code: "validation",
				message: "Umiak-Team and ?team= take a team id (team_...)",
			});
		}
		const principal = await authenticate(req, team);
		if (principal instanceof Response) return principal;

		let bytes: Uint8Array<ArrayBuffer> | null;
		try {
			bytes = await readBodyLimited(req, MAX_BODY_BYTES);
		} catch {
			// The client went away or the request limit closed it mid-body.
			return rpcError(408, "the request body did not arrive in time");
		}
		if (bytes === null) {
			return rpcError(413, `the request body is over ${MAX_BODY_BYTES} bytes`);
		}
		let parsedBody: unknown;
		try {
			parsedBody = JSON.parse(new TextDecoder().decode(bytes));
		} catch {
			// The handler answers the parse error itself.
		}
		const clientIp = clients.get(req);
		const state: RequestState = {
			principal,
			...(clientIp === undefined ? {} : { clientIp }),
			...flags,
			...metaOf(parsedBody),
			authFailed: false,
		};
		const authInfo: AuthInfo = {
			token: principal.token,
			clientId: principal.kind,
			scopes: principal.scopes,
			...(principal.expiresAt === null
				? {}
				: { expiresAt: Math.floor(principal.expiresAt / 1000) }),
			extra: { [STATE]: state },
		};
		// The body was read here: the handler gets the bytes again, and the
		// client's disconnect through the original signal.
		const forward = new Request(req.url, {
			method: "POST",
			headers: req.headers,
			body: bytes,
			signal: req.signal,
		});
		const res = await handler.fetch(forward, {
			authInfo,
			...(parsedBody === undefined ? {} : { parsedBody }),
		});
		if (state.authFailed && isJson(res)) {
			// The answer has not started: the client gets the 401 and refreshes
			// its token (decision 5). On SSE the tool error stays.
			await res.body?.cancel().catch(() => {});
			return refuse({
				status: 401,
				reason: "api_401_in_call",
				code: "unauthorized",
				message: "the API rejected the credential during the call",
				challenge: {
					error: "invalid_token",
					description: "the API rejected the credential",
				},
			});
		}
		return res;
	}

	const app = new Hono();
	if (authMode(o.localEnv ?? {}) === "none") {
		let observed = 0;
		const trusted = new TrustedProxies(
			(o.localEnv?.UMIAK_API_TRUSTED_PROXY_CIDRS ?? "")
				.split(",")
				.filter(Boolean),
		);
		app.use("*", async (c, next) => {
			const peer = (
				c.env as
					| { incoming?: { socket?: { remoteAddress?: string } } }
					| undefined
			)?.incoming?.socket?.remoteAddress;
			const client = trusted.clientOf(peer, c.req.header("x-forwarded-for"));
			if (observed++ < 10)
				console.info("local MCP observed peer/client (may be Docker NAT)", {
					peer,
					client,
				});
			if (!isLocalClientAllowed(client, o.localEnv))
				return c.json(
					{
						error: {
							code: "local_network_forbidden",
							message: "client address is outside UMIAK_LOCAL_ALLOWED_CIDRS",
						},
					},
					403,
				);
			if (client !== undefined) clients.set(c.req.raw, client);
			await next();
		});
	}

	app.get("/healthz", (c) => c.json({ ok: true }));
	app.get("/readyz", (c) =>
		closing
			? c.json({ ready: false, reasons: ["shutting_down"] }, 503)
			: c.json({ ready: true, reasons: [] }),
	);
	app.get(prmPath(o.publicUrl), (c) => {
		if (!hostAllowed(c.req.header("host") ?? null, hosts)) {
			return rpcError(421, "this Host is not served here");
		}
		return c.json(metadata);
	});
	app.all(mcpPath, serveMcp);

	return {
		app,
		ready: () => !closing,
		drain() {
			closing = true;
		},
		async close() {
			closing = true;
			await handler.close();
		},
	};
}

/** Ops listener (UMIAK_MCP_OPS_PORT): /metrics, /healthz, /readyz. */
export function createOpsApp(o: {
	metrics: Metrics;
	ready: () => boolean;
}): Hono {
	const app = new Hono();
	app.get("/healthz", (c) => c.json({ ok: true }));
	app.get("/readyz", (c) =>
		o.ready()
			? c.json({ ready: true, reasons: [] })
			: c.json({ ready: false, reasons: ["shutting_down"] }, 503),
	);
	app.get("/metrics", async (c) => {
		const r = o.metrics.registry;
		return c.body(await r.metrics(), 200, { "Content-Type": r.contentType });
	});
	return app;
}
