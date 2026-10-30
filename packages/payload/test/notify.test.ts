import { randomBytes, randomUUID } from "node:crypto";
import { encodeUuid } from "@sbx/auth";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import {
	commitTransaction,
	createLocalReq,
	initTransaction,
	killTransaction,
	type Payload,
} from "payload";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateSbxPayload, notify } from "../src/index.ts";
import { closePayload, Listener, type Note, openPayload } from "./helpers.ts";

const pub = (kind: "user" | "team" | "apiKey", id: string | number) =>
	encodeUuid(kind, String(id));

const CHANNELS = ["sbx_identity", "sbx_config", "sbx_routes", "sbx_ssh_revoke"];

describe.skipIf(skipPg())("NOTIFY from Payload hooks", () => {
	let t: TestDatabase;
	let payload: Payload;
	let listener: Listener;

	const only = (notes: Note[], channel: string) =>
		notes.filter((n) => n.channel === channel).map((n) => n.payload);

	async function user(data: Record<string, unknown> = {}) {
		return payload.create({
			collection: "users",
			data: { email: `u-${randomUUID()}@example.com`, ...data },
		});
	}

	async function team(name = "t") {
		return payload.create({ collection: "teams", data: { name } });
	}

	async function apiKey(teamId: string | number) {
		return payload.create({
			collection: "api-keys",
			data: {
				name: "k",
				team: teamId,
				kind: "team",
				secretHash: randomBytes(32).toString("hex"),
				prefix: "sbx_key_x",
				last4: "abcd",
				scopes: ["sandboxes:read"],
				expiresAt: new Date(Date.now() + 86400_000).toISOString(),
				createdVia: "api",
			},
		});
	}

	beforeAll(async () => {
		t = await createTestDatabase({ migrated: false, max: 2 });
		payload = await openPayload(t.url);
		await migrateSbxPayload(payload);
		listener = new Listener(t.url);
		await listener.start(CHANNELS);
	});
	afterAll(async () => {
		await listener?.stop();
		if (t) await closePayload(t.url);
		await t?.drop();
	});
	beforeEach(async () => {
		await listener.settle();
		listener.onNote(null);
		listener.clear();
	});

	describe("transactions", () => {
		it("a change in a request transaction notifies only after commit; the listener reads the new data", async () => {
			const u = await user({ name: "old" });
			await listener.settle();
			listener.clear();
			const seen: unknown[] = [];
			listener.onNote(async (n) => {
				if (n.payload !== `users:${u.id}`) return;
				const r = await listener.client.query(
					"SELECT name FROM payload.users WHERE id = $1",
					[u.id],
				);
				seen.push(r.rows[0]?.name);
			});

			const req = await createLocalReq({}, payload);
			expect(await initTransaction(req)).toBe(true);
			await payload.update({
				collection: "users",
				id: u.id,
				data: { name: "new" },
				req,
			});
			expect(only(await listener.settle(), "sbx_identity")).toEqual([]);

			await commitTransaction(req);
			await listener.waitFor((n) => n.payload === `users:${u.id}`);
			await expect.poll(() => seen).toEqual(["new"]);
		});

		it("a killed transaction sends nothing", async () => {
			const u = await user();
			const tm = await team();
			await listener.settle();
			listener.clear();
			const req = await createLocalReq({}, payload);
			await initTransaction(req);
			await payload.update({
				collection: "users",
				id: u.id,
				data: { active: false },
				req,
			});
			await payload.update({
				collection: "teams",
				id: tm.id,
				data: { quota: { maxActiveSandboxes: 1 } },
				req,
			});
			await killTransaction(req);
			expect(await listener.settle()).toEqual([]);
			const back = await payload.findByID({ collection: "users", id: u.id });
			expect(back.active).toBe(true);
		});

		it("a Local API call without req notifies after its own transaction", async () => {
			const u = await user();
			await listener.settle();
			listener.clear();
			await payload.update({
				collection: "users",
				id: u.id,
				data: { name: "x" },
			});
			expect(only(await listener.settle(), "sbx_identity")).toEqual([
				`users:${u.id}`,
			]);
		});

		it("notify without a transaction sends at once", async () => {
			const req = await createLocalReq({}, payload);
			expect(req.transactionID).toBeUndefined();
			await notify(req, "sbx_config", "sizes:probe");
			expect(only(await listener.settle(), "sbx_config")).toEqual([
				"sizes:probe",
			]);
		});

		it("a failed NOTIFY aborts the write", async () => {
			const u = await user({ name: "before" });
			const req = await createLocalReq({}, payload);
			await initTransaction(req);
			await payload.update({
				collection: "users",
				id: u.id,
				data: { name: "after" },
				req,
			});
			// pg_notify refuses payloads of 8000 bytes and more.
			await expect(
				notify(req, "sbx_identity", "x".repeat(9000)),
			).rejects.toThrow();
			await killTransaction(req);
			const back = await payload.findByID({ collection: "users", id: u.id });
			expect(back.name).toBe("before");
		});
	});

	describe("sbx_identity", () => {
		it("users, teams, memberships, api-keys, ssh-keys notify '<collection>:<uuid>'", async () => {
			const u = await user();
			const tm = await team();
			const m = await payload.create({
				collection: "memberships",
				data: { user: u.id, team: tm.id, role: "owner" },
			});
			const k = await apiKey(tm.id);
			const s = await payload.create({
				collection: "ssh-keys",
				data: {
					user: u.id,
					name: "laptop",
					publicKey: "ssh-ed25519 AAAA test",
					fingerprint: `SHA256:${randomUUID()}`,
					type: "ssh-ed25519",
				},
			});
			const ids = only(await listener.settle(), "sbx_identity");
			expect(ids).toEqual([
				`users:${u.id}`,
				`teams:${tm.id}`,
				`memberships:${m.id}`,
				`api-keys:${k.id}`,
				`ssh-keys:${s.id}`,
			]);
			listener.clear();
			await payload.delete({ collection: "ssh-keys", id: s.id });
			expect(only(await listener.settle(), "sbx_identity")).toEqual([
				`ssh-keys:${s.id}`,
			]);
		});

		it("touching lastUsedAt or lastLoginAt sends no sbx_identity", async () => {
			const u = await user();
			const tm = await team();
			const k = await apiKey(tm.id);
			const s = await payload.create({
				collection: "ssh-keys",
				data: {
					user: u.id,
					name: "laptop",
					publicKey: "ssh-ed25519 AAAA test",
					fingerprint: `SHA256:${randomUUID()}`,
					type: "ssh-ed25519",
				},
			});
			await listener.settle();
			listener.clear();
			const now = new Date().toISOString();
			await payload.update({
				collection: "api-keys",
				id: k.id,
				data: { lastUsedAt: now },
			});
			await payload.update({
				collection: "ssh-keys",
				id: s.id,
				data: { lastUsedAt: now },
			});
			await payload.update({
				collection: "users",
				id: u.id,
				data: { lastLoginAt: now },
			});
			expect(await listener.settle()).toEqual([]);
			await payload.update({
				collection: "api-keys",
				id: k.id,
				data: { name: "renamed" },
			});
			expect(only(await listener.settle(), "sbx_identity")).toEqual([
				`api-keys:${k.id}`,
			]);
		});
	});

	describe("sbx_config and sbx_routes", () => {
		it("templates, sizes and pool targets notify '<collection>:<uuid>'", async () => {
			const size = await payload.create({
				collection: "sizes",
				data: { slug: "4gb", vcpu: 2, memoryMb: 4096 },
			});
			const tpl = await payload.create({
				collection: "templates",
				data: {
					slug: "win",
					os: "windows",
					defaultSize: "4gb",
					allowedSizes: ["4gb"],
				},
			});
			const pt = await payload.create({
				collection: "pool-targets",
				data: { template: "win", size: "4gb", target: 0 },
			});
			await payload.delete({ collection: "pool-targets", id: pt.id });
			expect(only(await listener.settle(), "sbx_config")).toEqual([
				`sizes:${size.id}`,
				`templates:${tpl.id}`,
				`pool-targets:${pt.id}`,
				`pool-targets:${pt.id}`,
			]);
		});

		it("teams notify sbx_config only when the quota changes", async () => {
			const tm = await team();
			await listener.settle();
			listener.clear();
			await payload.update({
				collection: "teams",
				id: tm.id,
				data: { name: "renamed" },
			});
			let notes = await listener.settle();
			expect(only(notes, "sbx_config")).toEqual([]);
			expect(only(notes, "sbx_identity")).toEqual([`teams:${tm.id}`]);
			listener.clear();
			await payload.update({
				collection: "teams",
				id: tm.id,
				data: { quota: { maxRamMb: 1024 } },
			});
			notes = await listener.settle();
			expect(only(notes, "sbx_config")).toEqual([`teams:${tm.id}`]);
		});

		it("platform-defaults: publicPortsEnabled sends sbx_config and sbx_routes '*'", async () => {
			await payload.updateGlobal({
				slug: "platform-defaults",
				data: { publicPortsEnabled: false },
			});
			let notes = await listener.settle();
			expect(only(notes, "sbx_config")).toEqual(["platform-defaults:global"]);
			expect(only(notes, "sbx_routes")).toEqual(["*"]);
			listener.clear();
			await payload.updateGlobal({
				slug: "platform-defaults",
				data: { idleTimeoutSeconds: 600 },
			});
			notes = await listener.settle();
			expect(only(notes, "sbx_config")).toEqual(["platform-defaults:global"]);
			expect(only(notes, "sbx_routes")).toEqual([]);
			await payload.updateGlobal({
				slug: "platform-defaults",
				data: { publicPortsEnabled: true, idleTimeoutSeconds: 900 },
			});
		});

		it("ssoPortPolicy any -> team bumps ssoPolicyEpoch and sends sbx_routes '*'", async () => {
			const before = await payload.findGlobal({ slug: "platform-defaults" });
			expect(before.ssoPortPolicy).toBe("any");
			const epoch = before.ssoPolicyEpoch as number;
			await payload.updateGlobal({
				slug: "platform-defaults",
				data: { ssoPortPolicy: "team" },
			});
			let d = await payload.findGlobal({ slug: "platform-defaults" });
			expect(d.ssoPolicyEpoch).toBe(epoch + 1);
			expect(only(await listener.settle(), "sbx_routes")).toEqual(["*"]);
			listener.clear();
			// team -> any opens access: no new epoch is needed.
			await payload.updateGlobal({
				slug: "platform-defaults",
				data: { ssoPortPolicy: "any" },
			});
			d = await payload.findGlobal({ slug: "platform-defaults" });
			expect(d.ssoPolicyEpoch).toBe(epoch + 1);
			expect(only(await listener.settle(), "sbx_routes")).toEqual(["*"]);
			// The epoch is owned by the hook: a direct write is ignored.
			await payload.updateGlobal({
				slug: "platform-defaults",
				data: { ssoPolicyEpoch: 0 },
			});
			d = await payload.findGlobal({ slug: "platform-defaults" });
			expect(d.ssoPolicyEpoch).toBe(epoch + 1);
		});
	});

	describe("sbx_ssh_revoke", () => {
		it("a deactivated user -> 'user:usr_…'", async () => {
			const u = await user();
			await listener.settle();
			listener.clear();
			await payload.update({
				collection: "users",
				id: u.id,
				data: { active: false, deactivatedReason: "operator" },
			});
			expect(only(await listener.settle(), "sbx_ssh_revoke")).toEqual([
				`user:${pub("user", u.id)}`,
			]);
			listener.clear();
			await payload.update({
				collection: "users",
				id: u.id,
				data: { name: "still off" },
			});
			expect(only(await listener.settle(), "sbx_ssh_revoke")).toEqual([]);
		});

		it("a deleted membership -> 'member:team_…:usr_…'", async () => {
			const u = await user();
			const tm = await team();
			await payload.create({
				collection: "memberships",
				data: { user: (await user()).id, team: tm.id, role: "owner" },
			});
			const m = await payload.create({
				collection: "memberships",
				data: { user: u.id, team: tm.id, role: "member" },
			});
			await listener.settle();
			listener.clear();
			await payload.delete({ collection: "memberships", id: m.id });
			const notes = await listener.settle();
			expect(only(notes, "sbx_ssh_revoke")).toEqual([
				`member:${pub("team", tm.id)}:${pub("user", u.id)}`,
			]);
			expect(only(notes, "sbx_identity")).toEqual([`memberships:${m.id}`]);
		});

		it("a revoked key -> 'key:key_…'; a rotated live key too", async () => {
			const tm = await team();
			const k1 = await apiKey(tm.id);
			const k2 = await apiKey(tm.id);
			await listener.settle();
			listener.clear();
			await payload.update({
				collection: "api-keys",
				id: k1.id,
				data: { revokedAt: new Date().toISOString() },
			});
			await payload.update({
				collection: "api-keys",
				id: k2.id,
				data: {
					secretHash: randomBytes(32).toString("hex"),
					rotatedAt: new Date().toISOString(),
				},
			});
			expect(only(await listener.settle(), "sbx_ssh_revoke")).toEqual([
				`key:${pub("apiKey", k1.id)}`,
				`key:${pub("apiKey", k2.id)}`,
			]);
			listener.clear();
			// Already revoked: no second revoke.
			await payload.update({
				collection: "api-keys",
				id: k1.id,
				data: { secretHash: randomBytes(32).toString("hex") },
			});
			expect(only(await listener.settle(), "sbx_ssh_revoke")).toEqual([]);
		});

		it("a deleted shared team -> 'team:team_…', revokes and deletes in one transaction", async () => {
			const u = await user();
			const tm = await team("shared");
			const m = await payload.create({
				collection: "memberships",
				data: { user: u.id, team: tm.id, role: "owner" },
			});
			const k = await apiKey(tm.id);
			await listener.settle();
			listener.clear();
			await payload.delete({ collection: "teams", id: tm.id });
			const notes = await listener.settle();
			expect(only(notes, "sbx_ssh_revoke").sort()).toEqual(
				[
					`member:${pub("team", tm.id)}:${pub("user", u.id)}`,
					`key:${pub("apiKey", k.id)}`,
					`team:${pub("team", tm.id)}`,
				].sort(),
			);
			expect(only(notes, "sbx_identity").sort()).toEqual(
				[`memberships:${m.id}`, `api-keys:${k.id}`, `teams:${tm.id}`].sort(),
			);
			expect(only(notes, "sbx_config")).toEqual([`teams:${tm.id}`]);
		});
	});
});
