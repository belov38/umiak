import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type ApiKeyRecord,
	IdentityError,
	type IdentityErrorCode,
	type IdentityStore,
	type NewApiKey,
} from "../src/identity.ts";

// Contract of IdentityStore (S7 §7.2, §7.4, §17.3; S8 §5.3, §6). Run against
// the Postgres stand-in here and against PayloadIdentityStore in S8. Every test
// uses fresh emails, subjects and teams, so the suite shares one database.

/** IdP group the store under test must treat as an operator group. */
export const CONTRACT_OPERATOR_GROUP = "sbx-contract-operators";

/** Direct writes the contract needs that IdentityStore does not offer. */
export interface IdentityContractSeeding {
	/** A user that never logged in (no `idpSubject`, no personal team). */
	seedUser(u: {
		email: string;
		name?: string;
		active?: boolean;
	}): Promise<string>;
	seedTeam(name: string): Promise<string>;
	addMember(
		userId: string,
		teamId: string,
		role: "owner" | "member",
	): Promise<void>;
	removeMember(userId: string, teamId: string): Promise<void>;
	setActive(userId: string, active: boolean): Promise<void>;
	/** Called once after the suite. */
	close?(): Promise<void>;
}

export type IdentityContractSubject = IdentityStore & IdentityContractSeeding;

function uniq(): string {
	return randomBytes(6).toString("hex");
}

