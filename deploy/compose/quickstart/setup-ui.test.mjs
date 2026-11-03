import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { renderHelp, renderSetup } from "./setup-ui.mjs";

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
	assert.doesNotMatch(html, /owner\/tls/);
});

test("setup displays durable build output and prefills the pinned VirtIO checksum", async () => {
	const { VIRTIO_SHA256 } = await import("./setup-iso.mjs");
	const html = renderSetup(
		{
			steps: {},
			buildJob: {
				slug: "windows",
				status: "running",
				log: "actual builder output",
			},
		},
		"https://localhost",
	);
	assert.match(html, /actual builder output/);
	assert.ok(html.includes(`id="build-virtio-sha" value="${VIRTIO_SHA256}"`));
});

test("setup warns on the current ts.net origin and recommends private Serve", () => {
	const html = renderSetup({ steps: {} }, "https://umiak.tail123.ts.net");
	assert.match(html, /if you use Funnel, this is public/);
	assert.match(html, /Tailscale Serve/);
	for (const origin of [
		"http://192.168.1.20:8080",
		"https://ts.net.evil.example",
	]) {
		assert.doesNotMatch(
			renderSetup({ steps: {} }, origin),
			/if you use Funnel, this is public/,
		);
	}
});

test("help installs over LAN HTTP without owner CA commands", () => {
	const html = renderHelp("http://192.168.1.20:8080");
	assert.match(html, /http:\/\/192.168.1.20:8080\/install.sh/);
	assert.doesNotMatch(
		html,
		/owner\/tls|UMIAK_CA_CERT|quickstart-ca.pem|owner HTTPS CA/,
	);
});

test("help copy controls work without the secure-context Clipboard API", async () => {
	const html = renderHelp("http://192.168.1.20:4180");
	const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].find(
		(match) => match[1].includes("async function copyText"),
	)?.[1];
	assert.ok(script, "copy helper must be included in the served page");
	let copied = "";
	let selected = "";
	let removed = false;
	const input = {
		value: "",
		style: {},
		select() {
			selected = this.value;
		},
		remove() {
			removed = true;
		},
	};
	const context = {
		navigator: {},
		document: {
			createElement: () => input,
			body: { append: () => {} },
			execCommand: () => {
				copied = selected;
				return true;
			},
		},
	};
	runInNewContext(script, context);
	await context.copyText("umiak whoami");
	assert.equal(copied, "umiak whoami");
	assert.equal(removed, true);
});

test("setup displays current gateway CA and leaf certificate expiry status", async () => {
	const html = renderSetup({ steps: {} }, "http://192.168.1.20:4180");
	const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].find(
		(match) => match[1].includes("async function showCertificateStatus"),
	)?.[1];
	assert.ok(script, "setup includes certificate status loader");
	const status = { textContent: "" };
	const context = {
		document: {
			querySelector: (selector) => {
				assert.equal(selector, "#certificate-status");
				return status;
			},
		},
		fetch: async (url) => {
			assert.equal(url, "/quickstart/setup/certificates");
			return {
				ok: true,
				json: async () => ({
					caExpiresAt: "2027-01-01",
					tunnelExpiresAt: "2026-12-01",
					previewExpiresAt: "2026-12-02",
					warning: "Rotation requires rebuilding agent packages and templates.",
				}),
			};
		},
	};
	runInNewContext(script, context);
	await context.showCertificateStatus();
	assert.match(status.textContent, /Guest CA expires: 2027-01-01/);
	assert.match(status.textContent, /Tunnel certificate expires: 2026-12-01/);
	assert.match(status.textContent, /Preview certificate expires: 2026-12-02/);
	assert.match(status.textContent, /rebuilding agent packages and templates/);
});

test("setup offers three recipes and one Windows desktop with ISO URL inputs", () => {
	const html = renderSetup({ steps: {} }, "http://localhost");
	const select = html.match(/<select id="build-slug">(.*?)<\/select>/)[1];
	assert.equal((select.match(/<option /g) || []).length, 3);
	assert.match(select, /value="windows">Windows 11 \(with desktop\)/);
	assert.doesNotMatch(select, /windows-desktop/);
	assert.match(html, /id="build-iso-url"/);
});
