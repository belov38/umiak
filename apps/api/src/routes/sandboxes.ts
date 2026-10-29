// Sandbox routes (S7 §6, §8.2): create, list, get with long-poll, patch
// (with slug rename), delete with Sbx-Confirm-Delete, and the actions stop,
// resume, fork, recover, extend. Actions that start an operation answer 202
// {sandbox, operation}; a repeat while the same kind is active returns that
// operation (core), another kind is 409 operation_in_progress.
import { createRoute, z } from "@hono/zod-openapi";
import {
	decodeUuid,
	type EnvironmentRecord,
	type EnvironmentStore,
	encodeUuid,
} from "@sbx/auth";
import {
	type CreateInput,
	type ForkInput,
	type ListFilter,
	type Principal,
	type ResumeInput,
	SANDBOX_STATES,
	type SandboxState,
} from "@sbx/core";
import { authOf } from "../auth/principal.ts";
import { limitStarts } from "../auth/rate-limit.ts";
import { checkScope, requireScope } from "../auth/scopes.ts";
import type { ApiApp, ApiDeps } from "../deps.ts";
import { requireConfirmDelete } from "../http/confirm-delete.ts";
import { decodeCursor, signNextCursor } from "../http/cursor.ts";
import { notFoundError, validationError } from "../http/errors.ts";
import {
	idempotencyKeyHeader,
	idempotencyStart,
	replayHeaders,
} from "../http/idempotency.ts";
import { waitForSandbox } from "../http/wait.ts";
import { toOperationResource } from "../map/operation.ts";
import {
	resolveSandboxRef,
	sandboxResource,
	sandboxResources,
} from "../map/sandbox.ts";
import {
	ERROR_RESPONSES,
	errorResponse,
	jsonBody,
	jsonResponse,
	optionalJsonBody,
} from "../openapi/registry.ts";
import { compact, csvList, SandboxParams } from "../schemas/common.ts";
import {
	CreateSandboxRequest,
	ExtendSandboxRequest,
	ForkSandboxRequest,
	GetSandboxQuery,
	ListSandboxesQuery,
	ResumeSandboxRequest,
	SandboxActionSchema,
	SandboxDeleteSchema,
	SandboxForkSchema,
	SandboxListSchema,
	SandboxSchema,
	UpdateSandboxRequest,
} from "../schemas/sandbox.ts";

const TAGS = ["sandboxes"];

/** Default long-poll when `waitFor` is given without `waitSeconds`. */
export const DEFAULT_WAIT_SECONDS = 30;

const notFound404 = errorResponse(
	"`not_found`: no such sandbox in the team (also for a malformed id)",
);
const state409 = errorResponse(
	"`invalid_state` (details.state) or `operation_in_progress` (retryable; details.operationId, kind)",
);
const idempotencyHeaders = {
	headers: {
		"Idempotency-Replayed": {
			description:
				"`true` when the answer is the stored result of an earlier request with this Idempotency-Key",
			schema: { type: "string" as const, enum: ["true"] },
		},
	},
};

const IdempotencyHeaders = z.object({
	"Idempotency-Key": z
		.string()
		.optional()
		.openapi({
			description:
				"1-255 printable ASCII characters; a repeat with the same key and body returns the " +
				"stored result instead of creating again (24 h)",
		}),
});

const ConfirmDeleteHeaders = z.object({
	"Sbx-Confirm-Delete": z
		.string()
		.optional()
		.openapi({
			description:
				"Required: the id (`sb_...`) or slug of the sandbox in the path; without it or with " +
				"another sandbox the answer is 428 and nothing is deleted",
		}),
});

// --- create ---

