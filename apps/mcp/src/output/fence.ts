import { randomBytes } from "node:crypto";
import { sanitizeForLlm } from "./sanitize.ts";

const MAX_NONCE_TRIES = 32;

function randomNonce(): string {
	return randomBytes(3).toString("hex");
}

/**
 * Wraps sandbox text in blocks that only the server can close: the closing
 * line carries a random nonce shared by the whole response, and a nonce that
 * appears in the data as a closing line is never used.
 */
export function fenceUntrusted(
	blocks: { label: string; text: string }[],
	rand: () => string = randomNonce,
): string {
	const texts = blocks.map((b) => sanitizeForLlm(b.text));
	for (let i = 0; i < MAX_NONCE_TRIES; i++) {
		const nonce = rand();
		const marker = `<<<end id=${nonce}`;
		if (texts.some((t) => t.includes(marker))) continue;
		return blocks
			.map(
				(b, n) =>
					`<<<umiak-untrusted id=${nonce} ${b.label}>>>\n${texts[n]}\n<<<end id=${nonce}>>>`,
			)
			.join("\n");
	}
	throw new Error("could not pick a fence nonce absent from the data");
}
