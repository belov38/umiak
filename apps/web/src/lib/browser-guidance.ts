export const secureContextGuidance =
	"Use Tailscale Serve (recommended), localhost or your own HTTPS proxy. For localhost, run ssh -L 4180:localhost:4180 <docker-host> and open http://localhost:4180. For a quick Chrome test only, add this origin at chrome://flags/#unsafely-treat-insecure-origin-as-secure; this weakens browser protection.";

export function tailnetExposureWarning(hostname: string): string | null {
	if (!hostname.toLowerCase().replace(/\.$/, "").endsWith(".ts.net"))
		return null;
	return "Tailscale: if you use Funnel, this is public. Use Tailscale Serve to keep this dashboard private to your tailnet.";
}

export function desktopBrowserGuidance(capabilities: {
	secureContext: boolean;
	webCodecs: boolean;
	webRTC: boolean;
	viewerUrl?: string;
}): string | null {
	if (capabilities.viewerUrl) {
		const viewer = new URL(capabilities.viewerUrl);
		if (
			viewer.protocol === "http:" &&
			!(
				viewer.hostname === "localhost" ||
				viewer.hostname.endsWith(".localhost") ||
				viewer.hostname === "[::1]" ||
				/^127(?:\.\d{1,3}){3}$/.test(viewer.hostname)
			)
		)
			return `The HTTP viewer needs a secure context for video decoding. HTTPS on the dashboard alone does not secure this separate viewer origin (${viewer.origin}). Use an HTTPS proxy for the viewer or open it separately with the Chrome test override for that exact viewer origin. ${secureContextGuidance}`;
	}
	if (!capabilities.secureContext)
		return `The embedded desktop viewer needs a secure browser context for WebCodecs. ${secureContextGuidance} Opening a separately hosted HTTPS viewer in a new tab avoids an insecure parent page.`;
	if (!capabilities.webCodecs)
		return "WebCodecs is unavailable in this browser. Use a browser with WebCodecs support for WebSocket video, or try the WebRTC transport.";
	if (!capabilities.webRTC)
		return "WebRTC is unavailable in this browser. Use a browser with WebRTC support or the WebSocket transport.";
	return null;
}

export function certificateExpiryLines(value: unknown): string[] {
	if (!value || typeof value !== "object") return [];
	const status = value as Record<string, unknown>;
	const lines: string[] = [];
	for (const [key, label] of [
		["caExpiresAt", "Guest CA expires"],
		["tunnelExpiresAt", "Tunnel certificate expires"],
		["previewExpiresAt", "Preview certificate expires"],
	] as const) {
		if (typeof status[key] === "string") lines.push(`${label}: ${status[key]}`);
	}
	if (typeof status.warning === "string" && status.warning)
		lines.push(status.warning);
	return lines;
}

export function copyFailureGuidance(secureContext: boolean): string {
	return `Could not copy: select the text and copy it yourself.${secureContext ? "" : ` ${secureContextGuidance}`}`;
}
