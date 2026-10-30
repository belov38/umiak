import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createTestDatabase,
	skipPg,
	type TestDatabase,
} from "../src/testing/index.ts";

interface Note {
	channel: string;
	payload: string;
}

class Listener {
	readonly notes: Note[] = [];
	private client: pg.Client;

	constructor(url: string) {
		this.client = new pg.Client({ connectionString: url });
		this.client.on("notification", (n) => {
			this.notes.push({ channel: n.channel, payload: n.payload ?? "" });
		});
	}

	async start(channels: string[]): Promise<void> {
		await this.client.connect();
		for (const c of channels) await this.client.query(`LISTEN ${c}`);
	}

	/** Waits until at least n notifications arrived and returns them all. */
	async waitFor(n: number, timeoutMs = 3000): Promise<Note[]> {
		const deadline = Date.now() + timeoutMs;
		while (this.notes.length < n) {
			if (Date.now() > deadline) {
				throw new Error(
					`expected ${n} notifications, got ${JSON.stringify(this.notes)}`,
				);
			}
			await new Promise((r) => setTimeout(r, 10));
		}
		return [...this.notes];
	}

	/**
	 * Drops everything received so far. Notifications arrive in commit order, so
	 * once a sentinel sent now is seen, nothing older can still be in flight.
	 */
	async reset(pool: pg.Pool): Promise<void> {
		const sentinel = `sentinel-${Math.random()}`;
		await pool.query("SELECT pg_notify('sbx_routes', $1)", [sentinel]);
		const deadline = Date.now() + 3000;
		while (!this.notes.some((n) => n.payload === sentinel)) {
			if (Date.now() > deadline) throw new Error("sentinel not received");
			await new Promise((r) => setTimeout(r, 5));
		}
		this.notes.length = 0;
	}

	async stop(): Promise<void> {
		await this.client.end();
	}
}