const createSandbox = createRoute({
	method: "post",
	path: "/v1/sandboxes",
	operationId: "sandboxes.create",
	summary: "Create a sandbox",
	description:
		"Starts a new VM sandbox from a template (or a saved snapshot with `from`) and answers " +
		"202 at once with the sandbox in `creating` and its `create` operation. Wait for it with " +
		"GET /v1/sandboxes/{sandbox}?waitFor=ready. All fields are optional. The team's " +
		"environment (or the one named in `environment`) is applied first, the request's env, " +
		"secrets and secret files on top. Send an Idempotency-Key to retry safely.",
	tags: TAGS,
	middleware: [requireScope("sandboxes:write")] as const,
	request: {
		headers: IdempotencyHeaders,
		body: optionalJsonBody(CreateSandboxRequest, "What to create"),
	},
	responses: {
		202: {
			...jsonResponse(SandboxActionSchema, "The new sandbox and its create"),
			...idempotencyHeaders,
		},
		403: errorResponse(
			"`quota_exceeded` (details quota, limit, current) or `forbidden`",
		),
		404: errorResponse("`snapshot_not_found` or `not_found` (environment)"),
		409: errorResponse("`slug_taken` or `idempotency_key_reused`"),
		422: errorResponse(
			"`template_unavailable`: template disabled or size not allowed",
		),
		503: errorResponse("`out_of_capacity` (retryable, Retry-After)"),
		...ERROR_RESPONSES,
	},
});

const ENV_PREFIX = "env_";

async function resolveEnvironment(
	store: EnvironmentStore,
	p: Principal,
	ref: string | null | undefined,
): Promise<EnvironmentRecord | null> {
	if (ref === null) return null;
	if (ref === undefined) return store.getDefault(p.teamId);
	checkScope(p, "environments:read");
	let key = ref;
	if (ref.slice(0, ENV_PREFIX.length).toLowerCase() === ENV_PREFIX) {
		const id = decodeUuid("environment", ref);
		if (id === null) throw notFoundError("environment");
		key = id;
	}
	const rec = await store.get(p.teamId, key);
	if (rec === null) throw notFoundError("environment");
	return rec;
}

/** The environment's sets, the request's on top (same key or file name wins). */
function applyEnvironment(
	input: CreateInput,
	rec: EnvironmentRecord | null,
): CreateInput {
	if (rec === null) return input;
	const files = input.secretFiles ?? [];
	const names = new Set(files.map((f) => f.name));
	return {
		...input,
		env: { ...rec.sets.env, ...input.env },
		secrets: { ...rec.sets.secrets, ...input.secrets },
		secretFiles: [
			...rec.sets.secretFiles.filter((f) => !names.has(f.name)),
			...files,
		],
	};
}

// --- list / get ---

const listSandboxes = createRoute({
	method: "get",
	path: "/v1/sandboxes",
	operationId: "sandboxes.list",
	summary: "List sandboxes",
	description:
		"Sandboxes of the team, newest first, in pages of `limit` (default 50) with `nextCursor`. " +
		"Filters: `state` (comma-separated; deleted ones only with state=deleted), `label=k=v` " +
		"(repeat; all must match), `template`, `q` (prefix of name or slug).",
	tags: TAGS,
	middleware: [requireScope("sandboxes:read")] as const,
	request: { query: ListSandboxesQuery },
	responses: {
		200: jsonResponse(SandboxListSchema, "A page of sandboxes"),
		400: errorResponse("`validation` or `invalid_cursor`"),
		...ERROR_RESPONSES,
	},
});

const getSandbox = createRoute({
	method: "get",
	path: "/v1/sandboxes/{sandbox}",
	operationId: "sandboxes.get",
	summary: "Get a sandbox (long-poll)",
	description:
		"The sandbox by id or slug. With `waitFor=ready,stopped` (and `waitSeconds`, up to 60, " +
		"default 30) the answer comes as soon as the state is one of them or becomes " +
		"error/deleting/deleted, else after the timeout with the current state; 200 either way. " +
		"Deleted sandboxes stay readable for 30 days.",
	tags: TAGS,
	middleware: [requireScope("sandboxes:read")] as const,
	request: { params: SandboxParams, query: GetSandboxQuery },
	responses: {
		200: jsonResponse(SandboxSchema, "The sandbox"),
		404: notFound404,
		...ERROR_RESPONSES,
	},
});

function parseStates(
	raw: string | undefined,
	path: string,
): SandboxState[] | undefined {
	const list = csvList(raw);
	if (list === undefined) return undefined;
	const bad = list.filter(
		(s) => !(SANDBOX_STATES as readonly string[]).includes(s),
	);
	if (bad.length > 0) {
		throw validationError([
			{
				path,
				message: `unknown state ${bad.join(", ")}; one of ${SANDBOX_STATES.join(", ")}`,
			},
		]);
	}
	return list as SandboxState[];
}

