import { randomBytes, randomUUID } from "node:crypto";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { APIError, Forbidden, type Payload, ValidationError } from "payload";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DELETE_TEAM_HEADER, migrateSbxPayload } from "../src/index.ts";
import { closePayload, openPayload } from "./helpers.ts";

describe.skipIf(skipPg())("collection rules", () => {
	let t: TestDatabase;
	let payload: Payload;
	// biome-ignore lint/suspicious/noExplicitAny: Local API user documents are untyped here.
	let operator: any;

	const apiError = async (p: Promise<unknown>, message: string) => {
		const err = await p.then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(APIError);
		expect((err as APIError).message).toBe(message);
		expect((err as APIError).status).toBe(400);
	};

	const forbidden = (p: Promise<unknown>) =>
		expect(p).rejects.toBeInstanceOf(Forbidden);

	const validation = async (p: Promise<unknown>, path: string) => {
		const err = await p.then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(ValidationError);
		const paths = (err as ValidationError).data.errors.map((e) => e.path);
		expect(paths).toContain(path);
	};

	async function user(data: Record<string, unknown> = {}) {
		return payload.create({
			collection: "users",
			data: { email: `u-${randomUUID()}@example.com`, ...data },
		});
	}

	async function team(data: Record<string, unknown> = {}) {
		return payload.create({
			collection: "teams",
			data: { name: "t", ...data },
		});
	}

	async function member(teamId: string | number, role: "owner" | "member") {
		return payload.create({
			collection: "memberships",
			data: { user: (await user()).id, team: teamId, role },
		});
	}

	function keyData(teamId: string | number | null) {
		return {
			name: "k",
			team: teamId as string | number,
			kind: "team" as const,
			secretHash: randomBytes(32).toString("hex"),
			prefix: "sbx_key_x",
			last4: "abcd",
			scopes: ["sandboxes:read"],
			expiresAt: new Date(Date.now() + 86400_000).toISOString(),
			createdVia: "api" as const,
		};
	}

	const count = async (
		collection: "memberships" | "team-notices" | "teams",
		where: Record<string, unknown>,
	) =>
		(
			await payload.count({
				collection,
				// biome-ignore lint/suspicious/noExplicitAny: test where clauses.
				where: where as any,
			})
		).totalDocs;

	beforeAll(async () => {
		t = await createTestDatabase({ migrated: false, max: 2 });
		payload = await openPayload(t.url);
		await migrateSbxPayload(payload);
		operator = {
			...(await user({ isOperator: true })),
			collection: "users",
		};
	});
	afterAll(async () => {
		if (t) await closePayload(t.url);
		await t?.drop();
	});

	describe("memberships: the last owner", () => {
		it("cannot be demoted or deleted", async () => {
			const tm = await team();
			const owner = await member(tm.id, "owner");
			await member(tm.id, "member");
			await apiError(
				payload.update({
					collection: "memberships",
					id: owner.id,
					data: { role: "member" },
				}),
				"last_owner",
			);
			await apiError(
				payload.delete({ collection: "memberships", id: owner.id }),
				"last_owner",
			);
			const back = await payload.findByID({
				collection: "memberships",
				id: owner.id,
			});
			expect(back.role).toBe("owner");
		});

		it("with two owners one can go, the second then is the last", async () => {
			const tm = await team();
			const a = await member(tm.id, "owner");
			const b = await member(tm.id, "owner");
			await payload.update({
				collection: "memberships",
				id: a.id,
				data: { role: "member" },
			});
			await apiError(
				payload.delete({ collection: "memberships", id: b.id }),
				"last_owner",
			);
			await payload.update({
				collection: "memberships",
				id: a.id,
				data: { role: "owner" },
			});
			await payload.delete({ collection: "memberships", id: b.id });
			expect(await count("memberships", { team: { equals: tm.id } })).toBe(1);
		});

		it("a member is deleted freely", async () => {
			const tm = await team();
			await member(tm.id, "owner");
			const m = await member(tm.id, "member");
			await payload.delete({ collection: "memberships", id: m.id });
		});

		it("bulk delete by where is refused, owners stay", async () => {
			const tm = await team();
			await member(tm.id, "owner");
			await member(tm.id, "owner");
			await forbidden(
				payload.delete({
					collection: "memberships",
					where: { team: { equals: tm.id } },
					overrideAccess: false,
					user: operator,
				}),
			);
			expect(
				await count("memberships", {
					and: [{ team: { equals: tm.id } }, { role: { equals: "owner" } }],
				}),
			).toBe(2);
		});

		it("bulk update by where is refused, owners stay", async () => {
			const tm = await team();
			await member(tm.id, "owner");
			await member(tm.id, "owner");
			await forbidden(
				payload.update({
					collection: "memberships",
					where: { team: { equals: tm.id } },
					data: { role: "member" },
					overrideAccess: false,
					user: operator,
				}),
			);
			expect(
				await count("memberships", {
					and: [{ team: { equals: tm.id } }, { role: { equals: "owner" } }],
				}),
			).toBe(2);
		});
	});

	describe("memberships: user and team are fixed", () => {
		it("the Local API refuses a change of team or user", async () => {
			const tm = await team();
			const other = await team();
			await member(tm.id, "owner");
			const m = await member(tm.id, "member");
			await apiError(
				payload.update({
					collection: "memberships",
					id: m.id,
					data: { team: other.id },
				}),
				"membership_immutable",
			);
			await apiError(
				payload.update({
					collection: "memberships",
					id: m.id,
					data: { user: (await user()).id },
				}),
				"membership_immutable",
			);
			// Same values and other fields are fine.
			await payload.update({
				collection: "memberships",
				id: m.id,
				data: { team: tm.id, role: "owner" },
			});
		});

		it("through access the fields are read-only: the change is dropped", async () => {
			const tm = await team();
			const other = await team();
			await member(tm.id, "owner");
			const m = await member(tm.id, "member");
			await payload.update({
				collection: "memberships",
				id: m.id,
				data: { team: other.id, role: "owner" },
				overrideAccess: false,
				user: operator,
			});
			const back = await payload.findByID({
				collection: "memberships",
				id: m.id,
				depth: 0,
			});
			expect(back.team).toBe(tm.id);
			expect(back.role).toBe("owner");
		});
	});

	describe("teams: delete", () => {
		it("bulk delete by where is refused", async () => {
			const tm = await team({ name: "bulk" });
			await member(tm.id, "owner");
			await forbidden(
				payload.delete({
					collection: "teams",
					where: { id: { equals: tm.id } },
					overrideAccess: false,
					user: operator,
				}),
			);
			expect(await count("teams", { id: { equals: tm.id } })).toBe(1);
		});

		it("a personal team cannot be deleted", async () => {
			const tm = await team({ personal: true });
			await member(tm.id, "owner");
			await apiError(
				payload.delete({ collection: "teams", id: tm.id }),
				"personal_team",
			);
			expect(await count("teams", { id: { equals: tm.id } })).toBe(1);
			expect(await count("memberships", { team: { equals: tm.id } })).toBe(1);
		});

		it("a shared team: memberships and notices deleted, live keys revoked and kept", async () => {
			const tm = await team({ name: "shared" });
			const owner = await member(tm.id, "owner");
			await member(tm.id, "member");
			await payload.create({
				collection: "team-notices",
				data: { team: tm.id, kind: "member_deactivated" },
			});
			const live = await payload.create({
				collection: "api-keys",
				data: keyData(tm.id),
			});
			const revokedAt = "2026-01-01T00:00:00.000Z";
			const old = await payload.create({
				collection: "api-keys",
				data: { ...keyData(tm.id), revokedAt },
			});
			const otherTeam = await team();
			const otherKey = await payload.create({
				collection: "api-keys",
				data: keyData(otherTeam.id),
			});

			// Without the header of the /admin button (S8 §6.4): refused.
			await expect(
				payload.delete({
					collection: "teams",
					id: tm.id,
					overrideAccess: false,
					user: operator,
				}),
			).rejects.toBeInstanceOf(Forbidden);
			expect(await count("teams", { id: { equals: tm.id } })).toBe(1);

			await payload.delete({
				collection: "teams",
				id: tm.id,
				overrideAccess: false,
				user: operator,
				req: { headers: new Headers({ [DELETE_TEAM_HEADER]: "checked" }) },
			});

			expect(await count("teams", { id: { equals: tm.id } })).toBe(0);
			expect(await count("memberships", { team: { equals: tm.id } })).toBe(0);
			expect(await count("team-notices", { team: { equals: tm.id } })).toBe(0);
			expect(await count("memberships", { id: { equals: owner.id } })).toBe(0);
			const liveBack = await payload.findByID({
				collection: "api-keys",
				id: live.id,
				depth: 0,
			});
			expect(liveBack.revokedAt).toBeTruthy();
			expect(liveBack.revokedBy).toBe(operator.id);
			expect(liveBack.team ?? null).toBeNull();
			const oldBack = await payload.findByID({
				collection: "api-keys",
				id: old.id,
				depth: 0,
			});
			expect(oldBack.revokedAt).toBe(revokedAt);
			expect(oldBack.team ?? null).toBeNull();
			const otherBack = await payload.findByID({
				collection: "api-keys",
				id: otherKey.id,
			});
			expect(otherBack.revokedAt ?? null).toBeNull();
		});
	});

	describe("api-keys", () => {
		it("team is required on create", async () => {
			await validation(
				payload.create({ collection: "api-keys", data: keyData(null) }),
				"team",
			);
		});

		it("an operator in the admin changes only revokedAt; revokedBy is the operator", async () => {
			const tm = await team();
			const k = await payload.create({
				collection: "api-keys",
				data: keyData(tm.id),
			});
			await payload.update({
				collection: "api-keys",
				id: k.id,
				data: {
					name: "hijacked",
					scopes: ["*"],
					revokedAt: new Date().toISOString(),
				},
				overrideAccess: false,
				user: operator,
			});
			const back = await payload.findByID({
				collection: "api-keys",
				id: k.id,
				depth: 0,
			});
			expect(back.name).toBe("k");
			expect(back.scopes).toEqual(["sandboxes:read"]);
			expect(back.revokedAt).toBeTruthy();
			expect(back.revokedBy).toBe(operator.id);
			// A revoked key stays revoked.
			await payload.update({
				collection: "api-keys",
				id: k.id,
				data: { revokedAt: null },
				overrideAccess: false,
				user: operator,
			});
			const again = await payload.findByID({
				collection: "api-keys",
				id: k.id,
			});
			expect(again.revokedAt).toBe(back.revokedAt);
		});
	});

	describe("templates and sizes", () => {
		it("defaultSize must be one of allowedSizes", async () => {
			await validation(
				payload.create({
					collection: "templates",
					data: {
						slug: "bad-default",
						os: "linux",
						defaultSize: "2gb",
						allowedSizes: ["8gb"],
					},
				}),
				"defaultSize",
			);
		});

		it("allowed sizes must exist", async () => {
			await validation(
				payload.create({
					collection: "templates",
					data: {
						slug: "bad-size",
						os: "linux",
						defaultSize: "2gb",
						allowedSizes: ["2gb", "nope"],
					},
				}),
				"allowedSizes",
			);
		});

		it("the template slug cannot change", async () => {
			const tpl = await payload.create({
				collection: "templates",
				data: {
					slug: "fixed",
					os: "linux",
					defaultSize: "2gb",
					allowedSizes: ["2gb"],
				},
			});
			await validation(
				payload.update({
					collection: "templates",
					id: tpl.id,
					data: { slug: "moved" },
				}),
				"slug",
			);
			await payload.update({
				collection: "templates",
				id: tpl.id,
				data: { name: "Fixed" },
			});
		});

		it("the size slug cannot change", async () => {
			const s = await payload.create({
				collection: "sizes",
				data: { slug: "1gb", vcpu: 1, memoryMb: 1024 },
			});
			await validation(
				payload.update({
					collection: "sizes",
					id: s.id,
					data: { slug: "1g" },
				}),
				"slug",
			);
		});

		it("a size used by a template or a pool target cannot be deleted", async () => {
			const used = await payload.find({
				collection: "sizes",
				where: { slug: { equals: "2gb" } },
			});
			await apiError(
				payload.delete({
					collection: "sizes",
					id: used.docs[0]?.id as string,
				}),
				"size_in_use",
			);
			const pooled = await payload.create({
				collection: "sizes",
				data: { slug: "16gb", vcpu: 4, memoryMb: 16384 },
			});
			await payload.create({
				collection: "pool-targets",
				data: { template: "linux", size: "16gb", target: 0 },
			});
			await apiError(
				payload.delete({ collection: "sizes", id: pooled.id }),
				"size_in_use",
			);
			const free = await payload.create({
				collection: "sizes",
				data: { slug: "32gb", vcpu: 8, memoryMb: 32768 },
			});
			await payload.delete({ collection: "sizes", id: free.id });
		});
	});

	describe("users: delete", () => {
		it("only a stub: refused with an idpSubject, a login or a membership", async () => {
			const sso = await user({ idpSubject: randomUUID() });
			await apiError(
				payload.delete({ collection: "users", id: sso.id }),
				"user_not_stub",
			);
			const logged = await user({ lastLoginAt: new Date().toISOString() });
			await apiError(
				payload.delete({ collection: "users", id: logged.id }),
				"user_not_stub",
			);
			const tm = await team();
			const invited = await member(tm.id, "owner");
			const invitedUser = invited.user as string | { id: string };
			await apiError(
				payload.delete({
					collection: "users",
					id: typeof invitedUser === "string" ? invitedUser : invitedUser.id,
				}),
				"user_not_stub",
			);
			const stub = await user();
			await payload.delete({ collection: "users", id: stub.id });
		});
	});
});
