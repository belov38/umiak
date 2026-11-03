import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderSetup } from "./setup-ui.mjs";

test("wizard expands the current step and marks completed steps", () => {
	const html = renderSetup(
		{ steps: { connection: { status: "ready" }, host: { status: "ready" } } },
		"https://localhost",
	);
	assert.equal((html.match(/<details /g) || []).length, 6);
	assert.equal(
		(html.match(/<details name="setup-step" open>/g) || []).length,
		1,
	);
	assert.match(html, /<summary>✓ 1\. Connect Proxmox/);
	assert.match(html, /open><summary>3\. Storage/);
	assert.doesNotMatch(html, /github\.com\/belov38/);
	const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");
	assert.match(html, /restart gateway worker api web/);
	assert.match(readme, /restart gateway worker api web/);
	assert.match(html, /owner\/tls\/status/);
});
