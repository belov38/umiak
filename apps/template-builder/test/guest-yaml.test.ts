import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, expect, it } from "vitest";
import { parse } from "yaml";
import { renderOfflineSeed } from "../src/offline-seed.ts";
import { qemuBootSeed } from "../src/qemu-build.ts";
import { loadRecipe, loadVersions } from "../src/recipe.ts";
import { renderSeed } from "../src/seed.ts";

const root = resolve(import.meta.dirname, "../../../");
const scratch = mkdtempSync(join(tmpdir(), "guest-yaml-audit-"));
const agent = join(scratch, "agent");
writeFileSync(agent, "agent fixture");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const yaml11 = (text: string) => parse(text, { version: "1.1" });
function assertSameScalars(seed: Map<string, string | Buffer>) {
	for (const name of ["user-data", "meta-data", "network-config"]) {
		const text = String(seed.get(name));
		expect(
			yaml11(text),
			`${name}: YAML 1.1 must preserve every scalar and key`,
		).toEqual(parse(text, { version: "1.2" }));
	}
	const user = yaml11(String(seed.get("user-data")));
	expect(user.disable_root).toBe(true);
	expect(user.ssh_pwauth).toBe(false);
	expect(typeof yaml11(String(seed.get("meta-data")))["instance-id"]).toBe(
		"string",
	);
	expect(yaml11(String(seed.get("network-config"))).version).toBe(2);
}
function productionSeed(
	slug: string,
	capture: boolean,
	buildId = "0199c5a0-7b1e-7a3c-8d3e-5f2a9c1b4e60",
) {
	const recipe = loadRecipe(join(root, "infra/templates"), slug, "linux");
	return renderSeed({
		recipe,
		versions: loadVersions(recipe),
		buildId,
		version: "20261106.1",
		agentPackage: agent,
		agentVersion: "0.4.0",
		updateKeys: readFileSync(
			join(root, "services/guest-agent/packaging/trust/update-keys.pub"),
		),
		manifestBase: { slug },
		...(capture
			? {
					layerCapture: true,
					genericAgent: {
						binary: agent,
						unitsDirectory: join(
							root,
							"services/guest-agent/packaging/systemd",
						),
					},
				}
			: {}),
	});
}
for (const slug of ["linux", "linux-desktop"])
	for (const mode of ["legacy", "capture", "qemu-capture"])
		it(`${slug} ${mode} seed preserves types under cloud-init YAML 1.1`, () => {
			const seed = productionSeed(slug, mode !== "legacy");
			if (mode === "qemu-capture") qemuBootSeed(seed, true);
			assertSameScalars(seed);
			const user = yaml11(String(seed.get("user-data")));
			expect(user.packages).toContain("qemu-guest-agent");
			expect(user.apt.preserve_sources_list).toBe(true);
			expect(typeof user.apt.conf).toBe("string");
			const snapshot = user.bootcmd.find((cmd: unknown[]) => cmd[0] === "sh");
			expect(snapshot[4]).toBe("20261030T000000Z");
		});
for (const qemu of [false, true])
	it(`offline replay seed (${qemu ? "QEMU" : "PVE"}) preserves YAML 1.1 types`, () => {
		const seed = renderOfflineSeed("0123456789abcdef01234567");
		if (qemu) qemuBootSeed(seed, false);
		assertSameScalars(seed);
		const user = yaml11(String(seed.get("user-data")));
		expect(user.package_update).toBe(false);
		expect(user.package_upgrade).toBe(false);
		expect(user.packages).toEqual([]);
		expect(yaml11(String(seed.get("network-config"))).ethernets).toEqual({});
	});
it("installed netplan uses numeric schema version, string matcher and native booleans", () => {
	const text = readFileSync(
		join(root, "infra/templates/linux/files/etc/netplan/10-umiak.yaml"),
		"utf8",
	);
	const value = yaml11(text);
	expect(value).toEqual(parse(text, { version: "1.2" }));
	expect(value.network).toEqual({
		version: 2,
		ethernets: {
			en: {
				match: { name: "en*" },
				dhcp4: true,
				dhcp6: false,
				"accept-ra": false,
			},
		},
	});
});
for (const id of [
	"on",
	"off",
	"yes",
	"no",
	"0644",
	"12:30",
	"1.10",
	"52:54:00:25:00:01",
])
	it(`metadata quotes ambiguous string identity ${id}`, () => {
		const seed = productionSeed("linux", false, id);
		assertSameScalars(seed);
		expect(yaml11(String(seed.get("meta-data")))["instance-id"]).toBe(id);
	});
