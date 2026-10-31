import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { encodeUuid } from "@sbx/auth";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import type { Payload } from "payload";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import {
	type IdpSyncAbort,
	KeycloakAdminClient,
	KeycloakIdpSync,
	MAX_USER_PAGES,
	migrateSbxPayload,
} from "../src/index.ts";
import { closePayload, Listener, openPayload } from "./helpers.ts";

const REALM = "sbx";

/** xs[i], or a test failure. */
function at<T>(xs: readonly T[], i: number): T {
	const x = xs[i];
	if (x === undefined) throw new Error(`no element ${i}`);
	return x;
}
const CLIENT_ID = "sbx-worker";
const SECRET = "worker-client-secret-do-not-log";

interface FakeUser {
	id: string;
	enabled: boolean;
}

/**
 * Keycloak over node:http: the client credentials token endpoint and the
 * admin user list/lookup. `users` is the realm; `exists` overrides the
 * lookup of a user id; `failPage` answers 500 for that page index;
 * `ignoreFirst` always answers the first page.
 */
class FakeKeycloak {
	users: FakeUser[] = [];
	exists = new Map<string, number>();
	failPage: number | undefined;
	ignoreFirst = false;
	tokens = 0;
	lookups: string[] = [];
	pages = 0;
	#server: Server;
	#token = "";

