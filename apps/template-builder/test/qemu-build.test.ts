import { expect, it } from "vitest";
import { assertOfflineReplayFacts } from "../src/qemu-build.ts";

const facts = {
	kernel: "6.20",
	systemd: "systemd 259",
	packages: { bash: "5.3", chromium: "156" },
	tools: { node: "v26.0.0", claude: null },
};
it("requires exact package/tool/kernel parity in a fresh offline replay", () => {
	expect(() =>
		assertOfflineReplayFacts(facts, structuredClone(facts)),
	).not.toThrow();
	for (const mismatch of [
		{ packages: { ...facts.packages, bash: "5.4" } },
		{ tools: { ...facts.tools, node: null } },
		{ kernel: "other" },
		{ packages: { bash: "5.3" } },
		{ tools: { ...facts.tools, claude: "bundled" } },
	])
		expect(() =>
			assertOfflineReplayFacts(facts, { ...facts, ...mismatch }),
		).toThrow(/replay/i);
});

it("preserves an existing output directory when capture preparation fails", async () => {
	const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join, resolve } = await import("node:path");
	const { captureLayer } = await import("../src/qemu-build.ts");
	const root = await mkdtemp(join(tmpdir(), "umiak-capture-owner-"));
	try {
		await writeFile(join(root, "foreign"), "keep");
		await expect(
			captureLayer({
				slug: "linux",
				version: "20261106.1",
				templatesDir: resolve(import.meta.dirname, "../../../infra/templates"),
				outputDir: root,
				cacheDir: join(root, "cache"),
				agentBinary: "unused",
				agentVersion: "1.0.0",
				unitsDirectory: "unused",
				updateKeysFile: "unused",
				log() {},
			}),
		).rejects.toThrow();
		expect(await readFile(join(root, "foreign"), "utf8")).toBe("keep");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("dry-runs capture cloud-init without interface-name assumptions and preserves QGA bootstrap", async () => {
	const { parse, stringify } = await import("yaml");
	const { qemuBootSeed } = await import("../src/qemu-build.ts");
	const { CAPTURE_MAC } = await import("../src/qemu.ts");
	const { readFileSync } = await import("node:fs");
	// Substitute snapshot placeholders as JSON scalars, as the production renderer does.
	const raw = readFileSync(
		new URL(
			"../../../infra/templates/linux/seed/user-data.tmpl",
			import.meta.url,
		),
		"utf8",
	)
		.replaceAll("{{apt_snapshot_script}}", JSON.stringify("snapshot helper"))
		.replaceAll("{{apt_snapshot}}", JSON.stringify("20261030T000000Z"));
	const seed = new Map<string, string | Buffer>([
		["user-data", raw],
		[
			"network-config",
			stringify({
				version: 2,
				ethernets: { nics: { match: { name: "en*" }, dhcp4: true } },
			}),
		],
	]);
	qemuBootSeed(seed, true);
	const config = parse(String(seed.get("user-data")));
	expect(config.packages).toContain("qemu-guest-agent");
	expect(JSON.stringify(config.runcmd)).toContain(
		"systemctl enable --now qemu-guest-agent",
	);
	expect(config.output.all).toContain("/dev/ttyS0");
	expect(parse(String(seed.get("network-config")))).toEqual({
		version: 2,
		ethernets: { capture: { match: { macaddress: CAPTURE_MAC }, dhcp4: true } },
	});
	const offline = new Map<string, string | Buffer>([
		["user-data", "#cloud-config\nusers: []\n"],
		["network-config", "version: 2\nethernets: {}\n"],
	]);
	qemuBootSeed(offline, false);
	expect(parse(String(offline.get("network-config"))).ethernets).toEqual({});
});
