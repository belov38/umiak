import {
	cpSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	isBuiltinStep,
	loadRecipe,
	loadVersions,
	recipeDigest,
	recipeFile,
	resolveProductKey,
	stepFile,
} from "../src/recipe.ts";

const repoTemplates = resolve(import.meta.dirname, "../../../infra/templates");
const fixtures = resolve(import.meta.dirname, "fixtures/templates");

const tmpDirs: string[] = [];
function copyFixtures(): string {
	const dir = mkdtempSync(join(tmpdir(), "umiak-tpl-test-"));
	tmpDirs.push(dir);
	cpSync(fixtures, dir, { recursive: true });
	return dir;
}
afterEach(() => {
	for (const d of tmpDirs.splice(0))
		rmSync(d, { recursive: true, force: true });
});

describe("loadRecipe: real linux recipe", () => {
	const r = loadRecipe(repoTemplates, "linux");

	it("matches the spec step list", () => {
		expect(r.steps).toEqual([
			"00-base",
			"reboot",
			"10-system",
			"20-docker",
			"30-toolchains",
			"40-coding-agents",
			"50-umiak-agent",
			"90-cleanup",
		]);
	});

	it("builds only into its assigned Linux slot 597", () => {
		expect(r.vmids).toEqual([597]);
	});

	it("normalizes hw, disk and build vm", () => {
		expect(r.slug).toBe("linux");
		expect(r.os).toBe("linux");
		expect(r.extends).toBeNull();
		expect(r.hw.rng0).toBe("source=/dev/urandom");
		expect(r.hw.tablet).toBe("0");
		expect(r.hw.agent).toBe("enabled=1");
		expect(r.hw).not.toHaveProperty("cloudinit");
		expect(r.cloudinit).toBe(false);
		expect(r.disk).toEqual({ slot: "scsi0", sizeGb: 64 });
		expect(r.buildVm).toEqual({ cores: 4, memoryMb: 4096 });
		expect(r.source).toEqual({
			kind: "cloud-image",
			distro: "ubuntu",
			release: "26.04",
			flavor: "minimal",
		});
		expect(r.seal).toBe("umiak-agent");
		expect(r.bootTimeoutS).toBe(300);
		expect(r.verify).toBe("linux");
		expect(r.dir).toBe(join(repoTemplates, "linux"));
		expect(r.stepDirs).toEqual([join(repoTemplates, "linux")]);
	});
});

describe("loadRecipe: real windows recipe", () => {
	const r = loadRecipe(repoTemplates, "windows", "windows");

	it("builds into the Windows slot 598 only", () => {
		expect(r.vmids).toEqual([598]);
	});

	it("matches the spec (no pool, no size_default)", () => {
		expect(r.steps).toEqual([
			"00-base",
			"reboot",
			"network-up",
			"10-system",
			"30-toolchains",
			"40-coding-agents",
			"reboot",
			"50-umiak-agent",
			"60-desktop",
			"90-cleanup",
		]);
		expect(r.source).toEqual({
			kind: "iso-install",
			family: "client",
			drivers: "w11",
			locale: { formats: "en-US", keyboard: "en-US", timezone: "UTC" },
		});
		expect(r.seal).toBe("sysprep");
		expect(r.offline).toEqual(["defender-off", "waasmedic-off"]);
		expect(r.options).toEqual({ vsBuildtools: false });
		expect(r.bootTimeoutS).toBe(1200);
		expect(r.installTimeoutS).toBe(2400);
		expect(r.stepTimeoutsMin).toEqual({
			"30-toolchains": 60,
			"40-coding-agents": 45,
			"90-cleanup": 120,
		});
		expect(r.verify).toBe("windows");
		expect(r.disk).toEqual({ slot: "scsi0", sizeGb: 96 });
		expect(r.buildVm).toEqual({ cores: 4, memoryMb: 4096 });
		expect(r.hw.machine).toBe("pinned");
		expect(r.firmwareDisks).toEqual({
			efidisk0: { efitype: "4m", "pre-enrolled-keys": "1", "ms-cert": "2023k" },
			tpmstate0: { version: "v2.0" },
		});
		expect(r.stepDirs).toEqual([
			join(repoTemplates, "_windows"),
			join(repoTemplates, "windows"),
		]);
	});

	it("pins Ilia's ISO, virtio-win 0.1.271 and a generic Pro key", () => {
		const v = loadVersions(r);
		expect(v.iso).toMatchObject({
			file: "Windows11_Client_x64_en-gb_26300_9457.iso",
			edition: "Windows 11 Pro",
			productKey: "generic-pro",
			channel: "retail",
			uiLanguage: "en-GB",
		});
		expect(v.virtioWin).toEqual({
			version: "0.1.271",
			sha256:
				"bbe6166ad86a490caefad438fef8aa494926cb0a1b37fa1212925cfd81656429",
		});
		expect(Object.keys(v.npm).sort()).toEqual([
			"@anthropic-ai/claude-code",
			"@google/gemini-cli",
			"@openai/codex",
			"opencode-ai",
		]);
		expect(resolveProductKey(r, "generic-pro")).toBe(
			"VK7JG-NPHTM-C97JM-9MPGT-3V66T",
		);
	});
});

