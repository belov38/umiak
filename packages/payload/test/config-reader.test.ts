import { randomUUID } from "node:crypto";
import {
	type ConfigFixture,
	makeConfigFixture,
	runConfigReaderContract,
} from "@sbx/config/testing";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import type { Payload } from "payload";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql, tbl } from "../src/identity/db.ts";
import {
	getSbxPayload,
	migrateSbxPayload,
	PayloadConfigReader,
} from "../src/index.ts";
import { closePayload, testOptions } from "./helpers.ts";

const LISTENER_APP = "sbx-config-listener";

/** Empties the config collections (the initial migration seeds linux/2gb). */
async function resetConfig(payload: Payload): Promise<void> {
	for (const collection of ["pool-targets", "templates", "sizes"] as const) {
		await payload.delete({
			collection,
			where: { id: { exists: true } },
			overrideAccess: true,
		});
	}
}

async function setDefaults(
	payload: Payload,
	fx: ConfigFixture["defaults"],
	defaultQuota: ConfigFixture["defaultQuota"],
): Promise<void> {
	const { ssoPolicyEpoch, ...rest } = fx;
	await payload.updateGlobal({
		slug: "platform-defaults",
		data: { ...rest, defaultQuota },
		overrideAccess: true,
	});
	// The epoch belongs to a hook; the fixture needs a given value.
	const adapter = payload.db as unknown as {
		drizzle: { execute(q: unknown): Promise<unknown> };
	};
	await adapter.drizzle.execute(
		sql`UPDATE ${tbl(payload, "platform_defaults")} SET sso_policy_epoch = ${ssoPolicyEpoch}`,
	);
}

/**
 * Loads the fixture. Rows are created in reverse order with growing
 * `sortOrder`, so insertion order and configuration order differ.
 */
async function loadFixture(payload: Payload, fx: ConfigFixture) {
	await resetConfig(payload);
	for (const [i, s] of [...fx.sizes.entries()].reverse()) {
		await payload.create({
			collection: "sizes",
			data: { ...s, sortOrder: i * 10 },
			overrideAccess: true,
		});
	}
	for (const [i, t] of [...fx.templates.entries()].reverse()) {
		await payload.create({
			collection: "templates",
			data: { ...t, sortOrder: i * 10 },
			overrideAccess: true,
		});
	}
	for (const p of fx.pools) {
		await payload.create({
			collection: "pool-targets",
			data: {
				template: p.templateSlug,
				size: p.sizeSlug,
				target: p.target,
				...(p.providerId === undefined ? {} : { providerId: p.providerId }),
				...(p.maxAgeHours === undefined ? {} : { maxAgeHours: p.maxAgeHours }),
			},
			overrideAccess: true,
		});
	}
	await setDefaults(payload, fx.defaults, fx.defaultQuota);
	// A team with a given id (the Local API cannot create with one).
	const q = fx.team.quota;
	const adapter = payload.db as unknown as {
		drizzle: { execute(q: unknown): Promise<unknown> };
	};
	await adapter.drizzle.execute(
		sql`INSERT INTO ${tbl(payload, "teams")}
		      (id, name, personal, quota_max_active_sandboxes, quota_max_ram_mb, quota_max_saved_snapshots)
		    VALUES (${fx.team.id}, 'fixture', false, ${q.maxActiveSandboxes ?? null},
		            ${q.maxRamMb ?? null}, ${q.maxSavedSnapshots ?? null})`,
	);
}

async function eventually<T>(
	fn: () => Promise<T>,
	ok: (v: T) => boolean,
	timeoutMs: number,
): Promise<T> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const v = await fn();
		if (ok(v) || Date.now() > end) return v;
		await new Promise((r) => setTimeout(r, 20));
	}
}