function parseLabels(
	raw: string | string[] | undefined,
): Record<string, string> | undefined {
	if (raw === undefined) return undefined;
	const out = new Map<string, string>();
	for (const item of Array.isArray(raw) ? raw : [raw]) {
		const eq = item.indexOf("=");
		if (eq <= 0) {
			throw validationError([
				{ path: "query.label", message: "must be key=value" },
			]);
		}
		out.set(item.slice(0, eq), item.slice(eq + 1));
	}
	return Object.fromEntries(out);
}

// --- patch / delete ---

const updateSandbox = createRoute({
	method: "patch",
	path: "/v1/sandboxes/{sandbox}",
	operationId: "sandboxes.update",
	summary: "Update a sandbox",
	description:
		"Changes name, slug, labels (replaced whole), ttlSeconds (deadline = now + ttl on a " +
		"ready sandbox; null removes it) and idleTimeoutSeconds. A new slug changes the URLs " +
		"of published ports at once; old URLs and cookies stop working.",
	tags: TAGS,
	middleware: [requireScope("sandboxes:write")] as const,
	request: {
		params: SandboxParams,
		body: jsonBody(UpdateSandboxRequest, "Fields to change"),
	},
	responses: {
		200: jsonResponse(SandboxSchema, "The updated sandbox"),
		404: notFound404,
		409: errorResponse("`slug_taken` or `invalid_state` (deleting, deleted)"),
		...ERROR_RESPONSES,
	},
});

const deleteSandbox = createRoute({
	method: "delete",
	path: "/v1/sandboxes/{sandbox}",
	operationId: "sandboxes.delete",
	summary: "Delete a sandbox",
	description:
		"Deletes the sandbox and its VM; any running operation is superseded. Needs the header " +
		"Sbx-Confirm-Delete with the sandbox id (or slug) — otherwise 428 and nothing happens. " +
		"Answers 202 with the delete operation; on an already deleted sandbox 200 with " +
		"`operation: null`. Repeating is safe.",
	tags: TAGS,
	middleware: [requireScope("sandboxes:delete")] as const,
	request: { params: SandboxParams, headers: ConfirmDeleteHeaders },
	responses: {
		200: jsonResponse(SandboxDeleteSchema, "Already deleted"),
		202: jsonResponse(SandboxDeleteSchema, "Deleting"),
		404: notFound404,
		428: errorResponse(
			"`confirmation_required`: Sbx-Confirm-Delete is missing or names another resource",
		),
		...ERROR_RESPONSES,
	},
});

// --- actions ---

function action(o: {
	path: string;
	operationId: string;
	summary: string;
	description: string;
}) {
	return {
		method: "post" as const,
		path: o.path,
		operationId: o.operationId,
		summary: o.summary,
		description: o.description,
		tags: TAGS,
	};
}

const stopSandbox = createRoute({
	...action({
		path: "/v1/sandboxes/{sandbox}/stop",
		operationId: "sandboxes.stop",
		summary: "Stop a sandbox",
		description:
			"Shuts the VM down and keeps its disk; resume brings it back. Only from `ready`. " +
			"A repeat while the stop runs returns the same operation.",
	}),
	middleware: [requireScope("sandboxes:write")] as const,
	request: { params: SandboxParams },
	responses: {
		202: jsonResponse(SandboxActionSchema, "Stopping"),
		404: notFound404,
		409: state409,
		...ERROR_RESPONSES,
	},
});

const resumeSandbox = createRoute({
	...action({
		path: "/v1/sandboxes/{sandbox}/resume",
		operationId: "sandboxes.resume",
		summary: "Resume a stopped sandbox",
		description:
			"Starts a stopped sandbox again, optionally with another size or TTL. env, secrets " +
			"and secretFiles merge onto the sandbox's own (null deletes) and are kept even if the " +
			"resume fails. A repeat with the same body while the resume runs returns it.",
	}),
	middleware: [requireScope("sandboxes:write")] as const,
	request: {
		params: SandboxParams,
		body: optionalJsonBody(ResumeSandboxRequest, "Optional changes"),
	},
	responses: {
		202: jsonResponse(SandboxActionSchema, "Starting"),
		403: errorResponse("`quota_exceeded`"),
		404: notFound404,
		409: state409,
		503: errorResponse("`out_of_capacity` (retryable)"),
		...ERROR_RESPONSES,
	},
});

