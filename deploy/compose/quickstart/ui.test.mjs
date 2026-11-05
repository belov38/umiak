import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderSetup } from "./setup-ui.mjs";
import { renderPage, uiAsset } from "./ui.mjs";

test("owner and setup share dashboard tokens, fonts, frame and persisted appearance", () => {
	for (const html of [
		renderPage("Claim", "<h1>Claim</h1>"),
		renderSetup({ steps: {} }, "http://localhost"),
	]) {
		assert.match(html, /Inter Variable/);
		assert.match(html, /Funnel Display Variable/);
		assert.match(html, /aria-label="Main navigation"/);
		assert.match(html, /localStorage.getItem\('umiak-theme'\)/);
		assert.match(html, /localStorage.setItem\('umiak-theme'/);
		assert.match(html, /data-theme="light"/);
		assert.match(html, /data-theme="dark"/);
		assert.match(html, /focus-visible\{outline:2px solid var\(--ring\)/);
		assert.doesNotMatch(html, /border-radius:(?:8|12)px/);
	}
	const source = readFileSync(new URL("./ui.mjs", import.meta.url), "utf8");
	assert.match(source, /apps\/web\/src\/app\/globals.css/);
	assert.doesNotMatch(source, /--(?:background|foreground|primary):\s*#/);
});

test("only fixed font asset paths are public and both fonts are available", () => {
	for (const path of [
		"/quickstart/ui/inter.woff2",
		"/quickstart/ui/funnel.woff2",
	]) {
		let status;
		let data;
		assert.equal(
			uiAsset(path, {
				writeHead: (value) => {
					status = value;
				},
				end: (value) => {
					data = value;
				},
			}),
			true,
		);
		assert.equal(status, 200);
		assert.ok(data.byteLength > 1000);
	}
	assert.equal(uiAsset("/quickstart/ui/../../../etc/passwd", {}), false);
});

test("setup auxiliary controls are secondary and duplicate builds are blocked", () => {
	const html = renderSetup({ steps: {} });
	assert.match(html, /class="outline" type="button" id="validate-media"/);
	assert.doesNotMatch(html, /id="prepare"/);
	assert.match(html, /if \(building\) return/);
	assert.match(html, /button.disabled = true/);
});

test("owner navigation and progress follow dashboard composition", () => {
	const html = renderPage("Owner sessions", "");
	assert.match(
		html,
		/h1\{font-size:2rem;font-weight:400;letter-spacing:-.02em/,
	);
	assert.match(html, /href="\/owner\/sessions" aria-current="page"/);
	assert.match(
		html,
		/class="sidebar-footer"><nav aria-label="Owner navigation"><a href="\/setup"/,
	);
	assert.match(html, /data-theme="light"[^>]*><svg/);
	const setup = renderSetup({ steps: {} });
	assert.match(setup, /href="\/setup" aria-current="page"/);
	assert.match(setup, /role="progressbar"/);
	assert.doesNotMatch(setup, /<progress/);
});

test("setup names missing local templates and unfinished reservations per node", () => {
	const html = renderSetup({
		steps: {},
		sandboxNodes: [
			{
				nodeId: "a",
				name: "pve",
				state: "active",
				templates: [
					{ templateSlug: "linux", version: "20261104.1", pveVmid: 600 },
				],
			},
			{
				nodeId: "b",
				name: "pve2",
				state: "cordoned",
				templates: [],
				buildJobId: "prepare-held",
			},
		],
	});
	assert.match(html, /linux · 20261104\.1 · VM 600/);
	assert.match(html, /pve2[\s\S]*Template missing/);
	assert.match(html, /Unfinished reservation: <code>prepare-held<\/code>/);
});
