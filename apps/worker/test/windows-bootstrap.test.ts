import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StaticConfigReader } from "@umiak/config";
import { MIGRATIONS_DIR, migrate } from "@umiak/db";
import { createTestDatabase, type TestDatabase } from "@umiak/db/testing";
import {
	closeUmiakPayload,
	getUmiakPayload,
	migrateUmiakPayload,
} from "@umiak/payload";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type AdminDeps, runAdmin } from "../src/admin/commands.ts";
import { testLogger } from "./helpers/worker.ts";

let db: TestDatabase;
let legacyDir: string;
beforeAll(async () => {
	db = await createTestDatabase({ migrated: false });
	legacyDir = await mkdtemp(join(tmpdir(), "umiak-pre-headless-"));
	for (const name of await readdir(MIGRATIONS_DIR)) {
		if (name.endsWith(".sql") && name !== "0501_template_build_headless.sql")
			await writeFile(
				join(legacyDir, name),
				await readFile(join(MIGRATIONS_DIR, name)),
			);
	}
	await migrate(db.pool, { dir: legacyDir });
});
afterAll(async () => {
	if (db) await closeUmiakPayload(db.url);
	await db?.drop();
	if (legacyDir) await rm(legacyDir, { recursive: true });
});

function config(legacy: boolean) {
	return StaticConfigReader.fromObject({
		templates: [
			{
				slug: "windows",
				os: "windows",
				defaultSize: "4gb",
				allowedSizes: ["4gb"],
			},
		],
		sizes: [{ slug: "4gb", vcpu: 4, memoryMb: 4096 }],
		topology: {
			providers: [
				{
					name: "pve",
					clusterMacId: 1,
					vmidMin: 500,
					vmidMax: 589,
					apiUrl: "https://pve:8006",
					secretRef: "pve",
					nodes: [
						{
							name: "pve",
							ramCapMb: 8192,
							nodeAgentRef: "node",
							storages: [{ name: "local-lvm" }],
						},
					],
				},
			],
			templateBuilds: [
				...(legacy
					? [
							{
								templateSlug: "windows",
								version: "headless",
								os: "windows",
								node: "pve",
								storage: "local-lvm",
								pveVmid: 598,
								bootTimeoutS: 1200,
								diskLayout: {},
								hw: {},
							},
						]
					: []),
				{
					templateSlug: legacy ? "windows-desktop" : "windows",
					version: "20261101.7",
					os: "windows",
					node: "pve",
					storage: "local-lvm",
					pveVmid: 595,
					bootTimeoutS: 1200,
					diskLayout: {},
					hw: {},
				},
			],
		},
	});
}

it("bootstraps the canonical YAML before Payload migration without duplicating the legacy desktop build", async () => {
	const deps: AdminDeps = {
		pool: db.pool,
		config: () => config(true),
		out: () => {},
		err: (o) => {
			throw new Error(JSON.stringify(o));
		},
		log: testLogger("warn").log,
	};
	expect(await runAdmin(["bootstrap"], deps)).toBe(0);
	const old = (
		await db.pool.query("SELECT id, template_slug FROM runtime.template_builds")
	).rows;
	const desktop = old.find((b) => b.template_slug === "windows-desktop").id;
	const headless = old.find((b) => b.template_slug === "windows").id;
	const snapshot = randomUUID();
	await db.pool.query(
		`INSERT INTO runtime.snapshots (id, kind, team_id, name, provider_id, node_id, storage_id, template_build_id, lv_id, state)
 SELECT $1, 'saved', $2, 'desktop-saved', provider_id, node_id, storage_id, id, replace($1::uuid::text, '-', ''), 'ready' FROM runtime.template_builds WHERE id=$3`,
		[snapshot, randomUUID(), desktop],
	);
	// Apply the actual column upgrade to pre-existing headless/desktop rows.
	await migrate(db.pool);
	deps.config = () => config(false);
	expect(await runAdmin(["bootstrap"], deps)).toBe(0);
	expect(
		(
			await db.pool.query(
				"SELECT count(*)::int AS n FROM runtime.template_builds",
			)
		).rows[0].n,
	).toBe(2);
	const payload = await getUmiakPayload({
		databaseUrl: db.url,
		secret: "s17-bootstrap-test-secret-0123456789",
		operatorGroups: [],
		poolMax: 4,
	});
	await migrateUmiakPayload(payload);
	expect(
		(
			await db.pool.query(
				"SELECT id, template_slug, status FROM runtime.template_builds ORDER BY pve_vmid",
			)
		).rows,
	).toEqual([
		{ id: desktop, template_slug: "windows", status: "active" },
		{ id: headless, template_slug: "windows", status: "retired" },
	]);
	expect(
		(
			await db.pool.query(
				"SELECT template_build_id FROM runtime.snapshots WHERE id=$1",
				[snapshot],
			)
		).rows[0].template_build_id,
	).toBe(desktop);
	expect(await runAdmin(["bootstrap"], deps)).toBe(0);
	expect(await migrateUmiakPayload(payload)).toEqual([]);
	expect(
		(
			await db.pool.query(
				"SELECT count(*)::int AS n FROM runtime.template_builds",
			)
		).rows[0].n,
	).toBe(2);
});