const forkSandbox = createRoute({
	...action({
		path: "/v1/sandboxes/{sandbox}/fork",
		operationId: "sandboxes.fork",
		summary: "Fork a sandbox",
		description:
			"Creates a new sandbox from a snapshot of this one (disk and env/secrets copied; the " +
			"request's sets merge on top). Answers 202 with the new sandbox, its `create` " +
			"operation and the `fork` operation on the source. Send an Idempotency-Key to retry safely.",
	}),
	middleware: [requireScope("sandboxes:write")] as const,
	request: {
		params: SandboxParams,
		headers: IdempotencyHeaders,
		body: optionalJsonBody(ForkSandboxRequest, "Settings of the new sandbox"),
	},
	responses: {
		202: {
			...jsonResponse(SandboxForkSchema, "Forking"),
			...idempotencyHeaders,
		},
		403: errorResponse("`quota_exceeded`"),
		404: notFound404,
		409: errorResponse(
			"`invalid_state`, `operation_in_progress`, `slug_taken` or `idempotency_key_reused`",
		),
		503: errorResponse("`out_of_capacity` (retryable)"),
		...ERROR_RESPONSES,
	},
});

const recoverSandbox = createRoute({
	...action({
		path: "/v1/sandboxes/{sandbox}/recover",
		operationId: "sandboxes.recover",
		summary: "Recover a sandbox",
		description:
			"Reboots a sandbox in `error` (or a stuck one) on its disk. Rate limited per sandbox " +
			"(429 recover_rate_limited). A repeat while the recover runs returns it.",
	}),
	middleware: [requireScope("sandboxes:write")] as const,
	request: { params: SandboxParams },
	responses: {
		202: jsonResponse(SandboxActionSchema, "Recovering"),
		404: notFound404,
		409: state409,
		429: errorResponse("`recover_rate_limited` (retryable, Retry-After)"),
		...ERROR_RESPONSES,
	},
});

const extendSandbox = createRoute({
	...action({
		path: "/v1/sandboxes/{sandbox}/extend",
		operationId: "sandboxes.extend",
		summary: "Extend the TTL",
		description:
			"Moves the deadline of a ready sandbox to now + ttlSeconds (default: its TTL). The " +
			"sandbox's TTL itself does not change. No operation.",
	}),
	middleware: [requireScope("sandboxes:write")] as const,
	request: {
		params: SandboxParams,
		body: optionalJsonBody(ExtendSandboxRequest, "New lifetime"),
	},
	responses: {
		200: jsonResponse(SandboxSchema, "The sandbox with its new deadline"),
		404: notFound404,
		409: errorResponse("`invalid_state`: not ready"),
		...ERROR_RESPONSES,
	},
});