describe("loadRecipe: validation", () => {
	it("rejects unknown keys", () => {
		const dir = copyFixtures();
		const p = join(dir, "linux-fixture/template.yaml");
		writeFileSync(p, `${readText(p)}surprise: 1\n`);
		expect(() => loadRecipe(dir, "linux-fixture")).toThrow(/surprise/);
	});

	it("rejects unknown keys in nested objects", () => {
		const dir = copyFixtures();
		const p = join(dir, "linux-fixture/template.yaml");
		writeFileSync(
			p,
			readText(p).replace(
				"build_vm: { cores: 2,",
				"build_vm: { extra: 1, cores: 2,",
			),
		);
		expect(() => loadRecipe(dir, "linux-fixture")).toThrow(/extra/);
	});

	it("rejects a slug that does not match the directory", () => {
		const dir = copyFixtures();
		const p = join(dir, "linux-fixture/template.yaml");
		writeFileSync(p, readText(p).replace("slug: linux-fixture", "slug: other"));
		expect(() => loadRecipe(dir, "linux-fixture")).toThrow(/slug/);
	});

	it("rejects path-like slugs", () => {
		expect(() => loadRecipe(fixtures, "../child")).toThrow(/slug/);
	});

	it("rejects a disk size that is not whole gigabytes", () => {
		const dir = copyFixtures();
		const p = join(dir, "linux-fixture/template.yaml");
		writeFileSync(p, readText(p).replace("size: 32G", "size: 32M"));
		expect(() => loadRecipe(dir, "linux-fixture")).toThrow(/size/);
	});

	it("rejects a step name that is not a plain name", () => {
		const dir = copyFixtures();
		const p = join(dir, "linux-fixture/template.yaml");
		writeFileSync(p, readText(p).replace("90-cleanup]", "../evil]"));
		expect(() => loadRecipe(dir, "linux-fixture")).toThrow(/step/);
	});

	it("rejects @parent without extends", () => {
		const dir = copyFixtures();
		const p = join(dir, "linux-fixture/template.yaml");
		writeFileSync(
			p,
			readText(p).replace("steps: [00-base,", 'steps: ["@parent", 00-base,'),
		);
		expect(() => loadRecipe(dir, "linux-fixture")).toThrow(/@parent/);
	});

	it("rejects a missing recipe", () => {
		expect(() => loadRecipe(fixtures, "nope")).toThrow(/nope/);
	});
});

