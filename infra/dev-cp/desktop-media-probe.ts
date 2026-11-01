// Dev-only repeated viewer probe for streamer diagnostics (S10 W1-B). Opens the
// websocket (or webrtc) viewer N times on one sandbox, right after create by
// default, and saves viewer counters plus guest logs for every attempt.
//
//   SBX_PROBE_TEMPLATE=windows-desktop SBX_PROBE_ATTEMPTS=3 node infra/dev-cp/desktop-media-probe.ts
//
// SBX_PROBE_SANDBOX reuses a sandbox; SBX_PROBE_KEEP=1 keeps a created one;
// SBX_PROBE_SUNSHINE_LOG sets Sunshine's min_log_level before the first open
// (restarts the streamer); SBX_PROBE_HOLD_MS keeps a black viewer open for
// manual inspection. Needs the same environment as e2e-desktop.sh.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	instrumentViewer,
	launchViewerBrowser,
	viewerStats,
} from "../../apps/web/e2e/desktop-media.ts";
import { type Sandbox, Sbx } from "../../packages/sdk-ts/src/index.ts";
import { waitForDesktopBudget } from "./desktop-budget.ts";
import { guestRoot, pwsh } from "./guest-root.ts";

const client = new Sbx();
const template = process.env.SBX_PROBE_TEMPLATE ?? "windows-desktop";
const windows = template.startsWith("windows");
const attempts = Number(process.env.SBX_PROBE_ATTEMPTS ?? 3);
const transport = (process.env.SBX_PROBE_TRANSPORT ?? "websocket") as
	| "websocket"
	| "webrtc";
const output = process.env.SBX_E2E_OUTPUT ?? "";
if (!output) throw new Error("SBX_E2E_OUTPUT is required");
await mkdir(output, { recursive: true, mode: 0o700 });

const sunDir = windows
	? "C:\\Program Files\\Sunshine\\config"
	: "/home/user/.local/state/sbx-sunshine";
const logs = windows
	? {
			"web-server.log": pwsh(
				"Get-Content -Tail 600 'C:\\ProgramData\\sbx-agent\\state\\desktop-moonlight\\web-server.log'",
			),
			"sunshine.log": pwsh(`Get-Content -Tail 3000 '${sunDir}\\sunshine.log'`),
			"udp.txt": pwsh(
				"Get-NetUDPEndpoint | Where-Object { (Get-Process -Id $_.OwningProcess).Name -match 'sunshine|web-server' } | ForEach-Object { '{0}:{1} pid={2} {3}' -f $_.LocalAddress,$_.LocalPort,$_.OwningProcess,(Get-Process -Id $_.OwningProcess).Name }",
			),
		}
	: {
			"web-server.log": [
				"journalctl",
				"-u",
				"sbx-moonlight-web",
				"--no-pager",
				"-n",
				"600",
			],
			"sunshine.log": ["tail", "-n", "3000", `${sunDir}/sunshine.log`],
			"udp.txt": ["ss", "-uanp"],
		};

async function attempt(sb: Sandbox, n: number) {
	const label = `${n}-${transport}`;
	const browser = await launchViewerBrowser();
	const started = Date.now();
	try {
		const page = await browser.newPage({
			viewport: { width: 1280, height: 800 },
		});
		await page.addInitScript(instrumentViewer);
		const consoleLines: string[] = [];
		page.on("console", (m: { type(): string; text(): string }) =>
			consoleLines.push(
				`${new Date().toISOString()} ${m.type()} ${m.text().replace(/https?:\/\/\S+/g, "<url>")}`,
			),
		);
		// The first open starts the streamer; retry desktop_starting with fresh links.
		for (;;) {
			const link = await sb.desktop.link({ transport });
			const r = await page.goto(link.url, { waitUntil: "domcontentloaded" });
			if (r?.status() !== 503 || Date.now() - started > 90_000) break;
			await page.waitForTimeout(2000);
		}
		const opened = Date.now();
		let video = 0;
		let decoded = 0;
		for (const end = opened + 40_000; Date.now() < end; ) {
			await page.waitForTimeout(1000);
			// The viewer navigates after the ticket exchange; sample again then.
			const s = (await viewerStats(page).catch(() => ({}))) as {
				viewer?: { ws: { video: number }; decoder: { output: number } };
			};
			video = s.viewer?.ws.video ?? 0;
			decoded = s.viewer?.decoder.output ?? 0;
			if (decoded > 0) break;
		}
		const ok = decoded > 0;
		console.log(
			`${label} open ${opened - started} ms, ${ok ? "picture" : "BLACK"} after ${Date.now() - opened} ms (ws video ${video}, decoded ${decoded})`,
		);
		if (!ok) {
			const hold = Number(process.env.SBX_PROBE_HOLD_MS ?? 0);
			if (hold > 0) {
				console.log(`holding the black viewer for ${hold} ms`);
				await page.waitForTimeout(hold);
			}
		}
		await writeFile(
			join(output, `${label}-stats.json`),
			JSON.stringify(await viewerStats(page), null, 2),
			{ mode: 0o600 },
		);
		await writeFile(
			join(output, `${label}-console.log`),
			`${consoleLines.join("\n")}\n`,
			{ mode: 0o600 },
		);
		for (const [name, argv] of Object.entries(logs))
			await writeFile(
				join(output, `${label}-${name}`),
				guestRoot(sb, argv).out,
				{
					mode: 0o600,
				},
			);
		return ok;
	} finally {
		await browser.close();
		await sb.desktop.endStreams();
	}
}

const reuse = process.env.SBX_PROBE_SANDBOX;
await waitForDesktopBudget();
const sb = reuse
	? await client.sandboxes.get(reuse)
	: await client.sandboxes.create({
			template,
			size: "4gb",
			labels: { e2e: "desktop" },
			idleTimeoutSeconds: 900,
			ttlSeconds: 3600,
		});
console.log(`sandbox ${sb.data.slug}`);
let failures = 0;
try {
	await sb.waitUntilReady({ timeoutMs: windows ? 600_000 : 300_000 });
	const level = process.env.SBX_PROBE_SUNSHINE_LOG;
	if (level) {
		if (!/^(verbose|debug|info)$/.test(level))
			throw new Error("invalid Sunshine log level");
		await sb.desktop.endStreams();
		const conf = windows
			? `${sunDir}\\sunshine.conf`
			: `${sunDir}/sunshine.conf`;
		const r = guestRoot(
			sb,
			windows
				? pwsh(
						`$p='${conf}';(Get-Content -Raw $p) -replace 'min_log_level = \\w+','min_log_level = ${level}' | Set-Content -NoNewline $p; Stop-Service SunshineService -ErrorAction SilentlyContinue`,
					)
				: [
						"sh",
						"-c",
						`sed -i 's/^min_log_level = .*/min_log_level = ${level}/' ${conf} && systemctl --user -M user@ stop app-dev.lizardbyte.app.Sunshine.service || true`,
					],
		);
		console.log(`Sunshine min_log_level ${level}: exit ${r.exitcode}`);
	}
	for (let n = 1; n <= attempts; n++) if (!(await attempt(sb, n))) failures++;
} finally {
	if (!reuse && process.env.SBX_PROBE_KEEP !== "1")
		await sb.delete({ wait: true });
}
console.log(`${failures} of ${attempts} black; artifacts ${output}`);
process.exitCode = failures ? 1 : 0;
