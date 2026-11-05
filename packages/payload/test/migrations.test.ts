import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
	createTestDatabase,
	skipPg,
	type TestDatabase,
} from "@umiak/db/testing";
import type { Payload } from "payload";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	assertPayloadMigrated,
	migrateUmiakPayload,
	payloadMigrations,
	pendingPayloadMigrations,
} from "../src/index.ts";
import { closePayload, openPayload } from "./helpers.ts";

describe.skipIf(skipPg())("payload migrations on an empty database", () => {
	let t: TestDatabase;
	let payload: Payload;

	beforeAll(async () => {
		t = await createTestDatabase({ migrated: false, max: 2 });
		payload = await openPayload(t.url);
	});
	afterAll(async () => {
		if (t) await closePayload(t.url);
		await t?.drop();
	});

	it("assertPayloadMigrated throws before the migrations, naming them", async () => {
		const names = payloadMigrations.map((m) => m.name);
		expect(names.length).toBeGreaterThan(0);
		expect(await pendingPayloadMigrations(payload)).toEqual(names);
		await expect(assertPayloadMigrated(payload)).rejects.toThrow(
			names[0] as string,
		);
	});

	it("applies every migration once; a second run changes nothing", async () => {
		await migrateUmiakPayload(payload);
		expect(await pendingPayloadMigrations(payload)).toEqual([]);
		await assertPayloadMigrated(payload);
		const before = await t.pool.query(
			"SELECT name, batch FROM payload.payload_migrations ORDER BY name",
		);
		await migrateUmiakPayload(payload);
		const after = await t.pool.query(
			"SELECT name, batch FROM payload.payload_migrations ORDER BY name",
		);
		expect(after.rows).toEqual(before.rows);
		expect(before.rows.map((r) => r.name)).toEqual(
			payloadMigrations.map((m) => m.name),
		);
	});

	it("drops retired port policy storage and directory-only deactivation reasons", async () => {
		const columns = await t.pool.query(
			"SELECT column_name FROM information_schema.columns WHERE table_schema='payload' AND table_name='platform_defaults' AND column_name IN ('sso_port_policy','sso_policy_epoch')",
		);
		expect(columns.rows).toEqual([]);
		const policyEnum = await t.pool.query(
			"SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='payload' AND t.typname='enum_platform_defaults_sso_port_policy'",
		);
		expect(policyEnum.rows).toEqual([]);
		const reasons = await t.pool.query(
			"SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='payload' AND t.typname='enum_users_deactivated_reason' ORDER BY e.enumsortorder",
		);
		expect(reasons.rows).toEqual([{ enumlabel: "operator" }]);
		expect(
			(
				await t.pool.query(
					"SELECT to_regclass('payload.team_notices') AS retired",
				)
			).rows,
		).toEqual([{ retired: null }]);
		expect(
			(
				await t.pool.query(
					"SELECT column_name FROM information_schema.columns WHERE table_schema='payload' AND table_name='payload_locked_documents_rels' AND column_name='team_notices_id'",
				)
			).rows,
		).toEqual([]);
	});

	it("applied migrations unknown to the code are allowed", async () => {
		await t.pool.query(
			"INSERT INTO payload.payload_migrations (id, name, batch) VALUES (uuidv7(), '29991231_000000_future', 99)",
		);
		await assertPayloadMigrated(payload);
		expect(await pendingPayloadMigrations(payload)).toEqual([]);
		await t.pool.query(
			"DELETE FROM payload.payload_migrations WHERE name = '29991231_000000_future'",
		);
	});

	it("seeds platform-defaults with the S6, S7 and S8 defaults", async () => {
		const d = await payload.findGlobal({ slug: "platform-defaults" });
		expect(d).toMatchObject({
			ttlSeconds: null,
			maxTtlSeconds: 604800,
			idleTimeoutSeconds: 900,
			stoppedRetentionDays: 1,
			errorRetentionDays: 1,
			recoverMinIntervalSeconds: 600,
			defaultTemplate: "linux",
			publicPortsEnabled: true,
			rateLimits: { requestsPerSecond: 20, burst: 100, startsPerMinute: 30 },
			defaultQuota: {
				maxActiveSandboxes: 10000,
				maxRamMb: 8192,
				maxSavedSnapshots: 10,
			},
			newSharedTeamQuota: {
				maxActiveSandboxes: 10000,
				maxRamMb: 8192,
				maxSavedSnapshots: 10,
			},
			maxOwnedTeamsPerUser: 3,
		});
	});

	it("Update preserves disabled and explicitly configured retention", async () => {
		for (const stopped of [null, 3]) {
			await t.pool.query(
				"UPDATE payload.platform_defaults SET stopped_retention_days=$1, error_retention_days=4",
				[stopped],
			);
			await migrateUmiakPayload(payload);
			const r = await t.pool.query(
				"SELECT stopped_retention_days, error_retention_days FROM payload.platform_defaults",
			);
			expect(r.rows[0].stopped_retention_days).toBe(
				stopped === null ? null : String(stopped),
			);
			expect(r.rows[0].error_retention_days).toBe("4");
		}
		await t.pool.query(
			"UPDATE payload.platform_defaults SET stopped_retention_days=1, error_retention_days=1",
		);
	});

	it("seeds desktop capability and 4gb/8gb without a pool", async () => {
		for (const [slug, os] of [
			["linux-desktop", "linux"],
			["windows", "windows"],
		] as const) {
			const templates = await payload.find({
				collection: "templates",
				where: { slug: { equals: slug } },
			});
			expect(templates.docs[0]).toMatchObject({
				os,
				defaultSize: "4gb",
				allowedSizes: ["4gb", "8gb"],
				capabilities: ["exec", "files", "ssh", "desktop"],
			});
		}
		for (const [slug, vcpu, memoryMb] of [
			["4gb", 4, 4096],
			["8gb", 8, 8192],
		] as const) {
			const result = await payload.find({
				collection: "sizes",
				where: { slug: { equals: slug } },
			});
			expect(result.docs[0]).toMatchObject({ vcpu, memoryMb });
		}
		expect(
			(await payload.findGlobal({ slug: "platform-defaults" }))
				.publicDesktopEnabled,
		).toBe(false);
	});

	it("seeds the PoC template and size, no pool target", async () => {
		const tpl = await payload.find({
			collection: "templates",
			where: { slug: { equals: "linux" } },
		});
		expect(tpl.docs).toHaveLength(1);
		expect(tpl.docs[0]).toMatchObject({
			slug: "linux",
			name: "Ubuntu 26.04",
			os: "linux",
			enabled: true,
			defaultSize: "2gb",
			allowedSizes: ["2gb"],
			loginUser: "user",
			capabilities: ["exec", "files", "ssh"],
		});
		const size = await payload.find({
			collection: "sizes",
			where: { slug: { equals: "2gb" } },
		});
		expect(size.docs).toHaveLength(1);
		expect(size.docs[0]).toMatchObject({
			slug: "2gb",
			vcpu: 2,
			memoryMb: 2048,
		});
		// Warm pools are not in the MVP: no pool target is seeded.
		const pool = await payload.find({ collection: "pool-targets" });
		expect(pool.docs).toHaveLength(0);
	});

	it("registers Windows with 4 GB without enabling a warm pool", async () => {
		const templates = await payload.find({
			collection: "templates",
			where: { slug: { equals: "windows" } },
		});
		expect(templates.docs).toHaveLength(1);
		expect(templates.docs[0]).toMatchObject({
			slug: "windows",
			os: "windows",
			enabled: true,
			defaultSize: "4gb",
			allowedSizes: ["4gb", "8gb"],
			loginUser: "user",
			capabilities: ["exec", "files", "ssh", "desktop"],
		});
		const sizes = await payload.find({
			collection: "sizes",
			where: { slug: { equals: "4gb" } },
		});
		expect(sizes.docs).toHaveLength(1);
		// S9 seeds 2 vCPU; the S10 desktop migration raises it to 4 (S10 §11).
		expect(sizes.docs[0]).toMatchObject({
			slug: "4gb",
			vcpu: 4,
			memoryMb: 4096,
		});
		expect((await payload.find({ collection: "pool-targets" })).docs).toEqual(
			[],
		);
	});

	it("pool targets are unique per template and size when providerId is empty", async () => {
		const first = await payload.create({
			collection: "pool-targets",
			data: { template: "linux", size: "2gb", target: 1 },
		});
		try {
			await expect(
				payload.create({
					collection: "pool-targets",
					data: { template: "linux", size: "2gb", target: 2 },
				}),
			).rejects.toThrow();
			const r = await payload.find({ collection: "pool-targets" });
			expect(r.docs).toHaveLength(1);
		} finally {
			await payload.delete({ collection: "pool-targets", id: first.id });
		}
	});

	it("ids of new documents are UUIDs", async () => {
		const doc = await payload.create({
			collection: "sizes",
			data: { slug: `s-${Date.now()}`, vcpu: 1, memoryMb: 1024 },
		});
		expect(String(doc.id)).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
	});
});

