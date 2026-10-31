/** Largest file files_read returns as an MCP image (S11 8.4, 9.2). */
export const IMAGE_MAX_BYTES = 3 * 1024 * 1024;

export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

function startsWith(head: Uint8Array, bytes: number[], at = 0): boolean {
	return (
		head.length >= at + bytes.length &&
		bytes.every((b, i) => head[at + i] === b)
	);
}

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** The image type of the first bytes of a file (magic numbers), or null. */
export function sniffImage(head: Uint8Array): ImageMime | null {
	if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
		return "image/png";
	}
	if (startsWith(head, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (startsWith(head, ascii("GIF87a")) || startsWith(head, ascii("GIF89a"))) {
		return "image/gif";
	}
	if (startsWith(head, ascii("RIFF")) && startsWith(head, ascii("WEBP"), 8)) {
		return "image/webp";
	}
	return null;
}
