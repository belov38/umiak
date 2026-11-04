import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { renderHelp, renderSetup } from "./setup-ui.mjs";

test("wizard expands the current step and marks completed steps", () => {
	const html = renderSetup({
		steps: { limits: { status: "ready" }, network: { status: "ready" } },
	});
	assert.equal((html.match(/<details /g) || []).length, 4);
	assert.equal(
		(html.match(/<details name="setup-step" open>/g) || []).length,
		1,
	);
	assert.match(html, /<h1>Templates and smoke test<\/h1>/);
	assert.match(html, /<summary>✓ 1\. Storage/);
	assert.match(html, /open><summary>3\. Template builds/);
	assert.doesNotMatch(html, /github\.com\/belov38/);
	assert.doesNotMatch(
		html,
		/Connect Proxmox|Prepare or adopt|Funnel(?! Display)|chrome:\/\/flags|docker compose|id="prepare"|owner\/tls/,
	);
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

test("setup renders no tailnet, LAN or browser-flag guidance", () => {
	assert.doesNotMatch(
		renderSetup({ steps: {} }),
		/Funnel(?! Display)|Tailscale Serve|trusted LAN|chrome:/,
	);
});

test("help points at the given origin without LAN, flag or compose guidance", () => {
	const html = renderHelp("https://umiak.tail123.ts.net");
	assert.match(html, /https:\/\/umiak.tail123.ts.net\/install.sh/);
	assert.doesNotMatch(
		html,
		/owner\/tls|UMIAK_CA_CERT|quickstart-ca.pem|owner HTTPS CA|chrome:\/\/flags|docker compose|LAN HTTP/,
	);
});

test("help copy controls work without the secure-context Clipboard API", async () => {
	const html = renderHelp("https://umiak.tail123.ts.net");
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
	const html = renderSetup({ steps: {} });
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

test("progress counts only visible steps and warns until the installer has bootstrapped", () => {
	const ready = { status: "ready" };
	const boot = { connection: ready, host: ready };
	const none = renderSetup({ steps: boot });
	assert.match(none, /0 of 4 steps verified/);
	assert.match(none, /aria-valuenow="0"/);
	assert.doesNotMatch(none, /installer has not finished/);
	const all = renderSetup({
		steps: {
			...boot,
			limits: ready,
			network: ready,
			templates: ready,
			smoke: ready,
		},
	});
	assert.match(all, /4 of 4 steps verified/);
	assert.match(all, /aria-valuenow="4"/);
	assert.match(all, /width:100%/);
	assert.match(
		renderSetup({ steps: {} }),
		/The installer has not finished setting up this deployment\. Re-run the installer on your Proxmox node\./,
	);
});

test("setup page shows a recorded installer import failure", () => {
	const html = renderSetup({
		steps: {},
		bootstrapError: { message: "fingerprint <mismatch>" },
	});
	assert.match(
		html,
		/Installer data could not be imported: fingerprint &lt;mismatch&gt;/,
	);
});
