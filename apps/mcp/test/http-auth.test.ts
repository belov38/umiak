// Bearer check of the remote MCP server (S11 6.3, 11.5): challenges and
// Protected Resource Metadata, GET /v1/me with its cache, the 55 s rule, and
// the team (Umiak-Team, ?team=) of /v1/me and of the calls.
import { afterEach, describe, expect, it } from "vitest";
import { MeCache } from "../src/http/auth.ts";
import { FAKE_TEAM, FAKE_TOKENS, OTHER_TEAM } from "./fake-api/index.ts";
import { type HttpHarness, startHttp } from "./helpers/http.ts";

let h: HttpHarness | undefined;

afterEach(async () => {
	await h?.close();
	h = undefined;
});

/** The harness of the running test. */
function H(): HttpHarness {
	if (h === undefined) throw new Error("no harness");
	return h;
}

// biome-ignore lint/suspicious/noExplicitAny: loose JSON in assertions
type Json = any;

const INIT = JSON.stringify({
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "2025-11-25",
		capabilities: {},
		clientInfo: { name: "raw", version: "1" },
	},
});

/** A 2025-era initialize POST with this bearer (null: none). */
function post(token: string | null, headers: Record<string, string> = {}) {
	return H().raw("POST", "/mcp", {
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...(token === null ? {} : { authorization: `Bearer ${token}` }),
			...headers,
		},
		body: INIT,
	});
}

const meCalls = () => H().journal(/^GET \/v1\/me$/).length;

describe("challenges and metadata", () => {
	it("answers 503 with Retry-After, uncached, when /v1/me fails", async () => {
		h = await startHttp();
		h.api.script.failNext = {
			path: /^GET \/v1\/me$/,
			status: 500,
			code: "internal",
			retryable: false,
		};
		const r = await post(FAKE_TOKENS.full);
		expect(r.status).toBe(503);
		expect(r.headers["retry-after"]).toBe("1");
		expect(JSON.parse(r.text) as Json).toMatchObject({
			error: "api_unavailable",
		});
		const rejections = await h.metrics.authRejections.get();
		expect(
			rejections.values.find((v) => v.labels.reason === "api_unavailable")
				?.value,
		).toBe(1);
		// Not cached: the next request asks /v1/me again and passes.
		expect((await post(FAKE_TOKENS.full)).status).toBe(200);
		expect(meCalls()).toBe(2);
	});

	it("answers 401 invalid_token to a bearer the API rejects", async () => {
		h = await startHttp();
		const r = await post("umiak_not_a_key");
		expect(r.status).toBe(401);
		expect(r.headers["www-authenticate"]).toBeUndefined();
		expect(JSON.parse(r.text).error).toBe("unauthorized");
	});

	it("answers 403 to a disabled user", async () => {
		h = await startHttp();
		h.api.tokens.set("t_disabled", {
			kind: "session",
			scopes: ["sandboxes:read"],
			teamId: FAKE_TEAM,
			disabled: true,
		});
		const r = await post("t_disabled");
		expect(r.status).toBe(403);
		expect(r.headers["www-authenticate"]).toBeUndefined();
		expect(JSON.parse(r.text)).toMatchObject({ error: "forbidden" });
		const rejections = await h.metrics.authRejections.get();
		expect(
			rejections.values.find((v) => v.labels.reason === "user_disabled")?.value,
		).toBe(1);
	});
});

