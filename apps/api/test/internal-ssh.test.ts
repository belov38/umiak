// SSH authorization of the gateway (S7 §12.1, S4 §9.2, §9.5, S8 C6): a
// registered key of a person or a login certificate (person or team key);
// active member of the sandbox's team without the operator exception, a live
// team key with ssh:connect; `recheck` skips the certificate's validity.
import { randomUUID } from "node:crypto";
import { encodeUuid, parseSshPublicKey } from "@sbx/auth";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceTokens } from "../src/index.ts";
import { issueApiKey } from "../src/testing/index.ts";
import type { Harness, HarnessResponse } from "./helpers/harness.ts";
import { ed25519PublicKey } from "./helpers/ssh.ts";
import { type ApiWorld, apiWorld } from "./helpers/world.ts";

// biome-ignore lint/suspicious/noExplicitAny: internal answers are not in the document
type Body = any;
const body = (r: HarnessResponse): Body => r.body as Body;

const GW = "gw-token-ssh-0123456789abcdef";
const PATH = "/internal/v1/gateway/ssh/authorize";
const DENIED = { allowed: false };

describe.skipIf(skipPg())("POST /internal/v1/gateway/ssh/authorize", () => {
	let db: TestDatabase;
	let w: ApiWorld;
	let h: Harness;

	beforeAll(async () => {
		db = await createTestDatabase({ max: 20 });
		w = await apiWorld(db.pool);
		h = w.harness({
			listener: "internal",
			bearer: GW,
			deps: { serviceTokens: new ServiceTokens({ gateway: [GW] }) },
		});
	});
	afterAll(async () => {
		await w?.close();
		await db?.drop();
	});

	const authorize = (json: unknown) => h.request("POST", PATH, { json });

	/** A person stored in identity.users, by default a member of the world's team. */
	async function person(o: { member?: boolean; operator?: boolean } = {}) {
		const email = `p-${randomUUID()}@example.com`;
		const r = await db.pool.query<{ id: string }>(
			"INSERT INTO identity.users (email, is_operator) VALUES ($1, $2) RETURNING id",
			[email, o.operator ?? false],
		);
		const userId = r.rows[0]?.id as string;
		if (o.member ?? true) {
			await db.pool.query(
				"INSERT INTO identity.memberships (user_id, team_id, role) VALUES ($1, $2, 'member')",
				[userId, w.teamId],
			);
		}
		return { userId, email };
	}

	/** A registered SSH key of the user; `line` is what the gateway sends. */
	async function registered(userId: string) {
		const line = ed25519PublicKey();
		const k = parseSshPublicKey(line);
		const rec = await w.identity.addSshKey({
			userId,
			name: "laptop",
			publicKey: `${k.type} ${k.blob.toString("base64")}`,
			fingerprint: k.fingerprint,
			type: k.type,
		});
		return { line, fingerprint: k.fingerprint, id: rec.id };
	}

	function cert(keyId: string, sandboxId: string, validBefore = soon()) {
		return {
			keyId,
			serial: "42",
			principal: encodeUuid("sandbox", sandboxId),
			validBefore,
		};
	}

	function soon(): string {
		return new Date(Date.now() + 9 * 60_000)
			.toISOString()
			.replace(/\.\d+Z$/, "Z");
	}

	const userKeyId = (userId: string) =>
		`sbx:user:${encodeUuid("user", userId)}`;
	const teamKeyId = (keyId: string) => `sbx:key:${encodeUuid("apiKey", keyId)}`;

	async function sshKeyUsed(id: string): Promise<Date | null> {
		const r = await db.pool.query<{ last_used_at: Date | null }>(
			"SELECT last_used_at FROM identity.ssh_keys WHERE id = $1",
			[id],
		);
		return r.rows[0]?.last_used_at ?? null;
	}

	async function apiKeyUsed(id: string): Promise<Date | null> {
		const r = await db.pool.query<{ last_used_at: Date | null }>(
			"SELECT last_used_at FROM identity.api_keys WHERE id = $1",
			[id],
		);
		return r.rows[0]?.last_used_at ?? null;
	}

	describe("a registered key", () => {
		it("an active member: allowed with the full answer, public ids and teamId; lastUsedAt at most once a minute", async () => {
			const s = await w.seed({ state: "ready" });
			const u = await person();
			const k = await registered(u.userId);
			const r = await authorize({
				sandbox: s.slug,
				publicKey: k.line,
				fingerprint: k.fingerprint,
			});
			expect(r.status, r.text).toBe(200);
			const usr = encodeUuid("user", u.userId);
			expect(body(r)).toEqual({
				allowed: true,
				actor: { kind: "user", userId: usr, email: u.email },
				userId: usr,
				email: u.email,
				sandboxId: encodeUuid("sandbox", s.sandboxId),
				machineId: s.machineId,
				sandboxState: "ready",
				loginUser: "user",
				teamId: encodeUuid("team", w.teamId),
			});
			const first = await sshKeyUsed(k.id);
			expect(first).not.toBeNull();
			await authorize({
				sandbox: s.slug,
				publicKey: k.line,
				fingerprint: k.fingerprint,
			});
			expect(await sshKeyUsed(k.id)).toEqual(first);
		});

		it("the sandbox by sb_ id; a bare UUID, an unknown or a deleted sandbox is denied", async () => {
			const s = await w.seed({ state: "stopped" });
			const u = await person();
			const k = await registered(u.userId);
			const req = { publicKey: k.line, fingerprint: k.fingerprint };
			const ok = await authorize({
				...req,
				sandbox: encodeUuid("sandbox", s.sandboxId),
			});
			expect(body(ok)).toMatchObject({
				allowed: true,
				sandboxState: "stopped",
			});
			for (const sandbox of [
				s.sandboxId,
				"unknown-box",
				encodeUuid("sandbox", randomUUID()),
			]) {
				expect(body(await authorize({ ...req, sandbox })), sandbox).toEqual(
					DENIED,
				);
			}
			await w.markState(s.sandboxId, "deleted");
			expect(body(await authorize({ ...req, sandbox: s.slug }))).toEqual(
				DENIED,
			);
		});

		it("a stored fingerprint with another public key is denied", async () => {
			const s = await w.seed({ state: "ready" });
			const u = await person();
			const k = await registered(u.userId);
			const r = await authorize({
				sandbox: s.slug,
				publicKey: ed25519PublicKey(),
				fingerprint: k.fingerprint,
			});
			expect(body(r)).toEqual(DENIED);
			expect(await sshKeyUsed(k.id)).toBeNull();
		});

		it("an unknown fingerprint or a broken public key is denied", async () => {
			const s = await w.seed({ state: "ready" });
			const u = await person();
			const k = await registered(u.userId);
			expect(
				body(
					await authorize({
						sandbox: s.slug,
						publicKey: k.line,
						fingerprint: "SHA256:nope",
					}),
				),
			).toEqual(DENIED);
			expect(
				body(
					await authorize({
						sandbox: s.slug,
						publicKey: "ssh-ed25519 garbage",
						fingerprint: k.fingerprint,
					}),
				),
			).toEqual(DENIED);
		});

		it("a deactivated user, a non-member and a non-member operator are denied", async () => {
			const s = await w.seed({ state: "ready" });
			const off = await person();
			const offKey = await registered(off.userId);
			await db.pool.query(
				"UPDATE identity.users SET active = false WHERE id = $1",
				[off.userId],
			);
			const outsider = await person({ member: false });
			const operator = await person({ member: false, operator: true });
			for (const u of [
				offKey,
				await registered(outsider.userId),
				await registered(operator.userId),
			]) {
				const r = await authorize({
					sandbox: s.slug,
					publicKey: u.line,
					fingerprint: u.fingerprint,
				});
				expect(body(r)).toEqual(DENIED);
			}
		});
	});

	describe("a certificate", () => {
		it("of a person: allowed; the principal of another sandbox is denied", async () => {
			const s = await w.seed({ state: "ready" });
			const other = await w.seed({ state: "ready" });
			const u = await person();
			const ok = await authorize({
				sandbox: s.slug,
				certificate: cert(userKeyId(u.userId), s.sandboxId),
			});
			expect(body(ok)).toMatchObject({
				allowed: true,
				actor: { kind: "user", userId: encodeUuid("user", u.userId) },
				teamId: encodeUuid("team", w.teamId),
			});
			const r = await authorize({
				sandbox: s.slug,
				certificate: cert(userKeyId(u.userId), other.sandboxId),
			});
			expect(body(r)).toEqual(DENIED);
		});

		it("of a person: deactivated, non-member and non-member operator are denied", async () => {
			const s = await w.seed({ state: "ready" });
			const off = await person();
			await db.pool.query(
				"UPDATE identity.users SET active = false WHERE id = $1",
				[off.userId],
			);
			const outsider = await person({ member: false });
			const operator = await person({ member: false, operator: true });
			for (const u of [off, outsider, operator]) {
				const r = await authorize({
					sandbox: s.slug,
					certificate: cert(userKeyId(u.userId), s.sandboxId),
				});
				expect(body(r)).toEqual(DENIED);
			}
		});

		it("of a team key: allowed with actor team_key, userId and email null; lastUsedAt set", async () => {
			const s = await w.seed({ state: "ready" });
			const k = await w.key(["ssh:connect"]);
			const r = await authorize({
				sandbox: s.slug,
				certificate: cert(teamKeyId(k.id), s.sandboxId),
			});
			expect(body(r)).toEqual({
				allowed: true,
				actor: { kind: "team_key", apiKeyId: encodeUuid("apiKey", k.id) },
				userId: null,
				email: null,
				sandboxId: encodeUuid("sandbox", s.sandboxId),
				machineId: s.machineId,
				sandboxState: "ready",
				loginUser: "user",
				teamId: encodeUuid("team", w.teamId),
			});
			expect(await apiKeyUsed(k.id)).not.toBeNull();
		});

		it("a revoked key, an expired key, a key without ssh:connect and a key of another team are denied", async () => {
			const s = await w.seed({ state: "ready" });
			const revoked = await w.key(["ssh:connect"]);
			await w.identity.revokeApiKey(revoked.id, {});
			const expired = await w.key(["ssh:connect"]);
			await db.pool.query(
				"UPDATE identity.api_keys SET expires_at = now() - interval '1 second' WHERE id = $1",
				[expired.id],
			);
			const noScope = await w.key(["sandboxes:read"]);
			const otherTeam = randomUUID();
			await db.pool.query(
				"INSERT INTO identity.teams (id, name) VALUES ($1, $2)",
				[otherTeam, `other-${otherTeam}`],
			);
			const foreign = await issueApiKey(w.identity, {
				teamId: otherTeam,
				scopes: ["ssh:connect"],
			});
			for (const id of [revoked.id, expired.id, noScope.id, foreign.key.id]) {
				const r = await authorize({
					sandbox: s.slug,
					certificate: cert(teamKeyId(id), s.sandboxId),
				});
				expect(body(r), id).toEqual(DENIED);
			}
		});

		it("a malformed keyId is denied", async () => {
			const s = await w.seed({ state: "ready" });
			const u = await person();
			for (const keyId of [
				"",
				`sbx:usr:${encodeUuid("user", u.userId)}`,
				`sbx:user:${u.userId}`,
				`sbx:key:${encodeUuid("user", u.userId)}`,
				`sbx:user:${encodeUuid("user", u.userId)}:x`,
			]) {
				const r = await authorize({
					sandbox: s.slug,
					certificate: cert(keyId, s.sandboxId),
				});
				expect(body(r), keyId).toEqual(DENIED);
			}
		});

		it("an expired certificate is denied on login and allowed on recheck; recheck still checks the identity and touches nothing", async () => {
			const s = await w.seed({ state: "ready" });
			const u = await person();
			const k = await w.key(["ssh:connect"]);
			const past = new Date(Date.now() - 30 * 60_000).toISOString();
			const userCert = cert(userKeyId(u.userId), s.sandboxId, past);
			const keyCert = cert(teamKeyId(k.id), s.sandboxId, past);

			expect(
				body(await authorize({ sandbox: s.slug, certificate: userCert })),
			).toEqual(DENIED);
			const r = await authorize({
				sandbox: s.slug,
				certificate: keyCert,
				recheck: true,
			});
			expect(body(r)).toMatchObject({
				allowed: true,
				actor: { kind: "team_key" },
				teamId: encodeUuid("team", w.teamId),
			});
			expect(await apiKeyUsed(k.id)).toBeNull();
			expect(
				body(
					await authorize({
						sandbox: s.slug,
						certificate: userCert,
						recheck: true,
					}),
				),
			).toMatchObject({ allowed: true });

			await db.pool.query(
				"DELETE FROM identity.memberships WHERE user_id = $1",
				[u.userId],
			);
			await w.identity.revokeApiKey(k.id, {});
			for (const certificate of [userCert, keyCert]) {
				const d = await authorize({
					sandbox: s.slug,
					certificate,
					recheck: true,
				});
				expect(body(d)).toEqual(DENIED);
			}
		});

		it("a validBefore that is not a timestamp is denied on login", async () => {
			const s = await w.seed({ state: "ready" });
			const u = await person();
			const r = await authorize({
				sandbox: s.slug,
				certificate: cert(userKeyId(u.userId), s.sandboxId, "soon"),
			});
			expect(body(r)).toEqual(DENIED);
		});
	});

	it("a registered key on recheck does not touch lastUsedAt", async () => {
		const s = await w.seed({ state: "ready" });
		const u = await person();
		const k = await registered(u.userId);
		const r = await authorize({
			sandbox: s.slug,
			publicKey: k.line,
			fingerprint: k.fingerprint,
			recheck: true,
		});
		expect(body(r)).toMatchObject({ allowed: true });
		expect(await sshKeyUsed(k.id)).toBeNull();
	});

	it("a body with neither or both credentials is 400 validation", async () => {
		const s = await w.seed({ state: "ready" });
		for (const json of [
			{ sandbox: s.slug },
			{ sandbox: s.slug, publicKey: ed25519PublicKey() },
			{
				sandbox: s.slug,
				publicKey: ed25519PublicKey(),
				fingerprint: "SHA256:x",
				certificate: cert("sbx:user:x", s.sandboxId),
			},
			{ publicKey: ed25519PublicKey(), fingerprint: "SHA256:x" },
		]) {
			const r = await authorize(json);
			expect(r.status, JSON.stringify(json)).toBe(400);
			expect(body(r).code).toBe("validation");
		}
	});
});
