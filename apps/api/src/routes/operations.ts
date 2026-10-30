// GET /v1/operations/{operation} with long-poll (S7 §5.10, §8.4). Internal
// `reprovision` operations are 404 like unknown ones.
import { createRoute } from "@hono/zod-openapi";
import { decodeUuid } from "@sbx/auth";
import { authOf } from "../auth/principal.ts";
import { requireScope } from "../auth/scopes.ts";
import type { ApiApp, ApiDeps } from "../deps.ts";
import { notFoundError } from "../http/errors.ts";
import { waitForOperation } from "../http/wait.ts";
import { toOperationResource } from "../map/operation.ts";
import {
	ERROR_RESPONSES,
	errorResponse,
	jsonResponse,
} from "../openapi/registry.ts";
import { OperationParams } from "../schemas/common.ts";
import { OperationQuery, OperationSchema } from "../schemas/operation.ts";

const getOperation = createRoute({
	method: "get",
	path: "/v1/operations/{operation}",
	operationId: "operations.get",
	summary: "Get an operation (long-poll)",
	description:
		"An operation of the team's sandboxes. With `waitSeconds` (up to 60) the answer comes " +
		"as soon as the operation is final (succeeded, failed, superseded), else after the " +
		"timeout with its current state; 200 either way.",
	tags: ["operations"],
	middleware: [requireScope("sandboxes:read")] as const,
	request: { params: OperationParams, query: OperationQuery },
	responses: {
		200: jsonResponse(OperationSchema, "The operation"),
		404: errorResponse("`not_found`: no such operation in the team"),
		...ERROR_RESPONSES,
	},
});

export function registerOperationRoutes(app: ApiApp, deps: ApiDeps): void {
	app.openapi(getOperation, async (c) => {
		const p = authOf(c).principal;
		const id = decodeUuid("operation", c.req.valid("param").operation);
		if (id === null) throw notFoundError("operation");
		const op = await waitForOperation(
			deps.svc,
			p,
			id,
			c.req.valid("query").waitSeconds ?? 0,
		);
		return c.json(toOperationResource(op), 200);
	});
}
