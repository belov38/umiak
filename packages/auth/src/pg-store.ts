import type pg from "pg";
import {
	type ApiKeyRecord,
	IdentityError,
	type IdentityStore,
	type NewApiKey,
	type NewSshKey,
	type SessionHeaders,
	type SessionIdentity,
	type SshKeyRecord,
	type TeamMembership,
	type UserRecord,
} from "./identity.ts";
import { FK_VIOLATION, inTx, pgCode, UNIQUE_VIOLATION } from "./pg-util.ts";
import type { Scope } from "./scopes.ts";

// Postgres stand-in for IdentityStore until S8 (S7 plan decision 2): schema
// `identity` of migration 0300. Its triggers send NOTIFY umiak_identity
// '<collection>:<id>' (users, memberships, api-keys, ssh-keys) on every
// change, so this class never notifies itself. Migration 0302 adds NOTIFY
// umiak_ssh_revoke (S4 §9.5) with public ids, in the same transaction:
// `user:<usr_>` (deactivated), `member:<team_>:<usr_>` (membership removed),
// `key:<key_>` (revoked), `team:<team_>` (deleted).

export interface PgIdentityStoreOptions {
	pool: pg.Pool;
	/** Trusted internal session groups that make a user an operator. */
	operatorGroups: string[];
}

interface UserRow {
	id: string;
	email: string;
	name: string | null;
	active: boolean;
	is_operator: boolean;
	idp_subject: string | null;
	default_team_id: string | null;
}

interface ApiKeyRow {
	id: string;
	team_id: string;
	name: string;
	secret_hash: string;
	prefix: string;
	last4: string;
	scopes: string[];
	created_via: "api" | "cli" | "dashboard";
	created_at: Date;
	expires_at: Date;
	last_used_at: Date | null;
	revoked_at: Date | null;
	rotated_at: Date | null;
	cb_id: string | null;
	cb_email: string | null;
	cb_active: boolean | null;
	cb_member: boolean;
}

interface SshKeyRow {
	id: string;
	user_id: string;
	name: string;
	public_key: string;
	fingerprint: string;
	type: string;
	created_at: Date;
	last_used_at: Date | null;
}

const USER_COLS =
	"id, email, name, active, is_operator, idp_subject, default_team_id";

const API_KEY_SELECT = `
SELECT k.id, k.team_id, k.name, k.secret_hash, k.prefix, k.last4, k.scopes,
       k.created_via, k.created_at, k.expires_at, k.last_used_at, k.revoked_at,
       k.rotated_at, u.id AS cb_id, u.email AS cb_email, u.active AS cb_active,
       EXISTS (SELECT 1 FROM identity.memberships m
                WHERE m.user_id = k.created_by AND m.team_id = k.team_id) AS cb_member
  FROM identity.api_keys k
  LEFT JOIN identity.users u ON u.id = k.created_by`;

const SSH_COLS =
	"id, user_id, name, public_key, fingerprint, type, created_at, last_used_at";

/** Attempts of resolveSession when concurrent first logins collide. */
const RESOLVE_ATTEMPTS = 3;

function userOf(r: UserRow): UserRecord {
	return {
		id: r.id,
		email: r.email,
		name: r.name,
		active: r.active,
		isOperator: r.is_operator,
		idpSubject: r.idp_subject,
		defaultTeamId: r.default_team_id,
	};
}

function apiKeyOf(r: ApiKeyRow): ApiKeyRecord {
	return {
		id: r.id,
		kind: "team",
		sandboxId: null,
		teamId: r.team_id,
		name: r.name,
		secretHash: r.secret_hash,
		prefix: r.prefix,
		last4: r.last4,
		scopes: r.scopes as Scope[],
		createdBy:
			r.cb_id === null
				? null
				: {
						id: r.cb_id,
						email: r.cb_email ?? "",
						active: r.cb_active === true,
						member: r.cb_member,
					},
		createdVia: r.created_via,
		createdAt: r.created_at,
		expiresAt: r.expires_at,
		lastUsedAt: r.last_used_at,
		revokedAt: r.revoked_at,
		rotatedAt: r.rotated_at,
	};
}

function sshKeyOf(r: SshKeyRow): SshKeyRecord {
	return {
		id: r.id,
		userId: r.user_id,
		name: r.name,
		publicKey: r.public_key,
		fingerprint: r.fingerprint,
		type: r.type,
		createdAt: r.created_at,
		lastUsedAt: r.last_used_at,
	};
}

/** Name of the team created at the first login. */
export function personalTeamName(email: string): string {
	return `${email}'s team`;
}

export class PgIdentityStore implements IdentityStore {
	readonly #pool: pg.Pool;
	readonly #operatorGroups: ReadonlySet<string>;

