import { randomUUID } from "node:crypto";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { type CollectionSlug, Forbidden, type Payload } from "payload";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	DELETE_TEAM_HEADER,
	isOperatorReq,
	migrateSbxPayload,
	teamDeleteAccess,
} from "../src/index.ts";
import { closePayload, openPayload } from "./helpers.ts";

const COLLECTIONS: CollectionSlug[] = [
	"users",
	"teams",
	"memberships",
	"api-keys",
	"team-notices",
	"ssh-keys",
	"templates",
	"sizes",
	"pool-targets",
];

describe("isOperatorReq", () => {
	it("is true only for a user with isOperator === true", () => {
		expect(isOperatorReq({ user: { isOperator: true } })).toBe(true);
		expect(isOperatorReq({ user: { isOperator: false } })).toBe(false);
		expect(isOperatorReq({ user: { isOperator: "true" } })).toBe(false);
		expect(isOperatorReq({ user: {} })).toBe(false);
		expect(isOperatorReq({ user: null })).toBe(false);
		expect(isOperatorReq({})).toBe(false);
	});
});

describe("teamDeleteAccess", () => {
	const op = { isOperator: true };
	const req = (user: unknown, headers: Record<string, string> = {}) =>
		({ user, headers: new Headers(headers) }) as never;
	const checked = { [DELETE_TEAM_HEADER]: "checked" };

	it("an operator deleting one team by id with the header of the /admin button", () => {
		expect(teamDeleteAccess({ req: req(op, checked), id: "x" } as never)).toBe(
			true,
		);
	});

	it("refuses without the header (Payload's own Delete never shows), in bulk, and for others", () => {
		expect(teamDeleteAccess({ req: req(op), id: "x" } as never)).toBe(false);
		expect(teamDeleteAccess({ req: req(op, checked) } as never)).toBe(false);
		expect(
			teamDeleteAccess({
				req: req({ isOperator: false }, checked),
				id: "x",
			} as never),
		).toBe(false);
		expect(
			teamDeleteAccess({
				req: req(op, { [DELETE_TEAM_HEADER]: "yes" }),
				id: "x",
			} as never),
		).toBe(false);
	});
});

describe.skipIf(skipPg())("collection and global access", () => {
	let t: TestDatabase;
	let payload: Payload;
	// biome-ignore lint/suspicious/noExplicitAny: Local API user documents are untyped here.
	let member: any;
	// biome-ignore lint/suspicious/noExplicitAny: as above.
	let operator: any;

	beforeAll(async () => {
		t = await createTestDatabase({ migrated: false, max: 2 });
		payload = await openPayload(t.url);
		await migrateSbxPayload(payload);
		member = {
			...(await payload.create({
				collection: "users",
				data: { email: "member@example.com", active: true, isOperator: false },
			})),
			collection: "users",
		};
		operator = {
			...(await payload.create({
				collection: "users",
				data: { email: "op@example.com", active: true, isOperator: true },
			})),
			collection: "users",
		};
	});
	afterAll(async () => {
		if (t) await closePayload(t.url);
		await t?.drop();
	});

	const forbidden = (p: Promise<unknown>) =>
		expect(p).rejects.toBeInstanceOf(Forbidden);

	for (const collection of COLLECTIONS) {
		it(`${collection}: a non-operator can do nothing`, async () => {
			const as = { overrideAccess: false, user: member };
			await forbidden(payload.find({ collection, ...as }));
			await forbidden(payload.create({ collection, data: {}, ...as }));
			await forbidden(
				payload.update({ collection, id: randomUUID(), data: {}, ...as }),
			);
			await forbidden(payload.delete({ collection, id: randomUUID(), ...as }));
		});

		it(`${collection}: an operator reads`, async () => {
			const r = await payload.find({
				collection,
				overrideAccess: false,
				user: operator,
			});
			expect(Array.isArray(r.docs)).toBe(true);
		});
	}

	it("nobody creates api-keys through Payload access, operators neither", async () => {
		await forbidden(
			payload.create({
				collection: "api-keys",
				data: {},
				overrideAccess: false,
				user: operator,
			}),
		);
	});

	it("api-keys hide secretHash from access-checked reads", async () => {
		const team = await payload.create({
			collection: "teams",
			data: { name: "t" },
		});
		const key = await payload.create({
			collection: "api-keys",
			data: {
				name: "k",
				team: team.id,
				kind: "team",
				secretHash: "b".repeat(64),
				prefix: "sbx_key_x",
				last4: "abcd",
				scopes: ["sandboxes:read"],
				expiresAt: new Date(Date.now() + 86400_000).toISOString(),
				createdVia: "api",
			},
		});
		const asOperator = await payload.findByID({
			collection: "api-keys",
			id: key.id,
			overrideAccess: false,
			user: operator,
		});
		expect(asOperator.secretHash).toBeUndefined();
		const local = await payload.findByID({
			collection: "api-keys",
			id: key.id,
		});
		expect(local.secretHash).toBe("b".repeat(64));
	});

	it("platform-defaults: only operators read and update", async () => {
		await forbidden(
			payload.findGlobal({
				slug: "platform-defaults",
				overrideAccess: false,
				user: member,
			}),
		);
		await forbidden(
			payload.updateGlobal({
				slug: "platform-defaults",
				data: { idleTimeoutSeconds: 60 },
				overrideAccess: false,
				user: member,
			}),
		);
		const d = await payload.findGlobal({
			slug: "platform-defaults",
			overrideAccess: false,
			user: operator,
		});
		expect(d.idleTimeoutSeconds).toBe(900);
	});

	describe("users.delete", () => {
		const del = (id: string | number) =>
			payload.delete({
				collection: "users",
				id,
				overrideAccess: false,
				user: operator,
			});
		const exists = async (id: string | number) =>
			(
				await payload.count({
					collection: "users",
					where: { id: { equals: id } },
				})
			).totalDocs === 1;

		it("an operator deletes a stub without login and memberships", async () => {
			const stub = await payload.create({
				collection: "users",
				data: { email: `stub-${randomUUID()}@example.com` },
			});
			await del(stub.id);
			expect(await exists(stub.id)).toBe(false);
		});

		it("refuses a user who has logged in", async () => {
			const u = await payload.create({
				collection: "users",
				data: {
					email: `in-${randomUUID()}@example.com`,
					lastLoginAt: new Date().toISOString(),
				},
			});
			await expect(del(u.id)).rejects.toThrow("user_not_stub");
			expect(await exists(u.id)).toBe(true);
		});

		it("refuses a stub with a membership", async () => {
			const u = await payload.create({
				collection: "users",
				data: { email: `inv-${randomUUID()}@example.com` },
			});
			const team = await payload.create({
				collection: "teams",
				data: { name: "invited" },
			});
			await payload.create({
				collection: "memberships",
				data: { user: u.id, team: team.id, role: "member" },
			});
			await expect(del(u.id)).rejects.toThrow("user_not_stub");
			expect(await exists(u.id)).toBe(true);
		});
	});
});
