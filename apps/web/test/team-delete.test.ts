// The "Delete team" button of /admin (S8 §6.4, plan decision 12) without the
// DOM: the checks against the api, the refusal text and the Payload delete.
import { DELETE_TEAM_HEADER as PAYLOAD_HEADER } from "@umiak/payload";
import { describe, expect, it } from "vitest";
import {
	DELETE_TEAM_HEADER,
	deleteTeam,
	refusalText,
	teamContents,
} from "../src/lib/team-delete.ts";

type Call = { url: string; init: RequestInit };

function fakeFetch(
	answers: Record<string, { status: number; body?: unknown }>,
) {
	const calls: Call[] = [];
	const f = async (url: string, init: RequestInit = {}) => {
		calls.push({ url, init });
		const key = Object.keys(answers).find((k) => url.startsWith(k));
		const a = key === undefined ? { status: 404, body: {} } : answers[key];
		return new Response(a?.body === undefined ? null : JSON.stringify(a.body), {
			status: a?.status ?? 200,
			headers: { "content-type": "application/json" },
		});
	};
	return { f: f as typeof fetch, calls };
}

const TEAM = "team_01jbx2v7d3m6c8q9w0e4r5t6y7";

it("the header is the one teams access of @umiak/payload checks", () => {
	expect(DELETE_TEAM_HEADER).toBe(PAYLOAD_HEADER);
});

describe("teamContents", () => {
	it("asks the api with Umiak-Team of the team, same origin with cookies", async () => {
		const { f, calls } = fakeFetch({
			"/api/v1/sandboxes": {
				status: 200,
				body: { data: [], nextCursor: null },
			},
			"/api/v1/snapshots": { status: 200, body: { data: [] } },
			"/api/v1/environments": { status: 200, body: { data: [] } },
		});
		expect(await teamContents(f, TEAM)).toEqual({
			sandboxes: 0,
			snapshots: 0,
			environments: 0,
		});
		expect(calls.map((c) => c.url).sort()).toEqual(
			[
				`/api/v1/sandboxes?allTeams=true&teamId=${TEAM}&limit=1`,
				"/api/v1/snapshots",
				"/api/v1/environments",
			].sort(),
		);
		for (const c of calls) {
			expect(new Headers(c.init.headers).get("umiak-team")).toBe(TEAM);
			expect(c.init.credentials).toBe("same-origin");
			expect(c.init.method ?? "GET").toBe("GET");
		}
	});

	it("counts what is there", async () => {
		const { f } = fakeFetch({
			"/api/v1/sandboxes": {
				status: 200,
				body: { data: [{ id: "sb_1" }], nextCursor: "c" },
			},
			"/api/v1/snapshots": { status: 200, body: { data: [{}, {}] } },
			"/api/v1/environments": { status: 200, body: { data: [{}] } },
		});
		expect(await teamContents(f, TEAM)).toEqual({
			sandboxes: 1,
			snapshots: 2,
			environments: 1,
		});
	});

	it("an api error is thrown with its message", async () => {
		const { f } = fakeFetch({
			"/api/v1/sandboxes": {
				status: 403,
				body: { error: { code: "forbidden", message: "nope" } },
			},
			"/api/v1/snapshots": { status: 200, body: { data: [] } },
			"/api/v1/environments": { status: 200, body: { data: [] } },
		});
		await expect(teamContents(f, TEAM)).rejects.toThrow(/nope/);
	});

	it("a page without the api envelope (api down) is an error too", async () => {
		const { f } = fakeFetch({
			"/api/v1/sandboxes": { status: 502 },
			"/api/v1/snapshots": { status: 200, body: { data: [] } },
			"/api/v1/environments": { status: 200, body: { data: [] } },
		});
		await expect(teamContents(f, TEAM)).rejects.toThrow(/502/);
	});
});

describe("refusalText", () => {
	it("null when the team is empty", () => {
		expect(
			refusalText({ sandboxes: 0, snapshots: 0, environments: 0 }),
		).toBeNull();
	});

	it("names what is left", () => {
		const t = refusalText({ sandboxes: 1, snapshots: 2, environments: 1 });
		expect(t).toMatch(/sandboxes/);
		expect(t).toMatch(/2 saved snapshots/);
		expect(t).toMatch(/1 environment\b/);
	});
});

describe("deleteTeam", () => {
	it("DELETE /cms-api/teams/<uuid> with the checked header", async () => {
		const { f, calls } = fakeFetch({
			"/cms-api/teams/": { status: 200, body: { doc: {} } },
		});
		await deleteTeam(f, "0193f1d2-7c3a-7b4e-9a1f-2b3c4d5e6f70");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(
			"/cms-api/teams/0193f1d2-7c3a-7b4e-9a1f-2b3c4d5e6f70",
		);
		expect(calls[0]?.init.method).toBe("DELETE");
		expect(new Headers(calls[0]?.init.headers).get(DELETE_TEAM_HEADER)).toBe(
			"checked",
		);
	});

	it("a refusal of Payload is thrown with a readable message", async () => {
		const { f } = fakeFetch({
			"/cms-api/teams/": {
				status: 400,
				body: { errors: [{ message: "personal_team" }] },
			},
		});
		await expect(
			deleteTeam(f, "0193f1d2-7c3a-7b4e-9a1f-2b3c4d5e6f70"),
		).rejects.toThrow(/personal team/i);
	});
});