describe("loadRecipe: extends", () => {
	const child = loadRecipe(fixtures, "child", "linux");

	it("expands @parent in steps", () => {
		expect(child.steps).toEqual([
			"00-base",
			"reboot",
			"10-system",
			"90-cleanup",
			"60-desktop",
		]);
		expect(child.extends).toBe("linux-fixture");
	});

	it("inherits fields and merges overrides", () => {
		expect(child.source.release).toBe("26.04");
		expect(child.hw.vga).toBe("virtio");
		expect(child.hw.machine).toBe("q35");
		expect(child.cloudinit).toBe(false);
		expect(child.buildVm).toEqual({ cores: 2, memoryMb: 2048 });
		expect(child.disk.sizeGb).toBe(48);
		expect(child.seal).toBe("umiak-agent");
		expect(child.bootTimeoutS).toBe(300);
		expect(child.verify).toBe("linux");
	});

	it("looks step files up in the child first, then the parent", () => {
		expect(child.dir).toBe(join(fixtures, "child"));
		expect(child.stepDirs).toEqual([
			join(fixtures, "linux-fixture"),
			join(fixtures, "child"),
		]);
		expect(stepFile(child, "00-base")).toBe(
			join(fixtures, "linux-fixture/steps/00-base.sh"),
		);
		expect(stepFile(child, "60-desktop")).toBe(
			join(fixtures, "child/steps/60-desktop.sh"),
		);
	});

	it("prefers the child's file when both define a step", () => {
		const dir = copyFixtures();
		writeFileSync(join(dir, "child/steps/00-base.sh"), "#!/usr/bin/env bash\n");
		expect(stepFile(loadRecipe(dir, "child"), "00-base")).toBe(
			join(dir, "child/steps/00-base.sh"),
		);
	});

	it("keeps the child's own list when there is no @parent token", () => {
		const dir = copyFixtures();
		const p = join(dir, "child/template.yaml");
		writeFileSync(
			p,
			readText(p).replace(
				'steps: ["@parent", "60-desktop"]',
				"steps: [60-desktop]",
			),
		);
		expect(loadRecipe(dir, "child").steps).toEqual(["60-desktop"]);
	});

	it("inherits the parent's steps when the child has none", () => {
		const dir = copyFixtures();
		const p = join(dir, "child/template.yaml");
		writeFileSync(
			p,
			readText(p).replace('steps: ["@parent", "60-desktop"]\n', ""),
		);
		expect(loadRecipe(dir, "child").steps).toEqual([
			"00-base",
			"reboot",
			"10-system",
			"90-cleanup",
		]);
	});

	it("does not inherit the template slots", () => {
		const dir = copyFixtures();
		const p = join(dir, "child/template.yaml");
		writeFileSync(p, readText(p).replace(/^vmids:.*$/m, ""));
		expect(() => loadRecipe(dir, "child")).toThrow(/vmids/);
	});

	it("throws on a cycle", () => {
		expect(() => loadRecipe(fixtures, "cycle-a")).toThrow(/cycle/);
	});

	it("throws on an unknown parent", () => {
		const dir = copyFixtures();
		const p = join(dir, "child/template.yaml");
		writeFileSync(
			p,
			readText(p).replace("extends: linux-fixture", "extends: ghost"),
		);
		expect(() => loadRecipe(dir, "child")).toThrow(/ghost/);
	});
});

describe("stepFile", () => {
	const r = loadRecipe(fixtures, "linux-fixture");

	it("resolves to <dir>/steps/<name>.sh", () => {
		expect(stepFile(r, "10-system")).toBe(
			join(fixtures, "linux-fixture/steps/10-system.sh"),
		);
	});

	it("throws when the file is missing", () => {
		expect(() => stepFile(r, "20-docker")).toThrow(/20-docker/);
	});

	it("never resolves the built-in reboot step to a file", () => {
		expect(() => stepFile(r, "reboot")).toThrow(/reboot/);
	});
});

