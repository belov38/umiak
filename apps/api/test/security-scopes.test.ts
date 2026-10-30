// Scope and role matrix over every operation of the public document (S7 §6
// scope column, §7.2, §7.3, §7.5, §16 "матрица ручка × scope"): a key
// without the operation's scope is 403 with details.requiredScope, a key
// with only that scope gets past the guards, person-only operations refuse
// keys (user_required), owner-only operations refuse members (role), and
// /me, /limits, /templates, /sizes and DELETE /api-keys/self take any key.
import { SCOPES, type Scope } from "@sbx/auth";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiDeps } from "../src/index.ts";
import {
	createHarness,
	type Harness,
	type HarnessResponse,
	OPENAPI_DOC,
} from "./helpers/harness.ts";
import { ROUTE_LIST, ROUTES, type Route } from "./helpers/route-table.ts";
import {
	type Any,
	buildFixture,
	type Person,
	personOf,
	scopesWithout,
	send,
	type TeamFixture,
} from "./helpers/security.ts";
import { testSshCa } from "./helpers/ssh.ts";
import { type ApiWorld, apiWorld } from "./helpers/world.ts";

const err = (r: HarnessResponse): Any => (r.body as Any)?.error;

/** Error codes of a refused credential or right. */
const ACCESS_CODES = ["unauthorized", "forbidden", "team_forbidden"];

describe("the route table", () => {
	it("lists exactly the operations of openapi/v1.json, with their method and path", () => {
		const documented = new Map<string, string>();
		for (const [path, item] of Object.entries(OPENAPI_DOC.paths)) {
			for (const [method, op] of Object.entries(item)) {
				const id = (op as { operationId?: string }).operationId;
				if (id !== undefined) {
					documented.set(id, `${method.toUpperCase()} ${path}`);
				}
			}
		}
		expect(Object.keys(ROUTES).sort()).toEqual([...documented.keys()].sort());
		for (const [id, r] of ROUTE_LIST) {
			expect(`${r.method} ${r.path}`, id).toBe(documented.get(id));
		}
	});

	it("anonymous and person-only entries match the document's security", () => {
		for (const [id, r] of ROUTE_LIST) {
			const [path, method] = [r.path, r.method.toLowerCase()];
			const op = OPENAPI_DOC.paths[path]?.[method] as {
				security?: Record<string, string[]>[];
			};
			const security = JSON.stringify(op.security ?? null);
			if (r.anonymous) expect(security, id).toBe("[]");
			else if (r.human) expect(security, id).toBe('[{"keycloak":[]}]');
			else expect(security, id).toBe("null");
		}
	});

	it("names a resource for every path parameter", () => {
		const param: Record<string, string> = {
			sandbox: "sandbox",
			command: "command",
			upload: "upload",
			operation: "operation",
			name: "snapshot",
			port: "port",
			environment: "environment",
		};
		for (const [id, r] of ROUTE_LIST) {
			for (const [, p] of r.path.matchAll(/\{([^}]+)\}/g)) {
				let want = param[p as string];
				if (p === "command" && r.path.includes("/ptys/")) want = "pty";
				if (p === "key") {
					want = r.path.startsWith("/v1/ssh-keys") ? "sshKey" : "apiKey";
				}
				expect(r.resources, `${id} {${p}}`).toContain(want);
			}
		}
	});
});

