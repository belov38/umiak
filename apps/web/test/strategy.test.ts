// The Payload config of web (src/payload.config.ts) against a test Postgres:
// the oauth2-proxy strategy, the session cache it shares with /app, and the
// public-id session sent to the browser.
import { randomBytes, randomUUID } from "node:crypto";
import { decodeUuid } from "@umiak/auth";
import {
	createTestDatabase,
	skipPg,
	type TestDatabase,
} from "@umiak/db/testing";
import {
	authenticateRequest,
	dbPool,
	detachSessionCache,
	migrateUmiakPayload,
	oauth2ProxyStrategy,
	sessionCacheOf,
} from "@umiak/payload";
import { getPayload, type Payload } from "payload";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { toAppSession } from "../src/lib/app-session.ts";

const OPS = "umiak-operators";

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
				UMIAK_APP_ORIGIN: "https://app.umiak.test",
				UMIAK_OPERATOR_GROUPS: OPS,
				UMIAK_PREVIEW_DOMAIN: "umiak.test",
				UMIAK_API_PUBLIC_URL: "https://api.umiak.test",
			});
			const { default: config } = await import("../src/payload.config.ts");
			payload = await getPayload({ config, key: `web-test-${t.url}` });
			await migrateUmiakPayload(payload);
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
			expect(payload.config.csrf).toEqual(["https://app.umiak.test"]);
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

		it("local mode resolves the same owner/operator in dashboard and admin without IdP headers", async () => {
			vi.stubEnv("UMIAK_AUTH_MODE", "none");
			try {
				const h = new Headers({ "x-umiak-client-ip": "192.168.1.20" });
				const app = await authenticateRequest(payload, h);
				if (app.kind !== "session") throw new Error(app.kind);
				const admin = await payload.auth({ headers: h });
				expect(admin.user?.id).toBe(app.session.user.id);
				expect(app.session.isOperator).toBe(true);
				expect(app.session.user.email).toBe("local@umiak.invalid");
				const s = toAppSession(app.session, app.user?.personalTeam as string);
				expect(s.teams).toHaveLength(1);
				expect(s.teams[0]).toMatchObject({ role: "owner", personal: true });
				const denied = await authenticateRequest(
					payload,
					new Headers({ "x-umiak-client-ip": "203.0.113.1" }),
				);
				expect(denied).toEqual({
					kind: "denied",
					status: 403,
					reason: "client_network_forbidden",
				});
			} finally {
				vi.unstubAllEnvs();
			}
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