describe.skipIf(skipPg())("Windows catalog upgrade", () => {
	let t: TestDatabase;
	let payload: Payload;
	const migration = "20261101_000000_windows_template";

	beforeAll(async () => {
		t = await createTestDatabase({ migrated: false, max: 2 });
		payload = await openPayload(t.url);
		await migrateUmiakPayload(payload);
	});
	afterAll(async () => {
		if (t) await closePayload(t.url);
		await t?.drop();
	});

	it.each([
		{ existingSize: false, existingTemplate: false },
		{ existingSize: true, existingTemplate: false },
		{ existingSize: false, existingTemplate: true },
		{ existingSize: true, existingTemplate: true },
	])(
		"fills missing entries and preserves operator records: %j",
		async (preset) => {
			// Replay only the data migration on a pre-S9 catalog. Both entries may
			// have been created independently through /admin before the upgrade.
			await t.pool.query(
				"DELETE FROM payload.templates WHERE slug = 'windows'",
			);
			await t.pool.query("DELETE FROM payload.sizes WHERE slug = '4gb'");
			await t.pool.query(
				"DELETE FROM payload.payload_migrations WHERE name = $1",
				[migration],
			);
			const size = preset.existingSize
				? await payload.create({
						collection: "sizes",
						data: { slug: "4gb", vcpu: 4, memoryMb: 8192, sortOrder: 37 },
					})
				: undefined;
			const template = preset.existingTemplate
				? await payload.create({
						collection: "templates",
						data: {
							slug: "windows",
							name: "Operator Windows",
							os: "windows",
							enabled: false,
							defaultSize: "2gb",
							allowedSizes: ["2gb"],
							loginUser: "operator",
							capabilities: ["files"],
							sortOrder: 42,
						},
					})
				: undefined;
			const before = await t.pool.query(`
			SELECT row_to_json(t) AS doc FROM payload.templates t WHERE slug = 'linux'
			UNION ALL SELECT row_to_json(s) FROM payload.sizes s WHERE slug = '2gb'
			UNION ALL SELECT row_to_json(d) FROM payload.platform_defaults d
			UNION ALL SELECT row_to_json(p) FROM payload.pool_targets p
		`);
			expect(await migrateUmiakPayload(payload)).toEqual([migration]);
			expect(await migrateUmiakPayload(payload)).toEqual([]);
			const templates = await payload.find({
				collection: "templates",
				where: { slug: { equals: "windows" } },
			});
			const sizes = await payload.find({
				collection: "sizes",
				where: { slug: { equals: "4gb" } },
			});
			expect(templates.docs).toHaveLength(1);
			expect(sizes.docs).toHaveLength(1);
			if (template) expect(templates.docs[0]).toEqual(template);
			else
				expect(templates.docs[0]).toMatchObject({
					defaultSize: "4gb",
					enabled: true,
				});
			if (size) expect(sizes.docs[0]).toEqual(size);
			else expect(sizes.docs[0]).toMatchObject({ vcpu: 2, memoryMb: 4096 });
			const after = await t.pool.query(`
			SELECT row_to_json(t) AS doc FROM payload.templates t WHERE slug = 'linux'
			UNION ALL SELECT row_to_json(s) FROM payload.sizes s WHERE slug = '2gb'
			UNION ALL SELECT row_to_json(d) FROM payload.platform_defaults d
			UNION ALL SELECT row_to_json(p) FROM payload.pool_targets p
		`);
			expect(after.rows).toEqual(before.rows);
		},
	);
});

