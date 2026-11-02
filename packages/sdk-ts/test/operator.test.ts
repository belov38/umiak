// Operator facade of S8 C3: sb.block/unblock, sb.ports.block/unblock and
// umiak.operator.listSandboxes send the documented requests; against the real
// api a team key is refused with 403 operator_required.
import {
	createTestDatabase,
	skipPg,
	type TestDatabase,
} from "@umiak/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Umiak, UmiakError } from "../src/index.ts";
import { startTestApi, type TestApi } from "./helpers/api.ts";

const API = "https://api.example.test";

interface Seen {
	method: string;
	url: URL;
	body: string;
}

function fakeFetch(replies: Response[]) {
	const seen: Seen[] = [];
	const fetch = async (input: Request | string | URL, init?: RequestInit) => {
		const req = input instanceof Request ? input : new Request(input, init);
		seen.push({
			method: req.method,
			url: new URL(req.url),
			body: await req.text(),
		});
		const next = replies.shift();
		if (next === undefined) throw new Error("no scripted reply left");
		return next;
	};
	return { fetch: fetch as typeof globalThis.fetch, seen };
}

const json = (body: unknown) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});

const SANDBOX = {
	id: "sb_1",
	slug: "quiet-otter-lamp",
	state: "ready",
	blocked: true,
	blockReason: "abuse",
};
const PORT = { port: 3000, blocked: true, blockReason: "operator" };

function umiak(fetch: typeof globalThis.fetch) {
	return new Umiak({ baseUrl: API, apiKey: "umiak_test", fetch, env: {} });
}

describe("operator facade (requests)", () => {
	it("sb.block / sb.unblock post the body and keep the answer as data", async () => {
		const h = fakeFetch([
			json(SANDBOX),
			json(SANDBOX),
			json({ ...SANDBOX, blocked: false, blockReason: null }),
		]);
		const s = await umiak(h.fetch).sandboxes.get("sb_1");
		const data = await s.block({ reason: "abuse", note: "mining" });
		expect(data.blocked).toBe(true);
		expect(s.data.blockReason).toBe("abuse");
		const un = await s.unblock();
		expect(un.blocked).toBe(false);
		expect(s.data.blocked).toBe(false);
		expect(h.seen.map((x) => `${x.method} ${x.url.pathname}`)).toEqual([
			"GET /v1/sandboxes/sb_1",
			"POST /v1/sandboxes/sb_1/block",
			"POST /v1/sandboxes/sb_1/unblock",
		]);
		expect(JSON.parse(h.seen[1]?.body ?? "")).toEqual({
			reason: "abuse",
			note: "mining",
		});
		expect(JSON.parse(h.seen[2]?.body ?? "")).toEqual({});
	});

	it("sb.ports.block / unblock", async () => {
		const h = fakeFetch([
			json(SANDBOX),
			json(PORT),
			json({ ...PORT, blocked: false, blockReason: null }),
		]);
		const s = await umiak(h.fetch).sandboxes.get("sb_1");
		expect(
			await s.ports.block(3000, { reason: "operator", note: "n" }),
		).toMatchObject({ blocked: true, blockReason: "operator" });
		expect(await s.ports.unblock(3000, { note: "ok" })).toMatchObject({
			blocked: false,
		});
		expect(h.seen.slice(1).map((x) => `${x.method} ${x.url.pathname}`)).toEqual(
			[
				"POST /v1/sandboxes/sb_1/ports/3000/block",
				"POST /v1/sandboxes/sb_1/ports/3000/unblock",
			],
		);
		expect(JSON.parse(h.seen[1]?.body ?? "")).toEqual({
			reason: "operator",
			note: "n",
		});
		expect(JSON.parse(h.seen[2]?.body ?? "")).toEqual({ note: "ok" });
	});

	it("umiak.operator.listSandboxes pages with allTeams=true and teamId", async () => {
		const h = fakeFetch([
			json({ data: [{ ...SANDBOX, id: "sb_1" }], nextCursor: "c2" }),
			json({ data: [{ ...SANDBOX, id: "sb_2" }], nextCursor: null }),
		]);
		const ids: string[] = [];
		for await (const s of umiak(h.fetch).operator.listSandboxes({
			teamId: "team_1",
			state: ["ready", "stopped"],
			q: "box",
		})) {
			ids.push(s.id);
		}
		expect(ids).toEqual(["sb_1", "sb_2"]);
		const q = h.seen.map((x) => Object.fromEntries(x.url.searchParams));
		expect(q[0]).toEqual({
			allTeams: "true",
			teamId: "team_1",
			state: "ready,stopped",
			q: "box",
		});
		expect(q[1]).toMatchObject({ allTeams: "true", cursor: "c2" });
		// The plain list sends neither.
		const p = fakeFetch([json({ data: [], nextCursor: null })]);
		for await (const _ of umiak(p.fetch).sandboxes.list()) {
			// empty
		}
		expect(p.seen[0]?.url.searchParams.has("allTeams")).toBe(false);
	});
});

describe.skipIf(skipPg())("operator facade (real api)", () => {
	let db: TestDatabase;
	let api: TestApi;

	beforeAll(async () => {
		db = await createTestDatabase({ max: 10 });
		api = await startTestApi(db);
	});
	afterAll(async () => {
		await api?.close();
		await db?.drop();
	});

	it("a team key is 403 forbidden, operator_required, on every operator call", async () => {
		const client = new Umiak({
			baseUrl: api.url,
			apiKey: api.secret,
			fetch: api.fetch,
			env: {},
		});
		const sb = await client.sandboxes.create({}, {});
		const calls: [string, () => Promise<unknown>][] = [
			["block", () => sb.block({ reason: "abuse" })],
			["unblock", () => sb.unblock()],
			["ports.block", () => sb.ports.block(3000, { reason: "abuse" })],
			["ports.unblock", () => sb.ports.unblock(3000)],
			[
				"operator.listSandboxes",
				async () => {
					for await (const _ of client.operator.listSandboxes()) {
						// first page throws
					}
				},
			],
		];
		for (const [name, call] of calls) {
			const err = await call().then(
				() => null,
				(e: unknown) => e,
			);
			expect(err, name).toBeInstanceOf(UmiakError);
			expect(err, name).toMatchObject({
				status: 403,
				code: "forbidden",
				details: { reason: "operator_required" },
			});
		}
		expect((await client.sandboxes.get(sb.id)).data).toMatchObject({
			blocked: false,
			blockReason: null,
		});
	});
});
