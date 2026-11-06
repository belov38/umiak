import { describe, expect, it } from "vitest";
import {
	installVendorTools,
	VENDOR_TOOLS,
	vendorInstallScript,
} from "../src/vendor-tools.ts";

describe("node-only vendor phase", () => {
	it("records a verified installation separately from signed inputs and restores isolation", async () => {
		const events: string[] = [];
		const records = await installVendorTools({
			network: async (online) => {
				events.push(`network:${online}`);
			},
			install: async (tool) => {
				events.push(tool.id);
				return { version: tool.version, sha256: tool.sha256 };
			},
			log: (line) => {
				events.push(line);
			},
			now: () => 1000,
		});
		expect(events.filter((x) => x.startsWith("network:"))).toEqual([
			"network:true",
			"network:true",
			"network:true",
			"network:false",
		]);
		expect(records[0]).toMatchObject({
			status: "installed",
			vendorInstalled: true,
			partOfSignedLayer: false,
			version: VENDOR_TOOLS[0].version,
			durationS: 0,
		});
	});
	it("tolerates download and integrity failures with a clear warning, without readiness failure", async () => {
		const networks: boolean[] = [];
		const records = await installVendorTools({
			network: async (on) => {
				networks.push(on);
			},
			install: async () => {
				throw new Error("vendor unavailable");
			},
			log: () => {},
		});
		expect(records[0]).toMatchObject({
			status: "failed",
			warning: "Claude Code not installed: vendor unavailable",
		});
		expect(networks).toEqual([true, true, true, false]);
	});
	it("never seals when network isolation cannot be restored", async () => {
		await expect(
			installVendorTools({
				network: async (on) => {
					if (!on) throw new Error("PVE refused");
				},
				install: async (t) => ({ version: t.version, sha256: t.sha256 }),
				log: () => {},
			}),
		).rejects.toThrow("PVE refused");
	});
	it("pins the vendor binary checksum and exact version while bounding installer lifetime", () => {
		const script = vendorInstallScript(VENDOR_TOOLS[0]);
		expect(script).toContain("https://claude.ai/install.sh");
		expect(script).toContain(VENDOR_TOOLS[0].sha256);
		expect(script).toContain("timeout --kill-after=10s 600s");
		expect(script).toContain("--retry 3");
		expect(script).toContain("DISABLE_AUTOUPDATER");
	});
});

it("Bun uses the official pinned release and published checksum list only on the node", () => {
	const tool = VENDOR_TOOLS.find((t) => t.id === "bun");
	if (!tool) throw Error("Bun vendor entry missing");
	const script = vendorInstallScript(tool);
	expect(script).toContain("SHASUMS256.txt");
	expect(script).toContain(tool.sha256);
	expect(script).toContain("sha256sum --check");
});
