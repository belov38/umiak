// Identity helpers for tests: an in-memory IdentityStore with fixed keys and
// sessions (tests without Postgres) and `issueApiKey` for any store.
import { randomUUID } from "node:crypto";
import {
	type ApiKeyRecord,
	apiKeyDisplay,
	apiKeyHash,
	generateApiKeySecret,
	IdentityError,
	type IdentityStore,
	SCOPES,
	type Scope,
	type SessionHeaders,
	type SessionIdentity,
	type TeamMembership,
	type UserRecord,
} from "@sbx/auth";

export interface TestKeySpec {
	secret: string;
	id?: string;
	teamId: string;
	teamName?: string;
	/** Default: every scope. */
	scopes?: Scope[];
	expiresAt?: Date;
	revokedAt?: Date | null;
}

export interface TestSessionSpec {
	/** IdP subject (X-Auth-Request-User or JWT `sub`). */
	sub: string;
	email?: string;
	teams: TeamMembership[];
	defaultTeamId?: string;
	isOperator?: boolean;
	active?: boolean;
}

export interface TestIdentityOptions {
	keys?: TestKeySpec[];
	sessions?: TestSessionSpec[];
}

/**
 * Team key of the default test store (`makeTestDeps`), all scopes. Random
 * per process, so no key-shaped literal sits in the repository.
 */
export const TEST_API_KEY = generateApiKeySecret();
export const TEST_TEAM_ID = "0192f5a8-0000-7000-8000-000000000001";
export const TEST_TEAM_NAME = "test team";

function notImplemented(name: string): never {
	throw new Error(`testIdentityStore: ${name} is not implemented`);
}

/**
 * IdentityStore over fixed data: keys by secret, sessions by `sub` (a
 * session needs a known sub; `active: false` -> user_disabled). Everything
 * else throws. For tests that need no Postgres.
 */
export function testIdentityStore(o: TestIdentityOptions = {}): IdentityStore {
	const keys = new Map<string, ApiKeyRecord>();
	const teams = new Map<string, string>();
	for (const k of o.keys ?? []) {
		const d = apiKeyDisplay(k.secret);
		teams.set(k.teamId, k.teamName ?? TEST_TEAM_NAME);
		keys.set(apiKeyHash(k.secret), {
			id: k.id ?? randomUUID(),
			kind: "team",
			sandboxId: null,
			teamId: k.teamId,
			name: "test key",
			secretHash: apiKeyHash(k.secret),
			prefix: d.prefix,
			last4: d.last4,
			scopes: k.scopes ?? [...SCOPES],
			createdBy: null,
			createdVia: "api",
			createdAt: new Date(),
			expiresAt: k.expiresAt ?? new Date(Date.now() + 86_400_000),
			lastUsedAt: null,
			revokedAt: k.revokedAt ?? null,
			rotatedAt: null,
		});
	}
	const sessions = new Map<string, SessionIdentity & { active: boolean }>();
	for (const s of o.sessions ?? []) {
		for (const t of s.teams) teams.set(t.teamId, t.name);
		const user: UserRecord = {
			id: randomUUID(),
			email: s.email ?? `${s.sub}@example.com`,
			name: null,
			active: s.active ?? true,
			isOperator: s.isOperator ?? false,
			idpSubject: s.sub,
			defaultTeamId: s.defaultTeamId ?? s.teams[0]?.teamId ?? null,
		};
		sessions.set(s.sub, {
			user,
			teams: s.teams,
			defaultTeamId: user.defaultTeamId,
			isOperator: user.isOperator,
			active: user.active,
		});
	}
	return {
		async resolveSession(h: SessionHeaders) {
			const sub = h.user?.trim() ?? "";
			if (sub === "") throw new IdentityError("subject_required");
			const s = sessions.get(sub);
			if (s === undefined) return notImplemented(`resolveSession(${sub})`);
			if (!s.active) throw new IdentityError("user_disabled");
			const { active: _, ...identity } = s;
			return identity;
		},
		async findApiKeyByHash(hash) {
			return keys.get(hash) ?? null;
		},
		async apiKey(id) {
			return [...keys.values()].find((k) => k.id === id) ?? null;
		},
		async touchApiKey() {},
		async team(teamId) {
			const name = teams.get(teamId);
			return name === undefined ? null : { id: teamId, name };
		},
		async membership(userId, teamId) {
			for (const s of sessions.values()) {
				if (s.user.id !== userId) continue;
				const m = s.teams.find((t) => t.teamId === teamId);
				return m === undefined ? null : { role: m.role };
			}
			return null;
		},
		async user(userId) {
			for (const s of sessions.values())
				if (s.user.id === userId) return s.user;
			return null;
		},
		createApiKey: () => notImplemented("createApiKey"),
		rotateApiKey: () => notImplemented("rotateApiKey"),
		revokeApiKey: () => notImplemented("revokeApiKey"),
		listApiKeys: () => notImplemented("listApiKeys"),
		listSshKeys: () => notImplemented("listSshKeys"),
		addSshKey: () => notImplemented("addSshKey"),
		removeSshKey: () => notImplemented("removeSshKey"),
		findSshKeyByFingerprint: () => notImplemented("findSshKeyByFingerprint"),
		touchSshKey: () => notImplemented("touchSshKey"),
	};
}

export interface IssueApiKeyOptions {
	teamId: string;
	/** Default: every scope. */
	scopes?: Scope[];
	/** Default: in 90 days. */
	expiresAt?: Date;
	name?: string;
	createdByUserId?: string | null;
	createdVia?: ApiKeyRecord["createdVia"];
}

/** Issues a team key through the store; returns the secret (shown once) and the record. */
export async function issueApiKey(
	identity: IdentityStore,
	o: IssueApiKeyOptions,
): Promise<{ secret: string; key: ApiKeyRecord }> {
	const secret = generateApiKeySecret();
	const key = await identity.createApiKey({
		teamId: o.teamId,
		name: o.name ?? `key-${randomUUID().slice(0, 8)}`,
		scopes: o.scopes ?? [...SCOPES],
		expiresAt: o.expiresAt ?? new Date(Date.now() + 90 * 86_400_000),
		createdByUserId: o.createdByUserId ?? null,
		createdVia: o.createdVia ?? "api",
		secretHash: apiKeyHash(secret),
		...apiKeyDisplay(secret),
	});
	return { secret, key };
}
