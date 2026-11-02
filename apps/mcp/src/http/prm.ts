// OAuth Protected Resource Metadata of the remote MCP server (RFC 9728,
// S11 6.3) and the `WWW-Authenticate` challenges that point to it.

/** Scopes a client asks the authorization server for; never offline_access. */
export const PRM_SCOPES = ["openid", "email", "profile"] as const;

export const RESOURCE_NAME = "umiak sandboxes";

/**
 * Path of the metadata document: the well-known prefix in front of the
 * resource path (`/mcp` -> `/.well-known/oauth-protected-resource/mcp`).
 */
export function prmPath(publicUrl: string): string {
	const path = new URL(publicUrl).pathname.replace(/(.)\/+$/, "$1");
	return `/.well-known/oauth-protected-resource${path === "/" ? "" : path}`;
}

/** Absolute URL of the metadata document, on the origin of the public URL. */
export function prmUrl(publicUrl: string): string {
	return `${new URL(publicUrl).origin}${prmPath(publicUrl)}`;
}

export function protectedResourceMetadata(o: {
	publicUrl: string;
	issuer: string | null;
}): Record<string, unknown> {
	return {
		resource: o.publicUrl,
		// Without an issuer no authorization server is named (not an empty list).
		...(o.issuer === null ? {} : { authorization_servers: [o.issuer] }),
		scopes_supported: [...PRM_SCOPES],
		bearer_methods_supported: ["header"],
		resource_name: RESOURCE_NAME,
	};
}

/**
 * A quoted-string of RFC 6750: `"` and `\` are not allowed in its values
 * (NQSCHAR), so they are replaced, not escaped; other characters outside
 * printable ASCII become spaces.
 */
function quoted(v: string): string {
	const safe = v
		.replaceAll('"', "'")
		.replaceAll("\\", "/")
		.replace(/[^\x20-\x7e]/g, " ");
	return `"${safe}"`;
}

/** `Bearer resource_metadata="..."[, error="...", error_description="..."]` (RFC 6750 3). */
export function bearerChallenge(
	metadataUrl: string,
	error?: { error: string; description?: string },
): string {
	let v = `Bearer resource_metadata=${quoted(metadataUrl)}`;
	if (error !== undefined) {
		v += `, error=${quoted(error.error)}`;
		if (error.description !== undefined) {
			v += `, error_description=${quoted(error.description)}`;
		}
	}
	return v;
}
