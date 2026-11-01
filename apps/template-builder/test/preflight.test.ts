import { join, resolve } from "node:path";
import { type NodeOps, PveApiError, type PveClient } from "@umiak/pve";
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
		const a = answers[key];
		if (a instanceof Error) throw a;
		return a;
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
			pool: "umiak",
			maxmem: 2 * 2 ** 30,
			template: 0,
		},
		{
			vmid: 598,
			status: "stopped",
			pool: "umiak",
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

const cfg = { node: "pve", pool: "umiak" };

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
					throw new Error("umiak-node media.list: forbidden");
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
					pool: "umiak",
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

	it("warns instead of failing when the token may not read the node status", async () => {
		const noAudit = {
			...GOOD,
			"/nodes/pve/status": new PveApiError(
				403,
				"GET /nodes/pve/status: Permission check failed (/nodes/pve, Sys.Audit)",
			),
		};
		const checks = await preflight({
			api: stub(noAudit),
			node: nodeOk,
			cfg,
			keyFile,
			hasCommand: () => true,
		});
		const mem = checks.find((c) => c.name.includes("RAM"));
		expect(mem).toMatchObject({ ok: true, warn: true });
		expect(mem?.detail).toMatch(/Sys\.Audit/);
		expect(mem?.detail).toMatch(/pool running 2048 MB/);
		expect(checks.filter((c) => !c.ok)).toEqual([]);

		// The fallback still fails over the cap.
		const full = {
			...noAudit,
			"/nodes/pve/qemu/500/status/current": {
				status: "running",
				maxmem: 6 * 2 ** 30,
			},
		};
		const again = await preflight({
			api: stub(full),
			node: nodeOk,
			cfg,
			keyFile,
			hasCommand: () => true,
		});
		expect(again.find((c) => c.name.includes("RAM"))?.ok).toBe(false);
	});
	describe("windows", () => {
		const WIN = {
			...GOOD,
			"/access/permissions?path=/pool/umiak": {
				"/pool/umiak": { "VM.Console": 1, "VM.Audit": 1 },
			},
			"/nodes/pve/capabilities/qemu/machines": [
				{ id: "pc-q35-11.0+pve2", type: "q35" },
			],
		};
		const ISO = "Windows11_Client_x64_en-gb_26300_9457.iso";
		const nodeWin = (sha: string | Error): NodeOps => ({
			call: async <T>(op: string, args?: object) => {
				if (op === "media.list") return { iso: [], import: [] } as T;
				if (op === "media.sha256") {
					if (sha instanceof Error) throw sha;
					return { ...(args as object), size: 7, sha256: sha } as T;
				}
				throw new Error(op);
			},
			close() {},
		});

		it("checks VM.Console, machine types and the user ISO", async () => {
			const checks = await preflight({
				api: stub(WIN),
				node: nodeWin("ab".repeat(32)),
				cfg,
				keyFile,
				hasCommand: () => true,
				windows: { isoFile: ISO, isoSha256: "ab".repeat(32) },
			});
			expect(checks.filter((c) => !c.ok)).toEqual([]);
			expect(checks.map((c) => c.name)).toEqual(
				expect.arrayContaining([
					"token: VM.Console on /pool/umiak",
					"machine types (pc-q35-*+pve*)",
					`user ISO local:iso/${ISO}`,
				]),
			);
			expect(checks.find((c) => c.name.includes("machine"))?.detail).toBe(
				"pc-q35-11.0+pve2",
			);
		});

		it("fails without VM.Console, on a missing ISO and on a sha mismatch; warns on an unpinned sha", async () => {
			const noConsole = {
				...WIN,
				"/access/permissions?path=/pool/umiak": {
					"/pool/umiak": { "VM.Audit": 1 },
				},
			};
			const a = await preflight({
				api: stub(noConsole),
				node: nodeWin(new Error("not_found: no such ISO")),
				cfg,
				keyFile,
				hasCommand: () => true,
				windows: { isoFile: ISO, isoSha256: "ab".repeat(32) },
			});
			expect(a.find((c) => c.name.includes("VM.Console"))?.ok).toBe(false);
			const iso = a.find((c) => c.name.includes("user ISO"));
			expect(iso?.ok).toBe(false);
			expect(iso?.detail).toMatch(/iso upload/);

			const b = await preflight({
				api: stub(WIN),
				node: nodeWin("cd".repeat(32)),
				cfg,
				keyFile,
				hasCommand: () => true,
				windows: { isoFile: ISO, isoSha256: "ab".repeat(32) },
			});
			expect(b.find((c) => c.name.includes("user ISO"))?.ok).toBe(false);

			const c = await preflight({
				api: stub(WIN),
				node: nodeWin("cd".repeat(32)),
				cfg,
				keyFile,
				hasCommand: () => true,
				windows: { isoFile: ISO, isoSha256: "" },
			});
			const unpinned = c.find((x) => x.name.includes("user ISO"));
			expect(unpinned).toMatchObject({ ok: true, warn: true });
			expect(unpinned?.detail).toContain("cd".repeat(32));
		});
	});
});
