// createTeam, renameTeam (S8 §6.1, §9.11).
import { encodeUuid } from "@umiak/auth";
import { rows, sql, tbl } from "@umiak/payload";
import { z } from "zod";
import { can } from "../permissions";
import {
	type ActionCtx,
	type ActionResult,
	FORBIDDEN,
	fail,
	inAction,
	parse,
	teamAccess,
} from "./core";
import { teamId, teamName } from "./schemas";

/** PlatformDefaults.maxOwnedTeamsPerUser when unset (S8 §6.1). */
export const DEFAULT_MAX_OWNED_TEAMS = 3;

const createTeamArgs = z.object({ name: teamName });

/**
 * Any user: a shared team with the caller as `owner`, quota copied from
 * `newSharedTeamQuota`. At most `maxOwnedTeamsPerUser` shared teams where
 * the caller is `owner` (`team_limit`).
 */
export async function createTeamImpl(
	ctx: ActionCtx,
	args: { name: string },
): Promise<ActionResult<{ teamId: string }>> {
	const a = parse(createTeamArgs, args);
	if ("error" in a) return a;
	const me = ctx.session.user.id;
	return inAction(ctx, async (req) => {
		const p = req.payload;
		// Concurrent creates of one user serialize on the user row.
		await rows(
			p,
			sql`SELECT 1 FROM ${tbl(p, "users")} WHERE id = ${me} FOR NO KEY UPDATE`,
			req,
		);
		const owned = await rows<{ n: number }>(
			p,
			sql`SELECT count(*)::int AS n
			      FROM ${tbl(p, "memberships")} m
			      JOIN ${tbl(p, "teams")} t ON t.id = m.team_id
			     WHERE m.user_id = ${me} AND m.role = 'owner'
			       AND t.personal IS NOT TRUE`,
			req,
		);
		const defaults = await p.findGlobal({
			slug: "platform-defaults",
			depth: 0,
			req,
			overrideAccess: true,
		});
		const max =
			typeof defaults.maxOwnedTeamsPerUser === "number"
				? defaults.maxOwnedTeamsPerUser
				: DEFAULT_MAX_OWNED_TEAMS;
		if ((owned[0]?.n ?? 0) >= max) {
			return fail(
				"team_limit",
				`You already own ${max} shared team${max === 1 ? "" : "s"}, the limit.`,
			);
		}
		const q = (defaults.newSharedTeamQuota ?? {}) as Record<string, unknown>;
		const num = (v: unknown) => (typeof v === "number" ? v : null);
		const team = await p.create({
			collection: "teams",
			data: {
				name: a.data.name,
				personal: false,
				createdBy: me,
				quota: {
					maxActiveSandboxes: num(q.maxActiveSandboxes),
					maxRamMb: num(q.maxRamMb),
					maxSavedSnapshots: num(q.maxSavedSnapshots),
				},
			},
			depth: 0,
			req,
			overrideAccess: true,
		});
		await p.create({
			collection: "memberships",
			data: { user: me, team: team.id, role: "owner" },
			depth: 0,
			req,
			overrideAccess: true,
		});
		return { ok: true, teamId: encodeUuid("team", String(team.id)) };
	});
}

const renameTeamArgs = z.object({ teamId, name: teamName });

/** `owner` or operator; personal teams too (S8 §6.1). */
export async function renameTeamImpl(
	ctx: ActionCtx,
	args: { teamId: string; name: string },
): Promise<ActionResult> {
	const a = parse(renameTeamArgs, args);
	if ("error" in a) return a;
	return inAction(ctx, async (req) => {
		const acc = await teamAccess(ctx, req, a.data.teamId);
		if ("error" in acc) return acc;
		if (!can(ctx.session, acc.perm, "renameTeam")) {
			return fail("forbidden", FORBIDDEN);
		}
		if (acc.team.name !== a.data.name) {
			await req.payload.update({
				collection: "teams",
				id: a.data.teamId,
				data: { name: a.data.name },
				depth: 0,
				req,
				overrideAccess: true,
			});
		}
		return { ok: true };
	});
}
