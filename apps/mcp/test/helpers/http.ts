// The remote MCP server on a random port, backed by the fake API, with an
// MCP Streamable HTTP client of either protocol era. The fake's contract
// errors are asserted empty by `close()`.
//
//   const h = await startHttp();          // afterEach: await h.close()
//   const c = await h.connect(FAKE_TOKENS.full, { era: "legacy" });
//   await c.client.listTools();
import { request as httpRequest, type Server } from "node:http";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { serve } from "@hono/node-server";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { expect } from "vitest";
import {
	createHttpApp,
	type HttpApp,
	type HttpOptions,
} from "../../src/http/app.ts";
import { createLogger } from "../../src/log.ts";
import { Metrics } from "../../src/metrics.ts";
import {
	type FakeApi,
	type FakeApiOptions,
	startFakeApi,
} from "../fake-api/index.ts";
import {
	type Era,
	MODERN_PROTOCOL_VERSION,
	TEST_CLIENT_INFO,
} from "./connect.ts";

export interface ApiCall {
	method: string;
	path: string;
	headers: Headers;
}

export interface HttpConnection {
	client: Client;
	/** Every HTTP response the client got from the MCP server, in order. */
	responses: { status: number; headers: Headers }[];
	close(): Promise<void>;
}

export interface ConnectOptions {
	era?: Era;
	/** Appended to the URL, e.g. `?toolsets=core`. */
	query?: string;
	headers?: Record<string, string>;
}

export interface RawAnswer {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	text: string;
}

export interface HttpHarness {
	api: FakeApi;
	http: HttpApp;
	metrics: Metrics;
	/** http://127.0.0.1:<port>/mcp */
	url: string;
	origin: string;
	/** Requests the server made to the fake API. */
	apiCalls: ApiCall[];
	logs: Record<string, unknown>[];
	clock: { now: number };
	connect(token: string | null, o?: ConnectOptions): Promise<HttpConnection>;
	/** A raw HTTP request through node:http (any Host header). */
	raw(
		method: string,
		path: string,
		o?: { headers?: Record<string, string>; body?: string | Buffer },
	): Promise<RawAnswer>;
	/** Requests of the fake API journal matching "METHOD /path". */
	journal(re: RegExp): string[];
	close(): Promise<void>;
}

export interface HttpHarnessOptions {
	api?: FakeApiOptions;
	http?: Partial<HttpOptions>;
	/** Default: a free one. */
	port?: number;
}

export async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const s = createNetServer();
		s.once("error", reject);
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address() as AddressInfo;
			s.close(() => resolve(port));
		});
	});
}

export async function startHttp(
	o: HttpHarnessOptions = {},
): Promise<HttpHarness> {
	const api = await startFakeApi(o.api);
	const apiCalls: ApiCall[] = [];
	const recordingFetch: typeof fetch = async (input, init) => {
		const req =
			input instanceof Request && init === undefined
				? input
				: new Request(input, init);
		apiCalls.push({
			method: req.method,
			path: new URL(req.url).pathname,
			headers: new Headers(req.headers),
		});
		return fetch(req);
	};
	const logs: Record<string, unknown>[] = [];
	const log = createLogger({
		level: "debug",
		destination: { write: (line: string) => logs.push(JSON.parse(line)) },
	});
	const metrics = new Metrics();
	const clock = { now: Date.now() };
	const port = o.port ?? (await freePort());
	const origin = `http://127.0.0.1:${port}`;
	const url = `${origin}/mcp`;
	const http = createHttpApp({
		ownerEnv: {
			UMIAK_AUTH_MODE: "owner",
			UMIAK_LOCAL_ALLOWED_CIDRS: "127.0.0.0/8,::1/128",
		},
		apiUrl: api.url,
		publicUrl: url,
		log,
		metrics,
		fetch: recordingFetch,
		now: () => clock.now,
		...o.http,
	});
	const server = await new Promise<Server>((resolve) => {
		const s = serve(
			{ fetch: http.app.fetch, port, hostname: "127.0.0.1" },
			() => resolve(s as Server),
		);
	});
	const connections: HttpConnection[] = [];

	return {
		api,
		http,
		metrics,
		url,
		origin,
		apiCalls,
		logs,
		clock,
		async connect(token, c = {}) {
			const responses: HttpConnection["responses"] = [];
			const headers: Record<string, string> = { ...c.headers };
			if (token !== null) headers.Authorization = `Bearer ${token}`;
			const transport = new StreamableHTTPClientTransport(
				new URL(`${url}${c.query ?? ""}`),
				{
					requestInit: { headers },
					fetch: async (input, init) => {
						const res = await fetch(input, init);
						responses.push({ status: res.status, headers: res.headers });
						return res;
					},
				},
			);
			const client = new Client(
				TEST_CLIENT_INFO,
				(c.era ?? "modern") === "modern"
					? { versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } }
					: {},
			);
			await client.connect(transport);
			const conn: HttpConnection = {
				client,
				responses,
				close: () => client.close(),
			};
			connections.push(conn);
			return conn;
		},
		raw(method, path, r = {}) {
			return new Promise((resolve, reject) => {
				const req = httpRequest(
					{
						host: "127.0.0.1",
						port,
						method,
						path,
						headers: { host: `127.0.0.1:${port}`, ...r.headers },
					},
					(res) => {
						const chunks: Buffer[] = [];
						res.on("data", (d: Buffer) => chunks.push(d));
						res.on("end", () =>
							resolve({
								status: res.statusCode ?? 0,
								headers: res.headers,
								text: Buffer.concat(chunks).toString("utf8"),
							}),
						);
						res.on("error", reject);
					},
				);
				req.on("error", reject);
				req.end(r.body);
			});
		},
		journal: (re) => api.journal.filter((l) => re.test(l)),
		async close() {
			for (const c of connections) await c.close().catch(() => {});
			await http.close();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await api.close();
			expect(api.contractErrors).toEqual([]);
		},
	};
}

/** A JWT-shaped token with this `exp` (seconds); the signature is junk. */
export function fakeJwt(exp: number, sub = "user"): string {
	const part = (v: unknown) =>
		Buffer.from(JSON.stringify(v)).toString("base64url");
	return `${part({ alg: "RS256", typ: "JWT" })}.${part({ sub, exp })}.c2ln`;
}
