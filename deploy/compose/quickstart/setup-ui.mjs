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
	// A failed build's error can carry the whole tool output: show one line, keep the rest in the log.
	const briefError = (text) => {
		const lines = String(text || "")
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		if (!lines.length) return "";
		const line =
			[...lines].reverse().find((l) => /error|failed|must/i.test(l)) ||
			lines[0];
		return (
			(line.length > 300 ? `${line.slice(0, 300)}…` : line) +
			(lines.length > 1 ? " See the build log for details." : "")
		);
	};
	const $ = (selector) => document.querySelector(selector);
	for (const time of document.querySelectorAll("[data-local-time]"))
		if (time.dateTime)
			time.textContent = `at ${new Date(time.dateTime).toLocaleTimeString()}`;
	let building = false;
	let polling = false;
	// A failure already rendered on page load is shown; reveal only new ones.
	let revealedFailure =
		$("#build-linux")?.dataset.jobStatus === "error"
			? $("#build-linux").dataset.jobId
			: undefined;
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
		for (const button of document.querySelectorAll("[data-vendor-rebuild]"))
			button.disabled = disabled;
	};
	const showJob = (job) => {
		if (!job) return;
		disableBuilds(job.status === "running" || !!plan?.active);
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
		syncTest();
		$("#build-error").textContent = job.error
			? job.replication?.phase === "failed"
				? briefError(job.error)
				: `Last build failed at ${new Date(job.finishedAt || job.startedAt).toLocaleTimeString()} on ${[...document.querySelectorAll("[data-queue-node]")].find((r) => r.dataset.queueNode === job.nodeId)?.dataset.name || job.nodeId}: ${briefError(job.error)}`
			: "";
		const elapsed = Math.max(
			0,
			Math.floor(
				job.replication?.phase === "copying" &&
					job.replication.elapsedSeconds !== undefined
					? job.replication.elapsedSeconds
					: ((job.finishedAt ? Date.parse(job.finishedAt) : Date.now()) -
							Date.parse(job.startedAt)) /
							1000,
			),
		);

		const last =
			(job.log || "").trim().split("\n").at(-1) || "Preparing the build";
		const clipped = last.length > 110 ? `${last.slice(0, 110)}…` : last;
		const r = job.replication;
		const nodeRow = [...document.querySelectorAll("[data-queue-node]")].find(
			(row) => row.dataset.queueNode === job.nodeId,
		);
		const activity =
			r?.phase === "copying"
				? `Copying to ${r.node} · ${Math.floor((r.processedBytes || r.verifiedBytes || 0) / 1048576)} / ${Math.ceil((r.totalBytes || 0) / 1048576)} MiB`
				: `Building on ${nodeRow?.dataset.name || job.nodeId || "selected node"} · ${clipped}`;

		$("#build-progress").textContent =
			job.status === "running" || plan?.active
				? activity +
					" · Elapsed: " +
					Math.floor(elapsed / 60) +
					"m " +
					(elapsed % 60) +
					"s"
				: job.status === "ready"
					? "Template build complete."
					: r?.phase === "failed"
						? `Template ready on the source. Copy to ${r.node} failed; clean up and retry.`
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
			plan = result.buildQueue;
			showJob(result.buildJob);
			showQueue();
			// Reveal recovery once per failed job: re-opening the exclusive
			// accordion on every poll would keep closing the step the user opened.
			if (
				result.buildJob?.status === "error" &&
				!plan?.active &&
				$("#build-recoveries") &&
				revealedFailure !== result.buildJob.id
			) {
				revealedFailure = result.buildJob.id;
				$("#step-templates").open = true;
				try {
					const html = await (await fetch("/setup")).text();
					const fresh = new DOMParser()
						.parseFromString(html, "text/html")
						.querySelector("#build-recoveries");
					if (fresh && $("#build-recoveries"))
						$("#build-recoveries").innerHTML = fresh.innerHTML;
				} catch {}
			}
			if (
				result.buildJob?.status === "ready" &&
				!plan?.active &&
				($("#build-linux").dataset.jobStatus !== "ready" ||
					$("#build-linux").dataset.jobId !== result.buildJob.id)
			) {
				// Registration has finished before the job becomes ready.
				location.reload();
				return;
			}
			setTimeout(pollBuild, 2000);
		} catch (error) {
			$("#build-error").textContent = error.message;
			setTimeout(pollBuild, 3000);
		} finally {
			polling = false;
		}
	};
	let plan;
	const syncTest = () => {
		const select = $("#smoke-node");
		const option = select?.selectedOptions?.[0];
		const ready = (option?.dataset?.ready || select?.dataset?.ready) === "true";
		const busy = !!plan?.active || building;
		const button = $("#smoke-submit");
		if (button) button.disabled = !ready || busy;
		// Point back to step 3 only while the selected node still lacks the template.
		const back = $("#back-to-build-row");
		if (back) back.hidden = ready;
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
		const current = plan.nodes.find((id) =>
			["Building", "Copying"].includes(plan.states[id]),
		);
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
				: plan.message || "Build queue stopped or complete.";
		if (plan.active) {
			disableBuilds(true);
			$("#step-templates").open = true;
			if ($("#step-smoke")) $("#step-smoke").open = false;
		}
		if ($("#linux-ready")) $("#linux-ready").hidden = plan.active;
		if ($("#stop-queue")) $("#stop-queue").hidden = !plan.active;
		syncTest();
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
				buildMode:
					slug === "windows" ? "local" : value("#build-mode") || "download",
			};
			if (slug === "windows") Object.assign(input, media());
			const job = await post("build", input);
			showJob(job);
			await pollBuild();
		} catch (error) {
			$("#build-error").textContent = error.message;
			disableBuilds(false);
			syncTest();
		}
	};
	const buildLinux = async () => {
		if (building || plan?.active) return;
		disableBuilds(true);
		$("#build-error").textContent = "";
		try {
			plan = await post("build", {
				slug: "linux",
				buildMode: "download",
				nodes: ($("#build-linux").dataset.nodes || "")
					.split(",")
					.filter(Boolean),
			});
			showQueue();
			await pollBuild();
		} catch (error) {
			$("#build-error").textContent = briefError(error.message);
			disableBuilds(false);
		}
	};
	$("#stop-queue")?.addEventListener("click", async () => {
		try {
			await post("build/stop", {});
			await pollBuild();
		} catch (error) {
			$("#build-error").textContent = briefError(error.message);
		}
	});
	document.addEventListener("click", async (event) => {
		const button = event.target.closest?.("[data-recover-build]");
		if (!button) return;
		const error = button.parentElement.querySelector("[data-recovery-error]");
		button.disabled = true;
		error.textContent = "";
		try {
			const input = {
				nodeId: button.dataset.nodeId,
				jobId: button.dataset.recoverBuild,
			};
			const info = await post("build/recover", { ...input, inspect: true });
			const remains = [
				...info.vms.map((v) => `VM ${v.vmid}`),
				...info.disks.map((d) => d.name),
			];
			if (
				remains.length &&
				!confirm(
					`Remove this build's Umiak resources: ${remains.join(", ")}? Other resources will be kept.`,
				)
			)
				return;
			await post("build/recover", {
				...input,
				confirmRemove: remains.length > 0,
				retry: true,
			});
			location.reload();
		} catch (e) {
			error.textContent = briefError(e.message);
		} finally {
			button.disabled = false;
		}
	});
	for (const button of document.querySelectorAll("[data-vendor-rebuild]")) {
		button.addEventListener("click", async () => {
			if (building || plan?.active) return;
			disableBuilds(true);
			try {
				const slug = button.dataset.vendorRebuild;
				const job = await post("build", {
					slug,
					nodeId: button.dataset.nodeId,
					confirmRebuild: slug,
					buildMode: "download",
					vendorRetry: true,
				});
				showJob(job);
				await pollBuild();
			} catch (error) {
				$("#build-error").textContent = error.message;
				disableBuilds(false);
			}
		});
	}
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
		$("#linux-source").hidden = value("#build-slug") === "windows";
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
	syncTest();
	setTimeout(pollBuild, 0);
}

