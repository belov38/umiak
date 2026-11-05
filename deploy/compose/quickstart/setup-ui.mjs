import { VIRTIO_SHA256, VIRTIO_STABLE_URL } from "./setup-iso.mjs";
import { templateRange } from "./setup-vmids.mjs";
import { renderPage } from "./ui.mjs";

// Small owner dashboard pages; all dynamic text is escaped before rendering.
const escapeHtml = (value) =>
	String(value ?? "").replace(
		/[&<>"']/g,
		(ch) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				ch
			],
	);
// This helper runs in the browser; it falls back when the Clipboard API is unavailable.
async function copyText(text) {
	if (navigator.clipboard) {
		try {
			await navigator.clipboard.writeText(text);
			return;
		} catch {}
	}
	const input = document.createElement("textarea");
	input.value = text;
	input.style.position = "fixed";
	input.style.opacity = "0";
	document.body.append(input);
	try {
		input.select();
		if (!document.execCommand("copy")) throw new Error("Copy failed");
	} finally {
		input.remove();
	}
}
async function showCertificateStatus() {
	try {
		const response = await fetch("/quickstart/setup/certificates");
		if (!response.ok) return;
		const status = await response.json();
		if (!status || typeof status !== "object") return;
		const lines = [];
		for (const [key, label] of [
			["caExpiresAt", "Guest CA expires"],
			["tunnelExpiresAt", "Tunnel certificate expires"],
			["previewExpiresAt", "Preview certificate expires"],
		]) {
			if (typeof status[key] === "string")
				lines.push(`${label}: ${new Date(status[key]).toLocaleString()}`);
		}
		if (typeof status.warning === "string" && status.warning)
			document.querySelector("#certificate-warning").textContent =
				status.warning;
		document.querySelector("#certificate-status").textContent =
			lines.join(" · ");
	} catch {}
}
const block = (value) =>
	`<div class="copy"><pre>${escapeHtml(value)}</pre><button class="outline" type="button" onclick="copyText(this.previousElementSibling.textContent).catch(()=>{document.querySelector('#copy-status').textContent='Could not copy: select the text and copy it yourself.'})">Copy</button></div>`;
function page(title, content) {
	return renderPage(
		title,
		`<script>${copyText.toString()}</script>${content}<p id="copy-status" role="status"></p>`,
	);
}

export function renderHelp(origin) {
	return page(
		"Help",
		`<h1>Your Umiak developer guide</h1><p>Use this address for the dashboard, API, CLI and MCP: <strong>${escapeHtml(origin)}</strong>.</p>
<section><h2>Install the CLI</h2><p>Download the installer from your Umiak address.</p>${block(`curl -fsSL ${origin}/install.sh -o umiak-install.sh && sh ./umiak-install.sh`)}<p>The installer verifies SHA256SUMS and installs to <code>~/.local/bin</code>. Add that directory to PATH. Pair the CLI in your claimed owner browser.</p>${block(`umiak login --api-url ${origin}\numiak create --template linux --size 2gb\numiak exec <sandbox> -- echo hello\numiak rm <sandbox> --yes`)}</section>
<section><h2>MCP for Claude Code</h2><p>The stdio server uses your paired CLI profile. Only approve tools you intend your coding agent to use.</p>${block("claude mcp add umiak -- umiak mcp")}<h2>MCP for Codex</h2>${block("codex mcp add umiak -- umiak mcp")}<p>Remote Streamable HTTP endpoint: <code>${escapeHtml(origin)}/mcp</code>. Configure your client with a paired bearer credential. </p></section>
<section><h2>SDK</h2><p>Use a paired credential from your CLI profile. Keep credentials out of source control and agent prompts.</p>${block(`import { Umiak } from '@umiak/sdk';\nconst umiak = new Umiak({ baseUrl: '${origin}', accessToken: process.env.UMIAK_TOKEN });`)}${block(`from umiak_sdk import Umiak\nimport os\nclient = Umiak(base_url="${origin}", access_token=os.environ["UMIAK_TOKEN"])`)}</section>
<section><h2>Desktops and optional templates</h2><p>Linux is the default. Linux desktop and Windows 11 (with desktop) templates can be registered in Setup after building them. Supply your own licensed Windows ISO and the VirtIO ISO; existing templates are adopted without rebuilding. Open a desktop-capable sandbox in the dashboard and select Desktop. The embedded viewer needs a secure browser context for WebCodecs, which the tailnet HTTPS address provides.</p></section>
<section><h2>Troubleshooting</h2><ul><li><strong>Certificate error:</strong> check the guest gateway certificate. Verify any required CA through a trusted operator channel.</li><li><strong>Owner required:</strong> claim with the one-time link printed by the installer, or approve your CLI pairing from an existing owner session.</li><li><strong>PVE pin mismatch:</strong> inspect the fingerprint at the Proxmox console before updating it; do not blindly accept a changed pin.</li><li><strong>Node-agent SSH fails:</strong> check the restricted private key, pinned SSH host key and reachability from the control plane.</li><li><strong>Sandbox does not become ready:</strong> guests must reach the configured gateway on port 443 and trust the tunnel CA embedded in the template.</li><li><strong>Capacity exhausted:</strong> stop or delete your own sandboxes; the total RAM cap and VMID range are enforced.</li><li><strong>Tailnet address does not open:</strong> check that Tailscale is connected on this device and that MagicDNS and HTTPS certificates are enabled for your tailnet.</li></ul></section>`,
	);
}
const field = (name, label, value = "", type = "text") =>
	`<label>${label}<input name="${name}" type="${type}" value="${escapeHtml(value)}"></label>`;
