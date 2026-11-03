import { describe, expect, it } from "vitest";
import { desktopBrowserGuidance } from "../src/lib/browser-guidance";

describe("browser connection guidance", () => {
	it("points an insecure context at the tailnet HTTPS address without browser-flag advice", () => {
		const guidance = desktopBrowserGuidance({
			secureContext: false,
			webCodecs: false,
			webRTC: true,
		});
		expect(guidance).toContain("secure browser context");
		expect(guidance).toContain("tailnet HTTPS address");
		for (const legacy of ["chrome://flags", "ssh -L", "LAN", "Funnel"])
			expect(guidance).not.toContain(legacy);
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

it("keeps clipboard failure guidance to manual copying", async () => {
	const { copyFailureGuidance } = await import("../src/lib/browser-guidance");
	expect(copyFailureGuidance()).toContain("select the text");
	expect(copyFailureGuidance()).not.toContain("chrome://flags");
});
