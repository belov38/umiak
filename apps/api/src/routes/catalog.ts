// GET /v1/templates and GET /v1/sizes (S7 §13); any valid credential.
// Templates and sizes come from ConfigReader; the version of a template is
// its newest active build (template_builds), null without one. Disabled
// templates are listed for operators only.
import { createRoute } from "@hono/zod-openapi";
import type { SizeConfig, TemplateConfig } from "@umiak/config";
import { authOf } from "../auth/principal.ts";
import type { ApiApp, ApiDeps } from "../deps.ts";
import { ERROR_RESPONSES, jsonResponse } from "../openapi/registry.ts";
import {
	SizeListSchema,
	TemplateListSchema,
	type TemplateSchema,
} from "../schemas/catalog.ts";

export interface CatalogTemplate {
	template: TemplateConfig;
	/** Version of the newest active build; null without one. */
	version: string | null;
}

/** Configured templates in configuration order with their build versions. */
export async function catalogTemplates(
	deps: Pick<ApiDeps, "pool" | "config">,
	opts: { includeDisabled: boolean },
): Promise<CatalogTemplate[]> {
	const templates = (await deps.config.templates()).filter(
		(t) => t.enabled || opts.includeDisabled,
	);
	const versions = new Map<string, string>();
	if (deps.pool !== null && templates.length > 0) {
		const r = await deps.pool.query<{ template_slug: string; version: string }>(
			`SELECT DISTINCT ON (template_slug) template_slug, version
			 FROM runtime.template_builds
			 WHERE status = 'active' AND template_slug = ANY($1::text[])
			 ORDER BY template_slug, promoted_at DESC NULLS LAST, created_at DESC`,
			[templates.map((t) => t.slug)],
		);
		for (const row of r.rows) versions.set(row.template_slug, row.version);
	}
	return templates.map((template) => ({
		template,
		version: versions.get(template.slug) ?? null,
	}));
}

/** Every configured size, smallest first. */
export async function catalogSizes(
	deps: Pick<ApiDeps, "config">,
): Promise<SizeConfig[]> {
	return (await deps.config.sizes()).sort(
		(a, b) =>
			a.memoryMb - b.memoryMb || a.vcpu - b.vcpu || (a.slug < b.slug ? -1 : 1),
	);
}

function templateResource(t: CatalogTemplate): typeof TemplateSchema._output {
	const c = t.template;
	return {
		slug: c.slug,
		name: c.name,
		os: c.os,
		enabled: c.enabled,
		defaultSize: c.defaultSize,
		allowedSizes: c.allowedSizes,
		loginUser: c.loginUser,
		capabilities: c.capabilities,
		version: t.version,
	};
}

const listTemplates = createRoute({
	method: "get",
	path: "/v1/templates",
	operationId: "templates.list",
	summary: "List templates",
	description:
		"Templates a sandbox can be created from, with their default and allowed sizes, the " +
		"SSH login user, capabilities and the version of the active build. Disabled templates " +
		"are listed for operators only. Any valid credential.",
	tags: ["catalog"],
	responses: {
		200: jsonResponse(TemplateListSchema, "Templates"),
		...ERROR_RESPONSES,
	},
});

const listSizes = createRoute({
	method: "get",
	path: "/v1/sizes",
	operationId: "sizes.list",
	summary: "List sizes",
	description:
		"Sizes (vCPU and memory), smallest first; templates name the sizes they allow. Any valid credential.",
	tags: ["catalog"],
	responses: {
		200: jsonResponse(SizeListSchema, "Sizes"),
		...ERROR_RESPONSES,
	},
});

export function registerCatalogRoutes(app: ApiApp, deps: ApiDeps): void {
	app.openapi(listTemplates, async (c) => {
		const includeDisabled = authOf(c).principal.isOperator;
		const list = await catalogTemplates(deps, { includeDisabled });
		return c.json({ data: list.map(templateResource) }, 200);
	});

	app.openapi(listSizes, async (c) => {
		const sizes = await catalogSizes(deps);
		return c.json(
			{
				data: sizes.map((s) => ({
					slug: s.slug,
					vcpu: s.vcpu,
					memoryMb: s.memoryMb,
				})),
			},
			200,
		);
	});
}
