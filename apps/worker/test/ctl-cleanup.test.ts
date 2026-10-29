import { randomBytes, randomUUID } from "node:crypto";
import { StaticConfigReader } from "@sbx/config";
import { DELETE_RETRY_LIMIT, KeyRing } from "@sbx/core";
import { createTestDatabase, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCleanup } from "../src/controllers/cleanup.ts";
import {
	createWorld,
	insertMachine,
	insertSandbox,
	insertSnapshot,
	type TestWorld,
} from "./fakes/world.ts";
import {
	activeOps,
	eventTypes,
	linkedSandbox,
	setRow,
} from "./helpers/controllers.ts";
import { row } from "./helpers/ops.ts";

let db: TestDatabase;

beforeAll(async () => {
	db = await createTestDatabase();
});

afterAll(async () => {
	await db?.drop();
});

async function count(
	w: TestWorld,
	sql: string,
	params: unknown[],
): Promise<number> {
	const r = await w.pool.query<{ n: number }>(
		`SELECT count(*)::int AS n FROM ${sql}`,
		params,
	);
	return r.rows[0]?.n ?? 0;
}

describe("ctl-cleanup (§15.4)", () => {
	it("expired idempotency keys, old processed events, old commands and sandbox events", async () => {
		const w = await createWorld(db);
		const principal = randomUUID();
		await w.pool.query(
			`INSERT INTO runtime.idempotency_keys (principal_id, key, scope, request_hash, expires_at)
			 VALUES ($1, 'old', 's', '\\x00', now() - interval '1 second'),
			        ($1, 'live', 's', '\\x00', now() + interval '1 hour')`,
			[principal],
		);
		const m = randomUUID();
		await w.pool.query(
			`INSERT INTO runtime.agent_events (machine_id, seq, boot_id, type, time, received_at, processed_at)
			 VALUES ($1, 1, 'b', 'x', now(), now() - interval '8 days', now() - interval '8 days'),
			        ($1, 2, 'b', 'x', now(), now() - interval '8 days', NULL),
			        ($1, 3, 'b', 'x', now(), now() - interval '6 days', now())`,
			[m],
		);
		await w.pool.query(
			`INSERT INTO runtime.agent_synthetic_events (machine_id, epoch, type, instance_id, time, received_at, processed_at)
			 VALUES ($1, 1, 'connected', 'gw', now(), now() - interval '8 days', now()),
			        ($1, 2, 'connected', 'gw', now(), now() - interval '1 day', now())`,
			[m],
		);
		const l = await linkedSandbox(w);
		await w.pool.query(
			`INSERT INTO runtime.commands (id, sandbox_id, machine_id, cmd, mode, status, created_at)
			 VALUES ($1, $3, $4, 'x', 'sync', 'exited', now() - interval '91 days'),
			        ($2, $3, $4, 'x', 'sync', 'exited', now() - interval '89 days')`,
			[`old${randomUUID()}`, `new${randomUUID()}`, l.sandboxId, l.machineId],
		);
		await w.pool.query(
			`INSERT INTO runtime.sandbox_events (sandbox_id, type, created_at)
			 VALUES ($1, 'old', now() - interval '91 days'), ($1, 'new', now() - interval '1 day')`,
			[l.sandboxId],
		);

		await runCleanup(w.ctx);

		const keys = await w.pool.query(
			"SELECT key FROM runtime.idempotency_keys WHERE principal_id = $1",
			[principal],
		);
		expect(keys.rows).toEqual([{ key: "live" }]);
		const evs = await w.pool.query(
			"SELECT seq FROM runtime.agent_events WHERE machine_id = $1 ORDER BY seq",
			[m],
		);
		expect(evs.rows.map((x) => Number(x.seq))).toEqual([2, 3]);
		const syn = await w.pool.query(
			"SELECT epoch FROM runtime.agent_synthetic_events WHERE machine_id = $1",
			[m],
		);
		expect(syn.rows.map((x) => Number(x.epoch))).toEqual([2]);
		const cmds = await w.pool.query(
			"SELECT id FROM runtime.commands WHERE sandbox_id = $1",
			[l.sandboxId],
		);
		expect(cmds.rows.map((x) => String(x.id).slice(0, 3))).toEqual(["new"]);
		expect((await eventTypes(w, l.sandboxId)).map((e) => e.type)).toEqual([
			"new",
		]);
	});

	it("a failing part is logged and counted; the other parts still run", async () => {
		const w = await createWorld(db);
		const principal = randomUUID();
		await w.pool.query(
			`INSERT INTO runtime.idempotency_keys (principal_id, key, scope, request_hash, expires_at)
			 VALUES ($1, 'old', 's', '\\x00', now() - interval '1 second')`,
			[principal],
		);
		const bare = await insertSandbox(w, { state: "error" });
		await setRow(
			w,
			"sandboxes",
			bare,
			"state_changed_at = now() - interval '8 days'",
		);
		const cfg = w.ctx.config;
		w.ctx.config = new Proxy(cfg, {
			get(t, p) {
				if (p === "defaults") {
					return async () => {
						throw new Error("config down");
					};
				}
				const v = Reflect.get(t, p);
				return typeof v === "function" ? v.bind(t) : v;
			},
		});
		// The fork_source part fails too: its query sees a broken job sender.
		const consumer = await insertSandbox(w, { state: "error" });
		const fs = await insertSnapshot(w, { state: "ready", kind: "fork_source" });
		await w.pool.query(
			"UPDATE runtime.snapshots SET consumer_sandbox_id = $2 WHERE id = $1",
			[fs.snapshotId, consumer],
		);
		const send = w.jobs.send.bind(w.jobs);
		w.jobs.send = async (tx, queue, data, opts) => {
			if (queue === "snapshot-op") throw new Error("boss down");
			return send(tx, queue, data, opts);
		};

		const res = await runCleanup(w.ctx);

		expect(res.idempotencyKeys).toBeGreaterThanOrEqual(1);
		expect(res.errorDeletes).toEqual([]);
		expect(res.failed).toEqual(
			expect.arrayContaining(["retention", "fork_sources"]),
		);
		expect((await row(w, "snapshots", fs.snapshotId)).state).toBe("ready");
		expect(
			w.metrics.calls
				.filter((c) => c.name === "sbx_cleanup_failed_total")
				.map((c) => c.labels.part),
		).toEqual(expect.arrayContaining(["retention", "fork_sources"]));
		expect(
			await count(w, "runtime.idempotency_keys WHERE principal_id = $1", [
				principal,
			]),
		).toBe(0);
		w.ctx.config = cfg;
		w.jobs.send = send;
	});

	it("tombstones older than 30 days go with their machines, disks, operations and events", async () => {
		const w = await createWorld(db);
		const mk = async (daysAgo: number) => {
			const id = await insertSandbox(w, { state: "deleted" });
			const m = await insertMachine(w, {
				state: "deleted",
				poolKey: null,
				sandboxId: id,
			});
			await w.pool.query(
				`UPDATE runtime.sandboxes SET machine_id = $2,
				   deleted_at = now() - make_interval(days => $3) WHERE id = $1`,
				[id, m, daysAgo],
			);
			await w.pool.query(
				`INSERT INTO runtime.disks (machine_id, storage_id, slot, volume, state)
				 VALUES ($1, $2, 'scsi0', 'local-lvm:vm-1-disk-0', 'deleted')`,
				[m, w.topo.storageId],
			);
			await w.pool.query(
				"INSERT INTO runtime.operations (sandbox_id, kind, state) VALUES ($1, 'delete', 'succeeded')",
				[id],
			);
			await w.pool.query(
				"INSERT INTO runtime.sandbox_events (sandbox_id, type) VALUES ($1, 'state_changed')",
				[id],
			);
			await w.pool.query(
				`INSERT INTO runtime.hosted_ports (sandbox_id, port, label, mode, deleted_at)
				 VALUES ($1, 8080, $2, 'public', now())`,
				[id, `x-${id}`],
			);
			return { id, m };
		};
		const old = await mk(31);
		const recent = await mk(10);
		// A consumed fork_source of the old tombstone, already deleted.
		const { snapshotId } = await insertSnapshot(w, {
			state: "deleted",
			kind: "fork_source",
		});
		await w.pool.query(
			"UPDATE runtime.snapshots SET consumer_sandbox_id = $2 WHERE id = $1",
			[snapshotId, old.id],
		);
		await w.pool.query(
			"UPDATE runtime.machines SET origin = 'snapshot', origin_snapshot_id = $2 WHERE id = $1",
			[old.m, snapshotId],
		);

		const res = await runCleanup(w.ctx);
		expect(res.tombstones).toBeGreaterThanOrEqual(1);

		for (const [table, col] of [
			["sandboxes", "id"],
			["operations", "sandbox_id"],
			["sandbox_events", "sandbox_id"],
			["hosted_ports", "sandbox_id"],
			["machines", "sandbox_id"],
		] as const) {
			expect(
				await count(w, `runtime.${table} WHERE ${col} = $1`, [old.id]),
			).toBe(0);
			expect(
				await count(w, `runtime.${table} WHERE ${col} = $1`, [recent.id]),
			).toBeGreaterThan(0);
		}
		expect(await count(w, "runtime.disks WHERE machine_id = $1", [old.m])).toBe(
			0,
		);
		expect(
			await count(w, "runtime.disks WHERE machine_id = $1", [recent.m]),
		).toBe(1);
		expect(
			await count(w, "runtime.snapshots WHERE id = $1", [snapshotId]),
		).toBe(0);
	});

	it("tombstones with a machine that is not deleted yet stay", async () => {
		const w = await createWorld(db);
		const id = await insertSandbox(w, { state: "deleted" });
		await insertMachine(w, { state: "deleting", poolKey: null, sandboxId: id });
		await setRow(w, "sandboxes", id, "deleted_at = now() - interval '40 days'");
		await runCleanup(w.ctx);
		expect(await count(w, "runtime.sandboxes WHERE id = $1", [id])).toBe(1);
	});

	it("fork_source backstop: consumer in error, older than 1 h; a fresh one in use stays", async () => {
		const w = await createWorld(db);
		const consumerErr = await insertSandbox(w, { state: "error" });
		const consumerLive = await insertSandbox(w, { state: "creating" });
		const a = await insertSnapshot(w, { state: "ready", kind: "fork_source" });
		const b = await insertSnapshot(w, { state: "ready", kind: "fork_source" });
		const c = await insertSnapshot(w, { state: "ready", kind: "fork_source" });
		const d = await insertSnapshot(w, {
			state: "deleted",
			kind: "fork_source",
		});
		await w.pool.query(
			"UPDATE runtime.snapshots SET consumer_sandbox_id = $2 WHERE id = $1",
			[a.snapshotId, consumerErr],
		);
		for (const s of [b, c, d]) {
			await w.pool.query(
				"UPDATE runtime.snapshots SET consumer_sandbox_id = $2 WHERE id = $1",
				[s.snapshotId, consumerLive],
			);
		}
		await setRow(
			w,
			"snapshots",
			b.snapshotId,
			"created_at = now() - interval '61 minutes'",
		);
		await setRow(
			w,
			"snapshots",
			d.snapshotId,
			"created_at = now() - interval '2 hours'",
		);
		w.jobs.clear();

		const res = await runCleanup(w.ctx);

		expect(res.forkSources).toEqual(
			expect.arrayContaining([a.snapshotId, b.snapshotId]),
		);
		expect(res.forkSources).not.toContain(c.snapshotId);
		expect((await row(w, "snapshots", a.snapshotId)).state).toBe("deleting");
		expect((await row(w, "snapshots", b.snapshotId)).state).toBe("deleting");
		expect((await row(w, "snapshots", c.snapshotId)).state).toBe("ready");
		expect((await row(w, "snapshots", d.snapshotId)).state).toBe("deleted");
		const jobs = w.jobs.sent.filter((j) => j.queue === "snapshot-op");
		expect(jobs).toEqual(
			expect.arrayContaining([
				{
					queue: "snapshot-op",
					data: { snapshotId: a.snapshotId, action: "delete" },
					opts: { singletonKey: a.snapshotId, retryLimit: DELETE_RETRY_LIMIT },
				},
			]),
		);
		expect(
			jobs.map((j) => (j.data as { snapshotId: string }).snapshotId),
		).not.toContain(c.snapshotId);
	});

	it("error sandboxes without machines or disks after errorRetentionDays: system delete", async () => {
		const w = await createWorld(db);
		const bare = await insertSandbox(w, { state: "error" });
		await setRow(
			w,
			"sandboxes",
			bare,
			"state_changed_at = now() - interval '8 days'",
		);
		const young = await insertSandbox(w, { state: "error" });
		await setRow(
			w,
			"sandboxes",
			young,
			"state_changed_at = now() - interval '6 days'",
		);
		const withMachine = await linkedSandbox(w, {
			state: "error",
			machineState: "stopped",
		});
		await setRow(
			w,
			"sandboxes",
			withMachine.sandboxId,
			"state_changed_at = now() - interval '8 days'",
		);
		const onlyDeleted = await insertSandbox(w, { state: "error" });
		await insertMachine(w, {
			state: "deleted",
			poolKey: null,
			sandboxId: onlyDeleted,
		});
		await setRow(
			w,
			"sandboxes",
			onlyDeleted,
			"state_changed_at = now() - interval '8 days'",
		);

		const res = await runCleanup(w.ctx);

		expect(res.errorDeletes).toEqual(
			expect.arrayContaining([bare, onlyDeleted]),
		);
		expect(res.errorDeletes).not.toContain(young);
		expect(res.errorDeletes).not.toContain(withMachine.sandboxId);
		const s = await row(w, "sandboxes", bare);
		expect(s.state).toBe("deleting");
		const ops = await activeOps(w, bare);
		expect(ops.map((o) => [o.kind, o.request])).toEqual([
			["delete", { reason: "error_retention" }],
		]);
		const op = await row(w, "operations", ops[0]?.id as string);
		expect(op.requested_by).toBeNull();
		expect((await eventTypes(w, bare)).at(-1)).toEqual({
			type: "state_changed",
			reason: "error_retention",
		});
		expect((await row(w, "sandboxes", young)).state).toBe("error");
	});

	it("stoppedRetentionDays: off by default; when set, stopped sandboxes are deleted with reason retention", async () => {
		const w = await createWorld(db);
		const l = await linkedSandbox(w, {
			state: "stopped",
			machineState: "stopped",
		});
		await setRow(
			w,
			"sandboxes",
			l.sandboxId,
			"stopped_at = now() - interval '4 days'",
		);
		const fresh = await linkedSandbox(w, {
			state: "stopped",
			machineState: "stopped",
		});
		await setRow(
			w,
			"sandboxes",
			fresh.sandboxId,
			"stopped_at = now() - interval '2 days'",
		);

		expect((await runCleanup(w.ctx)).retentionDeletes).toEqual([]);
		expect((await row(w, "sandboxes", l.sandboxId)).state).toBe("stopped");

		w.ctx.config = StaticConfigReader.fromObject({
			templates: [
				{
					slug: w.topo.templateSlug,
					os: "linux",
					enabled: true,
					defaultSize: "2gb",
					allowedSizes: ["2gb"],
				},
			],
			sizes: [{ slug: "2gb", vcpu: 2, memoryMb: 2048 }],
			defaults: {
				defaultTemplate: w.topo.templateSlug,
				stoppedRetentionDays: 3,
			},
		});
		const res = await runCleanup(w.ctx);
		expect(res.retentionDeletes).toContain(l.sandboxId);
		expect(res.retentionDeletes).not.toContain(fresh.sandboxId);
		expect((await row(w, "sandboxes", l.sandboxId)).state).toBe("deleting");
		expect((await eventTypes(w, l.sandboxId)).at(-1)).toEqual({
			type: "state_changed",
			reason: "retention",
		});
		expect((await row(w, "sandboxes", fresh.sandboxId)).state).toBe("stopped");
	});

	it("re-encrypts secrets of key version 1 with version 2", async () => {
		const w = await createWorld(db);
		const k1 = randomBytes(32).toString("base64");
		const k2 = randomBytes(32).toString("base64");
		const v1 = KeyRing.fromObject({ current: 1, keys: { "1": k1 } });
		const sets = {
			env: { A: "1" },
			secrets: { TOKEN: "s3cr3t" },
			secretFiles: [{ name: "f", contentBase64: "eA==" }],
		};
		const ids: string[] = [];
		for (let i = 0; i < 3; i++) {
			const id = await insertSandbox(w, {
				state: i === 0 ? "stopped" : "ready",
			});
			const blob = v1.encrypt(id, sets);
			await w.pool.query(
				`INSERT INTO runtime.sandbox_secrets (sandbox_id, key_version, nonce, ciphertext)
				 VALUES ($1, $2, $3, $4)`,
				[id, blob.keyVersion, blob.nonce, blob.ciphertext],
			);
			ids.push(id);
		}
		const v2 = KeyRing.fromObject({ current: 2, keys: { "1": k1, "2": k2 } });
		w.ctx.keys = v2;

		const res = await runCleanup(w.ctx);
		expect(res.reencrypted).toBe(3);
		const only2 = KeyRing.fromObject({ current: 2, keys: { "2": k2 } });
		for (const id of ids) {
			const r = await w.pool.query(
				"SELECT key_version, nonce, ciphertext FROM runtime.sandbox_secrets WHERE sandbox_id = $1",
				[id],
			);
			const x = r.rows[0];
			expect(x.key_version).toBe(2);
			expect(
				only2.decrypt(id, {
					keyVersion: 2,
					nonce: x.nonce,
					ciphertext: x.ciphertext,
				}),
			).toEqual(sets);
		}
		expect(
			w.metrics.calls
				.filter((c) => c.name === "sbx_secrets_old_key_rows")
				.at(-1)?.value,
		).toBe(0);
		// Nothing left: a second run re-encrypts nothing.
		expect((await runCleanup(w.ctx)).reencrypted).toBe(0);
		// No secret in the logs.
		expect(w.logs.join("\n")).not.toContain("s3cr3t");
	});
});