describe.skipIf(skipPg())(
	"payload migrations copy the identity stand-in",
	() => {
		let t: TestDatabase;
		let payload: Payload;
		const ids = {
			personal: randomUUID(),
			shared: randomUUID(),
			alice: randomUUID(),
			bob: randomUUID(),
			key: randomUUID(),
			ssh: randomUUID(),
		};
		const hash = "a".repeat(64);
		const created = new Date("2026-10-01T10:00:00Z");
		const expires = new Date("2027-10-01T10:00:00Z");
		const revoked = new Date("2026-10-20T10:00:00Z");
		const rotated = new Date("2026-10-10T10:00:00Z");

		beforeAll(async () => {
			// Copy of the template: db/migrations applied, identity schema included.
			t = await createTestDatabase({ max: 2 });
			const q = (sql: string, args: unknown[]) => t.pool.query(sql, args);
			await q(
				"INSERT INTO identity.teams (id, name, personal, created_at) VALUES ($1, 'alice', true, $3), ($2, 'Shared', false, $3)",
				[ids.personal, ids.shared, created],
			);
			await q(
				`INSERT INTO identity.users (id, email, name, active, is_operator, idp_subject, default_team_id, created_at)
			 VALUES ($1, 'alice@example.com', 'Alice', true, true, 'sub-alice', $3, $4),
			        ($2, 'bob@example.com', NULL, false, false, NULL, NULL, $4)`,
				[ids.alice, ids.bob, ids.personal, created],
			);
			await q(
				`INSERT INTO identity.memberships (user_id, team_id, role, created_at)
			 VALUES ($1, $3, 'owner', $4), ($1, $5, 'owner', $4), ($2, $5, 'member', $4)`,
				[ids.alice, ids.bob, ids.personal, created, ids.shared],
			);
			await q(
				`INSERT INTO identity.api_keys (id, team_id, name, secret_hash, prefix, last4, scopes,
			   created_by, created_via, created_at, expires_at, last_used_at, revoked_at,
			   revoked_by, revoked_by_key, rotated_at)
			 VALUES ($1, $2, 'ci', $3, 'umiak_key_abc', 'wxyz', ARRAY['sandboxes:read','sandboxes:write'],
			   $4, 'cli', $5, $6, $5, $7, $4, $1, $8)`,
				[
					ids.key,
					ids.shared,
					hash,
					ids.alice,
					created,
					expires,
					revoked,
					rotated,
				],
			);
			await q(
				`INSERT INTO identity.ssh_keys (id, user_id, name, public_key, fingerprint, type, created_at, last_used_at)
			 VALUES ($1, $2, 'laptop', 'ssh-ed25519 AAAA test', 'SHA256:abc', 'ssh-ed25519', $3, $3)`,
				[ids.ssh, ids.alice, created],
			);
			payload = await openPayload(t.url);
			await migrateUmiakPayload(payload);
		});
		afterAll(async () => {
			if (t) await closePayload(t.url);
			await t?.drop();
		});

		it("keeps the UUIDs and fields of teams and users", async () => {
			const teams = await payload.find({
				collection: "teams",
				sort: "name",
				depth: 0,
			});
			expect(teams.docs.map((d) => [d.id, d.name, d.personal])).toEqual([
				[ids.shared, "Shared", false],
				[ids.personal, "alice", true],
			]);
			const alice = await payload.findByID({
				collection: "users",
				id: ids.alice,
				depth: 0,
			});
			expect(alice).toMatchObject({
				email: "alice@example.com",
				name: "Alice",
				active: true,
				isOperator: true,
				idpSubject: "sub-alice",
				defaultTeam: ids.personal,
				personalTeam: ids.personal,
			});
			expect(new Date(alice.createdAt).toISOString()).toBe(
				created.toISOString(),
			);
			// A user with an IdP subject has logged in; stubs have no lastLoginAt.
			expect(alice.lastLoginAt).not.toBeNull();
			const bob = await payload.findByID({
				collection: "users",
				id: ids.bob,
				depth: 0,
			});
			expect(bob).toMatchObject({
				email: "bob@example.com",
				active: false,
				isOperator: false,
			});
			expect(bob.idpSubject ?? null).toBeNull();
			expect(bob.lastLoginAt ?? null).toBeNull();
		});

		it("copies memberships with new ids", async () => {
			const ms = await payload.find({
				collection: "memberships",
				depth: 0,
				limit: 0,
			});
			const rows = ms.docs.map((d) => `${d.user}:${d.team}:${d.role}`).sort();
			expect(rows).toEqual(
				[
					`${ids.alice}:${ids.personal}:owner`,
					`${ids.alice}:${ids.shared}:owner`,
					`${ids.bob}:${ids.shared}:member`,
				].sort(),
			);
		});

		it("copies api keys with every field", async () => {
			const k = await payload.findByID({
				collection: "api-keys",
				id: ids.key,
				depth: 0,
			});
			expect(k).toMatchObject({
				name: "ci",
				team: ids.shared,
				kind: "team",
				secretHash: hash,
				prefix: "umiak_key_abc",
				last4: "wxyz",
				scopes: ["sandboxes:read", "sandboxes:write"],
				createdBy: ids.alice,
				createdVia: "cli",
				revokedBy: ids.alice,
				revokedByKey: ids.key,
			});
			expect(k.sandbox ?? null).toBeNull();
			expect(new Date(k.expiresAt).toISOString()).toBe(expires.toISOString());
			expect(new Date(k.revokedAt).toISOString()).toBe(revoked.toISOString());
			expect(new Date(k.rotatedAt).toISOString()).toBe(rotated.toISOString());
			expect(new Date(k.lastUsedAt).toISOString()).toBe(created.toISOString());
		});

		it("copies ssh keys", async () => {
			const s = await payload.findByID({
				collection: "ssh-keys",
				id: ids.ssh,
				depth: 0,
			});
			expect(s).toMatchObject({
				user: ids.alice,
				name: "laptop",
				publicKey: "ssh-ed25519 AAAA test",
				fingerprint: "SHA256:abc",
				type: "ssh-ed25519",
			});
		});

		it("leaves the identity schema in place", async () => {
			const r = await t.pool.query(
				"SELECT count(*)::int AS n FROM identity.users",
			);
			expect(r.rows[0].n).toBe(2);
		});
	},
);

