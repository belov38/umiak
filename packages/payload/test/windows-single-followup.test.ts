import { randomUUID } from "node:crypto";
import {
	createTestDatabase,
	skipPg,
	type TestDatabase,
} from "@umiak/db/testing";
import type { Payload } from "payload";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUmiakPayload } from "../src/index.ts";
import { closePayload, openPayload } from "./helpers.ts";

describe.skipIf(skipPg())(
	"Windows consolidation preserves build identity and operator policy",
	() => {
		let t: TestDatabase, payload: Payload;
		const provider = randomUUID(),
			node = randomUUID(),
			storage = randomUUID();
		beforeAll(async () => {
			t = await createTestDatabase();
			payload = await openPayload(t.url);
			await migrateUmiakPayload(payload);
			await t.pool.query(
				"INSERT INTO runtime.providers(id,kind,name,cluster_mac_id,vmid_min,vmid_max,api_url,secret_ref) VALUES($1,'proxmox','followup',244,500,589,'https://pve:8006','test')",
				[provider],
			);
			await t.pool.query(
				"INSERT INTO runtime.nodes(id,provider_id,name,ram_cap_mb,node_agent_ref) VALUES($1,$2,'pve',8192,'test')",
				[node, provider],
			);
			await t.pool.query(
				"INSERT INTO runtime.storages(id,provider_id,node_id,name,driver) VALUES($1,$2,$3,'local-lvm','lvmthin')",
				[storage, provider, node],
			);
		});
		afterAll(async () => {
			if (t) await closePayload(t.url);
			await t?.drop();
		});
		beforeEach(async () => {
			await t.pool.query("DELETE FROM runtime.template_builds");
			await t.pool.query(
				"DELETE FROM payload.templates WHERE slug IN ('windows','windows-desktop')",
			);
			await t.pool.query(
				`INSERT INTO payload.templates(id,slug,name,os,enabled,default_size,allowed_sizes,login_user,capabilities,sort_order) VALUES(uuidv7(),'windows','Windows 11','windows',true,'4gb','["4gb"]','user','["exec"]',1),(uuidv7(),'windows-desktop','Windows 11 Desktop','windows',true,'4gb','["4gb","8gb"]','user','["exec","desktop"]',2)`,
			);
		});
		const build = async (
			slug: string,
			slot: number,
			version: string,
			headless: boolean | null = null,
			status = "active",
		) => {
			const id = randomUUID();
			await t.pool.query(
				"INSERT INTO runtime.template_builds(id,template_slug,version,os,provider_id,node_id,storage_id,pve_vmid,disk_layout,hw,boot_timeout_s,status,headless) VALUES($1,$2,$3,'windows',$4,$5,$6,$7,'{}','{}',1200,$8,$9)",
				[id, slug, version, provider, node, storage, slot, status, headless],
			);
			return id;
		};
		const replay = async () => {
			await t.pool.query(
				"DELETE FROM payload.payload_migrations WHERE name='20261103_000000_windows_single'",
			);
			await migrateUmiakPayload(payload);
		};
		it("retires pre-S17 headless builds on custom slots and snapshots desktop capability", async () => {
			const old = await build("windows", 600, "old-headless");
			const desktop = await build("windows-desktop", 601, "custom-desktop");
			await replay();
			await replay();
			const rows = (
				await t.pool.query(
					"SELECT id,headless,status FROM runtime.template_builds ORDER BY pve_vmid",
				)
			).rows;
			expect(rows).toEqual([
				{ id: old, headless: true, status: "retired" },
				{ id: desktop, headless: false, status: "active" },
			]);
		});
		it("does not classify a new desktop on slot 598 as headless", async () => {
			const id = await build("windows", 598, "new-desktop", false);
			await replay();
			expect(
				(
					await t.pool.query(
						"SELECT headless,status FROM runtime.template_builds WHERE id=$1",
						[id],
					)
				).rows[0],
			).toEqual({ headless: false, status: "active" });
		});
		it.each([
			[false, true],
			[true, false],
			[false, false],
		])("combines enabled policy %s / %s", async (headless, desktop) => {
			await t.pool.query(
				"UPDATE payload.templates SET enabled=CASE WHEN slug='windows' THEN $1::boolean ELSE $2::boolean END WHERE slug IN ('windows','windows-desktop')",
				[headless, desktop],
			);
			await replay();
			expect(
				(
					await t.pool.query(
						"SELECT enabled FROM payload.templates WHERE slug='windows'",
					)
				).rows[0].enabled,
			).toBe(headless || desktop);
		});
		it("preserves operator name and merges size policies with desktop default", async () => {
			await t.pool.query(
				`UPDATE payload.templates SET name='Operator Windows',default_size='16gb',allowed_sizes='["16gb"]' WHERE slug='windows'`,
			);
			await t.pool.query(
				`UPDATE payload.templates SET name='Operator Desktop',default_size='8gb',allowed_sizes='["8gb","12gb"]' WHERE slug='windows-desktop'`,
			);
			await replay();
			await replay();
			const row = (
				await t.pool.query(
					"SELECT name,default_size,allowed_sizes FROM payload.templates WHERE slug='windows'",
				)
			).rows[0];
			expect(row.name).toBe("Operator Windows");
			expect(row.default_size).toBe("8gb");
			expect([...row.allowed_sizes].sort()).toEqual(["12gb", "16gb", "8gb"]);
		});
		it("uses the desktop operator name when the canonical name is still seeded", async () => {
			await t.pool.query(
				"UPDATE payload.templates SET name='My Windows desktop' WHERE slug='windows-desktop'",
			);
			await replay();
			expect(
				(
					await t.pool.query(
						"SELECT name FROM payload.templates WHERE slug='windows'",
					)
				).rows[0].name,
			).toBe("My Windows desktop");
		});
		it("falls back to 4gb/8gb only when size settings are unset", async () => {
			await t.pool.query(
				"UPDATE payload.templates SET default_size='',allowed_sizes='[]' WHERE slug IN ('windows','windows-desktop')",
			);
			await replay();
			expect(
				(
					await t.pool.query(
						"SELECT default_size,allowed_sizes FROM payload.templates WHERE slug='windows'",
					)
				).rows[0],
			).toEqual({ default_size: "4gb", allowed_sizes: ["4gb", "8gb"] });
		});
		it("keeps a newer active build rather than reactivating the old 595 image", async () => {
			const old = await build(
				"windows-desktop",
				595,
				"20261101.7",
				null,
				"deprecated",
			);
			const newer = await build("windows", 595, "20261103.1", false);
			await replay();
			expect(
				(
					await t.pool.query(
						"SELECT id FROM runtime.template_builds WHERE status='active'",
					)
				).rows,
			).toEqual([{ id: newer }]);
			expect(
				(
					await t.pool.query(
						"SELECT status FROM runtime.template_builds WHERE id=$1",
						[old],
					)
				).rows[0].status,
			).toBe("deprecated");
		});
	},
);