describe("the /v1/me cache", () => {
	it("rechecks owner authorization on every admitted request", async () => {
		h = await startHttp();
		expect((await post(FAKE_TOKENS.full)).status).toBe(200);
		expect((await post(FAKE_TOKENS.full)).status).toBe(200);
		expect(meCalls()).toBe(2);
	});

	it("checks every concurrent owner request independently", async () => {
		h = await startHttp();
		const all = await Promise.all(
			Array.from({ length: 5 }, () => post(FAKE_TOKENS.owner)),
		);
		expect(all.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
		expect(meCalls()).toBe(5);
	});

	it("keys entries by token hash and team, evicting the oldest", () => {
		let now = 0;
		const c = new MeCache({ now: () => now, maxEntries: 2 });
		const v = {
			rejection: { status: 401, reason: "x", code: "x", message: "x" },
		} as const;
		c.set("a", undefined, v, 1000);
		c.set("a", "team_x", v, 1000);
		expect(c.get("a", undefined)).toBeDefined();
		expect(c.get("a", "team_y")).toBeUndefined();
		c.set("b", undefined, v, 1000);
		expect(c.size).toBe(2);
		expect(c.get("a", undefined)).toBeUndefined();
		now = 1000;
		expect(c.get("b", undefined)).toBeUndefined();
		expect(MeCache.key("a", undefined).startsWith("a")).toBe(false);
	});
});

describe("the team of a request", () => {
	const twoTeams = "t_two_teams";

	async function setup(): Promise<HttpHarness> {
		h = await startHttp();
		h.api.tokens.set(twoTeams, {
			kind: "session",
			scopes: ["sandboxes:read", "sandboxes:write"],
			teamId: FAKE_TEAM,
			teams: [OTHER_TEAM],
		});
		return h;
	}

	const teamOf = (path: string) =>
		H()
			.apiCalls.filter((c) => c.path === path)
			.map((c) => c.headers.get("umiak-team"));

	it("sends Umiak-Team to /v1/me and to every call", async () => {
		const s = await setup();
		const c = await s.connect(twoTeams, {
			headers: { "Umiak-Team": OTHER_TEAM },
		});
		const r = await c.client.callTool({ name: "sandbox_list", arguments: {} });
		expect(r.isError).toBeFalsy();
		expect(teamOf("/v1/me").length).toBeGreaterThan(0);
		expect(teamOf("/v1/me").every((t) => t === OTHER_TEAM)).toBe(true);
		expect(teamOf("/v1/sandboxes")).toEqual([OTHER_TEAM]);
	});

	it("takes ?team= when there is no Umiak-Team header", async () => {
		const s = await setup();
		const c = await s.connect(twoTeams, { query: `?team=${OTHER_TEAM}` });
		await c.client.callTool({ name: "sandbox_list", arguments: {} });
		expect(teamOf("/v1/me").length).toBeGreaterThan(0);
		expect(teamOf("/v1/me").every((t) => t === OTHER_TEAM)).toBe(true);
		expect(teamOf("/v1/sandboxes")).toEqual([OTHER_TEAM]);
		// Without either: the default team, no header.
		const d = await s.connect(twoTeams);
		await d.client.callTool({ name: "sandbox_list", arguments: {} });
		expect(teamOf("/v1/sandboxes")).toEqual([OTHER_TEAM, null]);
	});

	it("Umiak-Team wins over ?team=", async () => {
		const s = await setup();
		const c = await s.connect(twoTeams, {
			headers: { "Umiak-Team": OTHER_TEAM },
			query: "?team=team_nobody",
		});
		await c.client.callTool({ name: "sandbox_list", arguments: {} });
		expect(teamOf("/v1/me").length).toBeGreaterThan(0);
		expect(teamOf("/v1/me").every((t) => t === OTHER_TEAM)).toBe(true);
		expect(teamOf("/v1/sandboxes")).toEqual([OTHER_TEAM]);
	});

	it("a team that is not a team id is 400 validation, before /v1/me", async () => {
		const s = await setup();
		for (const r of [
			await s.raw("POST", "/mcp?team=team_x%01y", {
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					authorization: `Bearer ${twoTeams}`,
				},
				body: INIT,
			}),
			await post(twoTeams, { "umiak-team": "my team" }),
		]) {
			expect(r.status).toBe(400);
			expect(JSON.parse(r.text) as Json).toMatchObject({
				error: "validation",
			});
		}
		expect(meCalls()).toBe(0);
	});

	it("caches per team and passes the API's refusal of a foreign team", async () => {
		const s = await setup();
		expect((await post(twoTeams)).status).toBe(200);
		expect((await post(twoTeams, { "umiak-team": OTHER_TEAM })).status).toBe(
			200,
		);
		expect(meCalls()).toBe(2);
		const r = await post(twoTeams, { "umiak-team": "team_nobody" });
		expect(r.status).toBe(403);
		expect(JSON.parse(r.text) as Json).toMatchObject({
			error: "team_forbidden",
		});
		const key = await post(FAKE_TOKENS.full, { "umiak-team": OTHER_TEAM });
		expect(key.status).toBe(403);
		const rejections = await s.metrics.authRejections.get();
		expect(
			rejections.values.find((v) => v.labels.reason === "team_forbidden")
				?.value,
		).toBe(2);
	});
});
