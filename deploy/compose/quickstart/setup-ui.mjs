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
// This helper runs in the browser, including plain LAN HTTP without Clipboard API.
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
				lines.push(`${label}: ${status[key]}`);
		}
		if (typeof status.warning === "string" && status.warning)
			lines.push(status.warning);
		document.querySelector("#certificate-status").textContent =
			lines.join(" · ");
	} catch {}
}
function copyFailureGuidance(secureContext) {
	const message = "Could not copy: select the text and copy it yourself.";
	return secureContext
		? message
		: message +
				" Use Tailscale Serve (recommended), localhost or your own HTTPS proxy. For localhost, run ssh -L 4180:localhost:4180 <docker-host> and open http://localhost:4180. For a quick Chrome test only, add this origin at chrome://flags/#unsafely-treat-insecure-origin-as-secure; this weakens browser protection.";
}
const block = (value) =>
	`<div class="copy"><pre>${escapeHtml(value)}</pre><button class="outline" type="button" onclick="copyText(this.previousElementSibling.textContent).catch(()=>{document.querySelector('#copy-status').textContent=copyFailureGuidance(window.isSecureContext)})">Copy</button></div>`;
function page(title, content) {
	return renderPage(
		title,
		`<script>${copyText.toString()};${copyFailureGuidance.toString()}</script>${content}<p id="copy-status" role="status"></p>`,
	);
}

export function renderHelp(origin) {
	return page(
		"Help",
		`<h1>Your Umiak developer guide</h1><p>Use this address for the dashboard, API, CLI and MCP: <strong>${escapeHtml(origin)}</strong>.</p>
<section><h2>Install the CLI</h2><p>Quickstart uses HTTP on your trusted LAN by default. For HTTPS, use Tailscale Serve or your own reverse proxy.</p>${block(`curl -fsSL ${origin}/install.sh -o umiak-install.sh && sh ./umiak-install.sh`)}<p>The installer verifies SHA256SUMS and installs to <code>~/.local/bin</code>. Add that directory to PATH. Pair the CLI in your claimed owner browser.</p>${block(`umiak login --api-url ${origin}\numiak create --template linux --size 2gb\numiak exec <sandbox> -- echo hello\numiak rm <sandbox> --yes`)}</section>
<section><h2>MCP for Claude Code</h2><p>The stdio server uses your paired CLI profile. Only approve tools you intend your coding agent to use.</p>${block("claude mcp add umiak -- umiak mcp")}<h2>MCP for Codex</h2>${block("codex mcp add umiak -- umiak mcp")}<p>Remote Streamable HTTP endpoint: <code>${escapeHtml(origin)}/mcp</code>. Configure your client with a paired bearer credential. For HTTPS through your own proxy, clients must trust its certificate.</p></section>
<section><h2>SDK</h2><p>Use a paired credential from your CLI profile. Keep credentials out of source control and agent prompts.</p>${block(`import { Umiak } from '@umiak/sdk';\nconst umiak = new Umiak({ baseUrl: '${origin}', accessToken: process.env.UMIAK_TOKEN });`)}${block(`from umiak_sdk import Umiak\nimport os\nclient = Umiak(base_url="${origin}", access_token=os.environ["UMIAK_TOKEN"])`)}</section>
<section><h2>Desktops and optional templates</h2><p>Linux is the default. Linux desktop, Windows and Windows desktop templates can be registered in Setup after building with the S5 template builder. Supply your own licensed Windows ISO and the VirtIO ISO; existing templates are adopted without rebuilding. Open a desktop-capable sandbox in the dashboard and select Desktop. The embedded viewer needs a secure browser context for WebCodecs: use Tailscale Serve (recommended), localhost or your own HTTPS proxy. For localhost, run <code>ssh -L 4180:localhost:4180 &lt;docker-host&gt;</code> and open <code>http://localhost:4180</code>. From LAN HTTP, open the HTTPS viewer in a new tab. For a quick Chrome test only, add this origin at <code>chrome://flags/#unsafely-treat-insecure-origin-as-secure</code>; this weakens browser protection.</p></section>
<section><h2>Troubleshooting</h2><ul><li><strong>Certificate error:</strong> check the certificate configured on your HTTPS proxy or guest gateway. Verify any required CA through a trusted operator channel.</li><li><strong>Owner required:</strong> claim with the setup code in <code>docker compose logs quickstart</code>, or approve your CLI pairing from an existing owner session.</li><li><strong>PVE pin mismatch:</strong> inspect the fingerprint at the Proxmox console before updating it; do not blindly accept a changed pin.</li><li><strong>Node-agent SSH fails:</strong> check the restricted private key, pinned SSH host key and reachability from the control plane.</li><li><strong>Sandbox does not become ready:</strong> guests must reach the configured gateway on port 443 and trust the tunnel CA embedded in the template.</li><li><strong>Capacity exhausted:</strong> stop or delete your own sandboxes; the total RAM cap and VMID range are enforced.</li><li><strong>LAN works, tailnet fails:</strong> verify DNS and direct access to the quickstart HTTP port or configured HTTPS proxy. No relay service is required.</li></ul>${block("docker compose ps\ndocker compose logs --tail=100 quickstart api worker gateway")}</section>`,
	);
}
const field = (name, label, value = "", type = "text") =>
	`<label>${label}<input name="${name}" type="${type}" value="${escapeHtml(value)}"></label>`;
