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
		localEnv: {
			UMIAK_AUTH_MODE: "none",
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
	app = createHttpApp({
		apiUrl: "http://api",
		publicUrl: "http://localhost/mcp",
		issuer: null,
		log: createLogger({ level: "silent" }),
		localEnv: { UMIAK_AUTH_MODE: "none" },
		fetch: (async (req: Request) => {
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

it.each(["none", "oidc"] as const)(
	"%s mode keeps a rejected team key unauthorized and advertises OAuth only in oidc",
	async (mode) => {
		app = createHttpApp({
			apiUrl: "http://api",
			publicUrl: "http://localhost/mcp",
			issuer:
				mode === "none" ? null : "https://keycloak.example.com/realms/umiak",
			log: createLogger({ level: "silent" }),
			localEnv: { UMIAK_AUTH_MODE: mode },
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
			localEnv: { UMIAK_AUTH_MODE: "none" },
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
