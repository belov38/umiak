export type BearerKind = "team_key" | "reserved" | "jwt" | "invalid";

const JWS_COMPACT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** Classify a bearer token by shape only (S7 §7.10); nothing is verified. */
export function classifyBearer(token: string): BearerKind {
	if (token.startsWith("sbxs_")) return "reserved";
	if (token.startsWith("sbx_")) return "team_key";
	if (JWS_COMPACT_RE.test(token)) return "jwt";
	return "invalid";
}
