// The Payload config of web (src/payload.config.ts) against a test Postgres:
// the oauth2-proxy strategy, the session cache it shares with /app, and the
// public-id session sent to the browser.
import { randomBytes, randomUUID } from "node:crypto";
import { decodeUuid } from "@sbx/auth";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import {
	authenticateRequest,
	dbPool,
	detachSessionCache,
	migrateSbxPayload,
	oauth2ProxyStrategy,
	sessionCacheOf,
} from "@sbx/payload";
import { getPayload, type Payload } from "payload";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toAppSession } from "../src/lib/app-session.ts";

const OPS = "sbx-operators";

describe.skipIf(skipPg())(
	"web Payload config: oauth2-proxy strategy (S8 §5.4)",
	() => {
		let t: TestDatabase;
		let payload: Payload;

		const headers = (o: { email: string; sub: string; groups?: string }) =>
			new Headers({
				"x-auth-request-email": o.email,
				"x-auth-request-user": o.sub,
				...(o.groups ? { "x-auth-request-groups": o.groups } : {}),
			});
		const email = () => `w-${randomBytes(5).toString("hex")}@example.com`;

		beforeAll(async () => {
			t = await createTestDatabase({ migrated: false, max: 2 });
			Object.assign(process.env, {
				DATABASE_URL: t.url,
				PAYLOAD_SECRET: "test-payload-secret-0123456789",
				SBX_APP_ORIGIN: "https://app.sbx.test",
				SBX_OPERATOR_GROUPS: OPS,
				SBX_SBX_DOMAIN: "sbx.test",
				SBX_API_PUBLIC_URL: "https://api.sbx.test",
			});
			const { default: config } = await import("../src/payload.config.ts");
			payload = await getPayload({ config, key: `web-test-${t.url}` });
			await migrateSbxPayload(payload);
		});
		afterAll(async () => {
			if (payload) {
				const pool = dbPool(payload);
				await detachSessionCache(payload);
				await payload.destroy();
				void pool?.end().catch(() => {});
			}
			await t?.drop();
		});

		it("the config attaches the session cache (decision 8)", () => {
			expect(sessionCacheOf(payload)).not.toBe(null);
			expect(payload.config.routes.api).toBe("/cms-api");
			expect(payload.config.csrf).toEqual(["https://app.sbx.test"]);
		});

		it("returns the user with collection 'users'", async () => {
			const e = email();
			const res = await oauth2ProxyStrategy.authenticate({
				payload,
				headers: headers({ email: e, sub: randomUUID(), groups: OPS }),
			});
			expect(res.user).toMatchObject({
				email: e,
				collection: "users",
				_strategy: "oauth2-proxy",
				isOperator: true,
			});
		});

		it("without headers: {user: null}", async () => {
			const res = await oauth2ProxyStrategy.authenticate({
				payload,
				headers: new Headers(),
			});
			expect(res).toEqual({ user: null });
			expect((await payload.auth({ headers: new Headers() })).user).toBe(null);
		});

		it("payload.auth (admin) and authenticateRequest (/app) see the same user", async () => {
			const h = headers({ email: email(), sub: randomUUID() });
			const app = await authenticateRequest(payload, h);
			if (app.kind !== "session") throw new Error(app.kind);
			const admin = await payload.auth({ headers: h });
			expect(admin.user?.id).toBe(app.session.user.id);
			expect(admin.user?.collection).toBe("users");
		});

		it("the browser gets public ids only", async () => {
			const e = email();
			const a = await authenticateRequest(
				payload,
				headers({ email: e, sub: randomUUID(), groups: OPS }),
			);
			if (a.kind !== "session") throw new Error(a.kind);
			const personal = a.user?.personalTeam as string;
			const s = toAppSession(a.session, personal);
			expect(s.user.id).toMatch(/^usr_[0-9a-z]{26}$/);
			expect(decodeUuid("user", s.user.id)).toBe(a.session.user.id);
			expect(s.user.email).toBe(e);
			expect(s.isOperator).toBe(true);
			expect(s.teams).toHaveLength(1);
			expect(s.teams[0]).toMatchObject({ role: "owner", personal: true });
			expect(s.teams[0]?.id).toMatch(/^team_[0-9a-z]{26}$/);
			expect(s.defaultTeamId).toBe(s.teams[0]?.id);
			expect(JSON.stringify(s)).not.toContain(a.session.user.id);
			expect(JSON.stringify(s)).not.toContain(personal);
		});
	},
);
