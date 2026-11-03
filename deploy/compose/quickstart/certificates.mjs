import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
export async function gatewayCertificates(
	dir = "/gateway-secrets",
	now = Date.now(),
) {
	const expiry = async (name) => {
		try {
			return new Date(
				new X509Certificate(await readFile(join(dir, name))).validTo,
			).toISOString();
		} catch (error) {
			if (error.code === "ENOENT") return null;
			throw error;
		}
	};
	const [caExpiresAt, tunnelExpiresAt, previewExpiresAt] = await Promise.all(
		["ca.pem", "tunnel.pem", "umiak.pem"].map(expiry),
	);
	const warning =
		caExpiresAt && new Date(caExpiresAt).getTime() - now <= 365 * 86400000
			? "Guest gateway CA expires within one year. CA rotation requires rebuilding agent packages and templates; existing agents pin this CA. Plan rotation before expiry."
			: null;
	return { caExpiresAt, tunnelExpiresAt, previewExpiresAt, warning };
}