	constructor(opts: PgIdentityStoreOptions) {
		this.#pool = opts.pool;
		this.#operatorGroups = new Set(opts.operatorGroups);
	}

	/**
	 * S8 §5.3: find by `sub`, else by email (and bind `sub`), else create the
	 * user with a personal team. `sub` is mandatory (S8 §5.3, C8): without it
	 * an email alone could resolve to, or create, an account that another IdP
	 * identity later takes over. Writes only what changed, so a repeated call
	 * with the same claims neither writes nor notifies.
	 */
	async resolveSession(h: SessionHeaders): Promise<SessionIdentity> {
		const sub = h.user?.trim() ?? "";
		if (sub === "") throw new IdentityError("subject_required");
		const email = h.email.trim().toLowerCase();
		const isOperator = h.groups.some((g) => this.#operatorGroups.has(g));
		for (let attempt = 1; ; attempt++) {
			try {
				return await inTx(this.#pool, (c) =>
					this.#resolve(c, email, sub, h, isOperator),
				);
			} catch (e) {
				// Concurrent first logins raced on the unique email or
				// idp_subject: the loser retries and finds the winner's row.
				if (pgCode(e) === UNIQUE_VIOLATION && attempt < RESOLVE_ATTEMPTS) {
					continue;
				}
				throw e;
			}
		}
	}

	async #resolve(
		c: pg.PoolClient,
		email: string,
		sub: string,
		h: SessionHeaders,
		isOperator: boolean,
	): Promise<SessionIdentity> {
		let row = (
			await c.query<UserRow>(
				`SELECT ${USER_COLS} FROM identity.users WHERE idp_subject = $1 FOR UPDATE`,
				[sub],
			)
		).rows[0];
		let userId: string;
		if (row) {
			userId = row.id;
			if (!row.active) throw new IdentityError("user_disabled");
			if (row.email !== email) await this.#changeEmail(c, row.id, email);
		} else {
			row = (
				await c.query<UserRow>(
					`SELECT ${USER_COLS} FROM identity.users WHERE email = $1 FOR UPDATE`,
					[email],
				)
			).rows[0];
			if (row) {
				userId = row.id;
				// The row may have been bound to this very sub by a concurrent
				// first login that committed while this one waited for the lock.
				if (row.idp_subject !== null && row.idp_subject !== sub) {
					// A new IdP account reusing the email must not get the old
					// account's teams and keys (S8 §5.3 item 2).
					throw new IdentityError(
						"identity_conflict",
						"the account is bound to another IdP identity",
					);
				}
				if (!row.active) throw new IdentityError("user_disabled");
				if (row.idp_subject === null) {
					// First login of a seeded user: bind it, add its personal team.
					await c.query(
						`UPDATE identity.users SET idp_subject = $2, name = COALESCE(name, $3)
						  WHERE id = $1`,
						[row.id, sub, displayName(email, h)],
					);
					await this.#ensurePersonalTeam(c, row.id, email, row.default_team_id);
				}
			} else {
				userId = await this.#createUser(c, email, sub, h, isOperator);
			}
		}
		await c.query(
			"UPDATE identity.users SET is_operator = $2 WHERE id = $1 AND is_operator <> $2",
			[userId, isOperator],
		);
		return this.#session(c, userId);
	}