function email(tag = "u"): string {
	return `${tag}-${uniq()}@example.com`;
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

function hash(): string {
	return randomBytes(32).toString("hex");
}

function newKey(teamId: string, createdByUserId: string | null): NewApiKey {
	return {
		teamId,
		name: `key-${uniq()}`,
		scopes: ["sandboxes:read", "commands:exec"],
		expiresAt: new Date(Date.now() + 90 * 86_400_000),
		createdByUserId,
		createdVia: "api",
		secretHash: hash(),
		prefix: "AbCdEfGh",
		last4: "wxyz",
	};
}

export function runIdentityStoreContract(
	name: string,
	make: () => Promise<IdentityContractSubject>,
): void {
	describe(`IdentityStore contract: ${name}`, () => {
		let s: IdentityContractSubject;

		beforeAll(async () => {
			s = await make();
		});
		afterAll(async () => {
			await s?.close?.();
		});

		describe("resolveSession", () => {
			it("JIT by sub creates the user and the personal team with role owner", async () => {
				const e = email();
				const sub = randomUUID();
				const r = await s.resolveSession({
					email: e,
					user: sub,
					groups: [],
					preferredUsername: "jit-user",
				});
				expect(r.user.email).toBe(e);
				expect(r.user.idpSubject).toBe(sub);
				expect(r.user.active).toBe(true);
				expect(r.user.name).toBe("jit-user");
				expect(r.user.id).toMatch(
					/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
				);
				expect(r.isOperator).toBe(false);
				expect(r.teams).toEqual([
					{ teamId: r.defaultTeamId, name: `${e}'s team`, role: "owner" },
				]);
				expect(r.user.defaultTeamId).toBe(r.defaultTeamId);
				const teamId = r.defaultTeamId as string;
				expect(await s.membership(r.user.id, teamId)).toEqual({
					role: "owner",
				});
				expect(await s.team(teamId)).toEqual({
					id: teamId,
					name: `${e}'s team`,
				});
				expect(await s.user(r.user.id)).toEqual(r.user);
			});

			it("prefers name over preferredUsername and lowercases the email", async () => {
				const e = email();
				const r = await s.resolveSession({
					email: e.toUpperCase(),
					user: randomUUID(),
					groups: [],
					preferredUsername: "nick",
					name: "Full Name",
				});
				expect(r.user.email).toBe(e);
				expect(r.user.name).toBe("Full Name");
			});

			it("the same sub with a new email is the same user, the email is updated", async () => {
				const sub = randomUUID();
				const first = await s.resolveSession({
					email: email(),
					user: sub,
					groups: [],
				});
				const e2 = email("renamed");
				const second = await s.resolveSession({
					email: e2,
					user: sub,
					groups: [],
				});
				expect(second.user.id).toBe(first.user.id);
				expect(second.user.email).toBe(e2);
				expect(second.teams.map((t) => t.teamId)).toEqual(
					first.teams.map((t) => t.teamId),
				);
			});

			it("a changed email that belongs to another signed-in user is identity_conflict", async () => {
				const taken = email("taken");
				await s.resolveSession({
					email: taken,
					user: randomUUID(),
					groups: [],
				});
				const sub = randomUUID();
				await s.resolveSession({ email: email(), user: sub, groups: [] });
				expect(
					await codeOf(
						s.resolveSession({ email: taken, user: sub, groups: [] }),
					),
				).toBe("identity_conflict");
			});

			it("the first login of a seeded user binds the subject and adds the personal team", async () => {
				const e = email("seeded");
				const id = await s.seedUser({ email: e, name: "Seeded" });
				const shared = await s.seedTeam(`shared-${uniq()}`);
				await s.addMember(id, shared, "member");
				const sub = randomUUID();
				const r = await s.resolveSession({ email: e, user: sub, groups: [] });
				expect(r.user.id).toBe(id);
				expect(r.user.idpSubject).toBe(sub);
				expect(r.user.name).toBe("Seeded");
				const personal = r.teams.find((t) => t.name === `${e}'s team`);
				expect(personal?.role).toBe("owner");
				expect(r.teams).toContainEqual({
					teamId: shared,
					name: expect.any(String),
					role: "member",
				});
				expect(r.defaultTeamId).toBe(personal?.teamId);
				// The next login by sub finds the same user, no second personal team.
				const again = await s.resolveSession({
					email: e,
					user: sub,
					groups: [],
				});
				expect(again.user.id).toBe(id);
				expect(again.teams).toHaveLength(2);
			});

			it("concurrent first logins of a seeded user bind it once", async () => {
				const e = email("seeded");
				const id = await s.seedUser({ email: e });
				const sub = randomUUID();
				const all = await Promise.all(
					Array.from({ length: 5 }, () =>
						s.resolveSession({ email: e, user: sub, groups: [] }),
					),
				);
				expect(new Set(all.map((r) => r.user.id))).toEqual(new Set([id]));
				const teams = new Set(all.flatMap((r) => r.teams.map((t) => t.teamId)));
				expect(teams.size).toBe(1);
				expect(all.every((r) => r.user.idpSubject === sub)).toBe(true);
			});

			it("a missing or empty sub is subject_required, also for a known email", async () => {
				const e = email();
				await s.seedUser({ email: e });
				for (const user of [undefined, "", "  "]) {
					const h =
						user === undefined
							? { email: e, groups: [] }
							: { email: e, user, groups: [] };
					expect(await codeOf(s.resolveSession(h))).toBe("subject_required");
				}
				expect(
					await codeOf(s.resolveSession({ email: email(), groups: [] })),
				).toBe("subject_required");
			});

			it("an email bound to another sub is identity_conflict", async () => {
				const e = email();
				await s.resolveSession({ email: e, user: randomUUID(), groups: [] });
				expect(
					await codeOf(
						s.resolveSession({ email: e, user: randomUUID(), groups: [] }),
					),
				).toBe("identity_conflict");
			});

			it("concurrent first logins create one user and one personal team", async () => {
				const e = email();
				const sub = randomUUID();
				const all = await Promise.all(
					Array.from({ length: 5 }, () =>
						s.resolveSession({ email: e, user: sub, groups: [] }),
					),
				);
				const ids = new Set(all.map((r) => r.user.id));
				expect(ids.size).toBe(1);
				const teams = new Set(all.flatMap((r) => r.teams.map((t) => t.teamId)));
				expect(teams.size).toBe(1);
			});

			it("isOperator follows the groups on every call", async () => {
				const e = email();
				const sub = randomUUID();
				const op = await s.resolveSession({
					email: e,
					user: sub,
					groups: ["devs", CONTRACT_OPERATOR_GROUP],
				});
				expect(op.isOperator).toBe(true);
				expect(op.user.isOperator).toBe(true);
				const plain = await s.resolveSession({
					email: e,
					user: sub,
					groups: ["devs"],
				});
				expect(plain.isOperator).toBe(false);
				expect((await s.user(op.user.id))?.isOperator).toBe(false);
			});

			it("a deactivated user is user_disabled", async () => {
				const e = email();
				const sub = randomUUID();
				const r = await s.resolveSession({ email: e, user: sub, groups: [] });
				await s.setActive(r.user.id, false);
				expect(
					await codeOf(s.resolveSession({ email: e, user: sub, groups: [] })),
				).toBe("user_disabled");
				expect((await s.user(r.user.id))?.active).toBe(false);
			});

			it("the default team falls back to the personal team after leaving it", async () => {
				const e = email();
				const sub = randomUUID();
				const r = await s.resolveSession({ email: e, user: sub, groups: [] });
				const personal = r.defaultTeamId as string;
				const other = await s.seedTeam(`other-${uniq()}`);
				await s.addMember(r.user.id, other, "member");
				await s.removeMember(r.user.id, other);
				const again = await s.resolveSession({
					email: e,
					user: sub,
					groups: [],
				});
				expect(again.defaultTeamId).toBe(personal);
				expect(again.teams.map((t) => t.teamId)).toEqual([personal]);
			});
		});

		describe("membership, team, user", () => {
			it("membership of a foreign team is null", async () => {
				const a = await s.resolveSession({
					email: email(),
					user: randomUUID(),
					groups: [],
				});
				const b = await s.resolveSession({
					email: email(),
					user: randomUUID(),
					groups: [],
				});
				expect(await s.membership(a.user.id, b.defaultTeamId as string)).toBe(
					null,
				);
			});

			it("unknown team and user are null", async () => {
				expect(await s.team(randomUUID())).toBe(null);
				expect(await s.user(randomUUID())).toBe(null);
				expect(await s.membership(randomUUID(), randomUUID())).toBe(null);
			});
		});

		describe("api keys", () => {
			async function owner(): Promise<{ userId: string; teamId: string }> {
				const r = await s.resolveSession({
					email: email("owner"),
					user: randomUUID(),
					groups: [],
				});
				return { userId: r.user.id, teamId: r.defaultTeamId as string };
			}

			it("createApiKey returns the record and findApiKeyByHash finds it", async () => {
				const o = await owner();
				const input = newKey(o.teamId, o.userId);
				const k = await s.createApiKey(input);
				expect(k).toMatchObject({
					kind: "team",
					sandboxId: null,
					teamId: o.teamId,
					name: input.name,
					secretHash: input.secretHash,
					prefix: "AbCdEfGh",
					last4: "wxyz",
					scopes: ["sandboxes:read", "commands:exec"],
					createdVia: "api",
					expiresAt: input.expiresAt,
					lastUsedAt: null,
					revokedAt: null,
				});
				expect(k.createdBy).toMatchObject({
					id: o.userId,
					active: true,
					member: true,
				});
				expect(k.createdAt).toBeInstanceOf(Date);
				expect(await s.findApiKeyByHash(input.secretHash)).toEqual(k);
				expect(await s.findApiKeyByHash(hash())).toBe(null);
			});

			it("a key without a creator has createdBy null", async () => {
				const o = await owner();
				const k = await s.createApiKey(newKey(o.teamId, null));
				expect(k.createdBy).toBe(null);
			});

			it("a revoked key is still found, with revokedAt", async () => {
				const o = await owner();
				const input = newKey(o.teamId, o.userId);
				const k = await s.createApiKey(input);
				await s.revokeApiKey(k.id, { userId: o.userId });
				const found = await s.findApiKeyByHash(input.secretHash);
				expect(found?.id).toBe(k.id);
				expect(found?.revokedAt).toBeInstanceOf(Date);
				// Revoking again keeps the first revocation.
				await s.revokeApiKey(k.id, { apiKeyId: k.id });
				expect((await s.findApiKeyByHash(input.secretHash))?.revokedAt).toEqual(
					found?.revokedAt,
				);
			});

			it("revoking an unknown key is not_found", async () => {
				expect(await codeOf(s.revokeApiKey(randomUUID(), {}))).toBe(
					"not_found",
				);
			});

			it("rotateApiKey replaces the secret and keeps id, scopes and expiry", async () => {
				const o = await owner();
				const input = newKey(o.teamId, o.userId);
				const k = await s.createApiKey(input);
				const next = { secretHash: hash(), prefix: "ZZZZZZZZ", last4: "0000" };
				const r = await s.rotateApiKey(k.id, next);
				expect(r).toMatchObject({
					id: k.id,
					scopes: k.scopes,
					expiresAt: k.expiresAt,
					...next,
				});
				expect(k.rotatedAt).toBe(null);
				expect(r.rotatedAt).toBeInstanceOf(Date);
				expect(await s.findApiKeyByHash(input.secretHash)).toBe(null);
				expect((await s.findApiKeyByHash(next.secretHash))?.id).toBe(k.id);
				expect(
					await codeOf(
						s.rotateApiKey(randomUUID(), { ...next, secretHash: hash() }),
					),
				).toBe("not_found");
			});

			it("apiKey returns the key by id (revoked too), null for an unknown id", async () => {
				const o = await owner();
				const k = await s.createApiKey(newKey(o.teamId, o.userId));
				expect(await s.apiKey(k.id)).toEqual(k);
				await s.revokeApiKey(k.id, {});
				expect((await s.apiKey(k.id))?.revokedAt).toBeInstanceOf(Date);
				expect(await s.apiKey(randomUUID())).toBe(null);
			});

			it("touchApiKey sets lastUsedAt", async () => {
				const o = await owner();
				const input = newKey(o.teamId, o.userId);
				const k = await s.createApiKey(input);
				await s.touchApiKey(k.id);
				const found = await s.findApiKeyByHash(input.secretHash);
				expect(found?.lastUsedAt).toBeInstanceOf(Date);
			});

			it("listApiKeys returns the team's keys and createdBy.member=false after the creator left", async () => {
				const o = await owner();
				const team = await s.seedTeam(`team-${uniq()}`);
				await s.addMember(o.userId, team, "owner");
				const k1 = await s.createApiKey(newKey(team, o.userId));
				const k2 = await s.createApiKey(newKey(team, null));
				await s.createApiKey(newKey(o.teamId, o.userId)); // another team
				await s.removeMember(o.userId, team);
				const list = await s.listApiKeys({ teamId: team });
				expect(list.map((k) => k.id).sort()).toEqual([k1.id, k2.id].sort());
				const created = list.find((k) => k.id === k1.id) as ApiKeyRecord;
				expect(created.createdBy).toMatchObject({
					id: o.userId,
					active: true,
					member: false,
				});
				// The key itself keeps working: still found and not revoked.
				expect((await s.findApiKeyByHash(created.secretHash))?.revokedAt).toBe(
					null,
				);
			});

			it("createdBy.active follows the creator's deactivation", async () => {
				const o = await owner();
				const input = newKey(o.teamId, o.userId);
				await s.createApiKey(input);
				await s.setActive(o.userId, false);
				const found = await s.findApiKeyByHash(input.secretHash);
				expect(found?.createdBy?.active).toBe(false);
				expect(found?.revokedAt).toBe(null);
			});
		});

		describe("ssh keys", () => {
			async function user(): Promise<string> {
				const r = await s.resolveSession({
					email: email(),
					user: randomUUID(),
					groups: [],
				});
				return r.user.id;
			}

			function sshKey(userId: string, fingerprint = `SHA256:${uniq()}`) {
				return {
					userId,
					name: `laptop-${uniq()}`,
					publicKey: `ssh-ed25519 AAAA${uniq()} laptop`,
					fingerprint,
					type: "ssh-ed25519",
				};
			}

			it("add, list, find by fingerprint, touch, remove", async () => {
				const u = await user();
				const input = sshKey(u);
				const k = await s.addSshKey(input);
				expect(k).toMatchObject({ ...input, lastUsedAt: null });
				expect(k.createdAt).toBeInstanceOf(Date);
				expect(await s.listSshKeys(u)).toEqual([k]);
				expect(await s.findSshKeyByFingerprint(input.fingerprint)).toEqual(k);
				await s.touchSshKey(k.id);
				expect(
					(await s.findSshKeyByFingerprint(input.fingerprint))?.lastUsedAt,
				).toBeInstanceOf(Date);
				await s.removeSshKey(u, k.id);
				expect(await s.listSshKeys(u)).toEqual([]);
				expect(await s.findSshKeyByFingerprint(input.fingerprint)).toBe(null);
			});

			it("a taken fingerprint is fingerprint_taken, also for another user", async () => {
				const u1 = await user();
				const u2 = await user();
				const fp = `SHA256:${uniq()}`;
				await s.addSshKey(sshKey(u1, fp));
				expect(await codeOf(s.addSshKey(sshKey(u1, fp)))).toBe(
					"fingerprint_taken",
				);
				expect(await codeOf(s.addSshKey(sshKey(u2, fp)))).toBe(
					"fingerprint_taken",
				);
			});

			it("removing another user's key is not_found and keeps the key", async () => {
				const u1 = await user();
				const u2 = await user();
				const k = await s.addSshKey(sshKey(u1));
				expect(await codeOf(s.removeSshKey(u2, k.id))).toBe("not_found");
				expect(await s.listSshKeys(u1)).toHaveLength(1);
				expect(await codeOf(s.removeSshKey(u1, randomUUID()))).toBe(
					"not_found",
				);
			});
		});
	});
}
