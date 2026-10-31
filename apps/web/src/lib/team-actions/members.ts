// inviteMember, setRole, removeMember, leaveTeam (S8 §6.2, §6.3, §9.11).
// Memberships are written one id at a time (never a bulk `where`): the
// last-owner hook is per document. user and team of a membership never
// change.
import type { PayloadRequest } from "payload";
import { z } from "zod";
import { encodeDashboardId } from "../ids";
import { can, type TeamRole } from "../permissions";
import {
	type ActionCtx,
	type ActionResult,
	FORBIDDEN,
	fail,
	inAction,
	membershipById,
	missing,
	parse,
	resetDefaultTeam,
	teamAccess,
} from "./core";
import { email, membershipId, role, teamId } from "./schemas";

const inviteArgs = z.object({ teamId, email, role });

/**
 * `owner` or operator, not into a personal team. An existing user (by
 * email) gets a membership; otherwise a stub user is created (`active`,
 * no `idpSubject`, no personal team; JIT completes it at the first login,
 * S8 §6.3) and the membership. Already in the team: `already_member`.
 */
export async function inviteMemberImpl(
	ctx: ActionCtx,
	args: { teamId: string; email: string; role: TeamRole },
): Promise<ActionResult<{ membershipId: string; stub: boolean }>> {
	const a = parse(inviteArgs, args);
	if ("error" in a) return a;
	return inAction(ctx, async (req) => {
		const acc = await teamAccess(ctx, req, a.data.teamId);
		if ("error" in acc) return acc;
		if (!can(ctx.session, acc.perm, "inviteMember")) {
			return fail(
				"forbidden",
				acc.team.personal && (acc.role === "owner" || ctx.session.isOperator)
					? "A personal team cannot have other members. Create a shared team instead."
					: FORBIDDEN,
			);
		}
		const p = req.payload;
		const found = await p.find({
			collection: "users",
			where: { email: { equals: a.data.email } },
			depth: 0,
			limit: 1,
			req,
			overrideAccess: true,
		});
		let userId: string;
		let stub = false;
		const existing = found.docs[0];
		if (existing) {
			userId = String(existing.id);
			const m = await p.count({
				collection: "memberships",
				where: {
					and: [
						{ team: { equals: a.data.teamId } },
						{ user: { equals: userId } },
					],
				},
				req,
				overrideAccess: true,
			});
			if (m.totalDocs > 0) {
				return fail("already_member", `${a.data.email} is already a member.`);
			}
		} else {
			const u = await p.create({
				collection: "users",
				data: { email: a.data.email, active: true },
				depth: 0,
				req,
				overrideAccess: true,
			});
			userId = String(u.id);
			stub = true;
		}
		const m = await p.create({
			collection: "memberships",
			data: {
				user: userId,
				team: a.data.teamId,
				role: a.data.role,
				invitedBy: ctx.session.user.id,
			},
			depth: 0,
			req,
			overrideAccess: true,
		});
		return {
			ok: true,
			membershipId: encodeDashboardId("membership", String(m.id)),
			stub,
		};
	});
}

/**
 * The membership by id with its team locked and the caller's access to the
 * team: `owner` or operator (`manageMembers`). A missing membership is
 * `missing()` (people cannot tell a foreign one from none).
 */
async function managedMembership(
	ctx: ActionCtx,
	req: PayloadRequest,
	id: string,
) {
	const first = await membershipById(req, id);
	if (first === null) return missing(ctx, "Membership");
	const acc = await teamAccess(ctx, req, first.teamId);
	if ("error" in acc) return acc;
	if (!can(ctx.session, acc.perm, "manageMembers")) {
		return fail("forbidden", FORBIDDEN);
	}
	// Read again under the team lock: it may have gone meanwhile.
	const m = await membershipById(req, id);
	if (m === null) return missing(ctx, "Membership");
	return { ok: true as const, membership: m, team: acc.team };
}

const setRoleArgs = z.object({ membershipId, role });

/** `owner` or operator; the last owner cannot be demoted (`last_owner`). */
export async function setRoleImpl(
	ctx: ActionCtx,
	args: { membershipId: string; role: TeamRole },
): Promise<ActionResult> {
	const a = parse(setRoleArgs, args);
	if ("error" in a) return a;
	return inAction(ctx, async (req) => {
		const r = await managedMembership(ctx, req, a.data.membershipId);
		if ("error" in r) return r;
		if (r.membership.role !== a.data.role) {
			await req.payload.update({
				collection: "memberships",
				id: r.membership.id,
				data: { role: a.data.role },
				depth: 0,
				req,
				overrideAccess: true,
			});
		}
		return { ok: true };
	});
}

const removeArgs = z.object({ membershipId });

/**
 * `owner` or operator; the last owner cannot be removed. The removed user's
 * default team falls back to their personal team. Sandboxes and keys of the
 * team stay (S8 §6.2); the delete hook closes their SSH sessions.
 */
export async function removeMemberImpl(
	ctx: ActionCtx,
	args: { membershipId: string },
): Promise<ActionResult> {
	const a = parse(removeArgs, args);
	if ("error" in a) return a;
	return inAction(ctx, async (req) => {
		const r = await managedMembership(ctx, req, a.data.membershipId);
		if ("error" in r) return r;
		await req.payload.delete({
			collection: "memberships",
			id: r.membership.id,
			depth: 0,
			req,
			overrideAccess: true,
		});
		await resetDefaultTeam(req, r.membership.userId, r.membership.teamId);
		return { ok: true };
	});
}

const leaveArgs = z.object({ teamId });

/**
 * The caller leaves a shared team (not the personal one, not as the last
 * owner). A default team that was this one becomes the personal team.
 */
export async function leaveTeamImpl(
	ctx: ActionCtx,
	args: { teamId: string },
): Promise<ActionResult> {
	const a = parse(leaveArgs, args);
	if ("error" in a) return a;
	return inAction(ctx, async (req) => {
		const acc = await teamAccess(ctx, req, a.data.teamId);
		if ("error" in acc) return acc;
		if (acc.membership === null) return fail("forbidden", FORBIDDEN);
		if (!can(ctx.session, acc.perm, "leaveTeam")) {
			return fail(
				"forbidden",
				acc.team.personal ? "You cannot leave your personal team." : FORBIDDEN,
			);
		}
		await req.payload.delete({
			collection: "memberships",
			id: acc.membership.id,
			depth: 0,
			req,
			overrideAccess: true,
		});
		await resetDefaultTeam(req, ctx.session.user.id, a.data.teamId);
		return { ok: true };
	});
}