	constructor() {
		this.#server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (c: Buffer) => chunks.push(c));
			req.on("end", () => this.#handle(req, Buffer.concat(chunks), res));
		});
	}

	#json(
		res: import("node:http").ServerResponse,
		status: number,
		body: unknown,
	) {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	}

	#handle(
		req: import("node:http").IncomingMessage,
		body: Buffer,
		res: import("node:http").ServerResponse,
	) {
		const url = new URL(req.url ?? "/", "http://kc");
		if (
			req.method === "POST" &&
			url.pathname === `/realms/${REALM}/protocol/openid-connect/token`
		) {
			const f = new URLSearchParams(body.toString());
			if (
				f.get("grant_type") !== "client_credentials" ||
				f.get("client_id") !== CLIENT_ID ||
				f.get("client_secret") !== SECRET
			) {
				return this.#json(res, 401, { error: "unauthorized_client" });
			}
			this.tokens += 1;
			this.#token = `tok-${this.tokens}`;
			return this.#json(res, 200, {
				access_token: this.#token,
				expires_in: 300,
				token_type: "Bearer",
			});
		}
		if (req.headers.authorization !== `Bearer ${this.#token}`) {
			return this.#json(res, 401, { error: "HTTP 401 Unauthorized" });
		}
		const base = `/admin/realms/${REALM}/users`;
		if (req.method === "GET" && url.pathname === base) {
			const first = Number(url.searchParams.get("first") ?? 0);
			const max = Number(url.searchParams.get("max") ?? 100);
			const page = this.pages;
			this.pages += 1;
			if (url.searchParams.get("briefRepresentation") !== "true") {
				return this.#json(res, 400, { error: "expected brief" });
			}
			if (this.failPage === page) return this.#json(res, 500, {});
			return this.#json(
				res,
				200,
				this.users
					.slice(
						this.ignoreFirst ? 0 : first,
						(this.ignoreFirst ? 0 : first) + max,
					)
					.map((u) => ({
						id: u.id,
						username: u.id,
						enabled: u.enabled,
					})),
			);
		}
		if (req.method === "GET" && url.pathname.startsWith(`${base}/`)) {
			const id = decodeURIComponent(url.pathname.slice(base.length + 1));
			this.lookups.push(id);
			const status =
				this.exists.get(id) ??
				(this.users.some((u) => u.id === id) ? 200 : 404);
			return this.#json(res, status, status === 200 ? { id } : {});
		}
		this.#json(res, 404, {});
	}

	async start(): Promise<string> {
		await new Promise<void>((r) => this.#server.listen(0, "127.0.0.1", r));
		const { port } = this.#server.address() as AddressInfo;
		return `http://127.0.0.1:${port}`;
	}

	reset() {
		this.users = [];
		this.exists.clear();
		this.failPage = undefined;
		this.ignoreFirst = false;
		this.lookups = [];
		this.pages = 0;
	}

	stop(): Promise<void> {
		return new Promise((r) => this.#server.close(() => r()));
	}
}

describe("KeycloakAdminClient", () => {
	const kc = new FakeKeycloak();
	let url: string;
	beforeAll(async () => {
		url = await kc.start();
	});
	afterAll(() => kc.stop());
	beforeEach(() => kc.reset());

	const client = (o: { secret?: string; pageSize?: number } = {}) =>
		new KeycloakAdminClient({
			baseUrl: `${url}/`,
			realm: REALM,
			clientId: CLIENT_ID,
			clientSecret: o.secret ?? SECRET,
			pageSize: o.pageSize ?? 2,
		});

	it("pages until an empty page, one token", async () => {
		kc.users = [1, 2, 3, 4, 5].map((i) => ({ id: `u${i}`, enabled: i !== 3 }));
		const tokens = kc.tokens;
		const got = await client().listUsers();
		expect(got).toEqual(kc.users);
		// 2 + 2 + 1 + empty
		expect(kc.pages).toBe(4);
		expect(kc.tokens).toBe(tokens + 1);
	});

	it("userExists: 200 true, 404 false, other statuses throw", async () => {
		kc.users = [{ id: "u1", enabled: true }];
		kc.exists.set("u3", 500);
		const c = client();
		expect(await c.userExists("u1")).toBe(true);
		expect(await c.userExists("u2")).toBe(false);
		await expect(c.userExists("u3")).rejects.toThrow(/500/);
	});

	it("a failed page throws; a refused token throws without the secret", async () => {
		kc.users = [1, 2, 3].map((i) => ({ id: `u${i}`, enabled: true }));
		kc.failPage = 1;
		await expect(client().listUsers()).rejects.toThrow(/500/);

		const err = await client({ secret: "wrong-secret-value" })
			.listUsers()
			.then(
				() => new Error("no error"),
				(e: unknown) => e as Error,
			);
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toMatch(/token request returned 401/);
		expect(err.message).not.toContain("wrong-secret-value");
	});

	it("a server that ignores first: a full page without new users throws", async () => {
		kc.users = [1, 2, 3].map((i) => ({ id: `u${i}`, enabled: true }));
		kc.ignoreFirst = true;
		await expect(client().listUsers()).rejects.toThrow(
			/full page without new users/,
		);
		expect(kc.pages).toBe(2);
	});

	it(`more than ${MAX_USER_PAGES} pages throws`, async () => {
		let pages = 0;
		const json = (body: unknown) =>
			new Response(JSON.stringify(body), {
				headers: { "content-type": "application/json" },
			});
		const c = new KeycloakAdminClient({
			baseUrl: url,
			realm: REALM,
			clientId: CLIENT_ID,
			clientSecret: SECRET,
			pageSize: 1,
			fetch: async (u) => {
				if (String(u).includes("/token")) {
					return json({ access_token: "t", expires_in: 300 });
				}
				pages += 1;
				return json([{ id: `u${pages}`, enabled: true }]);
			},
		});
		await expect(c.listUsers()).rejects.toThrow(/more than 10000 pages/);
		expect(pages).toBe(MAX_USER_PAGES);
	});

	it("a timeout is an error", async () => {
		const c = new KeycloakAdminClient({
			baseUrl: url,
			realm: REALM,
			clientId: CLIENT_ID,
			clientSecret: SECRET,
			timeoutMs: 50,
			fetch: (_u, init) =>
				new Promise((_r, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(init.signal?.reason),
					);
				}),
		});
		await expect(c.listUsers()).rejects.toThrow(/token.*failed/);
	});
});

