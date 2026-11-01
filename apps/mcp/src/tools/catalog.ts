// Catalog and quotas (S11 8.1): who am I and what can I create.
import type { components } from "@umiak/sdk";
import { toolText } from "../output/result.ts";
import { defineTool } from "../registry.ts";
import { compact, snakeKeys } from "./view.ts";

type Me = components["schemas"]["Me"];

/** `user.email`, or the team key id for a key (spec 8.1). */
function identityOf(me: Me): string {
	if (me.user !== null) return me.user.email;
	if (me.auth.apiKeyId !== undefined) return `team key ${me.auth.apiKeyId}`;
	return `credential of kind ${me.auth.kind}`;
}

export const limitsGet = defineTool({
	name: "limits_get",
	title: "Show identity and limits",
	description:
		"Shows who you are, the team, scopes, quota with usage and remaining, can_create, and the sizes allowed now per template (with the reason when not). Call before creating many sandboxes or after quota_exceeded.",
	toolset: "core",
	scopes: [],
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	sandboxArg: false,
	shape: {},
	async handler(_args, ctx) {
		const umiak = ctx.umiak();
		const [me, limits] = await Promise.all([
			umiak.raw.GET("/v1/me", ctx.call),
			umiak.raw.GET("/v1/limits", ctx.call),
		]);
		const { user, team, auth } = me.data;
		const l = limits.data;
		return toolText({
			identity: identityOf(me.data),
			user:
				user === null
					? null
					: { id: user.id, email: user.email, name: user.name },
			team: { id: team.id, name: team.name, role: team.role },
			auth: snakeKeys({
				kind: auth.kind,
				scopes: auth.scopes,
				expiresAt: auth.expiresAt,
			}),
			quota: snakeKeys(l.quota),
			usage: snakeKeys(l.usage),
			remaining: snakeKeys(l.remaining),
			can_create: l.canCreate,
			templates: l.templates.map((t) => ({
				slug: t.slug,
				enabled: t.enabled,
				default_size: t.defaultSize,
				sizes: t.sizes.map((size) =>
					compact({
						slug: size.slug,
						vcpu: size.vcpu,
						memory_mb: size.memoryMb,
						allowed: size.allowed,
						reason: size.reason ?? undefined,
					}),
				),
			})),
			rate_limits: snakeKeys(l.rateLimits),
		});
	},
});

export const templatesList = defineTool({
	name: "templates_list",
	title: "List templates and sizes",
	description:
		"Lists templates (slug, os, capabilities such as exec, files, ssh, desktop, allowed sizes, login user) and sizes with vcpu and memory. Use it to pick template and size for sandbox_create.",
	toolset: "core",
	scopes: [],
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	sandboxArg: false,
	shape: {},
	async handler(_args, ctx) {
		const umiak = ctx.umiak();
		const [templates, sizes] = await Promise.all([
			umiak.raw.GET("/v1/templates", ctx.call),
			umiak.raw.GET("/v1/sizes", ctx.call),
		]);
		return toolText({
			templates: templates.data.data.map((t) => ({
				slug: t.slug,
				name: t.name,
				os: t.os,
				capabilities: t.capabilities,
				default_size: t.defaultSize,
				allowed_sizes: t.allowedSizes,
				login_user: t.loginUser,
			})),
			sizes: sizes.data.data.map((s) => ({
				slug: s.slug,
				vcpu: s.vcpu,
				memory_mb: s.memoryMb,
			})),
		});
	},
});

export const CATALOG_TOOLS = [limitsGet, templatesList];
