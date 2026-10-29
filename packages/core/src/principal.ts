// Caller identity passed by `api` to SandboxService (S7 §7.5).

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

export interface Principal {
	/** browser session, Keycloak JWT (S7 §7.10) or team API key (S7 §7.2) */
	kind: "session" | "oidc" | "team_key";
	/** Payload user id; null for team keys. */
	userId: string | null;
	teamId: string;
	/** Team role from S8; null for team keys. */
	role: "owner" | "member" | null;
	/** Platform operator (IdP group, S8); browser sessions only. */
	isOperator: boolean;
	/** Team keys only. */
	apiKeyId?: string;
	scopes: readonly Scope[];
}

/** Principal id of idempotency keys: the API key, else the user (decision 9). */
export function idempotencyPrincipal(p: Principal): string {
	const id = p.apiKeyId ?? p.userId;
	if (id === null || id === undefined || id === "") {
		throw new Error(
			"idempotencyPrincipal: principal has neither apiKeyId nor userId",
		);
	}
	return id;
}
