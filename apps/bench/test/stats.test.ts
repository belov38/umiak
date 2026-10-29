import { describe, expect, it } from "vitest";
import { redact } from "../src/report.ts";
import { summarize } from "../src/stats.ts";
import { diffWorld } from "../src/world.ts";

describe("summarize", () => {
	it("computes median and nearest-rank p95", () => {
		expect(summarize([3, 1, 2])).toEqual({
			n: 3,
			median: 2,
			p95: 3,
			min: 1,
			max: 3,
		});
		expect(summarize([4, 1, 3, 2])).toMatchObject({ median: 2.5, p95: 4 });
		const xs = Array.from({ length: 20 }, (_, i) => i + 1);
		expect(summarize(xs).p95).toBe(19);
	});
	it("returns undefined fields for no samples", () => {
		expect(summarize([])).toEqual({ n: 0 });
	});
});

describe("diffWorld", () => {
	const base = {
		guests: { qm: [{ vmid: 100, status: "running" }], pct: [] },
		lvs: [{ name: "root", sizeBytes: 1, attr: "-wi-ao----" }],
		hashes: { "/etc/pve/firewall/cluster.fw": "aa" },
		sysctl: { "net.ipv4.ip_forward": "1" },
		search: { journal: true },
	};
	it("is empty for identical worlds and ignores search", () => {
		expect(
			diffWorld(base, { ...structuredClone(base), search: { journal: false } }),
		).toEqual([]);
	});
	it("reports changed hashes, new guests and new LVs", () => {
		const after = structuredClone(base);
		after.hashes["/etc/pve/firewall/cluster.fw"] = "bb";
		after.guests.qm.push({ vmid: 500, status: "running" });
		after.lvs.push({
			name: "vm-500-cloudinit",
			sizeBytes: 4,
			attr: "Vwi-a-tz--",
		});
		const d = diffWorld(base, after);
		expect(d.join("\n")).toMatch(/cluster\.fw/);
		expect(d.join("\n")).toMatch(/vmid":500/);
		expect(d.join("\n")).toMatch(/vm-500-cloudinit/);
	});
});

describe("redact", () => {
	it("replaces secrets anywhere in nested values", () => {
		const out = redact({ a: ["x SECRET y", { b: "SECRET" }], c: 1 }, [
			"SECRET",
		]);
		expect(out).toEqual({ a: ["x <redacted> y", { b: "<redacted>" }], c: 1 });
	});
});