function briefBuildError(text) {
	const lines = String(text || "")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (!lines.length) return "";
	const line =
		[...lines].reverse().find((l) => /error|failed|must/i.test(l)) || lines[0];
	return (
		(line.length > 300 ? `${line.slice(0, 300)}…` : line) +
		(lines.length > 1 ? " See the build log for details." : "")
	);
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
		`<details name="setup-step" id="step-${name}"${(name === "templates" && (state.buildQueue?.active || ["running", "error"].includes(state.buildJob?.status))) || (!state.complete && name === current && state.buildJob?.status !== "running") ? " open" : ""}><summary>${steps[name]?.status === "ready" ? "✓ " : ""}${summary}</summary>${body}</details>`;
	const form = (name, fields, button = "Verify and save") =>
		`<form data-step="${name}">${fields}<button type="submit"${name === "smoke" ? ` id="smoke-submit"${!(nodes[0]?.templates || []).some((t) => t.templateSlug === "linux") || state.buildJob?.status === "running" ? " disabled" : ""}` : ""}>${button}</button><div data-result role="status">${status(name)}</div></form>`;
	// Storage and VMID ranges are installer facts mirrored in every node-agent
	// config; only the installer node's RAM limit is editable here.
	const gib = (mb) => `${Number(mb || 8192) / 1024} GiB`;
	const installerNode = state.steps?.connection?.data?.node || "";
	const installed = Boolean(steps.limits?.data?.nodeId && limits.storage);
	const limitNodes = nodes.length
		? nodes
		: installed
			? [
					{
						name: installerNode,
						storage: limits.storage,
						ramCapMb: limits.ramCapMb,
					},
				]
			: [];
	const limitsSummary = installed
		? `1. Storage and capacity: ${limitNodes.map((n) => `${escapeHtml(n.name)} on ${escapeHtml(n.storage)}, ${gib(n.ramCapMb)}`).join(" · ")}`
		: `1. Storage: ${escapeHtml(limits.storage || "local-lvm")} · Sandbox memory limit: ${gib(limits.ramCapMb)}`;
	const vmidRange = (a, b) => `${escapeHtml(a)}–${escapeHtml(b)}`;
	const limitsBody = installed
		? `<style>#step-limits code{overflow-wrap:anywhere}#node-limits{border-collapse:collapse;margin:0 0 1rem}#node-limits th,#node-limits td{text-align:left;padding:.25rem 1rem .25rem 0}</style><table id="node-limits"><thead><tr><th>Node</th><th>LVM-thin storage</th><th>Sandbox RAM limit</th></tr></thead><tbody>${limitNodes.map((n) => `<tr><td>${escapeHtml(n.name)}</td><td>${escapeHtml(n.storage)}</td><td>${gib(n.ramCapMb)}</td></tr>`).join("")}</tbody></table>
<p>Each node keeps its sandboxes and templates on its own LVM-thin storage, chosen when the node was added. VMIDs are cluster-wide: sandboxes ${vmidRange(limits.vmidMin, limits.vmidMax)}, templates ${vmidRange(limits.templateVmidMin, limits.templateVmidMax)} on every node. Existing templates: ${escapeHtml((steps.templates?.data?.builds || []).map((build) => build.pveVmid).join(", ") || "none")}.</p>
<p>To change another node's RAM limit, run on a Proxmox node: <code>curl -fsSL https://raw.githubusercontent.com/belov38/umiak/main/install.sh | sh -s -- --action nodes --node NAME --node-action add --ram-cap-mb 8192</code>. Storage and VMID ranges are set by the installer.</p>
${form("limits", `<input type="hidden" name="storage" value="${escapeHtml(limits.storage)}"><input type="hidden" name="vmidMin" value="${escapeHtml(limits.vmidMin)}"><input type="hidden" name="vmidMax" value="${escapeHtml(limits.vmidMax)}"><input type="hidden" name="templateVmidMin" value="${escapeHtml(limits.templateVmidMin)}"><input type="hidden" name="templateVmidMax" value="${escapeHtml(limits.templateVmidMax)}">${field("ramCapMb", `Sandbox RAM limit on ${escapeHtml(installerNode)} (MiB)`, limits.ramCapMb || 8192, "number")}`, "Save RAM limit")}`
		: form(
				"limits",
				`<details><summary>Advanced settings</summary>${field("storage", "LVM-thin storage", limits.storage || "local-lvm") + field("vmidMin", "First sandbox VMID", limits.vmidMin || 500, "number") + field("vmidMax", "Last sandbox VMID", limits.vmidMax || 589, "number") + field("templateVmidMin", "First template VMID (separate from sandboxes)", limits.templateVmidMin, "number") + field("templateVmidMax", "Last template VMID", limits.templateVmidMax, "number")}<p>New builds allocate a free VMID in this range. Existing adopted templates keep their VMIDs: ${escapeHtml((steps.templates?.data?.builds || []).map((build) => build.pveVmid).join(", ") || "none")}. Occupied IDs are skipped; no existing VM is replaced.</p>${field("ramCapMb", "Total sandbox RAM cap (MiB)", limits.ramCapMb || 8192, "number")}</details>`,
			);
	const linuxReady = steps.templates?.status === "ready";
	const running =
		state.buildJob?.status === "running" || Boolean(state.buildQueue?.active);
	const hasTemplates =
		(steps.templates?.data?.builds || []).length > 0 ||
		nodes.some((n) => n.templates?.length);
	const vendorWarnings = (steps.templates?.data?.builds || [])
		.filter((build) => build.offlineLayer)
		.flatMap((build) =>
			(build.vendorTools || [])
				.filter((tool) => tool.status === "failed")
				.map(
					(tool) =>
						`<aside role="status"><p>${escapeHtml(tool.warning)}</p><button type="button" data-vendor-rebuild="${escapeHtml(build.templateSlug)}" data-node-id="${escapeHtml(build.nodeId)}"${running ? " disabled" : ""}>Install ${escapeHtml(tool.name || "Claude Code")} (rebuilds the template)</button><p>The rebuild reuses the downloaded layer, takes a few minutes, and existing sandboxes are not affected.</p></aside>`,
				),
		)
		.join("");
	const buildProgress = `<p id="build-progress" role="status" aria-live="polite"></p><p id="build-error" class="error" role="alert">${escapeHtml(briefBuildError(state.buildJob?.error))}</p><details id="build-details"${state.buildJob?.log ? "" : " hidden"}${state.buildJob?.status === "running" ? " open" : ""}><summary>Build log</summary><pre id="build-log" class="log" tabindex="0" aria-label="Build log, newest lines at the bottom">${escapeHtml(state.buildJob?.log || "")}</pre><p><a href="/quickstart/setup/build/log" target="_blank" rel="noopener">Open the full log in a new tab</a></p></details>`;
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
${section("limits", limitsSummary, limitsBody)}
${section("network", steps.network?.status === "ready" ? "2. Sandbox networking configured" : "2. Sandbox networking", form("network", `<details><summary>Advanced settings</summary>${field("gatewayAddress", "Gateway address reachable from guests", network.gatewayAddress) + field("tunnelUrl", "Guest tunnel URL (wss://gateway/v1/connect)", network.tunnelUrl) + field("previewDomain", "Preview domain (defaults to IP-derived sslip.io)", network.previewDomain) + field("guestDns", "Guest DNS resolver", network.guestDns || "1.1.1.1")}<p>Keep the gateway certificate and CA trusted by your existing templates. The default preview and tunnel names use external sslip.io DNS. Use your own wildcard DNS domain to replace it. Guests default to the external DNS resolver 1.1.1.1; choose another resolver during fresh preparation if needed. Saving here does not change an existing PVE DHCP configuration.</p></details>`))}
${section(
	"templates",
	"3. Prepare your first sandbox image",
	`
<style>#step-templates p,#step-templates li,#step-templates code{overflow-wrap:anywhere}</style>${status("templates")}
<p>A template is the reusable VM image your sandboxes start from. Download the Linux template to continue. It uses the official Ubuntu base and a signed offline layer, customized locally without package archive access. Desktop and Windows templates can be added later.</p>
<button type="button" id="build-linux" data-job-id="${escapeHtml(state.buildJob?.id || "")}" data-job-status="${escapeHtml(state.buildJob?.status || "")}" data-job-node="${escapeHtml(state.buildJob?.nodeId || "")}" data-nodes="${escapeHtml(needLinux.map((n) => n.nodeId).join(","))}"${running ? " disabled" : ""}${linuxReady && needLinux.length === 0 && !running ? " hidden" : ""}>${needLinux.length > 1 ? `Download Linux template for all nodes (${escapeHtml(needLinux.map((n) => n.name).join(", "))})` : needLinux.length === 1 && nodes.length > 1 ? `Download the Linux template on ${escapeHtml(needLinux[0].name)}` : "Download the Linux template"}</button>
<ul aria-label="Sandbox node template availability">${nodes.map((n) => `<li data-queue-node="${escapeHtml(n.nodeId)}" data-name="${escapeHtml(n.name)}">${escapeHtml(n.name)} · Node ${n.state === "active" || n.state === "ready" ? "online" : escapeHtml(n.state)} · Template ${(n.templates || []).some((t) => t.templateSlug === "linux") ? "ready" : "missing"} · <span data-node-build-state>${escapeHtml(state.buildQueue?.states?.[n.nodeId] || (state.buildJob?.nodeId === n.nodeId && running && !state.buildJob?.registered ? "Building" : (n.templates || []).some((t) => t.templateSlug === "linux") ? "Ready" : "Waiting"))}</span></li>`).join("")}</ul>
${vendorWarnings}
<div id="build-recoveries">${nodes
		.filter((n) => n.buildJobId && !running)
		.map((n) => {
			const recovery = state.buildRecovery?.[n.nodeId] || {};
			const resources = [
				...(recovery.vms || []).map((v) => `VM ${v.vmid}`),
				...(recovery.disks || []).map((d) => d.name),
				...(recovery.unknown || []).map((v) => `Unknown VM ${v.vmid}`),
			];
			return `<section class="build-recovery"><p>The last build on ${escapeHtml(n.name)} ${state.buildJob?.nodeId === n.nodeId && !/interrupted by restart/i.test(state.buildJob?.error || "") ? "failed" : "was interrupted"} <time data-local-time datetime="${escapeHtml((state.buildJob?.nodeId === n.nodeId && state.buildJob?.finishedAt) || recovery.createdAt || "")}"></time>.</p><p>${escapeHtml(resources.length ? `Remaining: ${resources.join(", ")}` : recovery.error || "No leftover build VMs or disks found.")}</p><button type="button" data-recover-build="${escapeHtml(n.buildJobId)}" data-node-id="${escapeHtml(n.nodeId)}">Clean up and retry</button><p class="error" role="alert" data-recovery-error></p><a href="/quickstart/setup/build/log?jobId=${escapeHtml(n.buildJobId)}" target="_blank" rel="noopener">Open build log</a></section>`;
		})
		.join("")}</div>
<p id="queue-progress" role="status"></p><button type="button" id="stop-queue" class="outline" hidden>Stop queue after current build</button>
<p>${
		nodes.length > 1
			? `Prepare once on ${escapeHtml(nodes[0].name)}, then copy to ${escapeHtml(
					nodes
						.slice(1)
						.map((n) => n.name)
						.join(", "),
				)}. Download time depends on your connection; customization runs offline.`
			: "Download time depends on your connection; customization then runs locally without package archive access."
	}</p>
${buildProgress}
${nodes.some((n) => n.templates?.length || n.buildJobId) ? `<details><summary>Node details</summary>${nodes.map((n) => `<p>${escapeHtml(n.name)} · ${escapeHtml((n.templates || []).map((t) => `${t.templateSlug} · ${t.version} · VM ${t.pveVmid}`).join(", "))}${n.buildJobId ? ` · Unfinished reservation: <code>${escapeHtml(n.buildJobId)}</code>` : ""}</p>`).join("")}</details>` : ""}

<details><summary>Build another template</summary>
${nodeSelect("build-node")}
<label>Operating system<select id="build-slug"><option value="linux">Umiak Linux</option><option value="linux-desktop">Umiak Linux Desktop</option><option value="windows">Windows 11 (with desktop)</option></select></label>
<label id="linux-source">Linux preparation<select id="build-mode"><option value="download">Download signed offline layer</option><option value="local">Build locally (advanced)</option></select><span>Local builds use the pinned online recipes and may take 10 minutes or longer.</span></label>
<div id="windows-media" hidden><label>Uploaded Windows ISO file name<input id="build-iso" placeholder="Windows.iso"></label><label>Or Windows ISO HTTPS URL<input id="build-iso-url" type="url" placeholder="https://…/Windows.iso"></label><label>Windows ISO SHA256 (optional)<input id="build-iso-sha" pattern="[a-fA-F0-9]{64}"></label><label>ISO storage (blank selects first with iso content)<input id="build-media-storage"></label><label>VirtIO ISO URL<input id="build-virtio-url" type="url" value="${VIRTIO_STABLE_URL}"></label><label>VirtIO SHA256 (optional; pinned archive checksum)<input id="build-virtio-sha" value="${VIRTIO_SHA256}" pattern="[a-fA-F0-9]{64}"></label><label><input id="build-internal-urls" type="checkbox">I explicitly allow internal or loopback ISO URLs</label><p>Not verified: the ISO will be used as downloaded when SHA256 is omitted.</p><p>Umiak never ships or hosts Windows media. Supply your own licensed Windows ISO URL. Obtain its SHA256 from your Microsoft download portal. For VirtIO, download the official ISO to your workstation and run <code>sha256sum virtio-win.iso</code>; the Fedora CHECKSUM currently lists RPM MD5s, not the ISO SHA256. Changing the versioned ISO requires a new confirmed SHA256.</p><button class="outline" type="button" id="validate-media">Validate ISO inputs only</button><p id="media-result" role="status"></p></div>
<button type="button" id="build-template"${running ? " disabled" : ""}>Prepare selected template</button></details>
${hasTemplates ? '<details><summary>Rebuild a template</summary><p>Choose the operating system above. A new image will be built; existing templates are kept.</p><label>Confirm the operating system name<input id="build-confirm" placeholder="linux, linux-desktop or windows"></label></details>' : ""}
<details><summary>Use an existing template</summary>${form("templates", `<fieldset><legend>Detected templates</legend>${state.templateDetectionError ? `<p class="error">${escapeHtml(state.templateDetectionError)}</p>` : ""}${(state.detectedTemplates || []).map((build) => `<label><input type="checkbox" name="template" value="${build.pveVmid}" data-node-id="${escapeHtml(build.nodeId || "")}" data-slug="${escapeHtml(build.templateSlug)}" ${(steps.templates?.data?.builds || []).some((saved) => saved.pveVmid === build.pveVmid) ? "checked" : ""}>${escapeHtml(build.name || build.templateSlug)} · ${escapeHtml(build.node || "")} · VM ${build.pveVmid} · ${escapeHtml(build.templateSlug)}</label>`).join("") || '<p class="pending">No existing templates detected. Build a Linux template above.</p>'}</fieldset>`)}</details>`,
)}
${section("smoke", "4. Test your installation", `${steps.smoke?.status === "ready" ? '<p class="ready">Sandbox creation and command execution passed. The temporary VM was deleted.</p>' : ""}${form("smoke", `${nodeSelect("smoke-node")}<p id="smoke-reason" role="status">${!(nodes[0]?.templates || []).some((t) => t.templateSlug === "linux") ? `Build a Linux template on ${escapeHtml(nodes[0]?.name || "the selected node")} first.` : ""}</p><p id="back-to-build-row"${(nodes[0]?.templates || []).some((t) => t.templateSlug === "linux") ? " hidden" : ""}><a href="#step-templates" id="back-to-build">Go to step 3 to build a Linux template</a></p><p>Creates a temporary Linux VM using 2 GiB RAM, runs a command, then deletes it.</p>`, "Run installation test")}`)}
<p id="certificate-warning" class="error" role="status"></p>
<details><summary>Technical details</summary><p id="certificate-status"></p></details>
<p><a href="/app/getting-started">CLI, agent connections and help</a></p>
<script>${showCertificateStatus.toString()};void showCertificateStatus();</script>
<script>${setupInteractions.toString()};setupInteractions();</script>`,
	);
}
