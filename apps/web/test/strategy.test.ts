import {
	createTestDatabase,
	skipPg,
	type TestDatabase,
} from "@umiak/db/testing";
import {
	authenticateRequest,
	dbPool,
	migrateUmiakPayload,
	ownerStrategy,
} from "@umiak/payload";
import { getPayload, type Payload } from "payload";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toAppSession } from "../src/lib/app-session.ts";

describe.skipIf(skipPg())("owner Payload strategy", () => {
	let db: TestDatabase;
	let payload: Payload;
	const ingress = () => new Headers({ "x-umiak-client-ip": "127.0.0.1" });
	beforeAll(async () => {
		db = await createTestDatabase({ migrated: false, max: 2 });
		Object.assign(process.env, {
			DATABASE_URL: db.url,
			PAYLOAD_SECRET: "test-payload-secret-0123456789",
			UMIAK_APP_ORIGIN: "https://app.umiak.test",
			UMIAK_AUTH_MODE: "owner",
			UMIAK_LOCAL_ALLOWED_CIDRS: "127.0.0.0/8",
			UMIAK_OPERATOR_GROUPS: "umiak-local-operator",
			UMIAK_PREVIEW_DOMAIN: "umiak.test",
			UMIAK_API_PUBLIC_URL: "https://api.umiak.test",
		});
		const { default: config } = await import("../src/payload.config.ts");
		payload = await getPayload({ config, key: `owner-test-${db.url}` });
		await migrateUmiakPayload(payload);
	});
	afterAll(async () => {
		if (payload) {
			const pool = dbPool(payload);
			await payload.destroy();
			void pool?.end().catch(() => {});
		}
		await db?.drop();
	});
	it("keeps the admin API private", () => {
		expect(payload.config.routes.api).toBe("/cms-api");
		expect(payload.config.csrf).toEqual(["https://app.umiak.test"]);
	});
	it("resolves the same owner/operator in admin and dashboard", async () => {
		const app = await authenticateRequest(payload, ingress());
		if (app.kind !== "session") throw new Error(app.kind);
		const admin = await payload.auth({ headers: ingress() });
		expect(admin.user?.id).toBe(app.session.user.id);
		expect(admin.user).toMatchObject({
			collection: "users",
			_strategy: "owner",
			email: "local@umiak.invalid",
			isOperator: true,
		});
		const session = toAppSession(app.session, app.user?.personalTeam as string);
		expect(session.teams).toHaveLength(1);
		expect(session.teams[0]).toMatchObject({ personal: true, role: "owner" });
		expect(session.user.id).toMatch(/^usr_/);
		expect(session.teams[0]?.id).toMatch(/^team_/);
	});
	it("ignores forged user and group headers", async () => {
		const h = ingress();
		h.set("x-auth-request-user", "attacker");
		h.set("x-auth-request-email", "attacker@example.com");
		h.set("x-auth-request-groups", "admins");
		const result = await ownerStrategy.authenticate({ payload, headers: h });
		expect(result.user?.email).toBe("local@umiak.invalid");
	});
	it("checks the network on every request, including after a successful login", async () => {
		await authenticateRequest(payload, ingress());
		for (const headers of [
			new Headers(),
			new Headers({
				"x-umiak-client-ip": "203.0.113.1",
				"x-forwarded-for": "127.0.0.1",
			}),
		]) {
			expect(await authenticateRequest(payload, headers)).toEqual({
				kind: "denied",
				status: 403,
				reason: "client_network_forbidden",
			});
			expect(
				await ownerStrategy.authenticate({ payload, headers }),
			).toMatchObject({ user: null });
		}
	});
	it("immediately refuses a disabled owner", async () => {
		const first = await authenticateRequest(payload, ingress());
		if (first.kind !== "session") throw new Error(first.kind);
		await payload.update({
			collection: "users",
			id: first.session.user.id,
			data: { active: false, deactivatedReason: "operator" },
		});
		try {
			expect(await authenticateRequest(payload, ingress())).toEqual({
				kind: "denied",
				status: 403,
				reason: "user_disabled",
			});
			expect((await payload.auth({ headers: ingress() })).user).toBeNull();
		} finally {
			await payload.update({
				collection: "users",
				id: first.session.user.id,
				data: { active: true },
			});
		}
	});
});