	// The email changed in the session: take it over unless another account owns
	// it. S8 merges a never-logged-in placeholder here; the stand-in does not.
	async #changeEmail(
		c: pg.PoolClient,
		userId: string,
		email: string,
	): Promise<void> {
		const other = await c.query(
			"SELECT 1 FROM identity.users WHERE email = $1",
			[email],
		);
		if (other.rowCount) {
			throw new IdentityError(
				"identity_conflict",
				"the email belongs to another account",
			);
		}
		await c.query("UPDATE identity.users SET email = $2 WHERE id = $1", [
			userId,
			email,
		]);
	}

	async #createUser(
		c: pg.PoolClient,
		email: string,
		sub: string,
		h: SessionHeaders,
		isOperator: boolean,
	): Promise<string> {
		const team = await c.query<{ id: string }>(
			"INSERT INTO identity.teams (name, personal) VALUES ($1, true) RETURNING id",
			[personalTeamName(email)],
		);
		const teamId = team.rows[0]?.id as string;
		const created = await c.query<{ id: string }>(
			`INSERT INTO identity.users (email, name, idp_subject, is_operator, default_team_id)
			 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
			[email, displayName(email, h), sub, isOperator, teamId],
		);
		const userId = created.rows[0]?.id as string;
		await c.query(
			"INSERT INTO identity.memberships (user_id, team_id, role) VALUES ($1, $2, 'owner')",
			[userId, teamId],
		);
		return userId;
	}

	async #ensurePersonalTeam(
		c: pg.PoolClient,
		userId: string,
		email: string,
		defaultTeamId: string | null,
	): Promise<void> {
		const has = await c.query(
			`SELECT 1 FROM identity.memberships m JOIN identity.teams t ON t.id = m.team_id
			  WHERE m.user_id = $1 AND m.role = 'owner' AND t.personal`,
			[userId],
		);
		if (has.rowCount) return;
		const team = await c.query<{ id: string }>(
			"INSERT INTO identity.teams (name, personal) VALUES ($1, true) RETURNING id",
			[personalTeamName(email)],
		);
		const teamId = team.rows[0]?.id as string;
		await c.query(
			"INSERT INTO identity.memberships (user_id, team_id, role) VALUES ($1, $2, 'owner')",
			[userId, teamId],
		);
		if (defaultTeamId === null) {
			await c.query(
				"UPDATE identity.users SET default_team_id = $2 WHERE id = $1",
				[userId, teamId],
			);
		}
	}

	async #session(c: pg.PoolClient, userId: string): Promise<SessionIdentity> {
		const u = await c.query<UserRow>(
			`SELECT ${USER_COLS} FROM identity.users WHERE id = $1`,
			[userId],
		);
		const user = userOf(u.rows[0] as UserRow);
		const t = await c.query<{
			team_id: string;
			name: string;
			role: "owner" | "member";
			personal: boolean;
		}>(
			`SELECT m.team_id, t.name, m.role, t.personal
			   FROM identity.memberships m JOIN identity.teams t ON t.id = m.team_id
			  WHERE m.user_id = $1
			  ORDER BY t.personal DESC, t.created_at, t.id`,
			[userId],
		);
		const teams: TeamMembership[] = t.rows.map((r) => ({
			teamId: r.team_id,
			name: r.name,
			role: r.role,
		}));
		// The stored default while still a member, else the personal team (S8 §6.1).
		const personal = t.rows.find((r) => r.personal && r.role === "owner");
		const defaultTeamId =
			teams.find((m) => m.teamId === user.defaultTeamId)?.teamId ??
			personal?.team_id ??
			teams[0]?.teamId ??
			null;
		return { user, teams, defaultTeamId, isOperator: user.isOperator };
	}

	async findApiKeyByHash(sha256Hex: string): Promise<ApiKeyRecord | null> {
		const r = await this.#pool.query<ApiKeyRow>(
			`${API_KEY_SELECT} WHERE k.secret_hash = $1`,
			[sha256Hex],
		);
		return r.rows[0] ? apiKeyOf(r.rows[0]) : null;
	}

	async apiKey(id: string): Promise<ApiKeyRecord | null> {
		const r = await this.#pool.query<ApiKeyRow>(
			`${API_KEY_SELECT} WHERE k.id = $1`,
			[id],
		);
		return r.rows[0] ? apiKeyOf(r.rows[0]) : null;
	}

	async #apiKey(id: string): Promise<ApiKeyRecord> {
		const k = await this.apiKey(id);
		if (k === null) throw new IdentityError("not_found");
		return k;
	}

	async createApiKey(input: NewApiKey): Promise<ApiKeyRecord> {
		let id: string;
		try {
			const r = await this.#pool.query<{ id: string }>(
				`INSERT INTO identity.api_keys
				   (team_id, name, secret_hash, prefix, last4, scopes, created_by, created_via, expires_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
				[
					input.teamId,
					input.name,
					input.secretHash,
					input.prefix,
					input.last4,
					input.scopes,
					input.createdByUserId,
					input.createdVia,
					input.expiresAt,
				],
			);
			id = r.rows[0]?.id as string;
		} catch (e) {
			if (pgCode(e) === FK_VIOLATION) {
				throw new IdentityError("not_found", "unknown team or creator");
			}
			throw e;
		}
		return this.#apiKey(id);
	}

	/** A revoked or unknown key is not_found. */
	async rotateApiKey(
		id: string,
		s: { secretHash: string; prefix: string; last4: string },
	): Promise<ApiKeyRecord> {
		const r = await this.#pool.query(
			`UPDATE identity.api_keys
			    SET secret_hash = $2, prefix = $3, last4 = $4, rotated_at = now()
			  WHERE id = $1 AND revoked_at IS NULL`,
			[id, s.secretHash, s.prefix, s.last4],
		);
		if (!r.rowCount) throw new IdentityError("not_found");
		return this.#apiKey(id);
	}

	/** Idempotent: a key revoked earlier keeps its first revocation. */
	async revokeApiKey(
		id: string,
		by: { userId?: string; apiKeyId?: string },
	): Promise<void> {
		let n: number | null;
		try {
			n = (
				await this.#pool.query(
					`UPDATE identity.api_keys
					    SET revoked_at = now(), revoked_by = $2, revoked_by_key = $3
					  WHERE id = $1 AND revoked_at IS NULL`,
					[id, by.userId ?? null, by.apiKeyId ?? null],
				)
			).rowCount;
		} catch (e) {
			if (pgCode(e) === FK_VIOLATION) {
				throw new IdentityError("not_found", "unknown revoking user or key");
			}
			throw e;
		}
		if (n) return;
		const exists = await this.#pool.query(
			"SELECT 1 FROM identity.api_keys WHERE id = $1",
			[id],
		);
		if (!exists.rowCount) throw new IdentityError("not_found");
	}

	/** Every key of the team, revoked ones included, newest first. */
	async listApiKeys(q: { teamId: string }): Promise<ApiKeyRecord[]> {
		const r = await this.#pool.query<ApiKeyRow>(
			`${API_KEY_SELECT} WHERE k.team_id = $1 ORDER BY k.created_at DESC, k.id DESC`,
			[q.teamId],
		);
		return r.rows.map(apiKeyOf);
	}

	async touchApiKey(id: string): Promise<void> {
		await this.#pool.query(
			"UPDATE identity.api_keys SET last_used_at = now() WHERE id = $1",
			[id],
		);
	}

	async listSshKeys(userId: string): Promise<SshKeyRecord[]> {
		const r = await this.#pool.query<SshKeyRow>(
			`SELECT ${SSH_COLS} FROM identity.ssh_keys WHERE user_id = $1 ORDER BY created_at, id`,
			[userId],
		);
		return r.rows.map(sshKeyOf);
	}

	async addSshKey(input: NewSshKey): Promise<SshKeyRecord> {
		try {
			const r = await this.#pool.query<SshKeyRow>(
				`INSERT INTO identity.ssh_keys (user_id, name, public_key, fingerprint, type)
				 VALUES ($1, $2, $3, $4, $5) RETURNING ${SSH_COLS}`,
				[
					input.userId,
					input.name,
					input.publicKey,
					input.fingerprint,
					input.type,
				],
			);
			return sshKeyOf(r.rows[0] as SshKeyRow);
		} catch (e) {
			const code = pgCode(e);
			if (code === UNIQUE_VIOLATION)
				throw new IdentityError("fingerprint_taken");
			if (code === FK_VIOLATION) throw new IdentityError("not_found");
			throw e;
		}
	}

	async removeSshKey(userId: string, id: string): Promise<void> {
		const r = await this.#pool.query(
			"DELETE FROM identity.ssh_keys WHERE id = $1 AND user_id = $2",
			[id, userId],
		);
		if (!r.rowCount) throw new IdentityError("not_found");
	}

	async findSshKeyByFingerprint(fp: string): Promise<SshKeyRecord | null> {
		const r = await this.#pool.query<SshKeyRow>(
			`SELECT ${SSH_COLS} FROM identity.ssh_keys WHERE fingerprint = $1`,
			[fp],
		);
		return r.rows[0] ? sshKeyOf(r.rows[0]) : null;
	}

	async touchSshKey(id: string): Promise<void> {
		await this.#pool.query(
			"UPDATE identity.ssh_keys SET last_used_at = now() WHERE id = $1",
			[id],
		);
	}

	async membership(
		userId: string,
		teamId: string,
	): Promise<{ role: "owner" | "member" } | null> {
		const r = await this.#pool.query<{ role: "owner" | "member" }>(
			"SELECT role FROM identity.memberships WHERE user_id = $1 AND team_id = $2",
			[userId, teamId],
		);
		return r.rows[0] ? { role: r.rows[0].role } : null;
	}

	async team(teamId: string): Promise<{ id: string; name: string } | null> {
		const r = await this.#pool.query<{ id: string; name: string }>(
			"SELECT id, name FROM identity.teams WHERE id = $1",
			[teamId],
		);
		return r.rows[0] ? { id: r.rows[0].id, name: r.rows[0].name } : null;
	}

	async user(userId: string): Promise<UserRecord | null> {
		const r = await this.#pool.query<UserRow>(
			`SELECT ${USER_COLS} FROM identity.users WHERE id = $1`,
			[userId],
		);
		return r.rows[0] ? userOf(r.rows[0]) : null;
	}
}

// S8 §5.3: name, else preferred username, else the local part of the email.
function displayName(email: string, h: SessionHeaders): string {
	return h.name ?? h.preferredUsername ?? email.split("@")[0] ?? email;
}
