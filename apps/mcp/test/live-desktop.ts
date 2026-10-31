// Live contract probe, invoked by infra/dev-cp; no token, URL, clipboard or image data is logged.
import { execFileSync } from "node:child_process";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { Sandbox } from "@sbx/sdk";

export async function verifyLiveDesktopMcp(
	sandbox: Sandbox,
	url: string,
	windows = false,
) {
	const auth = JSON.parse(
		execFileSync("sbx", ["auth", "token", "--json"], { encoding: "utf8" }),
	) as { token: string };
	const client = new Client({
		name: "s10-desktop-acceptance",
		version: "1.0.0",
	});
	await client.connect(
		new StreamableHTTPClientTransport(new URL(url), {
			requestInit: { headers: { Authorization: `Bearer ${auth.token}` } },
		}),
	);
	try {
		const call = async (name: string, args: Record<string, unknown> = {}) => {
			const result = await client.callTool({
				name,
				arguments: { sandbox: sandbox.id, ...args },
			});
			if (result.isError) throw new Error(`MCP ${name} returned isError`);
			console.log(`ok MCP ${name}`);
			return result;
		};
		const link = await call("desktop_url");
		if (!JSON.stringify(link).includes("https://"))
			throw new Error("MCP desktop_url missing link");
		const shot = await call("computer_screenshot");
		if (!(shot.content as { type: string }[]).some((c) => c.type === "image"))
			throw new Error("MCP missing screenshot image");
		await call("computer_click", { x: 250, y: 180, screenshot_after: false });
		await call("computer_move", { x: 260, y: 190, screenshot_after: false });
		await call("computer_drag", {
			path: [
				{ x: 250, y: 180 },
				{ x: 260, y: 190 },
			],
			screenshot_after: false,
		});
		await call("computer_scroll", { dy: 1, screenshot_after: false });
		await call("computer_key", { keys: "ctrl+c", screenshot_after: false });
		const proofText = "MCP Привет 世界";
		if (windows) {
			// The Run dialog of the console session executes the typed pwsh line.
			await call("computer_key", { keys: "win+r", screenshot_after: false });
			await new Promise((done) => setTimeout(done, 1500));
		}
		await call("computer_type", {
			text: windows
				? `pwsh -NoProfile -Command "Set-Content -NoNewline -Encoding utf8 $env:USERPROFILE\\s10-mcp-input '${proofText}'"`
				: `printf '%s' '${proofText}' > /tmp/s10-mcp-input`,
			screenshot_after: false,
		});
		await call("computer_key", { keys: "enter", screenshot_after: false });
		if (windows) await new Promise((done) => setTimeout(done, 4000));
		const proof = await sandbox.exec(
			windows
				? [
						"C:\\Program Files\\PowerShell\\7\\pwsh.exe",
						"-NoProfile",
						"-Command",
						"[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);[Console]::Write((Get-Content -Raw -Encoding utf8 (Join-Path $env:USERPROFILE 's10-mcp-input')))",
					]
				: ["cat", "/tmp/s10-mcp-input"],
		);
		if (proof.exitCode !== 0 || proof.stdout !== proofText)
			throw new Error("MCP keyboard proof failed");
		await call("computer_clipboard_write", { text: "MCP clipboard 世界" });
		const clip = await call("computer_clipboard_read");
		if (!JSON.stringify(clip).includes("MCP clipboard 世界"))
			throw new Error("MCP clipboard mismatch");
	} finally {
		await client.close();
	}
}
