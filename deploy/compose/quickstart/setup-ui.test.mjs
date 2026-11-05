import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { renderHelp, renderSetup } from "./setup-ui.mjs";

test("wizard expands the current step and marks completed steps", () => {
	const html = renderSetup({
		steps: { limits: { status: "ready" }, network: { status: "ready" } },
	});
	assert.equal((html.match(/<details name="setup-step"/g) || []).length, 4);
	assert.equal(
		(html.match(/<details name="setup-step" id="[^"]+" open>/g) || []).length,
		1,
	);
	assert.match(html, /<h1>Finish setting up Umiak<\/h1>/);
	assert.match(html, /<summary>✓ 1\. Storage/);
	assert.match(html, /open><summary>3\. Prepare your first sandbox image/);
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
	const warning = { textContent: "" };
	const context = {
		document: {
			querySelector: (selector) => {
				if (selector === "#certificate-warning") return warning;
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
	assert.ok(
		status.textContent.includes(new Date("2027-01-01").toLocaleString()),
	);
	assert.ok(
		status.textContent.includes(new Date("2026-12-01").toLocaleString()),
	);
	assert.ok(
		status.textContent.includes(new Date("2026-12-02").toLocaleString()),
	);
	assert.match(warning.textContent, /rebuilding agent packages and templates/);
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
	assert.match(none, /0 of 4 complete/);
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
	assert.match(all, /4 of 4 complete/);
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

test("first-run Linux action precedes optional controls and single node needs no selector", () => {
	const html = renderSetup({
		steps: { limits: { status: "ready" }, network: { status: "ready" } },
		sandboxNodes: [
			{ nodeId: "node_1", name: "lab", state: "ready", templates: [] },
		],
	});
	assert.match(html, /3\. Prepare your first sandbox image/);
	assert.match(html, /Build on: lab/);
	assert.doesNotMatch(html, /<select id="build-node"/);
	assert.ok(
		html.indexOf('id="build-linux"') < html.indexOf("Other operating systems"),
	);
	assert.match(html, /id="windows-media" hidden/);
	assert.doesNotMatch(
		html,
		/New template recipe|empty slot|Not configured|S5 builder|For a rebuild/,
	);
	assert.match(
		html,
		/2 of 4 complete · Next: Prepare your first sandbox image/,
	);
	assert.match(html, /<summary>Technical details<\/summary>/);
	assert.match(html, /<summary>Use an existing template<\/summary>/);
});

function setupBrowser(respond) {
	const html = renderSetup({ steps: {} });
	const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].find(
		(match) => match[1].includes("function setupInteractions"),
	)[1];
	const elements = new Map();
	const element = (id) => {
		if (!elements.has(id))
			elements.set(id, {
				value: "",
				disabled: false,
				hidden: true,
				textContent: "",
				addEventListener(event, listener) {
					this[event] = listener;
				},
			});
		return elements.get(id);
	};
	const timers = [];
	let reloads = 0;
	runInNewContext(script, {
		document: { querySelector: element, querySelectorAll: () => [] },
		fetch: respond,
		setTimeout: (callback) => {
			timers.push(callback);
		},
		clearTimeout: () => {},
		location: {
			reload: () => {
				reloads++;
			},
		},
	});
	return { element, timers, reloads: () => reloads };
}

test("build polls current activity and elapsed time, blocks duplicates and advances after registration", async () => {
	const requests = [];
	let finish = false;
	const browser = setupBrowser(async (url, options) => {
		requests.push({ url, options });
		const job = {
			status: finish ? "ready" : "running",
			startedAt: new Date(Date.now() - 65000).toISOString(),
			log: "Downloading Linux",
		};
		return {
			ok: true,
			json: async () => (options?.method === "POST" ? job : { buildJob: job }),
		};
	});
	await browser.element("#build-linux").click();
	assert.equal(browser.element("#build-linux").disabled, true);
	assert.equal(browser.element("#build-template").disabled, true);
	assert.match(
		browser.element("#build-progress").textContent,
		/Downloading Linux · Elapsed: 1m/,
	);
	assert.equal(browser.element("#build-log").textContent, "Downloading Linux");
	await browser.element("#build-linux").click();
	assert.equal(
		requests.filter((request) => request.options?.method === "POST").length,
		1,
	);
	assert.equal(JSON.parse(requests[0].options.body).slug, "linux");
	finish = true;
	await browser.timers.shift()();
	assert.equal(browser.reloads(), 1);
});

test("failed build request shows an error at the build action and allows retry", async () => {
	const browser = setupBrowser(async () => ({
		ok: false,
		json: async () => ({ error: "Storage unavailable" }),
	}));
	await browser.element("#build-linux").click();
	assert.equal(
		browser.element("#build-error").textContent,
		"Storage unavailable",
	);
	assert.equal(browser.element("#build-linux").disabled, false);
	assert.equal(browser.element("#build-template").disabled, false);
});

test("Windows media fields only appear when Windows is selected", () => {
	const browser = setupBrowser(async () => {});
	browser.element("#build-slug").value = "windows";
	browser.element("#build-slug").change();
	assert.equal(browser.element("#windows-media").hidden, false);
	browser.element("#build-slug").value = "linux-desktop";
	browser.element("#build-slug").change();
	assert.equal(browser.element("#windows-media").hidden, true);
});

test("completed setup leads directly to browser sandbox creation and uses friendly invalidation copy", () => {
	const html = renderSetup({
		complete: true,
		steps: { templates: { status: "stale" } },
	});
	assert.match(html, /href="\/app\/sandboxes\/new">Create your first sandbox/);
	assert.match(html, /Needs checking after settings changed/);
	assert.doesNotMatch(html, />stale</);
});

test("several nodes: one Linux action builds on every node that lacks it", () => {
	const html = renderSetup({
		steps: { limits: { status: "ready" }, network: { status: "ready" } },
		sandboxNodes: [
			{ nodeId: "node_1", name: "pve", state: "active", templates: [] },
			{ nodeId: "node_2", name: "pve2", state: "active", templates: [] },
			{
				nodeId: "node_3",
				name: "pve3",
				state: "active",
				templates: [{ templateSlug: "linux", version: "1", pveVmid: 20000 }],
			},
		],
	});
	assert.match(html, /data-nodes="node_1,node_2"/);
	assert.match(html, /Build Linux template on all nodes \(pve, pve2\)/);
	assert.match(html, /per node; nodes are built one after another/);
	// The node selector belongs to the optional single-template build only.
	assert.ok(
		html.indexOf('<select id="build-node"') >
			html.indexOf("Other operating systems"),
	);
});
