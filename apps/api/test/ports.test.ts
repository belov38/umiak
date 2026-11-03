import { createHash, randomUUID } from "node:crypto";
import { encodeUuid } from "@umiak/auth";
import type { ConfigReader } from "@umiak/config";
import {
	createTestDatabase,
	skipPg,
	type TestDatabase,
} from "@umiak/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureLogs } from "../src/testing/index.ts";
import type { Harness, HarnessResponse } from "./helpers/harness.ts";
import { type ApiWorld, apiWorld } from "./helpers/world.ts";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the conformance harness
type Body = any;
const body = (r: HarnessResponse): Body => r.body as Body;

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();

describe.skipIf(skipPg())("hosted ports (S7 §11.2)", () => {
	let db: TestDatabase;
	let w: ApiWorld;
	let h: Harness;
	let publicEnabled = true;

	beforeAll(async () => {
		db = await createTestDatabase({ max: 20 });
		w = await apiWorld(db.pool);
		// The flag is read on every request (S8 C7): a test flips it.
		const base = w.env.config;
		const config = new Proxy(base, {
			get(t, k) {
				if (k === "defaults") {
					return async () => ({
						...(await t.defaults()),
						publicPortsEnabled: publicEnabled,
					});
				}
				const v = Reflect.get(t, k);
				return typeof v === "function" ? v.bind(t) : v;
			},
		}) as ConfigReader;
		h = w.harness({ deps: { config } });
	});
	afterAll(async () => {
		await w?.close();
		await db?.drop();
	});

	async function tokenHash(sandboxId: string, port: number) {
		const r = await db.pool.query<{ token_hash: Buffer | null }>(
			`SELECT token_hash FROM runtime.hosted_ports
			 WHERE sandbox_id = $1 AND port = $2 AND deleted_at IS NULL`,
			[sandboxId, port],
		);
		return r.rows[0]?.token_hash ?? null;
	}

	it("returns configured HTTP preview URLs for hosting, listing, token rotation and sandbox endpoints", async () => {
		const s = await w.seed({ state: "ready" });
		const local = w.harness({
			deps: {
				settings: {
					...h.deps.settings,
					previewScheme: "http",
					previewPort: 8085,
				},
			},
		});
		const path = `/v1/sandboxes/${s.slug}`;
		const url = `http://${s.slug}-3000.umiak.test:8085`;
		const hosted = body(await local.request("PUT", `${path}/ports/3000`));
		expect(hosted.url).toBe(url);
		expect(hosted.urlWithToken).toBe(`${url}/?_token=${hosted.token}`);
		expect(
			body(await local.request("GET", `${path}/ports`)).hosted[0].url,
		).toBe(url);
		const rotated = body(
			await local.request("POST", `${path}/ports/3000/rotate-token`),
		);
		expect(rotated.urlWithToken).toBe(`${url}/?_token=${rotated.token}`);
		expect(
			body(await local.request("GET", path)).endpoints.portUrlTemplate,
		).toBe(`http://${s.slug}-{port}.umiak.test:8085`);
	});

	it("PUT issues the token once; GET /ports never returns it; the same settings again is 200 without a token", async () => {
		const logs = captureLogs();
		const lh = w.harness({ deps: { log: logs.log, config: h.deps.config } });
		const s = await w.seed({ state: "ready" });
		const r = await lh.request("PUT", `/v1/sandboxes/${s.slug}/ports/3000`);
		expect(r.status).toBe(201);
		const p = body(r);
		const domain = h.deps.settings.umiakDomain;
		expect(p).toMatchObject({
			port: 3000,
			label: `${s.slug}-3000`,
			url: `https://${s.slug}-3000.${domain}`,
			access: "token",
			hostRewrite: "preserve",
			appProtocol: "http1",
			blocked: false,
			blockReason: null,
		});
		expect(p.token).toMatch(/^umiakp_[A-Za-z0-9_-]{43}$/);
		expect(p.urlWithToken).toBe(
			`https://${s.slug}-3000.${domain}/?_token=${p.token}`,
		);
		expect(await tokenHash(s.sandboxId, 3000)).toEqual(sha256(p.token));

		const list = await lh.request("GET", `/v1/sandboxes/${s.slug}/ports`);
		expect(list.status).toBe(200);
		expect(list.text).not.toContain(p.token);
		expect(body(list).hosted).toHaveLength(1);
		expect(body(list).hosted[0]).not.toHaveProperty("token");
		expect(body(list).hosted[0]).not.toHaveProperty("urlWithToken");
		expect(body(list).hosted[0].url).toBe(p.url);

		const again = await lh.request(
			"PUT",
			`/v1/sandboxes/${s.slug}/ports/3000`,
			{
				json: { access: "token" },
			},
		);
		expect(again.status).toBe(200);
		expect(body(again)).not.toHaveProperty("token");
		expect(body(again)).not.toHaveProperty("urlWithToken");
		expect(await tokenHash(s.sandboxId, 3000)).toEqual(sha256(p.token));
		expect(logs.text()).not.toContain(p.token);
	});

	it("PUT changes options and mode; a switch to token issues a new token", async () => {
		const s = await w.seed({ state: "ready" });
		const path = `/v1/sandboxes/${encodeSb(s.sandboxId)}/ports/5173`;
		const sso = await h.request("PUT", path, { json: { access: "sso" } });
		expect(sso.status).toBe(201);
		expect(body(sso)).not.toHaveProperty("token");
		expect(await tokenHash(s.sandboxId, 5173)).toBeNull();

		const opts = await h.request("PUT", path, {
			json: { access: "sso", hostRewrite: "localhost", appProtocol: "h2c" },
		});
		expect(opts.status).toBe(200);
		expect(body(opts)).toMatchObject({
			access: "sso",
			hostRewrite: "localhost",
			appProtocol: "h2c",
		});
		// PUT semantics: omitted options go back to their defaults.
		const reset = await h.request("PUT", path, { json: { access: "sso" } });
		expect(body(reset)).toMatchObject({
			hostRewrite: "preserve",
			appProtocol: "http1",
		});

		const tok = await h.request("PUT", path, { json: { access: "token" } });
		expect(tok.status).toBe(200);
		expect(body(tok).token).toMatch(/^umiakp_/);
		expect(await tokenHash(s.sandboxId, 5173)).toEqual(sha256(body(tok).token));
	});

	it("rotate-token replaces the hash in the database; a non-token port is 400; an unhosted port is 404", async () => {
		const s = await w.seed({ state: "ready" });
		const put = await h.request("PUT", `/v1/sandboxes/${s.slug}/ports/8080`);
		const first = body(put).token as string;
		const r = await h.request(
			"POST",
			`/v1/sandboxes/${s.slug}/ports/8080/rotate-token`,
		);
		expect(r.status).toBe(200);
		const { token, urlWithToken } = body(r);
		expect(token).toMatch(/^umiakp_/);
		expect(token).not.toBe(first);
		expect(urlWithToken).toBe(
			`https://${s.slug}-8080.${h.deps.settings.umiakDomain}/?_token=${token}`,
		);
		expect(await tokenHash(s.sandboxId, 8080)).toEqual(sha256(token));

		await h.request("PUT", `/v1/sandboxes/${s.slug}/ports/8081`, {
			json: { access: "sso" },
		});
		const notToken = await h.request(
			"POST",
			`/v1/sandboxes/${s.slug}/ports/8081/rotate-token`,
		);
		expect(notToken.status).toBe(400);
		expect(body(notToken).error.code).toBe("validation");

		const none = await h.request(
			"POST",
			`/v1/sandboxes/${s.slug}/ports/8082/rotate-token`,
		);
		expect(none.status).toBe(404);
		expect(body(none).error.code).toBe("not_found");
	});

	it("DELETE answers 204 and is repeatable", async () => {
		const s = await w.seed({ state: "ready" });
		await h.request("PUT", `/v1/sandboxes/${s.slug}/ports/4000`);
		const d = await h.request("DELETE", `/v1/sandboxes/${s.slug}/ports/4000`);
		expect(d.status).toBe(204);
		expect(d.text).toBe("");
		const list = await h.request("GET", `/v1/sandboxes/${s.slug}/ports`);
		expect(body(list).hosted).toEqual([]);
		const again = await h.request(
			"DELETE",
			`/v1/sandboxes/${s.slug}/ports/4000`,
		);
		expect(again.status).toBe(204);
	});

	it("ports 22, 47989 (desktop), 0, 65536 and non-numbers are 400; the 51st port is 400", async () => {
		const s = await w.seed({ state: "ready" });
		for (const port of ["22", "47989", "0", "65536", "abc", "80.5"]) {
			const r = await h.request("PUT", `/v1/sandboxes/${s.slug}/ports/${port}`);
			expect(r.status, port).toBe(400);
			expect(body(r).error.code).toBe("validation");
		}
		for (let i = 0; i < 50; i++) {
			const r = await h.request(
				"PUT",
				`/v1/sandboxes/${s.slug}/ports/${10_000 + i}`,
				{ json: { access: "public" } },
			);
			expect(r.status).toBe(201);
		}
		const over = await h.request("PUT", `/v1/sandboxes/${s.slug}/ports/11000`);
		expect(over.status).toBe(400);
		expect(body(over).error.code).toBe("validation");
		// Changing a hosted port is still allowed at the limit.
		const change = await h.request(
			"PUT",
			`/v1/sandboxes/${s.slug}/ports/10000`,
			{ json: { access: "sso" } },
		);
		expect(change.status).toBe(200);
	});

	it("unknown fields and values of the body are 400", async () => {
		const s = await w.seed({ state: "ready" });
		for (const json of [
			{ access: "open" },
			{ hostRewrite: "x" },
			{ appProtocol: "h3" },
			{ mode: "token" },
		]) {
			const r = await h.request("PUT", `/v1/sandboxes/${s.slug}/ports/3000`, {
				json,
			});
			expect(r.status, JSON.stringify(json)).toBe(400);
			expect(body(r).error.code).toBe("validation");
		}
	});

	it("public is 403 public_disabled while the operator has turned it off, read without caching", async () => {
		const s = await w.seed({ state: "ready" });
		publicEnabled = false;
		try {
			const r = await h.request("PUT", `/v1/sandboxes/${s.slug}/ports/3000`, {
				json: { access: "public" },
			});
			expect(r.status).toBe(403);
			expect(body(r).error.code).toBe("forbidden");
			expect(body(r).error.details.reason).toBe("public_disabled");
			const list = await h.request("GET", `/v1/sandboxes/${s.slug}/ports`);
			expect(body(list).hosted).toEqual([]);
			// Other modes still work.
			const tok = await h.request("PUT", `/v1/sandboxes/${s.slug}/ports/3000`);
			expect(tok.status).toBe(201);
		} finally {
			publicEnabled = true;
		}
		const r = await h.request("PUT", `/v1/sandboxes/${s.slug}/ports/3000`, {
			json: { access: "public" },
		});
		expect(r.status).toBe(200);
		expect(body(r).access).toBe("public");
	});

	it("listening: the agent's list when ready, else the last stored report", async () => {
		const s = await w.seed({ state: "ready" });
		const m = w.agent.machine(s.machineId as string);
		m.ports = [
			{
				port: 3000,
				addresses: ["0.0.0.0"],
				pid: 42,
				process: "node",
				user: "user",
			},
		];
		await db.pool.query(
			"UPDATE runtime.sandboxes SET listening_ports = $2 WHERE id = $1",
			[
				s.sandboxId,
				JSON.stringify([
					{ port: 8000, addresses: ["127.0.0.1"], process: "py", user: "u" },
				]),
			],
		);
		const before = Date.now();
		const live = await h.request("GET", `/v1/sandboxes/${s.slug}/ports`);
		expect(live.status).toBe(200);
		expect(body(live).listening).toEqual([
			{ port: 3000, addresses: ["0.0.0.0"], process: "node", user: "user" },
		]);
		expect(Date.parse(body(live).listeningObservedAt)).toBeGreaterThanOrEqual(
			before - 1000,
		);

		// An unreachable agent never fails the request; the failure is a warning.
		w.agent.setUnavailable(s.machineId as string, true);
		const logs = captureLogs();
		const lh = w.harness({ deps: { log: logs.log } });
		try {
			const stored = await lh.request("GET", `/v1/sandboxes/${s.slug}/ports`);
			expect(stored.status).toBe(200);
			const warn = logs
				.entries()
				.find((e) => e.msg === "listPorts failed; the stored report is used");
			expect(warn).toMatchObject({
				level: 40,
				sandboxId: s.sandboxId,
				errName: "ConnectError",
				errCode: 14,
			});
			// Name and code only, never the message.
			expect(warn).not.toHaveProperty("err");
			expect(body(stored).listening).toEqual([
				{ port: 8000, addresses: ["127.0.0.1"], process: "py", user: "u" },
			]);
			expect(body(stored).listeningObservedAt).toBeNull();
		} finally {
			w.agent.setUnavailable(s.machineId as string, false);
		}

		const stopped = await w.seed({ state: "stopped", machineState: "stopped" });
		const st = await h.request("GET", `/v1/sandboxes/${stopped.slug}/ports`);
		expect(body(st)).toEqual({
			hosted: [],
			listening: [],
			listeningObservedAt: null,
		});
	});

	it("a stopped sandbox can host ports; a deleting one is 409", async () => {
		const stopped = await w.seed({ state: "stopped", machineState: "stopped" });
		const r = await h.request(
			"PUT",
			`/v1/sandboxes/${stopped.slug}/ports/3000`,
		);
		expect(r.status).toBe(201);
		const deleting = await w.seed({ state: "deleting" });
		const d = await h.request(
			"PUT",
			`/v1/sandboxes/${deleting.slug}/ports/3000`,
		);
		expect(d.status).toBe(409);
		expect(body(d).error.code).toBe("invalid_state");
	});

	it("another team's sandbox is 404 on every port route and nothing changes", async () => {
		const otherTeam = randomUUID();
		const other = await w.seed({ state: "ready", teamId: otherTeam });
		await w.env.svc.hostPort(
			{ ...w.env.p, teamId: otherTeam },
			other.sandboxId,
			3000,
			{ access: "token" },
		);
		const before = await tokenHash(other.sandboxId, 3000);
		for (const [method, path] of [
			["GET", `/v1/sandboxes/${other.slug}/ports`],
			["PUT", `/v1/sandboxes/${other.slug}/ports/3000`],
			["POST", `/v1/sandboxes/${other.slug}/ports/3000/rotate-token`],
			["DELETE", `/v1/sandboxes/${other.slug}/ports/3000`],
			["GET", `/v1/sandboxes/${encodeSb(other.sandboxId)}/ports`],
		] as const) {
			const r = await h.request(method, path);
			expect(r.status, `${method} ${path}`).toBe(404);
			expect(body(r).error.code).toBe("not_found");
		}
		expect(await tokenHash(other.sandboxId, 3000)).toEqual(before);
	});

	it("scopes: GET needs sandboxes:read, writes need ports:write", async () => {
		const s = await w.seed({ state: "ready" });
		const reader = await w.key(["sandboxes:read"]);
		const rh = w.harness({ bearer: reader.secret });
		expect(
			(await rh.request("GET", `/v1/sandboxes/${s.slug}/ports`)).status,
		).toBe(200);
		for (const [method, path] of [
			["PUT", `/v1/sandboxes/${s.slug}/ports/3000`],
			["POST", `/v1/sandboxes/${s.slug}/ports/3000/rotate-token`],
			["DELETE", `/v1/sandboxes/${s.slug}/ports/3000`],
		] as const) {
			const r = await rh.request(method, path);
			expect(r.status).toBe(403);
			expect(body(r).error.details.requiredScope).toBe("ports:write");
		}
		const writer = await w.key(["ports:write"]);
		const wh = w.harness({ bearer: writer.secret });
		const g = await wh.request("GET", `/v1/sandboxes/${s.slug}/ports`);
		expect(g.status).toBe(403);
		expect(body(g).error.details.requiredScope).toBe("sandboxes:read");
		expect(
			(await wh.request("PUT", `/v1/sandboxes/${s.slug}/ports/3000`)).status,
		).toBe(201);
	});
});

function encodeSb(id: string): string {
	return encodeUuid("sandbox", id);
}
