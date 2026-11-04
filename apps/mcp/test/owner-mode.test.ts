import { createServer, type IncomingMessage } from "node:http";
import { createPublicApp } from "@umiak/api";
import { makeTestDeps, testSettings } from "@umiak/api/testing";
import { afterEach, expect, it } from "vitest";
import { createHttpApp } from "../src/http/app.ts";
import { createLogger } from "../src/log.ts";

let app: ReturnType<typeof createHttpApp>;
afterEach(async () => {
	await app?.close();
});
it("rejects unallowed socket peers despite a spoofed forwarded address", async () => {
	app = createHttpApp({
		apiUrl: "http://api",
		publicUrl: "http://localhost/mcp",
		issuer: null,
		log: createLogger({ level: "silent" }),
		ownerEnv: {
			UMIAK_AUTH_MODE: "owner",
			UMIAK_LOCAL_ALLOWED_CIDRS: "127.0.0.0/8",
		},
	});
	const response = await app.app.request(
		"http://localhost/mcp",
		{
			method: "POST",
			headers: { host: "localhost", "x-forwarded-for": "127.0.0.1" },
		},
		{ incoming: { socket: { remoteAddress: "203.0.113.7" } } },
	);
	expect(response.status).toBe(403);
});
it("accepts a local request without an OAuth challenge", async () => {
	const forwarded: (string | null)[] = [];
	const api = createPublicApp(
		makeTestDeps({
			settings: testSettings({
				UMIAK_AUTH_MODE: "owner",
				UMIAK_LOCAL_ALLOWED_CIDRS: "127.0.0.0/8",
				UMIAK_API_URL: "http://localhost:4180",
			}),
		}),
	);
	app = createHttpApp({
		apiUrl: "http://api",
		publicUrl: "http://localhost/mcp",
		issuer: null,
		log: createLogger({ level: "silent" }),
		ownerEnv: {
			UMIAK_AUTH_MODE: "owner",
			UMIAK_LOCAL_ALLOWED_CIDRS: "127.0.0.0/8",
			UMIAK_API_URL: "http://localhost:4180",
		},
		fetch: (async (req: Request) => {
			const guarded = await api.request(
				"/v1/meta",
				{ headers: req.headers },
				{
					incoming: {
						socket: { remoteAddress: "127.0.0.1" },
					} as IncomingMessage,
				},
			);
			if (!guarded.ok) return guarded;
			forwarded.push(req.headers.get("x-forwarded-for"));
			return Response.json({
				auth: { kind: "session", scopes: ["sandboxes:read"] },
				user: { id: "local" },
			});
		}) as typeof fetch,
	});
	const response = await app.app.request(
		"http://localhost/mcp",
		{
			method: "POST",
			headers: {
				host: "localhost",
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-11-25",
					capabilities: {},
					clientInfo: { name: "test", version: "1" },
				},
			}),
		},
		{ incoming: { socket: { remoteAddress: "127.0.0.1" } } },
	);
	expect(response.status).toBe(200);
	expect(response.headers.has("www-authenticate")).toBe(false);
	expect(forwarded).toEqual(["127.0.0.1"]);
});

it.each(["owner", "oidc"] as const)(
	"%s mode keeps a rejected team key unauthorized and advertises OAuth only in oidc",
	async (mode) => {
		app = createHttpApp({
			apiUrl: "http://api",
			publicUrl: "http://localhost/mcp",
			issuer:
				mode === "owner" ? null : "https://keycloak.example.com/realms/umiak",
			log: createLogger({ level: "silent" }),
			ownerEnv: {
				UMIAK_AUTH_MODE: mode,
				UMIAK_LOCAL_ALLOWED_CIDRS: "127.0.0.0/8",
			},
			fetch: (async () =>
				Response.json(
					{
						error: {
							code: "unauthorized",
							message: "the team key was revoked",
							retryable: false,
							details: {},
						},
					},
					{ status: 401 },
				)) as typeof fetch,
		});
		const response = await app.app.request(
			"http://localhost/mcp",
			{
				method: "POST",
				headers: {
					host: "localhost",
					authorization: "Bearer umiak_revoked",
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
				},
				body: "{}",
			},
			{ incoming: { socket: { remoteAddress: "127.0.0.1" } } },
		);
		expect(response.status).toBe(401);
		expect(response.headers.has("www-authenticate")).toBe(mode === "oidc");
	},
);

it.each(["", "Basic abc", "Bearer", "Bearer umiak_first, Bearer umiak_second"])(
	"rejects malformed Authorization %j without falling back to the local owner",
	async (authorization) => {
		let apiCalls = 0;
		app = createHttpApp({
			apiUrl: "http://api",
			publicUrl: "http://localhost/mcp",
			issuer: null,
			log: createLogger({ level: "silent" }),
			ownerEnv: {
				UMIAK_AUTH_MODE: "owner",
				UMIAK_LOCAL_ALLOWED_CIDRS: "127.0.0.0/8",
			},
			fetch: (async () => {
				apiCalls++;
				throw new Error("must not reach API");
			}) as typeof fetch,
		});
		const response = await app.app.request(
			"http://localhost/mcp",
			{
				method: "POST",
				headers: {
					host: "localhost",
					authorization,
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
				},
				body: "{}",
			},
			{ incoming: { socket: { remoteAddress: "127.0.0.1" } } },
		);
		expect(response.status).toBe(401);
		expect(response.headers.has("www-authenticate")).toBe(false);
		expect(apiCalls).toBe(0);
	},
);

it("default local MCP transport preserves canonical Host through a real HTTP socket", async () => {
	const api = createServer((req, res) => {
		if (req.headers.host !== "localhost:4180") {
			res.writeHead(403);
			res.end("host_forbidden");
			return;
		}
		res.setHeader("content-type", "application/json");
		res.end(
			JSON.stringify({
				auth: { kind: "session", scopes: ["sandboxes:read"] },
				user: { id: "local" },
			}),
		);
	});
	await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
	const address = api.address();
	if (!address || typeof address === "string") throw Error("missing address");
	try {
		app = createHttpApp({
			apiUrl: `http://127.0.0.1:${address.port}`,
			publicUrl: "http://localhost/mcp",
			issuer: null,
			log: createLogger({ level: "silent" }),
			ownerEnv: {
				UMIAK_AUTH_MODE: "owner",
				UMIAK_LOCAL_ALLOWED_CIDRS: "127.0.0.0/8",
				UMIAK_API_URL: "http://localhost:4180",
			},
		});
		const response = await app.app.request(
			"http://localhost/mcp",
			{
				method: "POST",
				headers: {
					host: "localhost",
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: {
						protocolVersion: "2025-11-25",
						capabilities: {},
						clientInfo: { name: "test", version: "1" },
					},
				}),
			},
			{ incoming: { socket: { remoteAddress: "127.0.0.1" } } },
		);
		expect(response.status).toBe(200);
	} finally {
		await new Promise<void>((resolve) => api.close(() => resolve()));
	}
});
