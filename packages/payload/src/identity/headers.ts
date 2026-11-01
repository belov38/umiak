// oauth2-proxy identity headers (S8 §5.1, §5.2). Only oauth2-proxy (or the
// dev auth proxy, outside the image) sets them; web trusts them because
// nothing else reaches its port.
import type { SessionHeaders } from "@umiak/auth";

export type HeaderSource =
	| Headers
	| Record<string, string | string[] | undefined>;

export const AUTH_HEADERS = {
	email: "x-auth-request-email",
	user: "x-auth-request-user",
	groups: "x-auth-request-groups",
	preferredUsername: "x-auth-request-preferred-username",
} as const;

/** Every value of a header (case-insensitive name). */
function values(h: HeaderSource, name: string): string[] {
	if (h instanceof Headers) {
		const v = h.get(name);
		return v === null ? [] : [v];
	}
	const out: string[] = [];
	for (const [k, v] of Object.entries(h)) {
		if (k.toLowerCase() !== name || v === undefined) continue;
		if (Array.isArray(v)) out.push(...v);
		else out.push(v);
	}
	return out;
}

/** The first non-empty trimmed value, or undefined. */
function single(h: HeaderSource, name: string): string | undefined {
	for (const v of values(h, name)) {
		const s = v.trim();
		if (s !== "") return s;
	}
	return undefined;
}

/**
 * Exactly one non-empty trimmed value without a comma, else undefined.
 * Repeated headers arrive as several values or joined with ", " (Headers,
 * Node); picking one of them would let whoever added the second choose.
 */
function strict(h: HeaderSource, name: string): string | undefined {
	const all = values(h, name)
		.map((v) => v.trim())
		.filter((v) => v !== "");
	if (all.length !== 1) return undefined;
	const v = all[0] as string;
	return v.includes(",") ? undefined : v;
}

/**
 * oauth2-proxy's keycloak-oidc provider adds the realm and client roles to
 * X-Auth-Request-Groups as `role:<name>`. They are not IdP groups: the
 * Keycloak JWT of CLI, SDK and MCP carries only the `groups` claim, and a
 * browser and a CLI login of one user must store the same `users.groups`.
 */
export function isRoleEntry(group: string): boolean {
	return group.startsWith("role:");
}

/**
 * S8 §5.2: email (lowercased, trimmed; required, else null; an empty,
 * repeated or comma-joined value counts as none), user (`sub`; the same
 * rule: an empty, repeated or comma-joined value counts as none),
 * groups (one comma-separated value or several values; split by `,`,
 * trimmed, empty and duplicate names dropped; names with a comma are not
 * supported; `role:<name>` entries dropped, see isRoleEntry),
 * preferredUsername. A missing `user` is kept as undefined:
 * resolveSession answers subject_required.
 */
export function parseAuthHeaders(h: HeaderSource): SessionHeaders | null {
	const e = strict(h, AUTH_HEADERS.email)?.toLowerCase();
	if (e === undefined) return null;
	const groups = [
		...new Set(
			values(h, AUTH_HEADERS.groups)
				.flatMap((v) => v.split(","))
				.map((g) => g.trim())
				.filter((g) => g !== "" && !isRoleEntry(g)),
		),
	];
	const out: SessionHeaders = { email: e, groups };
	const user = strict(h, AUTH_HEADERS.user);
	if (user !== undefined) out.user = user;
	const preferredUsername = single(h, AUTH_HEADERS.preferredUsername);
	if (preferredUsername !== undefined) {
		out.preferredUsername = preferredUsername;
	}
	return out;
}
