// Environments of the team (S8 §10.2, S7 C1): list and get need
// `environments:read`; create, change and delete need `environments:write`
// and, for people, the `owner` role (team keys only need the scope). The
// store validates the merged sets with core's limits (`validateSets`).
// Secret values are never returned; the list has names only, GET of one adds
// the env values.
import { createRoute } from "@hono/zod-openapi";
import {
	decodeUuid,
	type EnvironmentPatch,
	type EnvironmentRecord,
	type EnvironmentStore,
	encodeUuid,
	IdentityError,
	type NewEnvironment,
} from "@umiak/auth";
import { isUuid, type Principal } from "@umiak/core";
import { authOf } from "../auth/principal.ts";
import { requireOwnerUnlessKey, requireScope } from "../auth/scopes.ts";
import type { ApiApp, ApiDeps } from "../deps.ts";
import { ApiError, notFoundError } from "../http/errors.ts";
import { iso } from "../map/operation.ts";
import {
	ERROR_RESPONSES,
	errorResponse,
	jsonBody,
	jsonResponse,
} from "../openapi/registry.ts";
import { compact } from "../schemas/common.ts";
import {
	CreateEnvironmentRequest,
	EnvironmentListSchema,
	EnvironmentParams,
	EnvironmentSchema,
	UpdateEnvironmentRequest,
} from "../schemas/environment.ts";
import { envView } from "./env.ts";

const TAGS = ["environments"];

const notFound404 = errorResponse(
	"`not_found`: no such environment in the team",
);
const write403 = errorResponse(
	"`forbidden`: the key lacks environments:write (details.requiredScope), or the person " +
		"is not an owner of the team (details.reason `role`)",
);
const write400 = errorResponse(
	"`validation`: name, repositories, or a limit of the sets (checked on the result)",
);
const name409 = errorResponse(
	"`already_exists`: the name is taken in the team",
);

const listEnvironments = createRoute({
	method: "get",
	path: "/v1/environments",
	operationId: "environments.list",
	summary: "List environments",
	description:
		"Environments of the team by name, without values: names of env and secret variables " +
		"and the metadata of secret files.",
	tags: TAGS,
	middleware: [requireScope("environments:read")] as const,
	responses: {
		200: jsonResponse(EnvironmentListSchema, "Environments of the team"),
		...ERROR_RESPONSES,
	},
});

const getEnvironment = createRoute({
	method: "get",
	path: "/v1/environments/{environment}",
	operationId: "environments.get",
	summary: "Get an environment",
	description:
		"The environment with its env values. Secret values are never returned, only their names.",
	tags: TAGS,
	middleware: [requireScope("environments:read")] as const,
	request: { params: EnvironmentParams },
	responses: {
		200: jsonResponse(EnvironmentSchema, "The environment"),
		404: notFound404,
		...ERROR_RESPONSES,
	},
});

const createEnvironment = createRoute({
	method: "post",
	path: "/v1/environments",
	operationId: "environments.create",
	summary: "Create an environment",
	description:
		"A named set of env, secrets, secret files and repositories that new sandboxes of the " +
		"team get at create (`environment` of POST /v1/sandboxes; the default one when it is " +
		"omitted). Changes apply to new sandboxes only. Only owners (or a team key with " +
		"environments:write).",
	tags: TAGS,
	middleware: [
		requireScope("environments:write"),
		requireOwnerUnlessKey(),
	] as const,
	request: { body: jsonBody(CreateEnvironmentRequest, "The environment") },
	responses: {
		201: jsonResponse(EnvironmentSchema, "Created"),
		400: write400,
		403: write403,
		409: name409,
		...ERROR_RESPONSES,
	},
});

const updateEnvironment = createRoute({
	method: "patch",
	path: "/v1/environments/{environment}",
	operationId: "environments.update",
	summary: "Change an environment",
	description:
		"Sets merge by key: a value sets the variable, null deletes it; secret files by name " +
		"(null deletes). `repositories` replaces the list. `revision` grows by one. Sandboxes " +
		"created before keep their values.",
	tags: TAGS,
	middleware: [
		requireScope("environments:write"),
		requireOwnerUnlessKey(),
	] as const,
	request: {
		params: EnvironmentParams,
		body: jsonBody(UpdateEnvironmentRequest, "Changes"),
	},
	responses: {
		200: jsonResponse(EnvironmentSchema, "The changed environment"),
		400: write400,
		403: write403,
		404: notFound404,
		409: name409,
		...ERROR_RESPONSES,
	},
});

