import { randomBytes, randomUUID } from "node:crypto";
import { encodeUuid, PRESETS } from "@sbx/auth";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import type { Payload } from "payload";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateSbxPayload, seedPayloadIdentity } from "../src/index.ts";
import { payloadContractSubject } from "../src/testing.ts";
import { closePayload, Listener, openPayload } from "./helpers.ts";

describe.skipIf(skipPg())("seedPayloadIdentity", () => {
	let t: TestDatabase;
	let payload: Payload;
	let listener: Listener;

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
				"SELECT * FROM payload.teams WHERE id = ANY($1::uuid[]) ORDER BY id",
			),
			users: await q(
				"SELECT * FROM payload.users WHERE id = ANY($1::uuid[]) ORDER BY id",
			),
			memberships: await q(
				"SELECT * FROM payload.memberships WHERE team_id = ANY($1::uuid[]) ORDER BY user_id",
			),
			apiKeys: await q(
				"SELECT * FROM payload.api_keys WHERE id = ANY($1::uuid[]) ORDER BY id",
			),
		};
	}

	beforeAll(async () => {
		t = await createTestDatabase({ migrated: false, max: 2 });
		payload = await openPayload(t.url);
		await migrateSbxPayload(payload);
		listener = new Listener(t.url);
		await listener.start(["sbx_identity", "sbx_config", "sbx_ssh_revoke"]);
	});
	afterAll(async () => {
		await listener?.stop();
		if (t) await closePayload(t.url);
		await t?.drop();
	});
	beforeEach(async () => {
		await listener.settle();
		listener.clear();
	});

	it("upserts users, teams, memberships and keys with the file's ids; twice gives the same rows", async () => {
		expect(await seedPayloadIdentity(payload, yaml)).toEqual({
			teams: 1,
			users: 2,
			memberships: 2,
			apiKeys: 2,
		});
		const notes = (await listener.settle()).map(
			(n) => `${n.channel} ${n.payload}`,
		);
		expect(notes).toEqual(
			expect.arrayContaining([
				`sbx_identity teams:${team}`,
				`sbx_config teams:${team}`,
				`sbx_identity users:${alice}`,
				`sbx_identity users:${bob}`,
				`sbx_identity memberships:${alice}:${team}`,
				`sbx_identity api-keys:${ciKey}`,
			]),
		);
		const first = await snapshot();
		expect(first.teams).toHaveLength(1);
		expect(first.users).toHaveLength(2);
		expect(first.memberships).toHaveLength(2);
		expect(first.apiKeys).toHaveLength(2);
		listener.clear();
		await seedPayloadIdentity(payload, yaml);
		expect(await snapshot()).toEqual(first);
		// Nothing changed: nothing to notify.
		expect(await listener.settle()).toEqual([]);

		const s = payloadContractSubject(payload);
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
		expect(await s.findApiKeyByHash(roHash)).toMatchObject({
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

	it("keeps a revocation, a JIT binding and the IdP's email across re-seeding", async () => {
		const s = payloadContractSubject(payload);
		await seedPayloadIdentity(payload, yaml);
		await s.revokeApiKey(roKey, {});
		const sub = randomUUID();
		await s.resolveSession({
			email: `alice-${team}@example.com`,
			user: sub,
			groups: [],
		});
		const moved = `alice-moved-${team}@example.com`;
		await s.resolveSession({ email: moved, user: sub, groups: [] });
		await seedPayloadIdentity(payload, yaml);
		expect((await s.findApiKeyByHash(roHash))?.revokedAt).toBeInstanceOf(Date);
		expect(await s.user(alice)).toMatchObject({
			idpSubject: sub,
			email: moved,
		});
	});

	it("a deactivation by the file sends sbx_ssh_revoke user:<usr_>", async () => {
		const id = randomUUID();
		const email = `f-${randomBytes(4).toString("hex")}@example.com`;
		await seedPayloadIdentity(payload, `users: [{id: ${id}, email: ${email}}]`);
		await seedPayloadIdentity(
			payload,
			`users: [{id: ${id}, email: ${email}, active: false}]`,
		);
		await listener.waitFor(
			(n) =>
				n.channel === "sbx_ssh_revoke" &&
				n.payload === `user:${encodeUuid("user", id)}`,
		);
	});

	it.each([
		["an unknown field", "teams: []\nusers: []\napiKeys: []\nextra: 1\n"],
		[
			"an unknown scope",
			`apiKeys:\n  - {id: ${randomUUID()}, teamId: ${team}, name: x, sha256: ${ciHash}, scopes: [nope:read], expiresAt: 2027-01-01T00:00:00Z}\n`,
		],
		["not a mapping", "- 1\n- 2\n"],
	])("rejects %s", async (_, text) => {
		await expect(seedPayloadIdentity(payload, text)).rejects.toThrow(
			/identity file/,
		);
	});

	it("an empty file is a no-op", async () => {
		expect(await seedPayloadIdentity(payload, "")).toEqual({
			teams: 0,
			users: 0,
			memberships: 0,
			apiKeys: 0,
		});
	});

	it("is atomic: a failing key leaves no rows and sends nothing", async () => {
		const t2 = randomUUID();
		const u2 = randomUUID();
		const text = `
teams:
  - {id: ${t2}, name: atomic}
users:
  - {id: ${u2}, email: atomic-${t2}@example.com, teams: {${t2}: owner}}
apiKeys:
  - {id: ${randomUUID()}, teamId: ${randomUUID()}, name: x, sha256: ${randomBytes(32).toString("hex")}, preset: ci, expiresAt: 2027-01-01T00:00:00Z}
`;
		await expect(seedPayloadIdentity(payload, text)).rejects.toThrow(
			/identity file/,
		);
		const r = await t.pool.query(
			"SELECT 1 FROM payload.teams WHERE id = $1 UNION ALL SELECT 1 FROM payload.users WHERE id = $2",
			[t2, u2],
		);
		expect(r.rowCount).toBe(0);
		expect(await listener.settle()).toEqual([]);
	});
});
