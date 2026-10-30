// Route lookup of the gateway (S7 §12.1, S4 §6.1, S8 C7): the S4 shape plus
// `kind`, public ids, policy decided here (blocked, public_disabled, the
// sso epoch), 404 route_not_found with a top-level code.
import { encodeUuid } from "@sbx/auth";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceTokens } from "../src/index.ts";
import { mutableDefaults } from "./helpers/config.ts";
import type { Harness, HarnessResponse } from "./helpers/harness.ts";
import { type ApiWorld, apiWorld } from "./helpers/world.ts";

// biome-ignore lint/suspicious/noExplicitAny: internal answers are not in the document
type Body = any;
const body = (r: HarnessResponse): Body => r.body as Body;

const GW = "gw-token-routes-0123456789abcdef";

describe.skipIf(skipPg())("GET /internal/v1/gateway/routes/{label}", () => {
	let db: TestDatabase;
	let w: ApiWorld;
	let h: Harness;
	let defaults: ReturnType<typeof mutableDefaults>;

	beforeAll(async () => {
		db = await createTestDatabase({ max: 20 });
		w = await apiWorld(db.pool);
		defaults = mutableDefaults(w.env.config);
		h = w.harness({
			listener: "internal",
			bearer: GW,
			deps: {
				config: defaults.config,
				serviceTokens: new ServiceTokens({ gateway: [GW] }),
			},
		});
	});
	afterAll(async () => {
		await w?.close();
		await db?.drop();
	});

	const lookup = (label: string) =>
		h.request("GET", `/internal/v1/gateway/routes/${label}`);

	async function hosted(
		mode: "token" | "sso" | "public",
		state = "ready",
		port = 3000,
	) {
		const s = await w.seed({ state: "ready" });
		await w.env.svc.hostPort(w.env.p, s.sandboxId, port, mode);
		if (state !== "ready") await w.markState(s.sandboxId, state);
		return s;
	}

	async function epoch(sandboxId: string, port = 3000): Promise<number> {
		const r = await db.pool.query<{ auth_epoch: number }>(
			"SELECT auth_epoch FROM runtime.hosted_ports WHERE sandbox_id = $1 AND port = $2 AND deleted_at IS NULL",
			[sandboxId, port],
		);
		return r.rows[0]?.auth_epoch as number;
	}

	it("answers the S4 §6.1 shape plus kind, with public ids", async () => {
		const s = await hosted("token");
		const r = await lookup(`${s.slug}-3000`);
		expect(r.status, r.text).toBe(200);
		const hash = await db.pool.query<{ token_hash: Buffer }>(
			"SELECT token_hash FROM runtime.hosted_ports WHERE sandbox_id = $1 AND port = 3000",
			[s.sandboxId],
		);
		expect(body(r)).toEqual({
			label: `${s.slug}-3000`,
			sandboxId: encodeUuid("sandbox", s.sandboxId),
			slug: s.slug,
			port: 3000,
			machineId: s.machineId,
			sandboxState: "ready",
			access: "token",
			tokenHash: hash.rows[0]?.token_hash.toString("hex"),
			authEpoch: await epoch(s.sandboxId),
			blocked: false,
			blockReason: null,
			hostRewrite: "preserve",
			appProtocol: "http1",
			teamId: encodeUuid("team", w.teamId),
			kind: "port",
		});
	});

	it("passes S6 states as they are, machineId null without a machine", async () => {
		for (const state of [
			"creating",
			"starting",
			"stopping",
			"stopped",
			"error",
			"deleting",
		]) {
			const s = await hosted("public", state);
			const r = await lookup(`${s.slug}-3000`);
			expect(r.status, state).toBe(200);
			expect(body(r).sandboxState).toBe(state);
		}
		const s = await w.seed({ state: "stopped", machineState: null });
		await w.env.svc.hostPort(w.env.p, s.sandboxId, 8080, "public");
		const r = await lookup(`${s.slug}-8080`);
		expect(body(r)).toMatchObject({ machineId: null, tokenHash: null });
	});

	it("public while public ports are off: blocked public_disabled, read on every request", async () => {
		const s = await hosted("public");
		defaults.set({ publicPortsEnabled: false });
		try {
			const r = await lookup(`${s.slug}-3000`);
			expect(body(r)).toMatchObject({
				access: "public",
				blocked: true,
				blockReason: "public_disabled",
			});
			// token and sso ports are not affected by the flag.
			const t = await hosted("token");
			expect(body(await lookup(`${t.slug}-3000`))).toMatchObject({
				blocked: false,
				blockReason: null,
			});
		} finally {
			defaults.set({ publicPortsEnabled: true });
		}
		expect(body(await lookup(`${s.slug}-3000`))).toMatchObject({
			blocked: false,
			blockReason: null,
		});
	});

	it("an operator block wins over public_disabled", async () => {
		const s = await hosted("public");
		await db.pool.query(
			"UPDATE runtime.hosted_ports SET blocked = true, block_reason = 'abuse' WHERE sandbox_id = $1",
			[s.sandboxId],
		);
		defaults.set({ publicPortsEnabled: false });
		try {
			expect(body(await lookup(`${s.slug}-3000`))).toMatchObject({
				blocked: true,
				blockReason: "abuse",
			});
		} finally {
			defaults.set({ publicPortsEnabled: true });
		}
	});

	it("sso: authEpoch = auth_epoch + ssoPolicyEpoch; token ports keep auth_epoch", async () => {
		const s = await hosted("sso");
		const t = await hosted("token");
		defaults.set({ ssoPolicyEpoch: 5 });
		try {
			const r = await lookup(`${s.slug}-3000`);
			expect(body(r)).toMatchObject({
				access: "sso",
				tokenHash: null,
				authEpoch: (await epoch(s.sandboxId)) + 5,
			});
			expect(body(await lookup(`${t.slug}-3000`)).authEpoch).toBe(
				await epoch(t.sandboxId),
			);
		} finally {
			defaults.set({ ssoPolicyEpoch: 0 });
		}
	});

	it("404 route_not_found with a top-level code: deleted sandbox, unhosted port, unknown slug, bad grammar, reserved, desktop", async () => {
		const d = await hosted("public");
		await w.markState(d.sandboxId, "deleted");
		const s = await hosted("public");
		for (const label of [
			`${d.slug}-3000`,
			`${s.slug}-3001`,
			"unknown-box-3000",
			`${s.slug}-03000`,
			`${s.slug}-70000`,
			`${s.slug.toUpperCase()}-3000`,
			"api-3000",
			"sbx-3000",
			`${s.slug}-desktop`,
			"nolabel",
		]) {
			const r = await lookup(label);
			expect(r.status, label).toBe(404);
			expect(body(r), label).toMatchObject({
				code: "route_not_found",
				error: { code: "route_not_found", retryable: false },
			});
		}
	});

	it("needs the gateway's service token", async () => {
		const s = await hosted("public");
		const r = await h.request(
			"GET",
			`/internal/v1/gateway/routes/${s.slug}-3000`,
			{
				headers: { authorization: "Bearer wrong" },
			},
		);
		expect(r.status).toBe(401);
		const other = w.harness({
			listener: "internal",
			bearer: "worker-token-0123456789",
			deps: {
				serviceTokens: new ServiceTokens({
					worker: ["worker-token-0123456789"],
				}),
			},
		});
		const f = await other.request(
			"GET",
			`/internal/v1/gateway/routes/${s.slug}-3000`,
		);
		expect(f.status).toBe(403);
		expect(body(f).code).toBe("forbidden");
	});
});
