import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "smol-toml";
import { expect, it } from "vitest";
import {
	isDesktopRecipe,
	loadRecipe,
	loadVerifyScript,
	loadVersions,
	stepFile,
} from "../src/recipe.ts";
import { buildIsoFiles, renderWindowsAgentToml } from "../src/windows/media.ts";

it("installs Windows desktop with manual services, private config and verified downloads", () => {
	const root = mkdtempSync(join(tmpdir(), "desktop-win-"));
	try {
		const r = spawnSync(
			"mise",
			[
				"exec",
				"--",
				"pwsh",
				"-NoLogo",
				"-NoProfile",
				"-File",
				resolve(import.meta.dirname, "fixtures/windows-desktop.ps1"),
				"-Root",
				root,
				"-Files",
				resolve(
					import.meta.dirname,
					"../../../infra/templates/windows-desktop/files",
				),
			],
			{ encoding: "utf8", timeout: 30_000 },
		);
		expect(r.stderr).toBe("");
		expect(r.status, r.stdout + r.stderr).toBe(0);
		expect(r.stdout).toContain("desktop install fake PASS");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

const templates = resolve(import.meta.dirname, "../../../infra/templates");

function windowsRecipe(slug: string) {
	const r = loadRecipe(templates, slug);
	if (r.os !== "windows") throw new Error(`${slug} is not windows`);
	return r;
}

it("windows-desktop extends windows in slot 595 and adds the streamer step", () => {
	const r = windowsRecipe("windows-desktop");
	const parent = windowsRecipe("windows");
	expect(r.extends).toBe("windows");
	expect(r.vmids).toEqual([595]);
	expect(parent.vmids).toEqual([598]);
	expect(r.verify).toBe("windows-desktop");
	expect(isDesktopRecipe(r)).toBe(true);
	expect(isDesktopRecipe(parent)).toBe(false);
	expect(r.steps.filter((s) => s !== "65-streamer")).toEqual(parent.steps);
	expect(r.steps.slice(-2)).toEqual(["65-streamer", "90-cleanup"]);
	expect(r.hw).toEqual(parent.hw);
	expect(loadVersions(r)).toEqual(loadVersions(parent));
	expect(stepFile(r, "65-streamer")).toContain("/windows-desktop/steps/");
	expect(stepFile(r, "60-desktop")).toContain("/_windows/steps/");
});

it("only the desktop build ISO carries the streamer installer", () => {
	const iso = (slug: string) => {
		const recipe = windowsRecipe(slug);
		return buildIsoFiles({
			recipe,
			versions: loadVersions(recipe),
			agentTar: Buffer.from("agent"),
			agentVersion: "0.1.0+test",
			agentToml: renderWindowsAgentToml(undefined, isDesktopRecipe(recipe)),
			buildPassword: "Passw0rd!Passw0rd!",
			buildId: "test",
		});
	};
	const desktop = iso("windows-desktop");
	const headless = iso("windows");
	for (const f of [
		"build/steps/65-streamer.ps1",
		"build/files/desktop-install.ps1",
		"build/files/desktop-pins.json",
	]) {
		expect(desktop.has(f), f).toBe(true);
		expect(headless.has(f), f).toBe(false);
	}
	const toml = parse(String(desktop.get("build/agent.toml"))) as {
		desktop: { enabled: boolean };
		readiness: { required: string[] };
		ports: { exclude: number[] };
	};
	expect(toml.desktop.enabled).toBe(true);
	expect(toml.readiness.required).toEqual([
		"identity",
		"claim",
		"secrets",
		"desktop",
	]);
	expect(toml.ports.exclude).toEqual([
		22, 135, 47800, 47984, 47989, 47990, 48010,
	]);
	const plain = parse(String(headless.get("build/agent.toml"))) as Record<
		string,
		unknown
	>;
	expect(plain.desktop).toBeUndefined();
});

it("windows-desktop verify runs the full Windows baseline plus the desktop group", () => {
	const script = loadVerifyScript(templates, "windows-desktop", "windows");
	const base = loadVerifyScript(templates, "windows", "windows");
	expect(script.startsWith("#requires -Version 7")).toBe(true);
	expect(script.indexOf("function Test-Desktop")).toBeGreaterThan(
		script.indexOf("param("),
	);
	expect(script.indexOf("function Test-Desktop")).toBeLessThan(
		script.indexOf("# --- main ---"),
	);
	expect(base).not.toContain("Test-Desktop");
	const dir = mkdtempSync(join(tmpdir(), "desktop-verify-"));
	try {
		const file = join(dir, "verify.ps1");
		writeFileSync(file, script);
		const r = spawnSync(
			"mise",
			[
				"exec",
				"--",
				"pwsh",
				"-NoLogo",
				"-NoProfile",
				"-Command",
				`$t=$null;$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$t,[ref]$e);if($e.Count){$e|Out-String;exit 1}`,
			],
			{ encoding: "utf8", timeout: 30_000 },
		);
		expect(r.status, r.stdout + r.stderr).toBe(0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
