// GET /v1/templates and GET /v1/sizes (S7 §13); any valid credential.
// ConfigReader resolves one slug at a time, so the templates are the slugs
// of the template builds (sbx-admin bootstrap creates them from the same
// config) plus the default template; disabled ones only for operators.
import { createRoute } from "@hono/zod-openapi";
import type { SizeConfig, TemplateConfig } from "@sbx/config";
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

/** Every configured template that has a build or is the default, by slug. */
export async function catalogTemplates(
	deps: Pick<ApiDeps, "pool" | "config">,
	opts: { includeDisabled: boolean },
): Promise<CatalogTemplate[]> {
	const versions = new Map<string, string | null>();
	if (deps.pool !== null) {
		const r = await deps.pool.query<{
			template_slug: string;
			version: string | null;
		}>(
			`SELECT DISTINCT ON (template_slug) template_slug,
			        CASE WHEN status = 'active' THEN version END AS version
			 FROM runtime.template_builds
			 WHERE status <> 'retired'
			 ORDER BY template_slug, (status = 'active') DESC,
			          promoted_at DESC NULLS LAST, created_at DESC`,
		);
		for (const row of r.rows) versions.set(row.template_slug, row.version);
	}
	const { defaultTemplate } = await deps.config.defaults();
	if (!versions.has(defaultTemplate)) versions.set(defaultTemplate, null);
	const out: CatalogTemplate[] = [];
	for (const [slug, version] of [...versions].sort(([a], [b]) =>
		a < b ? -1 : a > b ? 1 : 0,
	)) {
		const template = await deps.config.template(slug);
		if (template === null) continue;
		if (!template.enabled && !opts.includeDisabled) continue;
		out.push({ template, version });
	}
	return out;
}

/** Sizes allowed by any of the templates, smallest first. */
export async function catalogSizes(
	deps: Pick<ApiDeps, "config">,
	templates: readonly CatalogTemplate[],
): Promise<SizeConfig[]> {
	const slugs = new Set(templates.flatMap((t) => t.template.allowedSizes));
	const sizes: SizeConfig[] = [];
	for (const slug of slugs) {
		const size = await deps.config.size(slug);
		if (size !== null) sizes.push(size);
	}
	return sizes.sort(
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
		"Sizes (vCPU and memory) the templates allow, smallest first. Any valid credential.",
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
		const includeDisabled = authOf(c).principal.isOperator;
		const list = await catalogTemplates(deps, { includeDisabled });
		const sizes = await catalogSizes(deps, list);
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
