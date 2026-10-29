import type { Scope } from "./scopes.ts";

// IdentityStore contract (S7 §17.3). Ids are UUIDs (internal form, not public ids).

export interface UserRecord {
	id: string;
	email: string;
	name: string | null;
	active: boolean;
	isOperator: boolean;
	idpSubject: string | null;
	defaultTeamId: string | null;
}

export interface TeamMembership {
	teamId: string;
	name: string;
	role: "owner" | "member";
}

export interface SessionIdentity {
	user: UserRecord;
	teams: TeamMembership[];
	defaultTeamId: string | null;
	isOperator: boolean;
}

/** Identity claims from oauth2-proxy headers or Keycloak JWT claims. */
export interface SessionHeaders {
	email: string;
	user?: string;
	groups: string[];
	preferredUsername?: string;
	name?: string;
}

export interface ApiKeyCreator {
	id: string;
	email: string;
	active: boolean;
	/** Still a member of the key's team. */
	member: boolean;
}

export interface ApiKeyRecord {
	id: string;
	kind: "team";
	sandboxId: null;
	teamId: string;
	name: string;
	secretHash: string;
	prefix: string;
	last4: string;
	scopes: Scope[];
	createdBy: ApiKeyCreator | null;
	createdVia: "api" | "cli" | "dashboard";
	createdAt: Date;
	expiresAt: Date;
	lastUsedAt: Date | null;
	revokedAt: Date | null;
}

export interface NewApiKey {
	teamId: string;
	name: string;
	scopes: Scope[];
	expiresAt: Date;
	createdByUserId: string | null;
	createdVia: "api" | "cli" | "dashboard";
	secretHash: string;
	prefix: string;
	last4: string;
}

export interface SshKeyRecord {
	id: string;
	userId: string;
	name: string;
	publicKey: string;
	fingerprint: string;
	type: string;
	createdAt: Date;
	lastUsedAt: Date | null;
}

export interface NewSshKey {
	userId: string;
	name: string;
	publicKey: string;
	fingerprint: string;
	type: string;
}

export interface IdentityStore {
	/** JIT upsert of the user (and the personal team) from IdP claims. */
	resolveSession(h: SessionHeaders): Promise<SessionIdentity>;
	findApiKeyByHash(sha256Hex: string): Promise<ApiKeyRecord | null>;
	/** The secret hash is computed by the caller (`apiKeyHash`). */
	createApiKey(input: NewApiKey): Promise<ApiKeyRecord>;
	/** Replace the secret of a key, keeping id, scopes and expiry. */
	rotateApiKey(
		id: string,
		s: { secretHash: string; prefix: string; last4: string },
	): Promise<ApiKeyRecord>;
	revokeApiKey(
		id: string,
		by: { userId?: string; apiKeyId?: string },
	): Promise<void>;
	/** Team keys with the creator status. */
	listApiKeys(q: { teamId: string }): Promise<ApiKeyRecord[]>;
	touchApiKey(id: string): Promise<void>;
	listSshKeys(userId: string): Promise<SshKeyRecord[]>;
	/** Throws IdentityError("fingerprint_taken") if the fingerprint exists. */
	addSshKey(input: NewSshKey): Promise<SshKeyRecord>;
	removeSshKey(userId: string, id: string): Promise<void>;
	findSshKeyByFingerprint(fp: string): Promise<SshKeyRecord | null>;
	touchSshKey(id: string): Promise<void>;
	membership(
		userId: string,
		teamId: string,
	): Promise<{ role: "owner" | "member" } | null>;
	team(teamId: string): Promise<{ id: string; name: string } | null>;
	user(userId: string): Promise<UserRecord | null>;
}

export type IdentityErrorCode =
	| "user_disabled"
	| "fingerprint_taken"
	| "not_found"
	| "name_taken"
	/**
	 * The IdP identity clashes with another account (S8 §5.3): the email is
	 * bound to another `sub`, or a changed email belongs to another user.
	 * The api answers 403; an operator resolves it.
	 */
	| "identity_conflict";

export class IdentityError extends Error {
	readonly code: IdentityErrorCode;

	constructor(code: IdentityErrorCode, message?: string) {
		super(message ?? code);
		this.name = "IdentityError";
		this.code = code;
	}
}
