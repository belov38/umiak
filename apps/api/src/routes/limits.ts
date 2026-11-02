// GET /v1/limits (S7 §13): quota, usage and remaining of the request's team,
// which sizes it can create now, and the rate limits. Any valid credential.
import { createRoute } from "@hono/zod-openapi";
import { teamUsage } from "@umiak/core";
import { authOf } from "../auth/principal.ts";
import type { ApiApp, ApiDeps } from "../deps.ts";
import { ERROR_RESPONSES, jsonResponse } from "../openapi/registry.ts";
import { type Limits, LimitsSchema } from "../schemas/limits.ts";
import { catalogSizes, catalogTemplates } from "./catalog.ts";

const getLimits = createRoute({
	method: "get",
	path: "/v1/limits",
	operationId: "limits.get",
	summary: "Quota and what can be created",
	description:
		"Quota of the request's team, its usage and the remainder, every allowed size of each " +
		"template with `allowed` and the `reason` when not (template_disabled, " +
		"quota_active_sandboxes, quota_ram), `canCreate`, and the rate limits. Node capacity is " +
		"not promised: a create can still get 503 out_of_capacity. Any valid credential.",
	tags: ["account"],
	responses: {
		200: jsonResponse(LimitsSchema, "Limits of the team"),
		...ERROR_RESPONSES,
	},
});

type SizeReason = Limits["templates"][number]["sizes"][number]["reason"];

export function registerLimitsRoutes(app: ApiApp, deps: ApiDeps): void {
	app.openapi(getLimits, async (c) => {
		const p = authOf(c).principal;
		const quota = await deps.config.teamQuota(p.teamId);
		const usage =
			deps.pool === null
				? { activeSandboxes: 0, ramMb: 0, savedSnapshots: 0 }
				: await teamUsage(deps.pool, p.teamId);
		const remaining = {
			activeSandboxes: Math.max(
				0,
				quota.maxActiveSandboxes - usage.activeSandboxes,
			),
			ramMb: Math.max(0, quota.maxRamMb - usage.ramMb),
			savedSnapshots: Math.max(
				0,
				quota.maxSavedSnapshots - usage.savedSnapshots,
			),
		};
		const list = await catalogTemplates(deps, {
			includeDisabled: p.isOperator,
		});
		const sizesBySlug = new Map(
			(await catalogSizes(deps)).map((s) => [s.slug, s]),
		);
		let canCreate = false;
		const templates: Limits["templates"] = [];
		for (const { template } of list) {
			const sizes: Limits["templates"][number]["sizes"] = [];
			for (const slug of template.allowedSizes) {
				const size = sizesBySlug.get(slug);
				if (size === undefined) continue;
				let reason: SizeReason = null;
				if (!template.enabled) reason = "template_disabled";
				else if (remaining.activeSandboxes < 1)
					reason = "quota_active_sandboxes";
				else if (remaining.ramMb < size.memoryMb) reason = "quota_ram";
				if (reason === null) canCreate = true;
				sizes.push({
					slug: size.slug,
					vcpu: size.vcpu,
					memoryMb: size.memoryMb,
					allowed: reason === null,
					reason,
				});
			}
			templates.push({
				slug: template.slug,
				enabled: template.enabled,
				defaultSize: template.defaultSize,
				sizes,
			});
		}
		const rate = deps.settings.rate;
		const body: Limits = {
			quota: {
				maxActiveSandboxes: quota.maxActiveSandboxes,
				maxRamMb: quota.maxRamMb,
				maxSavedSnapshots: quota.maxSavedSnapshots,
			},
			usage,
			remaining,
			canCreate,
			templates,
			rateLimits: {
				requestsPerSecond: rate.rps,
				burst: rate.burst,
				startsPerMinute: rate.startsPerMinute,
			},
		};
		return c.json(body, 200);
	});
}
