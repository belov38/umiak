import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Manifest } from "../src/manifest.ts";
import { FileRegistry, newBuildId } from "../src/registry.ts";

const dirs: string[] = [];
function reg(): { r: FileRegistry; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "sbx-registry-"));
	dirs.push(dir);
	return {
		r: new FileRegistry(join(dir, "templates")),
		dir: join(dir, "templates"),
	};
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let seq = 0;
function manifest(over: Partial<Manifest> = {}): Manifest {
	seq++;
	return {
		buildId: `0192f000-0000-7000-8000-${String(seq).padStart(12, "0")}`,
		templateSlug: "linux",
		version: "20261030.1",
		os: "linux",
		status: "building",
		node: "pve",
		storage: "local-lvm",
		pveVmid: null,
		vmName: "sbx-tpl-linux-20261030-1",
		gitCommit: "abc",
		recipeDigest: "d",
		base: {
			distro: "ubuntu",
			release: "26.04",
			flavor: "minimal",
			serial: "20261024",
			sha256: "0".repeat(64),
		},
		apt: { snapshot: "20261029T000000Z" },
		kernel: null,
		systemd: null,
		packages: {},
		tools: {},
		agentVersion: "1.0.0",
		defaultTunnelUrl: null,
		hw: {},
		diskLayout: {},
		bootTimeoutS: 300,
		buildMemoryMb: 4096,
		startedAt: "2026-10-30T10:00:00.000Z",
		finishedAt: null,
		durationS: null,
		...over,
	};
}

const OCT30 = new Date("2026-10-30T12:00:00Z");

describe("FileRegistry.nextVersion", () => {
	it("numbers builds per UTC day and slug, counting failed builds", () => {
		const { r } = reg();
		expect(r.nextVersion("linux", OCT30)).toBe("20261030.1");
		r.create(manifest({ version: "20261030.1", status: "failed" }));
		expect(r.nextVersion("linux", OCT30)).toBe("20261030.2");
		r.create(manifest({ version: "20261030.2", status: "ready" }));
		expect(r.nextVersion("linux", OCT30)).toBe("20261030.3");
		// Other slug and other day are independent.
		expect(r.nextVersion("linux-desktop", OCT30)).toBe("20261030.1");
		expect(r.nextVersion("linux", new Date("2026-10-31T00:00:01Z"))).toBe(
			"20261031.1",
		);
	});

	it("takes the max n, not the count, and uses the UTC date", () => {
		const { r } = reg();
		r.create(manifest({ version: "20261030.7" }));
		expect(r.nextVersion("linux", OCT30)).toBe("20261030.8");
		// 23:30 at UTC-5 is already the 31st in UTC.
		expect(r.nextVersion("linux", new Date("2026-10-30T23:30:00-05:00"))).toBe(
			"20261031.1",
		);
	});
});

describe("FileRegistry", () => {
	it("creates, reads, updates and lists manifests", () => {
		const { r } = reg();
		const a = manifest({ startedAt: "2026-10-30T10:00:00.000Z" });
		const b = manifest({
			version: "20261030.2",
			startedAt: "2026-10-30T11:00:00.000Z",
		});
		const c = manifest({ templateSlug: "other", version: "20261030.1" });
		r.create(b);
		r.create(a);
		r.create(c);
		expect(r.get(a.buildId)).toEqual(a);
		expect(r.get("0192f000-0000-7000-8000-ffffffffffff")).toBeUndefined();

		const u = r.update(a.buildId, { status: "ready", pveVmid: 598 });
		expect(u).toEqual({ ...a, status: "ready", pveVmid: 598 });
		expect(r.get(a.buildId)).toEqual(u);

		expect(r.list("linux").map((m) => m.buildId)).toEqual([
			a.buildId,
			b.buildId,
		]);
		expect(r.list()).toHaveLength(3);
	});

	it("refuses a second build with the same id or slug and version", () => {
		const { r } = reg();
		const a = manifest();
		r.create(a);
		expect(() => r.create(a)).toThrow(/exists/);
		expect(() => r.create(manifest({ version: a.version }))).toThrow(
			/20261030\.1/,
		);
	});

	it("fails to update an unknown build", () => {
		const { r } = reg();
		const id = "0192f000-0000-7000-8000-ffffffffffff";
		expect(() => r.update(id, { status: "failed" })).toThrow(/not found/);
	});

	it("writes atomically and leaves only <buildId>.json files", () => {
		const { r, dir } = reg();
		const a = manifest();
		r.create(a);
		r.update(a.buildId, { status: "failed" });
		expect(readdirSync(dir)).toEqual([`${a.buildId}.json`]);
	});

	it("ignores stray files in the directory", () => {
		const { r, dir } = reg();
		r.create(manifest());
		writeFileSync(join(dir, "notes.txt"), "x");
		writeFileSync(join(dir, ".tmp-123.json"), "{");
		expect(r.list()).toHaveLength(1);
	});

	it("rejects ids that are not plain file names", () => {
		const { r } = reg();
		expect(() => r.get("../x")).toThrow(/build id/);
		expect(() => r.create(manifest({ buildId: "a/b" }))).toThrow(/build id/);
	});
});

describe("newBuildId", () => {
	it("is a UUIDv7 and sorts by time", () => {
		const a = newBuildId();
		const b = newBuildId();
		expect(a).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(a.slice(0, 13) <= b.slice(0, 13)).toBe(true);
		expect(a).not.toBe(b);
	});
});
