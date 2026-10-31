import { decodeUuid, encodeUuid } from "@sbx/auth";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureLogs } from "../src/testing/index.ts";
import type { Harness, HarnessResponse } from "./helpers/harness.ts";
import { type ApiWorld, apiWorld } from "./helpers/world.ts";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the conformance harness
type Body = any;
const body = (r: HarnessResponse): Body => r.body as Body;

const SECRET = "env-secret-marker-5f1e7c";
const FILE_SECRET = "file-secret-marker-a93d";
const B64 = Buffer.from(FILE_SECRET).toString("base64");

describe.skipIf(skipPg())("env routes", () => {
	let db: TestDatabase;
	let w: ApiWorld;
	let h: Harness;

	beforeAll(async () => {
		db = await createTestDatabase({ max: 20 });
		w = await apiWorld(db.pool);
		h = w.harness();
	});
	afterAll(async () => {
		await w?.close();
		await db?.drop();
	});

	it("GET /env: env values, secret names and file metadata, never secret values", async () => {
		const s = await w.seed({
			state: "ready",
			sets: {
				env: { NODE_ENV: "test" },
				secrets: { TOKEN: SECRET, ANOTHER: SECRET },
				secretFiles: [
					{ name: "a.json", contentBase64: B64 },
					{ name: "b.pem", contentBase64: B64, mode: 0o400, linkPath: "/x/b" },
				],
			},
		});
		const r = await h.request("GET", `/v1/sandboxes/${s.slug}/env`);
		expect(r.status).toBe(200);
		expect(body(r)).toEqual({
			env: { NODE_ENV: "test" },
			secretKeys: ["ANOTHER", "TOKEN"],
			secretFiles: [
				{
					name: "a.json",
					mode: 0o440,
					linkPath: null,
					sizeBytes: FILE_SECRET.length,
				},
				{
					name: "b.pem",
					mode: 0o400,
					linkPath: "/x/b",
					sizeBytes: FILE_SECRET.length,
				},
			],
		});
		expect(r.text).not.toContain(SECRET);
		expect(r.text).not.toContain(B64);
	});

	it("tracks Windows files before live delivery, keeps uncertainty on failure, clears only after empty delivery", async () => {
		const s = await w.seed({ state: "ready" });
		await db.pool.query(
			"UPDATE runtime.template_builds SET os = 'windows' WHERE id = (SELECT template_build_id FROM runtime.machines WHERE id = $1)",
			[s.machineId],
		);
		const dirty = async () =>
			(
				await db.pool.query<{ secret_files_on_disk: boolean }>(
					"SELECT secret_files_on_disk FROM runtime.machines WHERE id = $1",
					[s.machineId],
				)
			).rows[0]?.secret_files_on_disk;
		const put = await h.request("PUT", `/v1/sandboxes/${s.slug}/env`, {
			json: { secretFiles: [{ name: "key", contentBase64: B64 }] },
		});
		expect(body(put).delivered).toBe(true);
		expect(await dirty()).toBe(true);
		w.agent.setUnavailable(s.machineId as string, true);
		try {
			const empty = await h.request("PUT", `/v1/sandboxes/${s.slug}/env`, {
				json: { secretFiles: [] },
			});
			expect(body(empty).delivered).toBe(false);
			expect(await dirty()).toBe(true);
		} finally {
			w.agent.setUnavailable(s.machineId as string, false);
		}
		const empty = await h.request("PUT", `/v1/sandboxes/${s.slug}/env`, {
			json: { secretFiles: [] },
		});
		expect(body(empty).delivered).toBe(true);
		expect(await dirty()).toBe(false);
	});

	it("PUT /env on a ready sandbox replaces the given sets and delivers them; the secret is in no log", async () => {
		const logs = captureLogs();
		const lh = w.harness({ deps: { log: logs.log } });
		const s = await w.seed({
			state: "ready",
			sets: { env: { OLD: "1" }, secrets: { KEEP: "k" }, secretFiles: [] },
		});
		const r = await lh.request("PUT", `/v1/sandboxes/${s.slug}/env`, {
			json: {
				env: { NEW: "2" },
				secretFiles: [{ name: "f", contentBase64: B64 }],
			},
		});
		expect(r.status).toBe(200);
		expect(body(r)).toMatchObject({
			delivered: true,
			env: { NEW: "2" },
			secretKeys: ["KEEP"],
		});
		const m = w.agent.machine(s.machineId as string);
		expect(m.env).toEqual({ NEW: "2" });
		expect(Buffer.from(m.secretFiles[0]?.content ?? []).toString()).toBe(
			FILE_SECRET,
		);

		const put = await lh.request("PUT", `/v1/sandboxes/${s.slug}/env`, {
			json: { secrets: { TOKEN: SECRET } },
		});
		expect(body(put).secretKeys).toEqual(["TOKEN"]);
		expect(m.secretEnv).toEqual({ TOKEN: SECRET });
		expect(put.text).not.toContain(SECRET);
		// A refused value is not echoed either.
		const bad = await lh.request("PUT", `/v1/sandboxes/${s.slug}/env`, {
			json: { secrets: { SBX_RESERVED: SECRET } },
		});
		expect(bad.status).toBe(400);
		expect(bad.text).not.toContain(SECRET);
		expect(logs.text()).not.toContain(SECRET);
		expect(logs.text()).not.toContain(FILE_SECRET);
		expect(logs.text()).not.toContain(B64);
		expect(logs.entries().length).toBeGreaterThan(0);
	});

	it("PATCH /env merges by key, null deletes; delivered to the agent", async () => {
		const s = await w.seed({
			state: "ready",
			sets: {
				env: { A: "1", B: "2" },
				secrets: { S1: "x", S2: "y" },
				secretFiles: [{ name: "f1", contentBase64: B64 }],
			},
		});
		const r = await h.request("PATCH", `/v1/sandboxes/${s.slug}/env`, {
			json: {
				env: { B: null, C: "3" },
				secrets: { S1: null },
				secretFiles: { f1: null, f2: { contentBase64: B64, mode: 0o600 } },
			},
		});
		expect(r.status).toBe(200);
		expect(body(r)).toEqual({
			delivered: true,
			env: { A: "1", C: "3" },
			secretKeys: ["S2"],
			secretFiles: [
				{
					name: "f2",
					mode: 0o600,
					linkPath: null,
					sizeBytes: FILE_SECRET.length,
				},
			],
		});
		const m = w.agent.machine(s.machineId as string);
		expect(m.env).toEqual({ A: "1", C: "3" });
		expect(m.secretEnv).toEqual({ S2: "y" });
		expect(m.secretFiles.map((f) => f.name)).toEqual(["f2"]);
		const g = await h.request("GET", `/v1/sandboxes/${s.slug}/env`);
		expect(body(g).env).toEqual({ A: "1", C: "3" });
	});

	it("delivered: false when the sandbox is not ready or the agent is unavailable; the sets are stored", async () => {
		const stopped = await w.seed({ state: "stopped", machineState: "stopped" });
		const a = await h.request("PUT", `/v1/sandboxes/${stopped.slug}/env`, {
			json: { env: { X: "1" } },
		});
		expect(a.status).toBe(200);
		expect(body(a).delivered).toBe(false);

		const ready = await w.seed({ state: "ready" });
		w.agent.setUnavailable(ready.machineId as string, true);
		try {
			const b = await h.request("PATCH", `/v1/sandboxes/${ready.slug}/env`, {
				json: { env: { Y: "2" } },
			});
			expect(b.status).toBe(200);
			expect(body(b).delivered).toBe(false);
			expect(body(b).env).toEqual({ Y: "2" });
		} finally {
			w.agent.setUnavailable(ready.machineId as string, false);
		}
	});

	it("deleted sandboxes: 409 invalid_state; unknown fields: 400; scope sandboxes:write", async () => {
		const gone = await w.seed({ state: "deleting" });
		const r = await h.request("PUT", `/v1/sandboxes/${gone.slug}/env`, {
			json: { env: {} },
		});
		expect(r.status).toBe(409);
		expect(body(r).error.code).toBe("invalid_state");

		const s = await w.seed({ state: "ready" });
		const unknown = await h.request("PUT", `/v1/sandboxes/${s.slug}/env`, {
			json: { vars: {} },
		});
		expect(unknown.status).toBe(400);

		const k = await w.key(["sandboxes:read"]);
		const kh = w.harness({ bearer: k.secret });
		expect(
			(await kh.request("GET", `/v1/sandboxes/${s.slug}/env`)).status,
		).toBe(200);
		const denied = await kh.request("PATCH", `/v1/sandboxes/${s.slug}/env`, {
			json: { env: { A: "1" } },
		});
		expect(denied.status).toBe(403);
		expect(body(denied).error.details.requiredScope).toBe("sandboxes:write");
	});
});

