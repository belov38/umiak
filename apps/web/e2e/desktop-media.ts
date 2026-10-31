// Real media acceptance through the gateway; called by infra/dev-cp/e2e-desktop.ts.

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import type { Sandbox } from "@sbx/sdk";

const hash = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");
export async function verifyDesktopMedia(
	sb: Sandbox,
	output: string,
	onWebRtcReady?: () => Promise<void>,
) {
	const browser = await chromium.launch({
		headless: true,
		args: [
			"--autoplay-policy=no-user-gesture-required",
			...(process.env.SBX_DESKTOP_BROWSER_SPKI
				? [
						`--ignore-certificate-errors-spki-list=${process.env.SBX_DESKTOP_BROWSER_SPKI}`,
					]
				: []),
		],
	});
	try {
		for (const transport of ["websocket", "webrtc"] as const) {
			const page = await browser.newPage({
				viewport: { width: 1280, height: 800 },
			});
			if (transport === "webrtc")
				await page.addInitScript(() => {
					const peers: RTCPeerConnection[] = [];
					const Native = window.RTCPeerConnection;
					(
						window as unknown as { __s10Peers: RTCPeerConnection[] }
					).__s10Peers = peers;
					window.RTCPeerConnection = class extends Native {
						constructor(config?: RTCConfiguration) {
							super({ ...config, iceTransportPolicy: "relay" });
							peers.push(this);
						}
					};
				});
			try {
				const fresh = await sb.desktop.link({ transport });
				try {
					await page.goto(fresh.url, { waitUntil: "domcontentloaded" });
				} catch (error) {
					throw new Error(
						String(error)
							.split("\n")[0]
							?.replace(/https?:\/\/\S+/g, "<desktop>"),
					);
				}
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
				if (transport === "webrtc") {
					const pair = await page.evaluate(async () => {
						const peers = (
							window as unknown as { __s10Peers: RTCPeerConnection[] }
						).__s10Peers;
						for (const peer of peers) {
							const stats = await peer.getStats();
							for (const item of stats.values())
								if (
									item.type === "candidate-pair" &&
									item.state === "succeeded" &&
									item.nominated
								) {
									const local = stats.get(item.localCandidateId),
										remote = stats.get(item.remoteCandidateId);
									return {
										local: local?.candidateType,
										remote: remote?.candidateType,
										protocol: local?.relayProtocol,
									};
								}
						}
						return null;
					});
					if (pair?.local !== "relay" || pair.remote !== "relay")
						throw new Error(
							"WebRTC did not select a relay-to-relay candidate pair",
						);
					console.log("ok TURN selected relay-to-relay", JSON.stringify(pair));
					await onWebRtcReady?.();
				}

				await writeFile(join(output, `${transport}-viewer.png`), second, {
					mode: 0o600,
				});
			} catch (error) {
				const logs = page.getByText("Show Logs", { exact: true });
				if (await logs.count()) await logs.click();
				await page.screenshot({
					path: join(output, `${transport}-failure.png`),
				});
				await writeFile(
					join(output, `${transport}-failure.txt`),
					(await page.locator("body").textContent()) ?? "",
					{ mode: 0o600 },
				);
				console.log(`viewer ${transport} diagnostics saved privately`);
				throw error;
			} finally {
				await page.close();
				await sb.desktop.endStreams();
			}
		}
	} finally {
		await browser.close();
	}
}
