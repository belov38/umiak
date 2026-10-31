// Real media acceptance through the gateway; called by infra/dev-cp/e2e-desktop.ts.

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import type { Sandbox } from "@sbx/sdk";

const hash = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");
export async function verifyDesktopMedia(sb: Sandbox, output: string) {
	const browser = await chromium.launch({
		headless: true,
		args: ["--autoplay-policy=no-user-gesture-required"],
	});
	try {
		for (const transport of ["websocket", "webrtc"] as const) {
			const page = await browser.newPage({
				viewport: { width: 1280, height: 800 },
			});
			try {
				const fresh = await sb.desktop.link({ transport });
				await page.goto(fresh.url, { waitUntil: "domcontentloaded" });
				const deadline = Date.now() + 90_000;
				while (!(await sb.desktop.status()).streamer.streaming) {
					if (Date.now() > deadline)
						throw new Error(`no live ${transport} viewer`);
					await new Promise((done) => setTimeout(done, 1000));
				}
				const media = page.locator("video:visible, canvas:visible").first();
				await media.waitFor({ timeout: 30_000 });
				await page.waitForTimeout(3000);
				const first = await media.screenshot();
				await sb.desktop.act({
					actions: [
						{ type: "type", text: `echo S10-${transport}-frame-change` },
						{ type: "key", keys: ["enter"] },
					],
				});
				await page.waitForTimeout(3000);
				const second = await media.screenshot();
				if (hash(first) === hash(second))
					throw new Error(`${transport} live viewer frame did not change`);
				console.log(`ok ${transport} live viewer frame diff`);
				await writeFile(join(output, `${transport}-viewer.png`), second, {
					mode: 0o600,
				});
			} finally {
				await page.close();
				await sb.desktop.endStreams();
			}
		}
	} finally {
		await browser.close();
	}
}
