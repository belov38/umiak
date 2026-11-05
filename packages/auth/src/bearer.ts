export type BearerKind = "team_key" | "reserved" | "invalid";

/** Classify a bearer token by shape only (S7 §7.10); nothing is verified. */
export function classifyBearer(token: string): BearerKind {
	if (token.startsWith("umiaks_")) return "reserved";
	if (token.startsWith("umiak_")) return "team_key";
	return "invalid";
}
