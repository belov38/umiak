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
	loadRecipe,
	loadVersions,
	recipeDigest,
	stepFile,
} from "../src/recipe.ts";

const repoTemplates = resolve(import.meta.dirname, "../../../infra/templates");
const fixtures = resolve(import.meta.dirname, "fixtures/templates");

const tmpDirs: string[] = [];
function copyFixtures(): string {
	const dir = mkdtempSync(join(tmpdir(), "sbx-tpl-test-"));
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
			"50-sbx-agent",
			"90-cleanup",
		]);
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
		expect(r.seal).toBe("sbx-agent");
		expect(r.bootTimeoutS).toBe(300);
		expect(r.verify).toBe("linux");
		expect(r.dir).toBe(join(repoTemplates, "linux"));
		expect(r.stepDirs).toEqual([join(repoTemplates, "linux")]);
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
	const child = loadRecipe(fixtures, "child");

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
		expect(child.seal).toBe("sbx-agent");
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
		const v = loadVersions(loadRecipe(fixtures, "linux-fixture"));
		expect(v.base.serial).toBe("20261024");
		expect(v.apt.snapshot).toBe("20261029T000000Z");
		expect(v.tools.rust.rustup_init_sha256).toMatch(/^6+$/);
		expect(v.chrome.google_chrome_stable.version).toBe("156.0.8078.73-1");
		expect(v.npm.pnpm).toBe("12.16.1");
		expect(v.sbx).toBeUndefined();
	});

	it("merges the child's file over the parent's", () => {
		const v = loadVersions(loadRecipe(fixtures, "child"));
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
		expect(loadVersions(loadRecipe(dir, "child")).npm.pnpm).toBe("99.0.0");
	});

	it("works when the child has no versions.toml", () => {
		const dir = copyFixtures();
		rmSync(join(dir, "child/versions.toml"));
		expect(loadVersions(loadRecipe(dir, "child")).npm).not.toHaveProperty("x");
	});

	it("throws when no versions.toml exists", () => {
		const dir = copyFixtures();
		rmSync(join(dir, "linux-fixture/versions.toml"));
		expect(() => loadVersions(loadRecipe(dir, "linux-fixture"))).toThrow(
			/base/,
		);
	});

	it("rejects a malformed sha256", () => {
		const dir = copyFixtures();
		const p = join(dir, "linux-fixture/versions.toml");
		writeFileSync(p, readText(p).replace(/sha256 = "0{64}"/, 'sha256 = "xyz"'));
		expect(() => loadVersions(loadRecipe(dir, "linux-fixture"))).toThrow(
			/sha256/,
		);
	});

	it("rejects a malformed apt snapshot", () => {
		const dir = copyFixtures();
		const p = join(dir, "linux-fixture/versions.toml");
		writeFileSync(p, readText(p).replace("20261029T000000Z", "2026-10-29"));
		expect(() => loadVersions(loadRecipe(dir, "linux-fixture"))).toThrow(
			/snapshot/,
		);
	});

	it("rejects unknown sections", () => {
		const dir = copyFixtures();
		const p = join(dir, "linux-fixture/versions.toml");
		writeFileSync(p, `${readText(p)}\n[extra]\na = 1\n`);
		expect(() => loadVersions(loadRecipe(dir, "linux-fixture"))).toThrow(
			/extra/,
		);
	});
});

function readText(p: string): string {
	return readFileSync(p, "utf8");
}