describe.skipIf(skipPg())("src/migrate.ts", () => {
	let t: TestDatabase;
	const script = fileURLToPath(new URL("../src/migrate.ts", import.meta.url));
	const run = (env: Record<string, string>) =>
		new Promise<{ code: number | null; out: string }>((resolve) => {
			execFile(
				process.execPath,
				[script],
				{ env: { PATH: process.env.PATH ?? "", ...env } },
				(err, stdout, stderr) => {
					resolve({
						code: err ? ((err as { code?: number }).code ?? 1) : 0,
						out: `${stdout}${stderr}`,
					});
				},
			);
		});

	beforeAll(async () => {
		t = await createTestDatabase({ migrated: false, max: 2 });
	});
	afterAll(async () => {
		await t?.drop();
	});

	it("migrates the database of DATABASE_URL and exits 0, twice", async () => {
		const env = { DATABASE_URL: t.url, PAYLOAD_SECRET: "cli-secret" };
		const first = await run(env);
		expect(first.out).toContain("applied payload migrations");
		expect(first.code).toBe(0);
		const r = await t.pool.query(
			"SELECT name FROM payload.payload_migrations ORDER BY name",
		);
		expect(r.rows.map((x) => x.name)).toEqual(
			payloadMigrations.map((m) => m.name),
		);
		const second = await run(env);
		expect(second.out).toContain("up to date");
		expect(second.code).toBe(0);
	});

	it("exits 1 without PAYLOAD_SECRET", async () => {
		const r = await run({ DATABASE_URL: t.url });
		expect(r.code).toBe(1);
		expect(r.out).toContain("PAYLOAD_SECRET");
	});
});

