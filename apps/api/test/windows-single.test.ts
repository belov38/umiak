import { decodeUuid } from "@umiak/auth";
import { insertSavedSnapshot, insertTemplateBuild } from "@umiak/core/testing";
import {
	createTestDatabase,
	skipPg,
	type TestDatabase,
} from "@umiak/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiDeps } from "../src/deps.ts";
import { lookupDesktopRoute } from "../src/desktop/service.ts";
import { type ApiWorld, apiWorld } from "./helpers/world.ts";

describe.skipIf(skipPg())("single Windows template compatibility", () => {
	let db: TestDatabase;
	let w: ApiWorld;
	beforeAll(async () => {
		db = await createTestDatabase();
		w = await apiWorld(db.pool, {
			templateSlug: "windows",
			capabilities: ["exec", "files", "ssh", "desktop"],
			os: "windows",
			topology: { node: { ramCapMb: 100000 } },
		});
	});
	afterAll(async () => {
		await w?.close();
		await db?.drop();
	});
	it("creates using the alias, returns canonical identity and filters by either slug", async () => {
		const h = w.harness();
		const created = await h.request("POST", "/v1/sandboxes", {
			json: { template: "windows-desktop" },
		});
		expect(created.status).toBe(202);
		expect(created.body).toMatchObject({ sandbox: { template: "windows" } });
		for (const slug of ["windows", "windows-desktop"]) {
			const listed = await h.request("GET", `/v1/sandboxes?template=${slug}`);
			expect(listed.status).toBe(200);
			expect(listed.body).toMatchObject({ data: [{ template: "windows" }] });
		}
	});
	it("retired headless builds retain snapshot create, resume, fork and deletion", async () => {
		const retired = await insertTemplateBuild(db.pool, w.env.topo, {
			templateSlug: "windows",
			os: "windows",
			status: "retired",
			version: "headless-598",
		});
		const topo = { ...w.env.topo, templateBuildId: retired };
		await db.pool.query(
			"UPDATE runtime.template_builds SET pve_vmid = 598 WHERE id = $1",
			[retired],
		);
		const snapshot = await insertSavedSnapshot(db.pool, topo, {
			teamId: w.teamId,
			name: "old-headless",
		});
		const h = w.harness();
		const created = await h.request("POST", "/v1/sandboxes", {
			json: { from: { snapshot: "old-headless" } },
		});
		expect(created.status).toBe(202);
		const body = created.body as {
			sandbox: { id: string; template: string; templateVersion: string };
		};
		expect(body.sandbox).toMatchObject({
			template: "windows",
			templateVersion: "headless-598",
		});
		const id = decodeUuid("sandbox", body.sandbox.id) as string;
		expect(
			(
				await db.pool.query(
					"SELECT template_build_id FROM runtime.sandboxes WHERE id = $1",
					[id],
				)
			).rows[0].template_build_id,
		).toBe(retired);
		expect(
			(body.sandbox as { endpoints?: { desktop?: string } }).endpoints?.desktop,
		).toBeUndefined();
		const unsupported = await h.request(
			"POST",
			`/v1/sandboxes/${body.sandbox.id}/desktop/links`,
			{ json: {} },
		);
		expect(unsupported.status).toBe(422);
		const source = await w.env.svc.get(w.env.p, id);
		expect(
			await lookupDesktopRoute(w.deps() as ApiDeps, `${source.slug}-desktop`),
		).toBeNull();
		await w.markReady(id);
		await w.markState(id, "stopped");
		await db.pool.query(
			"UPDATE runtime.machines SET state = 'stopped', power_observed = 'stopped' WHERE sandbox_id = $1",
			[id],
		);
		const resumed = await w.env.svc.resume(w.env.p, id);
		expect(resumed.kind).toBe("resume");
		await w.markReady(id);
		await w.markState(id, "stopped");
		await db.pool.query(
			"UPDATE runtime.machines SET state = 'stopped', power_observed = 'stopped' WHERE sandbox_id = $1",
			[id],
		);
		const forked = await w.env.svc.fork(w.env.p, id, {});
		expect(forked.sandbox.templateBuildId).toBe(retired);
		await w.markReady(forked.sandbox.id);
		expect((await w.env.svc.delete(w.env.p, forked.sandbox.id)).kind).toBe(
			"delete",
		);
		await w.markReady(id);
		expect((await w.env.svc.delete(w.env.p, id)).kind).toBe("delete");
		await w.env.svc.deleteSavedSnapshot(w.env.p, "old-headless");
		expect(
			(
				await db.pool.query(
					"SELECT state FROM runtime.snapshots WHERE id = $1",
					[snapshot],
				)
			).rows[0].state,
		).toBe("deleting");
	});
});
