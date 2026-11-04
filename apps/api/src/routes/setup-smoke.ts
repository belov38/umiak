// Private dashboard-only setup operation; deliberately absent from public OpenAPI/SDKs.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { authOf } from "../auth/principal.ts";
import { requireOperator } from "../auth/scopes.ts";
import type { ApiApp, ApiDeps } from "../deps.ts";
import { ApiError } from "../http/errors.ts";
import { toOperationResource } from "../map/operation.ts";
import { sandboxResource } from "../map/sandbox.ts";
export function registerSetupSmoke(app: ApiApp, deps: ApiDeps): void {
	app.post("/v1/setup/smoke", requireOperator(), async (c) => {
		const body = z
			.object({ nodeId: z.uuid() })
			.strict()
			.safeParse(await c.req.json());
		if (!body.success)
			throw new ApiError(
				400,
				"validation_error",
				"A registered nodeId is required",
			);
		const r = await deps.svc.create(
			authOf(c).principal,
			{ template: "linux", size: "2gb", labels: { quickstart: "smoke" } },
			randomUUID(),
			{ placementNodeId: body.data.nodeId },
		);
		return c.json(
			{
				sandbox: await sandboxResource(deps, r.sandbox),
				operation: toOperationResource(r.operation),
			},
			202,
		);
	});
}