describe("recipeDigest", () => {
	it("is stable across calls", () => {
		const r = loadRecipe(fixtures, "child");
		expect(recipeDigest(r)).toMatch(/^[0-9a-f]{64}$/);
		expect(recipeDigest(r)).toBe(recipeDigest(r));
	});

	it("is the same for a copy at another path", () => {
		const dir = copyFixtures();
		expect(recipeDigest(loadRecipe(dir, "child"))).toBe(
			recipeDigest(loadRecipe(fixtures, "child")),
		);
	});

	it("changes when a step file changes", () => {
		const dir = copyFixtures();
		const before = recipeDigest(loadRecipe(dir, "child"));
		writeFileSync(
			join(dir, "linux-fixture/steps/10-system.sh"),
			"#!/usr/bin/env bash\necho changed\n",
		);
		expect(recipeDigest(loadRecipe(dir, "child"))).not.toBe(before);
	});

	it("changes when a new file appears", () => {
		const dir = copyFixtures();
		const before = recipeDigest(loadRecipe(dir, "linux-fixture"));
		writeFileSync(
			join(dir, "linux-fixture/steps/20-docker.sh"),
			"#!/usr/bin/env bash\n",
		);
		expect(recipeDigest(loadRecipe(dir, "linux-fixture"))).not.toBe(before);
	});
});

describe("loadVersions", () => {
	it("loads and validates a standalone versions.toml", () => {
		const v = loadVersions(loadRecipe(fixtures, "linux-fixture", "linux"));
		expect(v.base.serial).toBe("20261024");
		expect(v.apt.snapshot).toBe("20261029T000000Z");
		expect(v.tools.rust.rustup_init_sha256).toMatch(/^6+$/);
		expect(v.chrome.google_chrome_stable.version).toBe("156.0.8078.73-1");
		expect(v.npm.pnpm).toBe("12.16.1");
		expect(v.umiak).toBeUndefined();
	});

	it("merges the child's file over the parent's", () => {
		const v = loadVersions(loadRecipe(fixtures, "child", "linux"));
		expect(v.npm).toEqual({
			"@anthropic-ai/claude-code": "2.1.312",
			pnpm: "12.16.1",
			x: "1",
		});
		expect(v.tools.node.version).toBe("26.13.0");
	});

	it("lets the child override a parent value", () => {
		const dir = copyFixtures();
		writeFileSync(join(dir, "child/versions.toml"), '[npm]\npnpm = "99.0.0"\n');
		expect(loadVersions(loadRecipe(dir, "child", "linux")).npm.pnpm).toBe(
			"99.0.0",
		);
	});

	it("works when the child has no versions.toml", () => {
		const dir = copyFixtures();
		rmSync(join(dir, "child/versions.toml"));
		expect(
			loadVersions(loadRecipe(dir, "child", "linux")).npm,
		).not.toHaveProperty("x");
	});

	it("throws when no versions.toml exists", () => {
		const dir = copyFixtures();
		rmSync(join(dir, "linux-fixture/versions.toml"));
		expect(() =>
			loadVersions(loadRecipe(dir, "linux-fixture", "linux")),
		).toThrow(/base/);
	});

	it("rejects a malformed sha256", () => {
		const dir = copyFixtures();
		const p = join(dir, "linux-fixture/versions.toml");
		writeFileSync(p, readText(p).replace(/sha256 = "0{64}"/, 'sha256 = "xyz"'));
		expect(() =>
			loadVersions(loadRecipe(dir, "linux-fixture", "linux")),
		).toThrow(/sha256/);
	});

	it("rejects a malformed apt snapshot", () => {
		const dir = copyFixtures();
		const p = join(dir, "linux-fixture/versions.toml");
		writeFileSync(p, readText(p).replace("20261029T000000Z", "2026-10-29"));
		expect(() =>
			loadVersions(loadRecipe(dir, "linux-fixture", "linux")),
		).toThrow(/snapshot/);
	});

	it("rejects unknown sections", () => {
		const dir = copyFixtures();
		const p = join(dir, "linux-fixture/versions.toml");
		writeFileSync(p, `${readText(p)}\n[extra]\na = 1\n`);
		expect(() =>
			loadVersions(loadRecipe(dir, "linux-fixture", "linux")),
		).toThrow(/extra/);
	});
});

