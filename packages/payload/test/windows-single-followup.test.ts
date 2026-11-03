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
	},
);
