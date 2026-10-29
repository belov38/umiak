import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
	randomUUID,
} from "node:crypto";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type EnvironmentKeys,
	PgEnvironmentStore,
} from "../src/environments.ts";
import { IdentityError, type IdentityErrorCode } from "../src/identity.ts";
import type { SecretSets } from "../src/secret-sets.ts";

// AES-256-GCM with the AAD layout of KeyRing in @sbx/core (S6 §13.1); auth must
// not depend on core, so the tests carry their own ring.
function testKeys(): EnvironmentKeys & { aads: string[] } {
	const key = randomBytes(32);
	const aads: string[] = [];
	return {
		aads,
		encryptFor(prefix, id, plaintext) {
			const aad = `${prefix}:${id}:v7`;
			aads.push(aad);
			const nonce = randomBytes(12);
			const c = createCipheriv("aes-256-gcm", key, nonce);
			c.setAAD(Buffer.from(aad));
			const ct = Buffer.concat([
				c.update(Buffer.from(plaintext)),
				c.final(),
				c.getAuthTag(),
			]);
			return { keyVersion: 7, nonce, ciphertext: ct };
		},
		decryptFor(prefix, id, blob) {
			const ct = Buffer.from(blob.ciphertext);
			const d = createDecipheriv("aes-256-gcm", key, blob.nonce);
			d.setAAD(Buffer.from(`${prefix}:${id}:v${blob.keyVersion}`));
			d.setAuthTag(ct.subarray(ct.length - 16));
			return Buffer.concat([
				d.update(ct.subarray(0, ct.length - 16)),
				d.final(),
			]);
		},
	};
}

async function codeOf(p: Promise<unknown>): Promise<IdentityErrorCode> {
	try {
		await p;
	} catch (e) {
		if (e instanceof IdentityError) return e.code;
		throw e;
	}
	throw new Error("expected an IdentityError");
}