const deleteEnvironment = createRoute({
	method: "delete",
	path: "/v1/environments/{environment}",
	operationId: "environments.delete",
	summary: "Delete an environment",
	description: "Sandboxes created from it keep their values.",
	tags: TAGS,
	middleware: [
		requireScope("environments:write"),
		requireOwnerUnlessKey(),
	] as const,
	request: { params: EnvironmentParams },
	responses: {
		204: { description: "Deleted" },
		403: write403,
		404: notFound404,
		...ERROR_RESPONSES,
	},
});

const ENV_PREFIX = "env_";

/**
 * Path reference -> store reference: `env_...` is an id (a bad one is 404),
 * anything else a name. A bare UUID is never a name (the store would read
 * it as an id), so it is 404.
 */
export function environmentRef(ref: string): string {
	if (ref.slice(0, ENV_PREFIX.length).toLowerCase() === ENV_PREFIX) {
		const id = decodeUuid("environment", ref);
		if (id === null) throw notFoundError("environment");
		return id;
	}
	if (isUuid(ref)) throw notFoundError("environment");
	return ref;
}

function summary(e: EnvironmentRecord) {
	const view = envView(e.sets);
	return {
		id: encodeUuid("environment", e.id),
		name: e.name,
		isDefault: e.isDefault,
		revision: e.revision,
		envKeys: Object.keys(e.sets.env).sort(),
		secretKeys: view.secretKeys,
		secretFiles: view.secretFiles,
		repositories: e.repositories.map((r) => ({
			url: r.url,
			...(r.branch === undefined ? {} : { branch: r.branch }),
			...(r.path === undefined ? {} : { path: r.path }),
		})),
		excludeOwnerSecrets: e.excludeOwnerSecrets,
		createdAt: iso(e.createdAt),
		updatedAt: iso(e.updatedAt),
		updatedBy: e.updatedBy === null ? null : encodeUuid("user", e.updatedBy),
	};
}

function detail(e: EnvironmentRecord) {
	return { ...summary(e), env: e.sets.env };
}

/** Store errors -> API errors; anything else (core `validation`) passes. */
async function store<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (e) {
		if (e instanceof IdentityError) {
			if (e.code === "not_found") throw notFoundError("environment");
			if (e.code === "name_taken") {
				throw new ApiError(
					409,
					"already_exists",
					"an environment with this name exists in the team; pick another name",
				);
			}
		}
		throw e;
	}
}

async function getOne(
	s: EnvironmentStore,
	p: Principal,
	ref: string,
): Promise<EnvironmentRecord> {
	const e = await s.get(p.teamId, environmentRef(ref));
	if (e === null) throw notFoundError("environment");
	return e;
}

export function registerEnvironmentRoutes(app: ApiApp, deps: ApiDeps): void {
	const envs = deps.environments;

	app.openapi(listEnvironments, async (c) => {
		const p = authOf(c).principal;
		const list = await envs.list(p.teamId);
		return c.json({ data: list.map(summary) }, 200);
	});

	app.openapi(getEnvironment, async (c) => {
		const p = authOf(c).principal;
		const e = await getOne(envs, p, c.req.valid("param").environment);
		return c.json(detail(e), 200);
	});

	app.openapi(createEnvironment, async (c) => {
		const p = authOf(c).principal;
		const input = compact(c.req.valid("json")) as NewEnvironment;
		const e = await store(() => envs.create(p.teamId, input, p.userId));
		return c.json(detail(e), 201);
	});

	app.openapi(updateEnvironment, async (c) => {
		const p = authOf(c).principal;
		const ref = environmentRef(c.req.valid("param").environment);
		const patch = compact(c.req.valid("json")) as EnvironmentPatch;
		const e = await store(() => envs.patch(p.teamId, ref, patch, p.userId));
		return c.json(detail(e), 200);
	});

	app.openapi(deleteEnvironment, async (c) => {
		const p = authOf(c).principal;
		const ref = environmentRef(c.req.valid("param").environment);
		await store(() => envs.delete(p.teamId, ref));
		return c.body(null, 204);
	});
}