export function registerSandboxRoutes(app: ApiApp, deps: ApiDeps): void {
	const svc = deps.svc;
	const one = (s: Parameters<typeof sandboxResource>[1]) =>
		sandboxResource(deps, s);

	app.openapi(
		{
			...createSandbox,
			middleware: [...createSandbox.middleware, limitStarts(deps)],
		},
		async (c) => {
			const p = authOf(c).principal;
			const {
				environment,
				excludeOwnerSecrets: _owner,
				...body
			} = c.req.valid("json");
			if (body.from !== undefined) checkScope(p, "snapshots:read");
			const idemKey = idempotencyKeyHeader(c);
			const env = await resolveEnvironment(deps.environments, p, environment);
			const input = applyEnvironment(compact(body) as CreateInput, env);
			const start = await idempotencyStart(deps.pool, idemKey);
			const r = await svc.create(p, input, idemKey);
			return c.json(
				{
					sandbox: await one(r.sandbox),
					operation: toOperationResource(r.operation),
				},
				202,
				replayHeaders(start, r.operation),
			);
		},
	);

	app.openapi(listSandboxes, async (c) => {
		const p = authOf(c).principal;
		const q = c.req.valid("query");
		const filter: ListFilter = compact({
			state: parseStates(q.state, "query.state"),
			labels: parseLabels(q.label),
			template: q.template,
			q: q.q,
			limit: q.limit,
		});
		const key = deps.settings.cursorKey;
		const inner =
			q.cursor === undefined ? undefined : decodeCursor(q.cursor, key);
		const page = await svc.list(p, filter, inner);
		return c.json(
			{
				data: await sandboxResources(deps, page.data),
				nextCursor: signNextCursor(page.nextCursor, key),
			},
			200,
		);
	});

	app.openapi(getSandbox, async (c) => {
		const p = authOf(c).principal;
		const { sandbox } = c.req.valid("param");
		const q = c.req.valid("query");
		const waitFor = parseStates(q.waitFor, "query.waitFor");
		const s = await waitForSandbox(
			svc,
			p,
			resolveSandboxRef(sandbox),
			waitFor,
			q.waitSeconds ?? (waitFor === undefined ? 0 : DEFAULT_WAIT_SECONDS),
		);
		return c.json(await one(s), 200);
	});

	app.openapi(updateSandbox, async (c) => {
		const p = authOf(c).principal;
		const { sandbox } = c.req.valid("param");
		const { slug, ...rest } = compact(c.req.valid("json"));
		let s = await svc.get(p, resolveSandboxRef(sandbox));
		if (slug !== undefined) s = await svc.rename(p, s.id, slug);
		if (Object.keys(rest).length > 0) s = await svc.update(p, s.id, rest);
		return c.json(await one(s), 200);
	});

	app.openapi(deleteSandbox, async (c) => {
		const p = authOf(c).principal;
		const { sandbox } = c.req.valid("param");
		const s = await svc.get(p, resolveSandboxRef(sandbox));
		requireConfirmDelete(c, {
			id: encodeUuid("sandbox", s.id),
			aliases: [s.slug],
		});
		if (s.state === "deleted") {
			return c.json({ sandbox: await one(s), operation: null }, 200);
		}
		const op = await svc.delete(p, s.id);
		return c.json(
			{
				sandbox: await one(await svc.get(p, s.id)),
				operation: toOperationResource(op),
			},
			202,
		);
	});

	app.openapi(stopSandbox, async (c) => {
		const p = authOf(c).principal;
		const ref = resolveSandboxRef(c.req.valid("param").sandbox);
		const op = await svc.stop(p, ref);
		return c.json(
			{
				sandbox: await one(await svc.get(p, op.sandboxId)),
				operation: toOperationResource(op),
			},
			202,
		);
	});

	app.openapi(
		{
			...resumeSandbox,
			middleware: [...resumeSandbox.middleware, limitStarts(deps)],
		},
		async (c) => {
			const p = authOf(c).principal;
			const ref = resolveSandboxRef(c.req.valid("param").sandbox);
			const op = await svc.resume(
				p,
				ref,
				compact(c.req.valid("json")) as ResumeInput,
			);
			return c.json(
				{
					sandbox: await one(await svc.get(p, op.sandboxId)),
					operation: toOperationResource(op),
				},
				202,
			);
		},
	);

	app.openapi(
		{
			...forkSandbox,
			middleware: [...forkSandbox.middleware, limitStarts(deps)],
		},
		async (c) => {
			const p = authOf(c).principal;
			const ref = resolveSandboxRef(c.req.valid("param").sandbox);
			const idemKey = idempotencyKeyHeader(c);
			const start = await idempotencyStart(deps.pool, idemKey);
			const r = await svc.fork(
				p,
				ref,
				compact(c.req.valid("json")) as ForkInput,
				idemKey,
			);
			return c.json(
				{
					sandbox: await one(r.sandbox),
					operation: toOperationResource(r.operation),
					sourceOperation: toOperationResource(r.sourceOperation),
				},
				202,
				replayHeaders(start, r.operation),
			);
		},
	);

	app.openapi(recoverSandbox, async (c) => {
		const p = authOf(c).principal;
		const ref = resolveSandboxRef(c.req.valid("param").sandbox);
		const op = await svc.recover(p, ref);
		return c.json(
			{
				sandbox: await one(await svc.get(p, op.sandboxId)),
				operation: toOperationResource(op),
			},
			202,
		);
	});

	app.openapi(extendSandbox, async (c) => {
		const p = authOf(c).principal;
		const ref = resolveSandboxRef(c.req.valid("param").sandbox);
		const s = await svc.extend(p, ref, c.req.valid("json").ttlSeconds);
		return c.json(await one(s), 200);
	});
}
