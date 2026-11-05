import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { authOf } from "../auth/principal.ts";
import type { ApiApp, ApiDeps, ApiEnv } from "../deps.ts";
import { ApiError, zodValidationError } from "../http/errors.ts";
import {
	ERROR_RESPONSES,
	HUMAN_ONLY,
	jsonBody,
	jsonResponse,
} from "../openapi/registry.ts";
import * as S from "../settings/schemas.ts";
import * as service from "../settings/service.ts";

export function registerSettingsRoutes(app: ApiApp, deps: ApiDeps) {
	const guard = async (c: Context<ApiEnv>, next: () => Promise<void>) => {
		const p = authOf(c).principal;
		if (p.kind !== "session" || !p.isOperator || !p.userId)
			throw new ApiError(403, "forbidden", "Owner session required");
		if (!deps.pool)
			throw new ApiError(503, "unavailable", "Database unavailable");
		await next();
	};
	function route(
		method: "get" | "post" | "patch" | "put" | "delete",
		path: string,
		name: string,
		response: z.ZodType,
		handle: (c: Context<ApiEnv>) => Promise<unknown>,
		body?: z.ZodType,
	) {
		const params = path.includes("{")
			? z.object(
					Object.fromEntries(
						[...path.matchAll(/\{([^}]+)\}/g)].map((m) => [m[1], z.string()]),
					),
				)
			: undefined;
		app.openapi(
			createRoute({
				method,
				path: `/v1/settings/${path}`,
				operationId: `settings.${name}`,
				summary: name,
				description: `Owner-only ${name}. Requires a browser or paired owner session; scoped team keys are refused.`,
				tags: ["settings"],
				security: HUMAN_ONLY,
				middleware: [guard],
				request: {
					...(body ? { body: jsonBody(body, "Settings") } : {}),
					...(params ? { params } : {}),
				},
				responses: {
					200: jsonResponse(response, "Settings"),
					...ERROR_RESPONSES,
				},
			}),
			async (c) => {
				try {
					return c.json((await handle(c)) as never, 200);
				} catch (error) {
					if (error instanceof z.ZodError)
						throw zodValidationError("json", error);
					const code = (error as { code?: string }).code;
					if (code === "23505" || code === "23503")
						throw new ApiError(
							409,
							"configuration_conflict",
							"Configuration conflicts with existing records",
						);
					throw error;
				}
			},
		);
	}
	const pool = () => {
		if (!deps.pool)
			throw new ApiError(503, "unavailable", "Database unavailable");
		return deps.pool;
	};
	const user = (c: Context<ApiEnv>) => authOf(c).principal.userId as string;
	route("get", "session", "session", S.Session, (c) =>
		service.session(pool(), authOf(c)),
	);
	const account = z.strictObject({ defaultTeamId: z.string() });
	route(
		"patch",
		"account",
		"updateAccount",
		S.Ok,
		async (c) =>
			service.account(
				pool(),
				user(c),
				account.parse(await c.req.json()).defaultTeamId,
			),
		account,
	);
	route("get", "teams", "listTeams", z.array(S.Team), (c) =>
		service.teams(pool(), user(c)),
	);
	route(
		"post",
		"teams",
		"createTeam",
		S.Team,
		async (c) =>
			service.createTeam(
				pool(),
				user(c),
				S.TeamCreate.parse(await c.req.json()).name,
			),
		S.TeamCreate,
	);
	route("get", "teams/{teamId}", "getTeam", S.Team, async (c) => {
		const id = c.req.param("teamId");
		const team = (await service.teams(pool(), user(c))).find(
			(t) => t.id === id,
		);
		if (!team) throw new ApiError(404, "not_found", "Workspace not found");
		return team;
	});
	route(
		"patch",
		"teams/{teamId}",
		"updateTeam",
		S.Ok,
		async (c) =>
			service.updateTeam(
				pool(),
				service.teamUuid(c.req.param("teamId") ?? ""),
				S.TeamPatch.parse(await c.req.json()),
			),
		S.TeamPatch,
	);
	route("delete", "teams/{teamId}", "deleteTeam", S.Ok, (c) =>
		service.deleteTeam(pool(), service.teamUuid(c.req.param("teamId") ?? "")),
	);
	for (const collection of ["templates", "sizes"] as const) {
		const schema = collection === "templates" ? S.Template : S.Size;
		const create = collection === "templates" ? S.TemplateCreate : S.SizeCreate;
		const patch = collection === "templates" ? S.TemplatePatch : S.SizePatch;
		route("get", collection, `list${collection}`, z.array(schema), async () =>
			(await service.list(pool(), collection)).map((row) => schema.parse(row)),
		);
		route(
			"post",
			collection,
			`create${collection}`,
			S.Ok,
			async (c) => {
				const body = create.parse(await c.req.json());
				return service.mutateCatalog(pool(), collection, body.slug, body, true);
			},
			create,
		);
		route(
			"patch",
			`${collection}/{slug}`,
			`update${collection}`,
			S.Ok,
			async (c) =>
				service.mutateCatalog(
					pool(),
					collection,
					S.Slug.parse(c.req.param("slug")),
					patch.parse(await c.req.json()),
				),
			patch,
		);
		route("delete", `${collection}/{slug}`, `delete${collection}`, S.Ok, (c) =>
			service.mutateCatalog(
				pool(),
				collection,
				S.Slug.parse(c.req.param("slug")),
				{},
				false,
				true,
			),
		);
	}
	route("get", "platform-defaults", "defaults", S.Defaults, () =>
		service.defaults(pool()),
	);
	route(
		"put",
		"platform-defaults",
		"updateDefaults",
		S.Ok,
		async (c) =>
			service.setDefaults(pool(), S.Defaults.parse(await c.req.json())),
		S.Defaults,
	);
}
