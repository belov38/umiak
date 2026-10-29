import { StaticConfigReader } from "@sbx/config";
import { createTopology, SIZES } from "@sbx/core/testing";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiDeps } from "../src/index.ts";
import type { Harness, HarnessResponse } from "./helpers/harness.ts";
import { type ApiWorld, apiWorld } from "./helpers/world.ts";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the conformance harness
type Body = any;
const body = (r: HarnessResponse): Body => r.body as Body;

describe.skipIf(skipPg())("templates, sizes and limits", () => {
	let db: TestDatabase;
	let w: ApiWorld;
	let over: Partial<ApiDeps>;
	let h: Harness;
	let operator: { h: Harness; headers: Record<string, string> };
	const off = `off${process.pid}`;
	const old = `old${process.pid}`;
	const unbuilt = `unbuilt${process.pid}`;

	beforeAll(async () => {
		db = await createTestDatabase({ max: 20 });
		w = await apiWorld(db.pool);
		await createTopology(db.pool, {
			build: { templateSlug: off, os: "windows", version: "2026.10.30-1" },
		});
		await createTopology(db.pool, {
			build: { templateSlug: old, status: "deprecated", version: "1" },
		});
		const config = StaticConfigReader.fromObject({
			templates: [
				{
					slug: w.env.template,
					name: "Linux",
					os: "linux",
					defaultSize: "2gb",
					allowedSizes: ["2gb", "4gb"],
				},
				{
					slug: off,
					os: "windows",
					enabled: false,
					defaultSize: "4gb",
					allowedSizes: ["4gb", "8gb"],
				},
				{
					slug: old,
					os: "linux",
					defaultSize: "2gb",
					allowedSizes: ["2gb"],
					capabilities: ["exec"],
				},
				{
					slug: unbuilt,
					os: "linux",
					defaultSize: "2gb",
					allowedSizes: ["2gb"],
				},
			],
			sizes: SIZES,
			quotas: {
				teams: {
					[w.teamId]: {
						maxActiveSandboxes: 2,
						maxRamMb: 4096,
						maxSavedSnapshots: 3,
					},
				},
			},
			defaults: { defaultTemplate: w.env.template },
		});
		over = { config };
		h = w.harness({ deps: over });
		operator = w.session({ isOperator: true, deps: over });
	});
	afterAll(async () => {
		await w?.close();
		await db?.drop();
	});

	it("GET /v1/templates: configured templates with a build or the default; disabled for operators only", async () => {
		const r = await h.request("GET", "/v1/templates");
		expect(r.status).toBe(200);
		const data = body(r).data as Body[];
		expect(data.map((t) => t.slug)).toEqual([old, w.env.template].sort());
		expect(data.find((t) => t.slug === w.env.template)).toEqual({
			slug: w.env.template,
			name: "Linux",
			os: "linux",
			enabled: true,
			defaultSize: "2gb",
			allowedSizes: ["2gb", "4gb"],
			loginUser: "user",
			capabilities: ["exec", "files", "ssh"],
			version: expect.stringMatching(/^v\d+$/),
		});
		expect(data.find((t) => t.slug === old)).toMatchObject({
			capabilities: ["exec"],
			version: null,
		});

		const op = await operator.h.request("GET", "/v1/templates", {
			headers: operator.headers,
		});
		const all = body(op).data as Body[];
		expect(all.map((t) => t.slug)).toEqual([off, old, w.env.template].sort());
		expect(all.find((t) => t.slug === off)).toMatchObject({
			enabled: false,
			os: "windows",
			version: "2026.10.30-1",
		});
	});

	it("GET /v1/sizes: sizes of the visible templates, smallest first", async () => {
		const r = await h.request("GET", "/v1/sizes");
		expect(body(r).data).toEqual([
			{ slug: "2gb", vcpu: 2, memoryMb: 2048 },
			{ slug: "4gb", vcpu: 2, memoryMb: 4096 },
		]);
		const op = await operator.h.request("GET", "/v1/sizes", {
			headers: operator.headers,
		});
		expect(body(op).data.map((s: Body) => s.slug)).toEqual([
			"2gb",
			"4gb",
			"8gb",
		]);
	});

	it("GET /v1/limits: quota, usage, remaining, allowed sizes with reasons, no warm pool", async () => {
		await w.seed({ state: "ready", memoryMb: 2048 });
		await w.seed({ state: "stopped", machineState: "stopped" });
		const r = await h.request("GET", "/v1/limits");
		expect(r.status).toBe(200);
		const b = body(r);
		expect(b.quota).toEqual({
			maxActiveSandboxes: 2,
			maxRamMb: 4096,
			maxSavedSnapshots: 3,
		});
		expect(b.usage).toEqual({
			activeSandboxes: 1,
			ramMb: 2048,
			savedSnapshots: 0,
		});
		expect(b.remaining).toEqual({
			activeSandboxes: 1,
			ramMb: 2048,
			savedSnapshots: 3,
		});
		expect(b.canCreate).toBe(true);
		const tpl = (b.templates as Body[]).find((t) => t.slug === w.env.template);
		expect(tpl).toEqual({
			slug: w.env.template,
			enabled: true,
			defaultSize: "2gb",
			sizes: [
				{ slug: "2gb", vcpu: 2, memoryMb: 2048, allowed: true, reason: null },
				{
					slug: "4gb",
					vcpu: 2,
					memoryMb: 4096,
					allowed: false,
					reason: "quota_ram",
				},
			],
		});
		expect((b.templates as Body[]).map((t) => t.slug)).not.toContain(off);
		expect(b.rateLimits).toEqual({
			requestsPerSecond: 20,
			burst: 100_000,
			startsPerMinute: 100_000,
		});
		expect(r.text).not.toContain("warmAvailable");

		await w.seed({ state: "ready", memoryMb: 2048 });
		const full = body(await h.request("GET", "/v1/limits"));
		expect(full.canCreate).toBe(false);
		expect(full.remaining.activeSandboxes).toBe(0);
		const reasons = (full.templates as Body[]).flatMap((t) =>
			(t.sizes as Body[]).map((s) => s.reason),
		);
		expect(new Set(reasons)).toEqual(new Set(["quota_active_sandboxes"]));

		const op = body(
			await operator.h.request("GET", "/v1/limits", {
				headers: operator.headers,
			}),
		);
		const offTpl = (op.templates as Body[]).find((t) => t.slug === off);
		expect(offTpl.sizes.map((s: Body) => s.reason)).toEqual([
			"template_disabled",
			"template_disabled",
		]);
	});

	it("any valid key, without scopes, reads templates, sizes and limits", async () => {
		const k = await w.key([]);
		const kh = w.harness({ bearer: k.secret, deps: over });
		for (const path of ["/v1/templates", "/v1/sizes", "/v1/limits"]) {
			expect((await kh.request("GET", path)).status, path).toBe(200);
		}
		const denied = await kh.request("GET", "/v1/sandboxes");
		expect(denied.status).toBe(403);
	});
});
