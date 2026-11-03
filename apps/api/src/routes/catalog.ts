// GET /v1/templates and GET /v1/sizes (S7 §13); any valid credential.
// Templates and sizes come from ConfigReader; the version of a template is
// its newest active build (template_builds), null without one. Disabled
// templates are listed for operators only.
import { createRoute } from "@hono/zod-openapi";
import type { SizeConfig, TemplateConfig } from "@umiak/config";
import {
	NODE_NOT_BUILDING_SQL,
	STORAGE_BELOW_THRESHOLDS_SQL,
} from "@umiak/core";
import { authOf } from "../auth/principal.ts";
import type { ApiApp, ApiDeps } from "../deps.ts";
import { ERROR_RESPONSES, jsonResponse } from "../openapi/registry.ts";
import {
	SizeListSchema,
	TemplateListSchema,
	type TemplateSchema,
} from "../schemas/catalog.ts";

export interface NodeTemplateAvailability {
	nodeId: string;
	nodeName: string;
	version: string | null;
	pveVmid: number | null;
	available: boolean;
}

export interface CatalogTemplate {
	availability: NodeTemplateAvailability[];
	template: TemplateConfig;
	/** Version of the newest active build; null without one. */
	version: string | null;
	buildCreatedAt: string | null;
	pveVmid: number | null;
}

/** Configured templates in configuration order with their build versions. */
export async function catalogTemplates(
	deps: Pick<ApiDeps, "pool" | "config">,
	opts: { includeDisabled: boolean },
): Promise<CatalogTemplate[]> {
	const templates = (await deps.config.templates()).filter(
		(t) => t.enabled || opts.includeDisabled,
	);
	const builds = new Map<
		string,
		{ version: string; created_at: Date | string; pve_vmid: number }
	>();
	if (deps.pool !== null && templates.length > 0) {
		const r = await deps.pool.query<{
			template_slug: string;
			version: string;
			created_at: Date | string;
			pve_vmid: number;
		}>(
			`SELECT DISTINCT ON (template_slug) template_slug, version, created_at, pve_vmid
			 FROM runtime.template_builds
			 WHERE status = 'active' AND template_slug = ANY($1::text[])
			 ORDER BY template_slug, promoted_at DESC NULLS LAST, created_at DESC`,
			[templates.map((t) => t.slug)],
		);
		for (const row of r.rows) builds.set(row.template_slug, row);
	}
	const availability = new Map<string, NodeTemplateAvailability[]>();
	if (deps.pool !== null && templates.length > 0) {
		const r = await deps.pool.query<
			NodeTemplateAvailability & { templateSlug: string }
		>(
			`
   SELECT slug AS "templateSlug", n.id AS "nodeId", n.name AS "nodeName",
    tb.version, tb.pve_vmid AS "pveVmid",
    (p.state='active' AND n.state='active' AND tb.id IS NOT NULL
     AND ${NODE_NOT_BUILDING_SQL}
     AND COALESCE(${STORAGE_BELOW_THRESHOLDS_SQL},false)) AS available
   FROM runtime.nodes n JOIN runtime.providers p ON p.id=n.provider_id
   CROSS JOIN unnest($1::text[]) AS slug
   LEFT JOIN runtime.template_builds tb ON tb.node_id=n.id AND tb.template_slug=slug AND tb.status='active'
   LEFT JOIN runtime.storages st ON st.id=tb.storage_id AND st.node_id=n.id AND st.provider_id=n.provider_id
   WHERE n.retired_at IS NULL
   ORDER BY n.name,n.id`,
			[templates.map((t) => t.slug)],
		);
		for (const { templateSlug, ...row } of r.rows) {
			const list = availability.get(templateSlug) ?? [];
			list.push(row);
			availability.set(templateSlug, list);
		}
	}
	return templates.map((template) => {
		const build = builds.get(template.slug);
		return {
			template,
			availability: availability.get(template.slug) ?? [],
			version: build?.version ?? null,
			buildCreatedAt: build?.created_at
				? new Date(build.created_at).toISOString()
				: null,
			pveVmid: build?.pve_vmid ?? null,
		};
	});
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
		buildCreatedAt: t.buildCreatedAt,
		pveVmid: t.pveVmid,
		availability: t.availability,
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