describe.skipIf(skipPg())("PgEnvironmentStore", () => {
	let t: TestDatabase;
	let keys: ReturnType<typeof testKeys>;
	let store: PgEnvironmentStore;
	let userId: string;

	beforeAll(async () => {
		t = await createTestDatabase();
		keys = testKeys();
		store = new PgEnvironmentStore(t.pool, keys);
		const u = await t.pool.query<{ id: string }>(
			"INSERT INTO identity.users (email) VALUES ($1) RETURNING id",
			[`env-${randomUUID()}@example.com`],
		);
		userId = u.rows[0]?.id as string;
	});
	afterAll(async () => {
		await t?.drop();
	});

	async function team(): Promise<string> {
		const r = await t.pool.query<{ id: string }>(
			"INSERT INTO identity.teams (name) VALUES ('t') RETURNING id",
		);
		return r.rows[0]?.id as string;
	}

	const sets: SecretSets = {
		env: { NODE_ENV: "production", REGION: "nz" },
		secrets: { OPENAI_API_KEY: "sk-very-secret-value" },
		secretFiles: [
			{ name: "id_rsa", contentBase64: "c2VjcmV0LWZpbGU=", mode: 0o400 },
		],
	};

	it("create stores encrypted sets and get returns them by id and by name", async () => {
		const teamId = await team();
		const e = await store.create(
			teamId,
			{
				name: "prod",
				...sets,
				repositories: [
					{ url: "https://github.com/acme/app.git", branch: "main" },
				],
				excludeOwnerSecrets: true,
			},
			userId,
		);
		expect(e).toMatchObject({
			teamId,
			name: "prod",
			isDefault: false,
			revision: 1,
			sets,
			repositories: [
				{ url: "https://github.com/acme/app.git", branch: "main" },
			],
			excludeOwnerSecrets: true,
			updatedBy: userId,
		});
		expect(e.createdAt).toBeInstanceOf(Date);
		expect(e.updatedAt).toBeInstanceOf(Date);
		expect(await store.get(teamId, e.id)).toEqual(e);
		expect(await store.get(teamId, "prod")).toEqual(e);
		expect(keys.aads).toContain(`environment:${e.id}:v7`);

		const raw = await t.pool.query<{ ciphertext: Buffer; key_version: number }>(
			"SELECT ciphertext, key_version FROM identity.environments WHERE id = $1",
			[e.id],
		);
		const blob = raw.rows[0]?.ciphertext.toString("latin1") ?? "";
		expect(raw.rows[0]?.key_version).toBe(7);
		for (const v of ["sk-very-secret-value", "production", "OPENAI_API_KEY"]) {
			expect(blob).not.toContain(v);
		}
	});

	it("defaults to empty sets and an empty repository list", async () => {
		const teamId = await team();
		const e = await store.create(teamId, { name: "bare" }, null);
		expect(e).toMatchObject({
			sets: { env: {}, secrets: {}, secretFiles: [] },
			repositories: [],
			excludeOwnerSecrets: false,
			updatedBy: null,
		});
	});

	it("a duplicate name in the team is name_taken; another team may reuse it", async () => {
		const a = await team();
		const b = await team();
		await store.create(a, { name: "dup" }, null);
		expect(await codeOf(store.create(a, { name: "dup" }, null))).toBe(
			"name_taken",
		);
		await expect(store.create(b, { name: "dup" }, null)).resolves.toBeDefined();
		const other = await store.create(a, { name: "other" }, null);
		expect(await codeOf(store.patch(a, other.id, { name: "dup" }, null))).toBe(
			"name_taken",
		);
	});

	it("patch merges the sets, null deletes, repositories are replaced, revision+1", async () => {
		const teamId = await team();
		const e = await store.create(
			teamId,
			{ name: "dev", ...sets, repositories: [{ url: "https://x/a.git" }] },
			null,
		);
		const p = await store.patch(
			teamId,
			"dev",
			{
				env: { REGION: null, DEBUG: "1" },
				secrets: { OPENAI_API_KEY: null, TOKEN: "t" },
				secretFiles: {
					id_rsa: null,
					"config.json": { contentBase64: "e30=", linkPath: "/etc/app.json" },
				},
				repositories: [{ url: "https://x/b.git", path: "b" }],
				excludeOwnerSecrets: true,
			},
			userId,
		);
		expect(p).toMatchObject({
			id: e.id,
			revision: 2,
			sets: {
				env: { NODE_ENV: "production", DEBUG: "1" },
				secrets: { TOKEN: "t" },
				secretFiles: [
					{
						name: "config.json",
						contentBase64: "e30=",
						linkPath: "/etc/app.json",
					},
				],
			},
			repositories: [{ url: "https://x/b.git", path: "b" }],
			excludeOwnerSecrets: true,
			updatedBy: userId,
		});
		expect(p.updatedAt.getTime()).toBeGreaterThanOrEqual(e.updatedAt.getTime());
		expect(await store.get(teamId, e.id)).toEqual(p);
		// Rename keeps the id; the old name no longer resolves.
		const r = await store.patch(teamId, e.id, { name: "dev2" }, null);
		expect(r).toMatchObject({ id: e.id, name: "dev2", revision: 3 });
		expect(await store.get(teamId, "dev")).toBe(null);
	});

	it("only one default per team", async () => {
		const teamId = await team();
		expect(await store.getDefault(teamId)).toBe(null);
		const a = await store.create(teamId, { name: "a", isDefault: true }, null);
		expect((await store.getDefault(teamId))?.id).toBe(a.id);
		const b = await store.create(teamId, { name: "b", isDefault: true }, null);
		expect((await store.getDefault(teamId))?.id).toBe(b.id);
		expect((await store.get(teamId, "a"))?.isDefault).toBe(false);
		await store.patch(teamId, "a", { isDefault: true }, null);
		const list = await store.list(teamId);
		expect(list.filter((e) => e.isDefault).map((e) => e.name)).toEqual(["a"]);
		await store.patch(teamId, "a", { isDefault: false }, null);
		expect(await store.getDefault(teamId)).toBe(null);
		// Concurrent "make default" requests still leave exactly one default.
		await Promise.all(
			["a", "b"].map((n) => store.patch(teamId, n, { isDefault: true }, null)),
		);
		expect((await store.list(teamId)).filter((e) => e.isDefault)).toHaveLength(
			1,
		);
	});

	it("list returns the team's environments by name; other teams do not see them", async () => {
		const teamId = await team();
		const other = await team();
		await store.create(teamId, { name: "zeta" }, null);
		await store.create(teamId, { name: "alpha", ...sets }, null);
		const list = await store.list(teamId);
		expect(list.map((e) => e.name)).toEqual(["alpha", "zeta"]);
		expect(list[0]?.sets).toEqual(sets);
		expect(await store.list(other)).toEqual([]);
		expect(await store.get(other, "alpha")).toBe(null);
		expect(await store.get(other, list[0]?.id as string)).toBe(null);
		expect(
			await codeOf(store.patch(other, "alpha", { env: { A: "1" } }, null)),
		).toBe("not_found");
		expect(await codeOf(store.delete(other, "alpha"))).toBe("not_found");
	});

	it("delete removes the environment", async () => {
		const teamId = await team();
		const e = await store.create(teamId, { name: "gone" }, null);
		await store.delete(teamId, e.id);
		expect(await store.get(teamId, e.id)).toBe(null);
		expect(await codeOf(store.delete(teamId, "gone"))).toBe("not_found");
	});

	it("validateSets sees the merged sets and can reject them", async () => {
		const teamId = await team();
		const seen: SecretSets[] = [];
		const strict = new PgEnvironmentStore(t.pool, keys, {
			validateSets(s) {
				seen.push(s);
				if (Object.keys(s.env).length > 2) throw new Error("too many");
			},
		});
		await strict.create(teamId, { name: "v", env: { A: "1", B: "2" } }, null);
		await expect(
			strict.patch(teamId, "v", { env: { C: "3" } }, null),
		).rejects.toThrow("too many");
		expect(seen.at(-1)?.env).toEqual({ A: "1", B: "2", C: "3" });
		expect((await strict.get(teamId, "v"))?.revision).toBe(1);
		await strict.patch(teamId, "v", { env: { A: null, C: "3" } }, null);
		expect((await strict.get(teamId, "v"))?.sets.env).toEqual({
			B: "2",
			C: "3",
		});
	});

	it("an unknown team is not_found", async () => {
		expect(await codeOf(store.create(randomUUID(), { name: "x" }, null))).toBe(
			"not_found",
		);
	});
});
