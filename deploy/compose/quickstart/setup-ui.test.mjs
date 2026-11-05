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

test("setup offers nonredundant recipes and one Windows desktop with ISO URL inputs", () => {
	const html = renderSetup({ steps: {} }, "http://localhost");
	const select = html.match(/<select id="build-slug">(.*?)<\/select>/)[1];
	assert.equal((select.match(/<option /g) || []).length, 2);
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
		html.indexOf('id="build-linux"') < html.indexOf("Build another template"),
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

function setupBrowser(
	respond,
	{
		state = { steps: {} },
		storage = new Map(),
		nodes = "",
		ready = false,
	} = {},
) {
	const html = renderSetup(state);
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
	element("#build-linux").dataset = {
		nodes,
		jobStatus: state.buildJob?.status,
		jobNode: state.buildJob?.nodeId,
	};
	element("#build-linux").disabled = state.buildJob?.status === "running";
	element("#smoke-node").dataset = { ready: String(ready), name: "pve" };
	const timers = [];
	let reloads = 0;
	runInNewContext(script, {
		document: { querySelector: element, querySelectorAll: () => [] },
		sessionStorage: {
			getItem: (key) => storage.get(key),
			setItem: (key, value) => storage.set(key, value),
		},
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
			html.indexOf("Build another template"),
	);
});

const queueKey = "umiak-linux-build-queue";
test("one server build copies both nodes without scheduling a second build", async () => {
	const storage = new Map();
	let finish = false;
	const respond = async (_url, options) => ({
		ok: true,
		json: async () => {
			const job = {
				status: finish ? "ready" : "running",
				startedAt: new Date().toISOString(),
			};
			return options ? job : { buildJob: job };
		},
	});
	const first = setupBrowser(respond, {
		storage,
		nodes: "one,two",
		ready: true,
	});
	await first.element("#build-linux").click();
	assert.deepEqual(JSON.parse(storage.get(queueKey)).states, {
		one: "Building",
		two: "Waiting",
	});
	assert.equal(first.element("#step-templates").open, true);
	assert.equal(first.element("#smoke-submit").disabled, true);
	finish = true;
	await first.timers.shift()();
	assert.equal(first.reloads(), 1);
	assert.equal(JSON.parse(storage.get(queueKey)).states.one, "Ready");
	assert.deepEqual(JSON.parse(storage.get(queueKey)).states, {
		one: "Ready",
		two: "Ready",
	});
	assert.equal(JSON.parse(storage.get(queueKey)).active, false);
});

test("queue failure stops waiting nodes and keeps the error visible", async () => {
	const storage = new Map();
	const browser = setupBrowser(
		async (_url, options) => ({
			ok: true,
			json: async () => {
				const job = {
					status: options ? "running" : "error",
					error: "Build failed",
					startedAt: new Date().toISOString(),
				};
				return options ? job : { buildJob: job };
			},
		}),
		{ storage, nodes: "one,two", ready: true },
	);
	await browser.element("#build-linux").click();
	const plan = JSON.parse(storage.get(queueKey));
	assert.equal(plan.active, false);
	assert.deepEqual(plan.states, { one: "Failed", two: "Waiting" });
	assert.equal(browser.element("#build-error").textContent, "Build failed");
	assert.equal(browser.element("#smoke-submit").disabled, false);
});

test("hiding the queue does not cancel server-side template replication", async () => {
	const storage = new Map();
	let finish = false;
	const respond = async (_url, options) => ({
		ok: true,
		json: async () => {
			const job = {
				status: finish ? "ready" : "running",
				startedAt: new Date().toISOString(),
			};
			return options ? job : { buildJob: job };
		},
	});
	const browser = setupBrowser(respond, {
		storage,
		nodes: "one,two",
		ready: true,
	});
	await browser.element("#build-linux").click();
	browser.element("#stop-queue").click();
	assert.equal(browser.element("#smoke-submit").disabled, true);
	finish = true;
	await browser.timers.shift()();
	const plan = JSON.parse(storage.get(queueKey));
	assert.equal(plan.active, false);
	assert.deepEqual(plan.states, { one: "Ready", two: "Ready" });
	const reloaded = setupBrowser(respond, { storage, ready: true });
	assert.equal(reloaded.timers.length, 0);
	assert.equal(reloaded.element("#smoke-submit").disabled, false);
});

test("installation test requires a Linux template on the selected node", () => {
	const browser = setupBrowser(async () => {});
	assert.equal(browser.element("#smoke-submit").disabled, true);
	assert.match(
		browser.element("#smoke-reason").textContent,
		/Build a Linux template on pve first/,
	);
	browser.element("#smoke-node").dataset.ready = "true";
	browser.element("#smoke-node").change();
	assert.equal(browser.element("#smoke-submit").disabled, false);
	const html = renderSetup({
		sandboxNodes: [{ nodeId: "one", name: "pve", templates: [] }],
	});
	assert.match(html, /id="smoke-submit" disabled/);
	assert.match(html, /Test on: pve/);
	assert.match(html, /href="#step-templates"/);
	assert.match(html, /id="build-details" hidden/);
});

test("a failed build shows one line of error, not the whole tool output", () => {
	const noise = Array.from({ length: 300 }, (_, i) => `Get:${i} https://example/pkg ${i}`).join("\n");
	const html = renderSetup({
		steps: { limits: { status: "ready" }, network: { status: "ready" } },
		sandboxNodes: [{ nodeId: "node_1", name: "pve", state: "active", templates: [] }],
		buildJob: {
			id: "a".repeat(24),
			status: "error",
			startedAt: "2026-11-05T00:00:00Z",
			error: `${noise}\nError: UMIAK_GUEST_SUBNET must be an IPv4 network\n${noise}`,
			log: noise,
		},
	});
	const error = html.match(/<p id="build-error"[^>]*>([^<]*)<\/p>/)[1];
	assert.match(error, /^Error: UMIAK_GUEST_SUBNET must be an IPv4 network See the build log/);
	assert.ok(error.length < 400);
});