describe.skipIf(skipPg())(
	"single Windows catalog upgrade on the dev stand",
	() => {
		let t: TestDatabase;
		let payload: Payload;
		const migration = "20261103_000000_windows_single";
		beforeAll(async () => {
			t = await createTestDatabase();
			payload = await openPayload(t.url);
			await migrateUmiakPayload(payload);
		});
		afterAll(async () => {
			if (t) await closePayload(t.url);
			await t?.drop();
		});
		it("rekeys desktop builds, retires 598, keeps snapshot build IDs and is idempotent", async () => {
			const provider = randomUUID(),
				node = randomUUID(),
				storage = randomUUID();
			const headless = randomUUID(),
				desktop = randomUUID(),
				snapshot = randomUUID();
			await t.pool.query(
				"INSERT INTO runtime.providers (id,kind,name,cluster_mac_id,vmid_min,vmid_max,api_url,secret_ref) VALUES ($1,'proxmox','s17',250,500,589,'https://pve:8006','s17')",
				[provider],
			);
			await t.pool.query(
				"INSERT INTO runtime.nodes (id,provider_id,name,ram_cap_mb,node_agent_ref) VALUES ($1,$2,'pve',8192,'node')",
				[node, provider],
			);
			await t.pool.query(
				"INSERT INTO runtime.storages (id,provider_id,node_id,name,driver) VALUES ($1,$2,$3,'local-lvm','lvmthin')",
				[storage, provider, node],
			);
			await t.pool.query(
				`INSERT INTO runtime.template_builds (id,template_slug,version,os,provider_id,node_id,storage_id,pve_vmid,disk_layout,hw,boot_timeout_s,status,headless)
  VALUES ($1,'windows','headless','windows',$3,$4,$5,598,'{}','{}',1200,'active',NULL), ($2,'windows-desktop','20261101.7','windows',$3,$4,$5,595,'{}','{}',1200,'active',NULL)`,
				[headless, desktop, provider, node, storage],
			);
			await t.pool.query(
				"INSERT INTO runtime.snapshots (id,kind,team_id,name,provider_id,node_id,storage_id,template_build_id,lv_id,state) VALUES ($1,'saved',$2,'headless',$3,$4,$5,$6,replace($1::uuid::text,'-',''),'ready')",
				[snapshot, randomUUID(), provider, node, storage, headless],
			);
			for (let i = 0; i < 2; i++) {
				await t.pool.query(
					"DELETE FROM payload.payload_migrations WHERE name = $1",
					[migration],
				);
				await migrateUmiakPayload(payload);
			}
			expect(
				(
					await t.pool.query(
						"SELECT id, template_slug, status FROM runtime.template_builds ORDER BY pve_vmid",
					)
				).rows,
			).toEqual([
				{ id: desktop, template_slug: "windows", status: "active" },
				{ id: headless, template_slug: "windows", status: "retired" },
			]);
			expect(
				(
					await t.pool.query(
						"SELECT template_build_id FROM runtime.snapshots WHERE id=$1",
						[snapshot],
					)
				).rows[0].template_build_id,
			).toBe(headless);
			expect(
				(await payload.find({ collection: "templates" })).docs
					.map((x) => x.slug)
					.sort(),
			).toEqual(["linux", "linux-desktop", "windows"]);
		});
	},
);