describe("loadRecipe: windows (iso-install)", () => {
	it("loads the windows fixture recipe with nested efidisk0/tpmstate0", () => {
		const r = loadRecipe(fixtures, "windows-fixture");
		expect(r.os).toBe("windows");
		expect(r.source).toEqual({
			kind: "iso-install",
			family: "client",
			drivers: "w11",
			locale: { formats: "en-US", keyboard: "en-US", timezone: "UTC" },
		});
		expect(r.hw).toEqual({
			machine: "pinned",
			cpu: "host",
			bios: "ovmf",
			ostype: "win11",
			tablet: "1",
		});
		expect(r.firmwareDisks).toEqual({
			efidisk0: { efitype: "4m", "pre-enrolled-keys": "1", "ms-cert": "2023k" },
			tpmstate0: { version: "v2.0" },
		});
		expect(r.cloudinit).toBe(false);
		expect(r.disk).toEqual({ slot: "scsi0", sizeGb: 96 });
		expect(r.steps).toEqual([
			"00-base",
			"reboot",
			"network-up",
			"10-system",
			"90-cleanup",
		]);
		expect(r.seal).toBe("sysprep");
		expect(r.offline).toEqual(["defender-off", "waasmedic-off"]);
		expect(r.options).toEqual({ vsBuildtools: false });
		expect(r.bootTimeoutS).toBe(1200);
		expect(r.installTimeoutS).toBe(2400);
		expect(r.verify).toBe("windows");
		expect(r.shared).toBe("_winshared");
		expect(r.stepDirs).toEqual([
			join(fixtures, "_winshared"),
			join(fixtures, "windows-fixture"),
		]);
	});

	it("defaults offline, options and install timeout", () => {
		const dir = copyFixtures();
		const p = join(dir, "windows-fixture/template.yaml");
		writeFileSync(
			p,
			readText(p)
				.replace("offline: [defender-off, waasmedic-off]\n", "")
				.replace("options: { vs_buildtools: false }\n", ""),
		);
		const r = loadRecipe(dir, "windows-fixture");
		expect(r.offline).toEqual([]);
		expect(r.options).toEqual({ vsBuildtools: false });
		expect(r.installTimeoutS).toBe(2400);
		expect(r.stepTimeoutsMin).toEqual({});
	});

	it("reads step_timeouts in minutes per script step", () => {
		const dir = copyFixtures();
		const p = join(dir, "windows-fixture/template.yaml");
		writeFileSync(
			p,
			`${readText(p)}step_timeouts: { 10-system: 45, 90-cleanup: 120 }\n`,
		);
		const r = loadRecipe(dir, "windows-fixture");
		expect(r.stepTimeoutsMin).toEqual({ "10-system": 45, "90-cleanup": 120 });
	});

	it("rejects step_timeouts of unknown or built-in steps and non-positive minutes", () => {
		for (const [entry, msg] of [
			["nope: 5", /nope/],
			["reboot: 5", /reboot/],
			["network-up: 5", /network-up/],
			["10-system: 0", /step_timeouts/],
			["10-system: 1.5", /step_timeouts/],
		] as const) {
			const dir = copyFixtures();
			const p = join(dir, "windows-fixture/template.yaml");
			writeFileSync(p, `${readText(p)}step_timeouts: { ${entry} }\n`);
			expect(() => loadRecipe(dir, "windows-fixture"), entry).toThrow(msg);
		}
	});

	it("reads install_timeout_s and vs_buildtools", () => {
		const dir = copyFixtures();
		const p = join(dir, "windows-fixture/template.yaml");
		writeFileSync(
			p,
			`${readText(p).replace("vs_buildtools: false", "vs_buildtools: true")}install_timeout_s: 3000\n`,
		);
		const r = loadRecipe(dir, "windows-fixture");
		expect(r.installTimeoutS).toBe(3000);
		expect(r.options.vsBuildtools).toBe(true);
	});

	it("rejects unknown offline stage", () => {
		const dir = copyFixtures();
		const p = join(dir, "windows-fixture/template.yaml");
		writeFileSync(p, readText(p).replace("waasmedic-off]", "smartscreen-off]"));
		expect(() => loadRecipe(dir, "windows-fixture")).toThrow(/offline/);
	});

	it("rejects nested objects for other hw keys", () => {
		const dir = copyFixtures();
		const p = join(dir, "windows-fixture/template.yaml");
		writeFileSync(p, readText(p).replace("cpu: host", "cpu: { type: host }"));
		expect(() => loadRecipe(dir, "windows-fixture")).toThrow(/hw\.cpu/);
	});

	it("requires efidisk0 and tpmstate0 to be objects", () => {
		const dir = copyFixtures();
		const p = join(dir, "windows-fixture/template.yaml");
		writeFileSync(
			p,
			readText(p).replace(
				"tpmstate0: { version: v2.0 }",
				'tpmstate0: "local-lvm:1,version=v2.0"',
			),
		);
		expect(() => loadRecipe(dir, "windows-fixture")).toThrow(/tpmstate0/);
	});

	it("rejects a cloud-image source for os windows", () => {
		const dir = copyFixtures();
		const p = join(dir, "windows-fixture/template.yaml");
		writeFileSync(
			p,
			readText(p).replace(
				/source:\n(?: {2}.*\n)+/,
				'source: { kind: cloud-image, distro: ubuntu, release: "26.04", flavor: minimal }\n',
			),
		);
		expect(() => loadRecipe(dir, "windows-fixture")).toThrow(/iso-install/);
	});

	it("rejects seal umiak-agent for os windows", () => {
		const dir = copyFixtures();
		const p = join(dir, "windows-fixture/template.yaml");
		writeFileSync(p, readText(p).replace("seal: sysprep", "seal: umiak-agent"));
		expect(() => loadRecipe(dir, "windows-fixture")).toThrow(/seal/);
	});

	it("rejects windows-only fields in a linux recipe", () => {
		for (const extra of [
			"seal: sysprep",
			"offline: [defender-off]",
			"options: { vs_buildtools: true }",
			"install_timeout_s: 100",
			"step_timeouts: { 00-base: 5 }",
		]) {
			const dir = copyFixtures();
			const p = join(dir, "linux-fixture/template.yaml");
			const key = extra.split(":")[0] as string;
			const text =
				key === "seal"
					? readText(p).replace("seal: umiak-agent", extra)
					: `${readText(p)}${extra}\n`;
			writeFileSync(p, text);
			expect(() => loadRecipe(dir, "linux-fixture"), extra).toThrow(
				new RegExp(key),
			);
		}
	});

	it("rejects machine: pinned and firmware disks in a linux recipe", () => {
		const dir = copyFixtures();
		const p = join(dir, "linux-fixture/template.yaml");
		writeFileSync(p, readText(p).replace("machine: q35", "machine: pinned"));
		expect(() => loadRecipe(dir, "linux-fixture")).toThrow(/pinned/);
		const dir2 = copyFixtures();
		const p2 = join(dir2, "linux-fixture/template.yaml");
		writeFileSync(
			p2,
			readText(p2).replace("vga: std", "vga: std\n  efidisk0: { efitype: 4m }"),
		);
		expect(() => loadRecipe(dir2, "linux-fixture")).toThrow(/efidisk0/);
	});

	it("rejects a shared dir that is not an _name or does not exist", () => {
		const dir = copyFixtures();
		const p = join(dir, "windows-fixture/template.yaml");
		writeFileSync(p, readText(p).replace("shared: _winshared", "shared: ../x"));
		expect(() => loadRecipe(dir, "windows-fixture")).toThrow(/shared/);
		writeFileSync(p, readText(p).replace("shared: ../x", "shared: _missing"));
		expect(() => loadRecipe(dir, "windows-fixture")).toThrow(/_missing/);
	});

	it("checks the expected os when asked", () => {
		expect(() => loadRecipe(fixtures, "windows-fixture", "linux")).toThrow(
			/windows/,
		);
		expect(loadRecipe(fixtures, "linux-fixture", "linux").os).toBe("linux");
	});
});