const text = (name, label) =>
	`<label>${label}<textarea name="${name}" autocomplete="off"></textarea></label>`;
export function renderSetup(state, origin) {
	const tailnet = new URL(origin).hostname
		.toLowerCase()
		.replace(/\.$/, "")
		.endsWith(".ts.net");
	const steps = state.steps || {};
	const connection = steps.connection?.data || {};
	const limits = { ...templateRange(state), ...steps.limits?.data };
	const network = steps.network?.data || {};
	const status = (name) =>
		`<p class="${steps[name]?.status === "error" ? "error" : steps[name]?.status === "ready" ? "ready" : "pending"}">${escapeHtml(steps[name]?.status || "Not configured")}${steps[name]?.error ? `: ${escapeHtml(steps[name].error)}` : ""}</p>`;
	const buildStatus = state.buildJob
		? `<p class="${state.buildJob.status === "error" ? "error" : "ready"}">Build ${escapeHtml(state.buildJob.slug)}: ${escapeHtml(state.buildJob.status)} ${escapeHtml(state.buildJob.error || "")}</p><pre>${escapeHtml(state.buildJob.log || "")}</pre>`
		: "";
	const order = [
		"connection",
		"host",
		"limits",
		"network",
		"templates",
		"smoke",
	];
	const current = order.find((name) => steps[name]?.status !== "ready");
	const section = (name, title, fields) =>
		`<details name="setup-step"${name === current ? " open" : ""}><summary>${steps[name]?.status === "ready" ? "✓ " : ""}${title}</summary>${status(name)}<form data-step="${name}">${fields}<button${name === "templates" ? ' class="outline"' : ""}>Verify and save</button></form></details>`;
	return page(
		"Setup",
		`<h1>Set up your sandbox platform</h1><p id="certificate-status" role="status"></p><script>${showCertificateStatus.toString()};void showCertificateStatus();</script>${tailnet ? '<p class="error" role="status">Tailscale: if you use Funnel, this is public. Use Tailscale Serve to keep this dashboard private to your tailnet.</p>' : ""}<p>Quickstart uses HTTP on your trusted LAN by default. For HTTPS, use Tailscale Serve or your own reverse proxy.</p><p>${Object.values(steps).filter((step) => step.status === "ready").length} of 6 steps verified</p><progress max="6" value="${Object.values(steps).filter((step) => step.status === "ready").length}" aria-label="Setup progress"></progress><p>Each step is saved. Re-run a step to verify it again. Existing PVE objects and templates are adopted without creating a parallel setup.</p>${state.complete ? '<p class="ready">You are ready. Setup and smoke test passed. <a href="/app/getting-started">Get started with Umiak</a> · <a href="/app">Open your sandboxes</a></p>' : ""}
${section("connection", "1. Connect Proxmox", field("apiUrl", "Proxmox HTTPS origin", connection.apiUrl || "https://pve:8006") + field("node", "Node name", connection.node || "pve") + field("fingerprint", "SHA256 certificate fingerprint (verify at the PVE console)", connection.fingerprint) + field("tlsName", "TLS server name", connection.tlsName || "pve") + field("sshHost", "Node-agent SSH host", connection.sshHost || "pve") + field("tokenId", "Existing API token ID", connection.tokenId || "umiak@pve!dev") + field("tokenSecret", "Token secret (leave blank to use mounted credentials)", "", "password") + text("caPem", "PVE root CA PEM (preserve mounted CA when blank; required from the host report if not mounted)") + text("sshPrivateKey", "Restricted node-agent SSH private key (leave blank to use mounted key)") + text("knownHosts", "Pinned OpenSSH known_hosts (leave blank to use mounted file)"))}
${section("host", "2. Prepare or adopt the host", `<p>Choose Adopt to verify an existing installation. Checks are read-only: user/token permissions, pool, SDN, gateway IPSet, egress firewall and restricted node-agent.</p><input type="hidden" name="mode" value="adopt"><p>For a fresh PVE host generate the preparation command below, inspect its dry run, then re-run this adoption check.</p><label>Host preparation mode<select id="prep-mode"><option value="adopt">Read-only adoption report (existing host)</option><option value="fresh">Prepare a fresh host</option></select></label><label>Gateway LAN IPv4 (fresh host only)<input id="prep-gateway"></label><label>Storage for fresh preparation<input id="prep-storage" value="local-lvm"></label><label>Guest DNS resolver<input id="prep-dns" value="1.1.1.1"></label><label>Host template VMID range start<input id="prep-template-min" type="number" value="${templateRange(state).templateVmidMin}"></label><label>Host template VMID range end<input id="prep-template-max" type="number" value="${templateRange(state).templateVmidMax}"></label><button class="outline" type="button" id="prepare">Generate host command</button><pre id="preparation"></pre>`)}
${section("limits", "3. Storage and capacity", `${field("storage", "LVM-thin storage", limits.storage || "local-lvm") + field("vmidMin", "First sandbox VMID", limits.vmidMin || 500, "number") + field("vmidMax", "Last sandbox VMID", limits.vmidMax || 589, "number") + field("templateVmidMin", "First template VMID (separate from sandboxes)", limits.templateVmidMin, "number") + field("templateVmidMax", "Last template VMID", limits.templateVmidMax, "number")}<p>New builds allocate a free VMID in this range. Existing adopted templates keep their VMIDs: ${escapeHtml((steps.templates?.data?.builds || []).map((build) => build.pveVmid).join(", ") || "none")}. Occupied IDs are skipped; no existing VM is replaced.</p>${field("ramCapMb", "Total sandbox RAM cap (MiB)", limits.ramCapMb || 8192, "number")}`)}
${section("network", "4. Gateway and previews", `${field("gatewayAddress", "Gateway address reachable from guests", network.gatewayAddress) + field("tunnelUrl", "Guest tunnel URL (wss://gateway/v1/connect)", network.tunnelUrl) + field("previewDomain", "Preview domain (defaults to IP-derived sslip.io)", network.previewDomain) + field("guestDns", "Guest DNS resolver", network.guestDns || "1.1.1.1")}<p>Keep the gateway certificate and CA trusted by your existing templates. The default preview and tunnel names use external sslip.io DNS. Use your own wildcard DNS domain to replace it. Guests default to the external DNS resolver 1.1.1.1; choose another resolver during fresh preparation if needed. Saving here does not change an existing PVE DHCP configuration. Before the smoke test, apply the saved network settings from your repository checkout: <code>docker compose up -d --force-recreate gateway-secrets &amp;&amp; docker compose restart gateway worker api web</code>.</p>`)}
${section("templates", "5. Template builds", `<p>Register existing tagged templates or build Linux from scratch in its empty slot. Linux is required; desktop and Windows are optional. Existing template slots are never rebuilt.</p>${buildStatus}<label>New template recipe<select id="build-slug"><option value="linux">Linux (default)</option><option value="linux-desktop">Linux desktop</option><option value="windows">Windows</option><option value="windows-desktop">Windows desktop</option></select></label><label>Uploaded Windows ISO file name<input id="build-iso" placeholder="Windows.iso"></label><label>Or Windows ISO HTTPS URL<input id="build-iso-url" type="url" placeholder="https://…/Windows.iso"></label><label>Windows ISO SHA256 (optional)<input id="build-iso-sha" pattern="[a-fA-F0-9]{64}"></label><label>ISO storage (blank selects first with iso content)<input id="build-media-storage"></label><label>VirtIO ISO URL<input id="build-virtio-url" type="url" value="${VIRTIO_STABLE_URL}"></label><label>VirtIO SHA256 (optional; pinned archive checksum)<input id="build-virtio-sha" value="${VIRTIO_SHA256}" pattern="[a-fA-F0-9]{64}"></label><label><input id="build-internal-urls" type="checkbox">I explicitly allow internal or loopback ISO URLs</label><p>Not verified: the ISO will be used as downloaded when SHA256 is omitted.</p><p>Umiak never ships or hosts Windows media. Supply your own licensed Windows ISO URL. Obtain its SHA256 from your Microsoft download portal. For VirtIO, download the official ISO to your workstation and run <code>sha256sum virtio-win.iso</code>; the Fedora CHECKSUM currently lists RPM MD5s, not the ISO SHA256. Changing the versioned ISO requires a new confirmed SHA256.</p><button class="outline" type="button" id="validate-media">Validate ISO inputs only</button><button type="button" id="build-template">Build and verify template</button><p>Builds run one at a time and record their status. Refresh this page to see progress. Windows requires your licensed ISO; additional VirtIO/desktop recipe prerequisites are checked by the S5 builder.</p><fieldset><legend>Detected templates</legend>${state.templateDetectionError ? `<p class="error">${escapeHtml(state.templateDetectionError)}</p>` : ""}${(state.detectedTemplates || []).map((build) => `<label><input type="checkbox" name="template" value="${build.pveVmid}" data-slug="${escapeHtml(build.templateSlug)}" ${(steps.templates?.data?.builds || []).some((saved) => saved.pveVmid === build.pveVmid) ? "checked" : ""}>${escapeHtml(build.name || build.templateSlug)} · VM ${build.pveVmid} · ${escapeHtml(build.templateSlug)}</label>`).join("") || '<p class="pending">No tagged templates detected. Build a Linux template using the button above, then refresh this page.</p>'}</fieldset><p>For a manual build, read <code>apps/template-builder/README.md</code> in the repository checkout you used to start Docker Compose. Existing templates are never rebuilt by this wizard.</p>`)}
${section("smoke", "6. First sandbox smoke", "<p>This creates one 2 GiB Linux sandbox, waits for readiness, executes a command, then deletes it. It checks existing sandbox RAM first and runs sequentially.</p>")}
<p id="result" aria-live="polite"></p><p><a href="/app/getting-started">Getting started: CLI, MCP, SDK and troubleshooting</a></p>
<script>for(const form of document.querySelectorAll('form'))form.addEventListener('submit',async event=>{event.preventDefault();if(form.dataset.step==='smoke'&&!confirm('Run the smoke test? This creates a sandbox, executes a command and deletes it.'))return;const button=form.querySelector('button:last-child');button.disabled=true;const data=Object.fromEntries(new FormData(form));for(const key of ['vmidMin','vmidMax','templateVmidMin','templateVmidMax','ramCapMb'])if(key in data)data[key]=Number(data[key]);try{if(form.dataset.step==='templates')data.builds=Array.from(form.querySelectorAll('input[name=template]:checked')).map(input=>({templateSlug:input.dataset.slug,pveVmid:Number(input.value)}));const response=await fetch('/quickstart/setup/'+form.dataset.step,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const result=await response.json();if(!response.ok)throw new Error(result.error);location.reload();}catch(error){document.querySelector('#result').textContent=error.message;}finally{button.disabled=false;}});document.querySelector('#build-template').addEventListener('click',async()=>{try{if(!confirm("Build this template? This creates a VM and downloads required media on your Proxmox host."))return;const response=await fetch('/quickstart/setup/build',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug:document.querySelector('#build-slug').value,iso:document.querySelector('#build-iso').value,isoSha256:document.querySelector('#build-iso-sha').value,isoUrl:document.querySelector('#build-iso-url').value,mediaStorage:document.querySelector('#build-media-storage').value,virtioUrl:document.querySelector('#build-virtio-url').value,virtioSha256:document.querySelector('#build-virtio-sha').value,allowInternalIsoUrls:document.querySelector('#build-internal-urls').checked})});const result=await response.json();if(!response.ok)throw new Error(result.error);location.reload();}catch(error){document.querySelector('#result').textContent=error.message;}});document.querySelector('#validate-media').addEventListener('click',async()=>{const response=await fetch('/quickstart/setup/media/validate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({iso:document.querySelector('#build-iso').value,isoUrl:document.querySelector('#build-iso-url').value,isoSha256:document.querySelector('#build-iso-sha').value,virtioUrl:document.querySelector('#build-virtio-url').value,virtioSha256:document.querySelector('#build-virtio-sha').value,allowInternalIsoUrls:document.querySelector('#build-internal-urls').checked})});const result=await response.json();document.querySelector('#result').textContent=result.error||result.message;});document.querySelector('#prepare').addEventListener('click',async()=>{try{const response=await fetch('/quickstart/setup/prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:document.querySelector('#prep-mode').value,gatewayAddress:document.querySelector('#prep-gateway').value,storage:document.querySelector('#prep-storage').value,templateVmidMin:Number(document.querySelector('#prep-template-min').value),templateVmidMax:Number(document.querySelector('#prep-template-max').value),guestDns:document.querySelector('#prep-dns').value})});const result=await response.json();if(!response.ok)throw new Error(result.error);document.querySelector('#preparation').textContent=(result.warning?result.warning+'\\n\\n':'')+result.command;}catch(error){document.querySelector('#result').textContent=error.message;}});</script>`,
	);
}
