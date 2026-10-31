import { randomUUID } from "node:crypto";
import { decodeUuid, encodeUuid, PgIdentityStore } from "@sbx/auth";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureLogs, testSettings } from "../src/testing/index.ts";
import type { Harness, HarnessResponse } from "./helpers/harness.ts";
import { newTeam, personOf } from "./helpers/security.ts";
import { type ApiWorld, apiWorld } from "./helpers/world.ts";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the conformance harness
type Body = any;
const body = (r: HarnessResponse): Body => r.body as Body;

const SECRET = "environment-secret-marker-71c2";
const FILE_SECRET = "environment-file-marker-0b9e";
const B64 = Buffer.from(FILE_SECRET).toString("base64");

describe.skipIf(skipPg())("environments (S8 §10.2)", () => {
	let db: TestDatabase;
	let w: ApiWorld;
	let h: Harness;
	let owner: { h: Harness; headers: Record<string, string>; userId: string };

	beforeAll(async () => {
		db = await createTestDatabase({ max: 20 });
		w = await apiWorld(db.pool, {
			topology: { node: { ramCapMb: 1_000_000 } },
		});
		h = w.harness();
		owner = await w.dbSession({ role: "owner" });
	});
	afterAll(async () => {
		await w?.close();
		await db?.drop();
	});

	const uniqueName = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;
	const asOwner = (method: string, path: string, json?: unknown) =>
		owner.h.request(method, path, {
			headers: owner.headers,
			...(json === undefined ? {} : { json }),
		});

	function fullBody(name: string) {
		return {
			name,
			env: { NODE_ENV: "production", B: "2", A: "1" },
			secrets: { TOKEN: SECRET },
			secretFiles: [
				{ name: "gcp.json", contentBase64: B64 },
				{
					name: "key.pem",
					contentBase64: B64,
					mode: 0o400,
					linkPath: "/home/user/.k",
				},
			],
			repositories: [
				{ url: "https://github.com/acme/web.git", branch: "main" },
				{ url: "git@github.com:acme/api.git", path: "src/api" },
			],
			excludeOwnerSecrets: true,
		};
	}

	it("an owner creates one: 201 with env values, secret names and file metadata, never secret values", async () => {
		const logs = captureLogs();
		const logged = await w.dbSession({
			role: "owner",
			deps: { log: logs.log },
		});
		const name = uniqueName("prod");
		const r = await logged.h.request("POST", "/v1/environments", {
			headers: logged.headers,
			json: fullBody(name),
		});
		expect(r.status, r.text).toBe(201);
		expect(r.text).not.toContain(SECRET);
		expect(r.text).not.toContain(B64);
		expect(logs.text()).not.toContain(SECRET);
		expect(logs.text()).not.toContain(B64);
		const e = body(r);
		expect(e).toMatchObject({
			name,
			isDefault: false,
			revision: 1,
			env: { NODE_ENV: "production", B: "2", A: "1" },
			envKeys: ["A", "B", "NODE_ENV"],
			secretKeys: ["TOKEN"],
			secretFiles: [
				{
					name: "gcp.json",
					mode: 0o440,
					linkPath: null,
					sizeBytes: FILE_SECRET.length,
				},
				{
					name: "key.pem",
					mode: 0o400,
					linkPath: "/home/user/.k",
					sizeBytes: FILE_SECRET.length,
				},
			],
			repositories: [
				{ url: "https://github.com/acme/web.git", branch: "main" },
				{ url: "git@github.com:acme/api.git", path: "src/api" },
			],
			excludeOwnerSecrets: true,
			updatedBy: encodeUuid("user", logged.userId),
		});
		expect(e.id).toMatch(/^env_/);

		// The stored sets keep the secret values.
		const rec = await w.environments.get(w.teamId, name);
		expect(rec?.sets.secrets).toEqual({ TOKEN: SECRET });
	});

	it("GET list: names and metadata only; GET one by name or env_ id adds env values", async () => {
		const name = uniqueName("list");
		const c = await asOwner("POST", "/v1/environments", fullBody(name));
		const id = body(c).id as string;

		const list = await h.request("GET", "/v1/environments");
		expect(list.status).toBe(200);
		expect(list.text).not.toContain(SECRET);
		const item = body(list).data.find((x: Body) => x.id === id);
		expect(item).toMatchObject({
			name,
			envKeys: ["A", "B", "NODE_ENV"],
			secretKeys: ["TOKEN"],
		});
		expect(item).not.toHaveProperty("env");
		expect(list.text).not.toContain("production");

		for (const ref of [name, id, id.toUpperCase()]) {
			const one = await h.request("GET", `/v1/environments/${ref}`);
			expect(one.status, ref).toBe(200);
			expect(body(one).id).toBe(id);
			expect(body(one).env).toEqual({ NODE_ENV: "production", B: "2", A: "1" });
			expect(one.text).not.toContain(SECRET);
		}
		for (const ref of [
			"nope",
			decodeUuid("environment", id) as string,
			"env_bad",
		]) {
			const none = await h.request("GET", `/v1/environments/${ref}`);
			expect(none.status, ref).toBe(404);
			expect(body(none).error.code).toBe("not_found");
		}
	});

	it("PATCH merges the sets by key (null deletes), replaces repositories, renames, revision + 1", async () => {
		const name = uniqueName("patch");
		const c = await asOwner("POST", "/v1/environments", fullBody(name));
		const renamed = uniqueName("renamed");
		const r = await asOwner("PATCH", `/v1/environments/${name}`, {
			name: renamed,
			env: { A: null, C: "3" },
			secrets: { TOKEN: null, OTHER: "x" },
			secretFiles: { "gcp.json": null, "new.txt": { contentBase64: "eA==" } },
			repositories: [{ url: "ssh://git@example.com/acme/x.git" }],
			excludeOwnerSecrets: false,
		});
		expect(r.status).toBe(200);
		expect(body(r)).toMatchObject({
			id: body(c).id,
			name: renamed,
			revision: 2,
			env: { NODE_ENV: "production", B: "2", C: "3" },
			secretKeys: ["OTHER"],
			repositories: [{ url: "ssh://git@example.com/acme/x.git" }],
			excludeOwnerSecrets: false,
		});
		expect(body(r).secretFiles.map((f: Body) => f.name)).toEqual([
			"key.pem",
			"new.txt",
		]);
		expect(r.text).not.toContain('"x"');
		const old = await h.request("GET", `/v1/environments/${name}`);
		expect(old.status).toBe(404);
	});

	it("validation: name, unknown fields, limits on the merged sets, repositories", async () => {
		const name = uniqueName("val");
		const tooMany = Object.fromEntries(
			Array.from({ length: 101 }, (_, i) => [`V${i}`, "1"]),
		);
		for (const json of [
			{ name: "Bad_Name" },
			{ name: "" },
			{ name: randomUUID() },
			{},
			{ name, extra: true },
			{ name, env: { "1BAD": "x" } },
			{ name, env: tooMany },
			{ name, repositories: [{ url: "https://user:pw@github.com/a/b.git" }] },
			{ name, repositories: [{ url: "ftp://github.com/a/b.git" }] },
			// Tokens in a query string would be shown to every reader.
			{
				name,
				repositories: [{ url: "https://github.com/a/b.git?token=t0k" }],
			},
			{ name, repositories: [{ url: "https://github.com/a/b.git?" }] },
			{ name, repositories: [{ url: "https://github.com/a/b.git#main" }] },
			{ name, repositories: [{ url: "ssh://git@host/a/b.git?x=1" }] },
			{ name, repositories: [{ url: "git@github.com:a/b.git?x=1" }] },
			{ name, repositories: [{ url: "git@github.com:a/b.git#x" }] },
			{
				name,
				repositories: [{ url: "https://github.com/a/b.git", path: "/abs" }],
			},
			{
				name,
				repositories: [
					{ url: "https://github.com/a/b.git", path: "a/../../b" },
				],
			},
			{
				name,
				repositories: Array.from({ length: 21 }, (_, i) => ({
					url: `https://github.com/a/r${i}.git`,
				})),
			},
		]) {
			const r = await asOwner("POST", "/v1/environments", json);
			expect(r.status, JSON.stringify(json).slice(0, 80)).toBe(400);
			expect(body(r).error.code).toBe("validation");
		}
		expect(await w.environments.get(w.teamId, name)).toBeNull();

		// A patch is checked on the merged result.
		await asOwner("POST", "/v1/environments", {
			name,
			env: Object.fromEntries(
				Array.from({ length: 100 }, (_, i) => [`V${i}`, "1"]),
			),
		});
		const over = await asOwner("PATCH", `/v1/environments/${name}`, {
			env: { EXTRA: "1" },
		});
		expect(over.status).toBe(400);
		expect(body(over).error.code).toBe("validation");
		expect((await w.environments.get(w.teamId, name))?.revision).toBe(1);
	});

	it("a taken name is 409 already_exists, on create and on rename", async () => {
		const a = uniqueName("a");
		const b = uniqueName("b");
		await asOwner("POST", "/v1/environments", { name: a });
		await asOwner("POST", "/v1/environments", { name: b });
		const dup = await asOwner("POST", "/v1/environments", { name: a });
		expect(dup.status).toBe(409);
		expect(body(dup).error.code).toBe("already_exists");
		const ren = await asOwner("PATCH", `/v1/environments/${b}`, { name: a });
		expect(ren.status).toBe(409);
		expect(body(ren).error.code).toBe("already_exists");
	});

	it("DELETE answers 204; then the environment is gone (404)", async () => {
		const name = uniqueName("del");
		const c = await asOwner("POST", "/v1/environments", { name });
		const d = await asOwner("DELETE", `/v1/environments/${body(c).id}`);
		expect(d.status).toBe(204);
		expect(d.text).toBe("");
		expect((await h.request("GET", `/v1/environments/${name}`)).status).toBe(
			404,
		);
		const again = await asOwner("DELETE", `/v1/environments/${name}`);
		expect(again.status).toBe(404);
	});

	it("a member reads but cannot create, change or delete (403 role)", async () => {
		const member = await w.dbSession({ role: "member" });
		const name = uniqueName("m");
		await asOwner("POST", "/v1/environments", { name, env: { K: "v" } });
		const req = (method: string, path: string, json?: unknown) =>
			member.h.request(method, path, {
				headers: member.headers,
				...(json === undefined ? {} : { json }),
			});

		expect((await req("GET", "/v1/environments")).status).toBe(200);
		expect((await req("GET", `/v1/environments/${name}`)).status).toBe(200);
		for (const [method, path, json] of [
			["POST", "/v1/environments", { name: uniqueName("m") }],
			["PATCH", `/v1/environments/${name}`, { env: { K: "changed" } }],
			["DELETE", `/v1/environments/${name}`, undefined],
		] as const) {
			const r = await req(method, path, json);
			expect(r.status, method).toBe(403);
			expect(body(r).error.code).toBe("forbidden");
			expect(body(r).error.details.reason).toBe("role");
		}
		const rec = await w.environments.get(w.teamId, name);
		expect(rec?.sets.env).toEqual({ K: "v" });
		expect(rec?.revision).toBe(1);
	});

	it("an operator session writes the environments of a team it is not in (S8 §6.2, §6.4)", async () => {
		const OPS = "sbx-operators";
		const o = await personOf(w, await newTeam(db.pool), "member", {
			identity: new PgIdentityStore({ pool: db.pool, operatorGroups: [OPS] }),
			settings: testSettings({ SBX_OPERATOR_GROUPS: OPS }),
		});
		const headers = {
			...o.headers,
			"x-auth-request-groups": OPS,
			"sbx-team": encodeUuid("team", w.teamId),
		};
		const req = (method: string, path: string, json?: unknown) =>
			o.h.request(method, path, {
				headers,
				...(json === undefined ? {} : { json }),
			});
		const name = uniqueName("op");
		expect((await req("POST", "/v1/environments", { name })).status).toBe(201);
		const p = await req("PATCH", `/v1/environments/${name}`, {
			env: { K: "v" },
		});
		expect(p.status).toBe(200);
		expect(body(p).revision).toBe(2);
		expect((await req("DELETE", `/v1/environments/${name}`)).status).toBe(204);
		expect(await w.environments.get(w.teamId, name)).toBeNull();

		// The same person without the operator group is refused.
		const plain = await o.h.request("POST", "/v1/environments", {
			headers: { ...o.headers, "sbx-team": encodeUuid("team", w.teamId) },
			json: { name: uniqueName("op") },
		});
		expect(plain.status).toBe(403);
		expect(body(plain).error.code).toBe("team_forbidden");
	});

	it("team keys need only the scopes: environments:write writes, environments:read reads", async () => {
		const writer = await w.key(["environments:write"]);
		const wh = w.harness({ bearer: writer.secret });
		const name = uniqueName("key");
		const c = await wh.request("POST", "/v1/environments", { json: { name } });
		expect(c.status).toBe(201);
		expect(body(c).updatedBy).toBeNull();
		const g = await wh.request("GET", "/v1/environments");
		expect(g.status).toBe(403);
		expect(body(g).error.details.requiredScope).toBe("environments:read");

		const reader = await w.key(["environments:read"]);
		const rh = w.harness({ bearer: reader.secret });
		expect((await rh.request("GET", `/v1/environments/${name}`)).status).toBe(
			200,
		);
		for (const [method, path, json] of [
			["POST", "/v1/environments", { name: uniqueName("k") }],
			["PATCH", `/v1/environments/${name}`, { env: { K: "v" } }],
			["DELETE", `/v1/environments/${name}`, undefined],
		] as const) {
			const r = await rh.request(
				method,
				path,
				json === undefined ? {} : { json },
			);
			expect(r.status, method).toBe(403);
			expect(body(r).error.details.requiredScope).toBe("environments:write");
		}
	});

	it("another team's environment is 404 by name and by id, and stays unchanged", async () => {
		const otherTeam = randomUUID();
		await db.pool.query(
			"INSERT INTO identity.teams (id, name) VALUES ($1, $2)",
			[otherTeam, `other-${otherTeam}`],
		);
		const name = uniqueName("theirs");
		const rec = await w.environments.create(
			otherTeam,
			{ name, env: { T: "1" } },
			null,
		);
		const id = encodeUuid("environment", rec.id);
		const list = await h.request("GET", "/v1/environments");
		expect(body(list).data.map((x: Body) => x.id)).not.toContain(id);
		for (const ref of [name, id]) {
			for (const [method, json] of [
				["GET", undefined],
				["PATCH", { env: { T: "2" } }],
				["DELETE", undefined],
			] as const) {
				const r = await h.request(
					method,
					`/v1/environments/${ref}`,
					json === undefined ? {} : { json },
				);
				expect(r.status, `${method} ${ref}`).toBe(404);
			}
		}
		const after = await w.environments.get(otherTeam, rec.id);
		expect(after?.revision).toBe(1);
		expect(after?.sets.env).toEqual({ T: "1" });
	});

	it("create applies the default environment made through the API; environment: null skips it", async () => {
		const name = uniqueName("dflt");
		const made = await asOwner("POST", "/v1/environments", {
			name,
			isDefault: true,
			env: { FROM_DEFAULT: "1" },
			secrets: { DEFAULT_SECRET: SECRET },
		});
		expect(body(made).isDefault).toBe(true);
		try {
			const envOf = async (r: HarnessResponse) => {
				expect(r.status).toBe(202);
				const id = decodeUuid("sandbox", body(r).sandbox.id) as string;
				return w.env.svc.getEnv(w.env.p, id);
			};
			const withDefault = await h.request("POST", "/v1/sandboxes", {
				json: { env: { REQ: "1" } },
			});
			const sets = await envOf(withDefault);
			expect(sets.env).toEqual({ FROM_DEFAULT: "1", REQ: "1" });
			expect(sets.secrets).toEqual({ DEFAULT_SECRET: SECRET });

			const without = await h.request("POST", "/v1/sandboxes", {
				json: { environment: null, env: { REQ: "1" } },
			});
			const none = await envOf(without);
			expect(none.env).toEqual({ REQ: "1" });
			expect(none.secrets).toEqual({});

			// Making another one the default moves the flag.
			const next = uniqueName("next");
			await asOwner("POST", "/v1/environments", {
				name: next,
				isDefault: true,
			});
			const first = await h.request("GET", `/v1/environments/${name}`);
			expect(body(first).isDefault).toBe(false);
			await asOwner("PATCH", `/v1/environments/${next}`, { isDefault: false });
		} finally {
			await w.environments.patch(w.teamId, name, { isDefault: false }, null);
		}
	});

	it("create with a bare UUID as environment is 404 like the environments routes, and creates nothing", async () => {
		const name = uniqueName("byuuid");
		const made = await asOwner("POST", "/v1/environments", {
			name,
			env: { X: "1" },
		});
		const raw = decodeUuid("environment", body(made).id) as string;
		const before = await db.pool.query(
			"SELECT count(*)::int AS n FROM runtime.sandboxes",
		);
		const r = await h.request("POST", "/v1/sandboxes", {
			json: { environment: raw },
		});
		expect(r.status).toBe(404);
		expect(body(r).error.code).toBe("not_found");
		expect((await h.request("GET", `/v1/environments/${raw}`)).status).toBe(
			404,
		);
		const after = await db.pool.query(
			"SELECT count(*)::int AS n FROM runtime.sandboxes",
		);
		expect(after.rows[0].n).toBe(before.rows[0].n);
	});
});
