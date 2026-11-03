import type { ActionCtx, ActionResult } from "./team-actions/core";
import { fail } from "./team-actions/core";

/** Operator-only configuration change; existing sandbox disks are unaffected. */
export async function setTemplateEnabledImpl(
	ctx: ActionCtx,
	args: { slug: string; enabled: boolean },
): Promise<ActionResult> {
	if (!ctx.session.isOperator) return fail("forbidden", "Operators only.");
	if (!/^[a-z0-9-]{1,40}$/.test(args.slug) || typeof args.enabled !== "boolean")
		return fail("validation", "Invalid template setting.");
	const found = await ctx.payload.find({
		collection: "templates",
		where: { slug: { equals: args.slug } },
		limit: 1,
		depth: 0,
		overrideAccess: true,
	});
	const template = found.docs[0];
	if (!template) return fail("not_found", "Template not found.");
	await ctx.payload.update({
		collection: "templates",
		id: template.id,
		data: { enabled: args.enabled },
		overrideAccess: true,
	});
	return { ok: true };
}