describe.skipIf(skipPg())("KeycloakIdpSync", () => {
	let t: TestDatabase;
	let payload: Payload;
	let listener: Listener;
	const kc = new FakeKeycloak();
	let url: string;
	let aborts: IdpSyncAbort[];

	const sync = () =>
		new KeycloakIdpSync({
			payload,
			keycloak: new KeycloakAdminClient({
				baseUrl: url,
				realm: REALM,
				clientId: CLIENT_ID,
				clientSecret: SECRET,
				pageSize: 3,
			}),
			onAbort: (r) => aborts.push(r),
		});

	async function user(data: Record<string, unknown> = {}) {
		const sub = randomUUID();
		const doc = await payload.create({
			collection: "users",
			data: {
				email: `u-${randomUUID()}@example.com`,
				idpSubject: sub,
				...data,
			},
			depth: 0,
		});
		return { id: String(doc.id), sub };
	}

	async function team(name = "t") {
		const doc = await payload.create({
			collection: "teams",
			data: { name },
			depth: 0,
		});
		return String(doc.id);
	}

	async function member(userId: string, teamId: string, role = "member") {
		await payload.create({
			collection: "memberships",
			data: { user: userId, team: teamId, role },
			depth: 0,
		});
	}

	async function apiKey(teamId: string, createdBy: string, name: string) {
		const doc = await payload.create({
			collection: "api-keys",
			data: {
				name,
				team: teamId,
				createdBy,
				kind: "team",
				secretHash: randomBytes(32).toString("hex"),
				prefix: `sbx_key_${name}`,
				last4: "abcd",
				scopes: ["sandboxes:read"],
				expiresAt: new Date(Date.now() + 86400_000).toISOString(),
				createdVia: "api",
			},
			depth: 0,
		});
		return String(doc.id);
	}

	const get = async (id: string) =>
		payload.findByID({ collection: "users", id, depth: 0 });

	const notices = async (userId: string) =>
		(
			await payload.find({
				collection: "team-notices",
				where: { user: { equals: userId } },
				depth: 0,
				pagination: false,
				sort: "createdAt",
			})
		).docs;

	/** n users enabled in Keycloak, active on the platform. */
	async function enabledUsers(n: number) {
		const out = [];
		for (let i = 0; i < n; i++) {
			const u = await user();
			kc.users.push({ id: u.sub, enabled: true });
			out.push(u);
		}
		return out;
	}

	beforeAll(async () => {
		t = await createTestDatabase({ migrated: false, max: 2 });
		payload = await openPayload(t.url);
		await migrateSbxPayload(payload, () => {});
		url = await kc.start();
		listener = new Listener(t.url);
		await listener.start(["sbx_identity", "sbx_ssh_revoke"]);
	});
	afterAll(async () => {
		await listener?.stop();
		await kc.stop();
		if (t) await closePayload(t.url);
		await t?.drop();
	});
	beforeEach(async () => {
		kc.reset();
		aborts = [];
		// Every test starts from no active IdP users.
		await payload.update({
			collection: "users",
			where: { active: { equals: true } },
			data: { active: false, deactivatedReason: "operator" },
			depth: 0,
		});
		await listener.settle();
		listener.clear();
	});
	afterEach(() => {
		listener.onNote(null);
	});

	it("disabled in Keycloak: idp_disabled, a notice with their keys in each team, keys stay live", async () => {
		const other = at(await enabledUsers(9), 0);
		const u = await user();
		kc.users.push({ id: u.sub, enabled: false });
		const t1 = await team("one");
		const t2 = await team("two");
		await member(other.id, t1, "owner");
		await member(u.id, t1);
		await member(u.id, t2, "owner");
		const k1 = await apiKey(t1, u.id, "a");
		await apiKey(t1, other.id, "b");
		const k3 = await apiKey(t2, u.id, "c");
		const revoked = await apiKey(t2, u.id, "d");
		await payload.update({
			collection: "api-keys",
			id: revoked,
			data: { revokedAt: new Date().toISOString() },
			depth: 0,
		});
		await listener.settle();
		listener.clear();

		const r = await sync().run();
		expect(r).toEqual({ deactivated: [u.id], reactivated: [], aborted: false });
		const back = await get(u.id);
		expect(back).toMatchObject({
			active: false,
			deactivatedReason: "idp_disabled",
		});
		expect(back.deactivatedAt).toBeTruthy();

		const notes = await listener.settle();
		expect(notes).toEqual(
			expect.arrayContaining([
				{ channel: "sbx_identity", payload: `users:${u.id}` },
				{
					channel: "sbx_ssh_revoke",
					payload: `user:${encodeUuid("user", u.id)}`,
				},
			]),
		);

		const ns = await notices(u.id);
		const byTeam = new Map(ns.map((n) => [String(n.team), n]));
		expect([...byTeam.keys()].sort()).toEqual([t1, t2].sort());
		expect(byTeam.get(t1)).toMatchObject({
			kind: "member_deactivated",
			apiKeys: [
				{
					id: k1,
					publicId: encodeUuid("apiKey", k1),
					name: "a",
					prefix: "sbx_key_a",
				},
			],
		});
		expect(byTeam.get(t2)?.apiKeys).toEqual([
			{
				id: k3,
				publicId: encodeUuid("apiKey", k3),
				name: "c",
				prefix: "sbx_key_c",
			},
		]);
		const key = await payload.findByID({
			collection: "api-keys",
			id: k1,
			depth: 0,
		});
		expect(key.revokedAt ?? null).toBeNull();

		// A second pass changes nothing and adds no notice.
		const again = await sync().run();
		expect(again).toEqual({ deactivated: [], reactivated: [], aborted: false });
		expect(await notices(u.id)).toHaveLength(2);
	});

	it("missing from the list and 404: idp_deleted", async () => {
		await enabledUsers(9);
		const u = await user();
		const r = await sync().run();
		expect(r.deactivated).toEqual([u.id]);
		expect(kc.lookups).toEqual([u.sub]);
		expect(await get(u.id)).toMatchObject({
			active: false,
			deactivatedReason: "idp_deleted",
		});
	});

	it("missing from the list but GET /users/{id} is 200: untouched", async () => {
		await enabledUsers(9);
		const u = await user();
		kc.exists.set(u.sub, 200);
		const r = await sync().run();
		expect(r).toEqual({ deactivated: [], reactivated: [], aborted: false });
		expect(await get(u.id)).toMatchObject({ active: true });
	});

	it("stubs (no idpSubject) are not touched", async () => {
		await enabledUsers(3);
		const stub = await payload.create({
			collection: "users",
			data: { email: `stub-${randomUUID()}@example.com` },
			depth: 0,
		});
		const r = await sync().run();
		expect(r.deactivated).toEqual([]);
		expect(kc.lookups).toEqual([]);
		expect(await get(String(stub.id))).toMatchObject({ active: true });
		await payload.update({
			collection: "users",
			id: stub.id,
			data: { active: false, deactivatedReason: "operator" },
			depth: 0,
		});
	});

	it("an operator deactivation is not lifted", async () => {
		const u = await user({ active: false, deactivatedReason: "operator" });
		kc.users.push({ id: u.sub, enabled: true });
		const r = await sync().run();
		expect(r.reactivated).toEqual([]);
		expect(await get(u.id)).toMatchObject({
			active: false,
			deactivatedReason: "operator",
		});
	});

	it("enabled again after idp_disabled: active, reason cleared", async () => {
		const u = await user({
			active: false,
			deactivatedReason: "idp_disabled",
			deactivatedAt: new Date().toISOString(),
		});
		kc.users.push({ id: u.sub, enabled: true });
		const r = await sync().run();
		expect(r).toEqual({ deactivated: [], reactivated: [u.id], aborted: false });
		const back = await get(u.id);
		expect(back.active).toBe(true);
		expect(back.deactivatedReason ?? null).toBeNull();
		expect(back.deactivatedAt ?? null).toBeNull();
	});

	it("an empty list with 10 active users: aborted, nobody deactivated", async () => {
		const us = [];
		for (let i = 0; i < 10; i++) us.push(await user());
		const r = await sync().run();
		expect(r).toMatchObject({
			deactivated: [],
			reactivated: [],
			aborted: true,
		});
		expect(aborts).toEqual([
			{ reason: "mass_deactivation", wouldDeactivate: 10, active: 10 },
		]);
		for (const u of us) expect((await get(u.id)).active).toBe(true);
	});

	it("6 of 20 (30%): aborted", async () => {
		const us = await enabledUsers(20);
		for (const u of us.slice(0, 6)) {
			const k = kc.users.find((x) => x.id === u.sub);
			if (k) k.enabled = false;
		}
		const r = await sync().run();
		expect(r.aborted).toBe(true);
		expect(aborts).toEqual([
			{ reason: "mass_deactivation", wouldDeactivate: 6, active: 20 },
		]);
		for (const u of us) expect((await get(u.id)).active).toBe(true);
	});

	it("5 of 10: applied (no more than 5)", async () => {
		const us = await enabledUsers(10);
		for (const u of us.slice(0, 3)) {
			const k = kc.users.find((x) => x.id === u.sub);
			if (k) k.enabled = false;
		}
		// Two more deleted (404).
		kc.users = kc.users.filter(
			(x) => x.id !== at(us, 3).sub && x.id !== at(us, 4).sub,
		);
		const r = await sync().run();
		expect(r.aborted).toBe(false);
		expect(aborts).toEqual([]);
		expect([...r.deactivated].sort()).toEqual(
			us
				.slice(0, 5)
				.map((u) => u.id)
				.sort(),
		);
		for (const u of us.slice(5)) expect((await get(u.id)).active).toBe(true);
		expect((await get(at(us, 3).id)).deactivatedReason).toBe("idp_deleted");
		expect((await get(at(us, 0).id)).deactivatedReason).toBe("idp_disabled");
	});

	it("500 on the second page: throws, nothing changes", async () => {
		const us = await enabledUsers(5);
		const off = await user();
		kc.users.push({ id: off.sub, enabled: false });
		kc.failPage = 1;
		await listener.settle();
		listener.clear();
		await expect(sync().run()).rejects.toThrow(/500/);
		for (const u of [...us, off]) expect((await get(u.id)).active).toBe(true);
		expect(await listener.settle()).toEqual([]);
		expect(await notices(off.id)).toEqual([]);
	});

	it("an operator deactivation between the plan and the write wins", async () => {
		await enabledUsers(9);
		const off = await user();
		kc.users.push({ id: off.sub, enabled: false });
		const gone = await user();
		const real = new KeycloakAdminClient({
			baseUrl: url,
			realm: REALM,
			clientId: CLIENT_ID,
			clientSecret: SECRET,
		});
		const s = new KeycloakIdpSync({
			payload,
			keycloak: {
				listUsers: () => real.listUsers(),
				// Runs after the plan, before the writes.
				userExists: async (id) => {
					await payload.update({
						collection: "users",
						id: off.id,
						data: { active: false, deactivatedReason: "operator" },
						depth: 0,
					});
					return real.userExists(id);
				},
			},
		});
		const r = await s.run();
		expect(r.deactivated).toEqual([gone.id]);
		expect((await get(off.id)).deactivatedReason).toBe("operator");
		expect(await notices(off.id)).toEqual([]);
	});

	it("an unacknowledged notice is not duplicated after reactivation and a new deactivation", async () => {
		await enabledUsers(9);
		const u = await user();
		const tm = await team();
		await member(u.id, tm, "owner");
		kc.users.push({ id: u.sub, enabled: false });
		await sync().run();
		expect(await notices(u.id)).toHaveLength(1);

		const k = kc.users.find((x) => x.id === u.sub);
		if (k) k.enabled = true;
		expect((await sync().run()).reactivated).toEqual([u.id]);
		if (k) k.enabled = false;
		expect((await sync().run()).deactivated).toEqual([u.id]);
		expect(await notices(u.id)).toHaveLength(1);

		// After acknowledgement the next deactivation adds a new one.
		const n = at(await notices(u.id), 0);
		await payload.update({
			collection: "team-notices",
			id: n.id,
			data: { acknowledgedAt: new Date().toISOString() },
			depth: 0,
		});
		if (k) k.enabled = true;
		await sync().run();
		if (k) k.enabled = false;
		await sync().run();
		expect(await notices(u.id)).toHaveLength(2);
	});
});
