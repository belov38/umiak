import { StaticConfigReader } from "@umiak/config";
import { createTopology, SIZES } from "@umiak/core/testing";
import { createTestDatabase, type TestDatabase } from "@umiak/db/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type ApiWorld, apiWorld } from "./helpers/world.ts";

let db: TestDatabase;
let w: ApiWorld;
beforeAll(async () => {
	db = await createTestDatabase();
	w = await apiWorld(db.pool, { templateSlug: "linux" });
});
afterAll(async () => {
	await w?.close();
	await db?.drop();
});
it("operator-only proxied smoke creates on the chosen node, without exposing a public selector", async () => {
	const target = await createTopology(db.pool, {
		build: { templateSlug: "linux" },
	});
	const config = StaticConfigReader.fromObject({
		templates: [
			{ slug: "linux", os: "linux", defaultSize: "2gb", allowedSizes: ["2gb"] },
		],
		sizes: SIZES,
	});
	const op = w.session({ isOperator: true, deps: { config } });
	const req = {
		method: "POST",
		headers: { ...op.headers, "content-type": "application/json" },
		body: JSON.stringify({ nodeId: target.nodeId }),
	};
	const response = await op.h.app.request("/v1/setup/smoke", req);
	expect(response.status, await response.clone().text()).toBe(202);
	const rows = await db.pool.query(
		"SELECT node_id FROM runtime.sandboxes WHERE node_id=$1",
		[target.nodeId],
	);
	expect(rows.rowCount).toBe(1);
	const member = w.session();
	expect(
		(
			await member.h.app.request("/v1/setup/smoke", {
				...req,
				headers: { ...member.headers, "content-type": "application/json" },
			})
		).status,
	).toBe(403);
	expect(
		(
			await w.harness().app.request("/v1/setup/smoke", {
				...req,
				headers: { ...req.headers, authorization: `Bearer ${w.secret}` },
			})
		).status,
	).toBe(404);
});
