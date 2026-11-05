// The role table of S8 §6.2, row by row.
import { describe, expect, it } from "vitest";
import {
	can,
	type PermissionSubject,
	type PermissionTeam,
	TEAM_ACTIONS,
	type TeamAction,
} from "../src/lib/permissions.ts";

const person: PermissionSubject = { isOperator: false };
const operator: PermissionSubject = { isOperator: true };

const shared = (role: PermissionTeam["role"]): PermissionTeam => ({
	role,
	personal: false,
});
const personal = (role: PermissionTeam["role"]): PermissionTeam => ({
	role,
	personal: true,
});

// [member, owner, operator (not a member)] of a shared team, as in §6.2.
const TABLE: Record<TeamAction, [boolean, boolean, boolean]> = {
	sandboxes: [true, true, true],
	sshKeys: [true, true, true],
	viewApiKeys: [true, true, true],
	useEnvironments: [true, true, true],
	manageEnvironments: [false, true, true],
	issueApiKeys: [false, true, false],
	revokeApiKeys: [false, true, true],
	inviteMember: [false, true, true],
	manageMembers: [false, true, true],
	renameTeam: [false, true, true],
	leaveTeam: [true, true, false],
	deleteTeam: [false, false, true],
	viewQuota: [true, true, true],
	editQuota: [false, false, true],
};

describe("can(): S8 §6.2", () => {
	it("covers every action", () => {
		expect(Object.keys(TABLE).sort()).toEqual([...TEAM_ACTIONS].sort());
	});

	for (const action of TEAM_ACTIONS) {
		const [m, o, op] = TABLE[action];
		it(`${action}: member ${m}, owner ${o}, operator ${op}`, () => {
			expect(can(person, shared("member"), action)).toBe(m);
			expect(can(person, shared("owner"), action)).toBe(o);
			expect(can(operator, shared(null), action)).toBe(op);
		});
	}

	it("a non-member who is no operator can do nothing in the team", () => {
		for (const action of TEAM_ACTIONS) {
			if (action === "sshKeys") continue;
			expect(can(person, shared(null), action), action).toBe(false);
		}
	});

	it("own SSH keys need no team", () => {
		expect(can(person, null, "sshKeys")).toBe(true);
		expect(can(person, null, "renameTeam")).toBe(false);
	});

	it("an operator who is also a member keeps the operator rights", () => {
		expect(can(operator, shared("member"), "renameTeam")).toBe(true);
		expect(can(operator, shared("member"), "manageMembers")).toBe(true);
		// Issuing keys is owner-only.
		expect(can(operator, shared("member"), "issueApiKeys")).toBe(false);
		expect(can(operator, shared("owner"), "issueApiKeys")).toBe(true);
		expect(can(operator, shared("member"), "leaveTeam")).toBe(true);
	});

	describe("personal team (§6.1)", () => {
		it("nobody invites into it", () => {
			expect(can(person, personal("owner"), "inviteMember")).toBe(false);
			expect(can(operator, personal(null), "inviteMember")).toBe(false);
		});
		it("its owner cannot leave it", () => {
			expect(can(person, personal("owner"), "leaveTeam")).toBe(false);
		});
		it("it cannot be deleted, even by an operator", () => {
			expect(can(operator, personal(null), "deleteTeam")).toBe(false);
		});
		it("it can be renamed by its owner", () => {
			expect(can(person, personal("owner"), "renameTeam")).toBe(true);
		});
	});
});
