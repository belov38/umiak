import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

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
				resolve(import.meta.dirname, "../../../infra/templates/windows/files"),
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
