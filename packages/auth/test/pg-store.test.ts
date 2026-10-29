import { randomBytes, randomUUID } from "node:crypto";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import Pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRESETS } from "../src/scopes.ts";
import { seedIdentity } from "../src/seed.ts";
import { pgContractSubject, runIdentityStoreContract } from "../src/testing.ts";

describe.skipIf(skipPg())("PgIdentityStore", () => {
	let t: TestDatabase;

	beforeAll(async () => {
		t = await createTestDatabase({ max: 20 });
	});
	afterAll(async () => {
		await t?.drop();
	});

	runIdentityStoreContract("postgres stand-in", async () =>
		pgContractSubject(t.pool),
	);

	describe("NOTIFY sbx_identity", () => {
		let listener: Pg.Client;
		const got: string[] = [];
		const waiters: { payload: string; resolve: () => void }[] = [];

		beforeAll(async () => {
			listener = new Pg.Client({ connectionString: t.url });
			await listener.connect();
			listener.on("notification", (n) => {
				if (n.channel !== "sbx_identity" || n.payload === undefined) return;
				got.push(n.payload);
				for (const w of waiters.filter((w) => w.payload === n.payload)) {
					w.resolve();
				}
			});
			await listener.query("LISTEN sbx_identity");
		});
		afterAll(async () => {
			await listener?.end();
		});

		function received(payload: string): Promise<void> {
			if (got.includes(payload)) return Promise.resolve();
			return new Promise((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error(`no NOTIFY ${payload}`)),
					5000,
				);
				waiters.push({
					payload,
					resolve: () => {
						clearTimeout(timer);
						resolve();
					},
				});
			});
		}

		// Notifications of committed transactions arrive in commit order: once a
		// marker sent afterwards arrives, every earlier one has arrived too.
		async function flush(): Promise<void> {
			const marker = `marker:${randomUUID()}`;
			await t.pool.query("SELECT pg_notify('sbx_identity', $1)", [marker]);
			await received(marker);
		}

		function count(payload: string): number {
			return got.filter((p) => p === payload).length;
		}

		async function ownerWithTeam() {
			const s = pgContractSubject(t.pool);
			const r = await s.resolveSession({
				email: `n-${randomBytes(4).toString("hex")}@example.com`,
				user: randomUUID(),
				groups: [],
			});
			return { s, userId: r.user.id, teamId: r.defaultTeamId as string };
		}

		it("revoke sends api_keys:<id>; touch sends nothing", async () => {
			const { s, userId, teamId } = await ownerWithTeam();
			const k = await s.createApiKey({
				teamId,
				name: "ci",
				scopes: ["sandboxes:read"],
				expiresAt: new Date(Date.now() + 86_400_000),
				createdByUserId: userId,
				createdVia: "cli",
				secretHash: randomBytes(32).toString("hex"),
				prefix: "abcdefgh",
				last4: "1234",
			});
			await flush();
			expect(count(`api_keys:${k.id}`)).toBe(1); // insert
			await s.touchApiKey(k.id);
			await flush();
			expect(count(`api_keys:${k.id}`)).toBe(1);
			await s.revokeApiKey(k.id, { userId });
			await flush();
			expect(count(`api_keys:${k.id}`)).toBe(2);
			const row = await t.pool.query(
				"SELECT revoked_by, revoked_by_key FROM identity.api_keys WHERE id = $1",
				[k.id],
			);
			expect(row.rows[0]).toEqual({ revoked_by: userId, revoked_by_key: null });
		});

		it("users, memberships and ssh_keys changes notify; touchSshKey does not", async () => {
			const { s, userId, teamId } = await ownerWithTeam();
			await received(`users:${userId}`);
			await received(`memberships:${userId}:${teamId}`);
			await s.removeMember(userId, teamId);
			const ssh = await s.addSshKey({
				userId,
				name: "k",
				publicKey: "ssh-ed25519 AAAA k",
				fingerprint: `SHA256:${randomBytes(8).toString("hex")}`,
				type: "ssh-ed25519",
			});
			await received(`ssh_keys:${ssh.id}`);
			await s.touchSshKey(ssh.id);
			await flush();
			expect(count(`ssh_keys:${ssh.id}`)).toBe(1);
			got.length = 0;
			await s.setActive(userId, false);
			await received(`users:${userId}`);
		});

		it("a repeated resolveSession with unchanged claims does not notify", async () => {
			const s = pgContractSubject(t.pool);
			const h = {
				email: `q-${randomBytes(4).toString("hex")}@example.com`,
				user: randomUUID(),
				groups: [],
			};
			const r = await s.resolveSession(h);
			await flush();
			const before = count(`users:${r.user.id}`);
			expect(before).toBeGreaterThan(0);
			await s.resolveSession(h);
			await s.setActive(r.user.id, true); // no-op update
			await s.resolveSession({ ...h, groups: ["x"] }); // not an operator group
			await flush();
			expect(count(`users:${r.user.id}`)).toBe(before);
		});
	});

	describe("seedIdentity", () => {
		const team = randomUUID();
		const alice = randomUUID();
		const bob = randomUUID();
		const ciKey = randomUUID();
		const roKey = randomUUID();
		const ciHash = randomBytes(32).toString("hex");
		const roHash = randomBytes(32).toString("hex");
		const yaml = `
teams:
  - id: ${team}
    name: acme
users:
  - id: ${alice}
    email: Alice-${team}@Example.com
    name: Alice
    teams:
      ${team}: owner
  - id: ${bob}
    email: bob-${team}@example.com
    active: false
    teams:
      ${team}: member
apiKeys:
  - id: ${ciKey}
    teamId: ${team}
    name: ci
    sha256: ${ciHash}
    preset: ci
    expiresAt: 2027-01-01T00:00:00Z
  - id: ${roKey}
    teamId: ${team}
    name: reader
    sha256: ${roHash}
    scopes: [sandboxes:read, files:read]
    expiresAt: "2027-06-01T00:00:00.000Z"
    prefix: AbCdEfGh
    last4: wxyz
`;

		async function snapshot() {
			const q = async (sql: string) =>
				(await t.pool.query(sql, [[team, alice, bob, ciKey, roKey]])).rows;
			return {
				teams: await q(
					"SELECT * FROM identity.teams WHERE id = ANY($1::uuid[]) ORDER BY id",
				),
				users: await q(
					"SELECT * FROM identity.users WHERE id = ANY($1::uuid[]) ORDER BY id",
				),
				memberships: await q(
					"SELECT * FROM identity.memberships WHERE team_id = ANY($1::uuid[]) ORDER BY user_id",
				),
				apiKeys: await q(
					"SELECT * FROM identity.api_keys WHERE id = ANY($1::uuid[]) ORDER BY id",
				),
			};
		}

		it("upserts users, teams, memberships and keys; twice gives the same rows", async () => {
			expect(await seedIdentity(t.pool, yaml)).toEqual({
				teams: 1,
				users: 2,
				memberships: 2,
				apiKeys: 2,
			});
			const first = await snapshot();
			expect(first.teams).toHaveLength(1);
			expect(first.users).toHaveLength(2);
			expect(first.memberships).toHaveLength(2);
			expect(first.apiKeys).toHaveLength(2);
			await seedIdentity(t.pool, yaml);
			expect(await snapshot()).toEqual(first);

			const s = pgContractSubject(t.pool);
			const ci = await s.findApiKeyByHash(ciHash);
			expect(ci).toMatchObject({
				id: ciKey,
				teamId: team,
				name: "ci",
				scopes: [...PRESETS.ci],
				expiresAt: new Date("2027-01-01T00:00:00Z"),
				createdBy: null,
				revokedAt: null,
			});
			const ro = await s.findApiKeyByHash(roHash);
			expect(ro).toMatchObject({
				scopes: ["sandboxes:read", "files:read"],
				prefix: "AbCdEfGh",
				last4: "wxyz",
			});
			expect(await s.user(alice)).toMatchObject({
				email: `alice-${team}@example.com`,
				name: "Alice",
				active: true,
			});
			expect((await s.user(bob))?.active).toBe(false);
			expect(await s.membership(alice, team)).toEqual({ role: "owner" });
			expect(await s.team(team)).toEqual({ id: team, name: "acme" });
		});

		it("keeps a revocation and a JIT binding across re-seeding", async () => {
			const s = pgContractSubject(t.pool);
			await seedIdentity(t.pool, yaml);
			await s.revokeApiKey(roKey, {});
			const sub = randomUUID();
			await s.resolveSession({
				email: `alice-${team}@example.com`,
				user: sub,
				groups: [],
			});
			await seedIdentity(t.pool, yaml);
			expect((await s.findApiKeyByHash(roHash))?.revokedAt).toBeInstanceOf(
				Date,
			);
			expect((await s.user(alice))?.idpSubject).toBe(sub);
		});

		it.each([
			["an unknown field", "teams: []\nusers: []\napiKeys: []\nextra: 1\n"],
			[
				"an unknown scope",
				`apiKeys:\n  - {id: ${randomUUID()}, teamId: ${team}, name: x, sha256: ${ciHash}, scopes: [nope:read], expiresAt: 2027-01-01T00:00:00Z}\n`,
			],
			[
				"both scopes and preset",
				`apiKeys:\n  - {id: ${randomUUID()}, teamId: ${team}, name: x, sha256: ${ciHash}, scopes: [files:read], preset: ci, expiresAt: 2027-01-01T00:00:00Z}\n`,
			],
			[
				"neither scopes nor preset",
				`apiKeys:\n  - {id: ${randomUUID()}, teamId: ${team}, name: x, sha256: ${ciHash}, expiresAt: 2027-01-01T00:00:00Z}\n`,
			],
			[
				"a bad sha256",
				`apiKeys:\n  - {id: ${randomUUID()}, teamId: ${team}, name: x, sha256: abc, preset: ci, expiresAt: 2027-01-01T00:00:00Z}\n`,
			],
			[
				"a non-uuid id",
				"users:\n  - {id: alice, email: a@example.com, teams: {}}\n",
			],
			[
				"a bad role",
				`users:\n  - {id: ${randomUUID()}, email: a@example.com, teams: {${team}: admin}}\n`,
			],
			["not a mapping", "- 1\n- 2\n"],
		])("rejects %s and writes nothing", async (_, text) => {
			await expect(seedIdentity(t.pool, text)).rejects.toThrow(/identity file/);
		});

		it("an empty file is a no-op", async () => {
			expect(await seedIdentity(t.pool, "")).toEqual({
				teams: 0,
				users: 0,
				memberships: 0,
				apiKeys: 0,
			});
		});

		it("is atomic: a failing key leaves no rows", async () => {
			const t2 = randomUUID();
			const text = `
teams:
  - {id: ${t2}, name: atomic}
apiKeys:
  - {id: ${randomUUID()}, teamId: ${randomUUID()}, name: x, sha256: ${randomBytes(32).toString("hex")}, preset: ci, expiresAt: 2027-01-01T00:00:00Z}
`;
			await expect(seedIdentity(t.pool, text)).rejects.toThrow();
			const r = await t.pool.query(
				"SELECT 1 FROM identity.teams WHERE id = $1",
				[t2],
			);
			expect(r.rowCount).toBe(0);
		});
	});
});
