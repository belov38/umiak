import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "smol-toml";
import { expect, it } from "vitest";
import {
	loadRecipe,
	loadVerifyScript,
	loadVersions,
	stepFile,
} from "../src/recipe.ts";
import { renderSeed } from "../src/seed.ts";

const templates = resolve(import.meta.dirname, "../../../infra/templates");
it("desktop verification retains the Linux baseline and tools manifest", () => {
	const script = loadVerifyScript(templates, "linux-desktop");
	expect(script).toContain("check_system");
	expect(script).toContain("check_network");
	expect(script).toContain("TOOLS %s");
	expect(script).toContain("desktop_packages");
});
it("desktop inherits Linux pins, uses only slot 596 and enables the desktop readiness/capability", () => {
	const recipe = loadRecipe(templates, "linux-desktop");
	if (recipe.os !== "linux") throw new Error("linux-desktop is not linux");
	expect(recipe.extends).toBe("linux");
	expect(recipe.vmids).toEqual([596]);
	expect(recipe.verify).toBe("linux-desktop");
	expect(recipe.steps.slice(-2)).toEqual(["60-desktop", "90-cleanup"]);
	expect(loadVersions(recipe).tools).toEqual(
		loadVersions(loadRecipe(templates, "linux")).tools,
	);
	expect(stepFile(recipe, "50-sbx-agent")).toContain("/linux/steps/");
	expect(stepFile(recipe, "60-desktop")).toContain("/linux-desktop/steps/");
	const dir = mkdtempSync(join(tmpdir(), "desktop-seed-"));
	try {
		const agentPackage = join(dir, "agent.tar");
		writeFileSync(agentPackage, "test");
		const files = renderSeed({
			recipe,
			versions: loadVersions(recipe),
			buildId: "test",
			version: "test",
			agentPackage,
			agentVersion: "test",
			manifestBase: {},
		});
		const config = parse(String(files.get("build/agent.toml"))) as {
			desktop: { enabled: boolean };
			readiness: { required: string[] };
			ports: { exclude: number[] };
		};
		expect(config.desktop.enabled).toBe(true);
		expect(config.readiness.required).toContain("desktop");
		expect(config.ports.exclude).toEqual(
			expect.arrayContaining([47800, 47984, 47989, 47990, 48010]),
		);
		expect(files.has("build/steps/60-desktop.sh")).toBe(true);
		expect(files.has("build/files/etc/X11/xorg.conf.d/10-sbx-dummy.conf")).toBe(
			true,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
it("desktop scripts parse and do not start a VM or configure a warm pool", () => {
	const recipe = loadRecipe(templates, "linux-desktop");
	for (const path of [
		stepFile(recipe, "60-desktop"),
		join(recipe.dir, "verify.sh"),
	])
		expect(spawnSync("bash", ["-n", path]).status).toBe(0);
	expect(readFileSync(join(recipe.dir, "template.yaml"), "utf8")).not.toMatch(
		/pool:|hibernated|size_default:/,
	);
});

it("normalizes non-executable upstream archive binaries before checking them", () => {
	const root = mkdtempSync(join(tmpdir(), "desktop-archive-"));
	try {
		const script = readFileSync(
			join(templates, "linux-desktop/steps/60-desktop.sh"),
			"utf8",
		);
		const start = script.indexOf('ln -sfn "$moonlight"');
		const end = script.indexOf("id sbxstream", start);
		const fragment = script
			.slice(start, end)
			.replaceAll("/opt/sbx-desktop", root);
		spawnSync("mkdir", [
			"-p",
			join(root, "moonlight-web/test"),
			join(root, "cua-driver/test"),
		]);
		writeFileSync(
			join(root, "moonlight-web/test/web-server"),
			"#!/bin/sh\nexit 0\n",
			{ mode: 0o644 },
		);
		writeFileSync(
			join(root, "cua-driver/test/cua-driver"),
			"#!/bin/sh\nexit 0\n",
			{ mode: 0o644 },
		);
		const result = spawnSync(
			"bash",
			["-e", "-c", `moonlight=test; cua=test; die() { exit 1; };\n${fragment}`],
			{ encoding: "utf8" },
		);
		expect(result.status, result.stderr).toBe(0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
