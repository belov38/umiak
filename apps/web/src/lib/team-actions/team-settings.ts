// Data of /app/t/<team>/settings: team and members.
// Public and dashboard ids only; no UUID reaches the browser.
import { encodeUuid } from "@umiak/auth";
import { z } from "zod";
import { encodeDashboardId } from "../ids";
import type { TeamRole } from "../permissions";
import {
	type ActionCtx,
	type ActionResult,
	FORBIDDEN,
	fail,
	missing,
	parse,
	relationId,
} from "./core";
import { teamId } from "./schemas";

export interface TeamMemberView {
	/** `mbr_…` */
	id: string;
	/** `usr_…` */
	userId: string;
	email: string;
	name: string | null;
	role: TeamRole;
	/** A stub nobody has signed in to yet (S8 §6.3). */
	neverSignedIn: boolean;
	lastLoginAt: string | null;
	active: boolean;
}

export interface TeamSettingsData {
	team: { id: string; name: string; personal: boolean };
	/** Role of the caller; null for an operator outside the team. */
	myRole: TeamRole | null;
	members: TeamMemberView[];
}

type Doc = Record<string, unknown> & { id: string | number };

const iso = (v: unknown): string | null =>
	v === null || v === undefined || v === ""
		? null
		: new Date(String(v)).toISOString();

const args = z.object({ teamId });

/** Members of the team or operators; others `forbidden`. */
export async function loadTeamSettingsImpl(
	ctx: ActionCtx,
	input: { teamId: string },
): Promise<ActionResult<TeamSettingsData>> {
	const a = parse(args, input);
	if ("error" in a) return a;
	const p = ctx.payload;
	const tid = a.data.teamId;
	const team = (await p.findByID({
		collection: "teams",
		id: tid,
		depth: 0,
		overrideAccess: true,
		disableErrors: true,
	})) as Doc | null;
	if (!team) return missing(ctx, "Team");

	const ms = await p.find({
		collection: "memberships",
		where: { team: { equals: tid } },
		depth: 1,
		pagination: false,
		overrideAccess: true,
	});
	const mine = ms.docs.find((m) => relationId(m.user) === ctx.session.user.id);
	const myRole = (mine?.role as TeamRole | undefined) ?? null;
	if (myRole === null && !ctx.session.isOperator) {
		return fail("forbidden", FORBIDDEN);
	}
	const personal = team.personal === true;

	const members: TeamMemberView[] = ms.docs
		.map((m): TeamMemberView | null => {
			const u = m.user as Doc | null;
			if (!u || typeof u !== "object") return null;
			const lastLoginAt = iso(u.lastLoginAt);
			return {
				id: encodeDashboardId("membership", String(m.id)),
				userId: encodeUuid("user", String(u.id)),
				email: String(u.email),
				name: typeof u.name === "string" && u.name !== "" ? u.name : null,
				role: m.role as TeamRole,
				neverSignedIn: lastLoginAt === null,
				lastLoginAt,
				active: u.active !== false,
			};
		})
		.filter((m): m is TeamMemberView => m !== null)
		.sort(
			(x, y) =>
				Number(y.role === "owner") - Number(x.role === "owner") ||
				x.email.localeCompare(y.email),
		);

	return {
		ok: true,
		team: {
			id: encodeUuid("team", tid),
			name: String(team.name),
			personal,
		},
		myRole,
		members,
	};
}
