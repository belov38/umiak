/** The standard tunnel endpoint fits firmware with at most 143 ASCII hostname bytes. */
export const PINNED_TUNNEL_HOST_MAX = 143;
export function skuForTunnelCA(pin: string): string {
	if (!/^[a-f0-9]{64}$/.test(pin))
		throw new Error("Invalid tunnel CA SHA-256 fingerprint");
	return `umiakca1:${pin}`;
}
/** Validate at configuration time, after IDN normalization, including port/path overhead. */
export function validatePinnedTunnelUrl(value: string): string {
	const u = new URL(value);
	if (
		u.protocol !== "wss:" ||
		!u.hostname ||
		u.username ||
		u.password ||
		u.hash ||
		u.search ||
		!/^wss:\/\/[^/]/.test(value)
	)
		throw new Error(
			"Tunnel URL must use wss with a hostname and no credentials, query or fragment",
		);
	const normalized = u.toString();
	// 512-character smbios1: UUID + 32-byte BS serial + family + SHA-256 CA SKU.
	// The fixed fields leave 224 base64 characters for the family: 168 raw bytes.
	const max = Math.max(
		0,
		160 - Buffer.byteLength(normalized) + Buffer.byteLength(u.hostname),
	);
	if (Buffer.byteLength(u.hostname) > max)
		throw new Error(
			`tunnel hostname too long; use a shorter name (max ${max} chars)`,
		);
	return normalized;
}
