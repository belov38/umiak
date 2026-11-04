export function desktopBrowserGuidance(capabilities: {
	secureContext: boolean;
	webCodecs: boolean;
	webRTC: boolean;
}): string | null {
	if (!capabilities.secureContext)
		return "The embedded desktop viewer needs a secure browser context for WebCodecs. Open this deployment at its tailnet HTTPS address.";
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

export function copyFailureGuidance(): string {
	return "Could not copy: select the text and copy it yourself.";
}
