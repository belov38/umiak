// Saved snapshots (S7 §13, S6 §7.8): create from a sandbox (202 with the
// save_snapshot operation, Idempotency-Key), list, get by name, delete with
// Sbx-Confirm-Delete (`snap_...` or the name).
import { createRoute, z } from "@hono/zod-openapi";
import { encodeUuid } from "@sbx/auth";
import { authOf } from "../auth/principal.ts";
import { requireScope } from "../auth/scopes.ts";
import type { ApiApp, ApiDeps } from "../deps.ts";
import { requireConfirmDelete } from "../http/confirm-delete.ts";
import { ApiError } from "../http/errors.ts";
import {
	idempotencyKeyHeader,
	idempotencyStart,
	replayHeaders,
} from "../http/idempotency.ts";
import { toOperationResource } from "../map/operation.ts";
import { resolveSandboxRef } from "../map/sandbox.ts";
import { snapshotResource, snapshotResources } from "../map/snapshot.ts";
import {
	ERROR_RESPONSES,
	errorResponse,
	jsonBody,
	jsonResponse,
} from "../openapi/registry.ts";
import {
	CreateSnapshotRequest,
	SnapshotCreateSchema,
	SnapshotListSchema,
	SnapshotParams,
	SnapshotSchema,
} from "../schemas/snapshot.ts";

const TAGS = ["snapshots"];

const notFound404 = errorResponse(
	"`snapshot_not_found`: no ready or creating snapshot of this name in the team",
);

const IdempotencyHeaders = z.object({
	"Idempotency-Key": z
		.string()
		.optional()
		.openapi({
			description:
				"1-255 printable ASCII characters; a repeat with the same key and body returns the " +
				"stored result instead of saving again (24 h)",
		}),
});

const ConfirmDeleteHeaders = z.object({
	"Sbx-Confirm-Delete": z
		.string()
		.optional()
		.openapi({
			description:
				"Required: the id (`snap_...`) or the name of the snapshot in the path; without it " +
				"or with another snapshot the answer is 428 and nothing is deleted",
		}),
});

const createSnapshot = createRoute({
	method: "post",
	path: "/v1/snapshots",
	operationId: "snapshots.create",
	summary: "Save a snapshot of a sandbox",
	description:
		"Takes a snapshot of the sandbox (ready or stopped) under `name` and answers 202 with " +
		"the snapshot in `creating` and the `save_snapshot` operation of the sandbox; wait with " +
		"GET /v1/operations/{operation}?waitSeconds=. A ready snapshot with the same name is " +
		"replaced once the new one is ready. Send an Idempotency-Key to retry safely.",
	tags: TAGS,
	middleware: [requireScope("snapshots:write")] as const,
	request: {
		headers: IdempotencyHeaders,
		body: jsonBody(CreateSnapshotRequest, "Source sandbox and name"),
	},
	responses: {
		202: {
			...jsonResponse(SnapshotCreateSchema, "Saving"),
			headers: {
				"Idempotency-Replayed": {
					description:
						"`true` when the answer is the stored result of an earlier request with this Idempotency-Key",
					schema: { type: "string" as const, enum: ["true"] },
				},
			},
		},
		403: errorResponse(
			"`quota_exceeded` (saved snapshots of the team) or `forbidden`",
		),
		404: errorResponse("`not_found`: no such sandbox in the team"),
		409: errorResponse(
			"`invalid_state` (details.state), `operation_in_progress` (retryable) or " +
				"`idempotency_key_reused`",
		),
		...ERROR_RESPONSES,
	},
});

const listSnapshots = createRoute({
	method: "get",
	path: "/v1/snapshots",
	operationId: "snapshots.list",
	summary: "List saved snapshots",
	description:
		"Saved snapshots of the team, newest first: ready ones, those being created (under the " +
		"name they will get) and those that failed within the last day.",
	tags: TAGS,
	middleware: [requireScope("snapshots:read")] as const,
	responses: {
		200: jsonResponse(SnapshotListSchema, "Saved snapshots"),
		...ERROR_RESPONSES,
	},
});

const getSnapshot = createRoute({
	method: "get",
	path: "/v1/snapshots/{name}",
	operationId: "snapshots.get",
	summary: "Get a saved snapshot",
	description:
		"The ready snapshot of this name, else the one being created under it.",
	tags: TAGS,
	middleware: [requireScope("snapshots:read")] as const,
	request: { params: SnapshotParams },
	responses: {
		200: jsonResponse(SnapshotSchema, "The snapshot"),
		404: notFound404,
		...ERROR_RESPONSES,
	},
});

const deleteSnapshot = createRoute({
	method: "delete",
	path: "/v1/snapshots/{name}",
	operationId: "snapshots.delete",
	summary: "Delete a saved snapshot",
	description:
		"Deletes the ready snapshot of this name; the name is free at once, the disk is " +
		"removed in the background. Needs the header Sbx-Confirm-Delete with the snapshot id " +
		"(or name) — otherwise 428 and nothing happens. Sandboxes created from it stay.",
	tags: TAGS,
	middleware: [requireScope("snapshots:write")] as const,
	request: { params: SnapshotParams, headers: ConfirmDeleteHeaders },
	responses: {
		204: { description: "Deleting" },
		404: notFound404,
		409: errorResponse(
			"`invalid_state` (details.state `creating`): wait until it is ready",
		),
		428: errorResponse(
			"`confirmation_required`: Sbx-Confirm-Delete is missing or names another resource",
		),
		...ERROR_RESPONSES,
	},
});

export function registerSnapshotRoutes(app: ApiApp, deps: ApiDeps): void {
	const svc = deps.svc;

	app.openapi(createSnapshot, async (c) => {
		const p = authOf(c).principal;
		const { sandbox, name } = c.req.valid("json");
		const idemKey = idempotencyKeyHeader(c);
		const start = await idempotencyStart(deps.pool, idemKey);
		const r = await svc.saveSnapshot(
			p,
			resolveSandboxRef(sandbox),
			name,
			idemKey,
		);
		return c.json(
			{
				snapshot: await snapshotResource(deps.pool, r.snapshot),
				operation: toOperationResource(r.operation),
			},
			202,
			replayHeaders(start, r.operation),
		);
	});

	app.openapi(listSnapshots, async (c) => {
		const p = authOf(c).principal;
		const list = await svc.listSavedSnapshots(p);
		return c.json({ data: await snapshotResources(deps.pool, list) }, 200);
	});

	app.openapi(getSnapshot, async (c) => {
		const p = authOf(c).principal;
		const s = await svc.getSavedSnapshot(p, c.req.valid("param").name);
		return c.json(await snapshotResource(deps.pool, s), 200);
	});

	app.openapi(deleteSnapshot, async (c) => {
		const p = authOf(c).principal;
		const { name } = c.req.valid("param");
		const s = await svc.getSavedSnapshot(p, name);
		requireConfirmDelete(c, {
			id: encodeUuid("snapshot", s.id),
			aliases: [name],
		});
		if (s.state !== "ready") {
			throw new ApiError(
				409,
				"invalid_state",
				`snapshot ${name} is still ${s.state}; delete it once it is ready`,
				{ details: { state: s.state } },
			);
		}
		await svc.deleteSavedSnapshot(p, name);
		return c.body(null, 204);
	});
}
