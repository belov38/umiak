import { randomBytes, randomUUID } from "node:crypto";
import { IdentityError, type IdentityErrorCode } from "@umiak/auth";
import {
	createTestDatabase,
	skipPg,
	type TestDatabase,
} from "@umiak/db/testing";
import {
	createLocalReq,
	initTransaction,
	killTransaction,
	type Payload,
} from "payload";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	AUTH_DENIED_HEADER,
	authenticateHeaders,
	getUmiakPayload,
	migrateUmiakPayload,
	ownerStrategy,
	parseAuthHeaders,
	resolveSession,
} from "../src/index.ts";
import { closePayload, Listener, testOptions } from "./helpers.ts";

const OPS = "umiak-operators";
const opts = { operatorGroups: [OPS] };

function email(tag = "u"): string {
	return `${tag}-${randomBytes(6).toString("hex")}@example.com`;
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

describe.skipIf(skipPg())("resolveSession (S8 §5.3)", () => {
	let t: TestDatabase;
	let payload: Payload;
	let listener: Listener;

	const one = async <T extends Record<string, unknown>>(
		text: string,
		params: unknown[],
	): Promise<T | undefined> =>
		(await t.pool.query<T>(text, params)).rows[0] as T | undefined;

	const count = async (text: string, params: unknown[]) =>
		Number((await t.pool.query<{ n: string }>(text, params)).rows[0]?.n ?? "0");

	/** A stub as an owner invitation creates it (S8 §6.3). */
	async function stub(e: string) {
		return payload.create({ collection: "users", data: { email: e } });
	}

	beforeAll(async () => {
		t = await createTestDatabase({ migrated: false, max: 4 });
		payload = await getUmiakPayload({ ...testOptions(t.url), poolMax: 14 });
		await migrateUmiakPayload(payload);
		listener = new Listener(t.url);
		await listener.start(["umiak_identity", "umiak_ssh_revoke"]);
	});
	afterAll(async () => {
		await listener?.stop();
		if (t) await closePayload(t.url);
		await t?.drop();
	});
	beforeEach(async () => {
		await listener.settle();
		listener.clear();
	});

	it("10 concurrent first logins create one user and one personal team", async () => {
		const e = email();
		const sub = randomUUID();
		const all = await Promise.all(
			Array.from({ length: 10 }, () =>
				resolveSession(payload, { email: e, user: sub, groups: [] }, opts),
			),
		);
		expect(new Set(all.map((r) => r.user.id)).size).toBe(1);
		const userId = all[0]?.user.id;
		expect(
			await count("SELECT count(*) AS n FROM payload.users WHERE email = $1", [
				e,
			]),
		).toBe(1);
		expect(
			await count(
				`SELECT count(*) AS n FROM payload.teams t
				  JOIN payload.memberships m ON m.team_id = t.id
				 WHERE m.user_id = $1 AND t.personal AND m.role = 'owner'`,
				[userId],
			),
		).toBe(1);
		expect(
			await count(
				"SELECT count(*) AS n FROM payload.teams WHERE created_by_id = $1",
				[userId],
			),
		).toBe(1);
		const u = await one<{
			personal_team_id: string;
			default_team_id: string;
			last_login_at: Date | null;
		}>(
			"SELECT personal_team_id, default_team_id, last_login_at FROM payload.users WHERE id = $1",
			[userId],
		);
		expect(u?.personal_team_id).toBe(all[0]?.defaultTeamId);
		expect(u?.default_team_id).toBe(all[0]?.defaultTeamId);
		expect(u?.last_login_at).toBeInstanceOf(Date);
	});

	it("a known sub whose new email is held by a stub takes over its memberships; the stub is deleted", async () => {
		const sub = randomUUID();
		const first = await resolveSession(
			payload,
			{ email: email(), user: sub, groups: [] },
			opts,
		);
		const newEmail = email("moved");
		const s = await stub(newEmail);
		// The stub is a member of one team and the only owner of another; the
		// user is already a member there.
		const shared = await payload.create({
			collection: "teams",
			data: { name: "shared" },
		});
		const owned = await payload.create({
			collection: "teams",
			data: { name: "owned" },
		});
		await payload.create({
			collection: "memberships",
			data: { user: s.id, team: shared.id, role: "member" },
		});
		await payload.create({
			collection: "memberships",
			data: { user: s.id, team: owned.id, role: "owner" },
		});
		await payload.create({
			collection: "memberships",
			data: { user: first.user.id, team: owned.id, role: "member" },
		});

		const r = await resolveSession(
			payload,
			{ email: newEmail.toUpperCase(), user: sub, groups: [] },
			opts,
		);
		expect(r.user.id).toBe(first.user.id);
		expect(r.user.email).toBe(newEmail);
		expect(r.teams).toEqual(
			expect.arrayContaining([
				{ teamId: shared.id, name: "shared", role: "member" },
				{ teamId: owned.id, name: "owned", role: "owner" },
			]),
		);
		expect(r.teams).toHaveLength(3);
		expect(
			await count("SELECT count(*) AS n FROM payload.users WHERE id = $1", [
				s.id,
			]),
		).toBe(0);
		expect(
			await count(
				"SELECT count(*) AS n FROM payload.memberships WHERE user_id = $1",
				[s.id],
			),
		).toBe(0);
		const notes = await listener.settle();
		expect(notes.map((n) => n.payload)).toEqual(
			expect.arrayContaining([
				`memberships:${s.id}:${shared.id}`,
				`memberships:${first.user.id}:${shared.id}`,
				`users:${s.id}`,
				`users:${first.user.id}`,
			]),
		);
	});

	it("a new email held by a user who has logged in is identity_conflict, also without idpSubject", async () => {
		const taken = email("taken");
		const other = await stub(taken);
		// The operator cleared idpSubject of a user who has logged in before.
		await payload.update({
			collection: "users",
			id: other.id,
			data: { lastLoginAt: new Date().toISOString() },
		});
		const sub = randomUUID();
		await resolveSession(
			payload,
			{ email: email(), user: sub, groups: [] },
			opts,
		);
		expect(
			await codeOf(
				resolveSession(payload, { email: taken, user: sub, groups: [] }, opts),
			),
		).toBe("identity_conflict");
	});

	it("a repeated login with the same claims writes nothing and notifies nothing", async () => {
		const e = email();
		const sub = randomUUID();
		const h = { email: e, user: sub, groups: ["devs", OPS] };
		const r = await resolveSession(payload, h, opts);
		const before = await one<{ updated_at: Date }>(
			"SELECT updated_at FROM payload.users WHERE id = $1",
			[r.user.id],
		);
		await listener.settle();
		listener.clear();
		const again = await resolveSession(
			payload,
			{ ...h, groups: [OPS, "devs"] },
			opts,
		);
		expect(again).toEqual(r);
		const after = await one<{ updated_at: Date }>(
			"SELECT updated_at FROM payload.users WHERE id = $1",
			[r.user.id],
		);
		expect(after?.updated_at).toEqual(before?.updated_at);
		expect(await listener.settle()).toEqual([]);
	});

	it("dropping the operator group sets isOperator false and notifies users:<id>", async () => {
		const e = email();
		const sub = randomUUID();
		const op = await resolveSession(
			payload,
			{ email: e, user: sub, groups: [OPS] },
			opts,
		);
		expect(op.isOperator).toBe(true);
		await listener.settle();
		listener.clear();
		const plain = await resolveSession(
			payload,
			{ email: e, user: sub, groups: [] },
			opts,
		);
		expect(plain.isOperator).toBe(false);
		expect(plain.user.isOperator).toBe(false);
		const row = await one<{ is_operator: boolean; groups: unknown }>(
			"SELECT is_operator, groups FROM payload.users WHERE id = $1",
			[op.user.id],
		);
		expect(row).toEqual({ is_operator: false, groups: [] });
		expect((await listener.settle()).map((n) => n.payload)).toEqual([
			`users:${op.user.id}`,
		]);
	});

	it("alternating browser (headers with role: entries) and CLI (JWT groups) logins notify nothing", async () => {
		const e = email();
		const sub = randomUUID();
		const header = parseAuthHeaders({
			"x-auth-request-email": e,
			"x-auth-request-user": sub,
			"x-auth-request-groups":
				"role:offline_access,devs,role:uma_authorization,role:umiak-api:read",
			"x-auth-request-preferred-username": "bob",
		});
		if (header === null) throw new Error("no claims");
		expect(header.groups).toEqual(["devs"]);
		const token = { email: e, user: sub, groups: ["devs"] };
		const first = await resolveSession(payload, header, opts);
		await listener.settle();
		listener.clear();
		for (let i = 0; i < 3; i++) {
			await resolveSession(payload, token, opts);
			await resolveSession(payload, header, opts);
		}
		expect(await listener.settle()).toEqual([]);

		// groups and preferredUsername that do differ are written, still
		// without umiak_identity (not part of SessionIdentity).
		await resolveSession(
			payload,
			{ ...token, groups: ["devs", "qa"], preferredUsername: "robert" },
			opts,
		);
		await resolveSession(payload, header, opts);
		const row = await one<{ groups: unknown; preferred_username: string }>(
			"SELECT groups, preferred_username FROM payload.users WHERE id = $1",
			[first.user.id],
		);
		expect(row).toEqual({ groups: ["devs"], preferred_username: "bob" });
		expect(await listener.settle()).toEqual([]);

		// isOperator still notifies.
		const op = await resolveSession(
			payload,
			{ ...token, groups: ["devs", OPS] },
			opts,
		);
		expect(op.isOperator).toBe(true);
		expect((await listener.settle()).map((n) => n.payload)).toEqual([
			`users:${first.user.id}`,
		]);
	});

	it("lastLoginAt is written at most once per 60 s", async () => {
		const e = email();
		const sub = randomUUID();
		const r = await resolveSession(
			payload,
			{ email: e, user: sub, groups: [] },
			opts,
		);
		const old = new Date(Date.now() - 61_000);
		await t.pool.query(
			"UPDATE payload.users SET last_login_at = $2 WHERE id = $1",
			[r.user.id, old],
		);
		await listener.settle();
		listener.clear();
		await resolveSession(payload, { email: e, user: sub, groups: [] }, opts);
		const row = await one<{ last_login_at: Date }>(
			"SELECT last_login_at FROM payload.users WHERE id = $1",
			[r.user.id],
		);
		expect(row?.last_login_at.getTime()).toBeGreaterThan(old.getTime() + 1000);
		// lastLoginAt alone is bookkeeping: no umiak_identity.
		expect(await listener.settle()).toEqual([]);
	});

	it("binding a stub writes idpSubject, name and lastLoginAt", async () => {
		const e = email("stub");
		const s = await stub(e);
		const sub = randomUUID();
		const r = await resolveSession(
			payload,
			{ email: e, user: sub, groups: [], preferredUsername: "bob" },
			opts,
		);
		expect(r.user).toMatchObject({ id: s.id, idpSubject: sub, name: "bob" });
		const row = await one<{
			last_login_at: Date | null;
			preferred_username: string;
			personal_team_id: string;
		}>(
			"SELECT last_login_at, preferred_username, personal_team_id FROM payload.users WHERE id = $1",
			[s.id],
		);
		expect(row?.last_login_at).toBeInstanceOf(Date);
		expect(row?.preferred_username).toBe("bob");
		expect(row?.personal_team_id).toBe(r.defaultTeamId);
	});

	it("runs in the transaction of o.req: a rollback leaves nothing", async () => {
		const e = email();
		const req = await createLocalReq({}, payload);
		await initTransaction(req);
		const r = await resolveSession(
			payload,
			{ email: e, user: randomUUID(), groups: [] },
			{ ...opts, req },
		);
		expect(req.transactionID).toBeDefined();
		await killTransaction(req);
		expect(
			await count("SELECT count(*) AS n FROM payload.users WHERE id = $1", [
				r.user.id,
			]),
		).toBe(0);
	});

	describe("auth strategy (S8 §5.4)", () => {
		const headers = (h: Record<string, string>) => new Headers(h);

		it("authenticates by the oauth2-proxy headers", async () => {
			const e = email();
			const res = await ownerStrategy.authenticate({
				payload,
				headers: headers({
					"x-auth-request-email": e,
					"x-auth-request-user": randomUUID(),
					"x-auth-request-groups": `devs,${OPS}`,
				}),
			});
			expect(res.user).toMatchObject({
				email: e,
				isOperator: true,
				active: true,
				collection: "users",
				_strategy: "oauth2-proxy",
			});
			expect(res.responseHeaders).toBeUndefined();
		});

		it("isOperator of the user comes from the resolved session, not from the second read", async () => {
			const e = email();
			const real = payload.findByID.bind(payload);
			// A concurrent write between resolveSession and the read of the doc.
			const spy = vi.spyOn(payload, "findByID").mockImplementationOnce((async (
				a: Parameters<typeof real>[0],
			) => ({
				...(await real(a)),
				isOperator: false,
			})) as never);
			try {
				const res = await ownerStrategy.authenticate({
					payload,
					headers: headers({
						"x-auth-request-email": e,
						"x-auth-request-user": randomUUID(),
						"x-auth-request-groups": OPS,
					}),
				});
				expect(spy).toHaveBeenCalledTimes(1);
				expect(res.user).toMatchObject({ email: e, isOperator: true });
			} finally {
				spy.mockRestore();
			}
		});

		it("no email header -> no user; no sub -> no user", async () => {
			expect(
				(
					await ownerStrategy.authenticate({
						payload,
						headers: headers({}),
					})
				).user,
			).toBe(null);
			expect(await authenticateHeaders(payload, headers({}))).toEqual({
				kind: "anonymous",
				status: 401,
			});
			const h = headers({ "x-auth-request-email": email() });
			expect(
				(await ownerStrategy.authenticate({ payload, headers: h })).user,
			).toBe(null);
			expect(await authenticateHeaders(payload, h)).toEqual({
				kind: "denied",
				status: 401,
				reason: "subject_required",
			});
		});

		it("a disabled user or a conflict: no user, the reason in the outcome and a response header", async () => {
			const e = email();
			const sub = randomUUID();
			const r = await resolveSession(
				payload,
				{ email: e, user: sub, groups: [] },
				opts,
			);
			await payload.update({
				collection: "users",
				id: r.user.id,
				data: { active: false, deactivatedReason: "operator" },
			});
			const h = headers({
				"x-auth-request-email": e,
				"x-auth-request-user": sub,
			});
			const res = await ownerStrategy.authenticate({
				payload,
				headers: h,
			});
			expect(res.user).toBe(null);
			expect(res.responseHeaders?.get(AUTH_DENIED_HEADER)).toBe(
				"user_disabled",
			);
			expect(await authenticateHeaders(payload, h)).toEqual({
				kind: "denied",
				status: 403,
				reason: "user_disabled",
			});
			const conflict = headers({
				"x-auth-request-email": e,
				"x-auth-request-user": randomUUID(),
			});
			expect(await authenticateHeaders(payload, conflict)).toEqual({
				kind: "denied",
				status: 403,
				reason: "identity_conflict",
			});
		});

		it("payload.auth runs the strategy", async () => {
			const e = email();
			const res = await payload.auth({
				headers: headers({
					"x-auth-request-email": e,
					"x-auth-request-user": randomUUID(),
				}),
			});
			expect(res.user).toMatchObject({ email: e, collection: "users" });
		});
	});
});
