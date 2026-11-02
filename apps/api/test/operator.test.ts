// Operator endpoints of S8 C3 and the block semantics over HTTP: block and
// unblock of a sandbox and of a port, the all-teams list, 403 for everyone
// but an operator's browser session (keys, Keycloak JWT of an operator,
// owners), `sandbox_blocked` / `port_blocked` on the forbidden actions, reads,
// stop and delete still working, and the gateway's route answer.
import { randomUUID } from "node:crypto";
import { encodeUuid, PgIdentityStore } from "@umiak/auth";
import {
	createTestDatabase,
	skipPg,
	type TestDatabase,
} from "@umiak/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiDeps, ServiceTokens } from "../src/index.ts";
import {
	issueApiKey,
	startTestOidcServer,
	type TestOidcServer,
	testSettings,
} from "../src/testing/index.ts";
import type { Harness, HarnessResponse } from "./helpers/harness.ts";
import {
	type Any,
	buildFixture,
	errorOf,
	newTeam,
	ok,
	type Person,
	personOf,
	type TeamFixture,
} from "./helpers/security.ts";
import { testSshCa } from "./helpers/ssh.ts";
import { type ApiWorld, apiWorld } from "./helpers/world.ts";

const OPERATORS = "umiak-operators";
const GW = "gw-token-operator-0123456789abcdef";
const UNKNOWN_SANDBOX = "sb_01jbx2v7d3m6c8q9w0e4r5t6y7";

interface Init {
	json?: unknown;
	body?: string;
	headers?: Record<string, string>;
}

/** A request as some caller; `headers` of the caller are added. */
type Caller = (
	method: string,
	path: string,
	init?: Init,
) => Promise<HarnessResponse>;

function caller(h: Harness, headers: Record<string, string> = {}): Caller {
	return (method, path, init = {}) =>
		h.request(method, path, {
			...init,
			headers: { ...init.headers, ...headers },
		});
}

