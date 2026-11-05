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