describe.skipIf(skipPg())(
	"Windows identity collisions during catalog migration",
	() => {
		let t: TestDatabase;
		let payload: Payload;
		beforeAll(async () => {
			t = await createTestDatabase();
			payload = await openPayload(t.url);
			await migrateUmiakPayload(payload);
		});
		afterAll(async () => {
			if (t) await closePayload(t.url);
			await t?.drop();
		});
		it.each([
			{
				name: "custom slots and versions",
				canonicalSlot: 700,
				desktopSlot: 701,
				version: "custom-desktop",
			},
			{
				name: "duplicate desktop registration from an older bootstrap",
				canonicalSlot: 595,
				desktopSlot: 595,
				version: "20261101.7",
			},
		])(
			"merges active identities safely: $name",
			async ({ canonicalSlot, desktopSlot, version }) => {
				const provider = randomUUID(),
					node = randomUUID(),
					storage = randomUUID(),
					canonical = randomUUID(),
					desktop = randomUUID();
				await t.pool.query(
					"INSERT INTO runtime.providers (id,kind,name,cluster_mac_id,vmid_min,vmid_max,api_url,secret_ref) VALUES ($1,'proxmox',$1::uuid::text,$2,500,589,'https://pve:8006','s17')",
					[provider, canonicalSlot === 700 ? 247 : 248],
				);
				await t.pool.query(
					"INSERT INTO runtime.nodes (id,provider_id,name,ram_cap_mb,node_agent_ref) VALUES ($1,$2,'pve',8192,'node')",
					[node, provider],
				);
				await t.pool.query(
					"INSERT INTO runtime.storages (id,provider_id,node_id,name,driver) VALUES ($1,$2,$3,'local-lvm','lvmthin')",
					[storage, provider, node],
				);
				await t.pool.query(
					`INSERT INTO runtime.template_builds (id,template_slug,version,os,provider_id,node_id,storage_id,pve_vmid,disk_layout,hw,boot_timeout_s,status,headless)
   VALUES ($1,'windows',$6,'windows',$3,$4,$5,$7,'{}','{}',1200,'active',NULL),
          ($2,'windows-desktop',$6,'windows',$3,$4,$5,$8,'{}','{}',1200,'active',NULL)`,
					[
						canonical,
						desktop,
						provider,
						node,
						storage,
						version,
						canonicalSlot,
						desktopSlot,
					],
				);
				await t.pool.query(
					"DELETE FROM payload.payload_migrations WHERE name='20261103_000000_windows_single'",
				);
				await migrateUmiakPayload(payload);
				const result = (
					await t.pool.query(
						"SELECT id, template_slug, status FROM runtime.template_builds WHERE node_id=$1",
						[node],
					)
				).rows;
				expect(result).toHaveLength(2);
				expect(result.every((b) => b.template_slug === "windows")).toBe(true);
				expect(result.filter((b) => b.status === "active")).toHaveLength(1);
				if (canonicalSlot === 700)
					expect(result.find((b) => b.id === desktop)?.status).toBe("active");
			},
		);
	},
);
