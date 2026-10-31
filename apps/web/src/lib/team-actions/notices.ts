// acknowledgeNotice (S8 §9.11, §20.1): an owner of the notice's team.
import { z } from "zod";
import { can } from "../permissions";
import {
	type ActionCtx,
	type ActionResult,
	FORBIDDEN,
	fail,
	inAction,
	missing,
	parse,
	relationId,
	teamAccess,
} from "./core";
import { noticeId } from "./schemas";

const args = z.object({ noticeId });

/**
 * Sets `acknowledgedBy` and `acknowledgedAt`; an acknowledged notice keeps
 * its first acknowledgement. Not an owner of the team: `forbidden`
 * (operators work with notices in /admin).
 */
export async function acknowledgeNoticeImpl(
	ctx: ActionCtx,
	input: { noticeId: string },
): Promise<ActionResult> {
	const a = parse(args, input);
	if ("error" in a) return a;
	return inAction(ctx, async (req) => {
		const p = req.payload;
		const n = await p.findByID({
			collection: "team-notices",
			id: a.data.noticeId,
			depth: 0,
			req,
			overrideAccess: true,
			disableErrors: true,
		});
		const team = relationId(n?.team);
		if (!n || team === null) return missing(ctx, "Notice");
		const acc = await teamAccess(ctx, req, team);
		if ("error" in acc) return acc;
		if (!can(ctx.session, acc.perm, "acknowledgeNotice")) {
			return fail("forbidden", FORBIDDEN);
		}
		if (!n.acknowledgedAt) {
			await p.update({
				collection: "team-notices",
				id: a.data.noticeId,
				data: {
					acknowledgedBy: ctx.session.user.id,
					acknowledgedAt: new Date().toISOString(),
				},
				depth: 0,
				req,
				overrideAccess: true,
			});
		}
		return { ok: true };
	});
}