describe.skipIf(skipPg())("environment applied at create (S8 §10.1)", () => {
	let db: TestDatabase;
	let w: ApiWorld;
	let h: Harness;
	let baseId: string;

	beforeAll(async () => {
		db = await createTestDatabase({ max: 20 });
		w = await apiWorld(db.pool, {
			topology: { node: { ramCapMb: 1_000_000 } },
		});
		h = w.harness();
		const base = await w.environments.create(
			w.teamId,
			{
				name: "base",
				isDefault: true,
				env: { FROM_ENV: "e", SHARED: "env" },
				secrets: { ENV_SECRET: SECRET },
				secretFiles: [
					{ name: "env.json", contentBase64: B64 },
					{ name: "same.json", contentBase64: B64 },
				],
			},
			null,
		);
		baseId = base.id;
		await w.environments.create(
			w.teamId,
			{ name: "other", env: { OTHER: "o" } },
			null,
		);
	});
	afterAll(async () => {
		await w?.close();
		await db?.drop();
	});

	const envOf = async (r: HarnessResponse) => {
		const id = decodeUuid("sandbox", body(r).sandbox.id) as string;
		return w.env.svc.getEnv(w.env.p, id);
	};

	it("absent: the team's default environment, request sets on top", async () => {
		const r = await h.request("POST", "/v1/sandboxes", {
			json: {
				env: { SHARED: "req" },
				secretFiles: [
					{ name: "same.json", contentBase64: "eA==" },
					{ name: "req.json", contentBase64: "eQ==" },
				],
			},
		});
		expect(r.status).toBe(202);
		expect(r.text).not.toContain(SECRET);
		const sets = await envOf(r);
		expect(sets.env).toEqual({ FROM_ENV: "e", SHARED: "req" });
		expect(sets.secrets).toEqual({ ENV_SECRET: SECRET });
		expect(sets.secretFiles.map((f) => [f.name, f.contentBase64])).toEqual([
			["env.json", B64],
			["same.json", "eA=="],
			["req.json", "eQ=="],
		]);
		expect(body(r).sandbox.environment).toBeNull();
	});

	it("null: no environment; a name or env_ id: that one (needs environments:read)", async () => {
		const none = await h.request("POST", "/v1/sandboxes", {
			json: { environment: null, env: { ONLY: "1" } },
		});
		expect((await envOf(none)).env).toEqual({ ONLY: "1" });

		const byName = await h.request("POST", "/v1/sandboxes", {
			json: { environment: "other" },
		});
		expect((await envOf(byName)).env).toEqual({ OTHER: "o" });

		const byId = await h.request("POST", "/v1/sandboxes", {
			json: { environment: encodeUuid("environment", baseId) },
		});
		expect((await envOf(byId)).env).toEqual({ FROM_ENV: "e", SHARED: "env" });

		const missing = await h.request("POST", "/v1/sandboxes", {
			json: { environment: "nope" },
		});
		expect(missing.status).toBe(404);
		expect(body(missing).error.code).toBe("not_found");

		const k = await w.key(["sandboxes:write"]);
		const kh = w.harness({ bearer: k.secret });
		const denied = await kh.request("POST", "/v1/sandboxes", {
			json: { environment: "other" },
		});
		expect(denied.status).toBe(403);
		expect(body(denied).error.details.requiredScope).toBe("environments:read");
		// The default environment needs no environments:read.
		const dflt = await kh.request("POST", "/v1/sandboxes", { json: {} });
		expect(dflt.status).toBe(202);
		expect((await envOf(dflt)).env).toEqual({ FROM_ENV: "e", SHARED: "env" });
	});

	it("excludeOwnerSecrets: true is 400 until sandboxes store it; false is accepted", async () => {
		const r = await h.request("POST", "/v1/sandboxes", {
			json: { excludeOwnerSecrets: true },
		});
		expect(r.status).toBe(400);
		expect(body(r).error.code).toBe("validation");
		expect(JSON.stringify(body(r).error.details)).toContain(
			"excludeOwnerSecrets",
		);
		const ok = await h.request("POST", "/v1/sandboxes", {
			json: { excludeOwnerSecrets: false },
		});
		expect(ok.status).toBe(202);
		expect(body(ok).sandbox.excludeOwnerSecrets).toBe(false);
	});

	it("an Idempotency-Key retry replays after the default environment was edited or deleted", async () => {
		const tmp = await w.environments.create(
			w.teamId,
			{ name: "tmp", env: { V: "1" } },
			null,
		);
		// Make `tmp` the default for this test.
		await w.environments.patch(w.teamId, tmp.id, { isDefault: true }, null);
		try {
			const key = `env-retry-${Date.now()}`;
			const json = { env: { REQ: "1" } };
			const a = await h.request("POST", "/v1/sandboxes", {
				json,
				headers: { "idempotency-key": key },
			});
			expect(a.status).toBe(202);
			expect((await envOf(a)).env).toEqual({ V: "1", REQ: "1" });

			await w.environments.patch(w.teamId, tmp.id, { env: { V: "2" } }, null);
			const b = await h.request("POST", "/v1/sandboxes", {
				json,
				headers: { "idempotency-key": key },
			});
			expect(b.status).toBe(202);
			expect(b.headers.get("idempotency-replayed")).toBe("true");
			expect(body(b).sandbox.id).toBe(body(a).sandbox.id);

			await w.environments.delete(w.teamId, tmp.id);
			const c = await h.request("POST", "/v1/sandboxes", {
				json,
				headers: { "idempotency-key": key },
			});
			expect(c.status).toBe(202);
			expect(c.headers.get("idempotency-replayed")).toBe("true");
			expect(body(c).sandbox.id).toBe(body(a).sandbox.id);
			expect((await envOf(c)).env).toEqual({ V: "1", REQ: "1" });
		} finally {
			await w.environments.patch(w.teamId, baseId, { isDefault: true }, null);
		}
	});
});