describe("stepFile: windows", () => {
	const r = loadRecipe(fixtures, "windows-fixture");

	it("windows steps resolve to .ps1 from the shared dir", () => {
		expect(stepFile(r, "00-base")).toBe(
			join(fixtures, "_winshared/steps/00-base.ps1"),
		);
		expect(stepFile(r, "90-cleanup")).toBe(
			join(fixtures, "_winshared/steps/90-cleanup.ps1"),
		);
	});

	it("prefers the recipe's own step over the shared one", () => {
		expect(stepFile(r, "10-system")).toBe(
			join(fixtures, "windows-fixture/steps/10-system.ps1"),
		);
	});

	it("never resolves the built-in reboot and network-up steps", () => {
		expect(() => stepFile(r, "reboot")).toThrow(/built in/);
		expect(() => stepFile(r, "network-up")).toThrow(/built in/);
		expect(isBuiltinStep(r, "network-up")).toBe(true);
		expect(isBuiltinStep(r, "reboot")).toBe(true);
		expect(isBuiltinStep(r, "00-base")).toBe(false);
	});

	it("network-up is not built in for linux", () => {
		const l = loadRecipe(fixtures, "linux-fixture");
		expect(isBuiltinStep(l, "network-up")).toBe(false);
		expect(() => stepFile(l, "network-up")).toThrow(/network-up\.sh/);
	});

	it("names the .ps1 file when missing", () => {
		expect(() => stepFile(r, "30-toolchains")).toThrow(/30-toolchains\.ps1/);
	});

	it("finds other files recipe dir first, then the shared dir", () => {
		expect(recipeFile(r, "keys.toml")).toBe(
			join(fixtures, "_winshared/keys.toml"),
		);
		expect(recipeFile(r, "template.yaml")).toBe(
			join(fixtures, "windows-fixture/template.yaml"),
		);
		expect(() => recipeFile(r, "nope.txt")).toThrow(/nope\.txt/);
		expect(() => recipeFile(r, "../linux-fixture/template.yaml")).toThrow(
			/invalid/,
		);
	});

	it("includes the shared dir in the digest", () => {
		const dir = copyFixtures();
		const before = recipeDigest(loadRecipe(dir, "windows-fixture"));
		writeFileSync(join(dir, "_winshared/steps/00-base.ps1"), "exit 1\n");
		expect(recipeDigest(loadRecipe(dir, "windows-fixture"))).not.toBe(before);
	});
});

