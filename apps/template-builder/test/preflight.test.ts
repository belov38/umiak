import { join, resolve } from "node:path";
import type { NodeOps, PveClient } from "@sbx/pve";
import { describe, expect, it } from "vitest";
import { preflight } from "../src/preflight.ts";

const keyFile = join(
	resolve(import.meta.dirname, "../../.."),
	"infra/templates/keys/ubuntu-cloud-images.asc",
);

function stub(answers: Record<string, unknown>): PveClient {
	const get = async (path: string, params?: Record<string, unknown>) => {
		const key = params?.path ? `${path}?path=${params.path}` : path;
		if (!(key in answers)) throw new Error(`unexpected GET ${key}`);
		return answers[key];
	};
	const no = async () => {
		throw new Error("read-only");
	};
	return {
		get,
		post: no,
		put: no,
		delete: no,
		waitTask: no,
	} as unknown as PveClient;
}

const GOOD = {
	"/access/permissions?path=/storage/local": {
		"/storage/local": { "Datastore.AllocateTemplate": 1, "Datastore.Audit": 1 },
	},
	"/nodes/pve/storage/local/status": { content: "iso,vztmpl,import,backup" },
	"/nodes/pve/status": {
		memory: {
			total: 64 * 2 ** 30,
			free: 20 * 2 ** 30,
			available: 30 * 2 ** 30,
		},
	},
	"/cluster/resources": [
		{
			vmid: 500,
			status: "running",
			pool: "sandbox",
			maxmem: 2 * 2 ** 30,
			template: 0,
		},
		{
			vmid: 598,
			status: "stopped",
			pool: "sandbox",
			maxmem: 4 * 2 ** 30,
			template: 1,
		},
	],
	"/nodes/pve/qemu/500/status/current": {
		status: "running",
		maxmem: 2 * 2 ** 30,
	},
};

const nodeOk: NodeOps = {
	call: async <T>(op: string) => {
		if (op !== "media.list") throw new Error(op);
		return { iso: [], import: [] } as T;
	},
	close() {},
};

const cfg = { node: "pve", pool: "sandbox" };

describe("preflight", () => {
	it("passes with the right permissions, content types, memory and tools", async () => {
		const checks = await preflight({
			api: stub(GOOD),
			node: nodeOk,
			cfg,
			keyFile,
			hasCommand: () => true,
		});
		expect(checks.filter((c) => !c.ok)).toEqual([]);
		expect(checks.map((c) => c.name)).toHaveLength(6);
	});

	it("fails each check for its own reason", async () => {
		const bad = {
			...GOOD,
			"/access/permissions?path=/storage/local": {
				"/storage/local": { "Datastore.Audit": 1 },
			},
			"/nodes/pve/storage/local/status": { content: "iso,vztmpl" },
			"/nodes/pve/status": { memory: { total: 8 * 2 ** 30, free: 2 ** 30 } },
		};
		const checks = await preflight({
			api: stub(bad),
			node: {
				call: async () => {
					throw new Error("sbx-node media.list: forbidden");
				},
				close() {},
			},
			cfg,
			keyFile: "/nonexistent.asc",
			hasCommand: () => false,
		});
		expect(checks.filter((c) => c.ok)).toEqual([]);
		expect(checks.find((c) => c.name.includes("media.list"))?.detail).toMatch(
			/forbidden/,
		);
	});

	it("fails the memory check when the pool cap would be exceeded", async () => {
		const full = {
			...GOOD,
			"/cluster/resources": [
				{
					vmid: 500,
					status: "running",
					pool: "sandbox",
					maxmem: 6 * 2 ** 30,
					template: 0,
				},
			],
			"/nodes/pve/qemu/500/status/current": {
				status: "running",
				maxmem: 6 * 2 ** 30,
			},
		};
		const checks = await preflight({
			api: stub(full),
			node: nodeOk,
			cfg,
			keyFile,
			hasCommand: () => true,
		});
		const mem = checks.find((c) => c.name.includes("RAM"));
		expect(mem?.ok).toBe(false);
		expect(mem?.detail).toMatch(/6144/);
	});
});