// Serialized into the page so the server's CSP hashes cover the exact script.
function setupInteractions() {
	const $ = (selector) => document.querySelector(selector);
	let building = false;
	let polling = false;
	const value = (id) => $(id)?.value || "";
	const post = async (path, data) => {
		const response = await fetch(`/quickstart/setup/${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		const result = await response.json();
		if (!response.ok)
			throw new Error(result.error || "Request failed. Try again.");
		return result;
	};
	const disableBuilds = (disabled) => {
		building = disabled;
		$("#build-linux").disabled = disabled;
		$("#build-template").disabled = disabled;
	};
	const showJob = (job) => {
		if (!job) return;
		disableBuilds(job.status === "running");
		// Follow the end of the log unless the user scrolled up to read.
		const log = $("#build-log");
		const following =
			!log.scrollHeight ||
			log.scrollHeight - log.scrollTop - log.clientHeight < 40;
		log.textContent = job.log || "";
		if (following) log.scrollTop = log.scrollHeight;
		$("#build-details").hidden = !job.log;
		if (job.status === "running" && !$("#build-details").dataset?.seen) {
			$("#build-details").open = true;
			if ($("#build-details").dataset) $("#build-details").dataset.seen = "1";
		}
		if (job.status === "running") $("#step-templates").open = true;
		syncTest();
		$("#build-error").textContent = job.error || "";
		const elapsed = Math.max(
			0,
			Math.floor(
				((job.finishedAt ? Date.parse(job.finishedAt) : Date.now()) -
					Date.parse(job.startedAt)) /
					1000,
			),
		);
		const last = (job.log || "").trim().split("\n").at(-1) || "";
		const activity = last
			? last.length > 110
				? `${last.slice(0, 110)}…`
				: last
			: "Preparing the build";
		$("#build-progress").textContent =
			job.status === "running"
				? activity +
					" · Elapsed: " +
					Math.floor(elapsed / 60) +
					"m " +
					(elapsed % 60) +
					"s"
				: job.status === "ready"
					? "Template build complete."
					: "Build stopped. Check the error and build details.";
	};
	const pollBuild = async () => {
		if (polling) return;
		polling = true;
		try {
			const response = await fetch("/quickstart/setup/build");
			if (!response.ok)
				throw new Error("Could not check build progress. Retrying…");
			const result = await response.json();
			showJob(result.buildJob);
			if (["ready", "error"].includes(result.buildJob?.status))
				finishNode(result.buildJob);
			if (result.buildJob?.status === "ready") {
				// Registration has finished before the job becomes ready.
				location.reload();
				return;
			}
			if (result.buildJob?.status === "running") setTimeout(pollBuild, 2000);
		} catch (error) {
			$("#build-error").textContent = error.message;
			setTimeout(pollBuild, 3000);
		} finally {
			polling = false;
		}
	};
	// Keep the full requested queue across reloads, including completed nodes.
	const QUEUE = "umiak-linux-build-queue";
	let plan;
	try {
		const saved = sessionStorage.getItem(QUEUE);
		if (saved) {
			try {
				plan = JSON.parse(saved);
			} catch {
				plan = {
					nodes: saved.split(",").filter(Boolean),
					states: {},
					active: true,
				};
			}
			if (!Array.isArray(plan?.nodes) || !plan.states) plan = null;
		}
	} catch {}
	const saveQueue = () => {
		try {
			sessionStorage.setItem(QUEUE, JSON.stringify(plan));
		} catch {}
	};
	const syncTest = () => {
		const select = $("#smoke-node");
		const option = select?.selectedOptions?.[0];
		const ready = (option?.dataset?.ready || select?.dataset?.ready) === "true";
		const busy = !!plan?.active || building;
		const button = $("#smoke-submit");
		if (button) button.disabled = !ready || busy;
		const reason = $("#smoke-reason");
		if (reason)
			reason.textContent = busy
				? "Wait for the build queue to finish, or stop the queue."
				: ready
					? ""
					: "Build a Linux template on " +
						(option?.textContent ||
							select?.dataset?.name ||
							"the selected node") +
						" first.";
	};
	const showQueue = () => {
		if (!plan) {
			syncTest();
			return;
		}
		const current = plan.nodes.find((id) => plan.states[id] === "Building");
		const rows = document.querySelectorAll("[data-queue-node]");
		let name = current;
		for (const row of rows) {
			const id = row.dataset.queueNode;
			if (id === current) name = row.dataset.name;
			const state = row.querySelector("[data-node-build-state]");
			if (plan.states[id] && state) state.textContent = plan.states[id];
		}
		const progress = $("#queue-progress");
		if (progress)
			progress.textContent = plan.active
				? `Preparing node ${plan.nodes.indexOf(current) + 1} of ${plan.nodes.length}: ${name || "waiting"}`
				: "Build queue stopped or complete.";
		if (plan.active) {
			$("#step-templates").open = true;
			if ($("#step-smoke")) $("#step-smoke").open = false;
		}
		if ($("#linux-ready")) $("#linux-ready").hidden = plan.active;
		if ($("#stop-queue")) $("#stop-queue").hidden = !plan.active;
		syncTest();
	};
	const finishNode = (job) => {
		if (!plan) return;
		const id = plan.nodes.find((id) => plan.states[id] === "Building");
		if (id) plan.states[id] = job.status === "ready" ? "Ready" : "Failed";
		if (
			job.status !== "ready" ||
			plan.nodes.every((id) => plan.states[id] === "Ready")
		)
			plan.active = false;
		saveQueue();
		showQueue();
	};
	const build = async (slug, nodeId) => {
		if (building) return;
		disableBuilds(true);
		$("#build-error").textContent = "";
		$("#build-progress").textContent = "Starting template build…";
		try {
			const input = {
				slug,
				nodeId: nodeId || value("#build-node"),
				confirmRebuild: value("#build-confirm"),
			};
			if (slug === "windows") Object.assign(input, media());
			const job = await post("build", input);
			showJob(job);
			await pollBuild();
		} catch (error) {
			$("#build-error").textContent = error.message;
			finishNode({ status: "failed" });
			disableBuilds(false);
			syncTest();
		}
	};
	const buildLinux = () => {
		if (building) return;
		const nodes = ($("#build-linux").dataset?.nodes || "")
			.split(",")
			.filter(Boolean);
		plan = {
			nodes,
			states: Object.fromEntries(nodes.map((id) => [id, "Waiting"])),
			active: nodes.length > 0,
		};
		const first = nodes[0];
		if (first) plan.states[first] = "Building";
		saveQueue();
		showQueue();
		return build("linux", first);
	};
	$("#stop-queue")?.addEventListener("click", () => {
		if (plan) {
			plan.active = false;
			saveQueue();
			showQueue();
		}
	});
	$("#smoke-node")?.addEventListener("change", syncTest);
	const media = () => ({
		iso: value("#build-iso"),
		isoUrl: value("#build-iso-url"),
		isoSha256: value("#build-iso-sha"),
		mediaStorage: value("#build-media-storage"),
		virtioUrl: value("#build-virtio-url"),
		virtioSha256: value("#build-virtio-sha"),
		allowInternalIsoUrls: $("#build-internal-urls").checked,
	});
	$("#build-linux").addEventListener("click", buildLinux);
	$("#build-template").addEventListener("click", () =>
		build(value("#build-slug")),
	);
	$("#build-slug").addEventListener("change", () => {
		$("#windows-media").hidden = value("#build-slug") !== "windows";
	});
	$("#validate-media").addEventListener("click", async () => {
		const button = $("#validate-media");
		button.disabled = true;
		try {
			$("#media-result").textContent = (
				await post("media/validate", media())
			).message;
		} catch (error) {
			$("#media-result").textContent = error.message;
		} finally {
			button.disabled = false;
		}
	});
	$("#back-to-build")?.addEventListener("click", () => {
		$("#step-templates").open = true;
	});
	$("#continue-test")?.addEventListener("click", () => {
		$("#step-smoke").open = true;
	});
	for (const form of document.querySelectorAll("form[data-step]")) {
		form.addEventListener("submit", async (event) => {
			event.preventDefault();
			const button = form.querySelector('button[type="submit"]');
			const result = form.querySelector("[data-result]");
			button.disabled = true;
			result.textContent =
				form.dataset.step === "smoke"
					? "Running installation test. This can take several minutes…"
					: "Checking…";
			const data = Object.fromEntries(new FormData(form));
			for (const key of [
				"vmidMin",
				"vmidMax",
				"templateVmidMin",
				"templateVmidMax",
				"ramCapMb",
			])
				if (key in data) data[key] = Number(data[key]);
			if (form.dataset.step === "templates")
				data.builds = Array.from(
					form.querySelectorAll('input[name="template"]:checked'),
				).map((input) => ({
					templateSlug: input.dataset.slug,
					nodeId: input.dataset.nodeId,
					pveVmid: Number(input.value),
				}));
			let testing = form.dataset.step === "smoke";
			let timer;
			const pollTest = async () => {
				try {
					const response = await fetch("/quickstart/setup/state");
					if (response.ok) {
						const state = await response.json();
						if (testing && state.smokeProgress)
							result.textContent = `${state.smokeProgress}…`;
					}
				} catch {}
				if (testing) timer = setTimeout(pollTest, 1500);
			};
			if (testing) timer = setTimeout(pollTest, 1500);
			try {
				await post(form.dataset.step, data);
				location.reload();
			} catch (error) {
				result.textContent = error.message;
				result.className = "error";
			} finally {
				testing = false;
				clearTimeout(timer);
				button.disabled = false;
				if (form.dataset.step === "smoke") syncTest();
			}
		});
	}
	building = $("#build-linux").disabled;
	const previousStatus = $("#build-linux").dataset?.jobStatus;
	const previousNode = $("#build-linux").dataset?.jobNode;
	if (
		plan?.active &&
		plan.states[previousNode] === "Building" &&
		["ready", "error"].includes(previousStatus)
	)
		finishNode({ status: previousStatus });
	showQueue();
	// Resume the active job or the first waiting node after registration reloads.
	if ($("#build-linux").disabled) void pollBuild();
	else if (plan?.active) {
		const next = plan.nodes.find((id) => plan.states[id] !== "Ready");
		if (next) {
			plan.states[next] = "Building";
			saveQueue();
			showQueue();
			void build("linux", next);
		} else {
			plan.active = false;
			saveQueue();
			showQueue();
		}
	}
}

export function renderSetup(state) {
	const steps = state.steps || {};
	const limits = { ...templateRange(state), ...steps.limits?.data };
	const network = steps.network?.data || {};
	const nodes = state.sandboxNodes || [];
	const needLinux = nodes.filter(
		(n) => !(n.templates || []).some((t) => t.templateSlug === "linux"),
	);
	const nodeSelect = (id) =>
		nodes.length === 1
			? `<p>${id === "smoke-node" ? "Test on:" : "Build on:"} ${escapeHtml(nodes[0].name)}</p><input type="hidden" id="${id}" data-ready="${(nodes[0].templates || []).some((t) => t.templateSlug === "linux")}" data-name="${escapeHtml(nodes[0].name)}" name="nodeId" value="${escapeHtml(nodes[0].nodeId)}">`
			: `<label>${id === "smoke-node" ? "Test node" : "Sandbox node"}<select id="${id}" name="nodeId">${nodes.map((n) => `<option data-ready="${(n.templates || []).some((t) => t.templateSlug === "linux")}" value="${escapeHtml(n.nodeId)}">${escapeHtml(n.name)}</option>`).join("")}</select></label>`;
	const status = (name) => {
		const step = steps[name];
		if (step?.status === "stale")
			return '<p class="pending">Needs checking after settings changed</p>';
		if (step?.error)
			return `<p class="error" role="alert">${escapeHtml(step.error)}</p>`;
		return "";
	};
	const order = ["limits", "network", "templates", "smoke"];
	const titles = [
		"Storage and capacity",
		"Sandbox networking",
		"Prepare your first sandbox image",
		"Test your installation",
	];
	const current = order.find((name) => steps[name]?.status !== "ready");
	const verified = order.filter(
		(name) => steps[name]?.status === "ready",
	).length;
	const section = (name, summary, body) =>
		`<details name="setup-step" id="step-${name}"${!state.complete && ((name === "templates" && state.buildJob?.status === "running") || (name === current && state.buildJob?.status !== "running")) ? " open" : ""}><summary>${steps[name]?.status === "ready" ? "✓ " : ""}${summary}</summary>${body}</details>`;
	const form = (name, fields, button = "Verify and save") =>
		`<form data-step="${name}">${fields}<button type="submit"${name === "smoke" ? ` id="smoke-submit"${!(nodes[0]?.templates || []).some((t) => t.templateSlug === "linux") || state.buildJob?.status === "running" ? " disabled" : ""}` : ""}>${button}</button><div data-result role="status">${status(name)}</div></form>`;
	const linuxReady = steps.templates?.status === "ready";
	const running = state.buildJob?.status === "running";
	const hasTemplates =
		(steps.templates?.data?.builds || []).length > 0 ||
		nodes.some((n) => n.templates?.length);
	const buildProgress = `<p id="build-progress" role="status" aria-live="polite"></p><p id="build-error" class="error" role="alert">${escapeHtml(state.buildJob?.error || "")}</p><details id="build-details"${state.buildJob?.log ? "" : " hidden"}${state.buildJob?.status === "running" ? " open" : ""}><summary>Build log</summary><pre id="build-log" class="log" tabindex="0" aria-label="Build log, newest lines at the bottom">${escapeHtml(state.buildJob?.log || "")}</pre><p><a href="/quickstart/setup/build/log" target="_blank" rel="noopener">Open the full log in a new tab</a></p></details>`;
	const continueLink =
		'<p><a href="#step-smoke" id="continue-test">Continue to installation test</a></p>';
	return page(
		"Setup",
		`<h1>Finish setting up Umiak</h1>
<p>${state.complete ? "Setup complete. Create a sandbox, then open Terminal to run your first command." : steps.limits?.status === "ready" && steps.network?.status === "ready" ? "Storage and networking are ready. Next, build a Linux template and test that sandboxes work." : "Prepare storage and networking, then build a Linux template and test that sandboxes work."}</p>
${state.bootstrapError ? `<p class="error" role="alert">Installer data could not be imported: ${escapeHtml(state.bootstrapError.message)}</p>` : ["connection", "host"].every((name) => steps[name]?.status === "ready") ? "" : '<p class="error">The installer has not finished setting up this deployment. Re-run the installer on your Proxmox node.</p>'}
<p>${verified} of 4 complete · ${current ? `Next: ${titles[order.indexOf(current)]}` : "Setup complete"}</p>
<div class="progress" role="progressbar" aria-label="Setup progress" aria-valuemin="0" aria-valuemax="4" aria-valuenow="${verified}"><span style="width:${(verified / 4) * 100}%"></span></div>
${linuxReady && needLinux.length === 0 && !running && !state.complete ? `<div id="linux-ready"><p class="ready">Linux template ready. Next, test your installation.</p>${continueLink}</div>` : ""}
${state.complete ? '<section><h2>You are ready</h2><p><a class="primary-action" href="/app/sandboxes/new">Create your first sandbox</a></p></section>' : ""}
${section("limits", `1. Storage: ${escapeHtml(limits.storage || "local-lvm")} · Sandbox memory limit: ${Number(limits.ramCapMb || 8192) / 1024} GiB`, form("limits", `<details><summary>Advanced settings</summary>${field("storage", "LVM-thin storage", limits.storage || "local-lvm") + field("vmidMin", "First sandbox VMID", limits.vmidMin || 500, "number") + field("vmidMax", "Last sandbox VMID", limits.vmidMax || 589, "number") + field("templateVmidMin", "First template VMID (separate from sandboxes)", limits.templateVmidMin, "number") + field("templateVmidMax", "Last template VMID", limits.templateVmidMax, "number")}<p>New builds allocate a free VMID in this range. Existing adopted templates keep their VMIDs: ${escapeHtml((steps.templates?.data?.builds || []).map((build) => build.pveVmid).join(", ") || "none")}. Occupied IDs are skipped; no existing VM is replaced.</p>${field("ramCapMb", "Total sandbox RAM cap (MiB)", limits.ramCapMb || 8192, "number")}</details>`))}
${section("network", steps.network?.status === "ready" ? "2. Sandbox networking configured" : "2. Sandbox networking", form("network", `<details><summary>Advanced settings</summary>${field("gatewayAddress", "Gateway address reachable from guests", network.gatewayAddress) + field("tunnelUrl", "Guest tunnel URL (wss://gateway/v1/connect)", network.tunnelUrl) + field("previewDomain", "Preview domain (defaults to IP-derived sslip.io)", network.previewDomain) + field("guestDns", "Guest DNS resolver", network.guestDns || "1.1.1.1")}<p>Keep the gateway certificate and CA trusted by your existing templates. The default preview and tunnel names use external sslip.io DNS. Use your own wildcard DNS domain to replace it. Guests default to the external DNS resolver 1.1.1.1; choose another resolver during fresh preparation if needed. Saving here does not change an existing PVE DHCP configuration.</p></details>`))}
${section(
	"templates",
	"3. Prepare your first sandbox image",
	`
${status("templates")}
<p>A template is the reusable VM image your sandboxes start from. Build the Linux template to continue. Desktop and Windows templates can be added later.</p>
<button type="button" id="build-linux" data-job-status="${escapeHtml(state.buildJob?.status || "")}" data-job-node="${escapeHtml(state.buildJob?.nodeId || "")}" data-nodes="${escapeHtml(needLinux.map((n) => n.nodeId).join(","))}"${running ? " disabled" : ""}>${needLinux.length > 1 ? `Build Linux template on all nodes (${escapeHtml(needLinux.map((n) => n.name).join(", "))})` : needLinux.length === 1 && nodes.length > 1 ? `Build Linux template on ${escapeHtml(needLinux[0].name)}` : "Build Linux template"}</button>
<ul aria-label="Sandbox node template availability">${nodes.map((n) => `<li data-queue-node="${escapeHtml(n.nodeId)}" data-name="${escapeHtml(n.name)}">${escapeHtml(n.name)} · Node ${n.state === "active" || n.state === "ready" ? "online" : escapeHtml(n.state)} · Template ${(n.templates || []).some((t) => t.templateSlug === "linux") ? "ready" : "missing"} · <span data-node-build-state>${state.buildJob?.nodeId === n.nodeId && running ? "Building" : (n.templates || []).some((t) => t.templateSlug === "linux") ? "Ready" : "Waiting"}</span></li>`).join("")}</ul>
<p id="queue-progress" role="status"></p><button type="button" id="stop-queue" class="outline" hidden>Stop queue after current build</button>
<p>Allow about 10 minutes${needLinux.length > 1 ? " per node; nodes are built one after another. Keep this tab open" : ""}; download speed and hardware affect the time.</p>
${buildProgress}
${nodes.some((n) => n.templates?.length || n.buildJobId) ? `<details><summary>Node details</summary>${nodes.map((n) => `<p>${escapeHtml(n.name)} · ${escapeHtml((n.templates || []).map((t) => `${t.templateSlug} · ${t.version} · VM ${t.pveVmid}`).join(", "))}${n.buildJobId ? ` · Unfinished reservation: <code>${escapeHtml(n.buildJobId)}</code>` : ""}</p>`).join("")}</details>` : ""}

<details><summary>Build another template</summary>
${nodeSelect("build-node")}
<label>Operating system<select id="build-slug">${hasTemplates ? '<option value="linux">Linux</option>' : ""}<option value="linux-desktop">Linux desktop</option><option value="windows">Windows 11 (with desktop)</option></select></label>
<div id="windows-media" hidden><label>Uploaded Windows ISO file name<input id="build-iso" placeholder="Windows.iso"></label><label>Or Windows ISO HTTPS URL<input id="build-iso-url" type="url" placeholder="https://…/Windows.iso"></label><label>Windows ISO SHA256 (optional)<input id="build-iso-sha" pattern="[a-fA-F0-9]{64}"></label><label>ISO storage (blank selects first with iso content)<input id="build-media-storage"></label><label>VirtIO ISO URL<input id="build-virtio-url" type="url" value="${VIRTIO_STABLE_URL}"></label><label>VirtIO SHA256 (optional; pinned archive checksum)<input id="build-virtio-sha" value="${VIRTIO_SHA256}" pattern="[a-fA-F0-9]{64}"></label><label><input id="build-internal-urls" type="checkbox">I explicitly allow internal or loopback ISO URLs</label><p>Not verified: the ISO will be used as downloaded when SHA256 is omitted.</p><p>Umiak never ships or hosts Windows media. Supply your own licensed Windows ISO URL. Obtain its SHA256 from your Microsoft download portal. For VirtIO, download the official ISO to your workstation and run <code>sha256sum virtio-win.iso</code>; the Fedora CHECKSUM currently lists RPM MD5s, not the ISO SHA256. Changing the versioned ISO requires a new confirmed SHA256.</p><button class="outline" type="button" id="validate-media">Validate ISO inputs only</button><p id="media-result" role="status"></p></div>
<button type="button" id="build-template"${running ? " disabled" : ""}>Build selected template</button></details>
${hasTemplates ? '<details><summary>Rebuild a template</summary><p>Choose the operating system above. A new image will be built; existing templates are kept.</p><label>Confirm the operating system name<input id="build-confirm" placeholder="linux, linux-desktop or windows"></label></details>' : ""}
<details><summary>Use an existing template</summary>${form("templates", `<fieldset><legend>Detected templates</legend>${state.templateDetectionError ? `<p class="error">${escapeHtml(state.templateDetectionError)}</p>` : ""}${(state.detectedTemplates || []).map((build) => `<label><input type="checkbox" name="template" value="${build.pveVmid}" data-node-id="${escapeHtml(build.nodeId || "")}" data-slug="${escapeHtml(build.templateSlug)}" ${(steps.templates?.data?.builds || []).some((saved) => saved.pveVmid === build.pveVmid) ? "checked" : ""}>${escapeHtml(build.name || build.templateSlug)} · ${escapeHtml(build.node || "")} · VM ${build.pveVmid} · ${escapeHtml(build.templateSlug)}</label>`).join("") || '<p class="pending">No existing templates detected. Build a Linux template above.</p>'}</fieldset>`)}</details>`,
)}
${section("smoke", "4. Test your installation", `${steps.smoke?.status === "ready" ? '<p class="ready">Sandbox creation and command execution passed. The temporary VM was deleted.</p>' : ""}${form("smoke", `${nodeSelect("smoke-node")}<p id="smoke-reason" role="status">${!(nodes[0]?.templates || []).some((t) => t.templateSlug === "linux") ? `Build a Linux template on ${escapeHtml(nodes[0]?.name || "the selected node")} first.` : ""}</p><p><a href="#step-templates" id="back-to-build">Go to step 3 to build a Linux template</a></p><p>Creates a temporary Linux VM using 2 GiB RAM, runs a command, then deletes it.</p>`, "Run installation test")}`)}
<p id="certificate-warning" class="error" role="status"></p>
<details><summary>Technical details</summary><p id="certificate-status"></p></details>
<p><a href="/app/getting-started">CLI, agent connections and help</a></p>
<script>${showCertificateStatus.toString()};void showCertificateStatus();</script>
<script>${setupInteractions.toString()};setupInteractions();</script>`,
	);
}
