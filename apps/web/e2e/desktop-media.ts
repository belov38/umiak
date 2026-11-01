// Real media acceptance through the gateway; called by infra/dev-cp/e2e-desktop.ts.

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import type { Sandbox } from "@sbx/sdk";

const MIN_PICTURE_BYTES = 30_000;
const hash = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");
export async function verifyDesktopMedia(
	sb: Sandbox,
	output: string,
	onWebRtcReady?: () => Promise<void>,
	naturalCloseLast = false,
) {
	const protocols = (process.env.SBX_DESKTOP_TURN_TRANSPORTS ?? "udp").split(
		",",
	);
	if (protocols.some((p) => !["udp", "tcp", "tls"].includes(p)))
		throw new Error("invalid TURN verification transport");
	const cases = ["websocket", ...protocols.map((p) => `webrtc-${p}`)];
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
		for (const [index, label] of cases.entries()) {
			const transport = label === "websocket" ? "websocket" : "webrtc";
			const protocol = label.slice("webrtc-".length);
			const page = await browser.newPage({
				viewport: { width: 1280, height: 800 },
			});
			// Viewer logs for failures only; links and tickets are masked.
			const consoleLines: string[] = [];
			page.on("console", (m) =>
				consoleLines.push(
					`${new Date().toISOString()} ${m.type()} ${m.text().replace(/https?:\/\/\S+/g, "<url>")}`,
				),
			);
			if (transport === "webrtc")
				await page.addInitScript((protocol) => {
					const force = (config: RTCConfiguration = {}): RTCConfiguration => ({
						...config,
						iceTransportPolicy: "relay",
						iceServers: (config.iceServers ?? [])
							.map((server) => ({
								...server,
								urls: (Array.isArray(server.urls)
									? server.urls
									: [server.urls]
								).filter((url) =>
									protocol === "tls"
										? url.startsWith("turns:")
										: url.startsWith("turn:") &&
											(protocol === "tcp"
												? url.includes("transport=tcp")
												: !url.includes("transport=tcp")),
								),
							}))
							.filter((server) => server.urls.length > 0),
					});
					const peers: RTCPeerConnection[] = [];
					const Native = window.RTCPeerConnection;
					(
						window as unknown as { __s10Peers: RTCPeerConnection[] }
					).__s10Peers = peers;
					window.RTCPeerConnection = class extends Native {
						constructor(config?: RTCConfiguration) {
							super(force(config));
							peers.push(this);
						}
						override setConfiguration(config: RTCConfiguration) {
							super.setConfiguration(force(config));
						}
					};
				}, protocol);
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
					if (Date.now() > deadline) throw new Error(`no live ${label} viewer`);
					await new Promise((done) => setTimeout(done, 1000));
				}
				const media = page.locator("video:visible, canvas:visible").first();
				await media.waitFor({ timeout: 30_000 });
				// A decoded desktop is a large PNG; an empty or black element is a few KiB.
				const pictureFrom = Date.now();
				let first = await media.screenshot();
				while (first.length < MIN_PICTURE_BYTES) {
					if (Date.now() - pictureFrom > 30_000)
						throw new Error(`${label} viewer shows no picture`);
					await page.waitForTimeout(1000);
					first = await media.screenshot();
				}
				console.log(
					`${label} first picture after ${Date.now() - pictureFrom} ms`,
				);
				await page.waitForTimeout(1000);
				first = await media.screenshot();
				// The pointer is part of the captured frame on both platforms; typed text
				// only shows when a window has the focus.
				await sb.desktop.act({
					actions: [
						{ type: "move", x: 300 + 150 * index, y: 500 - 40 * index },
						{ type: "type", text: `echo S10-${label}-frame-change` },
						{ type: "key", keys: ["enter"] },
					],
				});
				await page.waitForTimeout(3000);
				let second = await media.screenshot();
				if (hash(first) === hash(second))
					throw new Error(`${label} live viewer frame did not change`);
				console.log(`ok ${label} live viewer frame diff`);
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
					if (pair.protocol !== protocol)
						throw new Error(`TURN did not select ${protocol}`);
					console.log("ok TURN selected relay-to-relay", JSON.stringify(pair));
					if (protocol === protocols[0]) await onWebRtcReady?.();
					const connected = await page.evaluate(() =>
						(
							window as unknown as { __s10Peers: RTCPeerConnection[] }
						).__s10Peers.some((p) => p.connectionState === "connected"),
					);
					if (!connected)
						throw new Error("WebRTC disconnected during idle hold");
					const endBefore = await media.screenshot();
					await sb.desktop.act({
						actions: [
							{ type: "move", x: 900 - 150 * index, y: 300 + 40 * index },
							{ type: "type", text: `echo S10-${label}-end-${Date.now()}` },
							{ type: "key", keys: ["enter"] },
						],
					});
					await page.waitForTimeout(2000);
					const endAfter = await media.screenshot();
					if (hash(endBefore) === hash(endAfter))
						throw new Error("WebRTC media froze during idle hold");
					second = endAfter;
					console.log(`ok ${label} still delivers changed frames after hold`);
				}

				await writeFile(join(output, `${label}-viewer.png`), second, {
					mode: 0o600,
				});
			} catch (error) {
				const logs = page.getByText("Show Logs", { exact: true });
				if (await logs.isVisible()) await logs.click({ timeout: 1000 });
				await page.screenshot({
					path: join(output, `${label}-failure.png`),
				});
				await writeFile(
					join(output, `${label}-failure.txt`),
					(await page.locator("body").textContent()) ?? "",
					{ mode: 0o600 },
				);
				await writeFile(
					join(output, `${label}-console.log`),
					`${consoleLines.join("\n")}\n`,
					{ mode: 0o600 },
				);
				console.log(`viewer ${label} diagnostics saved privately`);
				throw error;
			} finally {
				await page.close();
				if (!naturalCloseLast || index !== cases.length - 1)
					await sb.desktop.endStreams();
			}
		}
	} finally {
		await browser.close();
	}
}
