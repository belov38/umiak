/** Commands are checked against docs/getting-started.md by the drift test. */
export interface GuideDeployment {
	tenancy?: "single" | "teams";
	mode: "owner" | "none" | "oidc";
	apiUrl: string;
	appUrl: string;
	previewDomain: string;
	previewScheme?: "http" | "https";
	previewPort?: number;
}
type Block =
	| { kind: "text"; text: string }
	| { kind: "code"; label: string; text: string };
export interface GuideSection {
	id: string;
	title: string;
	blocks: Block[];
}
const text = (value: string): Block => ({ kind: "text", text: value });
const code = (label: string, value: string): Block => ({
	kind: "code",
	label,
	text: value,
});
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function guideSections(d: GuideDeployment): GuideSection[] {
	const singleOwner = d.tenancy === "single";
	const previewScheme =
		d.previewScheme ?? (d.mode === "owner" ? "http" : "https");
	const previewPort = d.previewPort ?? (d.mode === "owner" ? 8085 : 443);
	const previewSuffix =
		previewPort === (previewScheme === "http" ? 80 : 443)
			? ""
			: `:${previewPort}`;
	const api = d.apiUrl.replace(/\/+$/, "");
	const mcp = `${d.appUrl.replace(/\/+$/, "")}/mcp`;
	const sections: GuideSection[] = [
		{
			id: "concepts",
			title: "The model in one minute",
			blocks: [
				text(
					`A sandbox is a throwaway virtual machine, identified by a three-word slug. A template is the image it is cloned from; a size sets RAM and vCPU. ${singleOwner ? "You own your sandboxes, snapshots and API keys." : "Your team owns its sandboxes, snapshots and API keys."}`,
				),
				text(
					"Snapshots save a disk so you can create another sandbox with --from. Fork copies a sandbox directly. Port previews expose a guest port over HTTP or HTTPS. Desktop templates stream a screen that people and agents can control.",
				),
				text(
					"Inactive sandboxes stop automatically according to deployment policy. Their disks remain available for resume. Use limits to check the actual quotas before creating a sandbox.",
				),
			],
		},
		{
			id: "install",
			title: "Install the CLI",
			blocks:
				d.mode === "owner"
					? [
							text(
								"Quickstart uses HTTP on your trusted LAN by default. For HTTPS, use Tailscale Serve or your own reverse proxy. Download the installer from this deployment.",
							),
							code(
								"Install CLI",
								`curl --fail ${quote(`${api}/install.sh`)} -o umiak-install.sh && sh ./umiak-install.sh`,
							),
							text(
								"The installer runs login. Open the pairing link on the hostname where you claimed this deployment, and compare the short code shown in your terminal before approving. The CLI saves the deployment connection settings in its profile.",
							),
							code("Check CLI profile", "umiak whoami"),
						]
					: [
							text(
								"Build the CLI from the repository checkout. Choose the output for your OS and CPU (darwin/linux, arm64/x64), or umiak-windows-x64.exe on Windows. Copy it to a directory on PATH; a shell alias is insufficient for agent clients.",
							),
							code(
								"Build the CLI",
								"mise exec -- pnpm install\nmise exec -- pnpm --filter @umiak/cli build",
							),
							code(
								"Install CLI (macOS arm64 example)",
								'mkdir -p ~/.local/bin\ncp apps/cli/dist/umiak-darwin-arm64 ~/.local/bin/umiak\nexport PATH="$HOME/.local/bin:$PATH"',
							),
							code(
								"Log in to this deployment",
								`umiak login --api-url ${quote(api)}\numiak whoami`,
							),
							text(
								d.mode === "none"
									? "No sign-in is required in local mode. Access is restricted by the deployment's network policy; never expose the local listener to an untrusted network."
									: `Login opens browser sign-in through this deployment's identity provider. For unattended clients, use a scoped ${singleOwner ? "" : "team "}API key from API keys.`,
							),
						],
		},
		{
			id: "first-sandbox",
			title: "Your first sandbox",
			blocks: [
				text(
					"Create a Linux sandbox, copy the printed slug into current, then run a command. The dashboard's New sandbox button and Terminal tab offer the same flow.",
				),
				code("Create a sandbox", "umiak create --template linux --wait"),
				code("Select your sandbox", "umiak current <slug>"),
				code("Run a command", "umiak exec -- uname -a"),
				code("Open a shell", "umiak shell"),
				code("Run in a temporary sandbox", "umiak run -- uname -a"),
				code(
					"Copy files",
					"umiak cp ./notes.txt <slug>:notes.txt\numiak push . <slug>:app",
				),
				code("Stop and resume", "umiak stop --wait\numiak resume --wait"),
				code("Delete your sandbox", "umiak rm <slug> --yes"),
				text(
					"Replace <slug> with your sandbox's name. Run creates a temporary sandbox, runs a command and deletes it. Delete resources you no longer need.",
				),
			],
		},
		{
			id: "previews",
			title: "Port previews",
			blocks: [
				text(
					`A preview URL has the form ${previewScheme}://<slug>-<port>.${d.previewDomain}${previewSuffix}. Start a server inside the VM, then publish its port. Token access is the default; public access lets anyone with the URL connect.`,
				),
				code(
					"Start a preview server",
					"umiak exec --detach -- python3 -m http.server 3000",
				),
				code("Publish a protected port", "umiak port 3000"),
				code("Publish a public port", "umiak port 3000 --public"),
				text(
					previewScheme === "http"
						? "Quickstart previews use plain HTTP on your trusted LAN (port 8085 by default), with IP-derived sslip.io DNS. Token access remains the default; --public removes that token requirement. Serve cannot cover wildcard preview hostnames."
						: "Preview TLS uses the guest gateway certificate. Ask the operator for its verified CA if your browser does not trust it.",
				),
			],
		},
		{
			id: "desktops",
			title: "Desktops",
			blocks: [
				text(
					"Use an available desktop template for a graphical session. Desktop templates need more RAM than a headless Linux sandbox. The dashboard's Desktop tab has the same viewer. The embedded viewer needs a secure browser context for WebCodecs: use Tailscale Serve (recommended), localhost or your own HTTPS proxy. For localhost, run ssh -L 4180:localhost:4180 <docker-host> and open http://localhost:4180. From LAN HTTP, open the HTTPS viewer in a new tab. For a quick Chrome test only, add this origin at chrome://flags/#unsafely-treat-insecure-origin-as-secure; this weakens browser protection.",
				),
				code(
					"Create a desktop",
					"umiak create --template linux-desktop --wait",
				),
				code("Open the viewer", "umiak desktop open <slug>"),
				code(
					"Take a screenshot",
					"umiak desktop screenshot <slug> -o screen.png",
				),
				code(
					"Control the desktop",
					'umiak desktop act <slug> click 400 300\numiak desktop act <slug> type "hello"',
				),
			],
		},
		{
			id: "agents",
			title: "Connect an agent with MCP",
			blocks: [
				text(
					"The recommended stdio transport uses your paired CLI profile. Put umiak on PATH, then register it in Claude Code or add the Codex configuration below.",
				),
				code(
					"Claude Code · stdio",
					"claude mcp add --transport stdio --scope user umiak -- umiak mcp",
				),
				code(
					"Codex · ~/.codex/config.toml",
					'[mcp_servers.umiak]\ncommand = "umiak"\nargs = ["mcp"]',
				),
				text(
					`Remote MCP is available at ${mcp}. Local mode needs no credential. OIDC supports browser sign-in; quickstart remote MCP uses an owner credential. Prefer stdio for quickstart so credentials stay in the CLI profile. For HTTPS through your own proxy, remote clients must trust its certificate.`,
				),
				...(d.mode === "oidc"
					? [
							code(
								"Claude Code · remote OAuth",
								`claude mcp add --transport http --scope user --client-id umiak-mcp --callback-port 33418 umiak-remote ${quote(mcp)}\nclaude mcp login umiak-remote`,
							),
							code(
								"Codex · remote OAuth",
								`codex mcp add umiak-remote --url ${quote(mcp)} --oauth-client-id umiak-mcp\ncodex mcp login umiak-remote`,
							),
							code(
								"Codex · OAuth callback setting",
								'[mcp_servers.umiak-remote.oauth]\nclient_id = "umiak-mcp"\ncallback_port = 33418',
							),
						]
					: [
							code(
								"Claude Code · remote HTTP",
								d.mode === "owner"
									? JSON.stringify(
											{
												mcpServers: {
													"umiak-remote": {
														type: "http",
														url: mcp,
														headers: {
															// Claude Code expands this environment reference at runtime.
															Authorization: "Bearer $" + "{UMIAK_OWNER_TOKEN}",
														},
													},
												},
											},
											null,
											2,
										)
									: `claude mcp add --transport http --scope user umiak-remote ${quote(mcp)}`,
							),
							code(
								"Codex · remote HTTP configuration",
								`[mcp_servers.umiak-remote]\nurl = ${JSON.stringify(mcp)}${d.mode === "owner" ? '\nbearer_token_env_var = "UMIAK_OWNER_TOKEN"' : ""}`,
							),
							...(d.mode === "owner"
								? [
										text(
											"For Claude Code, save the remote JSON configuration in .mcp.json. Set UMIAK_OWNER_TOKEN in the client environment using your own paired CLI credential from its private profile; never commit a credential or paste it into this guide. Stdio avoids this manual credential transfer.",
										),
									]
								: []),
						]),
				text(
					'Ask your agent: "Create a Linux sandbox, clone my repository into it and run the tests." umiak mcp --help explains read-only mode, toolsets and sandbox restrictions.',
				),
			],
		},
		{
			id: "sdk",
			title: "Use the SDK",
			blocks: [
				text(
					"Both SDKs read the API URL and credentials from your CLI profile after login. Run package installation from the repository checkout; these packages are available as source/workspace packages.",
				),
				code("Install Python SDK", "pip install -e packages/sdk-py"),
				code(
					"Python",
					'from umiak_sdk import Umiak\n\nwith Umiak() as umiak:\n    sb = umiak.sandboxes.create(template="linux", wait=True)\n    try:\n        print(sb.exec("uname -a").stdout)\n    finally:\n        sb.delete()',
				),
				code(
					"TypeScript · @umiak/sdk workspace package",
					'import { Umiak } from "@umiak/sdk";\n\nconst umiak = new Umiak();\nconst sb = await umiak.sandboxes.create({ template: "linux" }, { wait: true });\ntry {\n    console.log((await sb.exec(["uname", "-a"])).stdout);\n} finally {\n    await sb.delete();\n}',
				),
				text(
					`The API reference is available at ${api}/v1/openapi.json. ${singleOwner ? "API keys restrict automated clients to the scopes you choose." : "API keys can restrict automated clients to a team and scopes."}`,
				),
			],
		},
		{
			id: "limits",
			title: "Limits and cleanup",
			blocks: [
				text(
					`Limits belong to this deployment${singleOwner ? "" : " and team"}; check them rather than assuming a fixed VM count or memory budget. Stopping frees RAM while keeping the disk; deleting frees the sandbox resources.`,
				),
				code("Check quotas", "umiak limits"),
				code("List sandboxes", "umiak ls"),
				text(
					"If quota_exceeded or out_of_capacity appears, stop or delete an unused sandbox, or ask the operator about capacity. Desktop templates need at least the size shown in New sandbox.",
				),
			],
		},
		{
			id: "troubleshooting",
			title: "Troubleshooting",
			blocks: [
				text(
					"Connection timeout: check the URL, LAN or tailnet reachability and deployment network policy. Local mode is only reachable from allowed networks. On macOS, check the browser's Local Network permission if curl works but the browser cannot connect.",
				),
				text(
					"Certificate error: check the certificate configured on your HTTPS proxy or guest gateway. Obtain any required CA through a trusted operator channel and compare its fingerprint. Do not bypass certificate verification for an installer.",
				),
				...(d.mode === "owner"
					? [
							text(
								"Pairing page asks to claim an already claimed deployment: open the pairing path on the hostname where you are signed in. Cookies are host-only. An expired pairing request needs a fresh login.",
							),
						]
					: []),
				text(
					d.mode === "owner"
						? "Template unavailable: use Setup → Templates to register detected templates or its Build Linux template button. Operators can also use the documented apps/template-builder path in the repository. A successful build must be registered before creation."
						: "Template unavailable: ask the operator to register a template build in Admin. Template builders live in apps/template-builder in the repository.",
				),
				code("Inspect CLI commands", "umiak --help\numiak mcp --help"),
				code(
					"Inspect stack logs (Docker host)",
					d.mode === "owner"
						? "docker compose logs --tail=100 quickstart api worker gateway"
						: "docker compose logs --tail=100 api worker gateway",
				),
			],
		},
	];
	if (d.mode === "owner")
		sections.push({
			id: "hosting",
			title: "Optional Tailscale Serve",
			blocks: [
				text(
					"Quickstart defaults to LAN HTTP. Operators can use Tailscale Serve or their own HTTPS reverse proxy for a trusted dashboard certificate. Tailscale Serve keeps access within the tailnet; if you use Funnel, this is public. Supply a Tailscale auth key through the environment; never commit it. This is an optional Docker Compose override.",
				),
				code(
					"Start with Tailscale Serve",
					"TS_AUTHKEY=... TS_HOSTNAME=umiak docker compose -f compose.yaml -f deploy/compose/quickstart/compose.tailscale.yaml up -d --build",
				),
				text(
					"Upgrade note: if host-run Serve still targets localhost:4180, run tailscale serve --bg --https=8443 http://localhost:4181 to preserve HTTPS origin and Secure __Host- owner cookies. Docker Engine 28 or newer is required for loopback publish isolation; Docker Desktop can NAT other containers to the host gateway, so trust containers on that Docker host. Serve covers this dashboard hostname. It cannot serve wildcard preview hostnames: quickstart previews still use the guest gateway HTTP listener on port 8085 by default, with their own DNS configuration.",
				),
			],
		});
	return sections;
}
