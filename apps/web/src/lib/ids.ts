// Dashboard-only ids of rows that have no public id in /api/v1 (S7 §5.3):
// memberships (`mbr_…`). Same encoding as the
// public ids (Crockford base32 over the 128-bit Payload UUID), so the
// browser never sees a raw UUID. They are not accepted anywhere but the
// server actions of web.
import { decodeUuid, encodeUuid } from "@umiak/auth";

export type DashboardIdKind = "membership";

const PREFIX: Record<DashboardIdKind, string> = {
	membership: "mbr_",
};

// Any registered kind carries the body; "user" is only the carrier here.
const CARRIER = "usr_";

export function encodeDashboardId(kind: DashboardIdKind, uuid: string): string {
	return PREFIX[kind] + encodeUuid("user", uuid).slice(CARRIER.length);
}

/** The UUID, or null on any format error. */
export function decodeDashboardId(
	kind: DashboardIdKind,
	id: unknown,
): string | null {
	if (typeof id !== "string") return null;
	const prefix = PREFIX[kind];
	if (id.slice(0, prefix.length).toLowerCase() !== prefix) return null;
	return decodeUuid("user", CARRIER + id.slice(prefix.length));
}
