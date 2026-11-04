import { StaticConfigReader } from "@umiak/config";
import { createTopology, SIZES } from "@umiak/core/testing";
import {
	createTestDatabase,
	skipPg,
	type TestDatabase,
} from "@umiak/db/testing";
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

	it("GET /v1/templates: configured templates in config order with their active build version; disabled for operators only", async () => {
		const r = await h.request("GET", "/v1/templates");
		expect(r.status).toBe(200);
		const data = body(r).data as Body[];
		expect(data.map((t) => t.slug)).toEqual([w.env.template, old, unbuilt]);
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
			buildCreatedAt: expect.any(String),
			pveVmid: expect.any(Number),
			availability: expect.any(Array),
		});
		expect(data.find((t) => t.slug === old)).toMatchObject({
			capabilities: ["exec"],
			version: null,
		});

		const op = await operator.h.request("GET", "/v1/templates", {
			headers: operator.headers,
		});
		const all = body(op).data as Body[];
		expect(all.map((t) => t.slug)).toEqual([w.env.template, off, old, unbuilt]);
		expect(all.find((t) => t.slug === unbuilt).version).toBeNull();
		expect(all.find((t) => t.slug === off)).toMatchObject({
			enabled: false,
			os: "windows",
			version: "2026.10.30-1",
		});
	});

	it("lists each node's version and availability without exposing its SSH endpoint", async () => {
		const a = await createTopology(db.pool, {
			build: { templateSlug: unbuilt, version: "node-a" },
		});
		const b = await createTopology(db.pool, {
			providerId: a.providerId,
			build: { templateSlug: unbuilt, version: "node-b" },
		});
		const c = await createTopology(db.pool, {
			providerId: a.providerId,
			build: { templateSlug: "different" },
		});
		await db.pool.query(
			"UPDATE runtime.nodes SET state='cordoned' WHERE id=$1",
			[b.nodeId],
		);
		try {
			const r = await h.request("GET", "/v1/templates");
			const item = body(r).data.find((t: Body) => t.slug === unbuilt);
			expect(item.availability).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						nodeId: a.nodeId,
						version: "node-a",
						available: true,
					}),
					expect.objectContaining({
						nodeId: b.nodeId,
						version: "node-b",
						available: false,
					}),
					expect.objectContaining({
						nodeId: c.nodeId,
						version: null,
						available: false,
					}),
				]),
			);
			expect(JSON.stringify(item)).not.toContain("node_agent_ref");
			expect(JSON.stringify(item)).not.toContain("https://pve:");
			await db.pool.query(
				"UPDATE runtime.nodes SET retired_at=now() WHERE id=$1",
				[b.nodeId],
			);
			const next = body(await h.request("GET", "/v1/templates")).data.find(
				(t: Body) => t.slug === unbuilt,
			);
			expect(next.availability.map((x: Body) => x.nodeId)).not.toContain(
				b.nodeId,
			);
		} finally {
			await db.pool.query(
				"UPDATE runtime.template_builds SET status='retired' WHERE node_id=ANY($1::uuid[])",
				[[a.nodeId, b.nodeId, c.nodeId]],
			);
			await db.pool.query(
				"UPDATE runtime.nodes SET retired_at=now() WHERE id=ANY($1::uuid[])",
				[[a.nodeId, b.nodeId, c.nodeId]],
			);
		}
	});
	it("GET /v1/sizes: every configured size, smallest first", async () => {
		const r = await h.request("GET", "/v1/sizes");
		expect(body(r).data).toEqual([
			{ slug: "2gb", vcpu: 2, memoryMb: 2048 },
			{ slug: "4gb", vcpu: 2, memoryMb: 4096 },
			{ slug: "8gb", vcpu: 4, memoryMb: 8192 },
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
		expect(b.defaults).toEqual({
			ttlSeconds: null,
			idleTimeoutSeconds: 900,
			stoppedRetentionDays: null,
		});
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
