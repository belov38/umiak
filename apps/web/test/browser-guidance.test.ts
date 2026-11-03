import { describe, expect, it } from "vitest";
import {
	desktopBrowserGuidance,
	tailnetExposureWarning,
} from "../src/lib/browser-guidance";

describe("browser connection guidance", () => {
	it("warns only for a ts.net hostname, including mixed case and a trailing DNS dot", () => {
		for (const hostname of ["umiak.tail123.ts.net", "UMIAK.tail123.TS.NET."]) {
			expect(tailnetExposureWarning(hostname)).toContain(
				"if you use Funnel, this is public",
			);
			expect(tailnetExposureWarning(hostname)).toContain("Tailscale Serve");
		}
		for (const hostname of [
			"localhost",
			"192.168.1.20",
			"ts.net.evil.example",
			"notts.net",
		]) {
			expect(tailnetExposureWarning(hostname)).toBeNull();
		}
	});
	it("explains how to open an HTTPS desktop from an insecure LAN dashboard", () => {
		const guidance = desktopBrowserGuidance({
			secureContext: false,
			webCodecs: false,
			webRTC: true,
		});
		expect(guidance).toContain("Tailscale Serve");
		expect(guidance).toContain("localhost");
		expect(guidance).toContain("HTTPS proxy");
		expect(guidance).toContain("new tab");
	});
	it("identifies missing video APIs without blocking supported browsers", () => {
		expect(
			desktopBrowserGuidance({
				secureContext: true,
				webCodecs: true,
				webRTC: true,
			}),
		).toBeNull();
		expect(
			desktopBrowserGuidance({
				secureContext: true,
				webCodecs: false,
				webRTC: true,
			}),
		).toContain("WebCodecs");
		expect(
			desktopBrowserGuidance({
				secureContext: true,
				webCodecs: true,
				webRTC: false,
			}),
		).toContain("WebRTC");
	});
});

it("offers the explicit localhost tunnel and opt-in Chrome test path", () => {
	const guidance = desktopBrowserGuidance({
		secureContext: false,
		webCodecs: false,
		webRTC: true,
	});
	expect(guidance).toContain("ssh -L 4180:localhost:4180 <docker-host>");
	expect(guidance).toContain("http://localhost:4180");
	expect(guidance).toContain(
		"chrome://flags/#unsafely-treat-insecure-origin-as-secure",
	);
	expect(guidance).toContain("weakens browser protection");
});

it("shows gateway CA and leaf expiry dates and the rotation warning", async () => {
	const { certificateExpiryLines } = await import(
		"../src/lib/browser-guidance"
	);
	expect(
		certificateExpiryLines({
			caExpiresAt: "2027-01-01T00:00:00.000Z",
			tunnelExpiresAt: "2026-12-01T00:00:00.000Z",
			previewExpiresAt: "2026-12-02T00:00:00.000Z",
			warning:
				"CA expires soon; rotation requires rebuilding agent packages and templates.",
		}),
	).toEqual([
		"Guest CA expires: 2027-01-01T00:00:00.000Z",
		"Tunnel certificate expires: 2026-12-01T00:00:00.000Z",
		"Preview certificate expires: 2026-12-02T00:00:00.000Z",
		"CA expires soon; rotation requires rebuilding agent packages and templates.",
	]);
	expect(certificateExpiryLines(null)).toEqual([]);
	expect(certificateExpiryLines({ caExpiresAt: null, warning: {} })).toEqual(
		[],
	);
});

it("explains all secure-context options when clipboard fallback fails on LAN HTTP", async () => {
	const { copyFailureGuidance } = await import("../src/lib/browser-guidance");
	expect(copyFailureGuidance(false)).toContain("select the text");
	expect(copyFailureGuidance(false)).toContain("Tailscale Serve (recommended)");
	expect(copyFailureGuidance(false)).toContain(
		"ssh -L 4180:localhost:4180 <docker-host>",
	);
	expect(copyFailureGuidance(false)).toContain("HTTPS proxy");
	expect(copyFailureGuidance(false)).toContain(
		"chrome://flags/#unsafely-treat-insecure-origin-as-secure",
	);
	expect(copyFailureGuidance(true)).not.toContain("chrome://flags");
});

it("warns about an HTTP viewer even inside an HTTPS dashboard", () => {
	const guidance = desktopBrowserGuidance({
		secureContext: true,
		webCodecs: true,
		webRTC: true,
		viewerUrl: "http://box-desktop.umiak.100-64-0-1.sslip.io:8085/",
	});
	expect(guidance).toContain("HTTP viewer");
	expect(guidance).toContain("dashboard alone");
	expect(guidance).toContain("viewer origin");
});