describe.skipIf(skipPg())("scopes and roles on every operation", () => {
	let db: TestDatabase;
	let w: ApiWorld;
	let deps: Partial<ApiDeps>;
	let full: Harness;
	let owner: Person;
	let member: Person;
	let f: TeamFixture;
	const keys = new Map<string, string>();

	/** A harness with a key of exactly these scopes (cached by scope set). */
	async function withScopes(scopes: Scope[]): Promise<Harness> {
		const id = [...scopes].sort().join(" ");
		let secret = keys.get(id);
		if (secret === undefined) {
			secret = (await w.key(scopes)).secret;
			keys.set(id, secret);
		}
		return w.harness({ bearer: secret, deps });
	}

	beforeAll(async () => {
		db = await createTestDatabase({ max: 20 });
		w = await apiWorld(db.pool);
		deps = { sshCa: testSshCa() };
		full = w.harness({ deps });
		owner = await personOf(w, w.teamId, "owner", deps);
		member = await personOf(w, w.teamId, "member", deps);
		f = await buildFixture(w, w.teamId, full, owner);
	});
	afterAll(async () => {
		await w?.close();
		await db?.drop();
	});

	/** The fixture for a route: a fresh one when the route consumes it. */
	const fixtureFor = async (r: Route) =>
		r.destructive ? buildFixture(w, w.teamId, full, owner) : f;

	const scoped = ROUTE_LIST.filter(([, r]) => r.scope !== null && !r.human);

	it.each(scoped)(
		"%s: a key with every other scope is 403 forbidden, details.requiredScope",
		async (_id, r) => {
			const h = await withScopes(scopesWithout(r.scope as Scope));
			const res = await send(h, r.method, r.request(f));
			expect(res.status).toBe(403);
			if (r.method !== "HEAD") {
				expect(err(res)).toMatchObject({
					code: "forbidden",
					details: { requiredScope: r.scope },
				});
			}
		},
	);

	it.each(scoped)(
		"%s: a key with only its scope gets past the guards",
		async (_id, r) => {
			const h = await withScopes([r.scope as Scope]);
			const res = await send(h, r.method, r.request(await fixtureFor(r)));
			expect(res.status, res.text).not.toBe(401);
			if (res.status === 403) {
				expect(ACCESS_CODES, res.text).not.toContain(err(res)?.code);
			}
		},
	);

	const withBodyScopes = ROUTE_LIST.filter(([, r]) => r.bodyScopes);

	it.each(withBodyScopes)(
		"%s: a body that needs another scope is 403 without it",
		async (_id, r) => {
			for (const [scope, req] of r.bodyScopes?.(f) ?? []) {
				const without = await withScopes(scopesWithout(scope));
				const res = await send(without, r.method, req);
				expect(res.status, scope).toBe(403);
				expect(err(res)).toMatchObject({
					code: "forbidden",
					details: { requiredScope: scope },
				});
				const h = await withScopes([r.scope as Scope, scope]);
				const okRes = await send(h, r.method, req);
				expect(ACCESS_CODES, okRes.text).not.toContain(err(okRes)?.code);
			}
		},
	);

	const human = ROUTE_LIST.filter(([, r]) => r.human);

	it.each(human)(
		"%s: a key with every scope is 403 user_required; an owner gets past the guards",
		async (_id, r) => {
			const res = await send(full, r.method, r.request(f));
			expect(res.status).toBe(403);
			expect(err(res)).toMatchObject({
				code: "forbidden",
				details: { reason: "user_required" },
			});
			const fx = await fixtureFor(r);
			const p = await send(owner.h, r.method, r.request(fx), owner.headers);
			expect(ACCESS_CODES, p.text).not.toContain(err(p)?.code);
			expect(p.status, p.text).toBeLessThan(400);
		},
	);

	const ownerOnly = ROUTE_LIST.filter(([, r]) => r.owner);

	it.each(ownerOnly)(
		"%s: a member is 403 role; an owner gets past the guards",
		async (_id, r) => {
			const res = await send(member.h, r.method, r.request(f), member.headers);
			expect(res.status).toBe(403);
			expect(err(res)).toMatchObject({
				code: "forbidden",
				details: { reason: "role" },
			});
			const fx = await fixtureFor(r);
			const p = await send(owner.h, r.method, r.request(fx), owner.headers);
			expect(p.status, p.text).toBeLessThan(400);
		},
	);

	const membersToo = ROUTE_LIST.filter(
		([, r]) => !r.anonymous && !r.owner && !r.keyOnly,
	);

	it.each(membersToo)(
		"%s: a member of the team gets past the guards",
		async (_id, r) => {
			if (r.websocket) return;
			const fx = await fixtureFor(r);
			const res = await send(member.h, r.method, r.request(fx), member.headers);
			expect(res.status, res.text).not.toBe(401);
			if (res.status === 403) {
				expect(ACCESS_CODES, res.text).not.toContain(err(res)?.code);
			}
		},
	);

	const anyKey = ROUTE_LIST.filter(
		([, r]) => r.scope === null && !r.human && !r.anonymous,
	);

	it("the operations that take any key are me, limits, templates, sizes and api-keys/self", () => {
		expect(anyKey.map(([id]) => id).sort()).toEqual([
			"apiKeys.revokeSelf",
			"limits.get",
			"me.get",
			"sizes.list",
			"templates.list",
		]);
	});

	it.each(anyKey)("%s: a key without scopes succeeds", async (_id, r) => {
		// DELETE /api-keys/self revokes the caller: not the shared key.
		const h = r.destructive
			? w.harness({ bearer: (await w.key([])).secret, deps })
			: await withScopes([]);
		const res = await send(h, r.method, r.request(f));
		expect(res.status, res.text).toBeLessThan(300);
	});

	it("DELETE /v1/api-keys/self: a person is 403 api_key_required", async () => {
		const r = ROUTES["apiKeys.revokeSelf"] as Route;
		const res = await send(owner.h, r.method, r.request(f), owner.headers);
		expect(res.status).toBe(403);
		expect(err(res)).toMatchObject({
			code: "forbidden",
			details: { reason: "api_key_required" },
		});
	});

	const anonymous = ROUTE_LIST.filter(([, r]) => r.anonymous);

	it.each(anonymous)(
		"%s: needs no credential, and a key without scopes is fine too",
		async (_id, r) => {
			const anon = createHarness({ deps: w.deps(deps) });
			const res = await anon.request(r.method, r.request(f).path);
			expect(res.status).toBe(200);
			const h = await withScopes([]);
			expect((await send(h, r.method, r.request(f))).status).toBe(200);
		},
	);

	it("every scope of §7.3 guards at least one operation", () => {
		const used = new Set<Scope>();
		for (const [, r] of ROUTE_LIST) {
			if (r.scope !== null) used.add(r.scope);
			for (const [s] of r.bodyScopes?.({} as never) ?? []) used.add(s);
		}
		expect([...used].sort()).toEqual([...SCOPES].sort());
	});
});
