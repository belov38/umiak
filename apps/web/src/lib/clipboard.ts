// Clipboard API is unavailable on plain LAN HTTP.
export async function copyText(text: string): Promise<void> {
	if (navigator.clipboard) {
		try {
			await navigator.clipboard.writeText(text);
			return;
		} catch {
			// Browser permission or iframe policy may deny the Clipboard API.
		}
	}
	const input = document.createElement("textarea");
	input.value = text;
	input.style.position = "fixed";
	input.style.opacity = "0";
	document.body.append(input);
	try {
		input.select();
		if (!document.execCommand("copy")) throw new Error("Copy failed");
	} finally {
		input.remove();
	}
}