describe.skipIf(skipPg())("PayloadConfigReader", () => {
	let t: TestDatabase;
	let payload: Payload;
	let admin: pg.Client;
	const readers: PayloadConfigReader[] = [];

	function open(
		o: { ttlMs?: number; listen?: boolean; reconnectDelayMs?: number } = {},
	) {
		const r = new PayloadConfigReader({
			payload,
			...(o.ttlMs === undefined ? {} : { ttlMs: o.ttlMs }),
			...(o.listen
				? {
						listen: {
							databaseUrl: t.url,
							...(o.reconnectDelayMs === undefined
								? {}
								: { reconnectDelayMs: o.reconnectDelayMs }),
						},
					}
				: {}),
		});
		readers.push(r);
		return r;
	}

	async function listenerPids(): Promise<number[]> {
		const r = await admin.query<{ pid: number }>(
			"SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND datname = current_database() ORDER BY pid",
			[LISTENER_APP],
		);
		return r.rows.map((x) => x.pid);
	}

	beforeAll(async () => {
		t = await createTestDatabase({ migrated: false, max: 2 });
		payload = await getSbxPayload({ ...testOptions(t.url), poolMax: 12 });
		await migrateSbxPayload(payload);
		admin = new pg.Client({ connectionString: t.url });
		await admin.connect();
	});
	afterEach(async () => {
		await Promise.all(readers.splice(0).map((r) => r.close()));
	});
	afterAll(async () => {
		await Promise.all(readers.splice(0).map((r) => r.close()));
		await admin?.end();
		if (t) await closePayload(t.url);
		await t?.drop();
	});

	runConfigReaderContract(
		"payload",
		async (fx) => {
			await loadFixture(payload, fx);
			// Not through open(): the suite closes it in its own afterAll.
			const r = new PayloadConfigReader({
				payload,
				listen: { databaseUrl: t.url },
			});
			await r.start();
			return r;
		},
		{ unknownTeamQuota: "zero" },
	);

	describe("cache and LISTEN sbx_config", () => {
		const fx = {
			slug: "cache-t",
			update: (name: string) =>
				payload.update({
					collection: "templates",
					where: { slug: { equals: "linux" } },
					data: { name },
					overrideAccess: true,
				}),
		};

		beforeAll(async () => {
			await loadFixture(payload, makeConfigFixture());
		});

		it("sees a template change within 1 s of the commit through LISTEN", async () => {
			const r = open({ listen: true, ttlMs: 60_000 });
			await r.start();
			expect((await r.template("linux"))?.name).toBe("Ubuntu 26.04");
			await fx.update("Ubuntu LTS");
			const seen = await eventually(
				async () => (await r.template("linux"))?.name,
				(n) => n === "Ubuntu LTS",
				1_000,
			);
			expect(seen).toBe("Ubuntu LTS");
			await fx.update("Ubuntu 26.04");
		});

		it("sees size, pool and quota changes through LISTEN", async () => {
			const r = open({ listen: true, ttlMs: 60_000 });
			await r.start();
			const before = await r.size("2gb");
			expect(before?.memoryMb).toBe(2048);
			await r.poolTargets();
			await r.teamQuota((await teamIds())[0] as string);
			await payload.update({
				collection: "sizes",
				where: { slug: { equals: "2gb" } },
				data: { memoryMb: 2560 },
				overrideAccess: true,
			});
			expect(
				(
					await eventually(
						() => r.size("2gb"),
						(s) => s?.memoryMb === 2560,
						1_000,
					)
				)?.memoryMb,
			).toBe(2560);

			await payload.update({
				collection: "pool-targets",
				where: { providerId: { exists: false } },
				data: { target: 5 },
				overrideAccess: true,
			});
			const pools = await eventually(
				() => r.poolTargets(),
				(p) => p.some((x) => x.target === 5),
				1_000,
			);
			expect(pools.filter((x) => x.target === 5)).toHaveLength(1);

			const [teamId] = await teamIds();
			await payload.update({
				collection: "teams",
				id: teamId as string,
				data: { quota: { maxRamMb: 1024 } },
				overrideAccess: true,
			});
			const q = await eventually(
				() => r.teamQuota(teamId as string),
				(x) => x.maxRamMb === 1024,
				1_000,
			);
			expect(q.maxRamMb).toBe(1024);
		});

		it("gives a deleted team a zero quota", async () => {
			const team = await payload.create({
				collection: "teams",
				data: { name: "doomed", quota: { maxActiveSandboxes: 9 } },
				overrideAccess: true,
			});
			const r = open({ listen: true, ttlMs: 60_000 });
			await r.start();
			expect((await r.teamQuota(String(team.id))).maxActiveSandboxes).toBe(9);
			await payload.delete({
				collection: "teams",
				id: team.id,
				overrideAccess: true,
			});
			const q = await eventually(
				() => r.teamQuota(String(team.id)),
				(x) => x.maxActiveSandboxes === 0,
				1_000,
			);
			expect(q).toEqual({
				maxActiveSandboxes: 0,
				maxRamMb: 0,
				maxSavedSnapshots: 0,
			});
		});

		it("serves a cached value until ttlMs without LISTEN", async () => {
			const r = open({ ttlMs: 300 });
			expect((await r.template("linux"))?.name).toBe("Ubuntu 26.04");
			await fx.update("Ubuntu TTL");
			// Still cached.
			expect((await r.template("linux"))?.name).toBe("Ubuntu 26.04");
			const seen = await eventually(
				async () => (await r.template("linux"))?.name,
				(n) => n === "Ubuntu TTL",
				1_500,
			);
			expect(seen).toBe("Ubuntu TTL");
			await fx.update("Ubuntu 26.04");
		});

		it("reads defaults() without the cache (C7)", async () => {
			const r = open({ ttlMs: 60_000 });
			expect((await r.defaults()).ssoPortPolicy).toBe("team");
			expect((await r.defaults()).ssoPolicyEpoch).toBe(4);
			await payload.updateGlobal({
				slug: "platform-defaults",
				data: { publicPortsEnabled: true },
				overrideAccess: true,
			});
			expect((await r.defaults()).publicPortsEnabled).toBe(true);
			// ssoPortPolicy team -> any keeps the epoch, any -> team adds one.
			await payload.updateGlobal({
				slug: "platform-defaults",
				data: { ssoPortPolicy: "any" },
				overrideAccess: true,
			});
			await payload.updateGlobal({
				slug: "platform-defaults",
				data: { ssoPortPolicy: "team" },
				overrideAccess: true,
			});
			const d = await r.defaults();
			expect(d.ssoPortPolicy).toBe("team");
			expect(d.ssoPolicyEpoch).toBe(5);
		});

		it("drops the cache when LISTEN is re-established", async () => {
			const r = open({ listen: true, ttlMs: 60_000, reconnectDelayMs: 50 });
			await r.start();
			expect((await r.template("linux"))?.name).toBe("Ubuntu 26.04");
			const [old] = await listenerPids();
			expect(old).toBeDefined();
			// A change without NOTIFY: only a flush on reconnect can show it.
			await admin.query(
				`UPDATE payload.templates SET name = 'Silent' WHERE slug = 'linux'`,
			);
			expect((await r.template("linux"))?.name).toBe("Ubuntu 26.04");
			await admin.query("SELECT pg_terminate_backend($1)", [old]);
			const seen = await eventually(
				async () => (await r.template("linux"))?.name,
				(n) => n === "Silent",
				3_000,
			);
			expect(seen).toBe("Silent");
			// And it listens again: a notified change arrives.
			const pids = await eventually(
				listenerPids,
				(p) => p.length === 1 && p[0] !== old,
				3_000,
			);
			expect(pids).toHaveLength(1);
			await fx.update("After reconnect");
			expect(
				await eventually(
					async () => (await r.template("linux"))?.name,
					(n) => n === "After reconnect",
					1_000,
				),
			).toBe("After reconnect");
			await fx.update("Ubuntu 26.04");
		});

		it("stops listening on close and start() fails for an unreachable database", async () => {
			const r = open({ listen: true });
			await r.start();
			expect(await listenerPids()).toHaveLength(1);
			await r.close();
			expect(
				await eventually(listenerPids, (p) => p.length === 0, 2_000),
			).toEqual([]);

			const bad = new PayloadConfigReader({
				payload,
				listen: { databaseUrl: "postgres://127.0.0.1:1/none" },
			});
			await expect(bad.start()).rejects.toThrow();
			await bad.close();
		});

		async function teamIds(): Promise<string[]> {
			const r = await payload.find({
				collection: "teams",
				where: { name: { equals: "fixture" } },
				depth: 0,
				overrideAccess: true,
			});
			return r.docs.map((d) => String(d.id));
		}
	});

	describe("mapping", () => {
		beforeAll(async () => {
			await resetConfig(payload);
			for (const [slug, sortOrder] of [
				["b", 1],
				["a", 1],
				["c", 0],
			] as const) {
				await payload.create({
					collection: "sizes",
					data: { slug: `s-${slug}`, vcpu: 1, memoryMb: 512, sortOrder },
					overrideAccess: true,
				});
			}
		});

		it("orders by sortOrder, then slug", async () => {
			const r = open();
			expect((await r.sizes()).map((s) => s.slug)).toEqual([
				"s-c",
				"s-a",
				"s-b",
			]);
		});

		it("fills name, loginUser and capabilities like the static reader", async () => {
			await payload.create({
				collection: "templates",
				data: {
					slug: "bare",
					os: "linux",
					defaultSize: "s-a",
					allowedSizes: ["s-a"],
				},
				overrideAccess: true,
			});
			const r = open();
			expect(await r.template("bare")).toEqual({
				slug: "bare",
				name: "bare",
				os: "linux",
				enabled: true,
				defaultSize: "s-a",
				allowedSizes: ["s-a"],
				loginUser: "user",
				capabilities: ["exec", "files", "ssh"],
			});
		});

		it("takes the default quota when a team has none and the platform default when empty", async () => {
			const team = await payload.create({
				collection: "teams",
				data: { name: "plain" },
				overrideAccess: true,
			});
			await payload.updateGlobal({
				slug: "platform-defaults",
				data: {
					defaultQuota: {
						maxActiveSandboxes: 1,
						maxRamMb: 1000,
						maxSavedSnapshots: 2,
					},
				},
				overrideAccess: true,
			});
			const r = open();
			expect(await r.teamQuota(String(team.id))).toEqual({
				maxActiveSandboxes: 1,
				maxRamMb: 1000,
				maxSavedSnapshots: 2,
			});
			// A zero is a value, not an empty field.
			await payload.update({
				collection: "teams",
				id: team.id,
				data: { quota: { maxActiveSandboxes: 0 } },
				overrideAccess: true,
			});
			expect(await open().teamQuota(String(team.id))).toEqual({
				maxActiveSandboxes: 0,
				maxRamMb: 1000,
				maxSavedSnapshots: 2,
			});
			expect(await open().teamQuota(randomUUID())).toEqual({
				maxActiveSandboxes: 0,
				maxRamMb: 0,
				maxSavedSnapshots: 0,
			});
		});
	});
});