describe.skipIf(skipPg())("operator blocks (S8 C3)", () => {
	let db: TestDatabase;
	let w: ApiWorld;
	let oidc: TestOidcServer;
	let deps: Partial<ApiDeps>;
	/** Deps of people resolved with the operator group configured. */
	let opDeps: Partial<ApiDeps>;
	let teamB: string;
	let keyHarness: Harness;
	let key: Caller;
	let ownerB: Person;
	let owner: Caller;
	let operator: Person;
	let op: Caller;
	let gateway: Harness;

	beforeAll(async () => {
		db = await createTestDatabase({ max: 20 });
		w = await apiWorld(db.pool, {
			topology: { node: { ramCapMb: 10_000_000 } },
			quota: { maxSavedSnapshots: 1000 },
		});
		oidc = await startTestOidcServer();
		deps = { sshCa: testSshCa() };
		opDeps = {
			...deps,
			identity: new PgIdentityStore({
				pool: db.pool,
				operatorGroups: [OPERATORS],
			}),
			settings: testSettings({
				UMIAK_API_RATE_BURST: "100000",
				UMIAK_API_RATE_STARTS_PER_MIN: "100000",
				UMIAK_OIDC_ISSUER: oidc.issuer,
				UMIAK_OPERATOR_GROUPS: OPERATORS,
			}),
		};
		teamB = await newTeam(db.pool);
		keyHarness = w.harness({
			bearer: (await issueApiKey(w.identity, { teamId: teamB })).secret,
			deps,
		});
		key = caller(keyHarness);
		ownerB = await personOf(w, teamB, "owner", opDeps);
		owner = caller(ownerB.h, ownerB.headers);
		// An operator who is a member of yet another team: no Umiak-Team needed.
		const o = await personOf(w, await newTeam(db.pool), "member", opDeps);
		operator = {
			...o,
			headers: { ...o.headers, "x-auth-request-groups": OPERATORS },
		};
		op = caller(operator.h, operator.headers);
		gateway = w.harness({
			listener: "internal",
			bearer: GW,
			deps: { serviceTokens: new ServiceTokens({ gateway: [GW] }) },
		});
	});
	afterAll(async () => {
		await oidc?.close();
		await w?.close();
		await db?.drop();
	});

	const fixture = () => buildFixture(w, teamB, keyHarness, ownerB);
	const route = (f: TeamFixture, port = f.port) =>
		gateway.request("GET", `/internal/v1/gateway/routes/${f.slug}-${port}`);

	function expectForbidden(r: HarnessResponse, reason: string, what = "") {
		expect(r.status, `${what} ${r.text.slice(0, 300)}`).toBe(403);
		expect(errorOf(r), what).toMatchObject({
			code: "forbidden",
			details: { reason },
		});
	}

	/** An operator's Keycloak token on the public listener: never operator rights (C6). */
	async function operatorJwt(): Promise<Caller> {
		const token = await oidc.token({
			sub: randomUUID(),
			email: `op-${randomUUID()}@example.com`,
			groups: [OPERATORS],
		});
		return caller(w.harness({ bearer: token, deps: opDeps }));
	}

	describe("who may call", () => {
		it("the operator session gets all five; keys, an operator's JWT and owners are 403 operator_required", async () => {
			const f = await fixture();
			const sb = `/v1/sandboxes/${f.sandbox}`;
			const calls: [string, string, Init?][] = [
				["GET", "/v1/sandboxes?allTeams=true"],
				[
					"GET",
					`/v1/sandboxes?allTeams=true&teamId=${encodeUuid("team", teamB)}`,
				],
				["POST", `${sb}/block`, { json: { reason: "abuse" } }],
				["POST", `${sb}/unblock`],
				["POST", `${sb}/ports/${f.port}/block`, { json: { reason: "abuse" } }],
				["POST", `${sb}/ports/${f.port}/unblock`],
			];
			const jwt = await operatorJwt();
			const me = await jwt("GET", "/v1/me");
			expect(me.status, me.text).toBe(200);
			expect((me.body as Any).isOperator).toBe(false);
			for (const [who, call] of [
				["team key", key],
				["operator JWT", jwt],
				["owner session", owner],
			] as const) {
				for (const [m, p, init] of calls) {
					expectForbidden(
						await call(m, p, init),
						"operator_required",
						`${who} ${m} ${p}`,
					);
				}
				// The same answer for a sandbox nobody has: nothing leaks.
				expectForbidden(
					await call("POST", `/v1/sandboxes/${UNKNOWN_SANDBOX}/block`, {
						json: { reason: "abuse" },
					}),
					"operator_required",
					who,
				);
			}
			const row = await db.pool.query(
				"SELECT blocked FROM runtime.sandboxes WHERE id = $1",
				[f.sandboxId],
			);
			expect(row.rows[0].blocked).toBe(false);

			for (const [m, p, init] of calls) {
				const r = await op(m, p, init);
				expect(r.status, `${m} ${p}: ${r.text.slice(0, 300)}`).toBe(200);
			}
		});

		it("an unknown sandbox or port is 404 for the operator; a bad body is 400", async () => {
			const f = await fixture();
			const sb = `/v1/sandboxes/${f.sandbox}`;
			const abuse = { json: { reason: "abuse" } };
			expect(
				(await op("POST", `/v1/sandboxes/${UNKNOWN_SANDBOX}/block`, abuse))
					.status,
			).toBe(404);
			expect(
				(await op("POST", `/v1/sandboxes/${UNKNOWN_SANDBOX}/unblock`)).status,
			).toBe(404);
			expect((await op("POST", `${sb}/ports/4999/block`, abuse)).status).toBe(
				404,
			);
			for (const json of [
				{},
				{ reason: "spam" },
				{ reason: "abuse", note: "x".repeat(501) },
				{ reason: "abuse", by: "me" },
			]) {
				const r = await op("POST", `${sb}/block`, { json });
				expect(r.status, JSON.stringify(json)).toBe(400);
				expect(errorOf(r).code).toBe("validation");
			}
			expect((await op("POST", `${sb}/ports/22/block`, abuse)).status).toBe(
				400,
			);
		});
	});

	describe("a blocked sandbox", () => {
		let f: TeamFixture;
		let sb: string;
		let blocked: Any;

		beforeAll(async () => {
			f = await fixture();
			sb = `/v1/sandboxes/${f.sandbox}`;
			blocked = ok(
				await op("POST", `${sb}/block`, {
					json: { reason: "abuse", note: "crypto mining" },
				}),
				"block",
			);
		});

		it("the answer is the Sandbox of its team with blocked and blockReason; the event has reason, note, by", async () => {
			expect(blocked).toMatchObject({
				id: f.sandbox,
				teamId: encodeUuid("team", teamB),
				blocked: true,
				blockReason: "abuse",
			});
			const ev = await db.pool.query(
				"SELECT data FROM runtime.sandbox_events WHERE sandbox_id = $1 AND type = 'blocked'",
				[f.sandboxId],
			);
			expect(ev.rows).toEqual([
				{
					data: { reason: "abuse", note: "crypto mining", by: operator.userId },
				},
			]);
		});

		const octet = { "content-type": "application/octet-stream" };
		const FORBIDDEN: [string, (f: TeamFixture) => [string, string, Init?]][] = [
			[
				"exec",
				(f) => [
					"POST",
					`/v1/sandboxes/${f.sandbox}/commands`,
					{ json: { command: "true" } },
				],
			],
			[
				"PTY",
				(f) => [
					"POST",
					`/v1/sandboxes/${f.sandbox}/ptys`,
					{ json: { command: "sh" } },
				],
			],
			[
				"command input",
				(f) => [
					"POST",
					`/v1/sandboxes/${f.sandbox}/commands/${f.command}/input`,
					{ json: { data: "eA==" } },
				],
			],
			[
				"command kill",
				(f) => [
					"POST",
					`/v1/sandboxes/${f.sandbox}/commands/${f.command}/kill`,
				],
			],
			[
				"PTY resize",
				(f) => [
					"POST",
					`/v1/sandboxes/${f.sandbox}/ptys/${f.pty}/resize`,
					{ json: { cols: 80, rows: 24 } },
				],
			],
			[
				"file write",
				(f) => [
					"PUT",
					`/v1/sandboxes/${f.sandbox}/files/content?path=~/x.txt`,
					{ body: "x", headers: octet },
				],
			],
			[
				"mkdir",
				(f) => [
					"POST",
					`/v1/sandboxes/${f.sandbox}/files/mkdir`,
					{ json: { path: "~/d" } },
				],
			],
			[
				"remove a file",
				(f) => ["DELETE", `/v1/sandboxes/${f.sandbox}/files?path=~/f.txt`],
			],
			[
				"new upload",
				(f) => [
					"POST",
					`/v1/sandboxes/${f.sandbox}/files/uploads`,
					{ json: { path: "~/u.bin" } },
				],
			],
			[
				"upload chunk",
				(f) => [
					"PUT",
					`/v1/sandboxes/${f.sandbox}/files/uploads/${f.upload}?offset=${f.uploadOffset}`,
					{ body: "x", headers: octet },
				],
			],
			[
				"publish a port",
				(f) => [
					"PUT",
					`/v1/sandboxes/${f.sandbox}/ports/4000`,
					{ json: { access: "token" } },
				],
			],
			[
				"change a port",
				(f) => [
					"PUT",
					`/v1/sandboxes/${f.sandbox}/ports/${f.port}`,
					{ json: { access: "sso" } },
				],
			],
			[
				"rotate a token",
				(f) => [
					"POST",
					`/v1/sandboxes/${f.sandbox}/ports/${f.port}/rotate-token`,
				],
			],
			[
				"unpublish",
				(f) => ["DELETE", `/v1/sandboxes/${f.sandbox}/ports/${f.port}`],
			],
			[
				"fork",
				(f) => ["POST", `/v1/sandboxes/${f.sandbox}/fork`, { json: {} }],
			],
			["recover", (f) => ["POST", `/v1/sandboxes/${f.sandbox}/recover`]],
			[
				"extend",
				(f) => [
					"POST",
					`/v1/sandboxes/${f.sandbox}/extend`,
					{ json: { ttlSeconds: 60 } },
				],
			],
			[
				"save snapshot",
				(f) => [
					"POST",
					"/v1/snapshots",
					{
						json: { sandbox: f.sandbox, name: `s-${randomUUID().slice(0, 8)}` },
					},
				],
			],
			[
				"PUT /env",
				(f) => [
					"PUT",
					`/v1/sandboxes/${f.sandbox}/env`,
					{ json: { env: { A: "1" } } },
				],
			],
			[
				"PATCH /env",
				(f) => [
					"PATCH",
					`/v1/sandboxes/${f.sandbox}/env`,
					{ json: { env: { A: "1" } } },
				],
			],
			[
				"PATCH name",
				(f) => [
					"PATCH",
					`/v1/sandboxes/${f.sandbox}`,
					{ json: { name: "renamed" } },
				],
			],
			[
				"PATCH slug",
				(f) => [
					"PATCH",
					`/v1/sandboxes/${f.sandbox}`,
					{ json: { slug: `rn-${randomUUID().slice(0, 8)}x` } },
				],
			],
		];

		it.each(FORBIDDEN)(
			"%s: 403 sandbox_blocked with a key and for the owner",
			async (name, build) => {
				const [method, path, init] = build(f);
				for (const [who, call] of [
					["key", key],
					["owner", owner],
				] as const) {
					expectForbidden(
						await call(method, path, init),
						"sandbox_blocked",
						`${name} (${who})`,
					);
				}
			},
		);

		it("reads stay allowed: get, list, env, ports, commands, files", async () => {
			expect(ok(await key("GET", sb))).toMatchObject({
				blocked: true,
				blockReason: "abuse",
			});
			const list = ok(await key("GET", "/v1/sandboxes"));
			expect(list.data.find((x: Any) => x.id === f.sandbox)).toMatchObject({
				blocked: true,
			});
			ok(await key("GET", `${sb}/env`));
			const ports = ok(await key("GET", `${sb}/ports`));
			expect(ports.hosted[0]).toMatchObject({
				port: f.port,
				blocked: false,
				blockReason: null,
			});
			ok(await key("GET", `${sb}/commands`));
			ok(await key("GET", `${sb}/commands/${f.command}`));
			ok(await key("GET", `${sb}/files/content?path=~/f.txt`));
			ok(await key("GET", `${sb}/files/list?path=~`));
			ok(await key("GET", `${sb}/files/stat?path=~/f.txt`));
		});

		it("the gateway gets blocked: true with the sandbox's reason", async () => {
			const r = await route(f);
			expect(r.status, r.text).toBe(200);
			expect(r.body).toMatchObject({ blocked: true, blockReason: "abuse" });
		});

		it("an operator with Umiak-Team still acts; unblock lifts everything at once", async () => {
			const team = { "umiak-team": encodeUuid("team", teamB) };
			const ext = await op("POST", `${sb}/extend`, {
				headers: team,
				json: { ttlSeconds: 600 },
			});
			expect(ext.status, ext.text).toBe(200);

			const un = ok(
				await op("POST", `${sb}/unblock`, { json: { note: "false alarm" } }),
			);
			expect(un).toMatchObject({ blocked: false, blockReason: null });
			const again = await key("POST", `${sb}/extend`, {
				json: { ttlSeconds: 60 },
			});
			expect(again.status, again.text).toBe(200);
			expect((await route(f)).body).toMatchObject({
				blocked: false,
				blockReason: null,
			});
			const ev = await db.pool.query(
				"SELECT data FROM runtime.sandbox_events WHERE sandbox_id = $1 AND type = 'unblocked'",
				[f.sandboxId],
			);
			expect(ev.rows).toEqual([
				{ data: { reason: "abuse", note: "false alarm", by: operator.userId } },
			]);
		});

		it("stop and delete stay allowed; resume is not", async () => {
			const fx = await fixture();
			const path = `/v1/sandboxes/${fx.sandbox}`;
			ok(await op("POST", `${path}/block`, { json: { reason: "abuse" } }));
			const stop = await key("POST", `${path}/stop`);
			expect(stop.status, stop.text).toBe(202);
			await w.finishOperation(
				(
					await db.pool.query(
						"SELECT id FROM runtime.operations WHERE sandbox_id = $1 AND kind = 'stop'",
						[fx.sandboxId],
					)
				).rows[0].id,
				"succeeded",
			);
			await w.markState(fx.sandboxId, "stopped");
			expectForbidden(
				await key("POST", `${path}/resume`),
				"sandbox_blocked",
				"resume",
			);
			const del = await key("DELETE", path, {
				headers: { "umiak-confirm-delete": fx.sandbox },
			});
			expect(del.status, del.text).toBe(202);
		});
	});

	describe("a blocked port", () => {
		it("PUT, rotate-token and DELETE of that port are 403 port_blocked; other ports work; unblock lifts it", async () => {
			const f = await fixture();
			const sb = `/v1/sandboxes/${f.sandbox}`;
			const hp = ok(
				await op("POST", `${sb}/ports/${f.port}/block`, {
					json: { reason: "abuse", note: "phishing" },
				}),
			);
			expect(hp).toMatchObject({
				port: f.port,
				blocked: true,
				blockReason: "abuse",
			});
			expect(hp.token).toBeUndefined();

			for (const [m, p, json] of [
				["PUT", `${sb}/ports/${f.port}`, { access: "token" }],
				["PUT", `${sb}/ports/${f.port}`, { access: "public" }],
				["POST", `${sb}/ports/${f.port}/rotate-token`, undefined],
				["DELETE", `${sb}/ports/${f.port}`, undefined],
			] as const) {
				for (const [who, call] of [
					["key", key],
					["owner", owner],
				] as const) {
					const r = await call(m, p, json === undefined ? {} : { json });
					expectForbidden(r, "port_blocked", `${who} ${m} ${p}`);
				}
			}
			const ports = ok(await key("GET", `${sb}/ports`));
			expect(ports.hosted).toEqual([
				expect.objectContaining({
					port: f.port,
					blocked: true,
					blockReason: "abuse",
				}),
			]);
			expect((await route(f)).body).toMatchObject({
				blocked: true,
				blockReason: "abuse",
			});
			// Another port and the sandbox itself are not blocked.
			const other = await key("PUT", `${sb}/ports/4001`, {
				json: { access: "token" },
			});
			expect(other.status, other.text).toBe(201);
			expect((await route(f, 4001)).body).toMatchObject({ blocked: false });
			ok(await key("POST", `${sb}/extend`, { json: { ttlSeconds: 60 } }));

			const un = ok(await op("POST", `${sb}/ports/${f.port}/unblock`));
			expect(un).toMatchObject({ blocked: false, blockReason: null });
			ok(await key("POST", `${sb}/ports/${f.port}/rotate-token`));
		});
	});

	describe("GET /v1/sandboxes?allTeams=true", () => {
		it("the operator sees every team with teamId, filtered by teamId; bad filters are 400", async () => {
			const fb = await fixture();
			const own = await w.seed({ state: "ready" });
			const all: Any[] = [];
			let cursor: string | null = null;
			do {
				const q: string =
					cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
				const page: Any = ok(
					await op("GET", `/v1/sandboxes?allTeams=true&limit=200${q}`),
				);
				all.push(...page.data);
				cursor = page.nextCursor;
			} while (cursor !== null);
			const ids = all.map((s) => s.id);
			expect(ids).toContain(fb.sandbox);
			expect(ids).toContain(encodeUuid("sandbox", own.sandboxId));
			expect(all.find((s) => s.id === fb.sandbox)?.teamId).toBe(
				encodeUuid("team", teamB),
			);

			const onlyB = ok(
				await op(
					"GET",
					`/v1/sandboxes?allTeams=true&teamId=${encodeUuid("team", teamB)}&limit=200`,
				),
			);
			expect(onlyB.data.map((s: Any) => s.id)).toContain(fb.sandbox);
			for (const s of onlyB.data)
				expect(s.teamId).toBe(encodeUuid("team", teamB));

			// Without allTeams: the operator's own team only.
			const mine = ok(await op("GET", "/v1/sandboxes?limit=200"));
			expect(mine.data.map((s: Any) => s.id)).not.toContain(fb.sandbox);

			for (const q of [
				`teamId=${encodeUuid("team", teamB)}`,
				"allTeams=true&teamId=nope",
				"allTeams=yes",
			]) {
				const r = await op("GET", `/v1/sandboxes?${q}`);
				expect(r.status, q).toBe(400);
				expect(errorOf(r).code, q).toBe("validation");
			}
			// allTeams=false is the plain list.
			expect((await key("GET", "/v1/sandboxes?allTeams=false")).status).toBe(
				200,
			);
		});
	});
});
