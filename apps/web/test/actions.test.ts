// Server actions of S8 §9.11 against Postgres and Payload, without Next:
// the …Impl functions take {payload, session} directly.
import { randomBytes, randomUUID } from "node:crypto";
import { decodeUuid, encodeUuid } from "@sbx/auth";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import {
	closeSbxPayload,
	getSbxPayload,
	migrateSbxPayload,
	resolveSession,
} from "@sbx/payload";
import type { Payload } from "payload";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeDashboardId } from "../src/lib/ids.ts";
import { setDefaultTeamImpl } from "../src/lib/team-actions/account.ts";
import type { ActionCtx } from "../src/lib/team-actions/core.ts";
import {
	inviteMemberImpl,
	leaveTeamImpl,
	removeMemberImpl,
	setRoleImpl,
} from "../src/lib/team-actions/members.ts";
import { acknowledgeNoticeImpl } from "../src/lib/team-actions/notices.ts";
import { loadTeamSettingsImpl } from "../src/lib/team-actions/team-settings.ts";
import {
	createTeamImpl,
	renameTeamImpl,
} from "../src/lib/team-actions/teams.ts";

const OPS = "sbx-operators";

describe.skipIf(skipPg())("server actions (S8 §9.11)", () => {
	let t: TestDatabase;
	let payload: Payload;

	const email = (p = "a") =>
		`${p}-${randomBytes(5).toString("hex")}@example.com`;

	async function login(o: { operator?: boolean; email?: string } = {}) {
		const session = await resolveSession(
			payload,
			{
				email: o.email ?? email(),
				user: randomUUID(),
				groups: o.operator ? [OPS] : [],
			},
			{ operatorGroups: [OPS] },
		);
		const ctx: ActionCtx = { payload, session };
		return {
			ctx,
			session,
			userId: session.user.id,
			personal: encodeUuid("team", session.defaultTeamId as string),
		};
	}

	async function user(id: string) {
		return payload.findByID({ collection: "users", id, depth: 0 });
	}

	function uuidOf(teamId: string): string {
		const id = decodeUuid("team", teamId);
		if (id === null) throw new Error(`bad team id ${teamId}`);
		return id;
	}

	async function team(teamId: string) {
		return payload.findByID({
			collection: "teams",
			id: uuidOf(teamId),
			depth: 0,
		});
	}

	async function membership(teamId: string, userId: string) {
		const r = await payload.find({
			collection: "memberships",
			where: {
				and: [
					{ team: { equals: uuidOf(teamId) } },
					{ user: { equals: userId } },
				],
			},
			depth: 0,
		});
		return r.docs[0];
	}

	const mbr = (doc: { id: string | number } | undefined) =>
		encodeDashboardId("membership", String(doc?.id));

	/** A shared team owned by `owner`, with `members` as members. */
	async function sharedTeam(
		owner: Awaited<ReturnType<typeof login>>,
		...members: Awaited<ReturnType<typeof login>>[]
	) {
		const r = await createTeamImpl(owner.ctx, { name: "shared" });
		if (!("ok" in r)) throw new Error(JSON.stringify(r));
		for (const m of members) {
			const inv = await inviteMemberImpl(owner.ctx, {
				teamId: r.teamId,
				email: m.session.user.email,
				role: "member",
			});
			if (!("ok" in inv)) throw new Error(JSON.stringify(inv));
		}
		return r.teamId;
	}

	beforeAll(async () => {
		t = await createTestDatabase({ migrated: false, max: 2 });
		payload = await getSbxPayload({
			databaseUrl: t.url,
			secret: "test-payload-secret-0123456789",
			operatorGroups: [OPS],
			appOrigin: "https://app.sbx.test",
			poolMax: 6,
		});
		await migrateSbxPayload(payload);
	});
	afterAll(async () => {
		if (t) await closeSbxPayload(t.url);
		await t?.drop();
	});

	describe("createTeam", () => {
		it("creates a shared team with the creator as owner and the new-team quota", async () => {
			const a = await login();
			const defaults = await payload.findGlobal({ slug: "platform-defaults" });
			const r = await createTeamImpl(a.ctx, { name: "  platform  " });
			if (!("ok" in r)) throw new Error(JSON.stringify(r));
			expect(r.teamId).toMatch(/^team_[0-9a-z]{26}$/);
			const doc = await team(r.teamId);
			expect(doc).toMatchObject({ name: "platform", personal: false });
			expect(doc?.createdBy).toBe(a.userId);
			const q = defaults.newSharedTeamQuota as Record<string, unknown>;
			expect(doc?.quota).toMatchObject({
				maxActiveSandboxes: q.maxActiveSandboxes ?? null,
				maxRamMb: q.maxRamMb ?? null,
				maxSavedSnapshots: q.maxSavedSnapshots ?? null,
			});
			expect((await membership(r.teamId, a.userId))?.role).toBe("owner");
		});

		it("the 4th owned shared team is team_limit; personal and member teams do not count", async () => {
			const a = await login();
			const b = await login();
			await sharedTeam(b, a); // a is a member there: not counted
			for (let i = 0; i < 3; i++) {
				const r = await createTeamImpl(a.ctx, { name: `t${i}` });
				expect(r).toMatchObject({ ok: true });
			}
			const r = await createTeamImpl(a.ctx, { name: "t3" });
			expect(r).toMatchObject({ error: { code: "team_limit" } });
		});

		it("validates the name", async () => {
			const a = await login();
			for (const name of ["", "   ", "x".repeat(65)]) {
				expect(await createTeamImpl(a.ctx, { name })).toMatchObject({
					error: { code: "validation" },
				});
			}
		});
	});

	describe("renameTeam", () => {
		it("owner renames; member and non-member get forbidden and nothing changes", async () => {
			const owner = await login();
			const member = await login();
			const stranger = await login();
			const teamId = await sharedTeam(owner, member);
			expect(
				await renameTeamImpl(member.ctx, { teamId, name: "hijack" }),
			).toMatchObject({ error: { code: "forbidden" } });
			expect(
				await renameTeamImpl(stranger.ctx, { teamId, name: "hijack" }),
			).toMatchObject({ error: { code: "forbidden" } });
			expect((await team(teamId))?.name).toBe("shared");
			expect(
				await renameTeamImpl(owner.ctx, { teamId, name: "renamed" }),
			).toEqual({ ok: true });
			expect((await team(teamId))?.name).toBe("renamed");
		});

		it("the owner may rename the personal team", async () => {
			const a = await login();
			expect(
				await renameTeamImpl(a.ctx, { teamId: a.personal, name: "mine" }),
			).toEqual({ ok: true });
		});

		it("an operator renames any team", async () => {
			const owner = await login();
			const op = await login({ operator: true });
			const teamId = await sharedTeam(owner);
			expect(
				await renameTeamImpl(op.ctx, { teamId, name: "by operator" }),
			).toEqual({ ok: true });
			expect((await team(teamId))?.name).toBe("by operator");
		});

		it("bad ids: validation; a missing team: forbidden for people, not_found for operators", async () => {
			const a = await login();
			const op = await login({ operator: true });
			expect(
				await renameTeamImpl(a.ctx, { teamId: "team_x", name: "n" }),
			).toMatchObject({ error: { code: "validation" } });
			const missing = encodeUuid("team", randomUUID());
			expect(
				await renameTeamImpl(a.ctx, { teamId: missing, name: "n" }),
			).toMatchObject({ error: { code: "forbidden" } });
			expect(
				await renameTeamImpl(op.ctx, { teamId: missing, name: "n" }),
			).toMatchObject({ error: { code: "not_found" } });
		});
	});

	describe("inviteMember", () => {
		it("an existing user gets a membership; inviting again is already_member", async () => {
			const owner = await login();
			const b = await login();
			const teamId = await sharedTeam(owner);
			const r = await inviteMemberImpl(owner.ctx, {
				teamId,
				email: b.session.user.email.toUpperCase(),
				role: "owner",
			});
			expect(r).toMatchObject({ ok: true, stub: false });
			const m = await membership(teamId, b.userId);
			expect(m).toMatchObject({ role: "owner", invitedBy: owner.userId });
			expect(
				await inviteMemberImpl(owner.ctx, {
					teamId,
					email: b.session.user.email,
					role: "member",
				}),
			).toMatchObject({ error: { code: "already_member" } });
		});

		it("a new email creates a stub user (lower case, active, no IdP subject, no personal team)", async () => {
			const owner = await login();
			const teamId = await sharedTeam(owner);
			const e = email("Stub");
			const r = await inviteMemberImpl(owner.ctx, {
				teamId,
				email: `  ${e.toUpperCase()} `,
				role: "member",
			});
			expect(r).toMatchObject({ ok: true, stub: true });
			const found = await payload.find({
				collection: "users",
				where: { email: { equals: e.toLowerCase() } },
				depth: 0,
			});
			expect(found.docs).toHaveLength(1);
			const stub = found.docs[0];
			expect(stub).toMatchObject({ email: e.toLowerCase(), active: true });
			expect(stub?.idpSubject ?? null).toBe(null);
			expect(stub?.personalTeam ?? null).toBe(null);
			expect(stub?.lastLoginAt ?? null).toBe(null);
			expect((await membership(teamId, String(stub?.id)))?.role).toBe("member");

			// The settings page shows it as "not signed in yet".
			const s = await loadTeamSettingsImpl(owner.ctx, { teamId });
			if (!("ok" in s)) throw new Error(JSON.stringify(s));
			const row = s.members.find((m) => m.email === e.toLowerCase());
			expect(row).toMatchObject({ neverSignedIn: true, lastLoginAt: null });
		});

		it("into a personal team: forbidden, for operators too", async () => {
			const a = await login();
			const op = await login({ operator: true });
			for (const ctx of [a.ctx, op.ctx]) {
				expect(
					await inviteMemberImpl(ctx, {
						teamId: a.personal,
						email: email(),
						role: "member",
					}),
				).toMatchObject({ error: { code: "forbidden" } });
			}
		});

		it("member and non-member: forbidden, no stub is created", async () => {
			const owner = await login();
			const member = await login();
			const stranger = await login();
			const teamId = await sharedTeam(owner, member);
			const e = email("nobody");
			for (const ctx of [member.ctx, stranger.ctx]) {
				expect(
					await inviteMemberImpl(ctx, { teamId, email: e, role: "member" }),
				).toMatchObject({ error: { code: "forbidden" } });
			}
			const found = await payload.count({
				collection: "users",
				where: { email: { equals: e } },
			});
			expect(found.totalDocs).toBe(0);
		});

		it("an operator invites", async () => {
			const owner = await login();
			const op = await login({ operator: true });
			const teamId = await sharedTeam(owner);
			expect(
				await inviteMemberImpl(op.ctx, {
					teamId,
					email: email(),
					role: "member",
				}),
			).toMatchObject({ ok: true });
		});

		it("validates email and role", async () => {
			const owner = await login();
			const teamId = await sharedTeam(owner);
			expect(
				await inviteMemberImpl(owner.ctx, {
					teamId,
					email: "not-an-email",
					role: "member",
				}),
			).toMatchObject({ error: { code: "validation" } });
			expect(
				await inviteMemberImpl(owner.ctx, {
					teamId,
					email: email(),
					role: "admin" as "member",
				}),
			).toMatchObject({ error: { code: "validation" } });
		});
	});

	describe("setRole", () => {
		it("member: forbidden on another membership; non-member: forbidden", async () => {
			const owner = await login();
			const member = await login();
			const stranger = await login();
			const teamId = await sharedTeam(owner, member);
			const ownerM = mbr(await membership(teamId, owner.userId));
			const memberM = mbr(await membership(teamId, member.userId));
			expect(
				await setRoleImpl(member.ctx, { membershipId: ownerM, role: "member" }),
			).toMatchObject({ error: { code: "forbidden" } });
			expect(
				await setRoleImpl(member.ctx, { membershipId: memberM, role: "owner" }),
			).toMatchObject({ error: { code: "forbidden" } });
			expect(
				await setRoleImpl(stranger.ctx, {
					membershipId: memberM,
					role: "owner",
				}),
			).toMatchObject({ error: { code: "forbidden" } });
			expect((await membership(teamId, member.userId))?.role).toBe("member");
		});

		it("the last owner cannot be demoted; with a second owner it can", async () => {
			const owner = await login();
			const member = await login();
			const teamId = await sharedTeam(owner, member);
			const ownerM = mbr(await membership(teamId, owner.userId));
			const memberM = mbr(await membership(teamId, member.userId));
			expect(
				await setRoleImpl(owner.ctx, { membershipId: ownerM, role: "member" }),
			).toMatchObject({ error: { code: "last_owner" } });
			expect(
				await setRoleImpl(owner.ctx, { membershipId: memberM, role: "owner" }),
			).toEqual({ ok: true });
			expect(
				await setRoleImpl(owner.ctx, { membershipId: ownerM, role: "member" }),
			).toEqual({ ok: true });
			expect((await membership(teamId, owner.userId))?.role).toBe("member");
		});

		it("two owners demoting each other at once: exactly one wins", async () => {
			const a = await login();
			const b = await login();
			const teamId = await sharedTeam(a, b);
			const aM = mbr(await membership(teamId, a.userId));
			const bM = mbr(await membership(teamId, b.userId));
			await setRoleImpl(a.ctx, { membershipId: bM, role: "owner" });
			const results = await Promise.all([
				setRoleImpl(a.ctx, { membershipId: bM, role: "member" }),
				setRoleImpl(b.ctx, { membershipId: aM, role: "member" }),
			]);
			const codes = results.map((r) => ("ok" in r ? "ok" : r.error.code));
			// The loser either lost its owner role first (forbidden) or would
			// have demoted the last owner (last_owner).
			expect(codes.filter((c) => c === "ok")).toHaveLength(1);
			const owners = await payload.count({
				collection: "memberships",
				where: {
					and: [
						{ team: { equals: uuidOf(teamId) } },
						{ role: { equals: "owner" } },
					],
				},
			});
			expect(owners.totalDocs).toBe(1);
		});

		it("an operator changes roles", async () => {
			const owner = await login();
			const member = await login();
			const op = await login({ operator: true });
			const teamId = await sharedTeam(owner, member);
			const memberM = mbr(await membership(teamId, member.userId));
			expect(
				await setRoleImpl(op.ctx, { membershipId: memberM, role: "owner" }),
			).toEqual({ ok: true });
		});

		it("bad and unknown membership ids", async () => {
			const a = await login();
			const op = await login({ operator: true });
			expect(
				await setRoleImpl(a.ctx, { membershipId: "mbr_bad", role: "owner" }),
			).toMatchObject({ error: { code: "validation" } });
			const unknown = encodeDashboardId("membership", randomUUID());
			expect(
				await setRoleImpl(a.ctx, { membershipId: unknown, role: "owner" }),
			).toMatchObject({ error: { code: "forbidden" } });
			expect(
				await setRoleImpl(op.ctx, { membershipId: unknown, role: "owner" }),
			).toMatchObject({ error: { code: "not_found" } });
		});
	});

	describe("removeMember", () => {
		it("member and non-member: forbidden", async () => {
			const owner = await login();
			const member = await login();
			const stranger = await login();
			const teamId = await sharedTeam(owner, member);
			const ownerM = mbr(await membership(teamId, owner.userId));
			for (const ctx of [member.ctx, stranger.ctx]) {
				expect(
					await removeMemberImpl(ctx, { membershipId: ownerM }),
				).toMatchObject({ error: { code: "forbidden" } });
			}
			expect(await membership(teamId, owner.userId)).toBeDefined();
		});

		it("the last owner cannot be removed", async () => {
			const owner = await login();
			const teamId = await sharedTeam(owner);
			const ownerM = mbr(await membership(teamId, owner.userId));
			expect(
				await removeMemberImpl(owner.ctx, { membershipId: ownerM }),
			).toMatchObject({ error: { code: "last_owner" } });
			expect(await membership(teamId, owner.userId)).toBeDefined();
		});

		it("an owner removes a member; their default team falls back to the personal one", async () => {
			const owner = await login();
			const member = await login();
			const teamId = await sharedTeam(owner, member);
			expect(await setDefaultTeamImpl(member.ctx, { teamId })).toEqual({
				ok: true,
			});
			const memberM = mbr(await membership(teamId, member.userId));
			expect(
				await removeMemberImpl(owner.ctx, { membershipId: memberM }),
			).toEqual({ ok: true });
			expect(await membership(teamId, member.userId)).toBeUndefined();
			expect((await user(member.userId)).defaultTeam).toBe(
				member.session.defaultTeamId,
			);
		});

		it("an operator removes", async () => {
			const owner = await login();
			const member = await login();
			const op = await login({ operator: true });
			const teamId = await sharedTeam(owner, member);
			const memberM = mbr(await membership(teamId, member.userId));
			expect(await removeMemberImpl(op.ctx, { membershipId: memberM })).toEqual(
				{ ok: true },
			);
		});
	});

	describe("leaveTeam", () => {
		it("leaving the default team makes the personal team the default", async () => {
			const owner = await login();
			const member = await login();
			const teamId = await sharedTeam(owner, member);
			await setDefaultTeamImpl(member.ctx, { teamId });
			expect((await user(member.userId)).defaultTeam).toBe(uuidOf(teamId));
			expect(await leaveTeamImpl(member.ctx, { teamId })).toEqual({
				ok: true,
			});
			expect(await membership(teamId, member.userId)).toBeUndefined();
			expect((await user(member.userId)).defaultTeam).toBe(
				member.session.defaultTeamId,
			);
		});

		it("the personal team cannot be left", async () => {
			const a = await login();
			expect(await leaveTeamImpl(a.ctx, { teamId: a.personal })).toMatchObject({
				error: { code: "forbidden" },
			});
		});

		it("the last owner cannot leave; with another owner they can", async () => {
			const owner = await login();
			const member = await login();
			const teamId = await sharedTeam(owner, member);
			expect(await leaveTeamImpl(owner.ctx, { teamId })).toMatchObject({
				error: { code: "last_owner" },
			});
			const memberM = mbr(await membership(teamId, member.userId));
			await setRoleImpl(owner.ctx, { membershipId: memberM, role: "owner" });
			expect(await leaveTeamImpl(owner.ctx, { teamId })).toEqual({ ok: true });
		});

		it("a non-member: forbidden", async () => {
			const owner = await login();
			const stranger = await login({ operator: true });
			const teamId = await sharedTeam(owner);
			expect(await leaveTeamImpl(stranger.ctx, { teamId })).toMatchObject({
				error: { code: "forbidden" },
			});
		});
	});

	describe("setDefaultTeam", () => {
		it("only a team of the user", async () => {
			const owner = await login();
			const stranger = await login({ operator: true });
			const teamId = await sharedTeam(owner);
			expect(await setDefaultTeamImpl(owner.ctx, { teamId })).toEqual({
				ok: true,
			});
			expect((await user(owner.userId)).defaultTeam).toBe(uuidOf(teamId));
			expect(await setDefaultTeamImpl(stranger.ctx, { teamId })).toMatchObject({
				error: { code: "forbidden" },
			});
		});
	});

	describe("acknowledgeNotice", () => {
		async function notice(teamId: string, about: string) {
			const doc = await payload.create({
				collection: "team-notices",
				data: {
					team: uuidOf(teamId),
					kind: "member_deactivated",
					user: about,
					apiKeys: [],
				},
				depth: 0,
			});
			return {
				id: String(doc.id),
				publicId: encodeDashboardId("teamNotice", String(doc.id)),
			};
		}

		it("member, non-member and a non-owner operator: forbidden; owner acknowledges", async () => {
			const owner = await login();
			const member = await login();
			const stranger = await login();
			const op = await login({ operator: true });
			const teamId = await sharedTeam(owner, member);
			const n = await notice(teamId, member.userId);
			for (const ctx of [member.ctx, stranger.ctx, op.ctx]) {
				expect(
					await acknowledgeNoticeImpl(ctx, { noticeId: n.publicId }),
				).toMatchObject({ error: { code: "forbidden" } });
			}
			const before = await payload.findByID({
				collection: "team-notices",
				id: n.id,
				depth: 0,
			});
			expect(before.acknowledgedAt ?? null).toBe(null);

			const settings = await loadTeamSettingsImpl(owner.ctx, { teamId });
			if (!("ok" in settings)) throw new Error(JSON.stringify(settings));
			expect(settings.notices.map((x) => x.id)).toEqual([n.publicId]);

			expect(
				await acknowledgeNoticeImpl(owner.ctx, { noticeId: n.publicId }),
			).toEqual({ ok: true });
			const after = await payload.findByID({
				collection: "team-notices",
				id: n.id,
				depth: 0,
			});
			expect(after.acknowledgedBy).toBe(owner.userId);
			expect(after.acknowledgedAt).toBeTruthy();
			const again = await loadTeamSettingsImpl(owner.ctx, { teamId });
			if (!("ok" in again)) throw new Error(JSON.stringify(again));
			expect(again.notices).toEqual([]);
		});

		it("the settings page lists the notice keys with their revoked state", async () => {
			const owner = await login();
			const member = await login();
			const teamId = await sharedTeam(owner, member);
			const key = async (name: string, revoked: boolean) =>
				payload.create({
					collection: "api-keys",
					data: {
						name,
						team: uuidOf(teamId),
						createdBy: member.userId,
						kind: "team",
						secretHash: randomBytes(32).toString("hex"),
						prefix: `p${randomBytes(3).toString("hex")}`,
						last4: "abcd",
						scopes: ["sandboxes:read"],
						expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
						createdVia: "api",
						...(revoked ? { revokedAt: new Date().toISOString() } : {}),
					},
					depth: 0,
				});
			const live = await key("live", false);
			const gone = await key("gone", true);
			await payload.create({
				collection: "team-notices",
				data: {
					team: uuidOf(teamId),
					kind: "member_deactivated",
					user: member.userId,
					apiKeys: [live, gone].map((k) => ({
						id: String(k.id),
						publicId: encodeUuid("apiKey", String(k.id)),
						name: k.name,
						prefix: k.prefix,
					})),
				},
				depth: 0,
			});
			const s = await loadTeamSettingsImpl(owner.ctx, { teamId });
			if (!("ok" in s)) throw new Error(JSON.stringify(s));
			expect(s.notices).toHaveLength(1);
			expect(s.notices[0]?.user?.email).toBe(member.session.user.email);
			expect(s.notices[0]?.apiKeys).toEqual([
				{
					id: encodeUuid("apiKey", String(live.id)),
					name: "live",
					prefix: live.prefix,
					revoked: false,
				},
				{
					id: encodeUuid("apiKey", String(gone.id)),
					name: "gone",
					prefix: gone.prefix,
					revoked: true,
				},
			]);
		});

		it("bad and unknown ids", async () => {
			const a = await login();
			expect(
				await acknowledgeNoticeImpl(a.ctx, { noticeId: "ntc_x" }),
			).toMatchObject({ error: { code: "validation" } });
			expect(
				await acknowledgeNoticeImpl(a.ctx, {
					noticeId: encodeDashboardId("teamNotice", randomUUID()),
				}),
			).toMatchObject({ error: { code: "forbidden" } });
		});
	});

	describe("loadTeamSettings", () => {
		it("members see members, not notices; strangers are forbidden; operators see all", async () => {
			const owner = await login();
			const member = await login();
			const stranger = await login();
			const op = await login({ operator: true });
			const teamId = await sharedTeam(owner, member);
			const m = await loadTeamSettingsImpl(member.ctx, { teamId });
			if (!("ok" in m)) throw new Error(JSON.stringify(m));
			expect(m.myRole).toBe("member");
			expect(m.members.map((x) => [x.email, x.role])).toEqual([
				[owner.session.user.email, "owner"],
				[member.session.user.email, "member"],
			]);
			expect(m.members[0]?.id).toMatch(/^mbr_[0-9a-z]{26}$/);
			expect(m.members[0]?.userId).toMatch(/^usr_[0-9a-z]{26}$/);
			expect(JSON.stringify(m)).not.toContain(owner.userId);
			expect(m.notices).toEqual([]);
			expect(
				await loadTeamSettingsImpl(stranger.ctx, { teamId }),
			).toMatchObject({ error: { code: "forbidden" } });
			const o = await loadTeamSettingsImpl(op.ctx, { teamId });
			expect(o).toMatchObject({ ok: true, myRole: null });
		});
	});
});
