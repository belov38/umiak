// Team API keys (S7 §7.2, §13; S8 §9.8, C5): owners issue and rotate them,
// members and keys with keys:admin list them, owners, operators and keys
// with keys:admin revoke them, a key revokes itself. The secret is shown
// only by POST and rotate.
import { randomUUID } from "node:crypto";
import {
	API_KEY_RE,
	decodeUuid,
	encodeUuid,
	PgIdentityStore,
	PRESETS,
	SCOPES,
} from "@umiak/auth";
import {
	createTestDatabase,
	skipPg,
	type TestDatabase,
} from "@umiak/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdentityListener } from "../src/index.ts";
import {
	captureLogs,
	issueApiKey,
	startTestOidcServer,
	type TestOidcServer,
	testSettings,
} from "../src/testing/index.ts";
import { eventually } from "./helpers/auth.ts";
import type { Harness, HarnessResponse } from "./helpers/harness.ts";
import { type ApiWorld, apiWorld } from "./helpers/world.ts";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the conformance harness
type Body = any;
const body = (r: HarnessResponse): Body => r.body as Body;

const DAY = 86_400;
const OPERATORS = "umiak-operators";

describe.skipIf(skipPg())("team API keys (S7 §7.2, §13)", () => {
	let db: TestDatabase;
	let w: ApiWorld;
	let events: IdentityListener;
	let oidc: TestOidcServer;

	beforeAll(async () => {
		db = await createTestDatabase({ max: 20 });
		w = await apiWorld(db.pool);
		events = IdentityListener.connect(db.url, { reconnectDelayMs: 50 });
		events.start();
		await events.whenReady();
		oidc = await startTestOidcServer();
	});
	afterAll(async () => {
		await oidc?.close();
		await events?.close();
		await w?.close();
		await db?.drop();
	});

	type Session = Awaited<ReturnType<ApiWorld["dbSession"]>> & {
		req(method: string, path: string, json?: unknown): Promise<HarnessResponse>;
	};

	async function session(
		role: "owner" | "member",
		o: {
			deps?: Parameters<ApiWorld["deps"]>[0];
			headers?: Record<string, string>;
		} = {},
	): Promise<Session> {
		const s = await w.dbSession({
			role,
			deps: { identityEvents: events, ...o.deps },
		});
		const headers = { ...s.headers, ...o.headers };
		return {
			...s,
			headers,
			req: (method, path, json) =>
				s.h.request(method, path, {
					headers,
					...(json === undefined ? {} : { json }),
				}),
		};
	}

	/** A public-listener harness of a team key with the live listener (a pod). */
	const keyHarness = (secret: string): Harness =>
		w.harness({ bearer: secret, deps: { identityEvents: events } });

	const me = (secret: string) => keyHarness(secret).request("GET", "/v1/me");

	async function create(owner: Session, json: Record<string, unknown> = {}) {
		const r = await owner.req("POST", "/v1/api-keys", {
			name: `k-${randomUUID().slice(0, 8)}`,
			preset: "ci",
			...json,
		});
		expect(r.status, r.text).toBe(201);
		return body(r) as { apiKey: Body; secret: string };
	}

	describe("POST /api-keys", () => {
		it("an owner issues a key: 201 {apiKey, secret}; the secret works and is never logged", async () => {
			const logs = captureLogs();
			const owner = await session("owner", { deps: { log: logs.log } });
			const before = Date.now();
			const r = await owner.req("POST", "/v1/api-keys", {
				name: "ci-main",
				preset: "ci",
			});
			expect(r.status, r.text).toBe(201);
			const { apiKey, secret } = body(r);
			expect(secret).toMatch(API_KEY_RE);
			const user = await w.identity.user(owner.userId);
			expect(apiKey).toEqual({
				id: expect.stringMatching(/^key_[0-9a-z]{26}$/),
				kind: "team",
				sandboxId: null,
				teamId: encodeUuid("team", w.teamId),
				name: "ci-main",
				prefix: secret.slice(6, 14),
				last4: secret.slice(-4),
				scopes: [...PRESETS.ci],
				createdBy: {
					id: encodeUuid("user", owner.userId),
					email: user?.email,
					active: true,
					member: true,
				},
				createdVia: "dashboard",
				createdAt: expect.any(String),
				expiresAt: expect.any(String),
				lastUsedAt: null,
				revokedAt: null,
			});
			const ttl = (Date.parse(apiKey.expiresAt) - before) / 1000;
			expect(Math.abs(ttl - 90 * DAY)).toBeLessThan(60);
			expect(logs.text()).not.toContain(secret);

			const m = await me(secret);
			expect(m.status).toBe(200);
			expect(body(m).auth).toMatchObject({
				kind: "team_key",
				apiKeyId: apiKey.id,
				scopes: [...PRESETS.ci],
			});
		});

		it("explicit scopes (deduplicated), a preset, a lifetime of up to 365 days, kind team", async () => {
			const owner = await session("owner");
			const a = await create(owner, {
				preset: undefined,
				scopes: ["sandboxes:read", "files:read", "sandboxes:read"],
				expiresInSeconds: 365 * DAY,
				kind: "team",
			});
			expect(a.apiKey.scopes).toEqual(["sandboxes:read", "files:read"]);
			const ttl = (Date.parse(a.apiKey.expiresAt) - Date.now()) / 1000;
			expect(Math.abs(ttl - 365 * DAY)).toBeLessThan(60);
			const full = await create(owner, { preset: "full" });
			expect(full.apiKey.scopes).toEqual([...SCOPES]);
			const ro = await create(owner, {
				preset: "read-only",
				expiresInSeconds: 3600,
			});
			expect(ro.apiKey.scopes).toEqual([...PRESETS["read-only"]]);
		});

		it("validation: kind sandbox, preset sandbox-self, unknown scope, both or neither, lifetime > 365 days", async () => {
			const owner = await session("owner");
			const before = (await w.identity.listApiKeys({ teamId: w.teamId }))
				.length;
			for (const json of [
				{ name: "x", preset: "ci", kind: "sandbox" },
				{ name: "x", preset: "sandbox-self" },
				{ name: "x", preset: "admin" },
				{ name: "x", scopes: ["sandboxes:read", "sandboxes:everything"] },
				{ name: "x", scopes: [] },
				{ name: "x", scopes: ["sandboxes:read"], preset: "ci" },
				{ name: "x" },
				{ name: "x", preset: "ci", expiresInSeconds: 365 * DAY + 1 },
				{ name: "x", preset: "ci", expiresInSeconds: 0 },
				{ name: "x", preset: "ci", expiresInSeconds: 1.5 },
				{ name: "", preset: "ci" },
				{ name: "x".repeat(101), preset: "ci" },
				{ preset: "ci" },
				{ name: "x", preset: "ci", extra: true },
			]) {
				const r = await owner.req("POST", "/v1/api-keys", json);
				expect(r.status, JSON.stringify(json)).toBe(400);
				expect(body(r).error.code).toBe("validation");
			}
			const sandbox = await owner.req("POST", "/v1/api-keys", {
				name: "x",
				preset: "ci",
				kind: "sandbox",
			});
			expect(body(sandbox).error.message).toContain("sandbox");
			expect((await w.identity.listApiKeys({ teamId: w.teamId })).length).toBe(
				before,
			);
		});

		it("a member is 403 role; a team key is 403 user_required", async () => {
			const member = await session("member");
			const r = await member.req("POST", "/v1/api-keys", {
				name: "x",
				preset: "ci",
			});
			expect(r.status).toBe(403);
			expect(body(r).error.details.reason).toBe("role");
			const k = await w.harness().request("POST", "/v1/api-keys", {
				json: { name: "x", preset: "ci" },
			});
			expect(k.status).toBe(403);
			expect(body(k).error.details.reason).toBe("user_required");
		});

		it("Keycloak JWT: createdVia cli with a umiak-cli/ User-Agent, else api", async () => {
			const settings = testSettings({
				UMIAK_OIDC_ISSUER: oidc.issuer,
				UMIAK_API_RATE_BURST: "100000",
			});
			const token = await oidc.token({
				sub: randomUUID(),
				email: `u-${randomUUID()}@example.com`,
			});
			const h = w.harness({ bearer: token, deps: { settings } });
			const cli = await h.request("POST", "/v1/api-keys", {
				headers: { "user-agent": "umiak-cli/0.1.0 (darwin; arm64)" },
				json: { name: "cli", preset: "read-only" },
			});
			expect(cli.status, cli.text).toBe(201);
			expect(body(cli).apiKey.createdVia).toBe("cli");
			const api = await h.request("POST", "/v1/api-keys", {
				headers: { "user-agent": "curl/8.0" },
				json: { name: "api", preset: "read-only" },
			});
			expect(body(api).apiKey.createdVia).toBe("api");
			// Issued in the person's own (personal) team.
			expect(body(api).apiKey.teamId).not.toBe(encodeUuid("team", w.teamId));
		});
	});

	describe("GET /api-keys", () => {
		it("members and keys with keys:admin list the team's keys without secrets; other keys are 403", async () => {
			const owner = await session("owner");
			const issued = await create(owner);
			const member = await session("member");
			const list = await member.req("GET", "/v1/api-keys");
			expect(list.status).toBe(200);
			expect(list.text).not.toContain(issued.secret);
			const found = body(list).data.find(
				(k: Body) => k.id === issued.apiKey.id,
			);
			expect(found).toEqual(issued.apiKey);
			expect(found).not.toHaveProperty("secret");

			const admin = await w.key(["keys:admin"]);
			const byKey = await keyHarness(admin.secret).request(
				"GET",
				"/v1/api-keys",
			);
			expect(byKey.status).toBe(200);
			expect(byKey.text).not.toContain(issued.secret);
			const ids = body(byKey).data.map((k: Body) => k.id);
			expect(ids).toContain(issued.apiKey.id);
			expect(ids).toContain(encodeUuid("apiKey", admin.id));

			const plain = await w.key(["sandboxes:read"]);
			const no = await keyHarness(plain.secret).request("GET", "/v1/api-keys");
			expect(no.status).toBe(403);
			expect(body(no).error.details.requiredScope).toBe("keys:admin");
		});

		it("a key keeps working after its creator left the team and was deactivated; the list shows it", async () => {
			const owner = await session("owner");
			const { apiKey, secret } = await create(owner);
			await db.pool.query(
				"DELETE FROM identity.memberships WHERE user_id = $1",
				[owner.userId],
			);
			await db.pool.query(
				"UPDATE identity.users SET active = false WHERE id = $1",
				[owner.userId],
			);
			expect((await me(secret)).status).toBe(200);
			const list = await keyHarness(w.secret).request("GET", "/v1/api-keys");
			const k = body(list).data.find((x: Body) => x.id === apiKey.id);
			expect(k.createdBy).toMatchObject({ active: false, member: false });
			expect(k.revokedAt).toBeNull();
		});
	});

	describe("rotate", () => {
		it("an owner rotates: a new secret, the old one is 401 at once, id, scopes and expiry stay", async () => {
			const owner = await session("owner");
			const { apiKey, secret } = await create(owner);
			const pod = keyHarness(secret);
			expect((await pod.request("GET", "/v1/me")).status).toBe(200);
			const r = await owner.req("POST", `/v1/api-keys/${apiKey.id}/rotate`);
			expect(r.status, r.text).toBe(200);
			const next = body(r);
			expect(next.secret).toMatch(API_KEY_RE);
			expect(next.secret).not.toBe(secret);
			expect(next.apiKey).toMatchObject({
				id: apiKey.id,
				scopes: apiKey.scopes,
				expiresAt: apiKey.expiresAt,
				prefix: next.secret.slice(6, 14),
				last4: next.secret.slice(-4),
			});
			// Another pod that had the old key cached drops it on NOTIFY.
			await eventually(
				async () => (await pod.request("GET", "/v1/me")).status === 401,
			);
			expect((await me(next.secret)).status).toBe(200);
		});

		it("a member is 403 role, a key 403 user_required, another team's key 404, a revoked key 409", async () => {
			const owner = await session("owner");
			const { apiKey } = await create(owner);
			const member = await session("member");
			const m = await member.req("POST", `/v1/api-keys/${apiKey.id}/rotate`);
			expect(body(m).error.details.reason).toBe("role");
			const k = await w
				.harness()
				.request("POST", `/v1/api-keys/${apiKey.id}/rotate`);
			expect(body(k).error.details.reason).toBe("user_required");

			const other = await otherTeamKey();
			const f = await owner.req(
				"POST",
				`/v1/api-keys/${encodeUuid("apiKey", other.key.id)}/rotate`,
			);
			expect(f.status).toBe(404);
			expect((await me(other.secret)).status).toBe(200);

			expect(
				(await owner.req("DELETE", `/v1/api-keys/${apiKey.id}`)).status,
			).toBe(204);
			const revoked = await owner.req(
				"POST",
				`/v1/api-keys/${apiKey.id}/rotate`,
			);
			expect(revoked.status).toBe(409);
			expect(body(revoked).error.code).toBe("invalid_state");
		});

		it("an expired key is 409 invalid_state with details.state expired, the secret is unchanged", async () => {
			const owner = await session("owner");
			const { apiKey } = await create(owner);
			const id = decodeUuid("apiKey", apiKey.id) as string;
			await db.pool.query(
				"UPDATE identity.api_keys SET expires_at = now() - interval '1 second' WHERE id = $1",
				[id],
			);
			const before = await db.pool.query(
				"SELECT secret_hash FROM identity.api_keys WHERE id = $1",
				[id],
			);
			const r = await owner.req("POST", `/v1/api-keys/${apiKey.id}/rotate`);
			expect(r.status, r.text).toBe(409);
			expect(body(r).error).toMatchObject({
				code: "invalid_state",
				details: { state: "expired" },
			});
			const after = await db.pool.query(
				"SELECT secret_hash FROM identity.api_keys WHERE id = $1",
				[id],
			);
			expect(after.rows).toEqual(before.rows);
		});
	});

	async function otherTeamKey() {
		const teamId = randomUUID();
		await db.pool.query(
			"INSERT INTO identity.teams (id, name) VALUES ($1, $2)",
			[teamId, `other-${teamId}`],
		);
		const r = await issueApiKey(w.identity, { teamId });
		return { teamId, ...r };
	}

	describe("DELETE /api-keys/{key}", () => {
		it("an owner revokes: 204, the next request with the key is 401, the list shows revokedAt", async () => {
			const owner = await session("owner");
			const { apiKey, secret } = await create(owner);
			const otherPod = keyHarness(secret);
			expect((await otherPod.request("GET", "/v1/me")).status).toBe(200);
			const r = await owner.req("DELETE", `/v1/api-keys/${apiKey.id}`);
			expect(r.status).toBe(204);
			expect((await me(secret)).status).toBe(401);
			await eventually(
				async () => (await otherPod.request("GET", "/v1/me")).status === 401,
			);
			const list = await owner.req("GET", "/v1/api-keys");
			const k = body(list).data.find((x: Body) => x.id === apiKey.id);
			expect(k.revokedAt).not.toBeNull();
			// Repeating is safe.
			expect(
				(await owner.req("DELETE", `/v1/api-keys/${apiKey.id}`)).status,
			).toBe(204);
		});

		it("a key with keys:admin revokes another key of its team, not one of another team (404)", async () => {
			const owner = await session("owner");
			const victim = await create(owner);
			const admin = await w.key(["keys:admin"]);
			const h = keyHarness(admin.secret);
			const r = await h.request("DELETE", `/v1/api-keys/${victim.apiKey.id}`);
			expect(r.status).toBe(204);
			expect((await me(victim.secret)).status).toBe(401);
			const row = await db.pool.query(
				"SELECT revoked_by_key FROM identity.api_keys WHERE id = $1",
				[decodeUuid("apiKey", victim.apiKey.id)],
			);
			expect(row.rows[0].revoked_by_key).toBe(admin.id);

			const other = await otherTeamKey();
			const f = await h.request(
				"DELETE",
				`/v1/api-keys/${encodeUuid("apiKey", other.key.id)}`,
			);
			expect(f.status).toBe(404);
			expect((await me(other.secret)).status).toBe(200);

			const plain = await w.key(["sandboxes:read"]);
			const no = await keyHarness(plain.secret).request(
				"DELETE",
				`/v1/api-keys/${encodeUuid("apiKey", admin.id)}`,
			);
			expect(no.status).toBe(403);
			expect((await me(admin.secret)).status).toBe(200);
		});

		it("a member is 403 role; an operator session revokes a key of any team", async () => {
			const owner = await session("owner");
			const { apiKey, secret } = await create(owner);
			const member = await session("member");
			const m = await member.req("DELETE", `/v1/api-keys/${apiKey.id}`);
			expect(m.status).toBe(403);
			expect(body(m).error.details.reason).toBe("role");
			expect((await me(secret)).status).toBe(200);

			const other = await otherTeamKey();
			const opIdentity = new PgIdentityStore({
				pool: db.pool,
				operatorGroups: [OPERATORS],
			});
			const op = await session("member", {
				deps: { identity: opIdentity },
				headers: {
					"x-auth-request-groups": OPERATORS,
					"umiak-team": encodeUuid("team", other.teamId),
				},
			});
			const r = await op.req(
				"DELETE",
				`/v1/api-keys/${encodeUuid("apiKey", other.key.id)}`,
			);
			expect(r.status, r.text).toBe(204);
			expect((await me(other.secret)).status).toBe(401);
		});

		it("an unknown or malformed id is 404", async () => {
			const owner = await session("owner");
			for (const id of [
				"key_01jbx2v7d3m6c8q9w0e4r5t6y7",
				"nope",
				randomUUID(),
			]) {
				const r = await owner.req("DELETE", `/v1/api-keys/${id}`);
				expect(r.status, id).toBe(404);
			}
		});
	});

	describe("DELETE /api-keys/self", () => {
		it("a key revokes itself (any scopes): 204, then 401", async () => {
			const k = await w.key(["sandboxes:read"]);
			const h = keyHarness(k.secret);
			const r = await h.request("DELETE", "/v1/api-keys/self");
			expect(r.status).toBe(204);
			expect((await h.request("GET", "/v1/me")).status).toBe(401);
			const row = await db.pool.query(
				"SELECT revoked_at, revoked_by_key FROM identity.api_keys WHERE id = $1",
				[k.id],
			);
			expect(row.rows[0].revoked_at).not.toBeNull();
			expect(row.rows[0].revoked_by_key).toBe(k.id);
		});

		it("a person has no key to revoke: 403", async () => {
			const owner = await session("owner");
			const r = await owner.req("DELETE", "/v1/api-keys/self");
			expect(r.status).toBe(403);
			expect(body(r).error.details.reason).toBe("api_key_required");
		});
	});
});
