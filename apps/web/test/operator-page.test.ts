// The operator section (S8 §9.10) without Next: the server guard, the team
// list for the client, the list query and the block body.
import { encodeUuid } from "@sbx/auth";
import { describe, expect, it } from "vitest";
import {
	blockBody,
	MAX_BLOCK_NOTE,
	operatorListQuery,
	requireOperator,
	teamNameOf,
} from "../src/lib/operator.ts";
import { toOperatorTeams } from "../src/lib/operator-teams.ts";

const A = "0193f1d2-7c3a-7b4e-9a1f-2b3c4d5e6f70";
const B = "0193f1d2-7c3a-7b4e-9a1f-2b3c4d5e6f71";

describe("requireOperator", () => {
	it("passes an operator session", () => {
		expect(requireOperator({ isOperator: true })).toEqual({ ok: true });
	});

	it("is 401 without a session", () => {
		expect(requireOperator(null)).toEqual({ ok: false, status: 401 });
		expect(requireOperator(undefined)).toEqual({ ok: false, status: 401 });
	});

	it("is 403 for anyone else, also for a truthy non-boolean flag", () => {
		for (const s of [
			{ isOperator: false },
			{},
			{ isOperator: "true" },
			{ isOperator: 1 },
		]) {
			expect(requireOperator(s as { isOperator?: unknown })).toEqual({
				ok: false,
				status: 403,
			});
		}
	});
});

describe("toOperatorTeams", () => {
	it("encodes the ids, keeps names and personal, sorts by name", () => {
		expect(
			toOperatorTeams([
				{ id: B, name: "zeta", personal: false },
				{ id: A, name: "Alpha", personal: true },
			]),
		).toEqual([
			{ id: encodeUuid("team", A), name: "Alpha", personal: true },
			{ id: encodeUuid("team", B), name: "zeta", personal: false },
		]);
	});

	it("drops rows without a UUID id, names a team without a name by its id", () => {
		const r = toOperatorTeams([
			{ id: "not-a-uuid", name: "x" },
			{ id: 7, name: "y" },
			{ id: A },
		]);
		expect(r).toEqual([
			{
				id: encodeUuid("team", A),
				name: encodeUuid("team", A),
				personal: false,
			},
		]);
	});

	it("teamNameOf: the name, or the id of an unknown team", () => {
		const teams = toOperatorTeams([{ id: A, name: "Alpha" }]);
		const names = new Map(teams.map((t) => [t.id, t.name]));
		expect(teamNameOf(names, encodeUuid("team", A))).toBe("Alpha");
		expect(teamNameOf(names, "team_unknown")).toBe("team_unknown");
	});
});

describe("operatorListQuery", () => {
	it("always asks for every team; filters only when chosen", () => {
		expect(
			operatorListQuery({ teamId: "all", state: "all", q: " " }, undefined),
		).toEqual({ allTeams: "true", limit: 50 });
	});

	it("adds team, state, q and the cursor", () => {
		expect(
			operatorListQuery({ teamId: "team_x", state: "ready", q: " web " }, "c1"),
		).toEqual({
			allTeams: "true",
			teamId: "team_x",
			state: "ready",
			q: "web",
			limit: 50,
			cursor: "c1",
		});
	});
});

describe("blockBody", () => {
	it("reason only when the note is blank", () => {
		expect(blockBody("abuse", "  ")).toEqual({
			ok: true,
			body: { reason: "abuse" },
		});
	});

	it("a trimmed note", () => {
		expect(blockBody("operator", " mining \n")).toEqual({
			ok: true,
			body: { reason: "operator", note: "mining" },
		});
	});

	it("refuses a note over 500 characters", () => {
		const r = blockBody("operator", "x".repeat(MAX_BLOCK_NOTE + 1));
		expect(r.ok).toBe(false);
		expect(blockBody("operator", "x".repeat(MAX_BLOCK_NOTE)).ok).toBe(true);
	});
});