describe("loadVersions: windows", () => {
	it("loads the windows versions with camelCase fields", () => {
		const v = loadVersions(loadRecipe(fixtures, "windows-fixture", "windows"));
		expect(v.iso).toEqual({
			file: "Windows11_Client_x64_en-gb_26300_9457.iso",
			sha256: "",
			edition: "Windows 11 Pro",
			productKey: "generic-pro",
			channel: "retail",
			uiLanguage: "en-GB",
		});
		expect(v.virtioWin).toEqual({
			version: "0.1.271",
			sha256:
				"bbe6166ad86a490caefad438fef8aa494926cb0a1b37fa1212925cfd81656429",
		});
		expect(Object.keys(v.tools).sort()).toEqual([
			"bun",
			"gh",
			"git",
			"go",
			"node",
			"pwsh",
			"python",
			"uv",
		]);
		expect(v.tools.go.url).toBe("https://go.dev/dl/go1.27.3.windows-amd64.msi");
		expect(v.npm).toEqual({ "@anthropic-ai/claude-code": "2.1.312" });
		expect(v.openssh).toEqual({ source: "inbox" });
	});

	it("maps an absent product_key to null", () => {
		const dir = copyFixtures();
		const p = join(dir, "windows-fixture/versions.toml");
		writeFileSync(p, readText(p).replace('product_key = "generic-pro"\n', ""));
		const v = loadVersions(loadRecipe(dir, "windows-fixture", "windows"));
		expect(v.iso.productKey).toBeNull();
	});

	it("windows versions parser requires iso.sha256 and tools sha256", () => {
		const load = (edit: (s: string) => string) => {
			const dir = copyFixtures();
			const p = join(dir, "windows-fixture/versions.toml");
			writeFileSync(p, edit(readText(p)));
			return () => loadVersions(loadRecipe(dir, "windows-fixture", "windows"));
		};
		// Empty is the "not known yet" value; build refuses it without --accept-iso-sha256.
		expect(load((s) => s)().iso.sha256).toBe("");
		expect(
			load((s) => s.replace('sha256 = ""', `sha256 = "${"a".repeat(64)}"`))()
				.iso.sha256,
		).toBe("a".repeat(64));
		expect(load((s) => s.replace('sha256 = ""\n', ""))).toThrow(/iso.*sha256/s);
		expect(load((s) => s.replace('sha256 = ""', 'sha256 = "xyz"'))).toThrow(
			/sha256/,
		);
		expect(
			load((s) =>
				s.replace(
					'sha256 = "079e7cecedd1e87fa7b4676e5c33ddfbe66859a44a97fbcd1db797245cbb93d2"\n',
					"",
				),
			),
		).toThrow(/pwsh.*sha256/s);
		expect(
			load((s) =>
				s.replace(
					'sha256 = "079e7cecedd1e87fa7b4676e5c33ddfbe66859a44a97fbcd1db797245cbb93d2"',
					'sha256 = ""',
				),
			),
		).toThrow(/pwsh.*sha256/s);
		expect(
			load((s) =>
				s.replace(
					'sha256 = "bbe6166ad86a490caefad438fef8aa494926cb0a1b37fa1212925cfd81656429"',
					'sha256 = ""',
				),
			),
		).toThrow(/virtio_win.*sha256/s);
	});

	it("requires every tool and rejects unknown sections and tools", () => {
		const dir = copyFixtures();
		const p = join(dir, "windows-fixture/versions.toml");
		const base = readText(p);
		writeFileSync(p, base.replace(/\[tools\.gh\][^[]*/, ""));
		expect(() =>
			loadVersions(loadRecipe(dir, "windows-fixture", "windows")),
		).toThrow(/gh/);
		writeFileSync(p, `${base}\n[tools.rust]\nversion = "1"\n`);
		expect(() =>
			loadVersions(loadRecipe(dir, "windows-fixture", "windows")),
		).toThrow(/rust/);
		writeFileSync(p, `${base}\n[base]\nserial = "1"\n`);
		expect(() =>
			loadVersions(loadRecipe(dir, "windows-fixture", "windows")),
		).toThrow(/base/);
	});

	it("rejects a non-https tool url and a bad channel", () => {
		const dir = copyFixtures();
		const p = join(dir, "windows-fixture/versions.toml");
		const base = readText(p);
		writeFileSync(p, base.replace("https://go.dev/dl/", "http://go.dev/dl/"));
		expect(() =>
			loadVersions(loadRecipe(dir, "windows-fixture", "windows")),
		).toThrow(/url/);
		writeFileSync(p, base.replace('"retail"', '"oem"'));
		expect(() =>
			loadVersions(loadRecipe(dir, "windows-fixture", "windows")),
		).toThrow(/channel/);
	});
});

describe("resolveProductKey", () => {
	const r = loadRecipe(fixtures, "windows-fixture");

	it("looks the key name up in keys.toml", () => {
		expect(resolveProductKey(r, "generic-pro")).toBe(
			"VK7JG-NPHTM-C97JM-9MPGT-3V66T",
		);
	});

	it("throws for an unknown name", () => {
		expect(() => resolveProductKey(r, "generic-home")).toThrow(/generic-home/);
	});

	it("rejects a malformed key", () => {
		const dir = copyFixtures();
		writeFileSync(join(dir, "_winshared/keys.toml"), 'generic-pro = "abc"\n');
		expect(() =>
			resolveProductKey(loadRecipe(dir, "windows-fixture"), "generic-pro"),
		).toThrow(/generic-pro/);
	});
});

function readText(p: string): string {
	return readFileSync(p, "utf8");
}
