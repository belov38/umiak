// setDefaultTeam (S8 §6.1, §9.9): the team used without Umiak-Team.
import { z } from "zod";
import {
	type ActionCtx,
	type ActionResult,
	FORBIDDEN,
	fail,
	inAction,
	parse,
	teamAccess,
} from "./core";
import { teamId } from "./schemas";

const args = z.object({ teamId });

/** Only a team the caller is a member of (operators too). */
export async function setDefaultTeamImpl(
	ctx: ActionCtx,
	input: { teamId: string },
): Promise<ActionResult> {
	const a = parse(args, input);
	if ("error" in a) return a;
	return inAction(ctx, async (req) => {
		const acc = await teamAccess(ctx, req, a.data.teamId);
		if ("error" in acc) return acc;
		if (acc.membership === null) return fail("forbidden", FORBIDDEN);
		await req.payload.update({
			collection: "users",
			id: ctx.session.user.id,
			data: { defaultTeam: a.data.teamId },
			depth: 0,
			req,
			overrideAccess: true,
		});
		return { ok: true };
	});
}