describe.skipIf(skipPg())("runtime triggers", () => {
	let db: TestDatabase;
	let listener: Listener;
	const ids = {
		provider: randomUUID(),
		node: randomUUID(),
		storage: randomUUID(),
		build: randomUUID(),
	};

	async function q(sql: string, params: unknown[] = []) {
		return db.pool.query(sql, params);
	}

	async function insertMachine(sandboxId: string | null): Promise<string> {
		const id = randomUUID();
		await q(
			`INSERT INTO runtime.machines
			   (id, provider_id, node_id, storage_id, template_build_id, origin,
			    size_slug, vcpu, memory_mb, sandbox_id, state)
			 VALUES ($1, $2, $3, $4, $5, 'template', 'small', 2, 2048, $6, 'allocating')`,
			[id, ids.provider, ids.node, ids.storage, ids.build, sandboxId],
		);
		return id;
	}

	async function insertSandbox(slug: string): Promise<string> {
		const id = randomUUID();
		await q(
			`INSERT INTO runtime.sandboxes
			   (id, slug, team_id, template_slug, size_slug, vcpu, memory_mb,
			    template_build_id, origin, state)
			 VALUES ($1, $2, $3, 'ubuntu', 'small', 2, 2048, $4, 'template', 'creating')`,
			[id, slug, randomUUID(), ids.build],
		);
		return id;
	}

	beforeAll(async () => {
		db = await createTestDatabase();
		await q(
			`INSERT INTO runtime.providers (id, kind, name, cluster_mac_id, vmid_min, vmid_max, api_url, secret_ref)
			 VALUES ($1, 'proxmox', 'pve1', 1, 500, 598, 'https://pve:8006', 'pve1')`,
			[ids.provider],
		);
		await q(
			`INSERT INTO runtime.nodes (id, provider_id, name, ram_cap_mb, node_agent_ref)
			 VALUES ($1, $2, 'pve', 8192, 'pve')`,
			[ids.node, ids.provider],
		);
		await q(
			`INSERT INTO runtime.storages (id, provider_id, node_id, name, driver)
			 VALUES ($1, $2, $3, 'local-lvm', 'lvmthin')`,
			[ids.storage, ids.provider, ids.node],
		);
		await q(
			`INSERT INTO runtime.template_builds
			   (id, template_slug, version, os, provider_id, node_id, storage_id,
			    pve_vmid, disk_layout, hw, boot_timeout_s, status)
			 VALUES ($1, 'ubuntu', '1', 'linux', $2, $3, $4, 599, '[]', '{}', 300, 'active')`,
			[ids.build, ids.provider, ids.node, ids.storage],
		);
		listener = new Listener(db.url);
		await listener.start(["sbx_routes", "sbx_sandboxes", "sbx_operations"]);
	});

	afterAll(async () => {
		await listener?.stop();
		await db?.drop();
	});

	describe("machines.sandbox_id", () => {
		it("may be set once from null", async () => {
			const m = await insertMachine(null);
			const sb = randomUUID();
			await q("UPDATE runtime.machines SET sandbox_id = $2 WHERE id = $1", [
				m,
				sb,
			]);
			const r = await q(
				"SELECT sandbox_id FROM runtime.machines WHERE id = $1",
				[m],
			);
			expect(r.rows[0].sandbox_id).toBe(sb);
		});

		it("rejects a change once set", async () => {
			const m = await insertMachine(randomUUID());
			await expect(
				q("UPDATE runtime.machines SET sandbox_id = $2 WHERE id = $1", [
					m,
					randomUUID(),
				]),
			).rejects.toThrow(/sandbox_id/);
			await expect(
				q("UPDATE runtime.machines SET sandbox_id = NULL WHERE id = $1", [m]),
			).rejects.toThrow(/sandbox_id/);
		});

		it("allows other updates and a same-value write", async () => {
			const sb = randomUUID();
			const m = await insertMachine(sb);
			await q(
				"UPDATE runtime.machines SET state = 'provisioning', sandbox_id = $2 WHERE id = $1",
				[m, sb],
			);
		});
	});

	describe("NOTIFY sbx_routes", () => {
		it("sends the old and the new slug on rename", async () => {
			const id = await insertSandbox("quiet-otter-lamp");
			await listener.reset(db.pool);
			await q(
				"UPDATE runtime.sandboxes SET slug = 'brave-fox-cup' WHERE id = $1",
				[id],
			);
			const notes = (await listener.waitFor(2)).filter(
				(n) => n.channel === "sbx_routes",
			);
			expect(notes.map((n) => n.payload)).toEqual([
				"quiet-otter-lamp",
				"brave-fox-cup",
			]);
		});

		it("sends the slug on state and machine_id changes", async () => {
			const id = await insertSandbox("calm-river-stone");
			await listener.reset(db.pool);
			await q("UPDATE runtime.sandboxes SET machine_id = $2 WHERE id = $1", [
				id,
				randomUUID(),
			]);
			await q("UPDATE runtime.sandboxes SET state = 'ready' WHERE id = $1", [
				id,
			]);
			const notes = await listener.waitFor(3);
			expect(notes.filter((n) => n.channel === "sbx_routes")).toEqual([
				{ channel: "sbx_routes", payload: "calm-river-stone" },
				{ channel: "sbx_routes", payload: "calm-river-stone" },
			]);
		});

		it("sends the slug on any hosted_ports change", async () => {
			const id = await insertSandbox("green-hill-path");
			await listener.reset(db.pool);
			const port = randomUUID();
			await q(
				`INSERT INTO runtime.hosted_ports (id, sandbox_id, port, label, mode)
				 VALUES ($1, $2, 8080, 'green-hill-path-8080', 'public')`,
				[port, id],
			);
			await q(
				"UPDATE runtime.hosted_ports SET mode = 'token', token_hash = '\\x00', auth_epoch = auth_epoch + 1 WHERE id = $1",
				[port],
			);
			await q("DELETE FROM runtime.hosted_ports WHERE id = $1", [port]);
			const notes = await listener.waitFor(3);
			expect(notes).toEqual([
				{ channel: "sbx_routes", payload: "green-hill-path" },
				{ channel: "sbx_routes", payload: "green-hill-path" },
				{ channel: "sbx_routes", payload: "green-hill-path" },
			]);
		});
	});

	describe("NOTIFY sbx_sandboxes", () => {
		it("sends the id on state and health changes, not on other updates", async () => {
			const id = await insertSandbox("tall-pine-wood");
			await listener.reset(db.pool);
			await q(
				`UPDATE runtime.sandboxes SET labels = '{"a":"b"}', last_api_call_at = now() WHERE id = $1`,
				[id],
			);
			await q(
				"UPDATE runtime.sandboxes SET health = 'degraded' WHERE id = $1",
				[id],
			);
			await q("UPDATE runtime.sandboxes SET state = 'ready' WHERE id = $1", [
				id,
			]);
			const notes = await listener.waitFor(3);
			expect(notes.filter((n) => n.channel === "sbx_sandboxes")).toEqual([
				{ channel: "sbx_sandboxes", payload: id },
				{ channel: "sbx_sandboxes", payload: id },
			]);
			// The labels update produced nothing at all.
			expect(notes).toHaveLength(3);
		});
	});

	describe("NOTIFY sbx_operations", () => {
		it("sends the id on a terminal transition only", async () => {
			const sb = await insertSandbox("wide-lake-shore");
			const active = randomUUID();
			await q(
				`INSERT INTO runtime.operations (id, sandbox_id, kind, state)
				 VALUES ($1, $2, 'create', 'pending')`,
				[active, sb],
			);
			await listener.reset(db.pool);
			await q("UPDATE runtime.operations SET state = 'running' WHERE id = $1", [
				active,
			]);
			await q(
				"UPDATE runtime.operations SET state = 'succeeded' WHERE id = $1",
				[active],
			);
			const notes = await listener.waitFor(1);
			expect(notes).toEqual([{ channel: "sbx_operations", payload: active }]);

			for (const [i, state] of (["failed", "superseded"] as const).entries()) {
				const op = randomUUID();
				await q(
					`INSERT INTO runtime.operations (id, sandbox_id, kind, state)
					 VALUES ($1, $2, 'stop', 'running')`,
					[op, sb],
				);
				await q("UPDATE runtime.operations SET state = $2 WHERE id = $1", [
					op,
					state,
				]);
				const all = await listener.waitFor(2 + i);
				expect(all.at(-1)).toEqual({ channel: "sbx_operations", payload: op });
			}
		});
	});

	describe("constraints", () => {
		it("allows one active operation per sandbox", async () => {
			const sb = randomUUID();
			await q(
				"INSERT INTO runtime.operations (sandbox_id, kind, state) VALUES ($1, 'stop', 'pending')",
				[sb],
			);
			await expect(
				q(
					"INSERT INTO runtime.operations (sandbox_id, kind, state) VALUES ($1, 'delete', 'running')",
					[sb],
				),
			).rejects.toThrow(/unique|duplicate/);
		});

		it("rejects unknown enum values", async () => {
			await expect(insertSandbox("x")).rejects.toThrow(/check/);
			await expect(
				q(
					"INSERT INTO runtime.operations (sandbox_id, kind, state) VALUES ($1, 'bogus', 'pending')",
					[randomUUID()],
				),
			).rejects.toThrow(/check/);
		});

		it("generates uuidv7 ids by default", async () => {
			const r = await q(
				"INSERT INTO runtime.sandbox_events (sandbox_id, type) VALUES ($1, 'state_changed') RETURNING id",
				[randomUUID()],
			);
			expect(r.rows[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
		});
	});

	it("sets sandboxes.updated_at on every update (0205)", async () => {
		const id = await insertSandbox(`touch-${randomUUID().slice(0, 8)}`);
		// The trigger overrides any value an UPDATE sets.
		await q(
			"UPDATE runtime.sandboxes SET name = 'n', updated_at = '2000-01-01Z' WHERE id = $1",
			[id],
		);
		const r = await q(
			"SELECT updated_at > now() - interval '1 minute' AS fresh FROM runtime.sandboxes WHERE id = $1",
			[id],
		);
		expect(r.rows[0].fresh).toBe(true);
	});
});
