// Real media acceptance through the gateway; called by infra/dev-cp/e2e-desktop.ts.

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "@playwright/test";
import type { Sandbox } from "@umiak/sdk";

const MIN_PICTURE_BYTES = 30_000;
const hash = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");
/**
 * Counts what reaches the viewer: video messages and keyframes on the websocket,
 * VideoDecoder input, output and errors. Main-thread only; a worker decoder shows
 * up as messages without decoder calls.
 */
export function instrumentViewer() {
	const s = {
		ws: { video: 0, videoKey: 0, control: 0, other: 0, firstKeyAt: 0 },
		decoder: {
			instances: 0,
			configure: 0,
			codec: "",
			key: 0,
			delta: 0,
			output: 0,
			reset: 0,
			maxQueue: 0,
			firstOutputAt: 0,
			errors: [] as string[],
		},
		startedAt: Date.now(),
	};
	(window as unknown as { __s10Viewer: typeof s }).__s10Viewer = s;
	const NativeSocket = window.WebSocket;
	window.WebSocket = class extends NativeSocket {
		constructor(url: string | URL, protocols?: string | string[]) {
			super(url, protocols);
			this.addEventListener("message", (event) => {
				if (!(event.data instanceof ArrayBuffer)) return;
				const view = new Uint8Array(event.data);
				// moonlight-web WebSocketChannel: video frames carry an IDR flag next.
				if (view[0] === 1) {
					s.ws.video++;
					if (view[1] === 1) {
						s.ws.videoKey++;
						s.ws.firstKeyAt ||= Date.now() - s.startedAt;
					}
				} else if (view[0] === 0) s.ws.control++;
				else s.ws.other++;
			});
		}
	};
	const NativeDecoder = window.VideoDecoder;
	if (!NativeDecoder) return;
	window.VideoDecoder = class extends NativeDecoder {
		constructor(init: VideoDecoderInit) {
			s.decoder.instances++;
			super({
				output: (frame) => {
					s.decoder.output++;
					s.decoder.firstOutputAt ||= Date.now() - s.startedAt;
					init.output(frame);
				},
				error: (error) => {
					s.decoder.errors.push(String(error).slice(0, 300));
					init.error(error);
				},
			});
		}
		override configure(config: VideoDecoderConfig) {
			s.decoder.configure++;
			s.decoder.codec = config.codec;
			super.configure(config);
		}
		override decode(chunk: EncodedVideoChunk) {
			if (chunk.type === "key") s.decoder.key++;
			else s.decoder.delta++;
			super.decode(chunk);
			s.decoder.maxQueue = Math.max(s.decoder.maxQueue, this.decodeQueueSize);
		}
		override reset() {
			s.decoder.reset++;
			super.reset();
		}
	};
}

/** Viewer-side counters plus video element and WebRTC inbound video stats. */
export async function viewerStats(page: Page): Promise<unknown> {
	return await page.evaluate(async () => {
		const w = window as unknown as {
			__s10Viewer?: unknown;
			__s10Peers?: RTCPeerConnection[];
		};
		const videos = [...document.querySelectorAll("video")].map((v) => ({
			readyState: v.readyState,
			width: v.videoWidth,
			height: v.videoHeight,
			currentTime: v.currentTime,
			paused: v.paused,
			quality: v.getVideoPlaybackQuality?.(),
		}));
		const inbound: unknown[] = [];
		for (const peer of w.__s10Peers ?? []) {
			const stats = await peer.getStats();
			for (const item of stats.values())
				if (item.type === "inbound-rtp" && item.kind === "video")
					inbound.push({
						connectionState: peer.connectionState,
						framesReceived: item.framesReceived,
						framesDecoded: item.framesDecoded,
						keyFramesDecoded: item.keyFramesDecoded,
						framesDropped: item.framesDropped,
						packetsLost: item.packetsLost,
						nackCount: item.nackCount,
						pliCount: item.pliCount,
						firCount: item.firCount,
						freezeCount: item.freezeCount,
						decoderImplementation: item.decoderImplementation,
					});
		}
		return { viewer: w.__s10Viewer, videos, inbound };
	});
}

/** Headless Chromium that trusts only the pinned dev gateway and TURN leaves. */
export async function launchViewerBrowser() {
	return await chromium.launch({
		headless: true,
		args: [
			"--autoplay-policy=no-user-gesture-required",
			...(process.env.UMIAK_DESKTOP_BROWSER_SPKI
				? [
						`--ignore-certificate-errors-spki-list=${process.env.UMIAK_DESKTOP_BROWSER_SPKI}`,
					]
				: []),
		],
	});
}

export async function verifyDesktopMedia(
	sb: Sandbox,
	output: string,
	onWebRtcReady?: () => Promise<void>,
	naturalCloseLast = false,
	/** Collects guest logs before the page closes and EndStreams restarts moonlight-web. */
	onFailure?: (label: string) => Promise<void>,
) {
	const protocols = (process.env.UMIAK_DESKTOP_TURN_TRANSPORTS ?? "udp").split(
		",",
	);
	if (protocols.some((p) => !["udp", "tcp", "tls"].includes(p)))
		throw new Error("invalid TURN verification transport");
	const cases = ["websocket", ...protocols.map((p) => `webrtc-${p}`)];
	const browser = await launchViewerBrowser();

	try {
		for (const [index, label] of cases.entries()) {
			const transport = label === "websocket" ? "websocket" : "webrtc";
			const protocol = label.slice("webrtc-".length);
			const page = await browser.newPage({
				viewport: { width: 1280, height: 800 },
			});
			await page.addInitScript(instrumentViewer);
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
				console.log(
					`${label} viewer stats`,
					JSON.stringify(await viewerStats(page)),
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
				// Each step is best effort: the original error is what the run reports.
				await writeFile(
					join(output, `${label}-stats.json`),
					JSON.stringify(await viewerStats(page).catch(String), null, 2),
					{ mode: 0o600 },
				).catch(() => undefined);
				await sb.desktop
					.screenshot({ cursor: "false" })
					.then((shot) =>
						writeFile(
							join(output, `${label}-agent-screenshot.png`),
							shot.bytes,
							{
								mode: 0o600,
							},
						),
					)
					.catch(() => undefined);
				await onFailure?.(label).catch((e: unknown) =>
					console.log(`guest diagnostics failed: ${String(e).slice(0, 200)}`),
				);
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
