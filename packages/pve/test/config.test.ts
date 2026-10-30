import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, readSecretFile } from "../src/config.ts";

describe("loadConfig", () => {
	it("uses the PoC defaults from the spec", () => {
		const c = loadConfig({}, "/home/u");
		expect(c.pveUrl).toBe("https://pve:8006");
		expect(c.tokenId).toBe("sbx@pve!poc");
		expect(c.tokenSecretFile).toBe("/home/u/.config/sbx/pve-token");
		expect(c.caFile).toBe("/home/u/.config/sbx/pve-root-ca.pem");
		expect(c.tlsName).toBe("pve");
		expect(c.nodeSshHost).toBe("pve");
		expect(c.nodeSshKeyFile).toBe("/home/u/.config/sbx/sbx-node_ed25519");
		expect(c.nodeSshKnownHosts).toBe("/home/u/.config/sbx/known_hosts");
		expect(c.vmidRange).toEqual({ min: 500, max: 598 });
		expect(c.clusterId).toBe(1);
		expect(c.stateDb).toBe("/home/u/.local/state/sbx/poc.db");
		expect(c.templateVmid).toBe(599);
		expect(c.node).toBe("pve");
		expect(c.storage).toBe("local-lvm");
		expect(c.vnet).toBe("sbx0");
		expect(c.pool).toBe("sandbox");
	});

	it("reads overrides from env and expands ~", () => {
		const c = loadConfig(
			{
				SBX_VMID_RANGE: "510-520",
				SBX_CLUSTER_ID: "7",
				SBX_STATE_DB: "~/x.db",
			},
			"/h",
		);
		expect(c.vmidRange).toEqual({ min: 510, max: 520 });
		expect(c.clusterId).toBe(7);
		expect(c.stateDb).toBe("/h/x.db");
	});

	it("rejects a range that contains the template or is malformed", () => {
		expect(() => loadConfig({ SBX_VMID_RANGE: "500-700" }, "/h")).toThrow(
			/template/,
		);
		expect(() => loadConfig({ SBX_VMID_RANGE: "600-500" }, "/h")).toThrow();
		expect(() => loadConfig({ SBX_VMID_RANGE: "abc" }, "/h")).toThrow();
		expect(() => loadConfig({ SBX_CLUSTER_ID: "256" }, "/h")).toThrow();
	});
});

describe("readSecretFile", () => {
	it("returns the trimmed secret of a 600 file and refuses group/other access", () => {
		const dir = mkdtempSync(join(tmpdir(), "sbx-cfg-"));
		const p = join(dir, "token");
		writeFileSync(p, "s3cret\n");
		chmodSync(p, 0o600);
		expect(readSecretFile(p)).toBe("s3cret");
		chmodSync(p, 0o640);
		expect(() => readSecretFile(p)).toThrow(/600/);
	});
});
