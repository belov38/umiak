/** Scopes of S7 §7.3 (part of the v1 contract: add only, never rename). */
export const SCOPES = [
	"sandboxes:read",
	"sandboxes:write",
	"sandboxes:delete",
	"commands:read",
	"commands:exec",
	"files:read",
	"files:write",
	"ports:write",
	"ssh:connect",
	"snapshots:read",
	"snapshots:write",
	"environments:read",
	"environments:write",
	"keys:admin",
] as const;
export type Scope = (typeof SCOPES)[number];

const SCOPE_SET: ReadonlySet<string> = new Set(SCOPES);

export function isScope(s: string): s is Scope {
	return SCOPE_SET.has(s);
}

/** Presets a team owner can pick when issuing a key (S7 §7.3). */
export const PRESETS: Record<"read-only" | "ci" | "full", readonly Scope[]> = {
	"read-only": [
		"sandboxes:read",
		"commands:read",
		"files:read",
		"snapshots:read",
		"environments:read",
	],
	ci: [
		"sandboxes:read",
		"sandboxes:write",
		"sandboxes:delete",
		"commands:read",
		"commands:exec",
		"files:read",
		"files:write",
		"ports:write",
		"snapshots:read",
		"environments:read",
	],
	full: SCOPES,
};

/** Reserved for `sandbox` keys (S7 §7.2); not issued in the MVP. */
export const SANDBOX_SELF_PRESET: readonly Scope[] = [
	"sandboxes:read",
	"commands:read",
	"commands:exec",
	"files:read",
	"files:write",
	"ports:write",
];
